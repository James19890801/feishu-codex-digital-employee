import assert from 'node:assert/strict';
import {
  hasSelfChatOutboundMarker,
  markSelfChatOutbound,
  stripSelfChatOutboundMarker,
} from './self-chat-guard.mjs';

const reply = '这是一条正常回复';
const marked = markSelfChatOutbound(reply);
assert.notEqual(marked, reply);
assert.equal(hasSelfChatOutboundMarker(marked), true);
assert.equal(hasSelfChatOutboundMarker(reply), false);
assert.equal(stripSelfChatOutboundMarker(marked), reply);
assert.equal(markSelfChatOutbound(marked), marked, 'marker insertion must be idempotent');

console.log('SELF_CHAT_GUARD_TEST_OK');
