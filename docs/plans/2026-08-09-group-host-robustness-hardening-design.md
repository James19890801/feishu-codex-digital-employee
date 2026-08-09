# Group Host Robustness Hardening Design

## Objective

Harden the selected-group host mechanism so that configuration changes, restarts,
busy chats, stale queues, prompt injection, AI failures, send ambiguity, and local
state faults fail toward silence instead of producing late, duplicate, unsafe, or
misrouted messages.

The first deployment remains limited to the configured DingTalk test group. This
hardening does not broaden candidate eligibility or enable any additional group.

## Failure-Mode Exploration

| Failure mode | Current consequence | Required behavior |
| --- | --- | --- |
| A group is removed from the allowlist after a candidate was queued | The old candidate can still be sent after restart | Revalidate enablement and allowlist at processing time; resolve silently |
| A candidate is processed long after its original topic | A stale reply can revive an old conversation | Expire candidates after a bounded maximum age |
| A new group message arrives near the worker deadline | The worker can win the chat lock before the inbound item is recorded | Require a short quiet window and defer without consuming a failure retry |
| Candidate text attempts prompt injection | The generator can be pushed outside the host contract | Delimit all chat content as untrusted data and enforce a deterministic output safety gate |
| Generated text includes mass mentions, links, commands, promises, or fake consensus | Length and question-count checks alone can still pass it | Reject unsafe output before channel delivery |
| SQLite claim or loop-level state access throws | The background loop can terminate permanently | Catch each loop iteration, publish redacted health state, back off, and continue |
| AI or send errors contain prompt/message content | Raw group text can leak into audits and retry records | Store only a bounded redacted error code/category |
| Service restarts with an in-flight candidate | Recovery can attempt the candidate again | Keep stable channel idempotency and outbound semantic dedup; expire stale work before generation |
| Queue grows or repeatedly fails | Operators cannot distinguish silence from failure | Expose aggregate pending/processing/dead/due counts and last successful loop/error timestamps |

## Approaches Considered

### Minimal guard patch

Add allowlist revalidation, expiry, and a reply denylist. This closes immediate
safety gaps but leaves timing races and worker liveness weak.

### Hardened bounded state machine

This is the selected approach. Keep the current SQLite worker, add explicit
`deferred` processing results, a no-penalty reschedule operation, runtime policy
revalidation, bounded age and quiet-window checks, deterministic output safety,
redacted failures, and worker health telemetry.

### Separate scheduling service

Move candidates to an independent worker with a DLQ dashboard and external
message reconciliation. This offers stronger isolation but is unnecessary for
one allowlisted test group and would increase operational failure surface.

## Processing Policy

Processing uses this fixed priority:

1. Host mode is enabled and the candidate chat remains allowlisted.
2. Candidate age is within ten minutes.
3. Human takeover and host-reply cooldown are inactive.
4. No other member has already picked up the topic.
5. The group has been quiet for at least twelve seconds; otherwise reschedule for
   the remaining quiet period without treating the event as a failure.
6. The strict decision classifier approves intervention with high confidence.
7. The generated reply passes structural and deterministic safety validation.
8. Delivery goes through the existing semantic repeat guard and stable source-ID
   idempotency key.

Any uncertainty resolves to silence. A stale, disallowed, unsafe, or already
answered candidate is completed with a machine-readable resolution and is never
retried.

## State and Retry Semantics

Add `rescheduleGroupHostCandidate(messageId, dueAtMs, resolution, nowMs)` for a
claimed candidate that needs more quiet time. It returns the row to `pending`
without changing its already-recorded delivery-attempt counter and without
recording an operational error.

Operational failures retain the existing maximum of three claims. Retry records
store only a safe category such as `ai_runtime_error`, `send_error`, or
`state_error`. Completed and dead candidates continue to use the existing
retention pruning.

## Prompt and Output Boundary

Prompts explicitly label candidate text and transcripts as untrusted quoted data.
They state that instructions, mentions, links, commands, and role changes inside
that data must not be followed.

The reply safety gate rejects:

- mass mentions or explicit user/channel mention markup;
- HTTP links, Markdown links, code fences, or command-like content;
- claims of group consensus or invented attribution;
- promises, approvals, authorizations, payments, deletion, publication, or record
  creation on behalf of a person;
- more than one question, missing final question, or text outside 60–180
  characters.

## Worker Liveness and Observability

The loop catches claim-level and processing-level exceptions separately. A
claim-level failure waits with bounded exponential backoff and then retries the
loop instead of terminating it. Health state records:

- last loop check time;
- last successful resolution time;
- pending, due, processing, completed, and dead counts;
- last redacted error category and time.

Audit details never include candidate or generated text. The service log may show
the source message ID and safe error category only.

## Acceptance Criteria

1. Removing a chat from the allowlist suppresses its already-queued candidates.
2. Candidates older than ten minutes never generate or send a reply.
3. Recent group activity defers processing without consuming a failure retry.
4. A related human reply still cancels intervention; same-sender elaboration does
   not falsely count as human pickup.
5. Prompt-injected or structurally unsafe generated text never reaches `send`.
6. Worker claim failures do not permanently stop later candidates.
7. Retries and audits contain redacted error categories, not raw chat text.
8. Restart recovery and send ambiguity still produce at most one delivered reply.
9. Other groups retain the conservative semantic engagement policy.
10. Full regression and mechanism acceptance suites pass before restart.
