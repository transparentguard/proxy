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

# Install all workspace deps (generates lock file on the fly)
RUN pnpm install --ignore-scripts

# Copy source + tsconfig
COPY packages/runtime/src/       ./packages/runtime/src/
COPY packages/runtime/tsconfig*.json ./packages/runtime/
COPY packages/proxy/src/         ./packages/proxy/src/
COPY packages/proxy/tsconfig*.json  ./packages/proxy/

# Compile runtime, then proxy
RUN pnpm --filter @transparentguard/runtime run build
RUN pnpm --filter @transparentguard/proxy   run build

# Bundle proxy + all production deps (including bundled runtime) into /prod
RUN pnpm deploy --filter @transparentguard/proxy --prod /prod

# Stage 2: lean runtime image
FROM node:22-alpine AS runner
RUN addgroup -S tgproxy && adduser -S -G tgproxy tgproxy
WORKDIR /app

# pnpm deploy creates a self-contained dir: node_modules + compiled dist
COPY --from=builder --chown=tgproxy:tgproxy /prod/node_modules ./node_modules
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/proxy/dist ./dist

# Default policy — permissive, no rules, audit off.
# Override at runtime: set CMD or mount a real policy at /app/policy.yaml
RUN mkdir -p /app/policies
COPY --chown=tgproxy:tgproxy --from=builder /dev/null /dev/null 2>/dev/null || true
RUN echo 'tps_version: "1.0"\nname: "TransparentGuard Default Policy"\nrules: []\naudit:\n  enabled: false' > /app/policies/default.yaml

USER tgproxy
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]
CMD ["--policy", "/app/policies/default.yaml", "--upstream", "https://api.openai.com"]

LABEL org.opencontainers.image.title="TransparentGuard Proxy"
LABEL org.opencontainers.image.source="https://github.com/transparentguard/proxy"
