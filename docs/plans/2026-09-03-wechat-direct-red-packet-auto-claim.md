# WeChat Direct Red Packet Auto Claim Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Automatically claim ordinary one-to-one WeChat red packets while deterministically refusing every group, transfer, self-sent, ambiguous, or duplicate event.

**Architecture:** Extend GeWe normalization with a dedicated `red_packet` message type, route it before the normal AI inbox, and execute it through an isolated coordinator backed by persistent state. The coordinator resolves the sender display name and delegates to a fail-closed macOS UI adapter action that verifies a direct conversation, an unclaimed red-packet card, and the claim dialog before clicking.

**Tech Stack:** Node.js ES modules, `node:sqlite`, GeWe Webhook, macOS JXA/System Events, existing Swift Vision helper, Node assert tests.

---

### Task 1: Normalize GeWe red-packet events

**Files:**
- Modify: `src/im-channels.mjs`
- Test: `src/im-channels.test.mjs`

**Step 1: Write failing tests**

Add v2 direct `RED_PACKET`, v2 group `RED_PACKET`, v2 `TRANSFER`, and v1 app-message red-packet fixtures. Assert direct and group packets normalize to `message_type: red_packet`, retain raw XML only in protected metadata, and preserve `p2p` versus `group`; assert transfers do not become red packets.

**Step 2: Run tests and verify failure**

Run: `node src/im-channels.test.mjs`

Expected: FAIL because `RED_PACKET` is currently not an accepted GeWe callback type.

**Step 3: Implement minimal normalization**

Accept explicit v2 `RED_PACKET`. For v1 `MsgType=49`, classify only XML with the native red-packet app subtype; never infer a packet from title text. Return safe text plus `metadata.redPacket` containing only the XML and original identifiers required for the UI handoff.

**Step 4: Run tests**

Run: `node src/im-channels.test.mjs`

Expected: PASS.

### Task 2: Add persistent claim state and coordinator policy

**Files:**
- Create: `src/wechat-red-packet-claim.mjs`
- Create: `src/wechat-red-packet-claim.test.mjs`
- Modify: `src/state.mjs`
- Modify: `src/state.test.mjs`

**Step 1: Write failing tests**

Cover direct-event acceptance, group hard rejection with zero UI calls, self/invalid rejection, duplicate idempotency, temporary retry, terminal not-claimable results, TTL, maximum attempts, and redacted audits.

**Step 2: Run tests and verify failure**

Run: `node src/wechat-red-packet-claim.test.mjs && node src/state.test.mjs`

Expected: FAIL because the coordinator and state methods do not exist.

**Step 3: Implement persistent state**

Add a `wechat_red_packet_claim` table keyed by message ID with chat type, hashed sender, status, attempts, timestamps, and bounded error reason. Add atomic create/claim/complete/fail/read methods.

**Step 4: Implement coordinator**

Validate `channel=wechat`, `message_type=red_packet`, `chat_type=p2p`, non-group target, and non-owner activity. Resolve contact details, claim a lease, call the UI adapter, map results to terminal/retry states, and emit redacted audits.

**Step 5: Run tests**

Run: `node src/wechat-red-packet-claim.test.mjs && node src/state.test.mjs`

Expected: PASS.

### Task 3: Add fail-closed macOS UI claiming action

**Files:**
- Modify: `src/wechat-poc/macos-ui-adapter.mjs`
- Modify: `src/wechat-poc/macos-ui-adapter.test.mjs`
- Modify: `scripts/wechat-poc-ui.jxa`
- Modify: `scripts/wechat-poc-vision.swift`

**Step 1: Write failing adapter tests**

Assert the adapter rejects group proofs before invoking JXA, accepts only fresh direct proofs, returns structured terminal versus retryable results, and never accepts caller-provided coordinates.

**Step 2: Run tests and verify failure**

Run: `node src/wechat-poc/macos-ui-adapter.test.mjs`

Expected: FAIL because `claimDirectRedPacket` does not exist.

**Step 3: Implement detection and protected clicks**

Extend the Vision helper output with bounded candidate controls/card rectangles derived from OCR and color/shape evidence. Add JXA `claim-direct-red-packet` which searches the target, verifies the selected telemetry proof, rejects any group marker or ambiguous header, clicks the newest unclaimed `微信红包` card, confirms the native claim dialog, clicks only its `开` control, and returns a structured status.

**Step 4: Implement adapter guard**

Expose `claimDirectRedPacket({ conversationTitle })`; acquire and verify a fresh direct selection proof, call the JXA action without coordinates, and normalize its result.

**Step 5: Run unit and type checks**

Run: `node src/wechat-poc/macos-ui-adapter.test.mjs && xcrun swiftc -parse-as-library -typecheck scripts/wechat-poc-vision.swift`

Expected: PASS.

### Task 4: Wire configuration and runtime routing

**Files:**
- Modify: `config.example.json`
- Modify: `src/config.mjs`
- Modify: `src/config.test.mjs`
- Modify: `src/config-assistant.mjs`
- Modify: `src/index.mjs`
- Test: `src/wechat-red-packet-claim.test.mjs`

**Step 1: Write failing configuration and routing tests**

Assert the feature defaults off, validates attempts/TTL bounds, is treated as a protected configuration mutation, and a red-packet Webhook bypasses `enqueueInbound` and the AI reply path.

**Step 2: Run tests and verify failure**

Run: `node src/config.test.mjs && node src/wechat-red-packet-claim.test.mjs`

Expected: FAIL because the configuration and runtime route are absent.

**Step 3: Implement configuration**

Add `geweDirectRedPacketAutoClaimEnabled`, `geweDirectRedPacketClaimMaxAttempts`, and `geweDirectRedPacketClaimTtlMs`, all with bounded validation. Keep the example default disabled and require double confirmation through Configuration Copilot.

**Step 4: Wire runtime**

Instantiate the UI adapter and coordinator only when GeWe and the feature are enabled. In the Webhook handler, route `red_packet` to the coordinator before normal inbound enqueueing; never enqueue group red packets or feed them to AI. Await through a serialized queue without delaying the Webhook response.

**Step 5: Run tests**

Run: `node src/config.test.mjs && node src/wechat-red-packet-claim.test.mjs && node src/im-channels.test.mjs`

Expected: PASS.

### Task 5: Verify and enable locally

**Files:**
- Modify: `config.local.json` (local-only, not committed)
- Modify: `package.json`

**Step 1: Add targeted test to the main test command**

Add `node src/wechat-red-packet-claim.test.mjs` adjacent to the other WeChat tests.

**Step 2: Run targeted regression**

Run: `node src/im-channels.test.mjs && node src/wechat-red-packet-claim.test.mjs && node src/wechat-poc/macos-ui-adapter.test.mjs && node src/config.test.mjs && node src/state.test.mjs`

Expected: PASS.

**Step 3: Run syntax and full regression checks**

Run: `npm run check`

Expected: PASS.

Run: `npm test`

Expected: PASS, or report pre-existing unrelated failures separately with evidence.

**Step 4: Enable on this Mac**

Set `geweDirectRedPacketAutoClaimEnabled` to `true` in untracked/local configuration only after automated checks pass. Probe the UI adapter read-only; if permissions or the supported WeChat UI are unavailable, leave the feature configured but report the exact runtime prerequisite.

**Step 5: Commit implementation files**

Stage only files changed for this feature and commit with a focused message. Do not stage pre-existing workspace changes.

**Step 6: Live acceptance**

Have a test contact send a small direct red packet and confirm `claimed`; then send a group red packet and confirm `skipped_group` with no UI click. This step requires an external sender and is the only part that cannot be completed from deterministic fixtures alone.
