# Pure Engage: API + built console in one image (PE_CONSOLE_DIR). TypeScript runs directly on Node 22.
# Build:  docker build -t pure-engage .
# Run:    see docker-compose.yml and .env.example (PE_TRACKING_SECRET and PE_SECRET_KEY are required in production).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
COPY packages/shared/package.json packages/shared/
COPY packages/purenet-connector/package.json packages/purenet-connector/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/console apps/console
RUN npm run build -w @pure-engage/console

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4200 PE_CONSOLE_DIR=/app/apps/console/dist
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/console/package.json apps/console/
COPY packages/shared/package.json packages/shared/
COPY packages/purenet-connector/package.json packages/purenet-connector/
RUN npm ci --omit=dev --no-audit --no-fund -w @pure-engage/api && npm cache clean --force
COPY packages packages
COPY apps/api/src apps/api/src
COPY --from=build /app/apps/console/dist apps/console/dist
USER node
EXPOSE 4200
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4200)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/api/src/main.ts"]
