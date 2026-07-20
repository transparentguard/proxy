# ============================================================
# TransparentGuard Proxy — multi-stage Docker build
# Pinned to pnpm v9 — last major version before pnpm v10/v11
# introduced mandatory build-script approval (ERR_PNPM_IGNORED_BUILDS).
# pnpm v9 deploy creates a self-contained node_modules with no symlinks,
# resolves workspace:* links to real packages, and needs no extra flags.
# ============================================================

# Stage 1: build
FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@9 --activate

# Layer-cache: reinstall only when manifests change
COPY package.json pnpm-workspace.yaml ./
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/proxy/package.json   ./packages/proxy/package.json
RUN pnpm install --ignore-scripts

# Copy source + tsconfig
COPY packages/runtime/src/           ./packages/runtime/src/
COPY packages/runtime/tsconfig*.json ./packages/runtime/
COPY packages/proxy/src/             ./packages/proxy/src/
COPY packages/proxy/tsconfig*.json   ./packages/proxy/

# Compile runtime first (proxy depends on it), then proxy
RUN pnpm --filter @transparentguard/runtime run build
RUN pnpm --filter @transparentguard/proxy   run build

# Bundle proxy + prod deps into /prod — self-contained, no symlinks
# workspace:* resolved to real package contents (runtime dist included)
RUN pnpm deploy --filter @transparentguard/proxy --prod /prod

# Hard-copy runtime dist as a safety guarantee:
# pnpm deploy respects the runtime's "files" field; if dist/ is missing
# from that list or the field references non-existent files, this ensures
# the compiled runtime is always present in the final bundle.
RUN mkdir -p /prod/node_modules/@transparentguard/runtime && \
    cp  packages/runtime/package.json \
        /prod/node_modules/@transparentguard/runtime/package.json && \
    cp -r packages/runtime/dist \
          /prod/node_modules/@transparentguard/runtime/dist

# ============================================================
# Stage 2: lean runtime image
# ============================================================
FROM node:22-alpine AS runner
RUN addgroup -S tgproxy && adduser -S -G tgproxy tgproxy
WORKDIR /app

# Production bundle from pnpm deploy (no devDeps, no symlinks)
COPY --from=builder --chown=tgproxy:tgproxy /prod/node_modules ./node_modules
# Compiled proxy JS
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/proxy/dist ./dist

# Bake in a default permissive policy so the container starts
# with no env vars required. Override by setting TG_POLICY_PATH
# to a mounted policy file.
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
