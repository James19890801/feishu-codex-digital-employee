# 阿里云香港微信中继

独立服务监听 `127.0.0.1:17658`，SQLite WAL 数据库与附件位于 `/var/lib/aipro-wechat-relay`；Nginx 仅为 `wxrelay.e2eskill.cn` 增加独立虚拟主机。不要覆盖现有网站的 PM2 或 Nginx 配置。

切换门槛：先确认服务器**续费**后到期日已延长、现有网站健康、旧队列清零、域名 DNS 和 HTTPS 可用。阿里云镜像需手动安装证书，执行 `nginx -t` 成功后才 reload。配置 `/etc/aipro-wechat-relay/config.json` 必须属 `root:aipro-wechat-relay` 且模式 `0640`，包含原有 callbackSecret、relayToken、artifactToken、canarySecret；不得提交 Git、打印或留在 shell 历史中。数据库与附件目录仅服务用户可写。

先运行 `bash deploy.sh` 安装独立文件和 systemd 单元，再由操作者安全提供私有配置并启动服务。运行 `node --test *.test.mjs`、访问 `/healthz`、测试回调→租约→ACK→附件。测试前后检查现有网站。状态接口必须带 Relay Bearer token；公开健康接口不得暴露正文或令牌。

备份：服务启动后执行 `systemctl enable --now aipro-wechat-relay-backup.timer`，每日运行 `backup.sh`，用 SQLite `.backup` 在线备份到 root-only 的 `/var/backups/aipro-wechat-relay`，并执行 `PRAGMA quick_check`。首次应手动 `systemctl start aipro-wechat-relay-backup.service`，将最新备份复制到独立临时路径，再次运行 `PRAGMA quick_check` 和事件数查询。附件 TTL 最长 900 秒，不进入长期备份。备份目录需要纳入磁盘容量巡检与离机备份策略，避免与源数据同机单点故障。

证书：先用 `nginx.bootstrap.conf` 创建仅处理 ACME challenge 的 HTTP vhost，`nginx -t` 后 reload；DNS 生效后使用 certbot webroot 签发，再切换为 `nginx.conf.example` 的独立 HTTPS vhost，重新 `nginx -t` 与 reload。确认 `certbot-renew.timer` 已启用，并用 `certbot renew --dry-run` 验证续签。不可覆盖已有站点证书。

回滚：保留旧 Railway/Cloudflare 配置与凭据。若新入口故障，先恢复 GeWe 登记回调和 Mac relay origin 到旧地址，再核对两边队列与本地消息 ID；不可清空未 ACK 消息。确认新入口持续稳定后，才停用旧微信流量，不影响独立许可服务。
