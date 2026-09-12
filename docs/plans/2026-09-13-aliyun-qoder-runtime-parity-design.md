# Alibaba Cloud / Qoder local-first failover design

## Goal and acceptance boundary

The local Mac remains the preferred worker. The existing Alibaba Cloud Hong Kong host is the always-on ingress, state, and send coordinator. If the local worker is unavailable, a cloud worker uses the existing Qoder Cloud Agent and Environment for reasoning. WeChat and DingTalk ingress, outbound rules, human takeover, persona, relationship memory, allow/deny lists, and message receipts must have the same effective state on both workers. A daily automatic full reconciliation is required in addition to near-real-time deltas. The feature is **not live** until a controlled local shutdown produces correctly routed cloud replies and a duplicate-free handback on both enabled IM channels.

The existing August Cloudflare/Railway text-only failover is not the production target. The September Alibaba WeChat relay remains active while the cloud worker is developed, and its current queue contract must remain backward compatible.

## Options considered

1. **Alibaba coordinator + standby application + Qoder reasoning (chosen).** One durable queue and send ledger, explicit leadership leases, maximum reuse of local policy code. Requires a separate cloud DingTalk identity and selective state replication, but minimizes duplicate replies and dependence on Cloudflare quotas.
2. Qoder Forward Mode with its built-in IM bindings. Faster to start, but rebinding WeChat/DingTalk would fork the present channel identity, local moderation, receipts, and human-takeover semantics.
3. Revive the August Cloudflare/Railway design. Existing tests and state machine are useful references, but it is deliberately text-only, excludes local memory/persona and most capabilities, and retains the quota concern that motivated migration.

## Components and data flow

1. **Always-on ingress.** Alibaba already receives GeWe callbacks. Add an independently authenticated DingTalk/DWS listener on Alibaba, initially receive-only. Both normalize provider event IDs into one durable inbox. The local Mac consumes the same inbox while it owns the processing lease. If DingTalk cannot support this independent login, fail closed and report the channel as unprotected; never infer that a three-minute history query fills the gap.
2. **One send authority.** All automated WeChat/DingTalk outbound requests pass through the Alibaba coordinator, which persists `(channel, source_event_id, action_kind)` idempotency keys, a monotonically increasing lease generation, send attempts, provider receipt IDs, and ambiguous outcomes. The provider adapter rechecks the generation immediately before send. Human takeover and deny rules are checked server-side as well as in the worker. A lost-ack send is reconciled, never blindly retried.
3. **Workers.** The Mac remains the primary decision and AI worker. A cloud standby process on the same Alibaba host can run Linux-compatible policy modules and calls Qoder Managed Sessions for reasoning. Qoder is not the webhook receiver, scheduler, or source of channel credentials. Client-side custom tool requests, if introduced, are executed by the coordinator behind the same authorization and confirmation policies; no unrestricted Qoder tool can directly send messages or mutate local state.
4. **State.** The coordinator stores the authoritative inbox/outbox/lease and a versioned policy bundle: persona, BIBLE, effective inbound/outbound routing, explicit allow/deny lists, human takeover, relationship memory, and pending decisions. A local change publishes an authenticated, encrypted delta with a sequence number and hash. Each day the Mac performs a full manifest/hash reconciliation and replaces only verified, allowlisted state using a SQLite online backup or table-level export as appropriate; the cloud never copies a live SQLite file or syncs unrelated 5+ GiB of local data. Critical state (reply receipts, owner approvals, deny rules, takeover) is acknowledged by the coordinator before the local worker treats it as committed. No broad, unreviewed directory sync.
5. **Secrets and privacy.** Alibaba stores only the independently scoped channel credentials, Qoder access token, and encrypted state needed to run the standby; permissions are 0600 and secrets are excluded from Git, logs, status APIs, and backups unless encrypted. Qoder receives only task-relevant conversation context and persona/rule excerpts, not provider credentials or a raw database dump. Per-channel data export and retention are audited. The shared server's other websites and services are not modified.

## Failover and recovery

The Mac publishes signed heartbeats containing a worker generation, sequence, state version, and readiness. Missing heartbeats alone do not authorize send: the server first fences the old lease and validates the standby's DingTalk/WeChat credentials, state version, Qoder connectivity, and policy readiness. If any requirement is missing, it records degraded status and does not claim full coverage. Cloud takeover starts after a configurable detection window; only one generation may claim each event. On Mac recovery, it receives the authoritative ledger and latest policy version, the cloud drains in-flight events, and the coordinator grants a newer local generation. Both sides retain message-ID deduplication and provider receipts.

The cloud worker applies the same trigger rules (including native/text @, mention of 小詹, and quoted follow-up), allow/deny lists, owner approval, human takeover, and outbound routing. Cloud-only limitations such as unavailable desktop/Multica integrations are explicit capability failures and cannot be converted into fabricated success or unauthorized substitute channels. A capability is called parity-complete only after its own live test.

## Verification and rollout

1. Unit tests for policy-bundle serialization, allowlist filtering, hash/sequence conflicts, daily reconciliation, secret redaction, lease fencing, and outbox idempotency.
2. Integration tests with synthetic WeChat and DingTalk inbound/outbound, duplicate callbacks, delayed receipts, Qoder 429/5xx, cloud worker restart, and local recovery.
3. Read-only Qoder Agent/Environment inspection, then a harmless session smoke test. The existing Agent currently has no system persona or skills and the Environment has no packages or sessions; creation alone is not a readiness signal.
4. Stage Alibaba listener and coordinator without changing production routing. Verify a complete daily sync and replay against non-production fixtures; inspect disk, RAM, and backup restoration on the 2-vCPU/2-GiB/40-GiB host.
5. Controlled local service stop: confirm real WeChat and DingTalk messages enter the cloud inbox, Qoder produces a policy-compliant answer, exactly one provider send receipt is recorded, and local restart hands back without duplicate sends. Run a longer cloud-active window and test human takeover, denial, quoted follow-up, images/files where supported, and failure modes. Record uncovered histories as **not fully checked** where GeWe/DWS APIs cannot backfill them.

No green health check, successful deploy, empty queue, or single Qoder response by itself proves full 7x24 parity.
