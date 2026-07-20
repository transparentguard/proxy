# ============================================================
# TransparentGuard Proxy — multi-stage Docker build
# ============================================================

# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate

# Layer-cache: reinstall only when manifests change
COPY package.json pnpm-workspace.yaml ./
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/proxy/package.json   ./packages/proxy/package.json
RUN pnpm install --ignore-scripts

# Copy source + config
COPY packages/runtime/src/           ./packages/runtime/src/
COPY packages/runtime/tsconfig*.json ./packages/runtime/
COPY packages/proxy/src/             ./packages/proxy/src/
COPY packages/proxy/tsconfig*.json   ./packages/proxy/

# Compile runtime first (proxy depends on it), then proxy
RUN pnpm --filter @transparentguard/runtime run build
RUN pnpm --filter @transparentguard/proxy   run build

# pnpm deploy: creates /prod with a self-contained non-symlinked node_modules
# workspace:* links are resolved to real package contents
RUN pnpm deploy --legacy --ignore-scripts --filter @transparentguard/proxy --prod /prod

# Guarantee the runtime dist is present even if pnpm deploy skips it
# (happens when runtime package.json files field lists non-existent README/LICENSE)
RUN mkdir -p /prod/node_modules/@transparentguard/runtime && \
    cp packages/runtime/package.json /prod/node_modules/@transparentguard/runtime/package.json && \
    cp -r packages/runtime/dist      /prod/node_modules/@transparentguard/runtime/dist

# ============================================================
# Stage 2: lean runtime image
# ============================================================
FROM node:22-alpine AS runner
RUN addgroup -S tgproxy && adduser -S -G tgproxy tgproxy
WORKDIR /app

# Self-contained production bundle from pnpm deploy
COPY --from=builder --chown=tgproxy:tgproxy /prod/node_modules ./node_modules
# Proxy compiled JS
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/proxy/dist ./dist

# Default permissive policy — no rules, audit off.
# Override: set TG_POLICY_PATH env var pointing at a mounted real policy.
RUN mkdir -p /app/policies && \
    printf 'tps_version: "1.0"\nname: "TransparentGuard Default"\nrules: []\naudit:\n  enabled: false\n' \
    > /app/policies/default.yaml

USER tgproxy

ENV PORT=8080
ENV TG_POLICY_PATH=/app/policies/default.yaml
ENV UPSTREAM_URL=https://api.openai.com

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]

LABEL org.opencontainers.image.title="TransparentGuard Proxy"
LABEL org.opencontainers.image.source="https://github.com/transparentguard/proxy"
