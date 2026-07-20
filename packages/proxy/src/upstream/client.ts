/**
 * TransparentGuard Proxy — Upstream HTTP Client
 *
 * A thin wrapper around Node's built-in fetch for forwarding requests
 * to the upstream LLM provider. Forwards all relevant headers and the body
 * verbatim, only swapping in the upstream API key.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
const PROXY_VERSION: string = (require("../../package.json") as { version: string }).version;

const UPSTREAM_TIMEOUT_MS = 120_000; // 2 minutes — generous for slow models

// Headers that must NOT be forwarded to the upstream.
// The proxy sets its own values for these.
const STRIP_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "content-length",   // recalculated by fetch
  "transfer-encoding",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
  "keep-alive",
]);

export interface UpstreamRequest {
  /** Full upstream base URL (e.g. https://api.openai.com) */
  upstreamBase: string;
  /** Path to forward (e.g. /v1/chat/completions) */
  path: string;
  /** HTTP method */
  method: string;
  /** Upstream API key — replaces whatever the client sent */
  apiKey: string;
  /** Request body (stringified JSON from the policy-evaluated payload) */
  body: string;
  /** Original request headers (minus Authorization, which we replace) */
  headers: Record<string, string>;
  /** Whether the request wants a streaming response */
  stream: boolean;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** Raw body as Buffer for streaming reconstruction */
  rawChunks: string[];
  ok: boolean;
}

/**
 * Call the upstream provider and return the full response.
 *
 * For streaming requests this buffers the entire SSE response into rawChunks
 * so the proxy can evaluate the assembled content before re-emitting.
 */
export async function callUpstream(req: UpstreamRequest): Promise<UpstreamResponse> {
  const url = req.upstreamBase.replace(/\/$/, "") + req.path;

  const forwardHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${req.apiKey}`,
    "User-Agent": "transparentguard-proxy/0.1.0",
  };

  // Forward safe original headers
  for (const [key, value] of Object.entries(req.headers)) {
    const lower = key.toLowerCase();
    if (!STRIP_REQUEST_HEADERS.has(lower) && lower !== "authorization") {
      forwardHeaders[key] = value;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: req.method,
      headers: forwardHeaders,
      body: req.body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    throw new Error(`Upstream request failed: ${String(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  // Collect response headers
  const respHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    respHeaders[key] = value;
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    return {
      status: response.status,
      headers: respHeaders,
      body: errorBody,
      rawChunks: [],
      ok: false,
    };
  }

  if (req.stream) {
    // Buffer the SSE stream into lines
    const rawChunks: string[] = [];
    const text = await response.text();
    // Split by SSE event boundaries (\n\n) and collect data lines
    const lines = text.split("\n");
    for (const line of lines) {
      rawChunks.push(line);
    }
    return {
      status: response.status,
      headers: respHeaders,
      body: text,
      rawChunks,
      ok: true,
    };
  }

  const body = await response.text();
  return {
    status: response.status,
    headers: respHeaders,
    body,
    rawChunks: [],
    ok: true,
  };
}
