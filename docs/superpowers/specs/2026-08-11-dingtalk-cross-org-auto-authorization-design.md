# DingTalk Cross-Organization Auto-Authorization Design

## Goal

Restore the digital human's intended personal-DingTalk behavior: when live conversation-history reading is rejected with `CrossOrgPermissionDenied`, automatically request all-target-organization chat data access through the configured DWS Channel, retry the original history read, and continue the normal grounded reply.

## Confirmed Existing Capability

- GitHub commit `16cef8ef029219ac892ca611b759275eabbbb49c` added `dingtalkChannel` and injects it as `DWS_CHANNEL` into every DWS subprocess. The current local branch already contains this commit.
- The configured runtime uses the independent DWS binary, profile, Channel, and `event-stream` transport. These values remain the only execution context for history reads and authorization.
- Installed DWS v1.0.56 provides `dws chat data-auth cross-org --all --grant-type timed --ttl 24h`, which maps to `scope=chat.data:cross-org`, `grantCategory=data`, and `grantParams={"targetOrgId":"*"}`.
- The current missing link is automatic invocation: `ConversationContextClient` wraps the provider rejection as `CONVERSATION_HISTORY_UNAVAILABLE` without requesting access or retrying.

## Behavior

`ConversationContextClient.fetch()` keeps the existing validation and successful-history path. After the first history command returns valid JSON:

1. If the provider response is not a cross-organization permission denial, retain the existing behavior and never request access.
2. If the provider response contains the exact provider code or marker `CrossOrgPermissionDenied`, execute the following through the same injected runner, binary, working directory, environment, profile, and `DWS_CHANNEL`:

   ```text
   chat data-auth cross-org --all --grant-type timed --ttl 24h --format json --profile "$CONFIGURED_DINGTALK_PROFILE" -y
   ```

3. Validate that the authorization subprocess returns valid success JSON. Do not treat an exit, parse, or provider error as a grant.
4. Retry the original history command exactly once. The retried response must pass all existing message-list and current-target validation before AI generation.
5. If authorization or the single retry fails, throw `ConversationHistoryError` and retain the normal inbound retry/final-failure handling. Never loop authorization attempts inside one fetch.

Concurrent cross-organization failures on the same client share one in-flight authorization promise. Each waiting history request performs its own single read retry after the shared grant settles.

## Observability and Privacy

Add metadata-only audit events:

- `conversation_cross_org_authorization_requested`
- `conversation_cross_org_authorization_granted`
- `conversation_cross_org_authorization_failed`

Audit details contain duration and error category only. They must not contain message bodies, conversation IDs, target organization IDs, profile values, Channel values, credentials, or provider response bodies.

## Scope

Modify only:

- `src/conversation-context-client.mjs`
- `src/conversation-context-client.test.mjs`
- mechanism acceptance documentation/test only if the existing suite needs an explicit contract count update

Do not add a local-history fallback, change the DWS Channel, use another DWS installation, remove communication blocklist entries, merge GitHub `origin/main`, or alter unrelated dirty files.

## Verification

Automated tests must prove:

- exact cross-organization denial causes read -> all-organization timed grant -> one read retry -> normalized history success;
- grant and retry receive the original DWS environment, including the configured Channel;
- unrelated provider errors never request cross-organization access;
- rejected authorization does not retry history and fails closed;
- concurrent failures share one grant;
- targeted tests, the repository test suite, static checks, and `git diff --check` pass.

Live verification may execute the same all-organization timed grant through the configured Channel and then perform an actual business history read. A successful grant alone is not sufficient; the history read and runtime health must be read back separately.
