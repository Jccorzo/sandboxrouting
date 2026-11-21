# The image every Cloud Run sandbox starts from. The sandbox sees this image's file system
# (read-only, with a writable overlay), so add the tools your commands need here.
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git curl && rm -rf /var/lib/apt/lists/*
COPY execd.mjs /opt/sbr/execd.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "/opt/sbr/execd.mjs"]
