# 微信稳定边缘中继设计

## 背景与根因

当前生产微信回调依赖 Cloudflare Quick Tunnel。Quick Tunnel 每次重建都会生成新的 `trycloudflare.com` 地址，监督程序随后改写 `gewePublicCallbackBaseUrl` 并重启主服务。切换 Wi-Fi、热点或 VPN 时，DNS、QUIC/UDP 和默认路由会短暂变化，这套“隧道变化 → 回调变化 → 主程序重启”的耦合链路会放大一次正常的网络切换。

Cloudflare 账户当前没有 DNS Zone，但有固定的 `494161546.workers.dev` 子域名。GeWe 的验证节点无法访问 `workers.dev` 和 `pages.dev`，因此生产入口使用独立 Railway 项目的固定 `railway.app` 域名，并将请求无状态转发到 Cloudflare 持久层。现有 Named Tunnel 凭据有效，能建立四条 HTTP/2 连接，但没有可绑定的用户域名。

## 目标

- GeWe 回调地址永久固定，不因本机网络、进程或隧道重连改变。
- 本机短暂离线时，微信入站先在 Cloudflare 持久化，恢复后按消息 ID 补回。
- 主程序、边缘入口和隧道生命周期解耦；隧道重连不得重启主程序。
- 微信附件继续通过固定入口可访问，不退化现有发送能力。
- 所有控制接口使用独立高熵凭据，凭据只进入 macOS Keychain 和 Cloudflare Secret。

## 架构

1. `aipro-wechat-ingress-production.up.railway.app` 作为唯一稳定公网入口；Railway 服务不落盘、不解析消息，只流式转发到 Cloudflare Worker。
2. Worker 接收 `/webhooks/gewe/<callback-secret>`，在 Durable Object 中按载荷摘要去重并持久化，然后在 3 秒内返回 GeWe 要求的 HTTP 200。
3. 本地 relay agent 仅发起出站 HTTPS 长轮询，以租约方式取得消息；成功投递到 `127.0.0.1` 的现有 GeWe webhook 后再 ACK。租约超时会重新可见，形成至少一次交付，本地状态库继续按消息 ID 去重。
4. 发送附件时，启动导入模块覆盖现有 `registerArtifact`：将不超过 25MB 的文件上传至 Worker 的受保护接口并存入 Workers KV，返回与原结构兼容的固定公网 URL。对象由 KV TTL 自动过期。
5. Worker 实现现有签名 canary，因此原有五层健康检查仍能验证公网入口；本地队列健康由 relay agent 单独写入状态快照。
6. Named Tunnel 切换为 token 管理的固定 tunnel、强制 HTTP/2、四路连接，只作为备用诊断通道。Quick Tunnel 从 LaunchAgent 和自动恢复路径移除。

## 故障语义

- 网络切换：Worker 继续收消息；本地长轮询失败并指数退避，恢复后继续租约消费。
- 本机进程退出：未 ACK 消息在租约到期后重新可见。
- 重复 webhook：Worker 以摘要去重，本地仍以业务消息 ID 去重。
- Railway、Worker 或存储异常：返回非 2xx，保留上游重试机会，不伪报已接收。
- 附件上传失败：发送动作失败并保留明确错误，不生成不可用 URL。

## 安全与运维

- callback secret 沿用现有 Keychain 值；新增 relay token 和 artifact token，均不写入仓库或日志。
- Worker 不记录消息正文、联系人或凭据；日志仅记录事件 ID、时间、大小和状态。
- 保留 `signal_recovery` 断线台账。恢复核对区分已回复、按规则跳过、待处理和失败。
- 钉钉历史检索仍受 `SearchRightsDenied` 限制；GeWe 没有历史补拉，完整性以边缘中继启用后的持久队列为界。

## 验收

- 固定 Railway URL 连续可达，GeWe 查询到的注册 URL 与配置一致。
- 停止本地 relay 后发送测试 webhook，云端积压增加；恢复 relay 后本地落盘且云端 ACK。
- 重启 tunnel 或切换网络不改配置、不重启主服务。
- canary、本地 webhook、provider 在线、callback registration 和 relay backlog 均健康。
- 附件上传后可通过固定 URL 下载，过期后不可访问。
