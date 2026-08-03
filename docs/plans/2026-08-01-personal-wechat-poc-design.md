# AIPRO Personal WeChat POC Design

Date: 2026-08-01  
Status: Approved  
Scope: Personal WeChat text-message proof of concept on macOS

## 1. Objective

Prove that AIPRO can receive a new message addressed to the operator's already logged-in personal WeChat account, send the message through the existing Codex response pipeline, and return the generated text through that same personal WeChat account.

The POC prioritizes proving the real end-to-end path. It is not represented as an official WeChat API integration or as production-ready personal-account automation.

## 2. Non-negotiable constraints

1. Feishu and DingTalk remain the primary channels and must continue operating if the WeChat POC is disabled, disconnected, overloaded, malformed, or crashed.
2. The POC does not reverse engineer WeChat authentication, store the WeChat password, modify client binaries, inject code into WeChat, or bypass login or security controls.
3. The operator logs into the official macOS WeChat client normally. The POC interacts only with the already logged-in desktop session through operating-system UI capabilities.
4. The WeChat POC is fail-closed. Restart, ambiguous state, missing permissions, screen lock, target mismatch, or uncertain send state prevents further sending.
5. Phase one supports text only.

## 3. Options considered

### 3.1 Vendor-neutral protocol plus simulator

This is the safest way to validate AIPRO's internal contract, queue, retries, memory, audit, and dashboard without touching a real WeChat account. It remains part of the implementation and test strategy, but by itself does not satisfy the real-account POC.

### 3.2 WeChat iLink bot bridge

A local `wechat-acp` 0.8.0 installation was discovered. It uses the WeChat iLink bot endpoint, supports bot direct messages, and intentionally ignores group messages. It is useful as architectural reference but does not satisfy the requirement to reply as the operator's existing personal WeChat identity. The existing process will not be modified or stopped by this project.

### 3.3 Official desktop client bridge — selected POC route

A separate local bridge observes the official macOS WeChat client and performs guarded text entry and send actions through operating-system UI capabilities. It requires an unlocked desktop session, a running official client, and explicit macOS permissions. It can demonstrate the required personal-identity flow without implementing a private login protocol.

This route is fragile with respect to WeChat UI changes and is approved only as a POC. Production hardening or commercial deployment requires a separately authorized and supportable execution driver.

## 4. Isolation architecture

The POC runs as a third channel in a separate `aipro-wechat-poc` process.

```text
Official WeChat.app
        |
        v
aipro-wechat-poc process
  - discovery loop
  - UI adapter
  - channel-local queue
  - deduplication
  - send guard
        |
        v
Versioned localhost AIPRO channel contract
        |
        v
WeChat-dedicated Codex session / quota
        |
        v
Existing memory and audit interfaces
```

Isolation requirements:

- Separate process, configuration namespace, state directory, logs, queue, health state, and lifecycle controls.
- No changes to Feishu or DingTalk credentials, listeners, polling cursors, WebSocket connections, or recovery loops.
- WeChat startup failure must not fail AIPRO startup.
- WeChat channel work has bounded concurrency and lower scheduling priority than Feishu and DingTalk.
- The POC cannot backpressure the primary-channel queues.
- Stopping or removing the POC requires no restart or configuration change in the primary channels.
- The dashboard and local channel contract may be shared; execution and failure domains are not.

## 5. Message discovery

The bridge uses a signal-plus-poll design:

1. macOS notifications provide a low-latency wake-up signal where available.
2. A one-second active scan checks unread conversations and newly visible messages.
3. An idle backoff reduces scanning when no activity is present.
4. Periodic scanning acts as the fallback if notifications are absent or truncated.

The discovery target is at most three seconds while the desktop is unlocked, WeChat is running, permissions are available, and the relevant UI can be inspected.

The bridge does not read or alter WeChat's private local database.

## 6. Trigger rules

- Direct chat: process each new incoming text message.
- Group chat: process only messages that explicitly mention the operator.
- Ignore outgoing/self messages, system notices, recalled-message notices, payments, transfers, red packets, and non-text content.
- Phase one does not treat an inferred or "obvious" address in a group as a trigger.
- There is no contact or group allowlist in normal operation.
- Real acceptance testing is restricted to a controlled test chat and a controlled test group. No broadcast testing is performed.

Each candidate message receives a channel-local idempotency key derived from the conversation identity, direction, normalized text, and observed message time. The durable deduplication window prevents repeated UI scans from generating duplicate replies.

Messages in one conversation are serialized. Different conversations use bounded concurrency.

## 7. Reply flow and send guard

```text
Discover candidate
  -> classify direct/group mention
  -> reject self/system/non-text
  -> deduplicate
  -> persist channel event
  -> enqueue in the WeChat-local queue
  -> invoke a WeChat-dedicated Codex session
  -> check master switch and generation epoch
  -> resolve and verify the target conversation
  -> focus the verified input area
  -> check master switch and target again
  -> insert reply text
  -> check master switch and target again
  -> send
  -> verify visible outbound result when possible
  -> write memory, result, metrics, and audit event
```

Every externally visible action is guarded by the current switch generation. Turning the channel off invalidates all in-flight work that has not already been sent.

If the active conversation title or other target evidence does not match the queued target, the bridge aborts. If send completion is uncertain, the message is marked `uncertain`; the system does not retry it automatically.

## 8. Dashboard controls

The dashboard adds a WeChat-only master switch labelled `Personal WeChat auto-reply`.

### Disabled

- No reply is generated or sent.
- Unsent queued and generated replies are cancelled.
- The disabled cursor advances so messages received while disabled are not replayed later.

### Enabling

- A confirmation dialog states the active policy: all direct text messages, group messages only when explicitly mentioned, text replies only.
- Enabling creates a new switch generation and starts from the current message boundary.
- Historical messages accumulated while disabled are skipped.

### Fail-closed lifecycle

- AIPRO restart, WeChat bridge restart, unreadable control state, lost UI permission, screen lock, or WeChat logout starts or transitions the channel to disabled.
- The operator must explicitly enable it again from the dashboard.
- Turning the switch off should prevent subsequent sends within one second. A message already accepted by WeChat cannot be recalled by this control.

### Visible state

The dashboard shows:

- Master switch state
- Bridge process state
- WeChat client and UI permission state
- Last discovered message time
- Last successful reply time
- Pending queue size
- Last error or degraded reason
- Last externally visible action
- Emergency stop control

All switch operations are audited with timestamp, previous state, new state, generation, and number of cancelled tasks.

## 9. Failure handling

- WeChat unavailable: set channel to degraded/disabled; do not affect other channels.
- Desktop locked: fail closed and require explicit re-enable after recovery.
- Permission revoked: fail closed and display the exact missing permission.
- UI structure changed: stop at the first failed selector or invariant; never fall back to blind coordinates for sending.
- Target mismatch: abort, retain diagnostic evidence without sending.
- Codex timeout: mark the WeChat task failed or expired; do not block another channel.
- Message flood: enforce channel-local queue and concurrency limits; drop or expire excess work according to the configured POC cap.
- Uncertain send: no automatic retry.
- Process crash: restart may restore monitoring components, but auto-reply remains disabled.

## 10. Security and privacy

- Never collect or store the WeChat password.
- Use the normal official-client login flow.
- Store POC secrets in the macOS Keychain where secrets are required.
- Keep state and logs in the WeChat channel namespace.
- Redact message content from operational logs; full content is available only through the existing local memory/audit policy when explicitly required.
- Protect dashboard mutations with the existing local control authentication and CSRF controls.
- Bind internal control endpoints to localhost and authenticate inter-process requests.

## 11. Acceptance criteria

### Functional

1. With the switch off, incoming WeChat messages never cause a reply.
2. With the switch on, a controlled direct text message receives a reply through the operator's personal account.
3. A controlled group message with an explicit mention receives a reply.
4. A group message without a mention receives no reply.
5. Repeated scans of one message produce at most one outbound reply.
6. Turning the switch off cancels all unsent WeChat work.
7. Re-enabling processes only messages observed after the new enable boundary.
8. Message discovery is at most three seconds under the supported desktop conditions.
9. A short-text end-to-end reply normally completes within fifteen seconds, excluding unusually long Codex work.

### Isolation and resilience

1. Feishu and DingTalk pass baseline smoke tests before the WeChat POC is enabled.
2. Feishu and DingTalk continue to pass live smoke tests while the WeChat bridge is healthy.
3. They continue to pass while the WeChat process is killed, hung, disconnected, flooded, malformed, or restarted.
4. Wrong-target and changed-UI simulations abort without sending.
5. An uncertain send is not automatically duplicated.
6. Restart leaves WeChat auto-reply disabled.
7. Removing or stopping the POC does not require primary-channel changes or restart.
8. All state transitions, failures, received-message decisions, and send outcomes appear in audit records.

## 12. Rollout and rollback

1. Build and validate the vendor-neutral contract and simulator first.
2. Add the separate desktop bridge behind a disabled-by-default feature flag.
3. Run automated contract, queue, deduplication, switch, failure, and primary-channel regression tests.
4. Verify required macOS permissions without enabling automatic reply.
5. Run one controlled direct-chat test.
6. Run one controlled group mention test.
7. Keep the switch off after the POC evidence is collected until the operator explicitly enables ongoing use.

Rollback is to disable the channel, stop the separate bridge, and remove its launch configuration. No Feishu or DingTalk rollback is required because their execution paths are unchanged.

## 13. Deferred work

- Images, voice, video, files, quoted replies, and rich messages
- Inferred group addressing without an explicit mention
- Locked-screen or headless operation
- Mobile-device execution drivers
- An officially authorized personal-account execution driver
- Commercial SLA, multi-host failover, and automated version compatibility certification

