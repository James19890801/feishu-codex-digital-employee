# WeChat P2P Red Packet Token Gate Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enforce a lifetime, per-person 30-reply allowance on personal WeChat chats, request one red packet at the next reply opportunity, send one refusal notice after a non-red-packet response, remain silent while blocked, and permanently unlock a person after a structurally valid personal red-packet card is observed.

**Architecture:** Keep red-packet recognition as a pure parser shared by live normalization and historical backfill. Persist relationship evidence, per-person gate state, reply accounting, and gate-message delivery claims in SQLite. Run the gate at the start of the existing per-chat serial queue before AI or other expensive handlers; account at most one successful normal reply per inbound message in the common send path. Backfill current production history idempotently while the feature flag is off, expose the resulting roster in the local Dashboard, then enable through an atomic release switch.

**Tech Stack:** Node.js ESM, `node:sqlite`, built-in `node:test`/`assert`, GeWe REST + webhook normalization, existing AIPRO Dashboard HTML/CSS/JavaScript, macOS launchd release layout.

---

## Operating invariants

- Scope is `metadata.channel === 'wechat'` and `message.chat_type === 'p2p'` only.
- Counts are lifetime totals. No date column participates in the decision and no scheduled reset exists.
- The ledger key is the inbound `message_id`, so several outbound fragments for one inbound still consume one reply.
- Only a completed, non-suppressed normal reply creates a reply-ledger row.
- Gate prompts, refusal notices, unlock acknowledgements, owner consultation messages, proactive jobs, and system notifications never count.
- A red-packet card means “card observed.” The product does not claim or verify funds.
- Full red-packet URLs, `sendid`, signatures, amounts, and raw payment XML never enter normalized metadata, audit details, relationship rows, or model prompts.
- Owner IDs in `geweOwnerWxids`, self activity, `wechat:system`, `gh_` accounts, service accounts, and groups are exempt.
- GeWe text sends have no provider idempotency key. Gate-message delivery uses a durable local claim and treats uncertain remote results as `ambiguous`; it never automatically sends the same gate message twice.

### Task 1: Add a strict, reusable red-packet classifier

**Files:**
- Create: `src/wechat-red-packet.mjs`
- Create: `src/wechat-red-packet.test.mjs`

**Step 1: Write the failing classifier tests**

Use a synthetic, scrubbed card fixture:

```js
import assert from 'node:assert/strict';
import { classifyPersonalWeChatRedPacket } from './wechat-red-packet.mjs';

const personal = `<msg><appmsg><title><![CDATA[微信红包]]></title>
  <des><![CDATA[我给你发了一个红包，赶紧去拆!]]></des><type>2001</type>
  <url><![CDATA[https://wxapp.tenpay.com/mmpayhb/wxhb_personalreceive?msgtype=1&channelid=1&sendid=fixture]]></url>
</appmsg></msg>`;

const match = classifyPersonalWeChatRedPacket(personal);
assert.equal(match?.kind, 'personal');
assert.match(match?.evidenceHash || '', /^[a-f0-9]{64}$/);
assert.equal(JSON.stringify(match).includes('fixture'), false);
```

Assert `null` for wrong app type, host, path, `msgtype`, `channelid`, missing `sendid`, URL credentials, HTTP, malformed XML, transfer cards, refund notices, literal “红包” text, and marketing mini-program cards.

**Step 2: Run the test and confirm the module is missing**

Run: `node src/wechat-red-packet.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Implement the smallest strict parser**

Export one pure function. Bound input to 80 KB, parse the URL with `new URL()`, compare the exact host/path/query, and return only safe evidence:

```js
export function classifyPersonalWeChatRedPacket(xml) {
  const source = String(xml || '').slice(0, 80_000);
  if (Number(xmlTag(source, 'type')) !== 2001) return null;
  if (!/微信红包/u.test(`${xmlTag(source, 'title')} ${xmlTag(source, 'des')}`)) return null;
  let url;
  try { url = new URL(xmlTag(source, 'url')); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  if (url.hostname !== 'wxapp.tenpay.com') return null;
  if (url.pathname !== '/mmpayhb/wxhb_personalreceive') return null;
  if (url.searchParams.get('msgtype') !== '1') return null;
  if (url.searchParams.get('channelid') !== '1') return null;
  if (!url.searchParams.get('sendid')) return null;
  return { kind: 'personal', evidenceHash: sha256(source) };
}
```

Do not export payment-field helpers or return extracted payment values.

**Step 4: Run and commit**

Run: `node src/wechat-red-packet.test.mjs && node --check src/wechat-red-packet.mjs`

Expected: `WECHAT_RED_PACKET_TEST_OK` and exit 0.

```bash
git add src/wechat-red-packet.mjs src/wechat-red-packet.test.mjs
git commit -m "feat: classify personal WeChat red packets"
```

### Task 2: Normalize real cards without leaking payment data

**Files:**
- Modify: `src/im-channels.mjs:696-924`
- Modify: `src/im-channels.test.mjs:714-1360`

**Step 1: Add failing webhook normalization tests**

Add GeWe v1 and v2 p2p fixtures with app type `2001`. Assert:

```js
assert.equal(payload.message.message_type, 'red_packet');
assert.equal(JSON.parse(payload.message.content).text, '[微信红包]');
assert.deepEqual(Object.keys(payload.metadata.redPacket).sort(), ['evidenceHash', 'kind']);
assert.equal(JSON.stringify(payload).includes('sendid='), false);
```

Add group-card, self-activity, type 5 link, transfer, wrong host/path/query, text-only, and malformed cases. A group card may follow ordinary group handling, but must not expose `metadata.redPacket` or `message_type='red_packet'`.

**Step 2: Confirm the expectations fail**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because app type `2001` currently normalizes to empty text/null.

**Step 3: Wire the classifier into `geWeAppMessage`**

Import Task 1. Promote a match only when `group === false`, `isSelf === false`, and sender/message IDs exist:

```js
const personalRedPacket = !group && !isSelf ? appMessage?.redPacket : null;
// ...
message_type: personalRedPacket ? 'red_packet' : existingMessageType,
content: JSON.stringify({ text: personalRedPacket ? '[微信红包]' : String(text) }),
// ...
...(personalRedPacket ? { redPacket: personalRedPacket } : {}),
```

Do not copy the raw XML or URL into the normalized red-packet payload.

**Step 4: Run focused regressions and commit**

Run: `node src/wechat-red-packet.test.mjs && node src/im-channels.test.mjs && node src/quoted-reply.test.mjs`

Expected: all exit 0.

```bash
git add src/im-channels.mjs src/im-channels.test.mjs
git commit -m "feat: normalize WeChat red packet cards"
```

### Task 3: Add the disabled-by-default configuration contract

**Files:**
- Modify: `src/config.mjs:227-264`
- Modify: `src/config.test.mjs`
- Modify: `config.example.json:52-70`
- Modify: `config.distribution.json`

**Step 1: Add failing config assertions**

```js
assert.equal(config.wechatP2pRedPacketGateEnabled, false);
assert.equal(config.wechatP2pRedPacketGateThreshold, 30);
```

Cover explicit enablement, valid thresholds `1` and `100`, and rejection of `0`, `101`, fractions, and numeric strings.

**Step 2: Run and confirm failure**

Run: `node src/config.test.mjs`

Expected: FAIL because the keys do not exist.

**Step 3: Implement the fields**

```js
wechatP2pRedPacketGateEnabled: raw.wechatP2pRedPacketGateEnabled === true,
wechatP2pRedPacketGateThreshold: boundedInteger(raw.wechatP2pRedPacketGateThreshold, {
  name: 'wechatP2pRedPacketGateThreshold', fallback: 30, min: 1, max: 100,
}),
```

Set both example/distribution configs to `false` and `30`. Do not add a daily reset setting.

**Step 4: Run and commit**

Run: `node src/config.test.mjs && node scripts/distribution-default-safety.test.mjs`

Expected: both exit 0 and distribution stays disabled by default.

```bash
git add src/config.mjs src/config.test.mjs config.example.json config.distribution.json
git commit -m "feat: configure WeChat token gate"
```

### Task 4: Persist lifetime counts, unlock evidence, state, and delivery claims

**Files:**
- Modify: `src/state.mjs:71-568`
- Modify: `src/state.mjs:613-664`
- Modify: `src/state.test.mjs`

**Step 1: Write migration and transaction tests**

Use temporary SQLite files. Cover fresh and legacy databases. Assert:

- construction adds `has_sent_red_packet`, `red_packet_first_seen_at`, and `red_packet_source_message_id` without losing old rows;
- `recordWeChatP2pReply` inserts once by inbound message ID and increments exactly once;
- `markWeChatRedPacketSeen` preserves the earliest timestamp/evidence and permanently returns true;
- gate state starts `active`, uses threshold 30, and never references a day;
- claiming request/refusal/unlock delivery is unique by `(source_message_id, action)`;
- confirmed send advances state, definite failure allows retry, and `ambiguous` prevents automatic replay;
- deleting a relationship explicitly deletes its gate/ledger/delivery rows in the existing transaction.

**Step 2: Run and confirm failure**

Run: `node src/state.test.mjs`

Expected: FAIL because the schema and APIs are absent.

**Step 3: Add schema and forward-only migration**

Extend `relationship_person` and create:

```sql
CREATE TABLE IF NOT EXISTS wechat_p2p_token_gate (
  person_id TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'payment_requested', 'blocked')),
  reply_count INTEGER NOT NULL DEFAULT 0 CHECK (reply_count >= 0),
  threshold INTEGER NOT NULL DEFAULT 30 CHECK (threshold BETWEEN 1 AND 100),
  payment_request_source_message_id TEXT NOT NULL DEFAULT '',
  payment_requested_at TEXT NOT NULL DEFAULT '',
  blocked_source_message_id TEXT NOT NULL DEFAULT '',
  blocked_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wechat_p2p_reply_ledger (
  message_id TEXT PRIMARY KEY,
  person_id TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS wechat_p2p_reply_person
  ON wechat_p2p_reply_ledger(person_id, sent_at);
CREATE TABLE IF NOT EXISTS wechat_p2p_gate_delivery (
  source_message_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('payment_request', 'block_notice', 'unlock_ack')),
  status TEXT NOT NULL CHECK (status IN ('claimed', 'sent', 'failed', 'ambiguous')),
  provider_message_id TEXT NOT NULL DEFAULT '',
  error_code TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(source_message_id, action)
);
```

Use `PRAGMA table_info(relationship_person)` plus `ALTER TABLE` for the three legacy columns.

**Step 4: Implement narrow state APIs**

Use `BEGIN IMMEDIATE` transactions for mutations:

```js
weChatP2pGate(personId, threshold = 30)
recordWeChatP2pReply({ messageId, personId, sentAt, threshold })
markWeChatRedPacketSeen({ personId, messageId, seenAt })
claimWeChatP2pGateDelivery({ sourceMessageId, personId, action })
finishWeChatP2pGateDelivery({ sourceMessageId, action, outcome, providerMessageId, errorCode })
listWeChatP2pGates({ limit = 500 } = {})
weChatP2pGateSummary()
```

`recordWeChatP2pReply` inserts the ledger first and increments only when `changes === 1`. `markWeChatRedPacketSeen` keeps the earliest evidence and never changes `1` back to `0`. Return camelCase objects so runtime and Dashboard do not issue SQL.

**Step 5: Run and commit**

Run: `node src/state.test.mjs`

Expected: exit 0 with migration and idempotency cases passing.

```bash
git add src/state.mjs src/state.test.mjs
git commit -m "feat: persist WeChat token gate state"
```

### Task 5: Encode the gate as a pure policy

**Files:**
- Create: `src/wechat-p2p-token-gate.mjs`
- Create: `src/wechat-p2p-token-gate.test.mjs`

**Step 1: Write the failing transition table**

| Input | Expected action |
| --- | --- |
| feature disabled | `continue` |
| non-WeChat or group | `continue` |
| owner/self/system/`gh_` | `continue`, exempt |
| valid first card in any state | `unlock` |
| already unlocked | `continue` |
| count 0–29, `active` | `continue` |
| count 30+, `active` | `request_payment` |
| `payment_requested`, normal message | `block_notice` |
| `blocked`, normal message | `suppress` |
| literal “红包” text | state-based action, never `unlock` |

Test thresholds `3` and `30` to prove there is no hard-coded date/reset logic.

**Step 2: Run and confirm failure**

Run: `node src/wechat-p2p-token-gate.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Implement constants and decision function**

```js
export const PAYMENT_REQUEST_TEXT = '老板，我这边没 token 了，能不能发个小红包，给我续点 token 花一花？';
export const BLOCK_NOTICE_TEXT = '红包都不发一个，不想跟你聊了，太浪费 token 了。';
export const UNLOCK_TEXT = '红包收到啦，token 续上了，继续聊 😄';

export function decideWeChatP2pTokenGate(input) {
  // Return { applies, action, reason, exempt }; perform no I/O.
}
```

Normalize IDs once and compare external WeChat IDs against `geweOwnerWxids`. Never use display names for exemption.

**Step 4: Run and commit**

Run: `node src/wechat-p2p-token-gate.test.mjs && node --check src/wechat-p2p-token-gate.mjs`

Expected: exit 0.

```bash
git add src/wechat-p2p-token-gate.mjs src/wechat-p2p-token-gate.test.mjs
git commit -m "feat: define WeChat token gate policy"
```

### Task 6: Build an idempotent historical backfill

**Files:**
- Create: `src/wechat-p2p-token-gate-backfill.mjs`
- Create: `src/wechat-p2p-token-gate-backfill.test.mjs`
- Create: `scripts/backfill-wechat-p2p-token-gate.mjs`
- Modify: `package.json`

**Step 1: Write fixture-database tests**

Include duplicate `message_replied` audits, 30 distinct p2p replies, group/owner/self/system/`gh_` rows, one legacy personal card, false positives, and malformed payloads. Assert dry run changes nothing; first apply creates exact counts/evidence; second apply changes zero rows; output contains no raw URL or payment identifier.

**Step 2: Run and confirm failure**

Run: `node src/wechat-p2p-token-gate-backfill.test.mjs`

Expected: FAIL because the module is missing.

**Step 3: Implement the shared backfill service**

Join `audit.event='message_replied'` to `inbound_message` by message ID, parse stored payloads defensively, and accept only WeChat p2p rows. Support new `metadata.redPacket` and legacy raw XML locations through Task 1. Do not infer cards from text.

Wrap apply mode in one `BEGIN IMMEDIATE` transaction and store a version marker:

```js
state.set('migration', 'wechat_p2p_token_gate_v1', {
  completedAt, replyRows, redPacketPeople, threshold: 30,
});
```

Re-running must report current facts without duplicates.

**Step 4: Add a safe CLI**

Support only explicit DB paths and default to dry run:

```text
node scripts/backfill-wechat-p2p-token-gate.mjs --db <path> --threshold 30 --dry-run
node scripts/backfill-wechat-p2p-token-gate.mjs --db <path> --threshold 30 --apply
```

Print one scrubbed JSON summary. Add `wechat-token-gate:backfill` to `package.json` without embedding a production path.

**Step 5: Run and commit**

Run: `node src/wechat-p2p-token-gate-backfill.test.mjs && node --check scripts/backfill-wechat-p2p-token-gate.mjs`

Expected: exit 0; second apply is a no-op.

```bash
git add src/wechat-p2p-token-gate-backfill.mjs src/wechat-p2p-token-gate-backfill.test.mjs \
  scripts/backfill-wechat-p2p-token-gate.mjs package.json
git commit -m "feat: backfill WeChat token gate history"
```

### Task 7: Enforce before expensive work and account once

**Files:**
- Create: `src/wechat-p2p-token-gate-runtime.mjs`
- Create: `src/wechat-p2p-token-gate-runtime.test.mjs`
- Modify: `src/reply-routing.mjs:26-34`
- Modify: `src/reply-routing.test.mjs`
- Modify: `src/index.mjs:946-999`
- Modify: `src/index.mjs:3219-3282`
- Modify: `src/index.mjs:4982-5001`
- Modify: `src/mechanism-acceptance.test.mjs`

**Step 1: Write runtime tests with spies**

Assert replies 1–30 continue and count once; opportunity 31 sends only the payment request with zero AI calls; the next non-card sends only the refusal; later messages remain silent; valid cards unlock from all states; duplicates do not resend; exempt/disabled paths do not touch storage; gate messages use `{ tokenGateAccounting: false }`; suppressed sends do not count; definite failures allow retry; ambiguous sends are never replayed.

**Step 2: Run and confirm failure**

Run: `node src/wechat-p2p-token-gate-runtime.test.mjs`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

**Step 3: Implement a dependency-injected controller**

Return `{ handled, action }`. Claim a delivery before calling `send`, record provider message ID on success, advance state only after confirmed success, and audit only safe source/person hashes, counts, and states. A suppressed decision writes `wechat_p2p_gate_suppressed` and returns handled without calling send.

Do not import AI, web-reader, media, or relationship-memory modules into the controller.

**Step 4: Put source IDs in reply context**

Extend `createReplyContext` with `messageId` and `senderId`. Assert AsyncLocalStorage stays scoped to the active inbound and background jobs receive no accounting context.

**Step 5: Call the controller immediately after `message_received`**

Invoke it in `processIncoming` after IDs are parsed and receipt is audited, before owner consultation, group policy, relationship recall, article reading, media resolution, approval flows, and AI. Owners are exempt, so owner consultation continues unchanged. When handled, return; `processStoredInbound` then completes the inbound, including silent suppression.

**Step 6: Account in the common send path**

After a successful, non-suppressed `sendTextUnchecked`, inspect reply context. For an eligible WeChat p2p turn with `options.tokenGateAccounting !== false`, call `recordWeChatP2pReply` using the inbound message ID. The ledger makes multiple sends in one turn count once. Keep `message_replied` for compatibility/reporting, but use the ledger for future decisions.

**Step 7: Add source acceptance assertions**

In `mechanism-acceptance.test.mjs`, assert controller invocation precedes representative expensive handlers and all three gate messages explicitly disable accounting.

**Step 8: Run and commit**

```bash
node src/wechat-p2p-token-gate.test.mjs
node src/wechat-p2p-token-gate-runtime.test.mjs
node src/reply-routing.test.mjs
node src/state.test.mjs
node src/mechanism-acceptance.test.mjs
```

Expected: all exit 0; spies show zero AI calls on request, refusal, and suppression paths.

```bash
git add src/wechat-p2p-token-gate-runtime.mjs src/wechat-p2p-token-gate-runtime.test.mjs \
  src/reply-routing.mjs src/reply-routing.test.mjs src/index.mjs src/mechanism-acceptance.test.mjs
git commit -m "feat: enforce WeChat red packet token gate"
```

### Task 8: Show the lifetime roster and ambiguous sends in Dashboard

**Files:**
- Modify: `src/dashboard-server.mjs:122-244`
- Modify: `src/dashboard-server.mjs:429-564`
- Modify: `src/dashboard-server.mjs:1198-1201`
- Create: `src/wechat-p2p-token-gate-dashboard.test.mjs`
- Modify: `dashboard/index.html`
- Modify: `dashboard/app.js:369-455`
- Modify: `dashboard/styles.css`
- Modify: `dashboard/i18n.js`
- Modify: `dashboard/i18n.test.mjs`
- Modify: `dashboard/visual-contract.test.mjs`

**Step 1: Write failing projection and DOM tests**

Assert summary fields `enabled`, `threshold`, `people`, `repliedPeople`, `thresholdPeople`, `unlockedPeople`, `paymentRequestedPeople`, `blockedPeople`, and `ambiguousDeliveries`. Rows contain display name, stable person ID, reply count, state, card-observed boolean, and update time; order by count then last seen; cap at 500. Assert responses exclude payloads, raw XML, URLs, `sendid`, signatures, and audit detail.

Add required DOM IDs for summary and table to `dashboard/visual-contract.test.mjs` first.

**Step 2: Confirm failure**

Run: `node src/wechat-p2p-token-gate-dashboard.test.mjs && node dashboard/visual-contract.test.mjs`

Expected: FAIL because projection and DOM are absent.

**Step 3: Add read-only status and roster APIs**

Add a compact gate summary to `collectStatus()` and register `GET /api/wechat/p2p-token-gate` beside `/api/status`. Open SQLite read-only, return a bounded list, and return an unavailable shape before migration. The route performs no mutation and exposes no session token.

**Step 4: Render the roster**

Add four summary metrics plus a responsive table with localized labels for lifetime replies, state, card observed, and last update. Mark ambiguous delivery count as attention required. Keep rollout as an operator config action.

**Step 5: Run and commit**

```bash
node src/wechat-p2p-token-gate-dashboard.test.mjs
node dashboard/i18n.test.mjs
node dashboard/visual-contract.test.mjs
node src/dashboard-api-security.test.mjs
node --check src/dashboard-server.mjs
node --check dashboard/app.js
```

Expected: all exit 0.

```bash
git add src/dashboard-server.mjs src/wechat-p2p-token-gate-dashboard.test.mjs \
  dashboard/index.html dashboard/app.js dashboard/styles.css dashboard/i18n.js \
  dashboard/i18n.test.mjs dashboard/visual-contract.test.mjs
git commit -m "feat: show WeChat token gate roster"
```

### Task 9: Run the full verification and privacy matrix

**Files:**
- Modify: `package.json`
- Create: `docs/testing/2026-09-09-wechat-p2p-red-packet-token-gate.md`

**Step 1: Add `test:wechat-token-gate`**

Run classifier, normalizer, state, backfill, policy, runtime, Dashboard, and mechanism tests in deterministic order.

**Step 2: Run focused and broad checks**

```bash
npm run test:wechat-token-gate
npm run check
npm test
git diff --check
```

Expected: all exit 0. Fix regressions without weakening assertions.

**Step 3: Scan payment-data boundaries**

```bash
rg -n "sendid|wxhb_personalreceive|tenpay|sign=|amount" \
  src dashboard scripts --glob '!*.test.mjs'
```

Expected: only strict classifier constants/path checks appear. No audit, Dashboard projection, relationship method, or prompt contains payment data.

**Step 4: Record and commit evidence**

Document commands/results, synthetic card fixtures, and the current-history limitation.

```bash
git add package.json docs/testing/2026-09-09-wechat-p2p-red-packet-token-gate.md
git commit -m "test: verify WeChat token gate"
```

### Task 10: Backfill and release with rollback

**Files:**
- Modify after tests: `~/Library/Application Support/AIPRO/config.local.json`
- Read/back up: `~/Library/Application Support/AIPRO/data/agent-state.sqlite`
- Create: `docs/operations/wechat-p2p-red-packet-token-gate-runbook.md`

**Step 1: Capture and back up production**

Record the resolved `current` symlink, service PID/health, DB checksum, and config checksum. Make consistent timestamped database and config backups. Never edit the live release in place.

**Step 2: Build a clean release from the tested commit**

Create a timestamped directory under `~/Library/Application Support/AIPRO/releases/`. Copy only production files selected from the tested commit/distribution manifest. Preserve shared data/config paths and verify no unrelated dirty-worktree file entered the release.

**Step 3: Dry-run backfill while disabled**

```bash
node scripts/backfill-wechat-p2p-token-gate.mjs \
  --db "$HOME/Library/Application Support/AIPRO/data/agent-state.sqlite" \
  --threshold 30 --dry-run
```

Reconcile against the 2026-09-09 baseline: 141 p2p people, 91 with successful replies, 7 at or above 30, 1 owner exemption, 1 service-account exemption among those 7, 1 already-unlocked person among those 7, and 4 human contacts awaiting a future natural inbound. Explain any delta using new live rows; do not force old numbers.

**Step 4: Apply and prove idempotency**

Run `--apply`, then `--dry-run` and `--apply` again. The second apply must create zero ledger/evidence rows. Query the migration marker, counts, threshold distribution, and unlocked relationships; scan stored rows for forbidden payment strings. No outbound send may occur.

**Step 5: Switch the release with the flag still off**

Atomically repoint `current`, restart with `zsh scripts/install-service.sh`, run `npm run health`, inspect `/api/status`, and verify WeChat, DingTalk, and all enabled IM channels retain their prior health. Check schema startup and Dashboard roster. No contact should receive a message.

**Step 6: Enable threshold 30 and restart once**

Set:

```json
"wechatP2pRedPacketGateEnabled": true,
"wechatP2pRedPacketGateThreshold": 30
```

Validate config, restart, and verify Dashboard shows enabled/30. Wait for natural inbound; do not send production test messages to contacts.

**Step 7: Observe first natural transitions**

For the first request, refusal, suppression, and unlock, verify completed inbound state, zero AI/web/media work on handled paths, one delivery-ledger row, unchanged count for gate text, permanent red-packet flag, normal handling after unlock, and no payment data in logs/audit/Dashboard.

**Step 8: Document rollback and commit**

Rollback order:

1. disable the feature flag and restart for behavior faults;
2. atomically repoint `current` to the prior release and restart for runtime faults;
3. retain additive SQLite tables/columns because prior code ignores them;
4. restore DB backup only for proven migration corruption, after stopping services and preserving the failed DB.

```bash
git add docs/operations/wechat-p2p-red-packet-token-gate-runbook.md
git commit -m "docs: add WeChat token gate runbook"
```

## Completion evidence

- Focused tests, `npm run check`, and `npm test` pass from the tested commit.
- Production dry-run and apply reconcile to the fresh database; repeated apply changes zero rows.
- Feature is enabled at 30 and no daily reset field or job exists.
- Dashboard lists every current p2p person with lifetime count, state, card-observed status, and update time.
- Enabled IM channels remain healthy after the atomic release switch.
- Gate audits contain no payment URL, token, signature, `sendid`, or amount.
- Release pointer, backups, test evidence, and rollback commands are recorded.
