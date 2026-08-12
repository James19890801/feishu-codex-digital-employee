# AIPR0S Qoder Cloud Offline Failover Design

## 1. Outcome

AIPR0S remains local-first. The existing macOS LaunchAgent, direct DWS personal event stream, local SQLite inbox, and local AI CLI remain the primary path. Two bounded failover mechanisms are added:

1. **Local runtime failover:** while the Mac and AIPR0S service are alive, a text-only L0/L1 model call uses up to three local runtime attempts inside the existing total runtime timeout budget. Only a timeout, process failure, transport/network failure, or empty runtime response is retryable. After the third retryable failure, the sanitized prompt is sent through the Cloudflare gateway to a tool-free Qoder Cloud Agent.
2. **Whole-host failover:** the Mac sends a signed heartbeat every 30 seconds. After three missed heartbeats, Cloudflare acquires a new takeover generation and starts the standby DWS container. The container backfills at most three minutes of authorized-chat messages, then consumes live DWS events until the Mac has produced three consecutive healthy heartbeats and the cloud worker has drained its in-flight work.

Business validation failures, permission denial, owner-confirmation requirements, answer-quality dissatisfaction, malformed structured business output, and prohibited data do not increment the runtime failure count and do not cause cloud execution.

## 2. Non-goals

- The cloud path does not replace the direct local DWS channel during normal operation.
- The cloud path does not execute L2 writes or L3 high-risk actions.
- The cloud path does not read mail, DingTalk documents, local files, attachments, images, repository worktrees, local memory databases, or local Wiki content.
- The cloud path does not use Qoder tools, MCP servers, Vaults, Skills, Memory Stores, repository resources, or environment credentials.
- The implementation does not copy the local DWS Profile, Channel, OAuth state, keychain material, `config.local.json`, SQLite database, Persona files, or knowledge directories to the cloud.
- Qoder Deployments or cron jobs are not used as the inbound availability mechanism. Qoder is the reasoning plane, not the always-on gateway.

## 3. System boundaries

### 3.1 Local primary plane

The current `src/index.mjs` model-call boundary is retained. `runAiRuntime()` delegates to a new `LocalFirstRuntimeRouter` rather than invoking `AiRuntimeClient` directly.

The router receives:

- the selected local `AiRuntimeClient`;
- a `CloudFailoverClient` that calls Cloudflare, not Qoder directly;
- a retry classifier;
- a cloud eligibility policy;
- audit and health callbacks.

For each call, the router divides the caller-provided `timeoutMs` into three bounded attempts. With the current 120-second default, each attempt receives 40 seconds. Retry backoff is one second and two seconds, but the overall call never exceeds the original timeout plus five seconds of process termination grace. A local success resets the per-call attempt count. Attempts are not accumulated across unrelated messages.

Startup probes, multimodal calls, any call containing local image paths, and calls marked cloud-ineligible never leave the Mac. They retain the existing single-runtime behavior.

The local service also starts a `FailoverHeartbeat` loop after SQLite and the DWS channel are initialized. Every 30 seconds it sends metadata only:

- installation-scoped `nodeId`;
- monotonic heartbeat sequence;
- UTC timestamp;
- local service start identifier;
- local DWS connected flag;
- local runtime healthy flag;
- latest locally completed DingTalk message ID hash;
- application version and protocol version.

No message body, prompt, chat title, person name, local path, credential, or conversation history appears in a heartbeat.

### 3.2 Cloudflare control plane

`cloud-failover/worker` is a Cloudflare Worker with a single SQL-backed Durable Object named `FailoverCoordinator`. The public Worker validates every local request with HMAC-SHA256 over method, path, timestamp, nonce, and body SHA-256. Timestamps outside 90 seconds and reused nonces are rejected.

The Durable Object owns the authoritative failover state:

- `LOCAL_PRIMARY`
- `TAKING_OVER`
- `CLOUD_ACTIVE`
- `DRAINING`
- `DEGRADED`

It persists the current generation, last accepted heartbeat, consecutive healthy recovery heartbeats, cloud-container readiness, in-flight claims, message-ID digests, delivery outcomes, and bounded error summaries. It never persists message bodies or Qoder output.

A Durable Object Alarm is scheduled for the next 30-second evaluation. Alarm execution is treated as at-least-once: every transition is guarded by the current state and generation, and repeating an alarm cannot allocate a second generation or duplicate a message claim.

### 3.3 Cloudflare standby DWS container

`cloud-failover/container` is a Linux/amd64 Cloudflare Container built from a pinned Node image and `dingtalk-workspace-cli@1.0.56`. It is addressable by one deterministic container ID for this AIPR0S installation.

The container is stopped while state is `LOCAL_PRIMARY`. On `TAKING_OVER`, Cloudflare starts it with:

- an encrypted portable DWS auth bundle created from a separate, revocable, minimum-scope device-flow authorization;
- DWS built-in device OAuth by default, with an optional dedicated AppKey/AppSecret override supplied only as a complete pair;
- the Cloudflare coordinator internal URL and container credential;
- the current takeover generation;
- the allowed DingTalk chat IDs;
- the Qoder execution endpoint exposed internally by the Worker.

The local DWS Profile and Channel are not accepted as container inputs. The cloud authorization is created once with DWS 1.0.56 device login in an isolated `HOME`; DingTalk AppKey/AppSecret are optional and cannot replace personal login. At boot, the container writes the base64 bundle to a permission-0600 temporary file, runs `dws auth import --base64 --force`, validates a real `dws auth status`, and deletes the import file. Container disk is treated as ephemeral. Durable state belongs to the coordinator.

After DWS authentication and event-stream readiness, the container reports ready for its generation, performs a three-minute authorized-chat backfill, and starts live consumption. A message must pass sender/chat authorization and atomically obtain a `(generation, messageIdDigest)` claim before its body is used.

### 3.4 Qoder reasoning plane

The Worker owns `QODER_PAT`, `QODER_AGENT_ID`, and `QODER_ENVIRONMENT_ID` as Cloudflare secrets. The PAT is never returned to the local app or container.

The Worker creates a new Qoder Session for each eligible task using the pre-created tool-free Agent and Environment. It sends one sanitized `user.message`, consumes the SSE stream until `session.status_idle`, and extracts the final `agent.message`. It archives the Session after recording the terminal outcome. It handles 429, 503, and other 5xx responses with one-, two-, and four-second exponential backoff. Other 4xx responses fail closed without blind retry.

The Qoder Agent has no tools, repository resource, Vault, Memory Store, Skill, MCP server, file upload, or environment variables. Its system instruction allows concise L0/L1 assistance and requires refusal/owner handoff for L2/L3 work.

## 4. Data policy

### 4.1 Cloud eligibility

Only text-only L0/L1 work is cloud eligible. The request is rejected before transmission when it contains or references:

- an attachment or image path;
- an email body or mail-write flow;
- DingTalk document content;
- a local file or repository excerpt;
- a pending confirmation token;
- a mutation execution intent;
- credential-like values, authorization headers, private keys, verification codes, or secrets;
- an L2 or L3 decision;
- an unapproved chat or sender;
- more than the configured 24,000-character sanitized prompt limit.

### 4.2 Sanitization

The cloud sanitizer removes absolute local paths, credential-like text, URL query strings, owner phone numbers, internal authentication metadata, DWS Profile/Channel values, and previous tool traces. It preserves only the minimum identity, response style, safety boundary, current user instruction, and bounded current-conversation context required for a useful reply.

The sanitizer produces a SHA-256 digest for audit correlation. Audit records contain the digest, byte count, eligibility decision, runtime, generation, latency, attempt count, and terminal error code. They contain no prompt or answer text.

### 4.3 Retention

Cloudflare Durable Object storage contains no message or answer bodies. Container stdout/stderr uses structured metadata and error codes only. Worker request logging must not log request bodies or authorization headers. Qoder Sessions are archived immediately after terminal completion; the product documentation explicitly states that archive is not a cryptographic deletion guarantee and cloud-eligible content is transmitted to Qoder.

## 5. Failure and recovery behavior

### 5.1 Local runtime call failure

1. Try the selected local runtime up to three times within the original total timeout budget.
2. Stop retrying immediately on a non-runtime/business error.
3. After the third retryable failure, evaluate cloud eligibility.
4. If ineligible, return a safe local error and record why cloud execution was blocked.
5. If eligible, call the signed Cloudflare runtime endpoint.
6. If Cloudflare or Qoder fails, return a bounded unavailable message; do not switch channels or execute a mutation.
7. A later request starts local-first again. The cloud result does not permanently change `aiRuntime`.

### 5.2 Whole-host takeover

1. Heartbeat age crosses 90 seconds after three expected intervals.
2. The coordinator atomically increments the generation and enters `TAKING_OVER`.
3. It starts the deterministic standby container.
4. Container readiness moves the state to `CLOUD_ACTIVE`.
5. The container backfills only the prior three minutes from authorized chats, claiming by message-ID digest.
6. New authorized messages are claimed, sanitized, classified, sent to Qoder, guarded, and replied with the visible prefix `【云端兜底】`.
7. L2/L3 messages receive an owner-confirmation handoff and no action is executed.

### 5.3 Local recovery

1. The recovered Mac resumes heartbeats with a new service-start identifier.
2. Three consecutive healthy heartbeats move cloud state to `DRAINING`.
3. `DRAINING` rejects new cloud claims but finishes already claimed messages.
4. The container publishes its last completed message-ID digest and stops.
5. The coordinator returns to `LOCAL_PRIMARY` only after in-flight count reaches zero or the drain timeout expires.
6. Local and cloud sends use the same stable UUID derived from channel and source message ID. If a network partition causes both sides to prepare the same reply, DWS idempotency and the cloud claim ledger provide two independent duplicate barriers.

### 5.4 Degraded modes

- Cloudflare unavailable while local works: local service continues; heartbeat failures are reported but never stop the local DWS path.
- Qoder unavailable during takeover: cloud sends at most one bounded fallback notice per chat per 15 minutes and keeps consuming/recording message-ID digests without storing bodies.
- Standby DWS authentication failure: coordinator enters `DEGRADED`, emits metadata-only health state, and does not substitute Wukong, desktop automation, or another personal profile.
- Container crash: the coordinator restarts the same generation with exponential backoff; already claimed messages remain claimed and require explicit reconciliation rather than blind replay.
- Cloudflare/Qoder credential missing: configuration validation fails closed before enabling failover.
- Recovery drain timeout: unresolved claims are marked ambiguous and are not automatically replayed locally.

## 6. Configuration and secret handling

Public, non-secret local configuration is added to `config.example.json`:

- `cloudFailoverEnabled`: default `false`;
- `cloudFailoverBaseUrl`: HTTPS origin with no credentials/query/fragment;
- `cloudFailoverNodeId`: installation-scoped public identifier;
- `cloudFailoverHeartbeatMs`: fixed default 30000, allowed 10000-60000;
- `cloudFailoverMissThreshold`: fixed default 3, allowed 2-10;
- `cloudFailoverRecoveryThreshold`: fixed default 3, allowed 2-10;
- `cloudFailoverLocalAttempts`: fixed default 3, allowed 1-3;
- `cloudFailoverMaxPromptChars`: default 24000, maximum 40000.

The local HMAC secret is read from macOS Keychain using a dedicated service/account and is never placed in JSON. Cloudflare stores the same HMAC secret and Qoder PAT/Agent/Environment IDs. Railway stores the independently authorized `DINGTALK_DWS_AUTH_BUNDLE_B64` and, only when explicitly used, a complete AppKey/AppSecret override pair. Secret templates contain names only. The bundle is produced only through the explicit cloud-credential provisioning flow; the implementation refuses a bundle exported from the configured local profile.

## 7. Observability

The local SQLite health scope and Dashboard add:

- configured/enabled state;
- current local runtime attempt and last local success;
- last heartbeat success/error;
- last observed cloud state and generation;
- last cloud fallback success/error;
- cloud-blocked reason counts;
- local-primary, cloud-active, draining, or degraded label.

Cloudflare exposes an authenticated metadata-only `/v1/status` response. It includes state, generation, heartbeat age, container readiness, in-flight count, last terminal error code, and protocol version. It never returns message identifiers, chat identifiers, prompts, answers, or credentials.

## 8. Deployment and compatibility

The feature lives on branch `codex/qoder-cloud-offline-failover` and is pushed to both `codeup` and `origin` after verification.

Cloudflare assets use a separate workspace package so the current Node application remains runnable without Wrangler. The root application remains compatible with Node `>=22.5.0`. The Worker uses the current Cloudflare compatibility date and SQL-backed Durable Objects. The container targets `linux/amd64` and pins DWS 1.0.56.

Cloud resources are provisioned only after explicit action-time approval because provisioning creates persistent external resources and secrets. Without credentials, the repository delivery remains fully testable through local Worker/Container fixtures and smoke-test commands, but live 7x24 availability is reported as not activated.

## 9. Verification and acceptance

Automated acceptance requires:

1. A failing-then-passing local router test for three retryable failures followed by one cloud call.
2. Tests proving non-runtime errors, images, files, L2/L3 work, secrets, and oversized prompts never call Cloudflare/Qoder.
3. HMAC tests for valid signatures, timestamp expiry, body tampering, and nonce replay.
4. Durable Object state tests for 89-second standby, 90-second takeover, at-least-once alarm replay, generation fencing, three-heartbeat recovery, and drain completion.
5. Claim-ledger tests proving one message is handled once across duplicate events, container restarts, and stale generations.
6. Qoder client tests for session creation, `user.message`, SSE assembly, terminal idle, archive, retryable 429/5xx, and fail-closed 4xx.
7. Container policy tests proving pinned DWS version, independent encrypted auth-bundle import, real auth-status gate, authorized-chat filtering, three-minute backfill, cloud reply label, and no local-profile input.
8. Dashboard/model tests for every failover state and redacted status output.
9. Distribution scans proving no PAT, AppSecret, local HMAC secret, profile, channel, prompt, or message body enters committed artifacts.
10. Root `npm test`, `npm run check`, Cloudflare worker tests/typecheck, container policy tests, and the updated mechanism-acceptance suite all pass.
11. With approved credentials, a live smoke test must prove Cloudflare heartbeat readback and one harmless `AIPR0S_CLOUD_OK` Qoder response. Whole-host DWS failover is not claimed live until a controlled local-service stop produces a cloud-labeled reply and local restart produces a duplicate-free handback.

## 10. Product promise

The user-facing promise is precise:

- **Implemented locally:** local runtime retries, cloud policy, signed heartbeat client, health reporting, and deployment assets.
- **Activated only after provisioning:** Cloudflare Worker, Durable Object, Container, independent DingTalk credential, and Qoder Agent/Environment/PAT.
- **7x24 verified only after live acceptance:** controlled whole-host stop, cloud reply, prolonged cloud-active message handling, and duplicate-free recovery.

No saved form, successful deploy command, green auth status, or Qoder connectivity test alone is presented as proof of 7x24 availability.
