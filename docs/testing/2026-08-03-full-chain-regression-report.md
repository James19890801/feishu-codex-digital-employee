# 2026-08-03 阿充数字人全链路回归报告

## 结论

本地数字人已切换为“阿充（James）的 AI 产品经理数字人”。主运行时为 Codex CLI，主 IM 链路为本机 DWS 个人事件流，飞书已关闭，悟空未接入。主服务、Dashboard、钉钉事件流、Codex、1A 只读访问、代码仓读取、状态库和备份均已通过验证。

## 本轮新增机制

1. 钉钉普通回复前，通过原 DWS 链路实时读取当前会话最新 30 条记录。
2. 组合对方最近一句、当前入站消息、阿充历史语气样本，再交给 Codex 生成回复。
3. 对阿里语境中的 5、6、7、8、9 进行上下文判断；层级语境解释为 P5-P9，日期、金额、数量、版本、时间和 ID 不误判。
4. 历史读取失败时不调用 Codex 盲回，记录可追溯的错误事件。
5. 1A 需求路由固化为 WebAgent 与 AI 协同空间两个产品；建需求前必须先读对应代码仓并完成结构化描述。

## 回归中发现并修复

| 问题 | 根因 | 修复与回读 |
|---|---|---|
| 历史实例中 Owner 样本识别不稳定 | 只靠显示名，未绑定已验证的 DWS 身份 | 改为验证 ID 优先，真实会话样本可正确识别“阿充James” |
| 会话 ID 与入站消息存在提供方差异 | 内部 chat ID 和 DWS `openConversationId` 可能不同 | 正常化双方 ID，保证上下文读取对准当前会话 |
| Dashboard 显示飞书 PRIMARY、钉钉 OPTIONAL | 通道徽标在 HTML 中写死 | 改为运行时模型驱动；实机显示钉钉 PRIMARY、飞书 DISABLED |
| 消息轮询显示约 49 万小时 | 飞书关闭时仍将空游标按 epoch 计算 | 增加 `polling.applicable`，关闭时显示 Disabled / Not enabled，健康输出为 `null` |
| 钉钉事件流已在线但“最近就绪”为空 | Dashboard 只读取旧飞书 WebSocket 时间 | 钉钉主通道时优先使用 DWS 事件流就绪时间 |
| 健康时仍能看到“Maintenance required” | 这是操作指南的静态标题，不是当前状态 | 改为“Amber · Degraded”，避免与实时健康结果混淆 |
| DWS 已登录、事件流在线，但主动私聊被 `ENTERPRISE_NOT_AUTHORIZED` 拒绝 | 阿里巴巴组织要求每条 DWS 请求携带已登记的 `DWS_CHANNEL`；登录态本身不代表产品权限 | 按 DWS 官方本机参考使用命令级渠道环境变量；运行时已由 `buildDingTalkProcessEnv` 注入所有历史读取、发送和事件流子进程，未写全局 shell 配置 |

## 自动化与实机证据

- `npm run check`：通过。
- `npm test`：通过。
- 机制验收：`87/87`，0 失败。
- `npm run runtime-smoke`：`healthy=true`，选中 `codex`，标签 `Codex CLI`。
- `npm run health`：`healthy=true`，`issues=[]`，钉钉已认证且已连接，飞书已关闭，1A 待发与死信均为 0。
- `npm run backup-smoke`：SQLite `integrity=ok`，备份可读，外部变更数为 0。
- LaunchAgent：主服务与 Dashboard 均为 `running`。
- 1A 只读：两个目标需求池均可读，两个目标代码仓根目录均可读，未创建测试工作项。
- DWS 实时上下文探针：读取 17 条最近消息，识别 9 条 Owner 消息、8 条对方消息和 8 条语气样本，未在日志中输出消息正文。
- 浏览器实机：`All systems operational`，钉钉 `PRIMARY / Online`，飞书 `DISABLED`，Codex CLI `ONLINE`，消息轮询 `Disabled`，事件流展示真实就绪时间，控制台 0 个 error/warn。

## 最终外部送达

- 收件人：谢冰雪（师姐）。
- 文本：`师姐，我满四周年啦，什么时候请我吃饭？——阿充（James）`
- 收件人回查：唯一命中谢冰雪 / 君栩 / 谢冰雪Emily / 工号 326584，与已存绑定一致。
- 首次不带渠道码的请求：确定失败，`ENTERPRISE_NOT_AUTHORIZED`，未送达。
- 修正后：`success=true`，`sendStatus=SUCCESS`。
- `openTaskId`：`eTuxB9Gmuv2IMpIDDJNXlxabAVODZa4mLPxIu3J1gA0=`
- `openMessageId`：`msgHzMu7WA9PZFQLz3YKzW6zw==`
- 去重：全程使用同一固定幂等 UUID，未对不确定结果重试。
