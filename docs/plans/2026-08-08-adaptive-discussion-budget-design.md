# Adaptive Discussion Budget Design

## Problem

AIPRO must support long, useful discussions with humans or other digital employees without allowing an unbounded reply loop. A fixed two-reply semantic guard stops legitimate debate too early, while semantic topic resets alone can be defeated by paraphrasing or changing topics.

## Goals

- Allow substantive group discussions to continue for as many as 100 AIPRO replies.
- Guarantee a mathematical upper bound even when the peer is another digital employee.
- Stop low-value acknowledgement and paraphrase loops quickly.
- Preserve Feishu and DingTalk availability, identity, memory, audit, and retry behavior.
- Keep direct messages and non-primary IM channels unchanged.
- Let the verified owner stop immediately or explicitly start a new discussion session.

## Scope

The adaptive budget applies to text and post messages in Feishu and DingTalk groups. It runs before Codex. Direct messages keep their existing behavior. WeCom and WeChat remain isolated and unchanged.

## Approach

Use a local deterministic value score with a persisted session budget. Codex is not called to decide whether Codex may be called. The existing semantic topic comparison becomes one input to the score instead of imposing a fixed two-reply ceiling.

Each group has one active discussion session. The session tracks AIPRO reply count, consecutive low-value turns, recent semantic topics, checkpoint position, cooldown, the last inbound message ID, and the last decision. State changes use an atomic SQLite claim so retries return the same decision.

## Turn Value

A turn receives positive evidence for:

- a new URL, Issue identifier, date, number, or other structured fact;
- a question, counterargument, causal explanation, example, or proposed decision;
- semantic novelty compared with recent discussion topics;
- enough substantive text to express a claim.

A turn receives negative evidence for:

- exact or semantic repetition;
- acknowledgement, agreement, waiting, or handoff language without a new claim;
- very short content with no structured information;
- restating an existing conclusion with different wording.

A score of two or more is substantive. Lower scores are low-value. The score and reason codes are audited, but raw message content is not copied into the discussion-budget audit.

## State Machine

1. `active`: substantive and low-value turns may be processed.
2. `checkpoint`: replies 20, 40, 60, and 80 receive an instruction to summarize agreement, disagreement, evidence, and the next unresolved question.
3. `closing_low_value`: three consecutive low-value turns produce one deterministic closing reply without an `@` mention.
4. `closing_hard_limit`: reply 100 is a Codex-generated final synthesis. After successful delivery, the session closes.
5. `cooldown`: closed sessions stay silent for 30 minutes while continuing to observe and remember messages.

The verified owner can send `继续讨论` to create a new session immediately. Existing owner stop commands remain stronger than this mechanism.

## Reply Accounting

The hard limit counts AIPRO outbound replies, not inbound messages. A decision is claimed before model execution and keyed by inbound message ID. A failed send retry receives the same action and does not consume another turn. The hard limit can never exceed 100.

## Codex Integration

For ordinary turns, the controller returns `process` and the normal workflow continues. At checkpoints, the controller returns a prompt suffix asking Codex for a short structured synthesis before advancing the debate. On turn 100 it returns a final-synthesis suffix and marks the session for closure only after the reply is successfully sent.

Low-value closure and cooldown suppression do not call Codex. Closing messages are sent without mentioning the peer, preventing an automatic mention-triggered response.

## Compatibility and Failure Isolation

- The adaptive controller supersedes the fixed semantic-repeat gate only for eligible Feishu and DingTalk group messages.
- If the adaptive feature is disabled, the existing semantic-repeat behavior remains available as a fallback.
- SQLite failures fail open to the existing message pipeline and create a sanitized audit error rather than taking down an IM channel.
- A closed session affects only one channel and group.
- Service restarts retain session count and cooldown.

## Configuration and Visibility

Defaults:

- `discussionBudgetEnabled: true`
- `discussionBudgetMaxReplies: 100`
- `discussionBudgetLowValueLimit: 3`
- `discussionBudgetCooldownMs: 1800000`

The dashboard status API exposes enabled state, active sessions, maximum replies, cooldown duration, total closed sessions, and the latest closure reason without exposing message content.

## Verification

Tests cover scoring, checkpoints, low-value closure, the exact 100-reply bound, retry idempotency, owner restart, cooldown persistence, channel isolation, direct-message bypass, no-mention closure, configuration bounds, dashboard status, and the existing full regression suite.
