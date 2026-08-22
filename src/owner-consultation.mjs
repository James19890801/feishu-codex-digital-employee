function bounded(value, limit = 1_000) {
  return String(value || '').replace(/\r\n?/g, '\n').trim().slice(0, limit);
}

const EXPLICIT_REQUEST = /(?:去|帮我|麻烦你|请你)?(?:问(?:一下|下)?|请示|找|跟|向).{0,8}詹老师|请詹老师.{0,8}(?:确认|决定|同意|回复)|(?:转达|告诉).{0,8}詹老师/u;
const NEGATED_REQUEST = /(?:不用|不必|别|无需|不要).{0,10}(?:问|找|请示|转达).{0,8}詹老师/u;
const QUOTED_REQUEST = /[“"「『][^”"」』]{0,80}(?:问|找|请示|转达).{0,8}詹老师[^”"」』]{0,80}[”"」』]/u;
const CONTEXT_ACCEPT = /^(?:好|好的|可以|行|那好)[，,。！! ]*(?:你)?(?:去)?(?:问|找|请示)(?:吧|一下|下)?[。！! ]*$/u;
const ASSISTANT_OFFER = /需要詹老师.{0,12}(?:确认|决定|同意)|(?:要我|我可以).{0,8}(?:问|找).{0,6}詹老师/u;

export function detectOwnerConsultationRequest({ text, recentAssistantText = '' } = {}) {
  const source = bounded(text, 2_000);
  if (!source || NEGATED_REQUEST.test(source) || QUOTED_REQUEST.test(source)) {
    return { triggered: false };
  }
  if (EXPLICIT_REQUEST.test(source)) return { triggered: true };
  if (CONTEXT_ACCEPT.test(source) && ASSISTANT_OFFER.test(bounded(recentAssistantText, 1_000))) {
    return { triggered: true };
  }
  return { triggered: false };
}

export function buildOwnerConsultationMessage({
  requesterLabel = '一位微信联系人',
  requestText = '',
  decisionPrompt = '',
  suggestedReply = '',
} = {}) {
  const requester = bounded(requesterLabel, 100) || '一位微信联系人';
  const request = bounded(requestText, 1_200) || '（没有可用摘要）';
  const decision = bounded(decisionPrompt, 500) || '是否同意对方提出的事项';
  const suggestion = bounded(suggestedReply, 800) || '我收到您的意见后再回复对方。';
  return [
    `詹老师，${requester}请我来问您：`,
    request,
    `需要您确认：${decision}`,
    `建议回复：${suggestion}`,
    '您可以直接引用这条消息回复“同意”“不同意”，或回复“改成：……”。',
  ].join('\n\n');
}

export function parseOwnerConsultationDecision(value) {
  const text = bounded(value, 1_200).replace(/[。！!]+$/u, '').trim();
  if (/^(?:同意|可以|行|好的?|没问题)$/u.test(text)) {
    return { kind: 'approve', approvedReply: '' };
  }
  if (/^(?:不同意|不可以|不行|暂不安排|拒绝)$/u.test(text)) {
    return { kind: 'reject', approvedReply: '' };
  }
  const revised = text.match(/^(?:改成|回复|告诉(?:她|他|对方)|转告(?:她|他|对方))[：:，,]?\s*([\s\S]+)$/u);
  if (revised?.[1]?.trim()) {
    return { kind: 'revise', approvedReply: revised[1].trim().slice(0, 800) };
  }
  return { kind: 'ambiguous', approvedReply: '' };
}

export function buildRequesterRelay({ decision, approvedReply = '' } = {}) {
  if (decision === 'reject') return '我问过詹老师了，他暂时没有同意这件事。';
  const reply = bounded(approvedReply, 800);
  return reply ? `我问过詹老师了，他回复：${reply}` : '';
}

function prefixedOwnerId(value) {
  const raw = bounded(value, 500).replace(/^wechat:/, '');
  return raw ? `wechat:${raw}` : '';
}

function outboundMessageId(value, depth = 0) {
  if (!value || depth > 5) return '';
  if (typeof value !== 'object') return '';
  for (const key of ['messageId', 'message_id', 'newMsgId', 'new_msg_id', 'msgId']) {
    const id = bounded(value[key], 500);
    if (id) return id;
  }
  for (const nested of Object.values(value)) {
    const found = outboundMessageId(nested, depth + 1);
    if (found) return found;
  }
  return '';
}

function defaultConsultationDraft(text) {
  const request = bounded(text, 1_200);
  return {
    decisionPrompt: `是否同意或认可对方提出的事项：${request}`.slice(0, 500),
    suggestedReply: '詹老师已同意进一步沟通，具体安排再另行确认。',
  };
}

export class OwnerConsultationCoordinator {
  constructor({
    state,
    ownerIds = [],
    send,
    executeOnce,
    audit = () => {},
    now = Date.now,
    idFactory = () => globalThis.crypto.randomUUID(),
    reminderMs = 4 * 60 * 60_000,
    ttlMs = 24 * 60 * 60_000,
  } = {}) {
    if (!state || typeof send !== 'function' || typeof executeOnce !== 'function') {
      throw new Error('Owner consultation coordinator requires state, send, and mutation execution');
    }
    this.state = state;
    this.ownerIds = new Set((Array.isArray(ownerIds) ? ownerIds : [ownerIds])
      .map(prefixedOwnerId).filter(Boolean));
    if (!this.ownerIds.size) throw new Error('Owner consultation coordinator requires an Owner');
    this.send = send;
    this.executeOnce = executeOnce;
    this.audit = audit;
    this.now = now;
    this.idFactory = idFactory;
    this.reminderMs = Math.max(60_000, Number(reminderMs) || 4 * 60 * 60_000);
    this.ttlMs = Math.max(this.reminderMs + 60_000, Number(ttlMs) || 24 * 60 * 60_000);
  }

  ownerChatId(ownerId) {
    return `wechat:user:${String(ownerId || '').replace(/^wechat:/, '')}`;
  }

  isOwnerPrivateMessage({ senderId, chatId, chatType } = {}) {
    const ownerId = prefixedOwnerId(senderId);
    return this.ownerIds.has(ownerId)
      && String(chatType || '') === 'p2p'
      && String(chatId || '') === this.ownerChatId(ownerId);
  }

  async mutate(executionKey, kind, operation) {
    return this.executeOnce({ state: this.state, executionKey, kind, operation });
  }

  async start({
    message, senderId, text, requesterLabel = '', recentAssistantText = '',
    decisionPrompt = '', suggestedReply = '',
  } = {}) {
    const detection = detectOwnerConsultationRequest({ text, recentAssistantText });
    if (!detection.triggered || this.ownerIds.has(prefixedOwnerId(senderId))) return { handled: false };
    const ownerId = [...this.ownerIds][0];
    const nowMs = Number(this.now());
    const draft = defaultConsultationDraft(text);
    const created = this.state.createOwnerConsultation({
      id: bounded(this.idFactory(), 200),
      channel: 'wechat',
      ownerId,
      ownerChatId: this.ownerChatId(ownerId),
      originChatId: bounded(message?.chat_id, 500),
      originChatType: bounded(message?.chat_type, 30),
      requesterId: prefixedOwnerId(senderId),
      requesterLabel: bounded(requesterLabel, 200),
      sourceMessageId: bounded(message?.message_id, 500),
      requestText: bounded(text, 4_000),
      decisionPrompt: bounded(decisionPrompt, 1_000) || draft.decisionPrompt,
      suggestedReply: bounded(suggestedReply, 2_000) || draft.suggestedReply,
      reminderAtMs: nowMs + this.reminderMs,
      expiresAtMs: nowMs + this.ttlMs,
      nowMs,
    });
    const consultation = created.consultation;
    if (!created.created && consultation.status !== 'pending_notify') {
      return { handled: true, action: 'already_created', consultation };
    }

    if (created.created) {
      try {
        await this.mutate(
          `owner-consultation:${consultation.id}:requester-ack`,
          'owner_consultation_ack',
          () => this.send({
            chatId: consultation.originChatId,
            chatType: consultation.originChatType,
            mentionSenderId: consultation.originChatType === 'group' ? consultation.requesterId : '',
            text: '好的，我去问詹老师，有回复后告诉你。',
            idempotencyKey: `owner-consultation-${consultation.id}-ack`,
          }),
        );
      } catch (error) {
        this.audit('owner_consultation_ack_ambiguous', {
          consultationId: consultation.id,
          channel: 'wechat',
          errorCode: error?.code || 'send_failed',
        });
      }
    }

    const claimed = this.state.claimOwnerConsultationNotification(consultation.id, Number(this.now()));
    if (!claimed) return { handled: true, action: 'notification_already_claimed', consultation };
    const ownerText = buildOwnerConsultationMessage({
      requesterLabel: consultation.requesterLabel,
      requestText: consultation.requestText,
      decisionPrompt: consultation.decisionPrompt,
      suggestedReply: consultation.suggestedReply,
    });
    try {
      const executed = await this.mutate(
        `owner-consultation:${consultation.id}:owner-notify`,
        'owner_consultation_notify',
        () => this.send({
          chatId: consultation.ownerChatId,
          chatType: 'p2p',
          text: ownerText,
          idempotencyKey: `owner-consultation-${consultation.id}-owner`,
        }),
      );
      const notificationMessageId = outboundMessageId(executed?.result)
        || `owner-consultation-${consultation.id}-owner`;
      this.state.markOwnerConsultationAwaiting(
        consultation.id, notificationMessageId, Number(this.now()),
      );
      this.audit('owner_consultation_started', { consultationId: consultation.id, channel: 'wechat' });
      return { handled: true, action: 'awaiting_owner', consultationId: consultation.id };
    } catch (error) {
      this.state.markOwnerConsultationAmbiguous(
        consultation.id, 'owner_notify', error?.message || error, Number(this.now()),
      );
      this.audit('owner_consultation_ambiguous', {
        consultationId: consultation.id, phase: 'owner_notify', errorCode: error?.code || 'send_failed',
      });
      return { handled: true, action: 'owner_notify_ambiguous', consultationId: consultation.id };
    }
  }

  async sendOwnerGuidance(chatId, messageId, text) {
    await this.mutate(
      `owner-consultation:guidance:${bounded(messageId, 300)}`,
      'owner_consultation_guidance',
      () => this.send({
        chatId, chatType: 'p2p', text,
        idempotencyKey: `owner-consultation-guidance-${bounded(messageId, 300)}`,
      }),
    );
  }

  async handleOwnerResponse({
    senderId, chatId, chatType, text, messageId, quotedMessageId = '',
  } = {}) {
    if (!this.isOwnerPrivateMessage({ senderId, chatId, chatType })) return { handled: false };
    const ownerId = prefixedOwnerId(senderId);
    let consultation = quotedMessageId
      ? this.state.ownerConsultationByNotificationMessageId(quotedMessageId)
      : null;
    if (consultation && consultation.ownerId !== ownerId) consultation = null;
    if (quotedMessageId && !consultation) return { handled: false };
    if (consultation && consultation.status !== 'awaiting_owner') {
      return { handled: true, action: 'already_closed' };
    }
    if (!consultation) {
      const active = this.state.activeOwnerConsultations(ownerId, Number(this.now()));
      if (active.length !== 1) {
        if (active.length > 1) {
          await this.sendOwnerGuidance(
            chatId, messageId,
            '现在有多条待请示事项。为避免串单，请引用对应的请示消息回复。',
          );
          return { handled: true, action: 'needs_quote' };
        }
        return { handled: false };
      }
      [consultation] = active;
    }
    const parsed = parseOwnerConsultationDecision(text);
    if (parsed.kind === 'ambiguous') {
      await this.sendOwnerGuidance(
        chatId, messageId,
        '我还不能确定您的决定。请回复“同意”“不同意”，或“改成：……”。',
      );
      return { handled: true, action: 'needs_clarification' };
    }
    const approvedReply = parsed.kind === 'approve'
      ? consultation.suggestedReply
      : parsed.approvedReply;
    const resolving = this.state.claimOwnerConsultationResolution(consultation.id, {
      decision: parsed.kind,
      approvedReply,
      ownerResponseMessageId: messageId,
      nowMs: Number(this.now()),
    });
    if (!resolving) return { handled: true, action: 'already_closed' };
    const relayText = buildRequesterRelay({ decision: parsed.kind, approvedReply });
    try {
      await this.mutate(
        `owner-consultation:${consultation.id}:relay`,
        'owner_consultation_relay',
        () => this.send({
          chatId: consultation.originChatId,
          chatType: consultation.originChatType,
          mentionSenderId: consultation.originChatType === 'group' ? consultation.requesterId : '',
          text: relayText,
          idempotencyKey: `owner-consultation-${consultation.id}-relay`,
        }),
      );
      const terminal = parsed.kind === 'reject' ? 'rejected_relayed' : 'relayed';
      this.state.markOwnerConsultationRelayed(consultation.id, terminal, Number(this.now()));
      this.audit('owner_consultation_relayed', {
        consultationId: consultation.id, decision: parsed.kind, channel: 'wechat',
      });
      return { handled: true, action: 'relayed', consultationId: consultation.id };
    } catch (error) {
      this.state.markOwnerConsultationAmbiguous(
        consultation.id, 'relay', error?.message || error, Number(this.now()),
      );
      this.audit('owner_consultation_ambiguous', {
        consultationId: consultation.id, phase: 'relay', errorCode: error?.code || 'send_failed',
      });
      return { handled: true, action: 'relay_ambiguous', consultationId: consultation.id };
    }
  }

  async processDue() {
    let processed = 0;
    for (let index = 0; index < 20; index += 1) {
      const reminder = this.state.claimDueOwnerConsultationReminder(Number(this.now()));
      if (!reminder) break;
      try {
        await this.mutate(
          `owner-consultation:${reminder.id}:owner-reminder`,
          'owner_consultation_reminder',
          () => this.send({
            chatId: reminder.ownerChatId,
            chatType: 'p2p',
            text: `提醒一下：${reminder.requesterLabel || '一位微信联系人'}的请示还在等您回复。\n\n需要您确认：${reminder.decisionPrompt}\n\n请引用原请示消息回复。`,
            idempotencyKey: `owner-consultation-${reminder.id}-reminder`,
          }),
        );
        this.state.markOwnerConsultationAwaiting(
          reminder.id, reminder.ownerNotificationMessageId, Number(this.now()), { reminded: true },
        );
        this.audit('owner_consultation_reminded', { consultationId: reminder.id, channel: 'wechat' });
      } catch (error) {
        this.state.markOwnerConsultationAmbiguous(
          reminder.id, 'owner_notify', error?.message || error, Number(this.now()),
        );
      }
      processed += 1;
    }
    for (let index = 0; index < 20; index += 1) {
      const expired = this.state.claimDueOwnerConsultationExpiry(Number(this.now()));
      if (!expired) break;
      try {
        await this.mutate(
          `owner-consultation:${expired.id}:expired`,
          'owner_consultation_expired',
          () => this.send({
            chatId: expired.originChatId,
            chatType: expired.originChatType,
            mentionSenderId: expired.originChatType === 'group' ? expired.requesterId : '',
            text: '詹老师暂时还没有回复，这次请示先结束；如果仍然需要，可以重新告诉我。',
            idempotencyKey: `owner-consultation-${expired.id}-expired`,
          }),
        );
        this.state.markOwnerConsultationRelayed(expired.id, 'expired', Number(this.now()));
        this.audit('owner_consultation_expired', { consultationId: expired.id, channel: 'wechat' });
      } catch (error) {
        this.state.markOwnerConsultationAmbiguous(
          expired.id, 'relay', error?.message || error, Number(this.now()),
        );
      }
      processed += 1;
    }
    return processed;
  }
}
