# WeChat group Multica for every participant design

Date: 2026-08-14

## Goal

Allow every participant in a personal-WeChat group to explicitly invoke the
digital employee, create and manage Multica work, and receive execution progress
and final delivery back in the originating group. The lifecycle must match the
existing direct-chat flow rather than stopping after Issue creation.

## Confirmed product rule

- Any group participant may start a Multica request by explicitly mentioning a
  configured assistant alias.
- Read operations execute immediately. For new Issue creation, selecting the
  execution squad is the confirmation and the Issue is created immediately;
  destructive or overwrite-style mutations retain explicit confirmation.
- The configured default workspace is treated internally as `My workspace` and
  is never presented as a choice to group participants. Squad selection,
  confirmation, execution, progress, and delivery are bound to the originating
  group and originating sender.
- Follow-up selections and confirmations from that same sender do not require a
  repeated mention while a bounded pending action exists.
- Another participant cannot select, confirm, cancel, or hijack someone else's
  pending action.
- Ordinary unmentioned group conversation remains context-only and cannot create
  or mutate Multica data.

## Chosen architecture

### Authorization

Treat a normalized WeChat group participant as write-capable only after ingress
has admitted an explicit assistant invocation or the processor has found a
pending Multica action keyed by the same `chatId + senderId`. The initial request
still requires the mention. Pending routing and confirmation reuse the durable
sender-scoped action store.

The existing preview, single/double confirmation, stale-Issue check,
idempotency, and ambiguous-result protections remain unchanged.

### Lifecycle parity with direct chat

The group uses the same Multica pipeline as direct chat:

1. Parse the request into a constrained Multica plan.
2. Resolve the configured `My workspace` internally and ask only for the
   execution squad.
3. Treat the originating sender's squad selection as authorization to create.
4. Create the Issue immediately with the selected squad as assignee, without a
   second six-digit confirmation.
5. Bind the Issue origin and subscribe the original group/sender to updates.
6. Let Multica run the assigned work automatically.
7. Synchronize run progress and significant Issue changes to the original group.
8. If the request specifies PDF, Word, PPT, Excel, image, audio, video, HTML, or
   another supported artifact, persist a delivery contract and return the real
   attachment through the original WeChat group when Multica uploads it.
9. Without an explicit file format, completion status and the Issue result link
   are the final delivery.

Selecting “create only” remains available only when the requester explicitly
chooses it. The normal squad path continues automatically after squad selection and
does not require a second “start execution” command.

### Group follow-up routing

Before silently observing an unmentioned group message, check for a live pending
Multica route or confirmation owned by the same sender. Only recognized bounded
squad selection, artifact-format supplements, confirmation, or cancellation text
is consumed. Unrelated messages remain group context and do not disturb the
pending action. Artifact-format supplements update the same pending Issue and
its delivery contract rather than starting a separate request.

### Progress and delivery isolation

Multica origin, subscription, conversation binding, and artifact contract all
retain the original channel, group, sender, and chat type. Synchronization may
notify that group, but it must not redirect content to another group or expose
another participant's pending request.

## Failure behavior

- Unauthorized or malformed group events fail closed.
- A different participant's confirmation is ignored as ordinary group context.
- Failed creation does not auto-retry when the result is ambiguous.
- Execution and artifact notification retries use the existing durable outbox.
- Missing artifacts remain in waiting state; the system does not claim delivery.
- Deployment occurs only with zero pending, failed-due, or processing inbound
  messages. Historical group events are replayed only with explicit user
  authorization and an exact bounded message set.

## Verification

Add tests proving:

- any explicitly mentioning WeChat group participant can prepare a Multica
  mutation;
- an unmentioned new request cannot mutate;
- new creates use the configured `My workspace` without exposing a workspace
  selector;
- same-sender unmentioned squad, artifact-format, confirmation, and cancellation
  follow-ups reach the pending workflow;
- another sender cannot consume or confirm that pending workflow;
- group Issue creation binds origin and subscription to the group/sender;
- squad assignment starts the same direct-chat execution lifecycle;
- progress and final artifacts route back to the original WeChat group;
- full mechanism and repository test suites remain green.
