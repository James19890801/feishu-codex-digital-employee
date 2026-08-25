# Online-first Blacklist Cloud Takeover Design

## Goal

Run AIPR0S in blacklist mode on both the Mac and the cloud while preserving the
AI-Lab `online-first` runtime. If the Mac becomes unable to serve DingTalk, the
Railway standby must take over without widening access, losing messages in the
takeover window, or producing duplicate replies. When the Mac recovers, control
must drain back to the local runtime.

## Current state and gaps

- The live Mac is healthy and uses `aiRuntime=online-first`, but it currently has
  `allowAllChats=false`, so one allowlisted owner chat is the only admitted chat.
- The existing `automaticCommunicationBlocklist` contains four DingTalk identity
  entries. These entries, not display names, remain the source of truth.
- The cloud failover branch already has Cloudflare coordination, Railway DWS,
  generation fencing, idempotent claims, Qoder execution and blacklist policy.
- The active AI-Lab branch does not contain the integrated cloud modules. Its
  current heartbeat is an older sidecar running from another worktree.
- That sidecar's checkout rejects `online-first` if it restarts.
- The Railway worker always invokes the group-send form even for direct messages.
- While Railway is in standby, inbound events are discarded. The existing
  three-minute backfill reads group mentions only, so a direct message arriving
  during the roughly 90-second takeover decision window can be lost.

## Repository and isolation strategy

Implementation happens on `codex/online-first-blacklist-cloud-takeover` in a
dedicated worktree created from the active branch's committed HEAD. The cloud
failover branch is integrated selectively, then the current AI-Lab/online-first
changes are migrated by semantic file-level review. The dirty primary checkout
is never reset, cleaned or overwritten.

## Access policy

### Local runtime

- Set `allowAllChats=true` in the private installed configuration.
- Preserve all existing `automaticCommunicationBlocklist` entries unchanged.
- Apply the blocklist before durable inbound processing and before any automatic
  outbound action.
- Direct messages are eligible by default unless their sender or direct target
  matches a blocked DingTalk identity.
- Group messages remain eligible only when DingTalk delivers the explicit `@`
  event or an approved assistant alias is explicitly mentioned.
- Explicit owner-authorized outbound operations retain the existing override;
  automatic replies never override the blocklist.

### Cloud runtime

- Require `AIPROS_ACCESS_MODE=blacklist`.
- Derive `AIPROS_BLOCKED_SENDER_IDS` from every DingTalk `openId`, `userId` and
  normalized `ids[]` in the local blocklist. Never use display names.
- Synchronize values to Railway without printing them. Verification reports only
  entry counts and a one-way digest.
- Optional chat-level blocks remain in `AIPROS_BLOCKED_CHAT_IDS`.
- Apply blacklist and response-obligation checks both when buffering a standby
  event and immediately before a cloud claim.

## Runtime routing

The local message path remains:

1. DingTalk independent DWS event stream.
2. Durable local inbox and response governance.
3. `online-first` AI routing: AI-Lab pre-production primary, local Codex fallback
   only for retryable transport/server/timeout/empty-response failures.
4. After the configured three exhausted retryable local attempts, a sanitized
   L0/L1 request may use signed Cloudflare per-message Qoder fallback.

Permission denial, confirmation requirements, business validation errors,
quality dissatisfaction and L2/L3 actions never trigger automatic execution in
the cloud. L2/L3 receives a human-confirmation handoff and performs no mutation.

## Whole-host failover

- The integrated Mac runtime emits a signed heartbeat every 30 seconds only
  while DWS is connected and the AI runtime is healthy.
- Three missed healthy heartbeats move the coordinator from `LOCAL_PRIMARY` to
  `TAKING_OVER` and increment the generation.
- The Railway DWS event consumer stays warm under its independent authorization.
- Railway becomes `CLOUD_ACTIVE` only after DWS authentication, event readiness,
  generation validation and standby-buffer replay are ready.
- Every eligible message requires a generation-scoped atomic claim and a stable
  DWS UUID. Completion records a terminal outcome and message ID.
- Three consecutive healthy local heartbeats move the coordinator to `DRAINING`.
  New cloud claims close, in-flight work completes, then state returns to
  `LOCAL_PRIMARY`.
- After the integrated heartbeat is deployed and proven, the old heartbeat
  sidecar is removed so there is one local authority.

## Standby event buffer

The always-warm Railway consumer must not discard messages while local is still
primary.

- Store only normalized, cloud-eligible DingTalk events for at most three minutes
  and at most 100 rows on the Railway volume.
- Use SQLite with `secure_delete=ON`. Encrypt the normalized payload using
  AES-256-GCM with a key derived by HKDF from the existing sealed container token
  and node identity. Store only ciphertext, nonce, tag, digest, timestamps and
  chat type.
- Deduplicate by message digest. Expired, blocked, completed and stale-generation
  rows are deleted.
- On activation, drain the buffer oldest-first after generation fencing. Continue
  the existing bounded group-mention API backfill as a second source; claims and
  stable UUIDs prevent duplicate sends.
- If the buffer cannot be opened, decrypted or bounded, Railway fails closed and
  does not announce readiness.

## DingTalk delivery

- Direct replies use the sender's DingTalk identity and the direct-message send
  form.
- Group replies use the open conversation ID and group-send form.
- Group traffic without an explicit assistant mention is ignored.
- A send succeeds only after `query-send-status` reaches terminal `SUCCESS` and
  returns a message ID.
- Cloud outcome metadata never stores message bodies. Local acceptance requires
  same-conversation readback and `outbound_echo` consistency where the local
  ledger participates.

## Deployment

1. Test and commit the integration branch.
2. Deploy the Cloudflare Worker and verify signed status plus console access.
3. Privately synchronize the blacklist and deploy Railway with `ALWAYS` restart,
   zero overlap and the existing persistent DWS volume.
4. Deploy the integrated local service with `allowAllChats=true`, the unchanged
   four-entry blocklist and `aiRuntime=online-first`.
5. Confirm integrated heartbeats, then uninstall the old sidecar.

No token, profile, channel, DingTalk identity, message body or private
configuration is committed or printed.

## Acceptance

Automated and synthetic acceptance must prove:

- local and cloud normalization use all configured blacklist identities;
- blocked senders and blocked chats never claim or send;
- non-blocked direct messages use the direct send form;
- group `@` messages use the group send form and ordinary group messages do not
  reply;
- standby-buffer rows survive a Railway worker restart, expire after three
  minutes, drain once and fail closed on decryption error;
- three missed heartbeats activate a new fenced generation;
- three healthy heartbeats drain back to local;
- concurrent/replayed processing produces one terminal send.

Live acceptance must then prove:

1. Local healthy traffic replies without a cloud label.
2. A controlled local stop reaches `CLOUD_ACTIVE` after the heartbeat threshold.
3. A consenting tester sends a harmless direct message or explicit group `@` and
   receives exactly one natural cloud reply with terminal send confirmation and
   same-conversation readback.
4. A blocked identity receives no automatic reply.
5. Local recovery reaches `DRAINING` and then `LOCAL_PRIMARY` without duplicate
   replies.
6. A later message during the controlled cloud window also succeeds, proving the
   standby is durable rather than an outage-instant smoke test.

Until all live steps have fresh evidence, report deployment and coordinator
health separately from `auto_reply_verified` and `7x24_verified`.

## Rollback

Re-enable the old local service only after disabling integrated heartbeat,
disable Railway lease activation, restore the private configuration snapshot,
and re-install the previous sidecar only if the integrated branch is no longer
running. Revoking cloud credentials is reserved for retirement or compromise;
rollback itself must not expose or rotate unrelated local DWS state.
