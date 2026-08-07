FROM node:24.5.0-bookworm-slim@sha256:541f5d24f96be2bea3bd208a9aa06b0429a455b4b6fa07179e4e5f261be454d9

RUN npm install --global dingtalk-workspace-cli@1.0.56 \
  && npm cache clean --force

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production
USER node
EXPOSE 8788
CMD ["node", "src/worker.mjs"]
