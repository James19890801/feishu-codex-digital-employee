# AIPR0S Stable Response Design

Date: 2026-08-11

Status: Approved for planning
Source: semantic migration from GitHub `origin/main` at `d8e1e83`, adapted to the local DingTalk-first branch

## Objective

Improve response reliability without importing the remote branch's proactive group behavior. The change has exactly three user-visible goals:

1. A valid group message that explicitly mentions the digital human must receive a visible response unless a hard safety boundary blocks it.
2. If answer generation fails for such a required response, the digital human sends a short deterministic fallback instead of failing silently.
3. Repetitive group conversations are bounded before repeated messages can create an uncontrolled AI-to-AI reply loop.

The implementation must preserve the local branch's DingTalk/DWS routing, live conversation context, A1 intake, private knowledge, owner identity, communication blocklist, human takeover, outbound echo tracking, and uncommitted nightly knowledge-sync work.

## Non-goals

This change does not:

- subscribe to or process unmentioned group traffic;
- add semantic auto-engagement for ambient group messages;
- add delayed group-host interventions;
- add a 100-reply adaptive discussion budget;
- add quoted-reply approval or change mutation authorization;
- change direct-message response policy;
- change Feishu availability or make Feishu a runtime prerequisite;
- merge `origin/main`, rename local product surfaces, or overwrite local branch history.

## Selected Approach

Semantically port the small response-stability units and integrate them into the existing local pipeline. Do not cherry-pick the remote commits verbatim: the local and remote histories have diverged across `src/index.mjs`, `src/state.mjs`, configuration, dashboard, knowledge, and testing surfaces.

The port uses focused modules with narrow interfaces:

- `src/response-obligation.mjs`: classify whether a received message creates a response obligation.
- `src/required-response-fallback.mjs`: convert generation failure into a deterministic fallback only when a response is required.
- `src/semantic-repeat-guard.mjs`: normalize group topics and conservatively compare them without invoking an AI model.
- `src/semantic-repeat-controller.mjs`: turn an atomic repeat claim into process, close, acknowledge, or suppress behavior.
- `src/outbound-repeat-controller.mjs`: stop recent semantically equivalent outbound replies from being resent, while preserving visible acknowledgement for required responses.
- `src/state.mjs`: persist and atomically claim inbound semantic topics and outbound semantic replies.
- `src/index.mjs`: place the new decisions in the existing inbound and send pipelines.

## Response Priority

The processing order is fixed:

1. Validate the event, sender, chat, authorization, and durable inbox claim.
2. Apply hard safety boundaries: outbound echo, authenticated owner pause/human takeover, communication blocklist, invalid identity, and existing abuse/rate limits.
3. Process existing owner/operator commands.
4. Determine whether the message has `responseRequired=true`.
5. Apply the inbound semantic-repeat gate.
6. Generate the normal answer when the gate permits it.
7. If generation fails and the response is required, produce the deterministic fallback.
8. Apply outbound semantic-repeat handling and send through the existing guarded, idempotent channel path.

Hard safety boundaries remain stronger than the response obligation. “Must respond” means the ordinary engagement, cooldown, repeat, and generation layers cannot fail silently; it does not bypass a blocklist, human pause, invalid identity, rate limit, privacy rule, or mutation authorization.

## Explicit Mention Obligation

`response-obligation.mjs` accepts the normalized message, channel metadata, message text, and configured assistant aliases. It returns:

```js
{
  explicitAssistantMention: true,
  responseRequired: true,
  reasonCode: 'structured_assistant_mention'
}
```

A DingTalk `user_im_message_receive_at` event is an explicit assistant mention because that event is already scoped to the current account. A structured mention that resolves to the current assistant is also explicit. Text aliases such as `@James`, `@詹老师`, `@数字人`, and the configured owner-specific digital-human label are recognized only within group messages already admitted by the current transport; this design does not add the full-group event subscription.

Mentioning another person does not create a response obligation. If the same admitted message mentions both the assistant and another person, the assistant obligation remains true. Direct messages continue through their existing response path and do not depend on this classifier.

## Required Generation Fallback

`resolveRequiredResponse({ responseRequired, generate })` runs the existing answer generator.

- On success, it returns the generated text unchanged.
- On failure with `responseRequired=false`, it rethrows so existing retry and failure behavior remains intact.
- On failure with `responseRequired=true`, it returns:

> 收到，这条我先接住。刚才回复生成失败了，你不用重复发，我恢复后继续处理。

The error is audited as a bounded category and message, without prompt content or conversation text. The fallback uses the inbound message ID in its idempotency key, so retrying the same event cannot send it twice.

## Inbound Semantic Repeat Guard

The guard applies only to text or post messages in group chats that already entered the current pipeline. Direct messages, owner commands, unsupported content, and disabled configurations bypass it.

Topic comparison is deterministic and local:

- remove mention markup, assistant aliases, punctuation, whitespace, and low-information acknowledgement prefixes;
- compare normalized exact fingerprints first;
- conservatively compare word and character shingles for longer text;
- treat changed URLs, issue identifiers, dates, and numbers as new information;
- treat explicit continuation requests such as `继续`, `展开`, `重新回答`, and `补充` as a new topic;
- fail open on short ambiguous messages unless they are exact normalized repeats.

State is keyed by channel, group chat, and sender. With the default 30-minute window and maximum of two visible replies:

1. The first topic occurrence proceeds to normal generation.
2. The second repeat sends a deterministic close: `这个话题我们先到这里，有新情况再 @ 我。`
3. Later repeats complete silently before generation.
4. If a later repeat has `responseRequired=true`, it sends a deterministic acknowledgement instead of remaining silent: `收到，这条我看到了；相同内容我不重复展开，有新问题我继续接。`

Required acknowledgements still pass through the existing hard rate limit. This resolves the tension between “explicit @ must be visible” and loop containment: repeated mentions stop consuming AI generation, while abuse protection can still stop an unbounded sender.

## Outbound Repeat Protection

Before sending a generated group reply, the system compares it with recent replies for the same chat and audience. A semantically equivalent non-required reply is suppressed and audited. A semantically equivalent required reply is downgraded to the deterministic acknowledgement and sent with the inbound message's idempotency key; it is not silently discarded.

If sending fails or the downstream path reports suppression before delivery, the outbound claim is released so an existing safe retry may try again. A confirmed delivery retains the claim until expiry.

## Persistence and Concurrency

`src/state.mjs` adds two SQLite-backed records:

- semantic-repeat state keyed by channel, chat, and sender, including the current topic fingerprint, bounded normalized comparison data, accepted count, last action, and expiry;
- outbound-repeat claims keyed by chat, audience, and semantic topic, including a stable claim ID and expiry.

Claims execute inside SQLite transactions. The inbound message ID makes repeat decisions idempotent across retries and overlapping ingestion paths. Concurrent workers cannot both advance the same topic or send the same closure for one message.

Expired rows are deleted through the existing state-pruning path. Raw message text is not copied into audit records. Local comparison state retains only the bounded normalized representation required for deterministic matching.

## Configuration

Add validated settings with these defaults:

```json
{
  "semanticRepeatGuardEnabled": true,
  "semanticRepeatWindowMs": 1800000,
  "semanticRepeatMaxReplies": 2,
  "outboundRepeatWindowMs": 600000,
  "responseMentionAliases": ["James", "詹老师", "数字人", "AIPR0S"]
}
```

Bounds:

- semantic repeat window: 1 minute to 24 hours;
- semantic repeat maximum replies: 2 to 5;
- outbound repeat window: 1 minute to 1 hour;
- aliases: at most 20 non-empty values, deduplicated after trimming.

The implementation must preserve user-provided aliases and must not expose account IDs or channel credentials through configuration readback.

## Audit and Health

Add sanitized audit events:

- `response_obligation_detected`;
- `required_response_fallback_sent`;
- `semantic_repeat_first_seen`;
- `semantic_repeat_reset`;
- `semantic_repeat_closed`;
- `semantic_repeat_suppressed`;
- `semantic_repeat_required_acknowledged`;
- `outbound_repeat_suppressed`;
- `outbound_repeat_required_acknowledged`.

Audit details contain channel, chat ID, sender ID, message ID, action, count, similarity, reason code, and expiry as appropriate. They do not contain raw inbound text, generated answer text, prompts, credentials, or private conversation history.

Health remains distinct from reply outcome. Existing process/channel health continues to report connectivity; mechanism tests and audit readback prove response behavior.

## Error Handling

- SQLite repeat-state failure fails open to the existing response path and records a sanitized state error. It must not disconnect DingTalk.
- Topic normalization failure fails open and records a bounded reason code.
- Required generation failure sends the deterministic fallback once.
- Non-required generation failure preserves the existing retry/final-failure behavior.
- Closure or acknowledgement send failure follows the existing send retry path with a stable idempotency key.
- Outbound-repeat state failure fails open to the existing guarded send path; delivery availability wins over optional deduplication.

## Test-Driven Implementation

Every production change starts with a failing test. New focused tests cover:

- structured DingTalk mention, assistant alias, other-person mention, mixed mention, and direct-message bypass;
- hard safety boundaries remaining stronger than `responseRequired`;
- required generation success, required generation failure fallback, and ordinary generation failure rethrow;
- exact repeats, conservative paraphrases, changed structured signals, explicit continuation, short-message fail-open, expiry, chat isolation, sender isolation, and direct-message bypass;
- atomic duplicate claims and retry idempotency;
- first process, second closure, later suppression, and required acknowledgement after suppression;
- outbound semantic duplicate suppression, required-response downgrade, claim release after send failure, and audience isolation;
- integration wiring proving a repeated explicit mention never invokes the AI runtime but still receives a bounded acknowledgement;
- mechanism acceptance proving the blocklist, human takeover, outbound echo, A1, knowledge, and current DingTalk paths remain unchanged.

Verification commands include each new focused test, the affected existing tests, `npm test`, `npm run check`, and `git diff --check`. The existing uncommitted nightly knowledge-sync test remains part of the baseline and is not modified by this feature.

## Local Rollout

After all verification passes:

1. Install/restart the existing local service through the repository's supported service script.
2. Wait for DingTalk authenticated and connected health, rather than treating process startup alone as success.
3. Read back recent audit/state counts for response obligations and failures without sending synthetic messages into a real group.
4. Report implementation, automated verification, runtime health, and any unverified live behavior separately.

No GitHub push or pull request is part of this work. Any later remote delivery must preserve the repository's configured delivery policy and be requested separately.
