/**
 * TransparentGuard Proxy — OpenTelemetry Tracing Initialization
 *
 * Uses @opentelemetry/sdk-node (NodeSDK) — the stable high-level API.
 * Tracing is a no-op when OTEL_EXPORTER_OTLP_ENDPOINT is not set.
 *
 * Standard OTEL env vars are honoured automatically:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  - collector endpoint (e.g. http://localhost:4318)
 *   OTEL_SERVICE_NAME            - service name (default: transparentguard-proxy)
 *   OTEL_EXPORTER_OTLP_HEADERS   - auth/routing headers (comma-separated key=value)
 */

import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  trace,
  context,
  SpanStatusCode,
  SpanKind,
  type Tracer,
  type Span,
} from "@opentelemetry/api";

export { trace, context, SpanStatusCode, SpanKind };
export type { Tracer, Span };

export const TRACER_NAME = "transparentguard-proxy";

let sdk: NodeSDK | null = null;
let tracer: Tracer | null = null;

/**
 * Initialize the OTEL SDK.
 * Safe to call multiple times — subsequent calls are no-ops.
 * Must be called before starting the HTTP server.
 */
export function initTelemetry(serviceName: string = "transparentguard-proxy"): void {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

  if (!endpoint) return; // No collector configured — stay in no-op mode.
  if (sdk) return;       // Already initialized.

  sdk = new NodeSDK({
    serviceName,
    traceExporter: new OTLPTraceExporter({
      url: endpoint.replace(/\/$/, "") + "/v1/traces",
    }),
  });

  sdk.start();

  console.log(
    `[TransparentGuard] OTEL tracing enabled — exporting to ${endpoint}`,
  );
}

/**
 * Get the singleton tracer. Returns a no-op tracer if OTEL was not initialized.
 */
export function getTracer(): Tracer {
  if (!tracer) {
    tracer = trace.getTracer(TRACER_NAME, "0.1.0");
  }
  return tracer;
}

/**
 * Flush all pending spans and shut down the SDK. Call before process exit.
 */
export async function shutdownTelemetry(): Promise<void> {
  if (sdk) {
    await sdk.shutdown();
    sdk = null;
    tracer = null;
  }
}
