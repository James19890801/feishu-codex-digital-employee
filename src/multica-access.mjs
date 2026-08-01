export function isAuthorizedMulticaOwner(context = {}, identities = {}) {
  const senderId = String(context.senderId || '').trim();
  if (!senderId) return false;

  const ownerOpenId = String(identities.ownerOpenId || '').trim();
  if (ownerOpenId && senderId === ownerOpenId) return true;

  const dingtalkOwnerOpenId = String(identities.dingtalkOwnerOpenId || '').trim();
  return Boolean(
    dingtalkOwnerOpenId
      && context.metadata?.channel === 'dingtalk'
      && context.metadata?.selfChat === true
      && senderId === `dingtalk:${dingtalkOwnerOpenId}`,
  );
}

export function requireAuthorizedMulticaOwner(context, identities) {
  if (isAuthorizedMulticaOwner(context, identities)) return true;
  const error = new Error('Verified Owner authorization is required for Multica writes');
  error.code = 'MULTICA_OWNER_REQUIRED';
  throw error;
}
