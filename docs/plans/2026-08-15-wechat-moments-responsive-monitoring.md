# WeChat Moments Responsive Monitoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect and answer new Moments comments within five minutes, with opportunistic scans on any personal-WeChat inbound message.

**Architecture:** Keep polling as the authoritative source because GeWe documents no Moments callback event. Add a cooldown/coalescing nudge API to the worker and invoke it from the GeWe webhook lifecycle without delaying normal message replies.

**Tech Stack:** Node.js ESM, GeWe webhook, SQLite-backed worker state, LaunchAgent.

---

### Task 1: Shorten the polling interval

**Files:**
- Modify: `src/config.test.mjs`
- Modify: `src/config.mjs`
- Modify: `config.example.json`
- Modify: `config.distribution.json`

1. Add a failing assertion for a 300,000 ms default.
2. Update defaults and examples to five minutes.
3. Run `node src/config.test.mjs`.

### Task 2: Add a coalesced inbound nudge

**Files:**
- Modify: `src/wechat-moments-engagement.test.mjs`
- Modify: `src/wechat-moments-engagement.mjs`

1. Add failing tests for stale-state triggering, 60-second cooldown and concurrent coalescing.
2. Implement `nudge(reason)` without blocking webhook processing.
3. Run the Moments worker tests.

### Task 3: Connect the webhook lifecycle

**Files:**
- Modify: `src/mechanism-acceptance.test.mjs`
- Modify: `src/index.mjs`

1. Add a failing mechanism assertion for an inbound nudge.
2. Invoke `nudge('wechat-inbound')` for accepted GeWe webhook events.
3. Run mechanism acceptance and full tests.
4. Restart the service, verify audit state, commit and push GitHub `main` when reachable.
