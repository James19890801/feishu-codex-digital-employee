# 微信数字人“调皮大神”人设 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 为微信私聊和已触发的微信群回复增加“AI + 流程管理大神、略调皮”的表达规则，并在微信 AI 生成失败时发送固定掉线文案。

**Architecture:** 新建纯函数模块集中提供微信专属 Prompt 和故障兜底，统一运行时只负责按通道注入与调用，避免复制微信处理链。普通短消息由模型结合对话上下文判断，运行失败则由确定性代码返回固定文案；非微信通道保持现状。

**Tech Stack:** Node.js ESM、`node:assert/strict`、现有统一 IM 运行时与 SQLite 幂等队列。

---

### Task 1: 微信专属人设规则

**Files:**
- Create: `src/wechat-conversation-style.mjs`
- Create: `src/wechat-conversation-style.test.mjs`

**Step 1: Write the failing test**

测试 `buildWeChatConversationStyle('wechat')` 包含 AI、流程管理、调皮追问、“哈哈”强制展开、收尾短句豁免与严肃场景收敛；测试非微信返回空字符串。

**Step 2: Run test to verify it fails**

Run: `node src/wechat-conversation-style.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Write minimal implementation**

导出 `buildWeChatConversationStyle(channel)`，只在标准化通道为 `wechat` 时返回完整规则，其他通道返回空字符串。

**Step 4: Run test to verify it passes**

Run: `node src/wechat-conversation-style.test.mjs`

Expected: `WECHAT_CONVERSATION_STYLE_TEST_OK`.

### Task 2: 微信确定性掉线兜底

**Files:**
- Modify: `src/required-response-fallback.mjs`
- Modify: `src/required-response-fallback.test.mjs`

**Step 1: Write the failing test**

增加微信生成失败测试，要求返回固定掉线文案、`fallback: true` 和有界错误；保留正常生成与非微信抛错测试。

**Step 2: Run test to verify it fails**

Run: `node src/required-response-fallback.test.mjs`

Expected: FAIL because the current wrapper always rethrows generation errors.

**Step 3: Write minimal implementation**

导出 `WECHAT_OFFLINE_FALLBACK_REPLY`，并让 `resolveRequiredResponse({ responseRequired, fallbackText, generate })` 仅在明确要求兜底时捕获错误、返回固定文案；其余情况继续抛出。

**Step 4: Run test to verify it passes**

Run: `node src/required-response-fallback.test.mjs`

Expected: `REQUIRED_RESPONSE_FALLBACK_TEST_OK`.

### Task 3: 接入统一微信运行时与 Persona

**Files:**
- Modify: `src/index.mjs`
- Modify: `src/persona-contract.test.mjs`
- Modify: `PERSONA.md`
- Modify: `templates/PERSONA.example.md`

**Step 1: Write the failing contract assertions**

断言分发 Persona 包含 AI 与流程管理专家、调皮但不攻击人；断言统一 Prompt 调用了微信专属规则；断言回复生成调用为微信传入固定兜底文案。

**Step 2: Run tests to verify they fail**

Run: `node src/persona-contract.test.mjs && node src/required-response-fallback.test.mjs`

Expected: persona contract fails before integration.

**Step 3: Write minimal integration**

在 `runCodex` 中按通道注入微信表达规则。在普通回复的 `resolveRequiredResponse` 调用中，仅微信传入 `WECHAT_OFFLINE_FALLBACK_REPLY`。同步当前运行 Persona 与分发 Persona，不改变群聊触发策略和其他通道。

**Step 4: Run focused tests**

Run: `node src/wechat-conversation-style.test.mjs && node src/required-response-fallback.test.mjs && node src/persona-contract.test.mjs && node src/wechat-group-reply-policy.test.mjs`

Expected: all commands print their `_TEST_OK` marker.

### Task 4: 回归验证

**Files:**
- Test only

**Step 1: Run syntax and whitespace checks**

Run: `node --check src/index.mjs && git diff --check`

Expected: exit 0.

**Step 2: Run related policy tests**

Run: `node src/stable-response-policy.test.mjs && node src/conversation-etiquette.test.mjs && node src/im-channels.test.mjs`

Expected: all pass.

**Step 3: Review scoped diff**

确认只新增微信专属 Prompt、微信故障兜底与 Persona 文案，没有改动群聊触发、隐私和授权逻辑。
