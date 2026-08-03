# AIPRO Identity Narrative and Developer Contact Design

## Goal

Explain AIPRO's defining product capability—an AI agent operating through the owner's explicitly authorized real social identity—and give every user a clear, safe way to contact James Feng for an invitation code.

## Product narrative

The primary Chinese brand line is:

> 让智能，以你的身份在场。

The primary English brand line is:

> Your identity, intelligently present.

The factual product descriptor is:

> 基于本人授权的真实社交身份运行的 AI 数字人平台

> An AI agent platform that works through your authorized social identity.

Supporting copy explains that AIPRO connects only to accounts the owner authorizes, operates inside existing conversations and relationships, and preserves human control:

> 连接你已授权的飞书、钉钉与个人微信，让 AI 在真实关系和真实会话中理解请求、协同工作并及时回应。

> Connect AIPRO to the IM accounts you authorize, so it can understand requests, coordinate work, and respond within the conversations and relationships you already have.

The trust statement is mandatory on activation and product-information surfaces:

> 身份始终属于你，重要判断仍由你做。AIPRO 只在你明确授权的边界内行动。

> Your identity remains yours. Important decisions remain yours. AIPRO acts only within the boundaries you authorize.

The English interface uses **AI agent** for functional descriptions. It does not use the awkward phrase **real human identity** or imply that every optional channel has the same identity model. Channel-level descriptions continue to distinguish human-identity channels from official bot channels.

## Global contact entry

Every dashboard state has a small contact control beside the language control.

- An unlicensed installation labels it **Get an invitation / 获取邀请码**.
- A licensed installation labels it **Contact developer / 联系开发者**.
- The control opens a modal on desktop and a bottom sheet on narrow screens.
- It never navigates away from the activation form or operations console.
- It remains available when the core IM worker is stopped.

The contact surface identifies:

- James Feng（詹老师）
- Co-developer · Authorized invitation issuer
- 联合开发者 · 授权邀请码签发人

It instructs the user to scan with WeChat, add James, and send **AIPRO invitation / 申请 AIPRO 邀请码**. It also states that James will never request an account password, SMS verification code, device private key, or recovery key.

The dialog supports keyboard focus management, `Escape`, a visible close control, backdrop dismissal, localized labels, and a retry state when the contact card cannot be loaded.

## Contact-card delivery

James's WeChat contact card is not committed to the public Git repository. The image is stripped of metadata and stored as a private Cloudflare object. The current deployment uses Workers KV because R2 is not enabled on the Cloudflare account; the storage adapter can migrate to R2 later without changing the public endpoint. The activation Worker exposes a same-origin public read endpoint that streams only the configured contact-card object with a fixed media type, conservative cache policy, `nosniff`, and no namespace listing capability.

The dashboard requests the image only when the dialog opens. Failure to retrieve the image affects only the contact dialog. It must not affect activation status, the operations console, Feishu, DingTalk, personal WeChat, Multica, Codex, memory, queues, or audit.

The remote object can be replaced without publishing a new desktop build. The public route is intentionally readable because prospective users need it before activation, but keeping the object outside Git prevents permanent exposure in repository history and permits rotation.

## Activation and Founder separation

The ordinary-user activation surface contains one ten-digit numeric invitation field and one activation action. It never displays Invite Studio.

Invite Studio appears only when the local dashboard API proves that the current device holds both:

1. a valid Founder entitlement bound to the current device key; and
2. an enrolled issuer private key in macOS Keychain that can answer a fresh online challenge.

The current James machine receives that authority during Founder bootstrap before licensing enforcement is enabled. A successful generation action always returns exactly ten unique ten-digit one-time invitation codes. The UI does not infer authority from a developer name, browser flag, local storage value, or hidden HTML.

Invite Studio sits in the lower-right dashboard area without using a floating overlay that would cover operations content. It shows copy-all and CSV export for the newly generated in-memory batch, then masked history and revoke controls. Full plaintext codes are returned only at generation time and are never persisted in the browser.

## Error and outage behavior

- Contact-card unavailable: keep the dialog open, show a localized retry action, and do not expose infrastructure details.
- Activation service unavailable: keep the dashboard activation gate available and show a retryable service message.
- Already licensed installation with activation service unavailable: continue operating from the locally verified entitlement.
- Founder challenge unavailable: disable generation for that attempt and leave all IM channels untouched.
- Missing or invalid Founder material: hide Invite Studio rather than presenting a broken or misleading control.

## Verification

Automated contract and browser tests must cover:

- English and Chinese product narrative.
- Contact control in licensed and unlicensed states.
- Modal accessibility and responsive bottom-sheet behavior.
- Contact-card success, retry, media type, size limit, and no cross-impact on health state.
- Ordinary-user absence and Founder-only presence of Invite Studio.
- Exactly ten codes per generation and no plaintext persistence.
- No changes to existing channel controls, API contracts, polling, runtime, Multica, memory, or audit behavior.
