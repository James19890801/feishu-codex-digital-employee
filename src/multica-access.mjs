export function isVerifiedMulticaOwner(context = {}, identities = {}) {
  const senderId = String(context.senderId || '').trim();
  if (!senderId) return false;

  const normalizedChannel = String(context.metadata?.channel || '').trim().toLowerCase();
  const channel = normalizedChannel === 'enterprisechat' ? 'enterpriseChat' : normalizedChannel;
  const ownerOpenId = String(identities.ownerOpenId || '').trim();
  if (channel === 'feishu' && ownerOpenId && senderId === ownerOpenId) {
    return true;
  }

  if (channel === 'wechat' && context.metadata?.ownerControlAuthenticated === true) {
    return senderId.startsWith('wechat:');
  }

  const enterpriseChatOwnerOpenId = String(identities.enterpriseChatOwnerOpenId || '').trim();
  return Boolean(
    enterpriseChatOwnerOpenId
      && channel === 'enterpriseChat'
      && senderId === `enterpriseChat:${enterpriseChatOwnerOpenId}`,
  );
}

export function isAuthorizedMulticaOwner(context = {}, identities = {}) {
  const wechatP2pParticipant = context.chatType === 'p2p'
    && context.metadata?.channel === 'wechat'
    && String(context.senderId || '').startsWith('wechat:');
  if (wechatP2pParticipant) return true;
  const selfChat = context.chatType === 'p2p' && context.metadata?.selfChat === true;
  const wechatGroupParticipant = context.chatType === 'group'
    && context.metadata?.channel === 'wechat'
    && String(context.senderId || '').startsWith('wechat:')
    && (context.metadata?.explicitBotMention === true
      || context.metadata?.pendingMulticaContinuation === true);
  if (wechatGroupParticipant) return true;
  return selfChat
    && isVerifiedMulticaOwner(context, identities);
}

export function requireAuthorizedMulticaOwner(context, identities) {
  if (isAuthorizedMulticaOwner(context, identities)) return true;
  const error = new Error('Verified Owner self-chat authorization is required for Multica writes');
  error.code = 'MULTICA_OWNER_REQUIRED';
  throw error;
}
