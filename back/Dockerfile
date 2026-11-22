# back: the ingest and read API. Build from the repository root (it bundles the router's own
# definitions from src/):
#
#   docker build -f back/Dockerfile -t sandboxrouting-back .
#
# Configured only by environment variables: DATABASE_URL (required), PORT, SBR_ADMIN_TOKEN,
# SBR_INGEST_TOKEN, SBR_SWEEP_TOKEN, SBR_MIGRATE_ON_START, DATABASE_POOL_MAX. See back/src/main.ts.
# With SBR_MIGRATE_ON_START=0 (a role that can't change the schema), run the migrations first with
#   docker run ... node back/dist/cli.js migrate      (as the database's owner)

FROM node:22-alpine AS build
WORKDIR /repo
COPY package.json package-lock.json ./
COPY back/package.json back/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace back --ignore-scripts --no-audit --no-fund
COPY src src
COPY back back
RUN cd back && node build.mjs

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY back/package.json back/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace back --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY --from=build /repo/back/dist back/dist
USER node
EXPOSE 8787
CMD ["node", "back/dist/main.js"]
