import { createHash } from 'node:crypto';
import { executeMutationOnce, MutationOutcomeAmbiguousError } from './mutation-execution.mjs';
import {
  buildMailKql, isMailCancellation, isMailConfirmation, parseMailIntent,
} from './mail-intent.mjs';

const SEARCH_CONTEXT_TTL_MS = 15 * 60_000;
const DELIVERY_TERMINAL = new Set(['success', 'partial_success', 'failed']);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function normalizedIds(values) {
  return new Set((values || []).map(value => String(value || '').trim()).filter(Boolean));
}

export function isAuthorizedMailOwner(context, ownerIds) {
  const ids = normalizedIds(ownerIds);
  return context?.chatType === 'p2p'
    && context?.metadata?.channel === 'dingtalk'
    && context?.metadata?.selfChat === true
    && ids.has(String(context?.senderId || '').trim());
}

function contextKey({ chatId, senderId }) {
  return `${chatId}:${senderId}`;
}

function displayAddress(address = {}) {
  return address.name ? `${address.name} <${address.email}>` : address.email || '未知发件人';
}

function briefList(messages) {
  if (!messages.length) return '没有查到符合条件的邮件。';
  return [
    `查到 ${messages.length} 封邮件：`,
    ...messages.map((mail, index) => `${index + 1}. ${mail.isRead ? '[已读]' : '[未读]'} ${mail.subject || '(无主题)'}｜${displayAddress(mail.from)}｜${mail.receivedDateTime || '时间未知'}${mail.hasAttachments ? '｜有附件' : ''}`),
    '回复“打开第 N 封邮件”可查看正文。',
  ].join('\n');
}

function previewText(draft) {
  const action = {
    send: '发送', reply: '回复', reply_all: '回复全部', forward: '转发',
  }[draft.operation] || '发送';
  const lines = [
    `邮件${action}前确认（15 分钟内有效）：`,
    `发件箱：${draft.from}`,
  ];
  if (draft.to?.length) lines.push(`收件人：${draft.to.join(', ')}`);
  if (draft.cc?.length) lines.push(`抄送：${draft.cc.join(', ')}`);
  if (draft.subject) lines.push(`主题：${draft.subject}`);
  if (draft.content) lines.push(`正文：\n${draft.content}`);
  if (draft.note) lines.push(`附言：\n${draft.note}`);
  lines.push('确认无误后，15 分钟内回复“确认”；回复“取消”则不发送。');
  return lines.join('\n');
}

function draftFingerprint(draft) {
  return createHash('sha256').update(JSON.stringify(draft)).digest('hex');
}

export class MailWorkflow {
  constructor({
    client, state, pendingStore, ownerIds = [], now = Date.now,
    delay = ms => new Promise(resolve => setTimeout(resolve, ms)),
  } = {}) {
    this.client = client;
    this.state = state;
    this.pendingStore = pendingStore;
    this.ownerIds = ownerIds;
    this.now = now;
    this.delay = delay;
  }

  _pending(context) {
    return this.pendingStore.get('mail_write', context.chatId, context.senderId, this.now());
  }

  async _mailbox() {
    const mailboxes = (await this.client.listMailboxes()).filter(mailbox => mailbox.type === 'ORG' || !mailbox.email.endsWith('@dingtalk.com'));
    if (mailboxes.length !== 1) return null;
    return mailboxes[0].email;
  }

  _searchContext(context) {
    const key = contextKey(context);
    const stored = this.state.get('mail_search_context', key, null);
    if (!stored || stored.expiresAt <= this.now()) {
      if (stored) this.state.unset('mail_search_context', key);
      return null;
    }
    return stored;
  }

  _selection(context, number) {
    const stored = this._searchContext(context);
    const item = stored?.messages?.[Number(number) - 1];
    return item ? { stored, item } : null;
  }

  async _resolveOne(mailbox, value) {
    const query = String(value || '').trim();
    if (EMAIL_PATTERN.test(query)) return { ok: true, email: query };
    const results = await Promise.allSettled([
      this.client.searchMailUsers({ email: mailbox, keyword: query, limit: 10 }),
      this.client.searchContactUsers({ query }),
    ]);
    const byEmail = new Map();
    for (const result of results) {
      if (result.status !== 'fulfilled') continue;
      for (const candidate of result.value || []) {
        const email = String(candidate.email || '').trim().toLowerCase();
        if (EMAIL_PATTERN.test(email)) byEmail.set(email, candidate);
      }
    }
    if (byEmail.size !== 1) return { ok: false, count: byEmail.size };
    return { ok: true, email: [...byEmail.keys()][0] };
  }

  async _resolveAll(mailbox, values) {
    const emails = [];
    for (const value of values || []) {
      const result = await this._resolveOne(mailbox, value);
      if (!result.ok) return { ok: false, value, count: result.count };
      emails.push(result.email);
    }
    return { ok: true, emails: [...new Set(emails)] };
  }

  async _search(context, intent, mailbox) {
    const result = await this.client.searchMessages({
      email: mailbox, query: buildMailKql(intent.filters), limit: intent.limit,
    });
    const messages = result.messages || [];
    this.state.set('mail_search_context', contextKey(context), {
      expiresAt: this.now() + SEARCH_CONTEXT_TTL_MS,
      email: mailbox,
      messages: messages.map(mail => ({
        id: mail.id, subject: mail.subject, from: mail.from,
        receivedDateTime: mail.receivedDateTime, isRead: mail.isRead,
        hasAttachments: mail.hasAttachments,
      })),
    });
    return { handled: true, sensitive: true, text: briefList(messages) };
  }

  async _open(context, intent) {
    const selected = this._selection(context, intent.selection);
    if (!selected) return { handled: true, sensitive: true, text: '这份邮件列表已失效或编号不存在，请先重新查询邮件。' };
    const mail = await this.client.getMessage({ email: selected.stored.email, id: selected.item.id });
    return {
      handled: true,
      sensitive: true,
      text: [`主题：${mail.subject || '(无主题)'}`, `发件人：${displayAddress(mail.from)}`, `时间：${mail.receivedDateTime || '未知'}`, '', mail.markdownBody || '(正文为空)'].join('\n'),
    };
  }

  async _prepareWrite(context, intent, mailbox) {
    const input = intent.draft;
    const draft = {
      operation: input.operation, from: mailbox, to: [], cc: [],
      subject: input.subject, content: input.content, note: input.note,
      sourceMessageId: context.messageId, sourceMailId: '',
    };
    if (input.operation === 'send') {
      if (!input.recipient || !input.subject || !input.content) {
        return { handled: true, text: '发送邮件需要明确收件人、主题和正文。' };
      }
      const to = await this._resolveAll(mailbox, [input.recipient]);
      const cc = await this._resolveAll(mailbox, input.cc);
      if (!to.ok || !cc.ok) return { handled: true, text: `无法唯一确认收件人“${to.ok ? cc.value : to.value}”，请改用完整邮箱地址。` };
      draft.to = to.emails;
      draft.cc = cc.emails;
    } else {
      const selected = this._selection(context, input.selection);
      if (!selected) return { handled: true, text: '邮件列表已失效或编号不存在，请先重新查询邮件。' };
      draft.sourceMailId = selected.item.id;
      draft.subject = selected.item.subject || '';
      if (input.operation === 'forward') {
        const to = await this._resolveAll(mailbox, [input.recipient]);
        if (!to.ok) return { handled: true, text: `无法唯一确认收件人“${to.value}”，请改用完整邮箱地址。` };
        draft.to = to.emails;
      }
    }
    draft.fingerprint = draftFingerprint(draft);
    this.pendingStore.set('mail_write', context.chatId, context.senderId, draft, this.now());
    return { handled: true, sensitive: true, text: previewText(draft) };
  }

  async _verify(from, internetMessageId) {
    if (!internetMessageId) return 'unknown';
    let status = 'unknown';
    for (let attempt = 0; attempt < 4; attempt += 1) {
      status = await this.client.verifyDelivery({ email: from, internetMessageId });
      if (DELIVERY_TERMINAL.has(status)) return status;
      if (attempt < 3) await this.delay(1000 * (attempt + 1));
    }
    return status;
  }

  async _confirm(context, draft) {
    const operation = async () => {
      if (draft.operation === 'send') return this.client.sendMessage({ from: draft.from, to: draft.to, cc: draft.cc, subject: draft.subject, content: draft.content });
      if (draft.operation === 'reply') return this.client.replyMessage({ from: draft.from, id: draft.sourceMailId, content: draft.content, subject: draft.subject });
      if (draft.operation === 'reply_all') return this.client.replyAllMessage({ from: draft.from, id: draft.sourceMailId, content: draft.content, subject: draft.subject });
      return this.client.forwardMessage({ from: draft.from, id: draft.sourceMailId, to: draft.to, content: draft.note, subject: draft.subject });
    };
    try {
      const executed = await executeMutationOnce({
        state: this.state,
        executionKey: `mail:${draft.sourceMessageId}:${draft.fingerprint}`,
        kind: `mail_${draft.operation}`,
        operation,
      });
      this.pendingStore.delete('mail_write', context.chatId, context.senderId);
      const status = await this._verify(draft.from, executed.result?.internetMessageId);
      const text = {
        success: '邮件投递成功。',
        partial_success: '邮件已投递，但部分收件人失败，请核对退信或投递状态。',
        failed: '邮件提交后投递失败，请检查收件地址和邮箱状态；系统不会自动重发。',
      }[status] || '邮件已提交，但暂时无法确认最终投递状态；系统不会自动重发。';
      return { handled: true, sensitive: true, text };
    } catch (error) {
      this.pendingStore.delete('mail_write', context.chatId, context.senderId);
      if (error instanceof MutationOutcomeAmbiguousError) {
        return { handled: true, sensitive: true, text: '邮件操作结果不确定。为避免重复发送，系统已禁止自动重试，请到“已发送”中核对。' };
      }
      return { handled: true, sensitive: true, text: '邮件未能发送，发送计划已取消。' };
    }
  }

  async handle(context) {
    const text = String(context?.text || '').trim();
    const intent = parseMailIntent(text);
    const pending = this._pending(context);
    const confirmation = isMailConfirmation(text);
    const cancellation = isMailCancellation(text);
    const looksLikeMail = intent.kind || /邮件|收件箱|已发送/u.test(text) || ((confirmation || cancellation) && pending);
    if (!looksLikeMail) return { handled: false };
    if (!isAuthorizedMailOwner(context, this.ownerIds)) {
      return { handled: true, text: '邮件能力仅能在本人钉钉私聊的数字人会话中使用。' };
    }
    if (cancellation && pending) {
      this.pendingStore.delete('mail_write', context.chatId, context.senderId);
      return { handled: true, text: '已取消，本次邮件不会发送。' };
    }
    if (confirmation) return pending ? this._confirm(context, pending) : { handled: false };
    const mailbox = await this._mailbox();
    if (!mailbox) return { handled: true, text: '无法唯一确定企业邮箱账号，邮件操作已停止。' };
    if (intent.kind === 'search') return this._search(context, intent, mailbox);
    if (intent.kind === 'open') return this._open(context, intent);
    if (intent.draft) return this._prepareWrite(context, intent, mailbox);
    return { handled: false };
  }
}
