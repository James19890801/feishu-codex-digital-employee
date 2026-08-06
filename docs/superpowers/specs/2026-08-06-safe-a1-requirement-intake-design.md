# Safe A1 Requirement Intake Design

## Goal

Reliably accept a complete requirement from DingTalk, preserve its conversation context and requester, and create or update an A1 requirement only through a verified Owner-authorized mutation.

## Architecture

The A1 workflow becomes a small state machine instead of an immediate keyword-triggered write. It receives the current message plus recent conversation history, recognizes natural create phrases such as “帮他建一个 1A 需求”, resolves only configured product routes, produces a preview, and waits for verified Owner confirmation before mutation. External users may submit and clarify requirements, but they cannot cause an A1 write.

The workflow carries requester, requested assignee, product route, source message, and specification in the pending snapshot. Unknown products require an explicit supported target instead of falling back to WebAgent. Repository inspection enriches the specification when available; a search timeout or no matching source file is recorded as missing evidence and must not discard an otherwise actionable requirement.

## Data Flow

1. DingTalk receives a message and loads recent per-sender conversation history.
2. A1 intake runs before first-contact greeting so a requirement is not swallowed by the introduction.
3. The workflow classifies create, update, and progress intents from current text plus history.
4. Missing product or assignee information is clarified and persisted.
5. The workflow creates a mutation preview. Non-Owner users receive a receipt saying Owner confirmation is required.
6. A verified Owner self-chat confirmation performs a duplicate search, updates an exact existing item when selected, or creates a new item with assignee and priority.
7. A1 readback is mandatory and the returned ID, status, assignee, project, and URL form the receipt.

## Safety Rules

- Only a verified Owner DingTalk self-chat can confirm an A1 create or update.
- A third-party request never directly mutates A1.
- Only configured A1 projects are valid mutation targets.
- Unknown products never default to WebAgent.
- Confirmation is bound to the prepared snapshot and expires through the existing pending-action store.
- Duplicate candidates are surfaced before create; an exact workitem ID updates that item instead of creating another.
- Ambiguous mutation results are not retried automatically.

## Failure Handling

- Repository search timeout or no readable file: keep the requirement, mark code evidence unavailable, and continue to preview.
- Missing product: ask for WebAgent or AI协同空间.
- Missing target assignee: ask who should own the item; Owner may explicitly choose the default Owner account.
- Unauthorized confirmation: do not mutate and explain that Owner confirmation is pending.
- A1 create/update/readback failure: retain an actionable error receipt and do not claim success.

## Acceptance Criteria

- “帮他建一个 1A 需求” and the observed WebAgent requirement message enter the A1 workflow.
- First-contact requirement messages are not replaced by the assistant introduction.
- Conversation history is passed into requirement planning.
- Unknown products cannot create in WebAgent by fallback.
- External users cannot create or update A1 directly.
- Assignee and priority are passed to A1 mutation calls.
- Repository search failure does not lose an actionable intake.
- Every successful mutation returns authoritative A1 readback.
- Existing A1, conversation, and full regression tests remain green.
