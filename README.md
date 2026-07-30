# AIPRO｜基于真人身份运行的AI数字人平台

这不是一个只会聊天的机器人，而是一条完整工作链：

`用户消息轮询发现 @ / 单聊 → WebSocket 辅助补充 → 持久化去重与排队 → Codex CLI 执行 → 用授权用户身份回写飞书 → 记忆与审计留痕`

## 一、四步方法

1. **定人设**：编辑 `PERSONA.md`，写清它是谁、服务谁、什么语气、什么不能说。
2. **定工作流**：编辑 `BIBLE.md`，写清触发、取资料、执行、交付、异常和人工确认。
3. **接能力**：代码已接 Codex CLI、文档/图片/文件理解、Word 生成、飞书资料、待办和日程。
4. **接渠道并验证**：用户身份消息轮询为主入口，bot WebSocket 为辅助入口，官方 `lark-cli --as user` 用授权用户身份回写。

## 二、前置条件

- macOS，已安装并登录 Codex CLI。
- Node.js 20+、Python 3。
- 安装飞书官方 CLI：`pnpm add -g @larksuite/cli`（或 `npm install -g @larksuite/cli`）。
- 飞书自建应用；建议同时启用长连接事件 `im.message.receive_v1` 作为辅助通道。
- 飞书应用至少开放：消息读取、会话消息历史、图片/文件读取；需使用文档、待办、日程时再最小化加对应权限。
- 用户 OAuth 必须授权 `offline_access search:message im:message im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user`。

> 当前配置面向全部群聊和单聊，群聊仅响应 @ 真人账号，单聊直接响应；回复不添加 AI 标签。承诺、付款、公开发布、删除等高风险动作仍然拒绝自动执行。

## 三、部署

```bash
unzip 真人数字员工_Codex飞书交接包.zip
cd 真人数字员工_Codex飞书交接包
chmod +x scripts/*.sh
./scripts/setup.sh
```

然后完成三个文件：

1. `config.local.json`：填自己的 App ID、owner open_id、测试群 chat_id。
2. `PERSONA.md`：填自己的身份、语气和真实语料。
3. `BIBLE.md`：按场景删改工作流和审批红线。

默认使用官方 `lark-cli --as user` 轮询用户可见消息，并用 `lark-cli event`
保留 bot WebSocket 辅助通道，因此不需要把 App Secret 复制出
`lark-cli` 的安全存储。只有将 `eventTransport` 改为 `sdk` 时，才需要把
App Secret 写入下面的专用 macOS 钥匙串项：

```bash
security add-generic-password -U -a 'cli_你的AppID' \
  -s 'codex-feishu-digital-employee' -w '你的AppSecret'
```

本交接包默认把 `allowAllChats` 设为 `true`、`authorizedChatIds` 设为空数组，
因此全部会话开放；群聊仍需 @ 真人账号。`digitalTwinLabel` 默认为空字符串，
回复不加 AI 前缀。

完成飞书用户 OAuth 并检查：

```bash
lark-cli auth login --scope 'offline_access search:message im:message im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user'
lark-cli auth check --scope 'search:message im:message im:message:readonly im:message.group_msg:get_as_user im:message.p2p_msg:get_as_user im:message.send_as_user' --json
```

成功结果必须包含 `"ok": true` 和 `"identity": "user"`。

安装常驻服务：

```bash
./scripts/install-service.sh
./scripts/install-dashboard-service.sh
./scripts/verify.sh
```

## 四、运维界面

浏览器打开 [http://127.0.0.1:17655](http://127.0.0.1:17655)。这是一个只监听
本机回环地址的独立看门人，不对局域网或互联网开放，也不依赖数字员工主进程存活。

- 绿色“运行正常”：主进程、消息轮询、WebSocket、Codex 代理和 SQLite 均正常。
- 橙色“需要维护”：进程仍在，但至少一条关键链路已停滞或不可用。
- 红色“主进程离线”：看门人仍在线，可在页面点击“重启主进程”。
- 页面每 5 秒自动刷新；状态发生变化时会发送 macOS 本地通知。
- 飞书内发送“状态”可查看通道健康，发送“帮助”可查看使用说明；账号本人会看到完整队列和本机面板地址，其他人只看到简化状态。
- 断线、部分恢复和完全恢复都会触发 macOS 本地横幅，因此飞书本身断线时仍能告警。

## 五、验收

在 `authorizedChatIds` 指定的测试群中完成：

1. `@数字员工 帮我总结这段内容`：验证收发。
2. 发一张截图后问图片内容：验证文件读取。
3. `帮我生成一份 Word 总结并发回群里`：验证 Codex 执行与文件回传。
4. `帮我建明天下午 3 点的待办：整理数据`：必须先预览，回复“确认”后才创建。
5. 发“暂停接管”和“恢复接管”：验证真人接管。

只有真实收到消息、真实用用户身份回写，才算端到端通过。`auth check` 只证明授权，不等于真实送达。

本地健康检查：

```bash
npm run health
./scripts/verify.sh
```

健康检查会验证 SQLite 完整性、轮询游标新鲜度、超时处理中消息、失败/死信、
Codex 代理端口、真实 Codex 采样、OAuth 权限、WebSocket 消费者和 LaunchAgent 运行状态。

## 六、文件说明

- `src/index.mjs`：用户消息轮询、WebSocket 辅助监听、消息桥、Codex 运行与回写。
- `src/polling.mjs`：轮询筛选、标准化、查询参数与退避策略。
- `src/state.mjs`：持久化收件箱、原子领取、重试、死信、记忆、限流和审计。
- `scripts/health-check.mjs`：只读健康检查，可接入本机定时监控。
- `src/dashboard-server.mjs`：与主进程分离的本机运维面板和状态 API。
- `PERSONA.md`：Identity + Persona。
- `BIBLE.md`：工作流与权限边界。
- `knowledge-catalog.json`：允许读取的飞书文档白名单。
- `data/agent-state.sqlite`：会话记忆和审计记录，不会被打包。
- `config.local.json`：本机配置，不会被提交或二次分发。

## 七、故障排查

```bash
tail -f bridge.log bridge-error.log
launchctl print gui/$(id -u)/com.local.feishu-codex-digital-employee
launchctl print gui/$(id -u)/com.local.feishu-codex-dashboard
lark-cli auth check --scope 'im:message im:message.send_as_user' --json
```

- 没收到消息：检查用户 OAuth、`search:message`、群内是否 @ 真人账号，以及轮询日志；WebSocket 仅是辅助通道。
- 收到但没回复：检查 Codex 登录、`lark-cli` OAuth 和错误日志。
- 后台提示 `keychain access blocked`：在明确接受“同一 macOS 用户下的进程可读取本地密钥文件”的安全影响后，执行 `lark-cli config keychain-downgrade`，再重启主进程。
- 能回文本但不能发文件：检查飞书资源上传权限及 CLI 文件发送能力。
- 回复不像本人：不要只写形容词，向 `PERSONA.md` 补真实语料和反例。

## 八、可靠性边界

- 这是 LaunchAgent 守护的单机服务。Mac 关机、休眠、断网期间无法秒级响应；恢复后最多补追 24 小时消息。
- 消息轮询依赖飞书用户搜索接口的完整性和时效；结果出现未分页完成时程序拒绝推进游标，避免静默漏消息。
- 核心文字问答和真人身份回写使用用户 OAuth。图片、文件、飞书文档、待办、日程还需要 SDK 业务凭据；未配置时程序会明确说明能力不可用。
- Codex 以临时会话、只读沙箱和隔离工作目录运行，但“零信任”级文件隔离仍需独立系统账号/容器或改用不带本机工具的模型 API。
- 如果本机访问 OpenAI 需要代理，在 `codexProxyUrl` 中填写可信代理地址。健康检查会验证代理端口，`npm run codex-smoke` 会验证真实采样。
