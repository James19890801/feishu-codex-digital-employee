# Test Group Host Mode Design

## Objective

AIPRO should act as a restrained host in selected group chats. Explicit mentions, direct alias addressing, and continuations of an AIPRO exchange still receive an immediate reply. A substantive public topic that is not directed at AIPRO becomes a delayed host candidate: AIPRO waits 75 seconds, remains silent when another member picks up the topic, and intervenes only when the topic would otherwise go unanswered.

The first deployment is limited to the configured DingTalk test group. The capability is reusable, but no real group identifier is committed to the repository.

## Existing Mechanism Conflict

The current semantic group engagement router is intentionally conservative. Its classifier prompt allows replies only when a message is directed at AIPRO, continues an AIPRO exchange, or requests AIPRO participation. Ambient group topics therefore default to `observe`. This is correct for an assistant but insufficient for a host.

Host mode is additive. It must not weaken the default behavior of other groups or bypass human takeover, rate limits, outbound semantic deduplication, echo protection, or discussion-budget controls.

## Approaches Considered

### Broaden the existing classifier

This would make public topics reply immediately. It is simple but conflicts with the requested grace period and would increase false interventions in every enabled group.

### Block each inbound handler for the grace period

This preserves ordering but blocks the serialized per-chat queue. Later messages could not cancel the candidate promptly, and one slow candidate would delay unrelated work.

### Persistent deferred host candidates

This is the selected design. The inbound handler records a bounded candidate and completes normally. A lightweight background loop claims due candidates, rechecks subsequent group context, and either cancels the candidate or generates one host reply. Candidates survive process restarts and remain auditable.

## Configuration

Add the following safe settings:

- `groupHostModeEnabled`, default `false`.
- `groupHostChatIds`, default an empty list.
- `groupHostSilenceMs`, default `75000`, bounded to 30–180 seconds.
- `groupHostReplyCooldownMs`, default `180000`, bounded to 60–900 seconds.

The repository example keeps `groupHostChatIds` empty. The local ignored configuration enables the known test group.

## Candidate Detection

Host mode applies only when all of the following are true:

- the message is a non-empty group text or post in an allowlisted chat;
- it is not an explicit mention, direct alias address, AIPRO continuation, owner-control message, outbound echo, or message addressed to another named member;
- it is not a greeting, acknowledgement, system notice, terminal handoff, or other low-information message;
- it is either a public question/request or a substantive viewpoint, case, news item, proposal, or judgment with clear discussion potential.

Deterministic filters remove obvious non-candidates. Ambiguous substantive candidates are evaluated only when the silence window expires, so active conversations do not consume AI-classifier capacity.

## Persistence and State

Persist candidates in SQLite with source message ID, chat ID, sender ID, original text, semantic topic, creation time, due time, status, and resolution reason. Source message ID is unique. The table exposes atomic operations to schedule, cancel, claim, complete, fail, and recover stale processing candidates.

Keep at most three pending candidates per chat. When the limit is reached, retain the newest substantive topics and close older pending candidates as superseded. A claimed candidate that is interrupted returns to pending with bounded retries; after the retry limit it is marked failed without sending a speculative reply.

## Silence Recheck

Every later group message is still recorded normally. Before replying, the worker reads messages after the candidate:

- a related reply from another member resolves the candidate as `human_picked_up`;
- a same-sender elaboration enriches context but does not count as another member picking up the topic;
- unrelated chatter does not automatically resolve the candidate;
- an explicit AIPRO reply, owner activity, or active human takeover resolves or suppresses the candidate;
- a recent host reply inside the per-chat cooldown resolves the candidate as `host_cooldown`.

Semantic relation uses the existing topic comparison first. Borderline cases use a bounded classifier that returns strict JSON and fails closed to silence.

## Host Reply Contract

The generated reply is 60–180 Chinese characters and contains exactly three functions:

1. briefly acknowledge the original topic;
2. add one concrete observation, distinction, or implication;
3. ask one open question that invites group members to continue.

It must not produce a long answer, claim consensus, invent member views, create business records, or issue a generic acknowledgement. The reply mentions the original sender and uses a stable idempotency key derived from the source message ID.

## Priority and Safety

Priority order is:

1. verified human takeover and owner controls;
2. explicit mention or direct AIPRO continuation;
3. channel and sender rate limits;
4. pending host-candidate cancellation and silence recheck;
5. host reply generation;
6. outbound echo and semantic-repeat guards;
7. discussion-budget controls for subsequent discussion.

Only the delayed trigger is new. All outbound messages continue through the single guarded `sendText` path.

## Reliability and Observability

The worker polls due candidates without blocking inbound chat queues. Audit events record scheduled, cancelled, claimed, replied, suppressed, retried, and failed outcomes without storing raw text in audit details. Dashboard status exposes aggregate counts, pending count, last run time, and the latest redacted error.

Disabling host mode stops new scheduling and leaves existing candidates suppressed. Restart recovery must not duplicate replies.

## Acceptance Criteria

1. Explicit mentions in the test group still reply immediately.
2. A public discussion topic receives no AIPRO reply during the 75-second grace period.
3. A related reply from another member cancels the pending intervention.
4. Same-sender elaboration does not falsely count as another member answering.
5. An unanswered public topic receives one short host reply after the grace period.
6. Greetings, acknowledgements, announcements without discussion value, and messages addressed to others remain silent.
7. Human takeover suppresses pending and new host interventions.
8. Restart recovery produces at most one reply per source message.
9. Other groups retain the current conservative semantic-engagement behavior.
10. Existing full tests and mechanism acceptance remain green.
