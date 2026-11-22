# web: the site, a static export served by nginx. Build from the repository root (the site is
# generated from the router's sources, README.md and docs/ at build time):
#
#   docker build -f web/Dockerfile -t sandboxrouting-web .
#
# Listens on PORT 8080. The build fetches its fonts from Google Fonts, so it needs network.

FROM node:22-alpine AS build
WORKDIR /repo
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
COPY back/package.json back/
COPY dashboard/package.json dashboard/
COPY web/package.json web/
# The generator imports the router, so the root package's dependencies come too.
RUN npm ci --workspace web --include-workspace-root --ignore-scripts --no-audit --no-fund
COPY . .
# The same steps as `npm run build -w web`, without hushrun's wrapper, which needs no image.
RUN cd web && npm run generate && npx next build

FROM nginx:1.27-alpine
COPY web/deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/web/out /usr/share/nginx/html
EXPOSE 8080
