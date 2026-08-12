import {
  buildDingTalkHistoryArgs,
  normalizeConversationHistory,
} from './conversation-context.mjs';
import { basename, isAbsolute } from 'node:path';

export function isSupportedDwsExecutable(value) {
  const executable = String(value || '').trim();
  if (!isAbsolute(executable) || basename(executable) !== 'dws') return false;
  const normalized = executable.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('wukong')) return false;
  if (/(?:^|\/)\.real(?:\/|$)/u.test(normalized)) return false;
  if (/\/\.bin\/dws\/bin\/dws$/u.test(normalized)) return false;
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

function isCrossOrgPermissionDenied(root) {
  const marker = [
    root?.error?.code,
    root?.code,
    root?.error?.message,
    root?.message,
  ].map(value => String(value || '')).join(' ');
  return /\bCrossOrgPermissionDenied\b/i.test(marker);
}

function buildCrossOrgAuthorizationArgs(profile) {
  return [
    'chat', 'data-auth', 'cross-org', '--all',
    '--grant-type', 'timed', '--ttl', '24h',
    '--format', 'json', '--profile', profile, '-y',
  ];
}

function safeErrorCategory(error) {
  if (error instanceof ConversationHistoryError) return error.code;
  const detail = String(error?.message || error || '').toLowerCase();
  if (/timeout|timed out/.test(detail)) return 'DWS_HISTORY_TIMEOUT';
  return 'DWS_HISTORY_PROCESS_FAILED';
}

export class ConversationContextClient {
  #crossOrgAuthorizationPromise = null;

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

  async runDws(args) {
    return this.runner(this.bin, args, {
      cwd: this.cwd,
      env: this.env,
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
  }

  async authorizeCrossOrgHistory() {
    if (this.#crossOrgAuthorizationPromise) return this.#crossOrgAuthorizationPromise;
    const startedAt = Date.now();
    this.audit('conversation_cross_org_authorization_requested', {});
    this.#crossOrgAuthorizationPromise = (async () => {
      try {
        const processResult = await this.runDws(buildCrossOrgAuthorizationArgs(this.profile));
        let root;
        try {
          root = JSON.parse(String(processResult?.stdout || ''));
        } catch (error) {
          throw new ConversationHistoryError(
            'DWS cross-organization authorization returned invalid JSON',
            'CROSS_ORG_AUTHORIZATION_FAILED',
            { cause: error },
          );
        }
        if (root?.success === false || root?.error) {
          throw new ConversationHistoryError(
            `DWS cross-organization authorization failed: ${providerMessage(root, 'provider rejected the request')}`,
            'CROSS_ORG_AUTHORIZATION_FAILED',
          );
        }
        this.audit('conversation_cross_org_authorization_granted', {
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        const wrapped = error instanceof ConversationHistoryError
          ? error
          : new ConversationHistoryError(
              `DWS cross-organization authorization failed: ${String(error?.message || error)}`,
              'CROSS_ORG_AUTHORIZATION_FAILED',
              { cause: error },
            );
        this.audit('conversation_cross_org_authorization_failed', {
          durationMs: Date.now() - startedAt,
          errorCategory: wrapped.code,
        });
        throw wrapped;
      }
    })().finally(() => {
      this.#crossOrgAuthorizationPromise = null;
    });
    return this.#crossOrgAuthorizationPromise;
  }

  async fetch(context = {}) {
    const startedAt = Date.now();
    try {
      if (!isSupportedDwsExecutable(this.bin)) {
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
        processResult = await this.runDws(args);
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
      if (isCrossOrgPermissionDenied(root)) {
        await this.authorizeCrossOrgHistory();
        try {
          processResult = await this.runDws(args);
        } catch (error) {
          throw new ConversationHistoryError(
            `DWS history process failed after cross-organization authorization: ${String(error?.message || error)}`,
            'CONVERSATION_HISTORY_UNAVAILABLE',
            { cause: error },
          );
        }
        try {
          root = JSON.parse(String(processResult?.stdout || ''));
        } catch (error) {
          throw new ConversationHistoryError(
            'DWS history returned invalid JSON after cross-organization authorization',
            undefined,
            { cause: error },
          );
        }
      }
      if (root?.success === false || root?.error) {
        throw new ConversationHistoryError(
          `DWS history failed: ${providerMessage(root, 'provider rejected the request')}`,
        );
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
