# WeChat Aliyun Relay Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the production WeChat Railway → Cloudflare ingress, queue, and artifact path with a directly hosted relay on the existing Aliyun Hong Kong server, without changing the existing website or other channels.

**Architecture:** A Node HTTP service bound only to loopback implements the current relay HTTP contract. SQLite WAL stores queued callbacks transactionally; short-lived artifact files live in a private directory. An isolated Nginx virtual host and HTTPS certificate expose `wxrelay.e2eskill.cn`; the existing Mac relay agent and artifact bootstrap retain their contract and change only origin after staged tests.

**Tech Stack:** Node.js 22, SQLite, Nginx, systemd, Alibaba Cloud DNS, GeWe callback API, macOS LaunchAgents and Keychain.

---

### Task 1: Lock protocol and failure behavior

**Files:** `cloud-relay/aliyun/contract.test.mjs`, `cloud-relay/aliyun/server.mjs`, `cloud-relay/worker/src/core.mjs`, `cloud-relay/worker/src/contract.mjs`.

1. Write tests for health, canary, callback validation, duplicate digest, lease/ACK/status auth, expiry and oversize artifacts, and non-2xx storage failures. Reuse existing Worker test fixtures where possible.
2. Run `node --test cloud-relay/aliyun/contract.test.mjs`; expect failures due to missing implementation.
3. Implement the minimum compatible HTTP routing and error handling; never log callback body or auth headers.
4. Run focused tests and `node --check cloud-relay/aliyun/server.mjs`; expect all pass.
5. Commit only the new service and tests.

### Task 2: Durable SQLite queue and artifact store

**Files:** `cloud-relay/aliyun/store.mjs`, `cloud-relay/aliyun/store.test.mjs`, `cloud-relay/aliyun/server.mjs`.

1. Test atomic enqueue/dedup, ordering, lease expiry and redelivery, ACK deletion, restart persistence, bounded capacity, artifact TTL and cleanup.
2. Run `node --test cloud-relay/aliyun/store.test.mjs`; expect failures.
3. Implement a single SQLite writer with WAL and busy timeout; store artifacts via atomic rename outside the served website tree. Reject full disk/capacity with non-2xx and preserve upstream retry.
4. Re-run focused tests including forced process restart and temporary directories; expect pass.
5. Commit only store and tests.

### Task 3: Deployment package and operational controls

**Files:** `cloud-relay/aliyun/package.json`, `cloud-relay/aliyun/aipro-wechat-relay.service`, `cloud-relay/aliyun/nginx.conf.example`, `cloud-relay/aliyun/README.md`, `cloud-relay/aliyun/deploy.sh`.

1. Add static checks for loopback bind, secret-file permissions, Nginx hostname isolation, max body size, queue bounds, restart policy, and backup command.
2. Run static checks; expect failure before assets exist.
3. Add deploy assets using a dedicated service directory/user. Do not create or replace existing `aipro` PM2 process, default Nginx site, or website certificate.
4. Re-run checks and review `git diff --check`; expect pass.
5. Commit deployment assets only.

### Task 4: Aliyun staging deploy and public HTTPS

**Files:** Aliyun isolated `/opt/aipro-wechat-relay` and private `/var/lib/aipro-wechat-relay`; DNS record for `wxrelay.e2eskill.cn`; server's Nginx vhost.

1. Confirm instance renewal has moved expiry beyond the observation period, current website health, free disk/memory, and 80/443 occupancy. If not renewed, stage only; do not cut over.
2. Back up existing Nginx configuration and relevant server state. Deploy service with new secrets generated/transported through protected channels and no value in shell history or logs.
3. Start loopback service and verify `/healthz`, denied unauthenticated control calls, and local test callback/lease/ACK.
4. Add DNS A record and issue/install HTTPS certificate. Run `nginx -t`, reload (not restart), and verify the existing websites plus new relay origin.
5. Record staging verification without secrets.

### Task 5: End-to-end shadow validation and cutover

**Files:** production Mac LaunchAgent environment, GeWe registered callback, `outputs/` cutover receipt.

1. Record old callback URL, queue counts, process IDs, and rollback steps. Drain old Cloudflare queue to zero; do not delete records.
2. Run new relay agent in a controlled test mode against an isolated test callback; test backlog when paused, lease redelivery, local 202 delivery, ACK, duplicates, signed canary, and 25 MiB-bounded artifact upload/download/expiry.
3. Update Mac relay origin and artifact bootstrap, restart only affected LaunchAgents, and verify auth and health. Then update GeWe callback to the new HTTPS origin.
4. Verify provider callback readback, harmless live inbound/outbound, artifact, health samples, old/new queue counts, and no duplicate replies. If any critical check fails, restore both old origin and old GeWe callback and reconcile IDs.
5. Leave old relay dormant for the rollback window; report exact remaining Cloudflare dependency and any history-coverage gaps.

### Task 6: Monitoring, backup, and final verification

**Files:** `cloud-relay/aliyun/README.md`, operational receipt under `outputs/`.

1. Configure log rotation, database backup/restore drill, queue depth and disk alerts, certificate renewal check, and instance expiry reminder.
2. Verify fresh backups and restore to an isolated path, not the live database.
3. Run focused tests and root `npm run check`/`npm test` where proportionate; report any pre-existing failures separately.
4. Confirm existing website, WeChat and DingTalk services still healthy, no routine Railway/Cloudflare WeChat traffic, and no secrets in Git diff or receipt.
