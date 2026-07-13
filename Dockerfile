# ============================================================================
# TransparentGuard Proxy — Multi-stage Docker build
# Base image: node:22-alpine (minimal attack surface)
# Final image is non-root, distroless-style layout
# ============================================================================

# ---------------------------------------------------------------------------
# Stage 1: builder — install all deps and compile TypeScript
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

WORKDIR /app

# Install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy workspace manifests first (layer cache: only reinstall deps when they change)
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/runtime/package.json           ./packages/runtime/package.json
COPY packages/proxy/package.json             ./packages/proxy/package.json

# Install all workspace deps
RUN pnpm install --frozen-lockfile --ignore-scripts

# Copy source
COPY packages/runtime/src/      ./packages/runtime/src/
COPY packages/runtime/tsconfig*.json ./packages/runtime/
COPY packages/proxy/src/        ./packages/proxy/src/
COPY packages/proxy/tsconfig*.json  ./packages/proxy/

# Build runtime first, then proxy
RUN pnpm --filter @transparentguard/runtime run build
RUN pnpm --filter @transparentguard/proxy    run build

# Prune dev dependencies for the final stage
RUN pnpm deploy --filter @transparentguard/proxy --prod /app/deploy

# ---------------------------------------------------------------------------
# Stage 2: runner — lean production image
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner

# Security: run as non-root
RUN addgroup -S tgproxy && adduser -S -G tgproxy tgproxy

WORKDIR /app

# Copy only what the proxy needs at runtime
COPY --from=builder --chown=tgproxy:tgproxy /app/deploy/node_modules ./node_modules
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/runtime/dist ./packages/runtime/dist
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/proxy/dist    ./dist

USER tgproxy

# Default port (override with PORT env var or --port flag)
ENV PORT=8080
EXPOSE 8080

# Health check — liveness probe
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1

ENTRYPOINT ["node", "dist/index.js"]

# Common defaults — all can be overridden at runtime
CMD ["--upstream", "https://api.openai.com"]

# ---------------------------------------------------------------------------
# Labels (OCI image spec)
# ---------------------------------------------------------------------------
LABEL org.opencontainers.image.title="TransparentGuard Proxy"
LABEL org.opencontainers.image.description="OpenAI-compatible HTTP proxy with AI policy enforcement"
LABEL org.opencontainers.image.vendor="TransparentGuard"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/transparentguard/proxy"
LABEL org.opencontainers.image.documentation="https://transparentguard.com/docs/proxy"
