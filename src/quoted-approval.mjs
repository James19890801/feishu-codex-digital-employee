const STORE_SCOPE = 'quoted_approval';
const STORE_KEY = 'records_v1';

export function normalizeDingTalkApprovalMessageId(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return '';
  return normalized.startsWith('dingtalk:') ? normalized : `dingtalk:${normalized}`;
}

export function isQuotedApprovalConsent(text) {
  return /^同意[。！! ]*$/.test(String(text || '').trim());
}

export function isDingTalkGroupApprovalContext(context = {}) {
  const channel = String(context.metadata?.channel || '').trim().toLowerCase();
  return context.chatType === 'group'
    && channel === 'dingtalk'
    && String(context.chatId || '').startsWith('dingtalk:group:');
}

export function isVerifiedDingTalkGroupApprover(context = {}, identities = {}) {
  const ownerId = String(identities.dingtalkOwnerOpenId || '').trim();
  return Boolean(
    ownerId
      && isDingTalkGroupApprovalContext(context)
      && String(context.senderId || '').trim() === `dingtalk:${ownerId}`,
  );
}

export async function handleDingTalkQuotedApproval({
  text,
  context = {},
  identities = {},
  store,
  execute,
  send,
  nowMs = Date.now(),
} = {}) {
  if (!isDingTalkGroupApprovalContext(context) || !isQuotedApprovalConsent(text)) {
    return { handled: false, outcome: 'not_consent' };
  }
  const verifiedApprover = isVerifiedDingTalkGroupApprover(context, identities);
  const quotedMessage = context.metadata?.quotedMessage;
  const quotedMessageId = normalizeDingTalkApprovalMessageId(quotedMessage?.messageId);
  if (!quotedMessageId) {
    if (!verifiedApprover) return { handled: false, outcome: 'not_approval' };
    await send('当前无法确定你同意的是哪一项，请引用对应的授权请求后回复“同意”。');
    return { handled: true, outcome: 'quote_required' };
  }

  const record = store?.peek(quotedMessageId, nowMs);
  if (!record) {
    if (!verifiedApprover) return { handled: false, outcome: 'not_approval' };
    await send('这条授权请求无效、已过期或已经处理，本次没有执行任何操作。');
    return { handled: true, outcome: 'not_found' };
  }
  if (!verifiedApprover) {
    await send('只有经过验证的 Owner 本人可以批准这项操作，本次没有执行。');
    return { handled: true, outcome: 'approver_denied' };
  }

  const quotedChatId = quotedMessage?.conversationId
    ? `dingtalk:group:${String(quotedMessage.conversationId).trim()}`
    : '';
  if (!quotedChatId || quotedChatId !== context.chatId) {
    await send('被引用的授权请求不属于当前群聊，本次没有执行任何操作。');
    return { handled: true, outcome: 'quote_chat_mismatch' };
  }
  const claim = store.claim(quotedMessageId, { chatId: context.chatId }, nowMs);
  if (!claim.ok) {
    await send(claim.reason === 'expired'
      ? '这条授权请求已经过期，本次没有执行任何操作。'
      : '这条授权请求无效或已经处理，本次没有执行任何操作。');
    return { handled: true, outcome: claim.reason };
  }

  const result = await execute(claim.record, context);
  await send(result?.text || '授权已确认，操作已执行。');
  return { handled: true, outcome: 'executed' };
}

export class QuotedApprovalStore {
  constructor(state, { ttlMs = 30 * 60_000, maxRecords = 100 } = {}) {
    if (!state) throw new Error('Quoted approval store requires state');
    this.state = state;
    this.ttlMs = ttlMs;
    this.maxRecords = maxRecords;
  }

  records() {
    const records = this.state.get(STORE_SCOPE, STORE_KEY, []);
    return Array.isArray(records) ? records : [];
  }

  save(records) {
    this.state.set(STORE_SCOPE, STORE_KEY, records);
  }

  liveRecords(nowMs) {
    return this.records().filter(record => Number(record?.expiresAtMs || 0) > nowMs);
  }

  bind(messageId, value, nowMs = Date.now()) {
    const normalizedMessageId = normalizeDingTalkApprovalMessageId(messageId);
    if (!normalizedMessageId || !value?.chatId) return false;
    const records = this.liveRecords(nowMs);
    if (records.some(record => record.messageId === normalizedMessageId)) return false;
    records.push({
      ...structuredClone(value),
      messageId: normalizedMessageId,
      boundAtMs: nowMs,
      expiresAtMs: nowMs + this.ttlMs,
    });
    records.sort((left, right) => left.boundAtMs - right.boundAtMs);
    this.save(records.slice(-this.maxRecords));
    return true;
  }

  peek(messageId, nowMs = Date.now()) {
    const normalizedMessageId = normalizeDingTalkApprovalMessageId(messageId);
    if (!normalizedMessageId) return null;
    const records = this.liveRecords(nowMs);
    this.save(records);
    const record = records.find(item => item.messageId === normalizedMessageId);
    return record ? structuredClone(record) : null;
  }

  claim(messageId, { chatId = '' } = {}, nowMs = Date.now()) {
    const normalizedMessageId = normalizeDingTalkApprovalMessageId(messageId);
    const records = this.records();
    const index = records.findIndex(record => record?.messageId === normalizedMessageId);
    if (index < 0) return { ok: false, reason: 'not_found', record: null };
    const record = records[index];
    if (Number(record.expiresAtMs || 0) <= nowMs) {
      records.splice(index, 1);
      this.save(records);
      return { ok: false, reason: 'expired', record: null };
    }
    if (String(record.chatId || '') !== String(chatId || '')) {
      return { ok: false, reason: 'chat_mismatch', record: null };
    }
    records.splice(index, 1);
    this.save(records);
    return { ok: true, reason: 'claimed', record: structuredClone(record) };
  }

  pendingChatIds(nowMs = Date.now()) {
    const records = this.liveRecords(nowMs);
    this.save(records);
    return [...new Set(records.map(record => String(record.chatId || '')).filter(Boolean))].sort();
  }
}
