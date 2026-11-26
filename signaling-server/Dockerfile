# Build from the repository root:
#   docker build -f signaling-server/Dockerfile -t karosync-signaling .

FROM node:22-alpine AS builder
WORKDIR /app

# Copy workspace manifests first for optimal Docker layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY signaling-server/package.json ./signaling-server/
COPY client-web/package.json ./client-web/
COPY extension/package.json ./extension/

RUN npm ci --workspace=@karosync/signaling

COPY signaling-server/tsconfig.json ./signaling-server/
COPY signaling-server/src ./signaling-server/src

RUN npm run build --workspace=@karosync/signaling

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

COPY package.json package-lock.json ./
COPY signaling-server/package.json ./signaling-server/
COPY client-web/package.json ./client-web/
COPY extension/package.json ./extension/

RUN npm ci --omit=dev --workspace=@karosync/signaling && npm cache clean --force

COPY --from=builder /app/signaling-server/dist ./signaling-server/dist

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "signaling-server/dist/index.js"]
