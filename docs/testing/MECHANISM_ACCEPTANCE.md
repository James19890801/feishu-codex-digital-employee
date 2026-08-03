# AIPRO Mechanism Acceptance Matrix

This suite turns recently added product rules into repeatable, non-production test contracts. Run it with:

```bash
npm run test:mechanisms
```

The suite asks each rule as a falsifiable question and tests the answer against production modules. It does not send IM messages, write 1A workitems, or use live credentials.

## Self-questioning model

For every new mechanism, ask all five dimensions before implementation:

1. Who: Owner, another user, an application, or a forged identity?
2. Where: Feishu, DingTalk, WeCom, personal WeChat, group, direct chat, or self-chat?
3. State: first contact, active human takeover, expired takeover, pending confirmation, retrying, completed, or dead-lettered?
4. Failure: timeout, permission denial, duplicate event, missing ID, malformed @, runtime failure, or disconnected channel?
5. Recovery: retry, suppress, degrade, deduplicate, notify, resume, or require human confirmation?

## Automated domains

| Domain | Cases | Primary contract |
|---|---:|---|
| Licensing | 2 | A valid local entitlement is required before the digital human starts |
| Owner authorization | 24 | Only the verified Owner in a trusted self-chat can advance protected external writes |
| Human takeover | 8 | Owner controls, five-minute boundary, assistant echo exclusion, retry/degrade policy |
| Group attribution | 6 | Group replies @ the requester without malformed or accidental mentions |
| Inbound normalization | 5 | Only complete supported DingTalk events become internal messages |
| Inbound validation | 4 | Missing identity, message ID, chat ID, or valid chat type fails closed |
| Durable inbox | 3 | Cross-transport deduplication, retry timing, and completed-message finality |
| Loop prevention | 3 | Invisible marker, one-time echo consumption, and per-chat circuit isolation |
| Pending confirmation | 3 | No confirmation can cross sender, conversation, or TTL boundaries |
| Conversation etiquette | 7 | Short replies stay short, detailed requests get budget, introductions happen once |
| Disconnect notification | 7 | Incident, partial recovery, recovery, and no-op transitions are deterministic |
| Agent routing | 4 | Content work from every IM provider goes to the configured local agent runtime |
| Decision boundary | 4 | Safe reads execute; external writes confirm; privacy and decision requests refuse |
| Polling selection | 1 | Group @, direct chat, duplicate and Owner-message filtering remain deterministic |
| Live reply context | 2 | Ordinary DingTalk replies read the latest conversation before invoking Codex and fail closed if history cannot be read |
| Retry boundary | 4 | Attempts one and two retry; attempt three and later do not loop forever |

Total: 87 mechanism contracts.

## Live verification boundary

Automated contracts cover deterministic platform logic. External-provider behavior still requires bounded smoke tests for DWS authentication, event-stream connectivity, IM delivery status, 1A access, and repository access. Live smoke tests must use the Owner self-chat or an explicitly designated recipient and must never broadcast to unrelated conversations.

## Change rule

Every new mechanism must add at least one success case, one denial case, one boundary case, and one recovery case here or in the closest focused test file. A bug fix must first reproduce the defect as a failing test before production code changes.
