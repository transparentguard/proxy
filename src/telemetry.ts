/**
 * TransparentGuard Proxy — OpenTelemetry Tracing Initialization
 *
 * Initializes the OTEL Node.js SDK when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 * If the env var is absent, tracing is a no-op — zero overhead, zero config required.
 *
 * Standard OTEL env vars are honoured automatically:
 *   OTEL_EXPORTER_OTLP_ENDPOINT  - collector endpoint (e.g. http://localhost:4318)
 *   OTEL_SERVICE_NAME            - service name (default: transparentguard-proxy)
 *   OTEL_EXPORTER_OTLP_HEADERS   - auth/routing headers (comma-separated key=value)
 */

import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
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

let provider: NodeTracerProvider | null = null;
let tracer: Tracer | null = null;

/**
 * Initialize the OTEL SDK.
 * Safe to call multiple times — subsequent calls are no-ops.
 * Must be called before starting the HTTP server.
 */
export function initTelemetry(serviceName: string = "transparentguard-proxy"): void {
  const endpoint = process.env["OTEL_EXPORTER_OTLP_ENDPOINT"];

  if (!endpoint) return; // No collector configured — stay in no-op mode.
  if (provider) return; // Already initialized.

  provider = new NodeTracerProvider({
    resource: new Resource({
      "service.name": serviceName,
      "service.version": "0.1.0",
    }),
  });

  provider.addSpanProcessor(
    new BatchSpanProcessor(
      new OTLPTraceExporter({
        url: endpoint.replace(/\/$/, "") + "/v1/traces",
      }),
    ),
  );

  provider.register(); // Registers as the global TracerProvider

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
  if (provider) {
    await provider.shutdown();
    provider = null;
    tracer = null;
  }
}
