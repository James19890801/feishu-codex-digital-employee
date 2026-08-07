FROM docker.m.daocloud.io/library/node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

RUN npm install --global dingtalk-workspace-cli@1.0.56 \
  && npm cache clean --force

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production
USER node
EXPOSE 8788
CMD ["node", "src/worker.mjs"]
