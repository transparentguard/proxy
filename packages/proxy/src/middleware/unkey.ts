/**
 * TransparentGuard Proxy — Unkey Key Verification
 *
 * Verifies a customer's TransparentGuard API key against Unkey.
 * Reads UNKEY_ROOT_KEY and UNKEY_API_ID from environment.
 *
 * If neither env var is set, returns null (bypass mode — useful for local dev).
 * If either is set but the key is invalid, returns { valid: false }.
 */

export interface UnkeyVerifyResult {
  valid: boolean;
  keyId: string;
  tier: string;
  /** Present only when valid is false */
  errorCode?: string;
}

const UNKEY_VERIFY_URL = "https://api.unkey.dev/v1/keys.verifyKey";
const TIMEOUT_MS = 5_000;

/**
 * Verifies a customer API key with Unkey.
 * Returns null if Unkey is not configured (UNKEY_API_ID not set).
 */
export async function verifyUnkey(customerKey: string): Promise<UnkeyVerifyResult | null> {
  const apiId   = process.env["UNKEY_API_ID"];
  const rootKey = process.env["UNKEY_ROOT_KEY"];

  if (!apiId) return null; // Unkey not configured — bypass

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (rootKey) headers["Authorization"] = `Bearer ${rootKey}`;

  let res: Response;
  try {
    res = await fetch(UNKEY_VERIFY_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({ apiId, key: customerKey }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure — fail closed
    console.error("[TG] Unkey verification request failed:", err);
    return { valid: false, keyId: "", tier: "free", errorCode: "unkey_unreachable" };
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`[TG] Unkey returned HTTP ${res.status}: ${text}`);
    return { valid: false, keyId: "", tier: "free", errorCode: `unkey_http_${res.status}` };
  }

  const data = await res.json() as {
    valid: boolean;
    keyId?: string;
    meta?: { tier?: string };
    code?: string;
    error?: string;
  };

  if (!data.valid) {
    return {
      valid: false,
      keyId: data.keyId ?? "",
      tier: "free",
      errorCode: data.code ?? "key_invalid",
    };
  }

  return {
    valid: true,
    keyId: data.keyId ?? "",
    tier: (data.meta?.["tier"] as string | undefined) ?? "free",
  };
}
