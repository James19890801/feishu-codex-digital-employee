import {
  buildEnterpriseChatHistoryArgs,
  normalizeConversationHistory,
} from './conversation-context.mjs';
import { basename, isAbsolute } from 'node:path';

export function isSupportedConnectorExecutable(value) {
  const executable = String(value || '').trim();
  if (!isAbsolute(executable) || basename(executable) !== 'connector') return false;
  const normalized = executable.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('legacyBridge')) return false;
  if (/(?:^|\/)\.real(?:\/|$)/u.test(normalized)) return false;
  if (/\/\.bin\/connector\/bin\/connector$/u.test(normalized)) return false;
  return true;
}

export class ConversationHistoryError extends Error {
  constructor(message, code = 'CONVERSATION_HISTORY_UNAVAILABLE', options = {}) {
    super(message, options);
    this.name = 'ConversationHistoryError';
    this.code = code;
  }
}

function hasMessageList(result) {
  return [
    result?.result?.messages,
    result?.result?.messageList,
    result?.data?.messages,
    result?.data?.messageList,
    result?.messages,
    result?.messageList,
  ].some(Array.isArray);
}

function providerMessage(root, fallback) {
  return String(root?.error?.message || root?.message || fallback);
}

function safeErrorCategory(error) {
  if (error instanceof ConversationHistoryError) return error.code;
  const detail = String(error?.message || error || '').toLowerCase();
  if (/timeout|timed out/.test(detail)) return 'CONNECTOR_HISTORY_TIMEOUT';
  return 'CONNECTOR_HISTORY_PROCESS_FAILED';
}

export class ConversationContextClient {
  constructor({
    bin,
    profile,
    transport,
    env = {},
    cwd,
    ownerIds = [],
    ownerNames = [],
    runner,
    timeoutMs = 30_000,
    audit = () => {},
  } = {}) {
    this.bin = String(bin || '');
    this.profile = String(profile || '');
    this.transport = String(transport || '');
    this.env = env;
    this.cwd = cwd;
    this.ownerIds = ownerIds;
    this.ownerNames = ownerNames;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.audit = typeof audit === 'function' ? audit : () => {};
  }

  async runConnector(args) {
    return this.runner(this.bin, args, {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
  }

  async fetch(context = {}) {
    const startedAt = Date.now();
    try {
      if (!isSupportedConnectorExecutable(this.bin)) {
        throw new ConversationHistoryError(
          'Conversation history must use the original CONNECTOR installation',
          'CONNECTOR_PATH_REJECTED',
        );
      }
      if (this.transport !== 'event-stream') {
        throw new ConversationHistoryError(
          'Conversation history requires the existing CONNECTOR event-stream transport',
          'CONNECTOR_TRANSPORT_REJECTED',
        );
      }
      if (typeof this.runner !== 'function') {
        throw new ConversationHistoryError('CONNECTOR history runner is unavailable');
      }
      const args = buildEnterpriseChatHistoryArgs(
        { kind: context.kind, targetId: context.targetId },
        { beforeTime: context.beforeTime, profile: this.profile },
      );
      let processResult;
      try {
        processResult = await this.runConnector(args);
      } catch (error) {
        throw new ConversationHistoryError(
          `CONNECTOR history process failed: ${String(error?.message || error)}`,
          'CONVERSATION_HISTORY_UNAVAILABLE',
          { cause: error },
        );
      }
      let root;
      try {
        root = JSON.parse(String(processResult?.stdout || ''));
      } catch (error) {
        throw new ConversationHistoryError('CONNECTOR history returned invalid JSON', undefined, { cause: error });
      }
      if (root?.success === false || root?.error) {
        throw new ConversationHistoryError(
          `CONNECTOR history failed: ${providerMessage(root, 'provider rejected the request')}`,
        );
      }
      if (!hasMessageList(root)) {
        throw new ConversationHistoryError('CONNECTOR history response has no message list');
      }
      const normalized = normalizeConversationHistory(root, {
        conversationId: context.conversationId,
        ownerIds: this.ownerIds,
        ownerNames: this.ownerNames,
        currentMessage: context.currentMessage,
      });
      if (!normalized.currentMessage || !normalized.latestCounterpartyMessage) {
        throw new ConversationHistoryError('CONNECTOR history could not validate the current message');
      }
      this.audit('conversation_history_read', {
        durationMs: Date.now() - startedAt,
        messageCount: normalized.messages.length,
        styleSampleCount: normalized.styleSamples.length,
      });
      return normalized;
    } catch (error) {
      const wrapped = error instanceof ConversationHistoryError
        ? error
        : new ConversationHistoryError(
            `CONNECTOR history unavailable: ${String(error?.message || error)}`,
            'CONVERSATION_HISTORY_UNAVAILABLE',
            { cause: error },
          );
      this.audit('conversation_history_failed', {
        durationMs: Date.now() - startedAt,
        errorCategory: safeErrorCategory(wrapped),
      });
      throw wrapped;
    }
  }
}
