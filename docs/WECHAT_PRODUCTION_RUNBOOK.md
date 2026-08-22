# 个人微信生产运行手册

本文用于当前 macOS 常驻服务器上的个人微信生产链路。目标是：固定入口、事实健康、自动恢复、可回滚，并确保开发工作区与生产运行完全隔离。本文不记录任何真实账号、域名、App ID、联系人标识、回调密钥或 Tunnel Token。

## 1. 生产拓扑与边界

```text
GeWe 事件 → 固定 HTTPS 主机名 → Cloudflare Named Tunnel → 127.0.0.1:17656
                                                        ↓
                                              AIPRO 持久化收件箱
                                                        ↓
                                              AI 处理 → GeWe 回复

独立可靠性监督器每 15 秒检查：本地 canary、Tunnel、公开 canary、GeWe 在线状态、回调注册。
```

生产使用四个独立 LaunchAgent：主服务、Cloudflare Tunnel、微信可靠性监督器、本地 Dashboard。主服务由 `caffeinate -s` 持有系统睡眠断言。监督器不依赖主服务存活，因此主服务退出时仍能完成拉起。

GeWe 的外部边界必须明确：如果事件从未送达本机且提供方不支持历史重放，本系统无法凭空恢复该消息。系统能保证的是已送达事件的持久化、去重、重试，以及本地、Tunnel、回调注册故障的自动恢复。

## 2. Cloudflare Named Tunnel

1. 在现有 Cloudflare 账号中创建专用于 AIPRO 微信回调的 remotely-managed Named Tunnel。
2. 为一个固定 HTTPS 主机名配置路由，origin 固定为 `http://127.0.0.1:17656`。
3. 连接器固定使用 IPv4；防火墙允许出站 `7844/TCP` 与 `7844/UDP`。若 UDP 不可用，可由 cloudflared 回落到 TCP，但应在验收记录中注明。
4. cloudflared metrics 固定绑定 `127.0.0.1:17657`，不得对局域网或公网开放。
5. Tunnel Token 只写入 macOS Keychain。使用受控凭据入口从标准输入写入，不把 Token 放进命令参数、环境持久文件、日志、Git 或聊天记录。
6. 正常状态应由 metrics 看到四条活跃 edge 连接，并且公开 canary 成功。仅“cloudflared 进程存在”不能视为健康。

Quick Tunnel（`trycloudflare.com`）只允许作为显式启用的应急回退。它没有固定主机名和生产 SLA，生产默认必须关闭；使用时要记录开始时间、原因和退出条件。

## 3. Canary 与事实健康

本地与公开探针都调用 `/internal/reliability/canary`。请求包含短时 HMAC，密钥来自 Keychain；响应和日志不输出密钥。Dashboard 必须同时展示以下事实：

| 层 | 健康条件 | 失败后的动作 |
|---|---|---|
| 本地主服务 | 本地 canary 成功 | 协调后重建主 LaunchAgent |
| Named Tunnel | metrics 可用且活跃连接大于 0 | 协调后重建 Tunnel |
| 公开回调 | 固定 HTTPS 主机名 canary 成功 | 重建 Tunnel、对齐回调、再验证 |
| GeWe 提供方 | 账号在线检查成功 | 标记 `provider_down`，不盲目重启本机 |
| 回调注册 | 注册地址与固定主机名一致 | 重新注册回调 |

任何事实缺失或超过三个探测周期未更新都失败关闭，不能用旧的 `connected: true` 覆盖。连续三次失败才触发恢复，连续三次成功才重新标记 `healthy`。破坏性恢复使用带抖动的退避和 15 分钟预算；超出预算进入 `circuit_open`，避免重启风暴。

## 4. Git 版本与生产目录

生产只允许从干净 Git commit 构建，不允许直接运行开发目录或 `.worktrees`：

```text
~/Library/Application Support/AIPRO/
  releases/<timestamp-tag-sha>/  # 只读、带 release-manifest.json
  current -> releases/<version>  # 原子切换
  previous -> releases/<version> # 回滚目标
  config/                         # config.local.json、BIBLE、PERSONA、知识目录
  data/                           # SQLite、收件箱、运行状态
  logs/                           # 四个 LaunchAgent 日志及恢复事件
```

标准路径是：功能分支 → 测试通过 → 干净 commit → 构建只读 release → 候选健康验证 → 原子切换 `current`。切换后的健康验证失败时，自动把 `current` 恢复为 `previous`，重启并再次验证已知良好版本。release 不删除，以便审计。

## 5. 安全恢复与回滚

自动恢复和人工恢复必须使用同一个协调器，禁止同时手工 `kill`、`launchctl kickstart` 和修改回调。每次只允许一个恢复动作，并留下仅含层、动作、耗时、结果和错误类别的记录。

人工恢复顺序：

1. 读取 Dashboard 与 `wechat-reliability-state.json`，确认失败层。
2. 若是 `provider_down`，保留本地服务，等待提供方恢复；不要制造重启风暴。
3. 若是本地/Tunnel/公开回调失败，通过可靠性协调器执行一次恢复并等待事实探针。
4. 若新版本切换后失败，执行 release rollback；不要直接修改只读 release。
5. 回滚后重新验证微信、钉钉两条链路，并检查无重复回复。

## 6. 上线验收

发布前执行全量测试和隔离故障注入。生产切换后必须保存不含个人数据的证据：

- `current` manifest 的 Git SHA 与预期 commit 一致，LaunchAgent 只指向 `Application Support/AIPRO/current`；
- 本地 canary、公开 canary、GeWe 在线和回调注册均成功；
- Cloudflare metrics 显示四条活跃连接；
- 终止一次 cloudflared 后，自动恢复 Tunnel、公开 canary 和回调注册；
- 个人微信真实消息形成 `received → durable enqueue → replied`，重启主服务后不重复回复；
- 钉钉 event-stream 已认证并 ready，真实入站回复、出站发送、重启重连与去重均成功；
- 隔离坏版本触发自动回滚，已知良好版本恢复健康；
- 主进程存在 `caffeinate` 睡眠断言，配置、数据、日志均位于 release 外部。

## 7. 告警与 SLO

运行目标为：健康状态 60 秒内可判定；本地进程或 Tunnel 单点退出后在恢复预算内自动拉起；已持久化消息不因进程重启丢失或重复回复。以下状态需要告警：`degraded` 表示已确认局部失败，`provider_down` 表示外部提供方不可用，`circuit_open` 表示自动恢复预算耗尽，`stale` 表示没有足够事实，必须按故障处理。

## 8. 后续双节点条件

双节点不是简单复制服务。启用前必须具备：共享或可复制的持久化收件箱、单写 leader lease、全局幂等键、回调入口的明确主备切换、Keychain 等价密钥分发、数据库复制与冲突策略、定期演练的 fencing。条件未满足前保持当前单节点 + 自动恢复 + 可回滚方案。
