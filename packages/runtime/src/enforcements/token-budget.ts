/**
 * TransparentGuard Runtime — Token Budget Enforcement
 *
 * Token counting:
 *   - Primary: tiktoken npm package (exact, model-aware) when installed
 *   - Fallback: blended word/char heuristic (~5% error for English)
 *
 * Usage tracking:
 *   - Primary: Redis (TG_REDIS_URL) — atomic Lua script, shared across replicas
 *   - Fallback: in-process Map — per-instance only, resets on restart
 *
 * Redis key format:
 *   tg:tok:{apiKeyId}:day:{YYYY-MM-DD}   TTL 48h
 *   tg:tok:{apiKeyId}:hr:{YYYY-MM-DDTHH} TTL 2h
 */

import type { EvaluationContext, RequestPayload, RuleResult, Violation } from "../types.js";
import { buildAuditEvent } from "../audit/emitter.js";
import { getRedisClient } from "./redis-client.js";

// ---------------------------------------------------------------------------
// Token counting — tiktoken-aware, model-adaptive
// ---------------------------------------------------------------------------

interface TiktokenEncoding {
  encode(text: string): Uint32Array;
}

let _tiktokenCache: Map<string, TiktokenEncoding> | null = null;

function loadTiktoken(): Map<string, TiktokenEncoding> | null {
  if (_tiktokenCache !== null) return _tiktokenCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tiktoken = require("tiktoken") as {
      get_encoding: (name: string) => TiktokenEncoding;
    };
    _tiktokenCache = new Map([
      ["o200k_base", tiktoken.get_encoding("o200k_base")],
      ["cl100k_base", tiktoken.get_encoding("cl100k_base")],
    ]);
    return _tiktokenCache;
  } catch {
    _tiktokenCache = new Map(); // empty — signals "not available"
    return null;
  }
}

function selectEncoding(model: string): string {
  if (/gpt-4o|o1-|o3-|o4-/.test(model)) return "o200k_base";
  return "cl100k_base";
}

/** @deprecated Use countTokens — kept for backwards compatibility */
export const approximateTokenCount = (text: string): number => countTokens(text);

export function countTokens(text: string, model = ""): number {
  if (!text) return 0;

  // Anthropic: documented ~3.5 chars/token
  if (/claude/i.test(model)) {
    return Math.max(1, Math.round(text.length / 3.5));
  }

  const enc = loadTiktoken();
  if (enc && enc.size > 0) {
    const encoding = enc.get(selectEncoding(model));
    if (encoding) {
      try {
        return encoding.encode(text).length;
      } catch {
        // fallthrough to heuristic
      }
    }
  }

  // Blended heuristic
  const words = text.trim().split(/\s+/).length;
  const chars = text.length;
  return Math.max(1, Math.ceil((words * 1.3 + chars / 4) / 2));
}

export function countRequestTokens(payload: RequestPayload): number {
  const model = payload.model ?? "";
  let total = 0;
  for (const msg of payload.messages) {
    if (msg.content) total += countTokens(msg.content, model);
    if (msg.name)    total += countTokens(msg.name, model);
    total += 4; // OpenAI per-message overhead
  }
  total += 2; // Reply priming
  if (payload.max_tokens) total += payload.max_tokens;
  return total;
}

// ---------------------------------------------------------------------------
// Date key helpers
// ---------------------------------------------------------------------------

function dayKey(apiKeyId: string): string {
  const d = new Date();
  return `tg:tok:${apiKeyId}:day:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function hourKey(apiKeyId: string): string {
  const d = new Date();
  return `tg:tok:${apiKeyId}:hr:${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}T${String(d.getUTCHours()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// In-process fallback
// ---------------------------------------------------------------------------

const tokenUsage = new Map<string, number>();

function fallbackRecord(apiKeyId: string, tokens: number): void {
  const dk = dayKey(apiKeyId);
  const hk = hourKey(apiKeyId);
  tokenUsage.set(dk, (tokenUsage.get(dk) ?? 0) + tokens);
  tokenUsage.set(hk, (tokenUsage.get(hk) ?? 0) + tokens);
}

// ---------------------------------------------------------------------------
// Redis atomic check-and-increment (Lua)
// Returns ["ok"|"day_exceeded"|"hr_exceeded", currentTotal]
// ---------------------------------------------------------------------------

const TOKEN_LUA = `
local day_k   = KEYS[1]
local hr_k    = KEYS[2]
local tokens  = tonumber(ARGV[1])
local max_day = tonumber(ARGV[2])
local max_hr  = tonumber(ARGV[3])
local day_use = tonumber(redis.call('GET', day_k) or 0)
local hr_use  = tonumber(redis.call('GET', hr_k)  or 0)
if max_day > 0 and day_use + tokens > max_day then
  return {'day_exceeded', tostring(day_use + tokens)}
end
if max_hr > 0 and hr_use + tokens > max_hr then
  return {'hr_exceeded', tostring(hr_use + tokens)}
end
redis.call('INCRBY', day_k, tokens)
redis.call('EXPIRE',  day_k, 172800)
redis.call('INCRBY', hr_k,  tokens)
redis.call('EXPIRE',  hr_k,  7200)
return {'ok', tostring(day_use + tokens)}
`;

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export async function enforceTokenBudget(ctx: EvaluationContext): Promise<RuleResult> {
  const { rule, payload, policy, stage, requestId, apiKeyId, tags } = ctx;
  const ruleId = rule.id;

  if (!("messages" in payload)) {
    return {
      ruleId,
      outcome: "skipped",
      auditEvent: buildAuditEvent({
        policy, rule, eventType: "allowed", stage, payload, tags, requestId,
        detail: "token_budget: skipped (not a request payload)",
      }),
    };
  }

  const requestPayload = payload as RequestPayload;
  const requestTokens = countRequestTokens(requestPayload);

  // Per-request hard cap
  if (rule.max_tokens_per_request !== undefined && requestTokens > rule.max_tokens_per_request) {
    return makeViolation(ctx, {
      detail: `Request token count ${requestTokens} exceeds per-request limit ${rule.max_tokens_per_request}`,
      category: "token_budget_per_request",
    });
  }

  // Per-key daily / hourly caps
  if (apiKeyId && (rule.max_tokens_per_day_per_key !== undefined || rule.max_tokens_per_hour_per_key !== undefined)) {
    const maxDay  = rule.max_tokens_per_day_per_key  ?? 0;
    const maxHour = rule.max_tokens_per_hour_per_key ?? 0;
    const redis   = await getRedisClient();

    if (redis) {
      const result = await redis.eval(
        TOKEN_LUA,
        [dayKey(apiKeyId), hourKey(apiKeyId)],
        [String(requestTokens), String(maxDay), String(maxHour)],
      ) as [string, string];

      if (result[0] === "day_exceeded") {
        return makeViolation(ctx, {
          detail: `Daily token limit reached: ${result[1]} > ${maxDay} tokens/day for this key`,
          category: "token_budget_per_day",
        });
      }
      if (result[0] === "hr_exceeded") {
        return makeViolation(ctx, {
          detail: `Hourly token limit reached: ${result[1]} > ${maxHour} tokens/hour for this key`,
          category: "token_budget_per_hour",
        });
      }
    } else {
      const dayUsed  = tokenUsage.get(dayKey(apiKeyId))  ?? 0;
      const hourUsed = tokenUsage.get(hourKey(apiKeyId)) ?? 0;

      if (maxDay && dayUsed + requestTokens > maxDay) {
        return makeViolation(ctx, {
          detail: `Daily token limit reached: ${dayUsed + requestTokens} > ${maxDay} per day`,
          category: "token_budget_per_day",
        });
      }
      if (maxHour && hourUsed + requestTokens > maxHour) {
        return makeViolation(ctx, {
          detail: `Hourly token limit reached: ${hourUsed + requestTokens} > ${maxHour} per hour`,
          category: "token_budget_per_hour",
        });
      }
      fallbackRecord(apiKeyId, requestTokens);
    }
  }

  return {
    ruleId,
    outcome: "passed",
    auditEvent: buildAuditEvent({ policy, rule, eventType: "allowed", stage, payload, tags, requestId }),
  };
}

function makeViolation(
  ctx: EvaluationContext,
  { detail, category }: { detail: string; category: string },
): RuleResult {
  const { rule, payload, policy, stage, requestId, tags } = ctx;
  const outcome = rule.on_violation === "block" ? "blocked" : "warned";
  const violation: Violation = {
    rule_id: rule.id,
    rule_description: rule.description,
    outcome,
    detail,
    category,
  };
  return {
    ruleId: rule.id,
    outcome,
    violation,
    auditEvent: buildAuditEvent({
      policy, rule,
      eventType: outcome === "blocked" ? "blocked" : "warned",
      stage, payload, tags, requestId, detail,
    }),
  };
}
