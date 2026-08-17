FROM docker.m.daocloud.io/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The public image is provider-neutral. Supply a compatible connector executable
# through the deployment's private image layer or runtime mount.

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
  PORT=8788
USER node
EXPOSE 8788
CMD ["node", "src/worker.mjs"]
