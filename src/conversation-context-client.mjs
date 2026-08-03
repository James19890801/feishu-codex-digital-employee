import {
  buildDingTalkHistoryArgs,
  normalizeConversationHistory,
} from './conversation-context.mjs';

export const ORIGINAL_DWS_BIN = '/Users/fengzhouchong.fzc/.npm-global/bin/dws';

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

function safeErrorCategory(error) {
  if (error instanceof ConversationHistoryError) return error.code;
  const detail = String(error?.message || error || '').toLowerCase();
  if (/timeout|timed out/.test(detail)) return 'DWS_HISTORY_TIMEOUT';
  return 'DWS_HISTORY_PROCESS_FAILED';
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

  async fetch(context = {}) {
    const startedAt = Date.now();
    try {
      if (this.bin !== ORIGINAL_DWS_BIN) {
        throw new ConversationHistoryError(
          'Conversation history must use the original DWS installation',
          'DWS_PATH_REJECTED',
        );
      }
      if (this.transport !== 'event-stream') {
        throw new ConversationHistoryError(
          'Conversation history requires the existing DWS event-stream transport',
          'DWS_TRANSPORT_REJECTED',
        );
      }
      if (typeof this.runner !== 'function') {
        throw new ConversationHistoryError('DWS history runner is unavailable');
      }
      const args = buildDingTalkHistoryArgs(
        { kind: context.kind, targetId: context.targetId },
        { beforeTime: context.beforeTime, profile: this.profile },
      );
      let processResult;
      try {
        processResult = await this.runner(this.bin, args, {
          cwd: this.cwd,
          env: this.env,
          timeoutMs: this.timeoutMs,
          maxStdoutBytes: 8 * 1024 * 1024,
          maxStderrBytes: 1024 * 1024,
        });
      } catch (error) {
        throw new ConversationHistoryError(
          `DWS history process failed: ${String(error?.message || error)}`,
          'CONVERSATION_HISTORY_UNAVAILABLE',
          { cause: error },
        );
      }
      let root;
      try {
        root = JSON.parse(String(processResult?.stdout || ''));
      } catch (error) {
        throw new ConversationHistoryError('DWS history returned invalid JSON', undefined, { cause: error });
      }
      if (root?.success === false || root?.error) {
        const providerMessage = String(root?.error?.message || root?.message || 'provider rejected the request');
        throw new ConversationHistoryError(`DWS history failed: ${providerMessage}`);
      }
      if (!hasMessageList(root)) {
        throw new ConversationHistoryError('DWS history response has no message list');
      }
      const normalized = normalizeConversationHistory(root, {
        conversationId: context.conversationId,
        ownerIds: this.ownerIds,
        ownerNames: this.ownerNames,
        currentMessage: context.currentMessage,
      });
      if (!normalized.currentMessage || !normalized.latestCounterpartyMessage) {
        throw new ConversationHistoryError('DWS history could not validate the current message');
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
            `DWS history unavailable: ${String(error?.message || error)}`,
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
