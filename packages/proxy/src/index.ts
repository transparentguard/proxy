#!/usr/bin/env node
/**
 * TransparentGuard Proxy Server — CLI Entry Point
 *
 * All flags have environment-variable equivalents so Railway / Docker
 * users never need to touch the CMD:
 *
 *   Flag                  Env var               Default
 *   --policy              TG_POLICY_PATH        /app/policies/default.yaml
 *   --upstream            UPSTREAM_URL          https://api.openai.com
 *   --port                PORT                  8080
 *   --upstream-api-key    UPSTREAM_API_KEY      (none — forwards client key)
 *   --tg-api-key          TG_API_KEY            (none — free tier)
 *   --log-level           TG_LOG_LEVEL          info
 *   --offline-mode        TG_OFFLINE_MODE       false
 *   (n/a)                 OTEL_EXPORTER_OTLP_ENDPOINT  enables tracing
 *   (n/a)                 OTEL_SERVICE_NAME     transparentguard-proxy
 */

import { parseArgs } from "node:util";
import { TransparentGuard } from "@transparentguard/runtime";
import { initTelemetry, shutdownTelemetry } from "./telemetry.js";
import { startServer } from "./server.js";

// ---------------------------------------------------------------------------
// CLI argument parsing (all optional — env vars fill the gaps)
// ---------------------------------------------------------------------------

const { values: argv } = parseArgs({
  options: {
    policy:              { type: "string",  short: "p" },
    upstream:            { type: "string",  short: "u" },
    port:                { type: "string" },
    "upstream-api-key":  { type: "string" },
    "tg-api-key":        { type: "string" },
    "log-level":         { type: "string",  default: "info" },
    "offline-mode":      { type: "boolean", default: false },
  },
  strict: true,
  allowPositionals: false,
});

// ---------------------------------------------------------------------------
// Resolve values: flag → env var → built-in default
// ---------------------------------------------------------------------------

const policyPath: string =
  argv.policy ??
  process.env["TG_POLICY_PATH"] ??
  "/app/policies/default.yaml";

const upstreamUrl: string =
  argv.upstream ??
  process.env["UPSTREAM_URL"] ??
  "https://api.openai.com";

const port = parseInt(
  argv.port ?? process.env["PORT"] ?? "8080",
  10,
);

const logLevel = (
  argv["log-level"] ??
  process.env["TG_LOG_LEVEL"] ??
  "info"
) as "debug" | "info" | "error";

const offlineMode: boolean =
  argv["offline-mode"] ||
  process.env["TG_OFFLINE_MODE"] === "true";

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

if (isNaN(port) || port < 1 || port > 65535) {
  console.error(`[TransparentGuard] Fatal: Invalid port "${String(argv.port ?? process.env["PORT"])}"`);
  process.exit(1);
}

if (!["debug", "info", "error"].includes(logLevel)) {
  console.error(`[TransparentGuard] Fatal: Invalid log level "${logLevel}". Use debug | info | error.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Init OTEL first — must precede any instrumented code
  const otelServiceName =
    process.env["OTEL_SERVICE_NAME"] ?? "transparentguard-proxy";
  initTelemetry(otelServiceName);

  console.log(`[TransparentGuard] Loading policy: ${policyPath}`);

  let tg: TransparentGuard;
  try {
    tg = await TransparentGuard.init({
      policy: policyPath,
      apiKey: argv["tg-api-key"] ?? process.env["TG_API_KEY"],
      offlineMode,
    });
    console.log(`[TransparentGuard] Policy loaded: "${tg.getPolicy().name}"`);
  } catch (err) {
    console.error(`[TransparentGuard] Fatal: Failed to load policy from "${policyPath}".\n  ${String(err)}`);
    process.exit(1);
  }

  console.log(`[TransparentGuard] Upstream: ${upstreamUrl}`);

  const server = startServer({
    tg,
    upstream: upstreamUrl,
    upstreamApiKey: argv["upstream-api-key"] ?? process.env["UPSTREAM_API_KEY"],
    port,
    logLevel,
  });

  // ---------------------------------------------------------------------------
  // Graceful shutdown
  // ---------------------------------------------------------------------------
  let shutdownInProgress = false;

  const shutdown = (signal: string): void => {
    if (shutdownInProgress) return;
    shutdownInProgress = true;
    console.log(`\n[TransparentGuard] ${signal} received — shutting down gracefully...`);

    server.close(() => {
      console.log("[TransparentGuard] HTTP server closed.");
      void Promise.all([
        tg.flushAudit(),
        shutdownTelemetry(),
      ]).then(() => {
        console.log("[TransparentGuard] Shutdown complete.");
        process.exit(0);
      }).catch((shutdownErr: unknown) => {
        console.error(`[TransparentGuard] Shutdown error: ${String(shutdownErr)}`);
        process.exit(1);
      });
    });

    // Force-exit if graceful shutdown stalls
    setTimeout(() => {
      console.error("[TransparentGuard] Force-exiting after 10 s timeout.");
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
