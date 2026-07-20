#!/usr/bin/env node
/**
 * TransparentGuard Proxy Server — CLI Entry Point
 *
 * Usage:
 *   tg-proxy --policy ./policy.yaml --upstream https://api.openai.com [options]
 *
 * Options:
 *   --policy, -p          <path|oci://ref>  TPS policy file or OCI artifact reference (required)
 *   --upstream, -u        <url>             Upstream LLM API base URL (required)
 *   --port                <number>          Port to listen on (default: $PORT or 8080)
 *   --upstream-api-key    <key>             Override upstream API key (default: from client Authorization header)
 *   --tg-api-key          <key>             TransparentGuard API key for paid-tier features
 *   --log-level           debug|info|error  Log verbosity (default: info)
 *   --offline-mode                          Skip license check (free tier only)
 *
 * Environment variables:
 *   PORT                            Overrides --port
 *   UPSTREAM_API_KEY                Overrides --upstream-api-key
 *   TG_API_KEY                      Overrides --tg-api-key
 *   OTEL_EXPORTER_OTLP_ENDPOINT     Enables OTEL tracing (no-op if absent)
 *   OTEL_SERVICE_NAME               OTEL service name (default: transparentguard-proxy)
 *   TG_COSIGN_VERIFY                Set to "true" to require Cosign verification on OCI policies
 *   TG_COSIGN_PUBLIC_KEY_PATH       Path to PEM public key for Cosign verification
 */

import { parseArgs } from "node:util";
import { TransparentGuard } from "@transparentguard/runtime";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";
import { startServer } from "./server.js";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const { values: argv } = parseArgs({
  options: {
    policy:            { type: "string",  short: "p" },
    upstream:          { type: "string",  short: "u" },
    port:              { type: "string" },
    "upstream-api-key": { type: "string" },
    "tg-api-key":      { type: "string" },
    "log-level":       { type: "string",  default: "info" },
    "offline-mode":    { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (!argv.policy) {
  console.error(
    "Error: --policy is required.\n" +
    "  Example: --policy ./policy.yaml\n" +
    "           --policy oci://ghcr.io/myorg/my-policy:v1.0.0",
  );
  process.exit(1);
}

if (!argv.upstream) {
  console.error(
    "Error: --upstream is required.\n" +
    "  Example: --upstream https://api.openai.com\n" +
    "           --upstream https://api.anthropic.com",
  );
  process.exit(1);
}

const port = parseInt(
  argv.port ?? process.env["PORT"] ?? "8080",
  10,
);

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`Error: Invalid port: ${String(argv.port ?? process.env["PORT"])}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main async startup
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Initialize OTEL before anything else — must precede any instrumented code.
  const otelServiceName =
    process.env["OTEL_SERVICE_NAME"] ?? "transparentguard-proxy";
  initTelemetry(otelServiceName);

  // Load policy
  console.log(`[TransparentGuard] Loading policy: ${argv.policy}`);

  let tg: TransparentGuard;
  try {
    tg = await TransparentGuard.init({
      policy: argv.policy as string,
      apiKey: argv["tg-api-key"] ?? process.env["TG_API_KEY"],
      offlineMode: argv["offline-mode"],
    });
    console.log(`[TransparentGuard] Policy loaded: "${tg.getPolicy().name}"`);
  } catch (err) {
    console.error(`[TransparentGuard] Fatal: Failed to load policy.\n  ${String(err)}`);
    process.exit(1);
  }

  // Start HTTP server
  const server = startServer({
    tg,
    upstream: argv.upstream as string,
    upstreamApiKey: argv["upstream-api-key"] ?? process.env["UPSTREAM_API_KEY"],
    port,
    logLevel: (argv["log-level"] as "debug" | "info" | "error") ?? "info",
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  let shutdownInProgress = false;

  const shutdown = (signal: string): void => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(`\n[TransparentGuard] Received ${signal} — shutting down gracefully...`);

    server.close(() => {
      console.log("[TransparentGuard] HTTP server closed.");

      // Flush audit events and OTEL spans before exit
      void Promise.all([
        tg.flushAudit(),
        shutdownTelemetry(),
      ]).then(() => {
        console.log("[TransparentGuard] Shutdown complete.");
        process.exit(0);
      }).catch((err) => {
        console.error(`[TransparentGuard] Shutdown error: ${String(err)}`);
        process.exit(1);
      });
    });

    // Force-exit after 10 seconds if graceful shutdown stalls
    setTimeout(() => {
      console.error("[TransparentGuard] Force-exiting after timeout.");
      process.exit(1);
    }, 10_000).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT",  () => shutdown("SIGINT"));
}

main().catch((err: unknown) => {
  console.error("[TransparentGuard] Fatal error:", err);
  process.exit(1);
});
