# AIPR0S 本人私有企业邮箱能力验收（2026-08-05）

## 结论

AIPR0S 已在现有钉钉数字人运行时中接入企业邮箱读取，以及发送、回复、回复全部、转发能力。运行链路只使用配置的独立 DWS CLI 和 `event-stream`，不使用悟空轮询或 `.real/.bin/dws` 代理路径。

## 能力边界

- 邮箱列表、查询、正文读取只允许本人钉钉 P2P 自聊。
- 查询条件由代码生成 KQL；默认 10 封、最多 30 封，并拒绝控制字符注入。
- 发送、回复、回复全部、转发先展示完整预览；同一本人、同一会话须在 15 分钟内确认。
- 写入通过 mutation execution ledger 保证不自动重放；结果不明确时要求到“已发送”核对。
- 邮件正文不进入对话记忆或审计，审计请求文本统一遮蔽为 `[mail request redacted]`。
- 本阶段不支持附件发送。

## 验收证据

1. `npm test`：退出码 0；邮件客户端、意图解析、工作流和全库回归全部通过。
2. `npm run check`：退出码 0；Node 语法、macOS Swift 类型检查、配置和 Python helper 检查通过。
3. `npm run test:mechanisms`：`91/91` 通过，其中包含邮件本人身份门禁和 15 分钟同会话确认租约。
4. 真实只读验收：唯一企业邮箱账号识别成功；`folderId:2` 搜索成功；选中邮件正文回读成功（只输出字符数，不输出主题、地址或正文）。
5. 真实工作流验收：`MailWorkflow` 通过本人 P2P 自聊上下文完成搜索并产出敏感响应；没有执行真实写入。
6. 写入安全演练：DWS `mail message send --dry-run` 接受命令，`realMailSent=false`。自动化验收没有发送真实邮件。
7. 服务部署：LaunchAgent `com.local.feishu-codex-digital-employee` 已重装；`npm run health` 返回 `healthy=true`，DingTalk `installed/authenticated/connected=true`。
8. 事件链路：运行日志出现两类订阅、`ready event_count=2` 和 `bus ... state=connected`；实际子进程为全局独立 DWS 的 `event consume`，未发现悟空或代理 DWS 进程。

## 已知非阻断项

`npm run event-health` 仍是历史飞书专用脚本；在 `feishuEnabled=false` 且本机没有 `lark-cli` 时以 `ENOENT` 退出。该脚本不检查钉钉。钉钉连接状态由通用健康检查、事件订阅 ready 日志和实际 DWS 子进程三项独立证据确认。

## 使用示例

- `看看今天未读的收件箱邮件`
- `查张三发的主题包含「项目进展」并且带附件的邮件`
- `打开第 2 封邮件`
- `给 张三 发邮件，抄送：李四，主题：周报，正文：本周完成 A`
- `回复第 2 封，正文：已收到`
- `回复全部第 3 封，正文：感谢大家`
- `转发第 1 封给 李四，附言：请查看`

写入指令只生成预览；本人回复 `确认` 后才会调用 DWS 写接口，回复 `取消` 则删除待执行计划。
