# James Owner-only IM 反馈闭环设计

## 背景与决策

当前 James 允许任意合法到达 IM 会话的联系人预览并确认 Multica 创建、更新和评论；“处理 ISSUE”入口还会直接把 Issue 改为 `in_progress` 并启动本地执行。这与 MYS-6 的 Owner-only 要求冲突。

已批准方案 A：非 Owner 不能调用任何通用 Multica 写入口。唯一例外是受控反馈登记流程，它只能代建未指派的 `backlog` Issue、订阅来源会话，不能派发或执行。Owner 反馈也先安全登记，再自动派发给“詹老师的开发团伙”。

曾比较的替代方案：B 只在本地保存非 Owner 反馈，会失去 Multica 可见性与状态同步；C 创建 `todo` 虽不指派，但会扩大未来默认派发或规则变更下的误执行风险。因此采用 A。

## 架构

1. `multica-access.mjs` 统一执行双条件授权：先验证发送者为已确认的 Owner（Multica 账号 `494161546@qq.com`；飞书映射为 `ownerOpenId`，钉钉映射为 `dingtalkOwnerOpenId`），再要求会话为 `p2p` 且带可信 `selfChat` 标记。渠道未知、Owner 群聊、Owner 普通 p2p、普通联系人、伪造 self-chat 元数据或不同会话确认一律 fail closed。
2. `MulticaCapability` 在创建、更新、评论的预览和执行阶段都校验 Owner；`MulticaWorkLifecycle` 在开始执行前再次校验。`index.mjs` 在路由层提前返回明确的只读提示，形成入口与能力层双重防护。
3. `MulticaFeedbackWorkflow` 是非 Owner 唯一可触发的受控写服务。它识别 Bug、整改、意见或功能需求，先保存原始请求并只追问一个验收问题；取消时清理待处理状态且不写 Multica。
4. 澄清后，工作流用固定字段创建 `backlog` Issue：无负责人，描述包含来源渠道、原会话、来源消息、原始需求、补充说明、验收标准和不可直接执行标记。创建完成后立即缓存并订阅原会话。
5. 仅当原始请求与澄清回复两个时点都重新通过 Owner self-chat 授权，Issue 创建成功后才写入持久化派发 outbox，再尝试把负责人和状态一次更新为“詹老师的开发团伙”与 `todo`。Owner 群聊、Owner 普通 p2p 与非 Owner 均不创建派发记录。

## 幂等、失败与审计

- 每个反馈使用由渠道、会话和原消息 ID 派生的稳定登记键，并写入 Issue 描述。重复消费先从本地登记记录或 Multica 搜索恢复已创建 Issue，不重复创建。
- 创建结果在 SQLite 中持久化；外部结果不确定时保留可审计状态，并通过稳定登记键进行后续对账，而不是盲目新建。
- Owner 派发记录保存在 SQLite outbox。派发是幂等的目标状态更新；失败后按有界指数退避重试，达到上限进入 dead 状态并反映到健康检查。
- 创建成功但首次派发失败时，Issue 保持未指派 `backlog`，原会话收到 Issue 编号、链接和“派发待重试”说明；不会启动 Squad。
- 审计事件覆盖追问、取消、越权拦截、登记创建、重复恢复、派发成功、派发失败、派发 dead letter 与同步通知。

## 数据流

1. 收到反馈 → 判断是否已有同会话同发送者的待澄清记录。
2. 首次反馈 → 记录原始请求 → 发送一个关键问题，不创建 Issue。
3. 回复“取消” → 删除待澄清记录 → 发送取消回执。
4. 回复补充说明 → 创建或恢复 `backlog` Issue → 订阅原会话。
5. 非 Owner → 返回 Issue 编号与链接，流程结束；后续只接收状态同步。
6. Owner → 入派发 outbox → 立即尝试指派 Squad 并转 `todo`；失败则保持安全状态并后台重试。
7. 现有 `MulticaSynchronizer` 根据订阅把状态、阻塞、完成和发布字段变化同步回原会话。

## 测试与验收

- 身份测试：Owner 群聊拒绝、Owner 普通 p2p 拒绝、Owner self-chat 允许、伪造 self-chat 但身份不匹配拒绝、未知渠道 fail closed。
- 权限测试：非 Owner 无法预览或执行创建、更新、评论、指派；无法进入“处理 ISSUE”；Owner 可走既有写链路。
- 反馈测试：必须先追问；取消不创建；非 Owner 只建未指派 backlog；Owner 创建后派发 Squad；来源与验收信息完整；重复消费不重复创建。
- 故障测试：创建成功但派发失败时保持 backlog、订阅成功并留下重试；后续重试成功；达到上限进入 dead。
- 回归验证：目标单测、全量 `npm test`、`npm run check`、`npm run health` 与 `git diff --check`。
