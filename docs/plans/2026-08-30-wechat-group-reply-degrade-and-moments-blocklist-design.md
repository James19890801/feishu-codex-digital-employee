# WeChat Group Reply Degrade and Moments Blocklist Design

## Goal

Reduce unsolicited participation by the personal WeChat digital employee while preserving direct assistance and content-reading capability. Also prevent all Moments likes and comments for configured blocked WeChat accounts.

## Group reply policy

The restriction applies only to personal WeChat group chats. Feishu, DingTalk, WeCom, private chats, scheduled jobs, and owner-only workflows keep their existing behavior.

A WeChat group message may enter the reply pipeline only when one of these conditions is true:

1. The message contains a real mention of the assistant.
2. The message directly asks the assistant by an approved alias to reply, review, analyze, comment, or perform another task.
3. The message is a continuation of an immediately preceding assistant exchange and still clearly requests a response.

An unaddressed URL, shared article, image, file, or ordinary group discussion remains observation-only. It is still stored in conversation history so a later addressed request can use it. Merely containing a question or a topic relevant to the assistant is not enough to trigger a reply.

When an allowed request quotes another message, the quoted text, article, image, or file is resolved directly and supplied to the response pipeline. The assistant must not claim that it cannot see content merely because it arrived as quoted or media content. If the referenced item cannot be resolved, the failure is recorded internally and the assistant asks for clarification only when that is necessary to answer the addressed request.

The existing group-history formatter remains the source of conversational context and continues to cap WeChat group context at the latest 50 messages.

## Implementation boundary

Add a WeChat-specific reply gate before semantic group engagement. The gate returns either `reply` with a reason or `observe`. The shared semantic engagement engine remains unchanged for other channels. For allowed alias-addressed messages, the existing engagement and response pipeline performs the final task interpretation; disallowed ambient messages never reach the proactive classifier.

The inbound normalization layer continues to mark unaddressed media and links as context-only. The new gate is the final enforcement point so downstream features cannot accidentally turn a passive link into an unsolicited reply.

## Moments blocklist

Add a validated configuration list for WeChat IDs whose Moments must never receive an automated like or comment. The production-only configuration contains the requested account; example and test configuration use placeholders so personal identifiers are not committed.

The blocklist is enforced twice:

1. During scanning and eligibility evaluation, blocked authors and blocked commenters are skipped before generation or scheduling.
2. Immediately before executing any pending like or comment, the target ID is checked again. This cancels previously queued work after a configuration change or service restart.

Blocked interactions are removed from the pending queue and audited with a non-identifying hash and a block reason. They do not consume daily interaction budgets.

## Testing

Regression tests cover:

- unaddressed WeChat group links, articles, images, files, and general questions staying silent;
- real mentions and explicit alias requests replying;
- quoted text and quoted media flowing through only after an allowed trigger;
- use of the latest 50 group messages and clarification when the referenced target is ambiguous;
- blocked Moments authors receiving neither proactive likes nor proactive comments;
- blocked commenters receiving no thread reply;
- already queued blocked interactions being cancelled at execution time;
- no behavior change for non-WeChat channels.

## Deployment and rollback

After focused and full verification, restart the local launchd service and confirm its running state and health endpoint. Push only the generic code, tests, and documentation. Keep the concrete production WeChat ID in the ignored local configuration.

Rollback consists of removing the WeChat gate wiring and the blocklist configuration entry, then restarting the service. Observation history is unaffected.
