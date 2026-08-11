import { isSupportedDwsExecutable } from './conversation-context-client.mjs';
import { runBufferedProcess } from './process-runner.mjs';

const DELIVERY_STATUSES = new Set([
  'none', 'posting', 'partial_success', 'success', 'failed', 'unknown',
]);

export class DwsMailError extends Error {
  constructor(message, code = 'DWS_MAIL_UNAVAILABLE', options = {}) {
    super(message, options);
    this.name = 'DwsMailError';
    this.code = code;
  }
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new DwsMailError(`DWS mail ${label} is required`, 'DWS_MAIL_INVALID_INPUT');
  return text;
}

function boundedLimit(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new DwsMailError('DWS mail limit must be a positive integer', 'DWS_MAIL_INVALID_INPUT');
  }
  return Math.min(parsed, 30);
}

function unwrap(root) {
  return root?.result ?? root?.data ?? root ?? {};
}

function address(value) {
  if (!value) return { email: '', name: '' };
  if (typeof value === 'string') return { email: value, name: '' };
  return {
    email: String(value.email || value.address || '').trim(),
    name: String(value.name || value.displayName || '').trim(),
  };
}

function recipients(value) {
  return (Array.isArray(value) ? value : []).map(address).filter(item => item.email || item.name);
}

function normalizeMailboxes(root) {
  const body = unwrap(root);
  const items = body.emailAccounts || body.mailboxes || [];
  if (!Array.isArray(items)) {
    throw new DwsMailError('DWS mailbox response has no account list', 'DWS_MAIL_INVALID_RESPONSE');
  }
  return items.map(item => ({
    email: String(item?.email || item?.address || '').trim(),
    type: String(item?.type || '').trim(),
    orgName: String(item?.orgName || item?.organizationName || '').trim(),
  })).filter(item => item.email);
}

function normalizeSearch(root) {
  const body = unwrap(root);
  const items = body.messages || body.items || [];
  if (!Array.isArray(items)) {
    throw new DwsMailError('DWS mail search response has no message list', 'DWS_MAIL_INVALID_RESPONSE');
  }
  return {
    messages: items.map(item => ({
      id: String(item?.id || item?.messageId || item?.message_id || '').trim(),
      subject: String(item?.subject || '').trim(),
      from: address(item?.from || item?.sender),
      receivedDateTime: String(item?.receivedDateTime || item?.date || item?.sentDateTime || '').trim(),
      isRead: item?.isRead === true,
      hasAttachments: item?.hasAttachments === true,
      conversationId: String(item?.conversationId || '').trim(),
    })).filter(item => item.id),
    nextCursor: String(body.nextCursor || ''),
    total: Number(body.total || 0),
  };
}

function normalizeMessage(root) {
  const body = unwrap(root);
  const item = body.message || body;
  if (!item || typeof item !== 'object') {
    throw new DwsMailError('DWS mail response has no message', 'DWS_MAIL_INVALID_RESPONSE');
  }
  const id = String(item.id || item.messageId || '').trim();
  if (!id) throw new DwsMailError('DWS mail response has no message id', 'DWS_MAIL_INVALID_RESPONSE');
  return {
    id,
    subject: String(item.subject || '').trim(),
    from: address(item.from || item.sender),
    to: recipients(item.toRecipients || item.to),
    cc: recipients(item.ccRecipients || item.cc),
    markdownBody: String(item.markdownBody || item.body || item.content || ''),
    receivedDateTime: String(item.receivedDateTime || item.sentDateTime || '').trim(),
    conversationId: String(item.conversationId || '').trim(),
  };
}

function normalizeWrite(root) {
  const body = unwrap(root);
  const message = body?.message || body || {};
  const internetMessageId = String(
    body?.internetMessageId || message?.internetMessageId || root?.internetMessageId || '',
  ).trim();
  return {
    internetMessageId,
    messageId: String(message?.id || body?.messageId || '').trim(),
  };
}

function normalizeUsers(root) {
  const body = unwrap(root);
  const items = body.users || body.items || body.list || [];
  if (!Array.isArray(items)) {
    throw new DwsMailError('DWS user response has no user list', 'DWS_MAIL_INVALID_RESPONSE');
  }
  return items.map(item => ({
    id: String(item?.id || item?.userId || item?.userid || '').trim(),
    email: String(item?.email || item?.mail || '').trim(),
    name: String(item?.name || item?.nickname || item?.displayName || '').trim(),
  })).filter(item => item.id || item.email);
}

export function normalizeDeliveryStatus(root) {
  const value = String(
    root?.result?.message?.sendStatus
    || root?.message?.sendStatus
    || root?.result?.sendStatus
    || root?.sendStatus
    || '',
  ).trim().toLowerCase();
  return DELIVERY_STATUSES.has(value) ? value : 'unknown';
}

function safeCategory(error) {
  if (error instanceof DwsMailError) return error.code;
  const detail = String(error?.message || error || '').toLowerCase();
  return /timeout|timed out/.test(detail) ? 'DWS_MAIL_TIMEOUT' : 'DWS_MAIL_PROCESS_FAILED';
}

export class DwsMailClient {
  constructor({
    bin,
    profile,
    transport,
    env = {},
    cwd,
    runner = runBufferedProcess,
    timeoutMs = 30_000,
    audit = () => {},
  } = {}) {
    this.bin = String(bin || '');
    this.profile = String(profile || '');
    this.transport = String(transport || '');
    this.env = env;
    this.cwd = cwd;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.audit = typeof audit === 'function' ? audit : () => {};
  }

  _validate() {
    if (!isSupportedDwsExecutable(this.bin)) {
      throw new DwsMailError(
        'Mail requires the configured standalone DWS installation',
        'DWS_MAIL_PATH_REJECTED',
      );
    }
    if (this.transport !== 'event-stream') {
      throw new DwsMailError(
        'Mail requires the existing DWS event-stream transport',
        'DWS_MAIL_TRANSPORT_REJECTED',
      );
    }
    if (typeof this.runner !== 'function') {
      throw new DwsMailError('DWS mail runner is unavailable');
    }
  }

  async _run(action, args, normalize) {
    const startedAt = Date.now();
    try {
      this._validate();
      const fullArgs = [
        ...(this.profile ? ['--profile', this.profile] : []),
        ...args,
        '--format', 'json',
      ];
      const result = await this.runner(this.bin, fullArgs, {
        cwd: this.cwd,
        env: this.env,
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: 1024 * 1024,
      });
      let root;
      try {
        root = JSON.parse(String(result?.stdout || ''));
      } catch (error) {
        throw new DwsMailError(
          'DWS mail returned invalid JSON',
          'DWS_MAIL_INVALID_JSON',
          { cause: error },
        );
      }
      if (root?.success === false || root?.error) {
        const message = String(root?.error?.message || root?.message || 'provider rejected the request');
        throw new DwsMailError(`DWS mail provider failed: ${message}`, 'DWS_MAIL_PROVIDER_ERROR');
      }
      const normalized = normalize(root);
      const count = Array.isArray(normalized)
        ? normalized.length
        : Array.isArray(normalized?.messages) ? normalized.messages.length : undefined;
      this.audit(`dws_mail_${action}`, {
        durationMs: Date.now() - startedAt,
        status: 'success',
        ...(count === undefined ? {} : { count }),
      });
      return normalized;
    } catch (error) {
      const wrapped = error instanceof DwsMailError
        ? error
        : new DwsMailError(
            `DWS mail process failed: ${String(error?.message || error)}`,
            safeCategory(error),
            { cause: error },
          );
      this.audit(`dws_mail_${action}_failed`, {
        durationMs: Date.now() - startedAt,
        status: 'failed',
        errorCategory: safeCategory(wrapped),
      });
      throw wrapped;
    }
  }

  listMailboxes() {
    return this._run('mailbox_list', ['mail', 'mailbox', 'list'], normalizeMailboxes);
  }

  searchMessages({ email, query, limit = 10, cursor = '' } = {}) {
    return this._run('search', [
      'mail', 'message', 'search',
      '--email', required(email, 'email'),
      '--query', required(query, 'query'),
      '--limit', String(boundedLimit(limit)),
      ...(cursor ? ['--cursor', String(cursor)] : []),
    ], normalizeSearch);
  }

  getMessage({ email, id } = {}) {
    return this._run('get', [
      'mail', 'message', 'get',
      '--email', required(email, 'email'),
      '--id', required(id, 'message id'),
    ], normalizeMessage);
  }

  searchMailUsers({ email, keyword, limit = 10 } = {}) {
    return this._run('user_search', [
      'mail', 'user', 'search',
      '--email', required(email, 'email'),
      '--keyword', required(keyword, 'user keyword'),
      '--limit', String(boundedLimit(limit)),
    ], normalizeUsers);
  }

  searchContactUsers({ query } = {}) {
    return this._run('contact_search', [
      'contact', 'user', 'search', '--query', required(query, 'contact query'),
    ], normalizeUsers);
  }

  sendMessage({ from, to = [], cc = [], subject, content } = {}) {
    const recipientsTo = (Array.isArray(to) ? to : [to]).map(String).map(value => value.trim()).filter(Boolean);
    const recipientsCc = (Array.isArray(cc) ? cc : [cc]).map(String).map(value => value.trim()).filter(Boolean);
    if (!recipientsTo.length) {
      throw new DwsMailError('DWS mail recipients are required', 'DWS_MAIL_INVALID_INPUT');
    }
    return this._run('send', [
      'mail', 'message', 'send',
      '--from', required(from, 'sender'),
      '--to', recipientsTo.join(','),
      ...(recipientsCc.length ? ['--cc', recipientsCc.join(',')] : []),
      '--subject', required(subject, 'subject'),
      '--content', required(content, 'content'),
      '--yes',
    ], normalizeWrite);
  }

  replyMessage({ from, id, content, subject = '' } = {}) {
    return this._run('reply', [
      'mail', 'message', 'reply', '--from', required(from, 'sender'),
      '--id', required(id, 'message id'),
      ...(subject ? ['--subject', String(subject)] : []),
      '--content', required(content, 'content'), '--yes',
    ], normalizeWrite);
  }

  replyAllMessage({ from, id, content, subject = '' } = {}) {
    return this._run('reply_all', [
      'mail', 'message', 'reply-all', '--from', required(from, 'sender'),
      '--id', required(id, 'message id'),
      ...(subject ? ['--subject', String(subject)] : []),
      '--content', required(content, 'content'), '--yes',
    ], normalizeWrite);
  }

  forwardMessage({ from, id, to = [], content = '', subject = '' } = {}) {
    const recipientList = (Array.isArray(to) ? to : [to]).map(String).map(value => value.trim()).filter(Boolean);
    if (!recipientList.length) throw new DwsMailError('DWS mail recipients are required', 'DWS_MAIL_INVALID_INPUT');
    return this._run('forward', [
      'mail', 'message', 'forward', '--from', required(from, 'sender'),
      '--id', required(id, 'message id'), '--to', recipientList.join(','),
      ...(subject ? ['--subject', String(subject)] : []),
      ...(content ? ['--content', String(content)] : []), '--yes',
    ], normalizeWrite);
  }

  verifyDelivery({ email, internetMessageId } = {}) {
    return this._run('verify', [
      'mail', 'message', 'verify',
      '--email', required(email, 'email'),
      '--internet-message-id', required(internetMessageId, 'internet message id'),
    ], normalizeDeliveryStatus);
  }
}
