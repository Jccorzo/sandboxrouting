# dashboard: the usage dashboard (Next.js, standalone server). Build from the repository root:
#
#   docker build -f dashboard/Dockerfile -t sandboxrouting-dashboard .
#
# Configured only by environment variables: BACK_URL (back as this server reaches it, required),
# BACK_PUBLIC_URL (back as routers reach it, shown in the key setup snippet), PORT.

FROM node:22-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY back/package.json back/
COPY dashboard/package.json dashboard/
RUN npm ci --workspace dashboard --ignore-scripts --no-audit --no-fund
# The dashboard imports back's response types, which import the router's; nothing of them ships.
COPY src src
COPY back/src back/src
COPY dashboard dashboard
RUN cd dashboard && npx next build

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
WORKDIR /app
COPY --from=build --chown=node:node /repo/dashboard/.next/standalone ./
COPY --from=build --chown=node:node /repo/dashboard/.next/static dashboard/.next/static
USER node
EXPOSE 3000
CMD ["node", "dashboard/server.js"]
