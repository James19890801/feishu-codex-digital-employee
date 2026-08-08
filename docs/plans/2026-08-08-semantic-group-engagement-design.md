# Semantic Group Engagement Design

## Objective

AIPRO must observe every available group message in Feishu and DingTalk, even when the sender does not mention the digital employee. It should reply only when the message is clearly directed at AIPRO, continues an active exchange with AIPRO, or is strongly relevant to an active task or discussion. Every group reply must mention the person or people being answered.

The existing fast path remains unchanged: explicit mentions and direct messages continue to enter through the current event and polling channels. Semantic observation is an additive path and must never make those channels depend on the new classifier.

## Approaches Considered

### 1. Classify every group message with the AI runtime

This gives the broadest semantic coverage but creates high cost, latency, and a large failure surface. A busy group could invoke the runtime for every casual remark. This approach was rejected.

### 2. Two-stage balanced engagement (selected)

All group messages are recorded locally. A deterministic gate identifies hard triggers and removes obvious non-candidates. Only ambiguous but plausible candidates are sent to the configured AI runtime with the preceding 30 messages. The runtime returns a strict decision, not a conversational answer. High-confidence candidates proceed to the normal reply workflow.

This preserves semantic understanding while bounding false positives, runtime calls, and loop risk.

### 3. Keyword-only engagement

This is cheap and predictable but cannot reliably understand pronouns, continuation, implicit requests, or topic relevance. It was rejected because it does not meet the contextual requirement.

## Message Acquisition

### Feishu

The existing user polling request already retrieves all accessible messages. The current selector discards unmentioned group messages. The new selector will emit them as `semanticCandidate` payloads while retaining the existing explicit-mention path and message-ID deduplication.

### DingTalk

The personal event stream supplies direct messages and group mention events. A shadow polling path will use the existing `chat message list-all` capability to observe unmentioned group messages. It runs independently of the event consumer, uses the durable inbox for message-ID deduplication, and has its own cursor, health state, exponential backoff, and circuit breaker. A failure in semantic polling must degrade only semantic observation; it must not mark the primary DingTalk event channel disconnected.

Messages sent by AIPRO under the owner's identity are excluded through the existing outbound echo guard. Verified owner messages are treated as human takeover activity, not as semantic candidates.

## Context Capture

Every accepted group text or post is written to the local conversation history before engagement classification, regardless of whether AIPRO replies. The current message is excluded when the preceding context is formatted. The classifier and answer generator both receive at most 30 preceding messages from all speakers, with speaker attribution.

Unsupported content is observed as a typed placeholder. Raw message text is not written to audit events. Existing local retention and privacy rules remain in force.

## Engagement Router

The router returns one of the following actions:

- `reply_explicit`: AIPRO was explicitly mentioned. This bypasses semantic uncertainty.
- `reply_named`: the message clearly addresses an configured assistant alias such as “詹老师助理”, “数字人”, or “AIPRO”.
- `reply_continuation`: the sender is continuing or questioning an active exchange in which AIPRO recently replied.
- `reply_semantic`: an ambiguous candidate is classified as relevant with high confidence.
- `observe`: retain the message as context without replying.
- `suppress`: human takeover, cooldown, loop protection, or a failed/invalid classification requires silence.

The deterministic first stage considers explicit mentions, assistant aliases, question/request form, recent AIPRO participation, active discussion state, verified owner activity, outbound echoes, and low-information acknowledgements.

Only plausible ambiguous candidates reach the AI classifier. The classifier receives the current message and the preceding 30-message transcript and must return strict JSON containing `action`, `confidence`, `reasonCode`, and `targetSenderIds`. Invalid output, timeout, or confidence below the configured threshold fails closed to `observe`. The default semantic reply threshold is 0.86.

## Intervention and Loop Controls

- Explicit mentions always use the existing fast path.
- New unmentioned semantic entry is limited to one reply per chat within a bounded cooldown. Continuations inside an already active substantive discussion may proceed.
- Existing semantic-repeat protection, low-value streak closure, 100-reply discussion ceiling, self-chat circuit breaker, outbound echo guard, and durable message deduplication remain mandatory.
- Any verified owner activity activates the existing five-minute human takeover window. During takeover, messages are remembered but AIPRO does not classify or reply.
- A semantic classifier never executes business mutations. It decides only whether the normal workflow may process the message.
- Every resulting group reply mentions the current sender by default. Explicit multi-recipient workflows may supply a deduplicated recipient list.

## Timing and Reliability

Mention events remain near-real-time through the existing event consumers. Unmentioned messages are processed on the user polling cadence. The first commercial-safe default reuses the current bounded polling interval and backoff rather than increasing API pressure. Polling cadence can later be exposed as a separate dashboard setting after rate-limit data is available.

The semantic observer has independent health metrics:

- last successful observation time;
- last classification time and result code;
- observed, classified, replied, and suppressed counts;
- polling/classifier error summaries without raw message content.

Disabling semantic group engagement returns the system to the current explicit-mention behavior without restarting or disconnecting the primary IM channels.

## Configuration

The initial configuration adds:

- `semanticGroupEngagementEnabled` (default `true` after migration);
- `semanticGroupReplyThreshold` (default `0.86`);
- `semanticGroupEntryCooldownMs` (default `120000`);
- `semanticGroupAliases` (safe built-in defaults plus configurable aliases).

The dashboard will expose a master switch and read-only counters. Existing channel switches remain independent.

## Testing and Acceptance

Unit tests cover selector behavior, deterministic routing, strict classifier parsing, 30-message exclusion, recipient attribution, cooldowns, owner takeover, echo suppression, and fail-closed behavior.

Integration tests prove:

1. an explicit mention still replies through the old fast path;
2. a named but unmentioned message replies and mentions its sender;
3. a contextual continuation replies after reading the preceding 30 messages;
4. unrelated group chatter is observed but not answered;
5. owner activity suppresses replies for at least five minutes;
6. repeated digital-human messages cannot create an unbounded loop;
7. semantic polling failure does not disconnect Feishu or DingTalk primary channels;
8. duplicate event and polling copies are processed once;
9. disabling the feature restores mention-only behavior;
10. the complete existing test and mechanism-acceptance suites remain green.
