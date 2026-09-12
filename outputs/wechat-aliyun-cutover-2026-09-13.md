# 微信中继阿里云切换回执（2026-09-13）

## 结果

- 微信 GeWe 回调、持久队列、临时附件入口已从 Railway → Cloudflare Worker 切到 `https://wxrelay.e2eskill.cn`，解析至现有阿里云香港轻量服务器。旧入口和凭据保留作回滚，不清空旧队列。
- 服务器当前到期日：2026-12-21 23:59:59（阿里云控制台核验）。新域名证书到期：2026-12-11；`certbot-renew.timer` 已启用，`certbot renew --dry-run` 成功。
- 新服务以独立 systemd 用户运行，仅监听 `127.0.0.1:17658`；Nginx 使用独立 vhost。未改动现有网站的 PM2 进程或主站 vhost。
- 本机主进程和微信中继 LaunchAgent 已载入新 origin；私有配置与两个原始 plist 备份在 AIPRO 本地私有备份目录，权限 `0600`。

## 验证

- DNS 权威服务器返回 `47.76.173.254`；新 HTTPS `/healthz` 返回 200，未授权 `/relay/status` 返回 401。
- 公网回调→租约→ACK 和附件上传→公网读取均成功；新旧队列在切换前均为 0，切换后再次核对均为 0。
- GeWe 回调重新注册成功，微信状态为 `healthy`、`callbackRegistered=true`、`providerOnline=true`、`publicReachable=true`；钉钉状态仍为 `healthy`。
- `e2eskill.cn` 首页为 200；Nginx 配置测试通过。独立监控 timer 每 5 分钟巡检服务、队列、磁盘、证书和备份；每日 SQLite 在线备份成功，独立路径恢复校验 `ok`。
- 本地服务协议测试 16/16 通过。全仓测试受隔离 worktree 缺少私有 `config.local.json` 影响，未作为本次部署验证依据。

## 未消除的限制

- GeWe 接入尚无历史补拉实现，不能宣称切换窗口的微信上游消息历史已全量查全。切换时本地入站队列未见新增，且新旧中继队列均清零，但这不等于上游历史完整。钉钉全会话历史搜索仍缺 `SearchRightsDenied` 权益。此次主进程重载后的生产 `signal_recovery` 心跳表未更新，不能把健康状态当成历史覆盖证明。
- 备份和监控均在同一台服务器，尚未配置离机备份或外部推送告警；服务器单点故障仍会影响入口。旧 Railway/Cloudflare 路径暂留作回滚。
- 现有另一个站点 `zhenyuskill.com` 的 HTTPS 证书在本次切换前已过期，未在本次微信迁移范围内修改。

## 回滚

若新入口异常：将 GeWe 回调和本机 `AIPRO_RELAY_ORIGIN` 恢复到原 Railway 域名，重新载入主进程和微信中继 LaunchAgent；核对两端队列与本地消息 ID 后再处理未 ACK 项，不删除新端残留记录。原配置的私有备份保留，且旧入口仍可访问。
