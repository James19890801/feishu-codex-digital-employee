# AIPR0S 本人私有邮件能力设计

## 决策

AIPR0S 将通过现有独立 DWS CLI 和已登记的 Profile、DWS Channel 接入钉钉企业邮箱。邮件查阅只对经过验证的账号本人私聊开放；发送、回复、回复全部和转发属于 L2 写操作，必须经过预览和同一本人会话确认，再执行一次并回读投递状态。

本能力不安装、不启动、不依赖悟空，不允许 `wukong-polling`，也不从独立 DWS 自动降级到其他通道。

## 已验证基础

- 当前运行配置为 `dingtalkEnabled=true`、`dingtalkTransport=event-stream`。
- DWS 使用配置中的绝对路径 `/Users/fengzhouchong.fzc/.npm-global/bin/dws`，当前版本为 v1.0.56。
- AIPR0S 已配置 DWS Profile 和 Channel；健康检查显示钉钉真人账号已认证、已连接。
- 使用同一平台配置执行 `mail mailbox list` 的真实只读探针成功，检测到一个企业邮箱。
- 当前二进制提供 `mailbox list`、`message search`、`message get`、`message send`、`message reply`、`message reply-all`、`message forward`、`draft create` 和 `message verify`。
- `message verify` 的 Cobra 命令真实存在，但缺少对应 Runtime Schema 条目。实现以真实 `--help` 契约为准，并把该漂移纳入测试和审计。

## 方案比较

### 方案 A：AIPR0S 平台原生邮件工作流，采用

新增受控邮件客户端和工作流模块，复用平台已有的 DWS 进程环境、Owner 校验、待确认动作、幂等执行和审计能力。优点是身份、权限、隐私和失败恢复都留在 AIPR0S 内；缺点是需要增加明确的工作流代码与测试。

### 方案 B：让 AI 运行时直接调用 DWS，不采用

由模型生成命令并执行。开发量较小，但当前 AI 运行时刻意处于只读、无工具模式；开放 shell 会破坏安全边界，也无法稳定保证邮箱选择、KQL 转义、收件人确认和发送幂等。

### 方案 C：直接复用 `dingtalk-mail-searcher`，不采用

该技能只包含提示词和命令参考，没有可复用实现，并明确依赖悟空。它的 KQL 映射和结果字段可作为研究输入，但不能成为 AIPR0S 的运行通道。

## 产品范围

第一阶段支持：

- 查询当前企业邮箱、最近邮件、今日邮件、未读邮件。
- 按发件人、收件人、主题、正文关键词、日期、文件夹和是否含附件组合搜索。
- 展示邮件摘要列表，并按序号打开正文。
- 新建并发送纯文本或 Markdown 邮件，支持 To、CC、主题和正文。
- 对已检索邮件执行回复、回复全部和转发。
- 查询发送结果，并明确区分成功、部分成功、失败和结果不确定。

第一阶段不支持：

- 邮件附件上传、下载和内联图片。
- 自动发送、定时发送、批量群发和未经确认的回复。
- 删除、移动、标记已读、标签、规则、自动回复等邮箱管理动作。
- 在群聊或非本人会话展示任何邮件元数据或正文。
- 将邮件正文长期沉淀到知识库、日志或审计记录。

## 安全与授权边界

### 本人私聊

邮件能力只在同时满足以下条件时开放：

1. 发送者匹配已配置的 Owner 身份。
2. 消息来自一对一私聊，不是群聊。
3. 当前通道是已配置的 DingTalk 真人账号通道。
4. DWS 二进制通过独立安装路径校验，transport 严格等于 `event-stream`。

任一条件不满足时，不执行邮箱命令，也不透露邮箱地址、是否有未读邮件、主题、发件人、时间、正文或发送历史；只提示到本人私聊处理。

### 读写分级

- 邮箱列表、搜索和正文读取为 L0，但仍受本人私聊硬门禁保护。
- 发送、回复、回复全部和转发为 L2，必须先预览再确认。
- 删除、批量发送、规则修改等不进入第一阶段。

### 写操作确认

预览必须展示：操作类型、发件邮箱、To、CC、主题和将要发送的完整正文；正文过长时拆成连续的私聊消息，最后一条再给出确认提示，不能只展示摘要。确认必须来自同一 Owner、同一私聊、同一待办动作，且在 15 分钟内完成。修改收件人、抄送、主题或正文后，旧确认立即失效，必须生成新预览。

## 架构

### `DwsMailClient`

新增 `src/dws-mail-client.mjs`，作为唯一 DWS 邮件进程边界：

- 接收 `bin`、`profile`、`transport`、`env`、`cwd`、`runner`、超时和审计函数。
- 复用独立 DWS 路径校验；拒绝相对路径、悟空目录、`.real/.bin/dws` 和非 `event-stream` transport。
- 每个命令显式添加 Profile 和 `--format json`，运行环境继承平台构造的 `DWS_CHANNEL`，不从 `PATH` 重新发现二进制。
- 只暴露领域方法：`listMailboxes`、`searchMessages`、`getMessage`、`resolveRecipient`、`sendMessage`、`replyMessage`、`replyAllMessage`、`forwardMessage`、`verifyDelivery`。
- 统一校验 JSON、`success`、错误结构和必要字段；业务失败转为稳定错误码。
- 审计只记录动作、时延、数量、状态和错误类别，不记录邮箱地址、姓名、主题、正文、messageId 或 internetMessageId 原值。

### `mail-intent`

新增 `src/mail-intent.mjs`，负责确定性意图解析和 KQL 构造：

- 识别最近、今日、未读、收件箱、已发送、发件人、收件人、主题、正文关键词、日期范围和附件条件。
- 默认 `limit=10`，本人明确要求更多时最高 30；不自动遍历全部邮箱。
- 所有字符串统一转义，拒绝控制字符和无法安全表示的 KQL；逻辑运算符由程序生成，不直接拼接未验证用户表达式。
- 日期按 Asia/Shanghai 解释，再生成完整 ISO 8601 时间。
- 搜索结果保存最小会话游标，仅允许同一 Owner、同一私聊通过“第 N 封”打开详情。

### `MailWorkflow`

新增 `src/mail-workflow.mjs`，负责授权、状态和响应：

- 在通用 AI 回复前确定性路由邮件意图。
- 首次使用先调用 `listMailboxes`，默认选择企业邮箱；多个企业邮箱无法确定时请求本人选择，绝不选第一项或猜测。
- 读取列表只返回序号、发件人显示名、主题、接收时间、未读/附件标记；正文仅在本人指定某封后读取。
- 按姓名发送时并行尝试 `aisearch person -> contact user get`、`mail user search` 和 `contact user search`；只有唯一、可验证邮箱才能进入预览，多候选或无结果必须请本人确认。
- 写入预览存为 `mail_write` 待确认动作，15 分钟过期，确认或取消后立即清理。
- 写入通过 `executeMutationOnce` 执行，稳定 execution key 由确认消息和草稿摘要生成；不因超时或连接中断自动重发。

### 平台接线

- `src/pending-actions.mjs` 增加 `mail_write` 类型，并支持该类型独立使用 15 分钟有效期，不改变其他待确认动作的现有 TTL。
- `src/bible.mjs` 增加邮件意图；读取保持 L0，发送/回复/转发固定为 L2。
- `src/index.mjs` 初始化一个 `DwsMailClient` 和一个 `MailWorkflow`，邮件路由位于通用 AI 回答之前。
- 帮助文本增加邮件查阅和本人确认发送说明。
- 健康状态增加邮件能力最近一次真实只读探针结果，但不暴露邮箱地址。

## 数据流

### 查阅

1. 收到本人私聊邮件请求。
2. 验证 Owner、私聊、DWS 路径和 event-stream。
3. 确定企业邮箱并构造受控 KQL。
4. 执行 `message search`，规范化并展示最多 10 条摘要。
5. 本人选择序号后，用同一搜索上下文取得 messageId，执行 `message get`。
6. 返回正文，不把正文写入审计或知识库。

### 发送、回复和转发

1. 解析动作、收件人、CC、主题和正文；缺字段时逐项追问。
2. 验证或解析准确邮箱，禁止猜测。
3. 生成完整预览，保存 15 分钟待确认动作。
4. 同一本人私聊回复“确认”后再次校验身份、会话、有效期和草稿摘要。
5. 通过 `executeMutationOnce` 调用唯一一次 DWS 写命令。
6. 从返回值提取 `internetMessageId`，有界轮询 `message verify`。
7. 终态为 `success` 才报告发送成功；`partial_success`、`failed` 分别报告部分成功和失败；超时、无终态或响应不完整标为结果不确定，禁止自动重发。

## 错误处理

- 未认证、Channel 未授权：报告邮箱能力当前不可用，不把失败解释成“没有邮件”。
- `domain.notFound`：说明当前邮箱不是受支持的钉钉托管邮箱。
- 多邮箱或多人重名：停在选择步骤，不猜测。
- KQL 无法安全表达：请本人缩小或重述条件。
- 搜索无结果：明确表示真实搜索成功但无命中，并回显搜索范围。
- DWS 非 JSON、字段缺失或进程失败：记录脱敏错误类别并有界重试读取；写操作不重试。
- 写命令返回后连接中断：标记结果不确定，优先按已有 `internetMessageId` 回读；没有可回读 ID 时交由本人核对。
- Runtime Schema 与 Cobra Help 漂移：执行参数以 Help 接受的 flags 为准，保留测试证明 `message verify` 的已知漂移。

## 隐私与存储

- 不建立邮件全文索引，不同步整箱邮件，不把邮件加入夜间知识同步。
- 搜索上下文只保存 messageId、序号和过期时间；不保存正文。
- 待发送正文只在本地待确认动作中短期保存，确认、取消或 15 分钟过期后清理。
- 进程错误、日志和审计必须经过脱敏，不记录 DWS Channel、Profile、邮箱地址、主题或正文。
- 不把邮件内容发送到其他联系人或群聊；跨人转发本身属于经过本人确认的邮件写操作。

## 测试设计

### 单元测试

- DWS 参数构造、Profile、JSON 输出和 Channel 环境继承。
- Wukong、`.real/.bin/dws`、相对路径和非 event-stream 拒绝。
- 邮箱选择、KQL 字段映射、引用转义、日期和条数上限。
- 多种 DWS 响应包裹结构、空结果、坏 JSON、认证失败和 `domain.notFound`。
- Owner 私聊放行；非 Owner、群聊和身份不完整全部拒绝且不触发 runner。
- 搜索序号与 messageId 绑定，过期或跨会话选择无效。
- 收件人唯一命中、多候选、无结果和三路结果不一致。
- 预览、确认、修改后失效、取消、超时和跨会话确认拒绝。
- 幂等执行、发送超时的 ambiguous 状态、禁止自动重发。
- `message verify` 的 success、partial_success、failed、posting 超时和字段漂移。
- 审计载荷中不出现测试邮箱、主题、正文或标识符。

### 集成与真实验收

- 使用确定性 fake runner 完整覆盖搜索、打开正文、发送预览、确认、发送和投递回读。
- 运行全部 Node 测试、机制验收、语法检查和健康检查。
- 使用当前平台配置执行真实 `mailbox list` 和受限 `message search`，只记录成功、数量和字段结构，不在验收报告输出真实邮件内容。
- 不在自动测试中发送真实邮件。首次真实发送由账号本人在数字人私聊中发起并确认；实现需要兼容 `message verify` 返回的顶层或 `message` 内嵌 `sendStatus`，归一化后的终态必须为 `success` 才算验收通过。
- 重启 LaunchAgent 后再次检查健康状态，确认 DingTalk 仍为 authenticated/connected，transport 仍为 event-stream，且没有 Wukong 进程或路径。

## 完成标准

1. 本人在钉钉私聊中可以查询最近、今日、未读和条件邮件，并按序号读取正文。
2. 非本人或群聊请求无法触发任何邮箱命令，也看不到邮箱存在性和邮件元数据。
3. 本人可以生成发送、回复、回复全部或转发预览；未经确认不写入邮箱。
4. 确认后只执行一次，投递状态被真实回读；结果不确定时不自动重发。
5. 所有自动化测试、真实只读探针、服务健康与无悟空检查通过。
6. 代码、配置、日志、审计和文档均不包含 DWS Channel、邮箱正文或其他本地凭据。
