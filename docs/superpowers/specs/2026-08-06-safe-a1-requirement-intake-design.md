# Safe A1 Requirement Intake Design

## Goal

Reliably accept a complete requirement from DingTalk, including the Owner's DingTalk self-chat, preserve its conversation context and requester, and create or update an A1 requirement immediately without an approval gate.

## Architecture

The A1 workflow receives the current message plus recent conversation history, recognizes natural create phrases such as “帮他建一个 1A 需求”, resolves configured product routes, and writes immediately. External users do not need an Owner confirmation step.

The workflow carries requester, requested assignee, product route, source message, and specification into the A1 body. Unknown products require an explicit supported target instead of falling back to WebAgent. Repository inspection enriches the specification when available; a search timeout or no matching source file is recorded as missing evidence and must not discard an otherwise actionable requirement. A missing assignee does not block creation; A1 project defaults may apply.

## Data Flow

1. DingTalk receives a message and loads recent per-sender conversation history. Owner self-chat is read through the dedicated DWS self-chat poller because the personal event stream filters self-sent messages.
2. A1 intake runs before first-contact greeting so a requirement is not swallowed by the introduction.
3. The workflow classifies create, update, and progress intents from current text plus history.
4. A missing product is clarified and persisted; a missing assignee does not block creation.
5. The workflow creates or updates the A1 item immediately.
6. A1 readback is mandatory and the returned ID, status, assignee, project, and URL form the receipt.

## Routing and Integrity Rules

- Only configured A1 projects are valid mutation targets.
- Unknown products never default to WebAgent.
- No authorization or confirmation preview blocks a recognized request.
- A DingTalk P2P message marked `selfChat=true` follows the same direct mutation path and records the requester as `阿充（钉钉自聊）` instead of an opaque OpenID.
- An exact workitem ID with update language updates that item.
- Create and update receipts always come from authoritative A1 readback.

## Failure Handling

- Repository search timeout or no readable file: keep the requirement, mark code evidence unavailable, and continue to create or update.
- Missing product: ask for WebAgent or AI协同空间.
- Missing target assignee: create without `--assignee` and allow A1 project defaults to apply.
- A1 create/update/readback failure: retain an actionable error receipt and do not claim success.

## Acceptance Criteria

- “帮他建一个 1A 需求” and the observed WebAgent requirement message enter the A1 workflow.
- First-contact requirement messages are not replaced by the assistant introduction.
- Conversation history is passed into requirement planning.
- Unknown products cannot create in WebAgent by fallback.
- External users can create or update A1 directly without Owner confirmation.
- The Owner can create A1 requirements from DingTalk self-chat with one message and receives the authoritative readback receipt.
- Assignee and priority are passed to A1 mutation calls.
- Repository search failure does not lose an actionable intake.
- Every successful mutation returns authoritative A1 readback.
- Existing A1, conversation, and full regression tests remain green.
