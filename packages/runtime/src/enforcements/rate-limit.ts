/**
 * TransparentGuard Runtime — Rate Limit Enforcement
 *
 * Algorithm: sliding window log (exact — no fixed-window boundary bursts)
 *
 * State storage:
 *   - Primary: Redis sorted set with atomic Lua script — shared across replicas
 *   - Fallback: in-process timestamp array — per-instance, resets on restart
 *
 * Redis key format:
 *   tg:rl:{apiKeyId}:rpm  TTL 120s
 *   tg:rl:{apiKeyId}:rph  TTL 7200s
 */

import type { EvaluationContext, RuleResult, Violation } from "../types.js";
import { buildAuditEvent } from "../audit/emitter.js";
import { getRedisClient } from "./redis-client.js";

// ---------------------------------------------------------------------------
// Redis atomic sliding window (Lua)
// KEYS[1] = sorted set key
// ARGV[1]=now_ms  ARGV[2]=window_ms  ARGV[3]=limit  ARGV[4]=ttl_sec
// Returns [current_count, "ok"|"exceeded"]
// ---------------------------------------------------------------------------

const RATE_LUA = `
local key    = KEYS[1]
local now    = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit  = tonumber(ARGV[3])
local ttl    = tonumber(ARGV[4])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now - window)
local count = tonumber(redis.call('ZCARD', key))
if count >= limit then
  return {count, 'exceeded'}
end
local seq = redis.call('INCR', key .. ':seq')
redis.call('ZADD', key, now, tostring(now) .. '-' .. tostring(seq))
redis.call('EXPIRE', key, ttl)
redis.call('EXPIRE', key .. ':seq', ttl)
return {count + 1, 'ok'}
`;

// ---------------------------------------------------------------------------
// In-process fallback (per-process only)
// ---------------------------------------------------------------------------

const minuteWindows = new Map<string, number[]>();
const hourWindows   = new Map<string, number[]>();

function pruneWindow(timestamps: number[], windowMs: number): number[] {
  const cutoff = Date.now() - windowMs;
  return timestamps.filter((t) => t > cutoff);
}

function inProcessCheck(
  map: Map<string, number[]>,
  key: string,
  windowMs: number,
  limit: number,
): { exceeded: boolean; count: number } {
  const pruned = pruneWindow(map.get(key) ?? [], windowMs);
  map.set(key, pruned);
  return { exceeded: pruned.length >= limit, count: pruned.length };
}

function inProcessRecord(map: Map<string, number[]>, key: string, windowMs: number): void {
  const pruned = pruneWindow(map.get(key) ?? [], windowMs);
  pruned.push(Date.now());
  map.set(key, pruned);
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export async function enforceRateLimit(ctx: EvaluationContext): Promise<RuleResult> {
  const { rule, payload, policy, stage, requestId, apiKeyId, tags } = ctx;
  const ruleId = rule.id;

  if (!apiKeyId) {
    return {
      ruleId,
      outcome: "skipped",
      auditEvent: buildAuditEvent({
        policy, rule, eventType: "allowed", stage, payload, tags, requestId,
        detail: "rate_limit: no api_key_id provided, skipping",
      }),
    };
  }

  const nowMs  = Date.now();
  const redis  = await getRedisClient();

  // Per-minute check
  if (rule.max_requests_per_minute_per_key !== undefined) {
    const limit = rule.max_requests_per_minute_per_key;
    const key   = `tg:rl:${apiKeyId}:rpm`;

    if (redis) {
      const res = await redis.eval(RATE_LUA, [key], [String(nowMs), "60000", String(limit), "120"]) as [number, string];
      if (res[1] === "exceeded") {
        return makeViolation(ctx, {
          detail: `Rate limit exceeded: >${limit} requests in the last 60s for this key`,
          category: "rate_limit_per_minute",
        });
      }
    } else {
      const { exceeded, count } = inProcessCheck(minuteWindows, key, 60_000, limit);
      if (exceeded) {
        return makeViolation(ctx, {
          detail: `Rate limit exceeded: ${count} requests in last 60s, max is ${limit}/min`,
          category: "rate_limit_per_minute",
        });
      }
      inProcessRecord(minuteWindows, key, 60_000);
    }
  }

  // Per-hour check
  if (rule.max_requests_per_hour_per_key !== undefined) {
    const limit = rule.max_requests_per_hour_per_key;
    const key   = `tg:rl:${apiKeyId}:rph`;

    if (redis) {
      const res = await redis.eval(RATE_LUA, [key], [String(nowMs), "3600000", String(limit), "7200"]) as [number, string];
      if (res[1] === "exceeded") {
        return makeViolation(ctx, {
          detail: `Rate limit exceeded: >${limit} requests in the last 3600s for this key`,
          category: "rate_limit_per_hour",
        });
      }
    } else {
      const { exceeded, count } = inProcessCheck(hourWindows, key, 3_600_000, limit);
      if (exceeded) {
        return makeViolation(ctx, {
          detail: `Rate limit exceeded: ${count} requests in last 3600s, max is ${limit}/hr`,
          category: "rate_limit_per_hour",
        });
      }
      inProcessRecord(hourWindows, key, 3_600_000);
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
