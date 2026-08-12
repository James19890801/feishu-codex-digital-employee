FROM docker.m.daocloud.io/library/node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0

RUN npm install --global --ignore-scripts dingtalk-workspace-cli@1.0.56 \
  && dws_arch="$(dpkg --print-architecture)" \
  && case "$dws_arch" in amd64|arm64) ;; *) exit 2 ;; esac \
  && mkdir -p /usr/local/lib/node_modules/dingtalk-workspace-cli/vendor \
  && tar -xzf "/usr/local/lib/node_modules/dingtalk-workspace-cli/assets/dws-linux-${dws_arch}.tar.gz" \
    -C /usr/local/lib/node_modules/dingtalk-workspace-cli/vendor --strip-components=0 dws \
  && chmod 0755 /usr/local/lib/node_modules/dingtalk-workspace-cli/vendor/dws \
  && npm cache clean --force

WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
  PORT=8788
USER node
EXPOSE 8788
CMD ["node", "src/worker.mjs"]
