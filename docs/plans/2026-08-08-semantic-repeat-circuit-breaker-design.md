# Semantic Repeat Circuit Breaker Design

Date: 2026-08-08
Status: Approved

## Problem

AIPRO currently prevents duplicate transport events, outbound echoes, and short bursts from one sender. It does not prevent two digital employees from creating new message IDs while repeatedly restating the same topic and mentioning each other. Every new event therefore reaches the AI runtime and produces another reply.

## Approved scope

- Enable the guard for all DingTalk and Feishu group chats.
- Do not apply it to direct messages.
- Preserve the existing Feishu, DingTalk, Codex, and Multica paths.
- Do not use an AI model to decide whether a message is repetitive.

## Behaviour

For one group, one sender, and one semantic topic inside a rolling window:

1. The first qualifying message is processed normally.
2. The second repetitive message receives one short deterministic closing reply.
3. The third and later repetitive messages are completed silently before Codex is invoked.
4. A materially new question, fact, state, Issue reference, number, date, URL, or explicit continuation instruction starts a new topic and is processed normally.

The closing reply is: `这个话题我们先到这里，有新情况再 @ 我。`

## Detection

Detection is deterministic and local:

- Remove mention syntax, assistant names, repeated whitespace, punctuation, and low-information acknowledgement phrases.
- Compare normalized exact fingerprints first.
- For longer text, compare character shingles with a conservative similarity threshold.
- Treat changed structured signals such as URLs, Issue identifiers, dates, and numbers as new information.
- Treat explicit instructions such as `继续`, `展开`, `重新回答`, and `补充` as a reset.

Short or ambiguous messages fail open unless they are exact normalized repetitions. This reduces the risk of suppressing legitimate human follow-ups.

## State and concurrency

State is persisted in SQLite and keyed by channel, group chat, and sender. The record stores the topic fingerprint, normalized sample, reply count, first/last timestamps, and expiry. A transaction claims the next action so WebSocket and polling cannot both advance the counter.

The counter advances only when a message is accepted for processing. The second-message closing response uses the existing idempotent send path. Suppressed messages are marked complete and cannot be retried into a reply.

## Observability and controls

Audits:

- `semantic_repeat_first_seen`
- `semantic_repeat_closed`
- `semantic_repeat_suppressed`
- `semantic_repeat_reset`

The status API exposes the total suppressed count and the most recent suppression without exposing message content. Configuration supports enabling the guard, setting the rolling window, and selecting the maximum reply count. Defaults are enabled, 30 minutes, and two replies.

## Safety and rollout

- Unit tests cover exact repeats, paraphrases, new facts, explicit continuation, sender isolation, chat isolation, expiry, direct-message bypass, and concurrent claims.
- Integration tests prove the third repeat never invokes the AI runtime and does not send a message.
- Existing Feishu, DingTalk, Codex, and Multica regression suites must pass before restart.
- After restart, inspect health and audit state without sending test messages to real groups.
