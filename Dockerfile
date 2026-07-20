FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@latest --activate
COPY package.json pnpm-workspace.yaml ./
COPY packages/runtime/package.json ./packages/runtime/package.json
COPY packages/proxy/package.json    ./packages/proxy/package.json
RUN pnpm install --ignore-scripts
COPY packages/runtime/src/      ./packages/runtime/src/
COPY packages/runtime/tsconfig*.json ./packages/runtime/
COPY packages/proxy/src/        ./packages/proxy/src/
COPY packages/proxy/tsconfig*.json  ./packages/proxy/
RUN pnpm --filter @transparentguard/runtime run build
RUN pnpm --filter @transparentguard/proxy    run build
RUN pnpm deploy --filter @transparentguard/proxy --prod /app/deploy

FROM node:22-alpine AS runner
RUN addgroup -S tgproxy && adduser -S -G tgproxy tgproxy
WORKDIR /app
COPY --from=builder --chown=tgproxy:tgproxy /app/deploy/node_modules      ./node_modules
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/runtime/dist    ./packages/runtime/dist
COPY --from=builder --chown=tgproxy:tgproxy /app/packages/proxy/dist      ./dist
USER tgproxy
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT}/health || exit 1
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--upstream", "https://api.openai.com"]
