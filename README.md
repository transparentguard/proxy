# TransparentGuard Proxy

An OpenAI-compatible HTTP proxy that sits between your application and any LLM provider, enforcing your [TransparentGuard Policy Spec (TPS)](https://github.com/transparentguard/transparentguard-policy-spec) policy on every request and response — with zero SDK changes required.

## Features

- **Drop-in proxy** — point any OpenAI SDK at the proxy URL instead of `api.openai.com`
- **Full TPS enforcement** — all rule types: PII redaction, keyword blocking, provider allowlists, token budgets, rate limits, classify rules, and threshold engine
- **Dual-provider** — handles both OpenAI (`/v1/chat/completions`) and Anthropic (`/v1/messages`) APIs
- **Buffer-mode streaming** — streaming responses are fully evaluated before re-emission (HIPAA-grade)
- **OTEL native** — zero-config distributed tracing; set `OTEL_EXPORTER_OTLP_ENDPOINT` and spans appear in Grafana/Datadog/Honeycomb/Jaeger
- **OCI-native policies** — load policies directly from OCI registries: `oci://ghcr.io/myorg/policy:v1.2`
- **Cosign-verified policies** — cryptographic supply-chain verification of OCI policy artifacts
- **Kubernetes-native** — Helm chart included, readiness/liveness probes, HPA support

## Quick Start

```bash
# Docker
docker run -p 8080:8080 \
  -e UPSTREAM_API_KEY=sk-... \
  ghcr.io/transparentguard/proxy:latest \
  --policy /dev/stdin <<'EOF'
tps_version: "1.0"
name: quick-start
rules:
  - id: block-secrets
    stage: pre-request
    action: redact
    targets:
      - type: pii
        categories: [api_keys, credentials]
    on_violation: redact
audit:
  enabled: true
  destination: stdout://
EOF
```

Then replace `https://api.openai.com` with `http://localhost:8080` in your code — no other changes needed.

## CLI Reference

```
tg-proxy --policy <path|oci://ref> --upstream <url> [options]

Required:
  --policy, -p   <path|oci://ref>  TPS policy file or OCI artifact reference
  --upstream, -u <url>             Upstream LLM base URL

Options:
  --port                <number>          Listen port (default: $PORT or 8080)
  --upstream-api-key    <key>             Upstream API key (default: from Authorization header)
  --tg-api-key          <key>             TransparentGuard API key for paid-tier features
  --log-level           debug|info|error  Verbosity (default: info)
  --offline-mode                          Skip license check (free tier only)
```

## OCI Policy Distribution

Distribute your policy as an OCI artifact — versioned, signed, and auto-deployed:

```bash
# Publish
oras push ghcr.io/myorg/my-policy:v1.0.0 \
  policy.yaml:application/vnd.transparentguard.policy+yaml

# Sign (keyless via Sigstore)
cosign sign ghcr.io/myorg/my-policy:v1.0.0

# Use in the proxy
tg-proxy --policy oci://ghcr.io/myorg/my-policy:v1.0.0 \
         --upstream https://api.openai.com
```

To require signature verification:
```bash
export TG_COSIGN_VERIFY=true
export TG_COSIGN_PUBLIC_KEY_PATH=/path/to/cosign.pub
tg-proxy --policy oci://ghcr.io/myorg/my-policy:v1.0.0 ...
```

### Verify any published image

```bash
cosign verify ghcr.io/transparentguard/proxy:v0.1.0 \
  --certificate-identity-regexp='https://github.com/transparentguard/proxy' \
  --certificate-oidc-issuer='https://token.actions.githubusercontent.com'
```

## OpenTelemetry Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` and get distributed traces with no code changes:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318

# Every request produces a trace with child spans:
#   tg.evaluate.pre_request   (pre-request policy evaluation)
#   tg.upstream.call          (upstream LLM call)
#   tg.evaluate.post_response (post-response policy evaluation)
```

**Span attributes:** `tg.policy_name`, `tg.pre_request.outcome`, `tg.post_response.outcome`, `tg.violations`, `llm.vendor`, `llm.request.model`

Works with: Grafana Tempo, Jaeger, Zipkin, Datadog, Honeycomb, AWS X-Ray, Azure Monitor, Dynatrace.

## Helm / Kubernetes

```bash
helm install tg-proxy oci://ghcr.io/transparentguard/charts/transparentguard-proxy \
  --set upstream.url=https://api.openai.com \
  --set upstream.apiKeySecret.name=openai-secret \
  --set policy.ociRef=oci://ghcr.io/myorg/my-policy:v1.0.0 \
  --set otel.endpoint=http://otel-collector:4318
```

See [`charts/transparentguard-proxy/values.yaml`](../../charts/transparentguard-proxy/values.yaml) for all options.

## Audit Destinations

The proxy inherits all of the runtime's audit destinations:

| URI scheme | Description |
|---|---|
| `stdout://` | Print to stdout (default) |
| `file:///path/to/audit.jsonl` | Append to local file |
| `s3://bucket/prefix/` | Upload to Amazon S3 (requires `@aws-sdk/client-s3`) |
| `postgres://user:pass@host/db` | Insert into PostgreSQL (requires `pg`) |
| `https://webhook.example.com` | POST to HTTP webhook |
| `otlp://host:4318` | OTLP Logs to OTEL collector |
| `otlps://host:4317` | OTLP Logs over HTTPS |

## License

MIT — core proxy and enforcement engine. Paid-tier features (cloud classifier APIs, managed policy registry) require a TransparentGuard API key.
