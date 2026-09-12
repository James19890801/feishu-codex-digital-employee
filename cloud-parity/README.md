# Cloud parity standby (not production-enabled)

`CloudStandby` orchestrates verified policy, a fenced leadership generation, a single
outbound intent and a provider-confirmed receipt. It deliberately has no default
policy engine, credentials, senders, readiness probe or service launcher. A deploy
that merely starts this module cannot send a message or claim parity.

Before enabling cloud promotion, wire and live-test all eight readiness inputs:
Qoder, WeChat ingress, DingTalk ingress, both channel senders, same policy engine,
outbound fencing, and provider receipts. The coordinator must also compare the
last *main-process* heartbeat's policy digest and critical-state sequence with
the encrypted server policy and acknowledged mutation cursor. A daily snapshot
alone cannot satisfy that condition.

Do not stop the Mac worker until both channels have independently passed real
inbound → rule evaluation → Qoder → fenced send → provider receipt tests and a
recovery/handoff drill. DWS must authenticate in the dedicated server profile;
do not copy the Mac's profile. On ambiguous send, preserve the prepared intent
and reconcile with the provider rather than retrying automatically.
