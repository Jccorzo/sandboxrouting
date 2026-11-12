# Image for the router's `lambda-microvm` provider. Lambda MicroVMs are ARM64 only.
# Build it as a MicroVM image (CreateMicrovmImage) and pass its ARN as LAMBDA_MICROVM_IMAGE.
# Add whatever tools your sandboxes need on top; execd only needs Node.
FROM --platform=linux/arm64 node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git python3 && rm -rf /var/lib/apt/lists/*
COPY execd.mjs /opt/sbr/execd.mjs
ENV PORT=8080
EXPOSE 8080
CMD ["node", "/opt/sbr/execd.mjs"]
