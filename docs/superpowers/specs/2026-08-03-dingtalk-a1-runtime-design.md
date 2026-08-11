# DingTalk + A1 本地运行时设计

## 目标

将 AIPRO 在当前 macOS 设备上运行为一个不依赖飞书的本地数字人服务：

- DingTalk 是已授权真人身份的主消息通道。
- A1 是唯一的研发需求管理运行时，替代 Multica。
- Codex 和 Qoder 都要被探测并分别通过真实响应冒烟测试；线上请求使用配置选中的单一 AI 运行时，默认 `auto`。
- 本地控制台展示所有运行时的真实安装、配置、认证和联机状态。

## 范围

### 飞书

新增 `feishuEnabled` 开关。当其为 `false` 时：

- `feishuAppId` 和 `ownerOpenId` 不再是必填项。
- 不创建飞书轮询、WebSocket 消费者或回复通道。
- 健康检查不将飞书未配置认定为故障。
- 控制台显示“已禁用”，不使用伪造 App ID 或 Open ID 绕过校验。

为避免破坏其他部署，未显式配置 `feishuEnabled` 时保持现有飞书启用语义；当前机器的 `config.local.json` 明确设为 `false`。

### DingTalk

DingTalk 成为主通道，复用已有 `dingtalk-workspace-cli >= 1.0.55` 适配器：

- 启动前校验 CLI 版本、当前 profile 和 OAuth 状态。
- 订阅 `user_im_message_receive_at` 和 `user_im_message_receive_o2o_all`。
- 群聊仅在真实 @ 时触发，单聊消息直接触发。
- 回复继续强制 `--ai-tag=false` 和交付幂等。
- 认证失效时报告真实阻断原因，不把“未读取”显示成“无消息”。

### A1

新增独立 A1 适配器，不重命名 Multica 模块，也不复用 Multica profile 或 workspace 语义。

配置字段：

- `a1Enabled`：启用 A1 能力与健康检查。
- `a1Bin`：A1 CLI 可执行文件路径。
- `a1DefaultProjectId`：可选默认项目；空值时创建操作必须从请求中解析出明确项目。
- `a1SyncIntervalMs`：变化同步间隔。
- `a1MaxWorkitems`：单轮扫描上限。

运行时只调用官方 `a1` CLI，并设置 `A1_NO_UPDATE_CHECK=1`。认证通过 `a1 auth whoami -f json` 只读验证；不读取、复制、记录或传递 BUC/PAT 凭据。

支持的首版能力：

- 只读：列出工作项、获取详情、查看活动、列出可用项目。
- 写入：创建需求/缺陷/任务、更新工作项、创建评论。
- 跟进：订阅单个工作项的关键变化；全局同步只覆盖配置的默认项目，没有默认项目时不启动全局扫描。

所有 A1 写入必须复用现有“预览 → 六位码二次确认 → 执行 → 回读”机制。回读使用 `a1 project workitem get <id> -f json`，写入失败不得生成成功文案。

### Multica

当前部署强制 `multicaEnabled: false`，不启动 Multica 客户端、同步器或冒烟测试。控制台业务系统卡片替换为 A1。旧 Multica 模块暂保留为代码兼容层，但不被当前启动路径引用，避免本次上线夹带无关数据迁移。

## 数据流

1. DWS 长连接收到 DingTalk 单聊或 @ 消息。
2. 消息进入现有 SQLite 收件箱，继续使用去重、会话串行和重试。
3. 选中的 AI 运行时生成普通回复，或生成受约束的 A1 操作计划。
4. A1 只读计划立即执行；写入计划进入待确认队列。
5. 写入确认后调用 A1 CLI，再读取工作项详情验证服务端结果。
6. 最终结果经 DingTalk 回到原会话，并写入审计日志。

## 故障隔离

- DingTalk 长连接故障不终止控制台或 A1 健康检查。
- A1 认证或网络故障不终止 DingTalk 普通对话；A1 卡片独立降级并保留最近错误。
- Codex 或 Qoder 单个运行时冒烟失败时，该运行时标记为不可用；`auto` 只选择已通过真实响应校验的执行器。
- 任何外部数据源未读取时，状态为“无法确认”或“未认证”，不得转换为“无变化”。

## 测试与验收

- 配置测试：飞书禁用时允许空飞书标识；启用时保持现有严格校验。
- 启动测试：无飞书配置不会启动飞书组件，DingTalk 组件独立启动。
- A1 客户端测试：参数构造、JSON 解析、超时、有界输出、失败摘要和写入后回读。
- A1 能力测试：只读直接执行，写入必须确认，待确认上下文必须与原请求一致。
- A1 同步测试：新增、修改、去重、重试和死信处理。
- UI 测试：控制台显示 DingTalk、A1、Codex、Qoder 的真实状态，飞书显示已禁用，Multica 不再显示为业务运行时。
- 真实冒烟：DWS 认证和事件长连接、A1 `auth whoami` 与只读工作项请求、Codex 回复、Qoder 回复、`/api/status` 与 LaunchAgent 存活。

## 不在本次范围

- 不创建或授权任何飞书应用。
- 不迁移旧 Multica 数据库表。
- 不自动选择 A1 默认项目；未配置时，写入请求必须明确指定项目。
- 不安装或声称支持本机没有可用 headless CLI 的 AI 运行时。
