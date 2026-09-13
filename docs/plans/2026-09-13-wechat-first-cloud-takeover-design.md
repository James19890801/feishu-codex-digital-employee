# WeChat-first cloud takeover design

## Decision

Ship and accept WeChat cloud takeover independently of DingTalk. DingTalk remains local-only until its separate cloud authorization and end-to-end acceptance are complete. This narrows the dual-channel readiness gate in the [Alibaba/Qoder parity design](2026-09-13-aliyun-qoder-runtime-parity-design.md); it does not relax WeChat's safety gates.

## Architecture and flow

The existing Alibaba Hong Kong relay remains the sole GeWe callback ingress, durable inbound queue, leadership coordinator, and automated-send authority. The Mac owns the primary processing lease. A cloud standby on the Alibaba host consumes the same queued WeChat events only after a signed main-process heartbeat expires, the old generation is fenced, and WeChat-specific readiness passes. It calls the existing Qoder Agent for bounded reasoning and sends through an independently configured GeWe credential. DingTalk readiness is not consulted for WeChat promotion, and the cloud worker does not claim DingTalk events.

WeChat readiness requires a fresh verified policy digest, acknowledged critical-state cursor, Qoder health, live ingress, real provider send credential and receipt validation, identical inbound trigger and outbound rules, human-takeover state, and generation-fenced send authority. The daily encrypted parity snapshot remains a reconciliation mechanism, not proof of current policy. The Mac publishes critical deltas promptly; the coordinator refuses takeover if they are unacknowledged.

Every automated reply obtains a unique `(wechat, source_event_id, action_kind)` intent. The coordinator rechecks policy and lease generation immediately before the provider send. A confirmed provider message ID completes the intent; ambiguous sends remain pending reconciliation and are never automatically repeated. On Mac recovery, the cloud drains and the Mac receives a newer generation after reconciling the inbox and send ledger. GeWe has no complete history backfill, so gaps are reported as not fully checked rather than silently counted as zero.

## Failure handling and acceptance

Missing credentials, stale policy, failed receipt parsing, stale generation, Qoder outage, or an uncertain send fail closed without fabricated replies. Test native/text @, explicit 小詹 mentions, quoted follow-ups, group @ semantics, blocklists, human takeover, duplicate callbacks, delayed receipts, and local recovery. Then perform a controlled Mac stop, send harmless real WeChat messages after takeover, verify exactly one provider-confirmed response per eligible event, restart the Mac, and verify duplicate-free handback. Keep cloud sending disabled until these checks pass. Do not describe the result as complete historical coverage while GeWe lacks history retrieval.
