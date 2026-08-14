# WeChat quoted context, media, Multica, and link robustness design

Date: 2026-08-14

## Goal

Make the personal WeChat channel handle quoted questions, owner-issued Multica
commands, images, and public links with the same reliable execution semantics as
the DingTalk and Feishu channels. Every reply should use the latest 50 messages
from all participants in the same chat, without crossing chat boundaries or
exposing private workspace information.

## Confirmed failures

1. GeWe quote cards arrive as app-message XML (`type=57`). The current ingress
   path forwards the raw XML instead of extracting the current prompt and quoted
   content. A bot mention that appears only in the quote-card title can therefore
   be misclassified as context-only.
2. A request that both creates a Multica Issue and requires a PDF is intercepted
   by the artifact follow-up branch before the Multica create branch. The later
   confirmations have no durable pending action to confirm.
3. In GeWe V1 group events, the group occupies `FromUserName` while the real
   member wxid is carried in the group-content prefix. Owner messages are not
   authenticated because self-origin detection runs before that prefix is parsed.
4. Quoted images contain usable image XML inside `refermsg type=3`, but ingress
   does not extract it. Standalone image downloads also trust the HTTP
   `Content-Type`; GeWe's object storage can return the misspelled generic type
   `application/octst-stream` for valid JPEG or PNG bytes.
5. Public link cards and plain URLs do not share one explicit, observable routing
   contract. A parsing or mention variation can cause a link to be stored without
   being read and answered.

## Chosen architecture

### 1. Structured WeChat quote normalization

Add a bounded parser for GeWe app-message XML. For `type=57`, produce:

- current request text from the outer `title`;
- quoted type, message id, sender wxid, display name, and decoded content;
- a concise model-facing text representation instead of raw XML;
- `metadata.quotedMessage` for deterministic downstream routing;
- `metadata.image` when the quote contains `refermsg type=3` image XML;
- a required-response signal when the current request explicitly names or
  mentions the assistant.

Malformed XML remains inert text and must never crash ingress.

### 2. Fifty-message, all-participant context

Raise the chat-history window from 30 to 50 messages for normal replies,
Multica planning, group engagement, and deferred group-host replies. The window
is scoped to the current chat and includes every participant plus assistant
replies. The exact quoted message remains first-class context even if it falls
outside the rolling window.

To bound prompt growth, each ordinary history item remains length-limited and
the newest messages are retained preferentially. No message from another chat is
eligible.

### 3. Authenticated owner commands in WeChat groups

For GeWe V1 group events, parse the group sender before computing self-origin.
An owner write is authorized only when all conditions hold:

- callback arrived through the secret GeWe webhook;
- parsed group sender equals the logged-in WeChat wxid;
- the message is in a group and explicitly invokes the assistant;
- the existing preview/confirmation policy approves the mutation.

Other group members remain read-only for Multica. Ordinary owner conversation
that does not invoke the assistant remains human activity and is not answered.

### 4. Multica create intent precedes artifact follow-up

When one request explicitly asks to create an Issue and names a final artifact,
route it to Multica creation first. Store the artifact requirement as the new
Issue's delivery contract. Only artifact-only follow-ups without a create intent
use the existing follow-up path. The pending confirmation and workspace/squad
selection must survive subsequent short confirmations in the same group.

### 5. Image source capture and on-demand recovery

Persist bounded image-source metadata as soon as an image event arrives, before
attempting a download. Resolution order for a directed image question is:

1. exact image XML embedded in the quoted message;
2. already-downloaded image from the latest 50 messages in the same chat;
3. image source XML from the latest 50 messages, downloaded on demand.

Download variants are tried in the order normal, high-definition, thumbnail.
Downloaded bytes are magic-number sniffed for JPEG, PNG, GIF, or WebP whenever
the server supplies a missing, generic, or incorrect MIME type. A failed
context-only image is retained for later on-demand retry instead of poisoning
the durable inbox with repeated dead letters.

### 6. Robust proactive public-link reading

Normalize both WeChat link cards and plain HTTP(S) URLs into explicit link
candidates. In an authorized group, a new public link is a response-required
event even without a separate reading command. The service will:

- extract the canonical URL and surrounding title/description;
- apply the existing public-address, redirect, size, timeout, and content-type
  protections;
- read WeChat Official Account HTML with the browser-compatible reader;
- summarize or answer in the context of the latest 50 chat messages;
- never invent unread content;
- state briefly that a link could not be opened when all safe readers fail.

Private hosts, embedded credentials, custom ports, and cross-chat retrieval stay
blocked. Duplicate callbacks and repeated links remain subject to the existing
inbox and semantic-repeat guards.

## Data flow

1. Secret GeWe webhook accepts an event.
2. Ingress parses group sender, quote card, media source, mention, and link.
3. Durable inbox deduplicates the callback.
4. Processor records the event in same-chat history and loads the newest 50
   messages from all participants.
5. Deterministic routing handles Multica creation before artifact follow-up.
6. Media and links are resolved through safe local/public readers.
7. Codex receives clean text, exact quote context, safe retrieved content, and
   local image paths.
8. Reply and any Multica progress or artifact return through the original WeChat
   chat.

## Failure behavior

- Quote parse failure: retain bounded plain text, log the parse classification,
  and continue without inventing quoted content.
- Image fetch failure: keep the source for on-demand retry; do not emit generic
  repeated-failure chatter.
- Link read failure: reply only when response is required, clearly saying the
  content could not be opened.
- Unauthorized Multica write: do not mutate; retain read/query capability.
- Service restart: deploy only after queued/retry/processing inbound count is
  zero, so no historical message is replayed.

## Verification

Add failing tests for:

- quote-card title mention with quoted text;
- quote-card image extraction and model-facing clean text;
- GeWe V1 owner identity inside a group;
- owner group Multica authorization with explicit invocation, and denial for all
  other members;
- create-Issue-plus-PDF routing priority;
- 50-message all-participant history;
- generic or misspelled MIME with valid image magic bytes;
- download fallback across image variants;
- plain URL and link-card proactive reading classification;
- malformed XML, unsafe URLs, duplicate events, and cross-chat isolation.

Run focused suites, the mechanism acceptance suite, and the full `npm test`
suite before a queue-safe service restart. Do not send or backfill test messages
to real chats.
