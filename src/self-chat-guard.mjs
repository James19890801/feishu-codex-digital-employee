const SELF_CHAT_OUTBOUND_MARKER = '\u2063\u2062\u2063\u2062\u2063\u2063\u2062\u2062';

export function hasSelfChatOutboundMarker(text) {
  return String(text || '').includes(SELF_CHAT_OUTBOUND_MARKER);
}

export function markSelfChatOutbound(text) {
  const value = String(text || '');
  return hasSelfChatOutboundMarker(value) ? value : `${value}${SELF_CHAT_OUTBOUND_MARKER}`;
}

export function stripSelfChatOutboundMarker(text) {
  return String(text || '').split(SELF_CHAT_OUTBOUND_MARKER).join('');
}
