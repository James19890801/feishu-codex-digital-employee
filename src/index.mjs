import * as lark from '@larksuiteoapi/node-sdk';
import { spawn } from 'node:child_process';
import { randomBytes, randomInt } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { config, validateCoreConfiguration } from './config.mjs';
import { evaluateLicenseGuard, waitForTerminationSignals } from './licensing/guard.mjs';
import { LicensingStore } from './licensing/store.mjs';
import { runtimeMode } from './runtime-mode.mjs';
import {
  canReadDocument,
  extractKnowledgeQuery,
  looksLikeKnowledgeRequest,
  normalizeKnowledgeCatalog,
  resolveCatalogDocument,
  sourceLine,
  stripHighlight,
  tokenFromSearchResult,
} from './knowledge.mjs';
import { AgentState } from './state.mjs';
import {
  hasSelfChatOutboundMarker,
  markSelfChatOutbound,
} from './self-chat-guard.mjs';
import { decideWorkflow, workflowInstruction } from './bible.mjs';
import { PendingActionStore } from './pending-actions.mjs';
import { rotateLogIfNeeded } from './log-maintenance.mjs';
import { createVerifiedDatabaseBackup } from './database-backup.mjs';
import { SerialKeyQueue } from './serial-key-queue.mjs';
import { InterruptibleDelay } from './interruptible-delay.mjs';
import { acquireSingletonLock } from './singleton-lock.mjs';
import {
  consumeLinesUntilExit,
  shouldRetrySupervisor,
} from './event-consumer.mjs';
import {
  buildOwnerControlPollingArgs,
  buildPollingSearchArgs,
  buildSelfChatPollingArgs,
  comparePollingItems,
  markSelfChatMessages,
  normalizeSearchMessage,
  pollFailureDelayMs,
  retryDelayMs,
  selectOwnerActivityMessages,
  selectInboundMessages,
  shouldRetryMessage,
  toLarkSearchIso,
} from './polling.mjs';
import {
  processFailureSummary,
  runBufferedProcess,
  terminateAllBufferedProcesses,
} from './process-runner.mjs';
import {
  buildHelpReply,
  buildStatusReply,
  matchOperatorCommand,
} from './operator-commands.mjs';
import {
  refersToRecentFiles,
  refersToRecentImages,
  requestedImageLimit,
  selectRecentFileRef,
  selectRecentImageRefs,
} from './media-context.mjs';
import {
  assertCompleteSearchResult,
  canPerformMutation,
  effectiveTask,
  initializeOptionalPoller,
  isBareMention,
  planPollWindow,
  validateInboundPayload,
} from './reliability.mjs';
import { MulticaClient } from './multica-client.mjs';
import {
  buildMulticaPlannerPrompt,
  looksLikeMulticaRequest,
  normalizeMulticaPlan,
  parseMulticaPlannerOutput,
} from './multica-planner.mjs';
import { MulticaCapability } from './multica-capability.mjs';
import { isAuthorizedMulticaOwner } from './multica-access.mjs';
import {
  isFeedbackCancellation,
  looksLikeMulticaFeedback,
  MulticaFeedbackWorkflow,
} from './multica-feedback.mjs';
import { MulticaSynchronizer } from './multica-sync.mjs';
import {
  MulticaWorkLifecycle,
  parseMulticaWorkRequest,
} from './multica-work-lifecycle.mjs';
import { multicaIssueUrl } from './multica-links.mjs';
import {
  buildPrivacyBoundary,
  knowledgeMemoryLabel,
  ownerHandoffReply,
} from './privacy-boundary.mjs';
import {
  MutationOutcomeAmbiguousError,
  executeMutationOnce,
} from './mutation-execution.mjs';
import {
  AiRuntimeClient,
  discoverAiRuntimes,
  selectAiRuntime,
} from './ai-runtime.mjs';
import {
  buildDingTalkConversationPollingArgs,
  buildDingTalkProcessEnv,
  buildDingTalkSelfPollingArgs,
  normalizeDingTalkSelfMessages,
  parseChannelChatId,
  prepareGroupMention,
} from './im-channels.mjs';
import {
  applyOwnerActivityHistory,
  evaluateHumanTakeover,
  humanTakeoverStatus,
  takeoverSyncFailurePolicy,
} from './human-takeover.mjs';
import {
  buildFirstTakeoverGreeting,
  enforceReplyLength,
  replyLengthPolicy,
  shouldIntroduceAssistant,
} from './conversation-etiquette.mjs';
import {
  DingTalkChannel,
  GeWeChannel,
  GeWeWebhookServer,
  WeComChannel,
} from './im-channel-runtime.mjs';
import { fetchDingTalkWukongWindow } from './dingtalk-wukong-poller.mjs';
import { buildIdentityInstruction } from './identity-policy.mjs';
import { A1Client } from './a1-client.mjs';
import { A1RequirementWorkflow } from './a1-workflow.mjs';
import { A1Synchronizer } from './a1-sync.mjs';
import {
  buildA1SpecPrompt,
  extractRepositoryPaths,
  parseA1RequirementSpec,
} from './a1-spec-planner.mjs';

const CORE_LICENSE_GUARD = await evaluateLicenseGuard({
  enforced: config.licensingEnforced,
  store: new LicensingStore(),
  publicKey: config.licensingPublicKey,
  product: config.licensingProductId,
});
if (!CORE_LICENSE_GUARD.allowed) {
  console.warn(`[licensing] core held in dashboard-only mode (${CORE_LICENSE_GUARD.reason})`);
  await waitForTerminationSignals();
  process.exit(0);
}
validateCoreConfiguration(config);

const APP_ID = config.feishuAppId;
const OWNER_OPEN_ID = config.ownerOpenId;
const KEYCHAIN_SERVICE = config.keychainService;
const WORKDIR = config.workdir;
const BUNDLED_PYTHON = config.pythonBin;
const FILE_EXTRACTOR = join(WORKDIR, 'src', 'extract_file_text.py');
const DATABASE_BACKUP_DIR = join(WORKDIR, 'data', 'database-backups');
const LARK_CLI = config.larkCli;
const BUNDLED_NODE_BIN = config.nodeBin;
const BIBLE_TEXT = await readFile(join(WORKDIR, 'BIBLE.md'), 'utf8');
const PERSONA_TEXT = await readFile(join(WORKDIR, 'PERSONA.md'), 'utf8');
const PRIVACY_BOUNDARY_TEXT = buildPrivacyBoundary({
  ownerContactPhone: config.ownerContactPhone,
});
const STATE_PATH = join(WORKDIR, 'data', 'agent-state.sqlite');
const CODEX_RUNTIME_DIR = join(WORKDIR, 'data', 'codex-runtime');
const CODEX_HOME_DIR = join(WORKDIR, 'data', 'codex-home');
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DOC_CHARS = 40_000;
const KNOWLEDGE_CATALOG_PATH = join(WORKDIR, 'knowledge-catalog.json');
const KNOWLEDGE_CATALOG = JSON.parse(await readFile(KNOWLEDGE_CATALOG_PATH, 'utf8'));
const KNOWLEDGE_SOURCES = normalizeKnowledgeCatalog(KNOWLEDGE_CATALOG).sources;
await mkdir(CODEX_RUNTIME_DIR, { recursive: true });
await mkdir(CODEX_HOME_DIR, { recursive: true, mode: 0o700 });
const isolatedAuthPath = join(CODEX_HOME_DIR, 'auth.json');
try {
  await lstat(isolatedAuthPath);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  try {
    await symlink(join(process.env.HOME || '', '.codex', 'auth.json'), isolatedAuthPath);
  } catch (symlinkError) {
    if (symlinkError?.code !== 'EEXIST') throw symlinkError;
  }
}
const AI_RUNTIMES = discoverAiRuntimes({ configuredCodexBin: config.codexBin });
const SELECTED_AI_RUNTIME = selectAiRuntime(AI_RUNTIMES, config.aiRuntime);
const AI_RUNTIME_CLIENT = new AiRuntimeClient({
  runtime: SELECTED_AI_RUNTIME,
  env: aiRuntimeEnv(),
});
const singletonLock = await acquireSingletonLock(join(WORKDIR, 'data', 'service.lock'));
const state = new AgentState(STATE_PATH);
const pendingActions = new PendingActionStore(state);
const chatQueues = new SerialKeyQueue();
const AUTHORIZED_CHAT_IDS = new Set(config.authorizedChatIds);
const DIGITAL_TWIN_LABEL = config.digitalTwinLabel;
const POLL_INTERVAL_MS = config.pollIntervalMs;
const RUNTIME_MODE = runtimeMode(config);
const POLL_OVERLAP_MS = config.pollOverlapMs;
const POLL_INITIAL_LOOKBACK_MS = config.pollInitialLookbackMs;
const POLL_MAX_CATCHUP_MS = config.pollMaxCatchupMs;
const POLL_WINDOW_MS = config.pollWindowMs;
const MAX_CONCURRENT_REPLIES = config.maxConcurrentReplies;
const DASHBOARD_URL = `http://127.0.0.1:${config.dashboardPort}`;
const A1_CLIENT = config.a1Enabled
  ? new A1Client({
      bin: config.a1Bin,
      timeoutMs: config.helperTimeoutMs,
      allowedProjectIds: [config.a1WebAgentProjectId, config.a1AiCollaborationProjectId],
    })
  : null;
const A1_WORKFLOW = A1_CLIENT
  ? new A1RequirementWorkflow({
      client: A1_CLIENT,
      pendingStore: pendingActions,
      prepareRequirement: input => prepareA1Requirement(input),
      subscribe: input => state.registerA1Subscription(input),
    })
  : null;
const A1_SYNCHRONIZER = A1_CLIENT
  ? new A1Synchronizer({
      client: A1_CLIENT,
      state,
      notify: (chatId, text, idempotencyKey, recipient) => sendText(
        null,
        chatId,
        text,
        idempotencyKey,
        {
          mentionSenderId: recipient?.senderId || '',
          chatType: recipient?.chatType || '',
        },
      ),
      audit: (event, detail) => state.audit(event, { detail }),
    })
  : null;
const MULTICA_CLIENT = config.multicaEnabled
  ? new MulticaClient({
      bin: config.multicaBin,
      profile: config.multicaProfile,
      defaultWorkspaceId: config.multicaDefaultWorkspaceId,
      timeoutMs: config.helperTimeoutMs,
      maxIssues: config.multicaMaxIssues,
    })
  : null;
const MULTICA_OWNER_IDENTITIES = {
  ownerOpenId: config.ownerOpenId,
  dingtalkOwnerOpenId: config.dingtalkOwnerOpenId,
};
const authorizeMulticaWrite = context => isAuthorizedMulticaOwner(
  context,
  MULTICA_OWNER_IDENTITIES,
);
const MULTICA_CAPABILITY = MULTICA_CLIENT
  ? new MulticaCapability({
      client: MULTICA_CLIENT,
      state,
      appUrl: config.multicaAppUrl,
      authorizeWrite: authorizeMulticaWrite,
    })
  : null;
const MULTICA_WORK_LIFECYCLE = MULTICA_CLIENT
  ? new MulticaWorkLifecycle({
      client: MULTICA_CLIENT,
      state,
      authorizeWrite: authorizeMulticaWrite,
    })
  : null;
const MULTICA_FEEDBACK_WORKFLOW = MULTICA_CLIENT
  ? new MulticaFeedbackWorkflow({
      client: MULTICA_CLIENT,
      state,
      workspaceId: config.multicaDefaultWorkspaceId,
      ownerSquad: config.multicaOwnerSquad,
      appUrl: config.multicaAppUrl,
      authorizeOwner: authorizeMulticaWrite,
      audit: (event, detail) => state.audit(event, { detail }),
    })
  : null;
const MULTICA_SYNCHRONIZER = MULTICA_CLIENT
  ? new MulticaSynchronizer({
      client: MULTICA_CLIENT,
      state,
      notify: (chatId, text, idempotencyKey, recipient) => sendText(
        null,
        chatId,
        text,
        idempotencyKey,
        {
          mentionSenderId: recipient?.senderId || '',
          chatType: recipient?.chatType || '',
        },
      ),
      audit: (event, detail) => state.audit(event, { detail }),
      appUrl: config.multicaAppUrl,
      ownerRecipient: config.dingtalkEnabled && config.dingtalkOwnerOpenId
        ? {
            chatId: `dingtalk:user:${config.dingtalkOwnerOpenId}`,
            senderId: `dingtalk:${config.dingtalkOwnerOpenId}`,
            chatType: 'p2p',
          }
        : null,
    })
  : null;
let stopping = false;
let activeEventChild = null;
let activeDingTalkChild = null;
let activeSdkWsClient = null;
let drainPromise = null;
let multicaSyncPromise = null;
let a1SyncPromise = null;
let dingTalkSupervisorPromise = null;
let dingTalkSelfPollingPromise = null;
let geWeMonitorPromise = null;
let businessClient = null;
let sdkAppSecret = '';
let dingTalkChannel = null;
let weComChannel = null;
let geWeChannel = null;
let geWeWebhookServer = null;
const shutdownDelay = new InterruptibleDelay();

function remember(chatId, senderOpenId, role, content) {
  state.remember(chatId, senderOpenId, role, content);
}

function formatHistory(chatId, senderOpenId) {
  const history = state.history(chatId, senderOpenId, 12);
  if (!history.length) return '（这是当前运行周期内的第一条消息）';
  return history.map(item => `${item.role === 'user' ? '对方' : '助理'}：${item.content}`).join('\n');
}

function multicaContext(message, senderOpenId, metadata = {}) {
  const context = {
    chatId: message.chat_id,
    senderId: senderOpenId,
    chatType: message.chat_type,
    metadata: structuredClone(metadata || {}),
  };
  return {
    ...context,
    ownerAuthorized: authorizeMulticaWrite(context),
  };
}

function audit(event, message, senderOpenId, detail = {}) {
  state.audit(event, {
    chatId: message?.chat_id || '', senderId: senderOpenId,
    messageId: message?.message_id || '', detail,
  });
}

function larkCliEnv() {
  return {
    ...process.env,
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
    PATH: `${BUNDLED_NODE_BIN}:${join(process.env.HOME || '', '.local/bin')}:${process.env.PATH || ''}`,
  };
}

function aiRuntimeEnv() {
  const env = {
    ...process.env,
  };
  if (SELECTED_AI_RUNTIME?.id === 'codex') env.CODEX_HOME = CODEX_HOME_DIR;
  if (config.codexProxyUrl) {
    env.HTTP_PROXY = config.codexProxyUrl;
    env.HTTPS_PROXY = config.codexProxyUrl;
    env.ALL_PROXY = config.codexProxyUrl;
  }
  return env;
}

async function runLarkCli(args, options = {}) {
  const { stdout, stderr } = await runBufferedProcess(LARK_CLI, args, {
    cwd: options.cwd || WORKDIR,
    env: larkCliEnv(),
    timeoutMs: options.timeoutMs || config.larkCliTimeoutMs,
    maxStdoutBytes: 8 * 1024 * 1024,
    maxStderrBytes: 1024 * 1024,
    input: options.input,
    completeOnStdout: stdout => {
      try {
        const parsed = JSON.parse(stdout);
        return typeof parsed?.ok === 'boolean';
      } catch {
        return false;
      }
    },
  });
  let result;
  try { result = JSON.parse(stdout); } catch {
    throw new Error(`lark-cli returned invalid JSON: ${(stderr || stdout).slice(-800)}`);
  }
  if (!result.ok || result.identity !== 'user') {
    throw new Error(`lark-cli user action failed: ${JSON.stringify(result.error || result).slice(0, 1000)}`);
  }
  return result;
}

function labelDigitalTwin(text) {
  if (!DIGITAL_TWIN_LABEL) return text;
  return text.startsWith(DIGITAL_TWIN_LABEL) ? text : `${DIGITAL_TWIN_LABEL}\n${text}`;
}

function outboundMessageId(result, depth = 0) {
  if (!result || typeof result !== 'object' || depth > 5) return '';
  for (const key of ['message_id', 'messageId', 'openMessageId', 'open_message_id', 'msg_id', 'msgId']) {
    if (typeof result[key] === 'string' && result[key].trim()) return result[key].trim();
  }
  for (const value of Object.values(result)) {
    const found = outboundMessageId(value, depth + 1);
    if (found) return found;
  }
  return '';
}

async function sendWithEchoGuard(chatId, text, operation) {
  const echoId = state.recordOutboundEcho(chatId, text);
  try {
    const result = await operation();
    const messageId = outboundMessageId(result);
    if (messageId) {
      state.attachOutboundMessageId(echoId, messageId);
      state.seedInbound(messageId, 'outbound-send', {
        message: {
          message_id: messageId,
          chat_id: chatId,
          chat_type: 'p2p',
          message_type: 'text',
          create_time: String(Date.now()),
          content: JSON.stringify({ text }),
          mentions: [],
        },
        sender: { sender_type: 'user', sender_id: { open_id: OWNER_OPEN_ID } },
        metadata: { outbound: true },
      });
    }
    return result;
  } catch (error) {
    state.cancelOutboundEcho(echoId);
    throw error;
  }
}

async function getSecret() {
  const { stdout } = await runBufferedProcess('/usr/bin/security', [
    'find-generic-password', '-a', APP_ID, '-s', KEYCHAIN_SERVICE, '-w',
  ], { timeoutMs: 10_000, maxStdoutBytes: 64 * 1024, maxStderrBytes: 64 * 1024 });
  return stdout.trim();
}

async function getKeychainSecret(service, account) {
  const { stdout } = await runBufferedProcess('/usr/bin/security', [
    'find-generic-password', '-a', account, '-s', service, '-w',
  ], {
    timeoutMs: 10_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  return stdout.trim();
}

async function ensureKeychainSecret(service, account) {
  try {
    return await getKeychainSecret(service, account);
  } catch (error) {
    const summary = processFailureSummary(error);
    if (!/could not be found|item not found|SecKeychainSearchCopyNext/i.test(summary)) throw error;
  }
  const secret = randomBytes(32).toString('base64url');
  await runBufferedProcess('/usr/bin/security', [
    'add-generic-password', '-U', '-a', account, '-s', service, '-w', secret,
  ], {
    timeoutMs: 10_000,
    maxStdoutBytes: 64 * 1024,
    maxStderrBytes: 64 * 1024,
  });
  return secret;
}

function cleanTask(text) {
  return text
    .replace(/^@_user_\d+\s*/i, '')
    .replace(/^@[^\s]+\s*/, '')
    .trim();
}

function parsePost(content) {
  const blocks = Array.isArray(content?.content) ? content.content.flat() : [];
  return {
    text: blocks.filter(item => item?.tag === 'text').map(item => item.text || '').join('\n').trim(),
    imageKeys: blocks.filter(item => item?.tag === 'img' && item.image_key).map(item => item.image_key),
  };
}

async function listRecentChatMessages(client, message) {
  const response = await client.im.message.list({
    params: {
      container_id_type: 'chat',
      container_id: message.chat_id,
      page_size: 50,
      sort_type: 'ByCreateTimeDesc',
      user_id_type: 'open_id',
    },
  });
  if (response.code !== 0) throw new Error(`Feishu message history failed: ${response.code ?? 'unknown'} ${response.msg || ''}`);
  return response.data?.items || [];
}

async function findRecentImageRefs(client, message, senderOpenId, requestText) {
  return selectRecentImageRefs(await listRecentChatMessages(client, message), {
    senderOpenId,
    currentTime: Number(message.create_time || Date.now()),
    limit: requestedImageLimit(requestText),
  });
}

async function findRecentFileRef(client, message, senderOpenId, { includeCurrent = false } = {}) {
  const currentTime = Number(message.create_time || Date.now());
  return selectRecentFileRef(await listRecentChatMessages(client, message), {
    senderOpenId,
    currentTime: currentTime + (includeCurrent ? 1 : 0),
  });
}

async function extractFileText(filePath) {
  const info = await stat(filePath);
  if (info.size > MAX_FILE_BYTES) throw new Error('File exceeds 20 MB limit');
  const { stdout } = await runBufferedProcess(BUNDLED_PYTHON, [FILE_EXTRACTOR, filePath], {
    timeoutMs: config.helperTimeoutMs,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 256 * 1024,
  });
  return JSON.parse(stdout).text || '';
}

function resolveFeishuDocRequest(text) {
  const result = resolveCatalogDocument(text, KNOWLEDGE_CATALOG);
  if (!result) return null;
  if (result.denied) return result;
  return { documentId: result.token, ...result };
}

async function readAllowedFeishuDoc(client, documentId) {
  const response = await client.docx.document.rawContent({ path: { document_id: documentId } });
  if (response.code !== 0 || !response.data?.content) {
    throw new Error(`Feishu doc read failed: ${response.code ?? 'unknown'} ${response.msg || ''}`);
  }
  return response.data.content.slice(0, MAX_DOC_CHARS);
}

async function searchFeishuKnowledge(client, text, senderOpenId) {
  const catalogMatch = resolveFeishuDocRequest(text);
  if (catalogMatch?.denied) return { denied: true, reason: 'not_allowlisted' };
  if (catalogMatch?.documentId) {
    if (!canReadDocument(catalogMatch, senderOpenId, OWNER_OPEN_ID)) {
      return { denied: true, reason: 'reader_not_allowed', document: catalogMatch };
    }
    return { documents: [catalogMatch] };
  }
  if (!looksLikeKnowledgeRequest(text)) return null;
  if (!client) return { unavailable: true };
  const query = extractKnowledgeQuery(text);
  if (!query) return null;
  try {
    const response = await client.search.docWiki.search({
      data: {
        query,
        doc_filter: { doc_types: ['DOCX'], only_title: false, sort_type: 'DEFAULT_TYPE' },
        page_size: 8,
      },
    });
    if (response.code !== 0) throw new Error(`${response.code ?? 'unknown'} ${response.msg || ''}`);
    const documents = (response.data?.res_units || [])
      .map(result => {
        const token = tokenFromSearchResult(result);
        const catalog = KNOWLEDGE_SOURCES.find(item => item.token === token);
        return catalog ? { documentId: token, ...catalog } : {
          documentId: token,
          token,
          title: stripHighlight(result.title_highlighted) || '未命名飞书文档',
          url: result.result_meta?.url || '',
          aliases: [],
          readerOpenIds: [],
        };
      })
      .filter(item => item.documentId && canReadDocument(item, senderOpenId, OWNER_OPEN_ID))
      .slice(0, 3);
    return documents.length ? { documents } : { denied: true, reason: 'no_authorized_result' };
  } catch (error) {
    console.error('[knowledge-search-error]', error?.response?.data?.msg || error.message);
    return { unavailable: true };
  }
}

function parseTaskDraft(text, senderOpenId) {
  const createIntent = /(?:帮我|请)?\s*(?:建|创建|新增)(?!议)/.test(text) || /提醒我/.test(text);
  if (!/(待办|任务|提醒我)/.test(text) || !createIntent) return null;
  const now = new Date();
  const due = new Date(now);
  due.setSeconds(0, 0);
  if (text.includes('明天')) due.setDate(due.getDate() + 1);
  else if (text.includes('后天')) due.setDate(due.getDate() + 2);
  const dateMatch = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (dateMatch) due.setMonth(Number(dateMatch[1]) - 1, Number(dateMatch[2]));
  const timeMatch = text.match(/(上午|中午|下午|晚上)?\s*(\d{1,2})\s*[点时](半|\d{1,2}分)?/);
  if (!timeMatch) return { missingTime: true };
  let hour = Number(timeMatch[2]);
  const period = timeMatch[1] || '';
  if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
  if (period === '中午' && hour < 11) hour += 12;
  const minute = timeMatch[3] === '半' ? 30 : Number((timeMatch[3] || '0').replace('分', ''));
  due.setHours(hour, minute, 0, 0);
  let summary = text.split(/[：:]/).slice(1).join(':').trim();
  if (!summary) {
    summary = text
      .replace(/^.*?(?:待办|任务)[是为]?[：:]?/, '')
      .replace(/^(?:一个|一条)/, '')
      .trim();
  }
  summary = summary.replace(/[。！!]+$/, '').trim();
  if (!summary) return { missingSummary: true };
  return { summary: summary.slice(0, 160), due, senderOpenId };
}

function formatTaskTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

async function sendText(client, chatId, text, uuid, {
  mentionSenderId = '',
  chatType = '',
} = {}) {
  let outboundText = String(text || '');
  if (state.isSelfChat(chatId)) {
    const circuit = state.claimSelfChatOutbound(chatId);
    if (!circuit.allowed) {
      state.set('health', 'self_chat_circuit_last', {
        chatId,
        openUntilMs: circuit.openUntilMs,
        trippedAt: new Date().toISOString(),
      });
      state.audit('self_chat_circuit_open', {
        chatId,
        detail: {
          tripped: circuit.tripped,
          openUntilMs: circuit.openUntilMs,
          uuid: String(uuid || '').slice(0, 100),
        },
      });
      console.error(`[self-chat-circuit] suppressed outbound message for ${chatId}`);
      return { suppressed: true, reason: 'self_chat_circuit_open' };
    }
    outboundText = markSelfChatOutbound(outboundText);
  }
  const mention = prepareGroupMention({
    chatId,
    chatType,
    senderId: mentionSenderId,
    text: outboundText,
  });
  outboundText = mention.text;
  const target = parseChannelChatId(chatId);
  if (target?.channel === 'dingtalk') {
    if (!dingTalkChannel) throw new Error('DingTalk channel is not available');
    return sendWithEchoGuard(chatId, outboundText, () => dingTalkChannel.send(target, outboundText, uuid, {
        atOpenDingTalkIds: mention.atOpenDingTalkIds,
      }));
  }
  if (target?.channel === 'wecom') {
    if (!weComChannel) throw new Error('WeCom channel is not available');
    return weComChannel.send(target, outboundText, uuid);
  }
  if (target?.channel === 'wechat') {
    if (!geWeChannel) throw new Error('Personal WeChat channel is not available');
    return geWeChannel.send(target, outboundText);
  }
  const labeledText = labelDigitalTwin(outboundText);
  const args = [
    'im', '+messages-send', '--as', 'user', '--chat-id', chatId,
    '--text', labeledText, '--format', 'json',
  ];
  if (uuid) args.push('--idempotency-key', uuid.slice(0, 50));
  return sendWithEchoGuard(chatId, labeledText, () => runLarkCli(args));
}

async function createConfirmedTask(client, draft) {
  const due = draft.due ? {
    time: String(Math.floor(draft.due.getTime() / 1000)),
    timezone: 'Asia/Shanghai',
    is_all_day: false,
  } : undefined;
  const response = await client.task.task.create({
    params: { user_id_type: 'open_id' },
    data: {
      summary: draft.summary,
      ...(due ? { due } : {}),
      origin: { platform_i18n_name: JSON.stringify({ zh_cn: '飞书 AI 数字分身' }) },
      collaborator_ids: draft.senderOpenId ? [draft.senderOpenId] : [],
    },
  });
  if (response.code !== 0 || !response.data?.task?.id) {
    throw new Error(`Feishu task create failed: ${response.code ?? 'unknown'} ${response.msg || ''}`);
  }
  return response.data.task;
}

function parseCalendarQuery(text) {
  if (!/(安排|日程|日历)/.test(text) || !/(今天|明天|后天|上午|下午|晚上)/.test(text)) return null;
  const start = new Date();
  start.setSeconds(0, 0);
  let dayOffset = 0;
  if (text.includes('明天')) dayOffset = 1;
  if (text.includes('后天')) dayOffset = 2;
  start.setDate(start.getDate() + dayOffset);
  const end = new Date(start);
  let period = '全天';
  if (text.includes('上午')) {
    period = '上午'; start.setHours(0, 0, 0, 0); end.setHours(12, 0, 0, 0);
  } else if (text.includes('下午')) {
    period = '下午'; start.setHours(12, 0, 0, 0); end.setHours(18, 0, 0, 0);
  } else if (text.includes('晚上')) {
    period = '晚上'; start.setHours(18, 0, 0, 0); end.setDate(end.getDate() + 1); end.setHours(0, 0, 0, 0);
  } else {
    start.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1); end.setHours(0, 0, 0, 0);
  }
  const dayLabel = dayOffset === 0 ? '今天' : dayOffset === 1 ? '明天' : '后天';
  return { start, end, label: `${dayLabel}${period === '全天' ? '' : period}` };
}

function formatEventTime(event) {
  if (event.start_time?.date) return '全天';
  const start = new Date(Number(event.start_time?.timestamp || 0) * 1000);
  const end = new Date(Number(event.end_time?.timestamp || 0) * 1000);
  const formatter = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  return `${formatter.format(start)}–${formatter.format(end)}`;
}

async function queryCalendarEvents(client, senderOpenId, window) {
  const primary = await client.calendar.calendar.primary({
    params: { user_id_type: 'open_id', op_user_id: senderOpenId },
  });
  const calendar = primary.data?.calendars?.[0]?.calendar;
  if (primary.code !== 0 || !calendar?.calendar_id) {
    throw new Error(`Primary calendar lookup failed: ${primary.code ?? 'unknown'} ${primary.msg || ''}`);
  }
  const response = await client.calendar.calendarEvent.list({
    path: { calendar_id: calendar.calendar_id },
    params: {
      start_time: String(Math.floor(window.start.getTime() / 1000)),
      end_time: String(Math.floor(window.end.getTime() / 1000)),
      user_id_type: 'open_id',
      op_user_id: senderOpenId,
      page_size: 50,
    },
  });
  if (response.code !== 0) {
    throw new Error(`Calendar event query failed: ${response.code ?? 'unknown'} ${response.msg || ''}`);
  }
  return (response.data?.items || []).filter(event => event.status !== 'cancelled');
}

function parseCalendarDraft(text, senderOpenId) {
  const createIntent = /(?:帮我|请)?\s*(?:建|创建|新增)(?!议)/.test(text);
  if (!/(日程|安排)/.test(text) || !createIntent) return null;
  const times = [...text.matchAll(/(上午|中午|下午|晚上)?\s*(\d{1,2})\s*[点时](半|\d{1,2}分)?/g)];
  if (!times.length) return { missingTime: true };
  const base = new Date();
  if (text.includes('明天')) base.setDate(base.getDate() + 1);
  else if (text.includes('后天')) base.setDate(base.getDate() + 2);
  const dateMatch = text.match(/(\d{1,2})月(\d{1,2})[日号]/);
  if (dateMatch) base.setMonth(Number(dateMatch[1]) - 1, Number(dateMatch[2]));
  const toDate = (match, fallbackPeriod = '') => {
    const result = new Date(base);
    const period = match[1] || fallbackPeriod;
    let hour = Number(match[2]);
    if ((period === '下午' || period === '晚上') && hour < 12) hour += 12;
    if (period === '中午' && hour < 11) hour += 12;
    const minute = match[3] === '半' ? 30 : Number((match[3] || '0').replace('分', ''));
    result.setHours(hour, minute, 0, 0);
    return result;
  };
  const start = toDate(times[0]);
  const end = times[1] ? toDate(times[1], times[0][1] || '') : new Date(start.getTime() + 60 * 60 * 1000);
  if (end <= start) end.setDate(end.getDate() + 1);
  let summary = text.split(/[：:]/).slice(1).join(':').trim();
  if (!summary) summary = text.replace(/^.*?(?:日程|安排)[是为]?[：:]?/, '').trim();
  summary = summary.replace(/[。””！!]+$/, '').trim();
  if (!summary) return { missingSummary: true };
  return { summary: summary.slice(0, 160), start, end, senderOpenId };
}

function formatCalendarDraftTime(date) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai', month: 'numeric', day: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

async function createConfirmedCalendarEvent(client, draft) {
  const primary = await client.calendar.calendar.primary({
    params: { user_id_type: 'open_id', op_user_id: draft.senderOpenId },
  });
  const calendar = primary.data?.calendars?.[0]?.calendar;
  if (primary.code !== 0 || !calendar?.calendar_id) {
    throw new Error(`Primary calendar lookup failed: ${primary.code ?? 'unknown'} ${primary.msg || ''}`);
  }
  const response = await client.calendar.calendarEvent.create({
    path: { calendar_id: calendar.calendar_id },
    params: { user_id_type: 'open_id' },
    data: {
      summary: draft.summary,
      start_time: { timestamp: String(Math.floor(draft.start.getTime() / 1000)), timezone: 'Asia/Shanghai' },
      end_time: { timestamp: String(Math.floor(draft.end.getTime() / 1000)), timezone: 'Asia/Shanghai' },
      need_notification: false,
      visibility: 'default',
      free_busy_status: 'busy',
    },
  });
  if (response.code !== 0 || !response.data?.event?.event_id) {
    throw new Error(`Calendar event create failed: ${response.code ?? 'unknown'} ${response.msg || ''}`);
  }
  return response.data.event;
}

async function runAiRuntime(prompt, options) {
  try {
    const result = await AI_RUNTIME_CLIENT.run(prompt, options);
    state.set('health', 'last_ai_runtime_success_at', new Date().toISOString());
    state.unset('health', 'last_ai_runtime_error');
    return result;
  } catch (error) {
    const detail = {
      at: new Date().toISOString(),
      runtime: SELECTED_AI_RUNTIME.id,
      error: processFailureSummary(error),
    };
    state.set('health', 'last_ai_runtime_error', detail);
    state.audit('ai_runtime_error', { detail });
    throw error;
  }
}

async function runCodex(task, history, imagePaths = [], decision = null) {
  const lengthPolicy = replyLengthPolicy(task);
  const prompt = `
${buildIdentityInstruction()}

${PERSONA_TEXT}

工作与表达标准：
1. 你是阿充的数字人，不虚构阿充本人已经阅读、同意或承诺；不要把产品名 AIPRO 当作自己的名字。
2. 默认使用简体中文，按 Persona 的风格自然、直接地回复。
3. 不要使用客服腔或报告腔。避免“已记录”“请提供相关材料”“我可以立即为你”“处理如下”等模板句式。
4. 不要每次复述问题，不要无必要地加标题、总结、编号或固定落款。
5. 日常回应可以使用“好哦”“可以的”“你发我一下”“我先看看”这类自然表达，但不要每句话都加语气词。面向老师或职场对象时礼貌、有分寸。
6. 清单只保留核心内容。例如问本周任务，可直接答“这周主要有三个：招聘数据整理、面试安排、周报。”
7. 缺少材料时，用最自然、最短的方式追问。例如：“可以的，你把阿充的原消息发我一下，我帮你顺一下回复。”
8. 可以直接整理、总结、分析、改写或起草内容。若缺少必要材料，只追问最关键的一项。
9. 方案、报告、总结、表格或格式要求都由你根据用户真实意图处理并直接给出高质量最终内容；不要因为出现某个关键词就擅自改成 PDF、Word、在线文档或在线表格，也不要声称已经创建这类文件或链接。
10. 只输出给当前 IM 用户的最终回复，不解释内部步骤。除已经由阿充明确授权的需求写入、需求状态通知和指定私人消息外，涉及向其他会话或外部对象发送、公开发布、付款、承诺、申请、删除或隐私数据操作时，只生成草稿并等待本人确认。
11. 不得执行任意命令或自行遍历本机目录。应用提供的具名只读证据、A1 和钉钉工具结果可以使用；只能在工具声明的范围内操作，不能把用户输入当作命令执行。
12. ${lengthPolicy.detailed
    ? '对方明确要求方案、报告或详细交付，可以完整展开，但只保留有用内容。'
    : `这是日常对话，只回复 ${lengthPolicy.maxChars} 个汉字左右；短句问候只回一句，普通问题最多 1–3 个短句，不加标题、清单、铺垫或重复。`}

数字员工 Bible：
${BIBLE_TEXT}

全局隐私与决策底线：
${PRIVACY_BOUNDARY_TEXT}

本次工作流决策：
${decision ? workflowInstruction(decision) : '未指定，按 Bible 判断。'}

本次运行周期内的最近对话：
${history}

用户指令：
${task}
`.trim();

  const { text } = await runAiRuntime(prompt, {
    cwd: CODEX_RUNTIME_DIR,
    model: SELECTED_AI_RUNTIME.id === 'codex' ? config.codexModel : '',
    images: imagePaths,
    timeoutMs: config.codexTimeoutMs,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  return enforceReplyLength(text, task);
}

async function planA1Requirement(input) {
  const { text } = await runAiRuntime(buildA1SpecPrompt(input), {
    cwd: CODEX_RUNTIME_DIR,
    model: SELECTED_AI_RUNTIME.id === 'codex' ? config.codexModel : '',
    timeoutMs: config.codexTimeoutMs,
    maxStdoutBytes: 512 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  return parseA1RequirementSpec(text);
}

async function prepareA1Requirement({ request, route, clarification = '', existingBody = '' }) {
  const initial = await planA1Requirement({
    request,
    route,
    clarification,
    existingBody,
    repositoryEvidence: '',
  });
  if (!route.inspectRepository) return { ...initial, codeEvidence: [] };

  const searchTerm = initial.codeSearchTerms[0] || initial.title;
  const repository = await A1_CLIENT.searchRepository({
    repo: route.repo,
    keyword: searchTerm,
    branch: route.branch,
  });
  const paths = extractRepositoryPaths(repository.search).length
    ? extractRepositoryPaths(repository.search)
    : extractRepositoryPaths(repository.tree);
  if (!paths.length) {
    throw new Error(`已读取 ${route.repo}，但没有定位到与“${searchTerm}”相关的可读代码文件；需要补充功能入口或页面名称后再建需求`);
  }
  const inspected = [];
  for (const path of paths.slice(0, 3)) {
    const content = await A1_CLIENT.viewRepositoryFile({
      repo: route.repo,
      path,
      branch: route.branch,
      startLine: 1,
      endLine: 240,
    });
    inspected.push({ path, content });
  }
  const repositoryEvidence = JSON.stringify({
    repository: route.repo,
    branch: route.branch || 'default',
    files: inspected,
  }).slice(0, 60_000);
  return planA1Requirement({
    request,
    route,
    clarification,
    existingBody,
    repositoryEvidence,
  });
}

async function runCodexActionItems(documentText) {
  const prompt = `
请根据下面的会议纪要提取最多 6 条可执行事项。

规则：
- 只有纪要明确写出行动项，或同时出现具体负责人和要执行的动作时，type 才写 explicit。
- 纪要没有明确任务，但可以合理转化为学习、整理或验证动作时，type 写 suggested。
- 不得虚构负责人、承诺、结果或截止日期。
- summary 必须是简洁的中文动宾短语，适合作为飞书待办标题。
- 只有原文明确出现截止时间时才填写 due，格式为 YYYY-MM-DD HH:mm；否则为 null。
- 只输出 JSON 数组，不要 Markdown，不要解释。

格式：[{"summary":"整理法务 AI 工具对比清单","due":null,"type":"suggested","evidence":"纪要中的简短依据"}]

会议纪要：
${documentText.slice(0, 40_000)}
`.trim();
  const { text: output } = await runAiRuntime(prompt, {
    cwd: CODEX_RUNTIME_DIR,
    model: SELECTED_AI_RUNTIME.id === 'codex' ? config.codexModel : '',
    timeoutMs: config.codexTimeoutMs,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  try {
    const start = output.indexOf('[');
    const end = output.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('JSON array not found');
    const parsed = JSON.parse(output.slice(start, end + 1));
    return parsed
      .filter(item => item && typeof item.summary === 'string')
      .slice(0, 6)
      .map(item => ({
        summary: item.summary.trim().slice(0, 160),
        due: typeof item.due === 'string' && item.due ? new Date(`${item.due.replace(' ', 'T')}:00+08:00`) : null,
        type: item.type === 'explicit' ? 'explicit' : 'suggested',
        evidence: typeof item.evidence === 'string' ? item.evidence.trim().slice(0, 240) : '',
      }))
      .filter(item => item.summary && (!item.due || !Number.isNaN(item.due.getTime())));
  } catch (error) {
    throw new Error(`Invalid action item JSON: ${error.message}`);
  }
}

async function runCodexMulticaPlan(request, history) {
  if (!MULTICA_CLIENT) throw new Error('Multica integration is disabled');
  const workspaces = await MULTICA_CLIENT.listWorkspaces();
  const prompt = buildMulticaPlannerPrompt({
    request,
    history,
    workspaces,
    defaultWorkspaceId: config.multicaDefaultWorkspaceId,
  });
  const { text: output } = await runAiRuntime(prompt, {
    cwd: CODEX_RUNTIME_DIR,
    model: SELECTED_AI_RUNTIME.id === 'codex' ? config.codexModel : '',
    timeoutMs: config.codexTimeoutMs,
    maxStdoutBytes: 256 * 1024,
    maxStderrBytes: 1024 * 1024,
  });
  return normalizeMulticaPlan(parseMulticaPlannerOutput(output), {
    workspaces,
    defaultWorkspaceId: config.multicaDefaultWorkspaceId,
  });
}

function multicaConfirmationMatches(text, pending) {
  if (pending.pending.plan.confirmationLevel === 'double') {
    const match = String(text).match(/^确认\s+(\d{6})[。！! ]*$/);
    return Boolean(match && match[1] === pending.confirmationCode);
  }
  return /^(确认|确认执行|可以|好|好哦)[。！! ]*$/.test(text);
}

async function applyPendingFeedback(message, senderOpenId, cleanText, metadata = {}) {
  const pending = pendingActions.get('multica_feedback', message.chat_id, senderOpenId);
  if (!pending) return false;
  if (isFeedbackCancellation(cleanText)) {
    const cancellation = MULTICA_FEEDBACK_WORKFLOW
      ? MULTICA_FEEDBACK_WORKFLOW.cancel(pending, {
          context: multicaContext(message, senderOpenId, metadata),
        })
      : { text: '好的，这次反馈登记已取消，没有创建 Multica Issue。' };
    pendingActions.delete('multica_feedback', message.chat_id, senderOpenId);
    await sendText(
      null,
      message.chat_id,
      cancellation.text,
      `multica-feedback-cancel-${message.message_id}`,
    );
    audit('multica_feedback_cancel_receipt_sent', message, senderOpenId, {
      sourceMessageId: pending.sourceMessageId,
    });
    return true;
  }
  if (!MULTICA_FEEDBACK_WORKFLOW) {
    await sendText(
      null,
      message.chat_id,
      'Multica 反馈登记能力当前不可用；待补充内容已保留，可稍后重试或回复“取消”。',
      `multica-feedback-disabled-${message.message_id}`,
    );
    return true;
  }
  if (!cleanText) {
    await sendText(
      null,
      message.chat_id,
      '请补充一个可验证的完成标准，或回复“取消”。',
      `multica-feedback-empty-${message.message_id}`,
    );
    return true;
  }
  try {
    const result = await MULTICA_FEEDBACK_WORKFLOW.register(pending, cleanText, {
      context: multicaContext(message, senderOpenId, metadata),
    });
    pendingActions.delete('multica_feedback', message.chat_id, senderOpenId);
    remember(message.chat_id, senderOpenId, 'user', cleanText);
    remember(message.chat_id, senderOpenId, 'assistant', result.text);
    await sendText(
      null,
      message.chat_id,
      result.text,
      `multica-feedback-registered-${message.message_id}`,
    );
    audit('multica_feedback_receipt_sent', message, senderOpenId, {
      issueId: result.issue.id,
      identifier: result.issue.identifier,
      replayed: result.replayed,
      ownerDispatched: result.ownerDispatched,
      dispatchPending: result.dispatchPending,
    });
  } catch (error) {
    await sendText(
      null,
      message.chat_id,
      `反馈暂时没有登记完成：${processFailureSummary(error)}\n请重新回复同一验收标准重试，或回复“取消”。`,
      `multica-feedback-error-${message.message_id}`,
    );
    audit('multica_feedback_registration_failed', message, senderOpenId, {
      sourceMessageId: pending.sourceMessageId,
      error: String(error?.message || error).slice(0, 1000),
    });
  }
  return true;
}

async function startMulticaFeedback(message, senderOpenId, cleanText, metadata = {}) {
  if (!MULTICA_FEEDBACK_WORKFLOW) {
    await sendText(
      null,
      message.chat_id,
      'Multica 反馈登记能力还没有启用。',
      `multica-feedback-disabled-${message.message_id}`,
    );
    return true;
  }
  const context = multicaContext(message, senderOpenId, metadata);
  const started = MULTICA_FEEDBACK_WORKFLOW.begin({
    text: cleanText,
    sourceMessageId: message.message_id,
    context,
  });
  pendingActions.set(
    'multica_feedback',
    message.chat_id,
    senderOpenId,
    started.pending,
  );
  remember(message.chat_id, senderOpenId, 'user', cleanText);
  remember(message.chat_id, senderOpenId, 'assistant', started.text);
  await sendText(
    null,
    message.chat_id,
    started.text,
    `multica-feedback-clarify-${message.message_id}`,
  );
  return true;
}

async function applyPendingMultica(message, senderOpenId, cleanText, metadata = {}) {
  const pending = pendingActions.get('multica', message.chat_id, senderOpenId);
  if (!pending) return false;
  if (/^(取消|不用了|不执行|放弃)[。！! ]*$/.test(cleanText)) {
    pendingActions.delete('multica', message.chat_id, senderOpenId);
    await sendText(
      null,
      message.chat_id,
      '好哦，这次 Multica 修改已经取消，没有写入任何内容。',
      `multica-cancel-${message.message_id}`,
    );
    audit('multica_mutation_cancelled', message, senderOpenId, {
      action: pending.pending.plan.action,
    });
    return true;
  }
  const looksLikeConfirmation = /^(确认|确认执行|可以|好|好哦)(?:\s+\d{6})?[。！! ]*$/.test(cleanText);
  if (!looksLikeConfirmation) return false;
  if (!multicaConfirmationMatches(cleanText, pending)) {
    const answer = pending.pending.plan.confirmationLevel === 'double'
      ? `确认码不对。请回复“确认 ${pending.confirmationCode}”执行，或回复“取消”。`
      : '请回复“确认”执行，或回复“取消”。';
    await sendText(null, message.chat_id, answer, `multica-confirm-invalid-${message.message_id}`);
    return true;
  }
  const context = multicaContext(message, senderOpenId, metadata);
  if (!context.ownerAuthorized) {
    pendingActions.delete('multica', message.chat_id, senderOpenId);
    await sendText(
      null,
      message.chat_id,
      '只有经过验证的 Owner 在飞书或钉钉 self-chat 中才能确认 Multica 写入；本次操作未执行。',
      `multica-owner-required-${message.message_id}`,
    );
    audit('multica_write_denied', message, senderOpenId, {
      action: pending.pending.plan.action,
      phase: 'apply',
    });
    return true;
  }
  let execution;
  try {
    execution = await executeMutationOnce({
      state,
      executionKey: `multica:${message.message_id}`,
      kind: `multica_${pending.pending.plan.action}`,
      operation: () => MULTICA_CAPABILITY.applyMutation(pending.pending, context),
      definitelyNotApplied: error => /changed after the preview/i.test(
        String(error?.message || ''),
      ),
    });
  } catch (error) {
    pendingActions.delete('multica', message.chat_id, senderOpenId);
    const answer = error instanceof MutationOutcomeAmbiguousError
      ? '这次 Multica 写入的最终结果不确定。为了防止重复创建或重复评论，我已经停止自动重试。请先在 Multica 中核对；确认没有写入后，再重新发起一次操作。'
      : /changed after the preview/i.test(String(error?.message || ''))
      ? '这个 Issue 在确认前已经发生变化，所以我没有覆盖它。请重新发一次修改指令，我会基于最新状态生成方案。'
      : `Multica 写入没有完成：${processFailureSummary(error)}`;
    await sendText(null, message.chat_id, answer, `multica-apply-error-${message.message_id}`);
    audit('multica_mutation_failed', message, senderOpenId, {
      action: pending.pending.plan.action,
      error: String(error?.message || error).slice(0, 1000),
    });
    return true;
  }
  const result = execution.result;
  await sendText(null, message.chat_id, result.text, `multica-applied-${message.message_id}`);
  pendingActions.delete('multica', message.chat_id, senderOpenId);
  remember(message.chat_id, senderOpenId, 'user', cleanText);
  remember(message.chat_id, senderOpenId, 'assistant', result.text);
  audit('multica_mutation_applied', message, senderOpenId, {
    action: pending.pending.plan.action,
    issueId: result.issue?.id || '',
    identifier: result.issue?.identifier || '',
    replayed: execution.replayed,
  });
  return true;
}

async function handleMulticaRequest(message, senderOpenId, cleanText, metadata = {}) {
  if (!MULTICA_CAPABILITY) {
    await sendText(
      null,
      message.chat_id,
      'Multica 业务系统能力还没有启用。',
      `multica-disabled-${message.message_id}`,
    );
    return true;
  }
  const history = formatHistory(message.chat_id, senderOpenId);
  const plan = await runCodexMulticaPlan(cleanText, history);
  const context = multicaContext(message, senderOpenId, metadata);
  audit('multica_plan_created', message, senderOpenId, {
    action: plan.action,
    confirmationLevel: plan.confirmationLevel,
    issue: plan.issue || '',
    workspaceId: plan.workspaceId || '',
  });
  if (plan.confirmationLevel === 'none') {
    const result = await MULTICA_CAPABILITY.execute(plan, context);
    remember(message.chat_id, senderOpenId, 'user', cleanText);
    remember(message.chat_id, senderOpenId, 'assistant', result.text);
    await sendText(null, message.chat_id, result.text, `multica-read-${message.message_id}`);
    audit('multica_action_completed', message, senderOpenId, {
      action: plan.action,
      issueId: result.issue?.id || '',
      identifier: result.issue?.identifier || '',
    });
    return true;
  }
  if (!context.ownerAuthorized) {
    await sendText(
      null,
      message.chat_id,
      '只有经过验证的 Owner 在飞书或钉钉 self-chat 中才能创建、更新、评论或派发 Multica Issue。当前会话仍可查询，或反馈 AIPRO 的 Bug、整改意见和功能需求；反馈会先追问并仅登记为未指派 backlog。',
      `multica-owner-required-${message.message_id}`,
    );
    audit('multica_write_denied', message, senderOpenId, {
      action: plan.action,
      phase: 'prepare',
    });
    return true;
  }
  const prepared = await MULTICA_CAPABILITY.prepareMutation(plan, context);
  const confirmationCode = plan.confirmationLevel === 'double'
    ? String(randomInt(100000, 1000000))
    : '';
  pendingActions.set('multica', message.chat_id, senderOpenId, {
    pending: prepared.pending,
    confirmationCode,
  });
  const confirmation = plan.confirmationLevel === 'double'
    ? `\n\n这是敏感变更。请回复“确认 ${confirmationCode}”执行，或回复“取消”。`
    : '\n\n请回复“确认”执行，或回复“取消”。';
  await sendText(
    null,
    message.chat_id,
    `${prepared.text}${confirmation}`,
    `multica-preview-${message.message_id}`,
  );
  audit('multica_mutation_previewed', message, senderOpenId, {
    action: plan.action,
    confirmationLevel: plan.confirmationLevel,
  });
  return true;
}

async function handleMulticaWorkRequest(message, senderOpenId, request, decision, metadata = {}) {
  if (!MULTICA_WORK_LIFECYCLE) {
    await sendText(
      null,
      message.chat_id,
      'Multica 任务生命周期能力还没有启用。',
      `multica-work-disabled-${message.message_id}`,
    );
    return true;
  }
  const context = multicaContext(message, senderOpenId, metadata);
  if (!context.ownerAuthorized) {
    await sendText(
      null,
      message.chat_id,
      '只有经过验证的 Owner 在飞书或钉钉 self-chat 中才能执行 Multica Issue；本次没有修改状态或启动任务。',
      `multica-work-owner-required-${message.message_id}`,
    );
    audit('multica_work_denied', message, senderOpenId, { issue: request.issue });
    return true;
  }
  const history = formatHistory(message.chat_id, senderOpenId);
  audit('multica_work_requested', message, senderOpenId, {
    issue: request.issue,
    task: request.task.slice(0, 500),
  });
  const result = await MULTICA_WORK_LIFECYCLE.run({
    reference: request.issue,
    context,
    onStarted: async issue => {
      await sendText(
        null,
        message.chat_id,
        `${issue.identifier} 已开始执行，状态已自动更新为“进行中”。`
          + `${multicaIssueUrl(issue, config.multicaAppUrl)
            ? `\n查看：${multicaIssueUrl(issue, config.multicaAppUrl)}` : ''}`,
        `multica-work-started-${message.message_id}`,
      );
      audit('multica_work_started', message, senderOpenId, {
        issueId: issue.id,
        identifier: issue.identifier,
      });
    },
    execute: () => runCodex(
      `你正在执行 Multica Issue ${request.issue} 对应的工作。\n\n具体任务：${request.task}\n\n请直接交付可发送给当前用户的最终结果；没有完成任务所需的关键信息时，明确说明缺少什么，不得假装已经完成。`,
      history,
      [],
      decision,
    ),
    deliver: async answer => {
      remember(message.chat_id, senderOpenId, 'user', `处理 ${request.issue}：${request.task}`);
      remember(message.chat_id, senderOpenId, 'assistant', answer);
      await sendText(
        null,
        message.chat_id,
        answer,
        `multica-work-result-${message.message_id}`,
      );
    },
  });
  if (result.outcome === 'completed') {
    audit('multica_work_completed', message, senderOpenId, {
      issueId: result.issue.id,
      identifier: result.issue.identifier,
      answerChars: result.answer.length,
    });
    return true;
  }
  const error = processFailureSummary(result.error);
  await sendText(
    null,
    message.chat_id,
    `${result.issue.identifier || request.issue} 执行受阻，状态已自动更新为“受阻”。\n原因：${error}`
      + `${multicaIssueUrl(result.issue, config.multicaAppUrl)
        ? `\n查看：${multicaIssueUrl(result.issue, config.multicaAppUrl)}` : ''}`,
    `multica-work-blocked-${message.message_id}`,
  );
  audit('multica_work_blocked', message, senderOpenId, {
    issueId: result.issue.id,
    identifier: result.issue.identifier,
    error,
  });
  return true;
}

function readHumanTakeover(chatId, nowMs = Date.now()) {
  const current = state.get(chatId, 'human_takeover', null);
  if (current) return current;
  if (!state.get(chatId, 'assistant_paused', false)) return null;
  const migrated = {
    pausedAtMs: nowMs,
    pausedUntilMs: nowMs + 5 * 60_000,
    sourceMessageId: 'legacy-indefinite-pause',
    reason: 'owner_human_takeover',
  };
  state.set(chatId, 'human_takeover', migrated);
  state.unset(chatId, 'assistant_paused');
  return migrated;
}

function writeHumanTakeover(chatId, value) {
  state.unset(chatId, 'assistant_paused');
  if (value) state.set(chatId, 'human_takeover', value);
  else state.unset(chatId, 'human_takeover');
}

function dingTalkMessageTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return Number.NaN;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}+08:00`
    : raw;
  return Date.parse(normalized);
}

async function syncRecentDingTalkTakeover(message, metadata = {}) {
  const target = parseChannelChatId(message?.chat_id);
  if (target?.channel !== 'dingtalk'
    || config.dingtalkTransport === 'wukong-polling'
    || !config.dingtalkOwnerOpenId
    || metadata.selfChat === true) return null;
  const nowMs = Date.now();
  const { stdout, stderr } = await runBufferedProcess(
    config.dingtalkBin,
    buildDingTalkConversationPollingArgs(
      config.dingtalkProfile,
      target,
      dingTalkPollingTime(nowMs),
    ),
    {
      cwd: WORKDIR,
      env: dingtalkProcessEnv(),
      timeoutMs: config.larkCliTimeoutMs,
      maxStdoutBytes: 4 * 1024 * 1024,
      maxStderrBytes: 512 * 1024,
    },
  );
  let result;
  try { result = JSON.parse(stdout); } catch {
    throw new Error(`dws conversation control poll returned invalid JSON: ${(stderr || stdout).slice(-800)}`);
  }
  if (result.success === false || result.error) {
    throw new Error(`dws conversation control poll failed: ${JSON.stringify(result.error || result).slice(0, 1000)}`);
  }
  const root = result?.result || result?.data || result || {};
  const messages = Array.isArray(root) ? root : (root.messages || root.items || []);
  const applied = applyOwnerActivityHistory(messages, {
    ownerId: config.dingtalkOwnerOpenId,
    current: readHumanTakeover(message.chat_id, nowMs),
    nowMs,
    parseTime: dingTalkMessageTime,
    isAssistantMessage: item => state.hasOutboundEcho(
      message.chat_id,
      String(item?.content || item?.text || ''),
      { messageId: String(item?.openMessageId || item?.messageId || item?.message_id || '') },
    ),
  });
  if (!applied.changed) return applied;
  writeHumanTakeover(message.chat_id, applied.state);
  const latest = applied.activities.at(-1);
  state.audit(latest?.command === 'pause'
    ? 'takeover_paused'
    : latest?.command === 'resume' ? 'takeover_resume_requested' : 'owner_manual_activity', {
    chatId: message.chat_id,
    senderId: `dingtalk:${config.dingtalkOwnerOpenId}`,
    messageId: latest?.messageId || '',
    detail: {
      channel: 'dingtalk',
      active: applied.active,
      pausedUntilMs: Number(applied.state?.pausedUntilMs || 0),
    },
  });
  return applied;
}

async function processIncoming(client, message, sender, metadata = {}) {
  if (sender?.sender_type === 'app') return;
  if (!config.allowAllChats && !AUTHORIZED_CHAT_IDS.has(message.chat_id)) return;
  if (!['text', 'image', 'post', 'file'].includes(message.message_type)) {
    console.log(`[ignore] ${message.message_id}: unsupported ${message.message_type}`);
    return;
  }

  let text = '';
  let imageKeys = [];
  let imageRefs = [];
  let fileKey = '';
  let fileName = '';
  let fileRef = null;
  try {
    const content = JSON.parse(message.content || '{}');
    if (message.message_type === 'post') {
      ({ text, imageKeys } = parsePost(content));
    } else {
      text = content.text || '';
      if (content.image_key) imageKeys = [content.image_key];
      fileKey = content.file_key || '';
      fileName = content.file_name || '';
    }
  } catch { return; }
  const cleanText = cleanTask(String(text || '').slice(0, 20_000));
  const senderOpenId = sender?.sender_id?.open_id || '';
  audit('message_received', message, senderOpenId, { type: message.message_type, text: cleanText.slice(0, 300) });

  if (parseChannelChatId(message.chat_id)?.channel === 'dingtalk') {
    try {
      await syncRecentDingTalkTakeover(message, metadata);
    } catch (error) {
      const failurePolicy = takeoverSyncFailurePolicy({
        current: readHumanTakeover(message.chat_id),
        attemptNumber: metadata.inboundAttemptNumber,
      });
      audit('takeover_control_check_failed', message, senderOpenId, {
        channel: 'dingtalk',
        failurePolicy,
        attemptNumber: Number(metadata.inboundAttemptNumber || 1),
        error: processFailureSummary(error),
      });
      console.error(`[takeover-control-check-error] ${message.message_id}:`, error);
      if (failurePolicy === 'suppress') return;
      if (failurePolicy === 'retry') throw error;
    }
  }

  const nowMs = Date.now();
  if (metadata.ownerActivity === true && senderOpenId === OWNER_OPEN_ID) {
    const occurredAtMs = Number(message.create_time || nowMs);
    const applied = applyOwnerActivityHistory([{
      message_id: message.message_id,
      content: cleanText,
      create_time: new Date(Number.isFinite(occurredAtMs) ? occurredAtMs : nowMs).toISOString(),
      sender: { id: OWNER_OPEN_ID },
    }], {
      ownerId: OWNER_OPEN_ID,
      current: readHumanTakeover(message.chat_id, nowMs),
      nowMs,
    });
    if (applied.changed) writeHumanTakeover(message.chat_id, applied.state);
    audit(applied.activities.at(-1)?.command ? 'takeover_owner_activity' : 'owner_manual_activity', message, senderOpenId, {
      pausedUntilMs: Number(applied.state?.pausedUntilMs || 0),
      silent: true,
    });
    return;
  }
  const takeover = evaluateHumanTakeover({
    current: readHumanTakeover(message.chat_id, nowMs),
    text: cleanText,
    authenticatedOwner: senderOpenId === OWNER_OPEN_ID || metadata.operatorControl === true
      || metadata.ownerControlAuthenticated === true,
    nowMs,
    sourceMessageId: message.message_id,
  });
  if (takeover.handled) {
    writeHumanTakeover(message.chat_id, takeover.state);
    audit(takeover.command === 'pause'
      ? 'takeover_paused'
      : takeover.resumed ? 'takeover_resumed' : 'takeover_resume_deferred', message, senderOpenId, {
      pausedUntilMs: Number(takeover.state?.pausedUntilMs || 0),
      silent: true,
    });
    return;
  }
  if (takeover.suppressed) {
    audit('message_skipped_human_takeover', message, senderOpenId, {
      pausedUntilMs: humanTakeoverStatus(takeover.state, nowMs).pausedUntilMs,
    });
    return;
  }

  if (message.chat_type === 'group'
    && (!Array.isArray(message.mentions) || message.mentions.length === 0)) return;

  if (await applyPendingFeedback(message, senderOpenId, cleanText, metadata)) return;
  if (looksLikeMulticaFeedback(cleanText)) {
    await startMulticaFeedback(message, senderOpenId, cleanText, metadata);
    return;
  }

  const existingHistory = state.history(message.chat_id, senderOpenId, 12);
  if (shouldIntroduceAssistant({
    chatType: message.chat_type,
    isOwner: senderOpenId === OWNER_OPEN_ID || metadata.selfChat === true,
    history: existingHistory,
  })) {
    const greeting = buildFirstTakeoverGreeting();
    remember(message.chat_id, senderOpenId, 'user', cleanText || `发送了${message.message_type}`);
    remember(message.chat_id, senderOpenId, 'assistant', greeting);
    await sendText(client, message.chat_id, greeting, `aipro-introduction-${message.message_id}`);
    audit('assistant_first_takeover_introduction', message, senderOpenId, { answerChars: greeting.length });
    return;
  }

  const decision = decideWorkflow(cleanText, {
    hasImages: imageKeys.length > 0,
    hasFile: message.message_type === 'file',
  });
  audit('workflow_decision', message, senderOpenId, decision);

  if (decision.action === 'refuse') {
    await sendText(
      client,
      message.chat_id,
      ownerHandoffReply({ ownerContactPhone: config.ownerContactPhone }),
      `digital-employee-refuse-${message.message_id}`,
    );
    return;
  }

  const operatorCommand = matchOperatorCommand(cleanText);
  if (operatorCommand === 'help') {
    const answer = buildHelpReply({ dashboardUrl: DASHBOARD_URL });
    await sendText(client, message.chat_id, answer, `xiaozhao-help-${message.message_id}`);
    audit('operator_help_requested', message, senderOpenId);
    return;
  }
  if (operatorCommand === 'status') {
    const lastMulticaSyncResult = state.get('health', 'last_multica_sync_result', null);
    const answer = buildStatusReply({
      startedAt: state.get('health', 'last_start_at', ''),
      lastPollSuccessAt: state.get('health', 'last_poll_success_at', ''),
      lastPollError: state.get('health', 'last_poll_error', null),
      websocketConnected: state.get('health', 'websocket_connected', false),
      aiRuntimeLabel: SELECTED_AI_RUNTIME.label,
      multicaEnabled: config.multicaEnabled,
      lastMulticaSyncAt: state.get('health', 'last_multica_sync_at', ''),
      lastMulticaSyncError: state.get('health', 'last_multica_sync_error', null),
      maxMulticaSyncAgeMs: Math.max(60_000, config.multicaSyncIntervalMs * 6),
      multicaPending: Number(lastMulticaSyncResult?.pending || 0),
      multicaDead: state.multicaNotificationDeadCount(),
      inboxCounts: state.inboxStatusCounts(),
      dashboardUrl: DASHBOARD_URL,
      detailed: senderOpenId === OWNER_OPEN_ID,
    });
    await sendText(client, message.chat_id, answer, `xiaozhao-status-${message.message_id}`);
    audit('operator_status_requested', message, senderOpenId, {
      detailed: senderOpenId === OWNER_OPEN_ID,
    });
    return;
  }
  if (isBareMention(cleanText, message.message_type)) {
    const answer = '我在，想让我帮你看什么？';
    remember(message.chat_id, senderOpenId, 'user', '只 @ 了我');
    remember(message.chat_id, senderOpenId, 'assistant', answer);
    await sendText(client, message.chat_id, answer, `xiaozhao-${message.message_id}`);
    audit('message_replied', message, senderOpenId, {
      artifact: false,
      answerChars: answer.length,
      fastPath: 'bare_mention',
    });
    return;
  }
  if (!client && (message.message_type === 'image' || message.message_type === 'file')) {
    await sendText(client, message.chat_id, '当前真人身份入口暂时只能处理文字消息，图片和文件读取通道还没有配置完成。', `digital-employee-media-unavailable-${message.message_id}`);
    audit('capability_unavailable', message, senderOpenId, { capability: message.message_type });
    return;
  }
  imageRefs = imageKeys.map(fileKey => ({ messageId: message.message_id, fileKey }));
  if (message.message_type === 'file' && fileKey) {
    fileRef = { messageId: message.message_id, fileKey, fileName };
  }
  if (!fileRef && message.message_type === 'file' && client) {
    try {
      fileRef = await findRecentFileRef(client, message, senderOpenId, { includeCurrent: true });
    } catch (error) {
      console.error(`[file-resolution-error] ${message.message_id}:`, error);
    }
  }
  if (message.message_type === 'file' && !fileRef) {
    await sendText(client, message.chat_id, '文件收到了，但当前没有拿到可读取的文件资源。你可以再发一句希望我怎么处理，我会从最近消息里重新读取。', `digital-employee-file-resource-unavailable-${message.message_id}`);
    audit('capability_unavailable', message, senderOpenId, { capability: 'file_resource' });
    return;
  }
  if (!imageRefs.length && ['text', 'post'].includes(message.message_type) && refersToRecentImages(cleanText)) {
    try {
      imageRefs = await findRecentImageRefs(client, message, senderOpenId, cleanText);
    } catch (error) {
      console.error(`[image-context-error] ${message.message_id}:`, error);
    }
  }
  if (!fileRef && ['text', 'post'].includes(message.message_type) && refersToRecentFiles(cleanText)) {
    try {
      fileRef = await findRecentFileRef(client, message, senderOpenId);
    } catch (error) {
      console.error(`[file-context-error] ${message.message_id}:`, error);
    }
  }
  if (A1_WORKFLOW) {
    try {
      const result = await A1_WORKFLOW.handle({
        chatId: message.chat_id,
        senderId: senderOpenId,
        chatType: message.chat_type,
        messageId: message.message_id,
        text: cleanText,
      });
      if (result.handled) {
        remember(message.chat_id, senderOpenId, 'user', cleanText);
        remember(message.chat_id, senderOpenId, 'assistant', result.text);
        await sendText(client, message.chat_id, result.text, `a1-requirement-${message.message_id}`);
        audit('a1_requirement_handled', message, senderOpenId, {
          workitemId: result.item?.id || '',
          url: result.item?.url || '',
        });
        return;
      }
    } catch (error) {
      console.error(`[a1-requirement-error] ${message.message_id}:`, error);
      await sendText(
        client,
        message.chat_id,
        `1A 需求没有处理完成：${processFailureSummary(error)}`,
        `a1-requirement-error-${message.message_id}`,
      );
      audit('a1_requirement_failed', message, senderOpenId, {
        error: String(error?.message || error).slice(0, 1000),
      });
      return;
    }
  }
  if (await applyPendingMultica(message, senderOpenId, cleanText, metadata)) return;
  const multicaWorkRequest = parseMulticaWorkRequest(cleanText);
  if (multicaWorkRequest) {
    try {
      await handleMulticaWorkRequest(
        message,
        senderOpenId,
        multicaWorkRequest,
        decision,
        metadata,
      );
    } catch (error) {
      console.error(`[multica-work-error] ${message.message_id}:`, error);
      await sendText(
        null,
        message.chat_id,
        `Multica 任务没有启动：${processFailureSummary(error)}`,
        `multica-work-error-${message.message_id}`,
      );
      audit('multica_work_failed', message, senderOpenId, {
        issue: multicaWorkRequest.issue,
        error: String(error?.message || error).slice(0, 1000),
      });
    }
    return;
  }
  if (looksLikeMulticaRequest(cleanText)) {
    try {
      await handleMulticaRequest(message, senderOpenId, cleanText, metadata);
    } catch (error) {
      console.error(`[multica-request-error] ${message.message_id}:`, error);
      await sendText(
        null,
        message.chat_id,
        `Multica 刚刚没有处理成功：${processFailureSummary(error)}`,
        `multica-request-error-${message.message_id}`,
      );
      audit('multica_request_failed', message, senderOpenId, {
        error: String(error?.message || error).slice(0, 1000),
      });
    }
    return;
  }
  const pendingTaskBatch = pendingActions.get('task_batch', message.chat_id, senderOpenId);
  if (pendingTaskBatch && /^(确认|确认创建|全部确认|可以|好|好哦)[。！! ]*$/.test(cleanText)) {
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置待办创建凭证，这批待办暂时不能执行。', `digital-employee-task-batch-unavailable-${message.message_id}`);
      return;
    }
    const created = [];
    const uncertain = [];
    for (const [index, item] of pendingTaskBatch.items.entries()) {
      try {
        const execution = await executeMutationOnce({
          state,
          executionKey: `task-batch:${message.message_id}:${index}`,
          kind: 'feishu_task_create',
          operation: () => createConfirmedTask(client, {
            ...item,
            senderOpenId: pendingTaskBatch.senderOpenId,
          }),
        });
        const task = execution.result;
        created.push(task.summary || item.summary);
      } catch (error) {
        console.error(`[task-batch-error] ${message.message_id}:`, error);
        uncertain.push(item.summary);
      }
    }
    const lines = [`建好了 ${created.length} 条待办：`, ...created.map((item, index) => `${index + 1}. ${item}`)];
    if (uncertain.length) {
      lines.push(
        `\n有 ${uncertain.length} 条结果不确定，已停止自动重试以避免重复创建，请在飞书待办中核对：${uncertain.join('、')}`,
      );
    }
    await sendText(client, message.chat_id, lines.join('\n'), `xiaozhao-batch-${message.message_id}`);
    pendingActions.delete('task_batch', message.chat_id, senderOpenId);
    audit('task_batch_created', message, senderOpenId, { created, uncertain });
    return;
  }
  if (pendingTaskBatch && /^(取消|不用了|不建了)[。！! ]*$/.test(cleanText)) {
    pendingActions.delete('task_batch', message.chat_id, senderOpenId);
    await sendText(client, message.chat_id, '好哦，这批待办先不建。', `xiaozhao-batch-cancel-${message.message_id}`);
    return;
  }
  if (/(会议纪要|智能纪要)/.test(cleanText) && /(行动项|待办)/.test(cleanText) && /(提取|整理|生成|创建)/.test(cleanText)) {
    if (senderOpenId !== OWNER_OPEN_ID) {
      await sendText(client, message.chat_id, '这份资料目前只授权给账号本人使用哦。', `digital-employee-owner-only-${message.message_id}`);
      return;
    }
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置纪要读取和待办创建凭证，暂时不能执行这项操作。', `digital-employee-action-items-unavailable-${message.message_id}`);
      return;
    }
    try {
      const documentId = config.actionItemDocumentToken;
      if (!documentId) {
        await sendText(client, message.chat_id, '还没有配置用来提取行动项的会议纪要哦。', `digital-employee-no-action-doc-${message.message_id}`);
        return;
      }
      const documentText = await readAllowedFeishuDoc(client, documentId);
      const items = await runCodexActionItems(documentText);
      if (!items.length) {
        await sendText(client, message.chat_id, '这份纪要里没有提取到可以直接执行的事项哦。', `xiaozhao-batch-empty-${message.message_id}`);
        return;
      }
      pendingActions.set('task_batch', message.chat_id, senderOpenId, { items, senderOpenId });
      const lines = [
        '这份纪要没有明确负责人和截止时间，下面是我根据内容整理的建议待办：',
        ...items.map((item, index) => `${index + 1}. ${item.summary}${item.due ? `（${formatTaskTime(item.due)}）` : ''}`),
        '',
        '你回复“确认”后我再批量创建。',
      ];
      await sendText(client, message.chat_id, lines.join('\n'), `xiaozhao-batch-preview-${message.message_id}`);
    } catch (error) {
      console.error(`[task-batch-extract-error] ${message.message_id}:`, error);
      await sendText(client, message.chat_id, '刚刚没能从纪要里整理出待办，你稍后再试一次哦。', `xiaozhao-batch-extract-error-${message.message_id}`);
    }
    return;
  }
  const pendingTask = pendingActions.get('task', message.chat_id, senderOpenId);
  if (pendingTask && /^(确认|确认创建|可以|好|好哦)[。！! ]*$/.test(cleanText)) {
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置待办创建凭证，暂时不能创建。', `digital-employee-task-unavailable-${message.message_id}`);
      return;
    }
    let execution;
    try {
      execution = await executeMutationOnce({
        state,
        executionKey: `task:${message.message_id}`,
        kind: 'feishu_task_create',
        operation: () => createConfirmedTask(client, pendingTask),
      });
    } catch (error) {
      console.error(`[task-error] ${message.message_id}:`, error);
      pendingActions.delete('task', message.chat_id, senderOpenId);
      const answer = error instanceof MutationOutcomeAmbiguousError
        ? '这条待办的创建结果不确定。为了避免重复创建，我已经停止自动重试。请先在飞书待办中核对；确认没有创建后，再重新发起。'
        : '待办没有创建成功，请重新发起一次。';
      await sendText(client, message.chat_id, answer, `xiaozhao-task-error-${message.message_id}`);
      return;
    }
    const created = execution.result;
    await sendText(client, message.chat_id, `建好啦：${created.summary || pendingTask.summary}\n截止时间：${formatTaskTime(pendingTask.due)}`, `xiaozhao-task-${message.message_id}`);
    pendingActions.delete('task', message.chat_id, senderOpenId);
    audit('task_created', message, senderOpenId, {
      taskId: created.id,
      summary: created.summary || pendingTask.summary,
      replayed: execution.replayed,
    });
    return;
  }
  if (pendingTask && /^(取消|不用了|不建了)[。！! ]*$/.test(cleanText)) {
    pendingActions.delete('task', message.chat_id, senderOpenId);
    await sendText(client, message.chat_id, '好哦，那这条先不建。', `xiaozhao-task-cancel-${message.message_id}`);
    return;
  }
  const pendingCalendarEvent = pendingActions.get('calendar', message.chat_id, senderOpenId);
  if (pendingCalendarEvent && /^(确认|确认创建|可以|好|好哦)[。！! ]*$/.test(cleanText)) {
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置日程创建凭证，暂时不能创建。', `digital-employee-calendar-unavailable-${message.message_id}`);
      return;
    }
    let execution;
    try {
      execution = await executeMutationOnce({
        state,
        executionKey: `calendar:${message.message_id}`,
        kind: 'feishu_calendar_create',
        operation: () => createConfirmedCalendarEvent(client, pendingCalendarEvent),
      });
    } catch (error) {
      console.error(`[calendar-create-error] ${message.message_id}:`, error);
      pendingActions.delete('calendar', message.chat_id, senderOpenId);
      const answer = error instanceof MutationOutcomeAmbiguousError
        ? '这个日程的创建结果不确定。为了避免重复创建，我已经停止自动重试。请先在飞书日历中核对；确认没有创建后，再重新发起。'
        : '日程没有创建成功，请重新发起一次。';
      await sendText(client, message.chat_id, answer, `xiaozhao-event-error-${message.message_id}`);
      return;
    }
    const created = execution.result;
    await sendText(client, message.chat_id, `日程建好啦：${created.summary || pendingCalendarEvent.summary}\n${formatCalendarDraftTime(pendingCalendarEvent.start)}–${formatCalendarDraftTime(pendingCalendarEvent.end)}`, `xiaozhao-event-${message.message_id}`);
    pendingActions.delete('calendar', message.chat_id, senderOpenId);
    audit('calendar_created', message, senderOpenId, {
      eventId: created.event_id,
      summary: created.summary || pendingCalendarEvent.summary,
      replayed: execution.replayed,
    });
    return;
  }
  if (pendingCalendarEvent && /^(取消|不用了|不建了)[。！! ]*$/.test(cleanText)) {
    pendingActions.delete('calendar', message.chat_id, senderOpenId);
    await sendText(client, message.chat_id, '好哦，那这个日程先不建。', `xiaozhao-event-cancel-${message.message_id}`);
    return;
  }
  const calendarDraft = parseCalendarDraft(cleanText, senderOpenId);
  if (calendarDraft) {
    if (!canPerformMutation(senderOpenId, OWNER_OPEN_ID)) {
      await sendText(client, message.chat_id, '我可以帮你整理日程内容，但不能代表账号本人创建日程。', `digital-employee-calendar-owner-only-${message.message_id}`);
      return;
    }
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置日程创建凭证，暂时不能创建。', `digital-employee-calendar-unavailable-${message.message_id}`);
      return;
    }
    if (calendarDraft.missingTime || calendarDraft.missingSummary) {
      await sendText(client, message.chat_id, calendarDraft.missingTime ? '这个日程是几点到几点呀？' : '这个日程叫什么呀？', `xiaozhao-event-missing-${message.message_id}`);
      return;
    }
    pendingActions.set('calendar', message.chat_id, senderOpenId, calendarDraft);
    await sendText(client, message.chat_id, `我先这样建：\n${calendarDraft.summary}\n${formatCalendarDraftTime(calendarDraft.start)}–${formatCalendarDraftTime(calendarDraft.end)}\n\n你回复“确认”后我再创建。`, `xiaozhao-event-preview-${message.message_id}`);
    return;
  }
  const taskDraft = parseTaskDraft(cleanText, senderOpenId);
  if (taskDraft) {
    if (!canPerformMutation(senderOpenId, OWNER_OPEN_ID)) {
      await sendText(client, message.chat_id, '我可以帮你整理待办内容，但不能代表账号本人创建待办。', `digital-employee-task-owner-only-${message.message_id}`);
      return;
    }
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置待办创建凭证，暂时不能创建。', `digital-employee-task-unavailable-${message.message_id}`);
      return;
    }
    if (taskDraft.missingTime || taskDraft.missingSummary) {
      await sendText(client, message.chat_id, taskDraft.missingTime ? '几点提醒你呀？' : '这条待办写什么内容呀？', `xiaozhao-task-missing-${message.message_id}`);
      return;
    }
    pendingActions.set('task', message.chat_id, senderOpenId, taskDraft);
    await sendText(client, message.chat_id, `我先这样建：\n${taskDraft.summary}\n截止时间：${formatTaskTime(taskDraft.due)}\n\n你回复“确认”后我再创建。`, `xiaozhao-task-preview-${message.message_id}`);
    return;
  }
  const calendarWindow = parseCalendarQuery(cleanText);
  if (calendarWindow) {
    if (!client) {
      await sendText(client, message.chat_id, '当前真人身份入口还没有配置日历读取凭证，暂时查不了日程。', `digital-employee-calendar-query-unavailable-${message.message_id}`);
      return;
    }
    try {
      const events = await queryCalendarEvents(client, senderOpenId, calendarWindow);
      const answer = events.length
        ? `${calendarWindow.label}有这些安排：\n${events.map(event => `${formatEventTime(event)} ${event.summary || '未命名日程'}`).join('\n')}`
        : `${calendarWindow.label}日历里没有安排哦。`;
      await sendText(client, message.chat_id, answer, `xiaozhao-calendar-${message.message_id}`);
    } catch (error) {
      console.error(`[calendar-error] ${message.message_id}:`, error);
      await sendText(client, message.chat_id, '日历刚刚没查成功，你稍后再问我一次哦。', `xiaozhao-calendar-error-${message.message_id}`);
    }
    return;
  }
  const knowledgeResult = !imageRefs.length && !fileRef && ['text', 'post'].includes(message.message_type)
    ? await searchFeishuKnowledge(client, cleanText, senderOpenId)
    : null;
  let task = imageRefs.length
    ? `${cleanText ? `对方的问题是：${cleanText}\n` : ''}看一下图片里的内容，然后结合图片直接回复对方。如果是聊天截图，先理解对话语境，再给出最自然的回应或建议。`
    : cleanText;
  if (fileRef) {
    task = `${cleanText ? `对方的问题是：${cleanText}\n` : ''}请阅读文件“${fileRef.fileName || '未命名文件'}”，结合文件内容直接回复对方。`;
  }
  if (knowledgeResult?.denied) {
    task = knowledgeResult.reason === 'reader_not_allowed'
      ? '对方请求读取一份没有向其开放的飞书资料。请简短说明这份资料目前没有向他开放，不要泄露内容。'
      : '没有找到对方有权限读取的相关飞书资料。请自然说明没有查到已授权资料，并建议对方补充更具体的标题或日期。';
  }
  if (knowledgeResult?.unavailable) {
    task = '飞书资料搜索暂时不可用。请自然说明刚刚没有搜索成功，让对方稍后再试，不要让对方重新上传已经在飞书里的资料。';
  }
  task = effectiveTask(task, { messageType: message.message_type });
  console.log(
    `[receive] ${message.message_id}: ${message.message_type}`
      + ` request=${cleanText.slice(0, 100)}`
      + ` files=${fileRef ? 1 : 0} images=${imageRefs.length}`
      + ` documents=${knowledgeResult?.documents?.length || 0}`,
  );

  let tempDir = '';
  try {
    const imagePaths = [];
    if (imageRefs.length) {
      tempDir = await mkdtemp(join(tmpdir(), 'xiaozhao-feishu-'));
      for (let index = 0; index < imageRefs.slice(0, 4).length; index += 1) {
        const imageRef = imageRefs[index];
        const imagePath = join(tempDir, `message-image-${index + 1}.jpg`);
        const resource = await client.im.messageResource.get({
          params: { type: 'image' },
          path: { message_id: imageRef.messageId, file_key: imageRef.fileKey },
        });
        await resource.writeFile(imagePath);
        imagePaths.push(imagePath);
      }
    }
    if (fileRef) {
      tempDir = tempDir || await mkdtemp(join(tmpdir(), 'xiaozhao-feishu-'));
      const safeName = basename(fileRef.fileName || `attachment${extname(fileRef.fileName || '') || '.bin'}`);
      const filePath = join(tempDir, safeName);
      const resource = await client.im.messageResource.get({
        params: { type: 'file' },
        path: { message_id: fileRef.messageId, file_key: fileRef.fileKey },
      });
      await resource.writeFile(filePath);
      const extracted = await extractFileText(filePath);
      if (!extracted) throw new Error('No readable text found in file');
      task += `\n\n文件内容：\n${extracted}`;
    }
    if (knowledgeResult?.documents?.length) {
      const materials = [];
      for (const document of knowledgeResult.documents) {
        try {
          const documentText = await readAllowedFeishuDoc(client, document.documentId);
          materials.push(`《${document.title}》\n${documentText}\n${sourceLine(document)}`);
        } catch (error) {
          console.error(`[knowledge-read-error] ${document.documentId}:`, error.message);
        }
      }
      if (materials.length) {
        task += `\n\n下面是自动检索到且对提问者已授权的飞书资料。请只依据资料回答，不要编造；回答末尾保留来源标题和链接：\n\n${materials.join('\n\n---\n\n')}`;
      } else {
        task = '找到了相关资料，但读取原文失败。请自然说明刚刚没能打开资料，让对方稍后再试。';
      }
    }
    const history = formatHistory(message.chat_id, senderOpenId);
    const historyLabel = knowledgeResult?.documents?.length
      ? knowledgeMemoryLabel({ request: cleanText, documents: knowledgeResult.documents })
      : fileRef
        ? `${cleanText || '请求读取文件'}：${fileRef.fileName || '未命名文件'}`
        : imageRefs.length ? `${cleanText || '发送了图片'}（含图片）` : task;
    remember(message.chat_id, senderOpenId, 'user', historyLabel);
    const answer = await runCodex(task, history, imagePaths, decision);
    remember(message.chat_id, senderOpenId, 'assistant', answer);
    await sendText(client, message.chat_id, answer, `xiaozhao-${message.message_id}`);
    audit('message_replied', message, senderOpenId, { artifact: false, answerChars: answer.length });
    console.log(`[reply] ${message.message_id}: ok`);
  } catch (error) {
    console.error(`[error] ${message.message_id}:`, error);
    throw error;
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function enqueueInbound(payload, source) {
  const messageId = payload?.message?.message_id;
  const validation = validateInboundPayload(payload);
  if (!validation.ok) {
    state.audit('inbound_rejected', {
      chatId: payload?.message?.chat_id || '',
      senderId: payload?.sender?.sender_id?.open_id || '',
      messageId: messageId || '',
      detail: { source, reason: validation.reason },
    });
    return false;
  }
  const senderOpenId = payload.sender?.sender_id?.open_id || '';
  const selfChat = payload.metadata?.selfChat === true;
  const operatorControl = payload.metadata?.operatorControl === true;
  const ownerActivity = payload.metadata?.ownerActivity === true;
  if (selfChat) state.markSelfChat(payload.message.chat_id);
  if (senderOpenId === OWNER_OPEN_ID
    && !(selfChat && payload.message.chat_type === 'p2p')
    && !operatorControl
    && !ownerActivity) {
    state.audit('inbound_rejected', {
      chatId: payload.message.chat_id || '',
      senderId: senderOpenId,
      messageId: messageId || '',
      detail: { source, reason: 'owner_message_outside_self_chat' },
    });
    return false;
  }
  const echoGuardEnabled = ownerActivity || (payload.message.chat_type === 'p2p'
    && (selfChat || payload.metadata?.channel === 'dingtalk'));
  if (echoGuardEnabled) {
    let text = '';
    try { text = String(JSON.parse(payload.message.content || '{}').text || ''); } catch {}
    if (selfChat && hasSelfChatOutboundMarker(text)) {
      if (state.seedInbound(messageId, 'outbound-marker', payload)) {
        state.audit('outbound_marker_ignored', {
          chatId: payload.message.chat_id || '',
          senderId: senderOpenId,
          messageId: messageId || '',
          detail: { source, channel: payload.metadata?.channel || 'feishu' },
        });
      }
      return false;
    }
    if (state.consumeOutboundEcho(payload.message.chat_id, text, { messageId })) {
      state.seedInbound(messageId, 'outbound-echo', payload);
      state.audit('outbound_echo_ignored', {
        chatId: payload.message.chat_id || '',
        senderId: senderOpenId,
        messageId: messageId || '',
        detail: { source, channel: payload.metadata?.channel || 'feishu' },
      });
      return false;
    }
  }
  if (state.hasInbound(messageId)) return false;
  const rateLimited = senderOpenId !== OWNER_OPEN_ID && !selfChat && !state.consumeRateLimit(
    `sender:${senderOpenId || payload.message.chat_id}`,
    Date.now(),
    config.rateLimitWindowMs,
    config.rateLimitMaxMessages,
  );
  const notifyRateLimit = rateLimited && state.consumeRateLimit(
    `rate-notice:${senderOpenId || payload.message.chat_id}`,
    Date.now(),
    config.rateLimitWindowMs,
    1,
  );
  const storedPayload = rateLimited
    ? {
        ...payload,
        metadata: {
          ...(payload.metadata || {}),
          rateLimited: true,
          notifyRateLimit,
        },
      }
    : payload;
  const inserted = state.enqueueInbound(messageId, source, storedPayload);
  if (inserted) {
    state.audit('inbound_enqueued', {
      chatId: payload.message.chat_id || '',
      senderId: payload.sender?.sender_id?.open_id || '',
      messageId,
      detail: { source, rateLimited },
    });
  }
  return inserted;
}

async function processStoredInbound(item, client = null) {
  const payload = item?.payload;
  const message = payload?.message;
  const sender = payload?.sender;
  const validation = validateInboundPayload(payload);
  if (!validation.ok) {
    const storedMessageId = message?.message_id || item?.messageId;
    if (storedMessageId) state.completeInbound(storedMessageId);
    state.audit('inbound_quarantined', {
      chatId: message?.chat_id || '',
      senderId: sender?.sender_id?.open_id || '',
      messageId: storedMessageId || '',
      detail: {
        reason: item?.payloadParseError ? 'stored payload is invalid JSON' : validation.reason,
      },
    });
    return;
  }

  await chatQueues.run(message.chat_id, async () => {
    const claimedAt = new Date().toISOString();
    if (!state.claimInbound(message.message_id, claimedAt)) return;
    try {
      if (payload.metadata?.rateLimited) {
        if (payload.metadata.notifyRateLimit) {
          await sendText(client, message.chat_id, '刚刚消息有点多，我先缓一下，过几分钟再 @ 我哦。', `digital-employee-rate-limit-${message.message_id}`);
        }
        audit('message_rate_limited', message, sender?.sender_id?.open_id || '');
        state.completeInbound(message.message_id);
        return;
      }
      await processIncoming(client, message, sender, {
        ...(payload.metadata || {}),
        inboundAttemptNumber: item.attempts + 1,
      });
      state.completeInbound(message.message_id);
    } catch (error) {
      const attemptNumber = item.attempts + 1;
      if (shouldRetryMessage(attemptNumber)) {
        const retryAt = new Date(Date.now() + retryDelayMs(attemptNumber)).toISOString();
        state.failInbound(message.message_id, error?.stack || error?.message || error, retryAt);
        state.audit('inbound_retry_scheduled', {
          chatId: message.chat_id,
          senderId: sender?.sender_id?.open_id || '',
          messageId: message.message_id,
          detail: {
            source: item.source,
            attemptNumber,
            retryAt,
            error: String(error?.message || error).slice(0, 1000),
          },
        });
        console.error(`[inbound-retry] ${message.message_id} at ${retryAt}:`, error);
        return;
      }

      try {
        await sendText(client, message.chat_id, '刚刚连续几次没处理成功，你稍后再发我一次哦。', `xiaozhao-error-${message.message_id}`);
        state.completeInbound(message.message_id);
        state.audit('inbound_failed_final', {
          chatId: message.chat_id,
          senderId: sender?.sender_id?.open_id || '',
          messageId: message.message_id,
          detail: { source: item.source, attemptNumber, error: String(error?.message || error).slice(0, 1000) },
        });
      } catch (sendError) {
        state.deadLetterInbound(message.message_id, sendError?.stack || sendError?.message || sendError);
        state.audit('inbound_dead_lettered', {
          chatId: message.chat_id,
          senderId: sender?.sender_id?.open_id || '',
          messageId: message.message_id,
          detail: {
            source: item.source,
            attemptNumber,
            processingError: String(error?.message || error).slice(0, 1000),
            noticeError: String(sendError?.message || sendError).slice(0, 1000),
          },
        });
        console.error(`[inbound-dead-letter] ${message.message_id}:`, sendError);
      }
    }
  });
}

async function drainReadyInbound(client = null) {
  while (!stopping) {
    const ready = state.listReadyInbound(new Date().toISOString(), 20);
    if (!ready.length) return;
    for (let index = 0; index < ready.length; index += MAX_CONCURRENT_REPLIES) {
      const batch = ready.slice(index, index + MAX_CONCURRENT_REPLIES);
      await Promise.all(batch.map(item => processStoredInbound(item, client)));
    }
  }
}

function triggerDrain(client = businessClient) {
  if (drainPromise) return drainPromise;
  drainPromise = drainReadyInbound(client)
    .catch(error => console.error('[inbound-drain-error]', error))
    .finally(() => { drainPromise = null; });
  return drainPromise;
}

async function fetchUserInboundMessages(startMs, endMs) {
  const start = toLarkSearchIso(new Date(startMs));
  const end = toLarkSearchIso(new Date(endMs));
  const [groupResult, p2pResult, selfResult, ownerControlResult] = await Promise.all([
    runLarkCli(buildPollingSearchArgs('group', start, end)),
    runLarkCli(buildPollingSearchArgs('p2p', start, end)),
    runLarkCli(buildSelfChatPollingArgs(OWNER_OPEN_ID, start, end)),
    runLarkCli(buildOwnerControlPollingArgs(OWNER_OPEN_ID, start, end)),
  ]);
  const selfMessages = markSelfChatMessages(selfResult);
  const regular = selectInboundMessages([
    ...assertCompleteSearchResult(groupResult, 'group'),
    ...assertCompleteSearchResult(p2pResult, 'p2p'),
    ...selfMessages,
  ], OWNER_OPEN_ID);
  const selfMessageIds = new Set(selfMessages.map(item => item.message_id));
  const ownerActivity = selectOwnerActivityMessages(
    assertCompleteSearchResult(ownerControlResult, 'owner-activity'),
    OWNER_OPEN_ID,
  ).filter(item => !selfMessageIds.has(item.message_id));
  return [...regular, ...ownerActivity].sort(comparePollingItems);
}

async function initializeUserPolling() {
  const nowMs = Date.now();
  if (state.get('poller', 'initialized_v1', false)) {
    if (!state.get('poller', 'cursor_ms', 0)) state.set('poller', 'cursor_ms', nowMs);
    return;
  }

  const snapshot = await fetchUserInboundMessages(nowMs - POLL_INITIAL_LOOKBACK_MS, nowMs);
  const seededAt = new Date().toISOString();
  let seeded = 0;
  for (const item of snapshot) {
    if (state.seedInbound(item.message_id, 'poll-baseline', normalizeSearchMessage(item), seededAt)) {
      seeded += 1;
    }
  }
  state.set('poller', 'cursor_ms', nowMs);
  state.set('poller', 'initialized_v1', true);
  state.audit('poller_baseline_seeded', { detail: { seeded, lookbackMs: POLL_INITIAL_LOOKBACK_MS } });
  console.log(`[poll] baseline ready; seeded ${seeded} existing message(s) without replying`);
}

async function pollUserMessagesOnce() {
  const pollStartedAt = Date.now();
  const nowMs = Date.now();
  const cursorMs = Number(state.get('poller', 'cursor_ms', nowMs));
  const { startMs, endMs } = planPollWindow(cursorMs, nowMs, {
    overlapMs: POLL_OVERLAP_MS,
    maxCatchupMs: POLL_MAX_CATCHUP_MS,
    maxWindowMs: POLL_WINDOW_MS,
  });
  const items = await fetchUserInboundMessages(startMs, endMs);
  let enqueued = 0;
  for (const item of items) {
    if (enqueueInbound(normalizeSearchMessage(item), 'user-poll')) enqueued += 1;
  }
  state.set('poller', 'cursor_ms', endMs);
  state.set('health', 'last_poll_success_at', new Date().toISOString());
  state.set('health', 'last_poll_duration_ms', Date.now() - pollStartedAt);
  state.unset('health', 'last_poll_error');
  if (enqueued) {
    console.log(`[poll] enqueued ${enqueued} new message(s)`);
    triggerDrain();
  }
  return enqueued;
}

function wait(ms) {
  return shutdownDelay.wait(ms);
}

async function runUserPollingLoop() {
  let failures = 0;
  while (!stopping) {
    const startedAt = Date.now();
    try {
      await pollUserMessagesOnce();
      failures = 0;
      triggerDrain();
    } catch (error) {
      if (stopping) break;
      failures += 1;
      const delayMs = pollFailureDelayMs(error, failures, {
        baseIntervalMs: POLL_INTERVAL_MS,
      });
      const failureSummary = processFailureSummary(error);
      state.set('health', 'last_poll_error', {
        at: new Date().toISOString(),
        failures,
        error: failureSummary,
      });
      state.audit('poller_error', { detail: { failures, delayMs, error: failureSummary } });
      console.error(`[poll-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
      continue;
    }
    const elapsed = Date.now() - startedAt;
    await wait(Math.max(250, POLL_INTERVAL_MS - elapsed));
  }
}

function dingTalkSelfUserId() {
  const profile = String(config.dingtalkProfile || '');
  const separator = profile.indexOf(':');
  return separator >= 0 ? profile.slice(separator + 1).trim() : '';
}

function dingTalkPollingTime(timestampMs) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(timestampMs));
  const value = type => parts.find(part => part.type === type)?.value || '';
  return `${value('year')}-${value('month')}-${value('day')} ${value('hour')}:${value('minute')}:${value('second')}`;
}

async function fetchDingTalkSelfMessages(startMs, endMs) {
  const userId = dingTalkSelfUserId();
  if (!config.dingtalkEnabled || !userId) return [];
  const { stdout, stderr } = await runBufferedProcess(
    config.dingtalkBin,
    buildDingTalkSelfPollingArgs(
      config.dingtalkProfile,
      userId,
      dingTalkPollingTime(startMs),
    ),
    {
      cwd: WORKDIR,
      env: dingtalkProcessEnv(),
      timeoutMs: config.larkCliTimeoutMs,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    },
  );
  let result;
  try { result = JSON.parse(stdout); } catch {
    throw new Error(`dws self-chat poll returned invalid JSON: ${(stderr || stdout).slice(-800)}`);
  }
  if (result.success === false || result.error) {
    throw new Error(`dws self-chat poll failed: ${JSON.stringify(result.error || result).slice(0, 1000)}`);
  }
  return normalizeDingTalkSelfMessages(result)
    .filter(payload => Number(payload.message.create_time || 0) <= endMs);
}

async function initializeDingTalkSelfPolling() {
  if (!config.dingtalkEnabled || !dingTalkSelfUserId()) return false;
  const nowMs = Date.now();
  if (!state.get('dingtalk_self_poller', 'initialized_v1', false)) {
    const snapshot = await fetchDingTalkSelfMessages(nowMs - POLL_INITIAL_LOOKBACK_MS, nowMs);
    const seededAt = new Date().toISOString();
    let seeded = 0;
    for (const payload of snapshot) {
      if (state.seedInbound(payload.message.message_id, 'dingtalk-self-baseline', payload, seededAt)) {
        seeded += 1;
      }
    }
    state.set('dingtalk_self_poller', 'cursor_ms', nowMs);
    state.set('dingtalk_self_poller', 'initialized_v1', true);
    state.audit('dingtalk_self_poller_baseline_seeded', { detail: { seeded } });
    console.log(`[dingtalk-self-poll] baseline ready; seeded ${seeded} existing message(s)`);
    return true;
  }
  if (!state.get('dingtalk_self_poller', 'cursor_ms', 0)) {
    state.set('dingtalk_self_poller', 'cursor_ms', nowMs);
  }
  return true;
}

async function pollDingTalkSelfMessagesOnce() {
  const nowMs = Date.now();
  const cursorMs = Number(state.get('dingtalk_self_poller', 'cursor_ms', nowMs));
  const { startMs, endMs } = planPollWindow(cursorMs, nowMs, {
    overlapMs: POLL_OVERLAP_MS,
    maxCatchupMs: POLL_MAX_CATCHUP_MS,
    maxWindowMs: POLL_WINDOW_MS,
  });
  const payloads = await fetchDingTalkSelfMessages(startMs, endMs);
  let enqueued = 0;
  for (const payload of payloads) {
    if (enqueueInbound(payload, 'dingtalk-self-poll')) enqueued += 1;
  }
  state.set('dingtalk_self_poller', 'cursor_ms', endMs);
  state.set('health', 'last_dingtalk_self_poll_success_at', new Date().toISOString());
  state.unset('health', 'last_dingtalk_self_poll_error');
  if (enqueued) {
    console.log(`[dingtalk-self-poll] enqueued ${enqueued} new message(s)`);
    triggerDrain();
  }
  return enqueued;
}

async function runDingTalkSelfPollingLoop() {
  let failures = 0;
  while (!stopping) {
    const startedAt = Date.now();
    try {
      await pollDingTalkSelfMessagesOnce();
      failures = 0;
    } catch (error) {
      if (stopping) break;
      failures += 1;
      const delayMs = pollFailureDelayMs(error, failures, { baseIntervalMs: POLL_INTERVAL_MS });
      const summary = processFailureSummary(error);
      state.set('health', 'last_dingtalk_self_poll_error', {
        at: new Date().toISOString(), error: summary,
      });
      state.audit('dingtalk_self_poll_error', { detail: { failures, delayMs, error: summary } });
      console.error(`[dingtalk-self-poll-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
      continue;
    }
    await wait(Math.max(0, POLL_INTERVAL_MS - (Date.now() - startedAt)));
  }
}

async function fetchDingTalkWukongMessages(startMs, endMs) {
  if (!config.dingtalkEnabled || config.dingtalkTransport !== 'wukong-polling') return [];
  return fetchDingTalkWukongWindow({
    bin: config.dingtalkBin,
    start: dingTalkPollingTime(startMs),
    end: dingTalkPollingTime(endMs),
    ownerOpenId: config.dingtalkOwnerOpenId,
    ownerNames: ['阿充', '阿充James', '冯周充'],
    mentionNames: ['阿充', '阿充James'],
    run: runBufferedProcess,
    runOptions: {
      cwd: WORKDIR,
      env: dingtalkProcessEnv(),
      timeoutMs: config.larkCliTimeoutMs,
      maxStdoutBytes: 16 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    },
  });
}

async function initializeDingTalkWukongPolling() {
  if (!config.dingtalkEnabled || config.dingtalkTransport !== 'wukong-polling') return false;
  const nowMs = Date.now();
  if (!state.get('dingtalk_wukong_poller', 'initialized_v1', false)) {
    const snapshot = await fetchDingTalkWukongMessages(
      nowMs - POLL_INITIAL_LOOKBACK_MS,
      nowMs,
    );
    const seededAt = new Date().toISOString();
    let seeded = 0;
    for (const payload of snapshot) {
      if (state.seedInbound(payload.message.message_id, 'dingtalk-wukong-baseline', payload, seededAt)) {
        seeded += 1;
      }
    }
    state.set('dingtalk_wukong_poller', 'cursor_ms', nowMs);
    state.set('dingtalk_wukong_poller', 'initialized_v1', true);
    state.audit('dingtalk_wukong_poller_baseline_seeded', { detail: { seeded } });
    console.log(`[dingtalk-wukong-poll] baseline ready; seeded ${seeded} existing message(s)`);
  } else if (!state.get('dingtalk_wukong_poller', 'cursor_ms', 0)) {
    state.set('dingtalk_wukong_poller', 'cursor_ms', nowMs);
  }
  const readyAt = new Date().toISOString();
  state.set('health', 'last_dingtalk_wukong_poll_success_at', readyAt);
  state.unset('health', 'last_dingtalk_wukong_poll_error');
  updateImChannelStatus('dingtalk', {
    authenticated: true,
    connected: true,
    lastReadyAt: readyAt,
    lastError: null,
  });
  return true;
}

async function pollDingTalkWukongMessagesOnce() {
  const nowMs = Date.now();
  const cursorMs = Number(state.get('dingtalk_wukong_poller', 'cursor_ms', nowMs));
  const { startMs, endMs } = planPollWindow(cursorMs, nowMs, {
    overlapMs: POLL_OVERLAP_MS,
    maxCatchupMs: POLL_MAX_CATCHUP_MS,
    maxWindowMs: POLL_WINDOW_MS,
  });
  const payloads = await fetchDingTalkWukongMessages(startMs, endMs);
  let enqueued = 0;
  for (const payload of payloads) {
    if (enqueueInbound(payload, 'dingtalk-wukong-poll')) enqueued += 1;
  }
  state.set('dingtalk_wukong_poller', 'cursor_ms', endMs);
  const readyAt = new Date().toISOString();
  state.set('health', 'last_dingtalk_wukong_poll_success_at', readyAt);
  state.unset('health', 'last_dingtalk_wukong_poll_error');
  updateImChannelStatus('dingtalk', {
    authenticated: true,
    connected: true,
    lastReadyAt: readyAt,
    lastError: null,
  });
  if (enqueued) {
    console.log(`[dingtalk-wukong-poll] enqueued ${enqueued} new message(s)`);
    triggerDrain();
  }
  return enqueued;
}

async function runDingTalkWukongPollingLoop() {
  let failures = 0;
  while (!stopping) {
    const startedAt = Date.now();
    try {
      await pollDingTalkWukongMessagesOnce();
      failures = 0;
    } catch (error) {
      if (stopping) break;
      failures += 1;
      const delayMs = pollFailureDelayMs(error, failures, { baseIntervalMs: POLL_INTERVAL_MS });
      const summary = processFailureSummary(error);
      const lastError = { at: new Date().toISOString(), error: summary };
      state.set('health', 'last_dingtalk_wukong_poll_error', lastError);
      state.audit('dingtalk_wukong_poll_error', { detail: { failures, delayMs, error: summary } });
      updateImChannelStatus('dingtalk', { connected: false, failures, lastError });
      console.error(`[dingtalk-wukong-poll-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
      continue;
    }
    await wait(Math.max(250, POLL_INTERVAL_MS - (Date.now() - startedAt)));
  }
}

async function runMulticaSyncLoop() {
  if (!MULTICA_SYNCHRONIZER) return;
  let failures = 0;
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const dispatch = MULTICA_FEEDBACK_WORKFLOW
        ? await MULTICA_FEEDBACK_WORKFLOW.deliverDispatches()
        : { dispatched: 0, failed: 0, dead: 0, pending: 0, deadTotal: 0 };
      const result = await MULTICA_SYNCHRONIZER.cycle();
      failures = 0;
      state.set('health', 'last_multica_sync_at', new Date().toISOString());
      state.set('health', 'last_multica_sync_result', result);
      state.set('health', 'last_multica_dispatch_result', dispatch);
      state.unset('health', 'last_multica_sync_error');
      if (result.changes || dispatch.dispatched || dispatch.failed) {
        console.log(`[multica-sync] changes=${result.changes} notified=${result.notified}`
          + ` dispatch=${dispatch.dispatched}/${dispatch.failed}`);
      }
    } catch (error) {
      if (stopping) break;
      failures += 1;
      const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(failures, 9)));
      const summary = processFailureSummary(error);
      state.set('health', 'last_multica_sync_error', {
        at: new Date().toISOString(),
        failures,
        error: summary,
      });
      state.audit('multica_sync_error', {
        detail: { failures, delayMs, error: summary },
      });
      console.error(`[multica-sync-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
      continue;
    }
    const elapsed = Date.now() - startedAt;
    await wait(Math.max(250, config.multicaSyncIntervalMs - elapsed));
  }
}

async function runA1SyncLoop() {
  if (!A1_SYNCHRONIZER) return;
  let failures = 0;
  while (!stopping) {
    const startedAt = Date.now();
    try {
      const result = await A1_SYNCHRONIZER.syncOnce();
      failures = 0;
      state.set('health', 'last_a1_sync_at', new Date().toISOString());
      state.set('health', 'last_a1_sync_result', result);
      state.unset('health', 'last_a1_sync_error');
      if (result.changed || result.delivered || result.failed) {
        console.log(`[a1-sync] changed=${result.changed} delivered=${result.delivered} failed=${result.failed}`);
      }
    } catch (error) {
      if (stopping) break;
      failures += 1;
      const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(failures, 9)));
      const summary = processFailureSummary(error);
      state.set('health', 'last_a1_sync_error', {
        at: new Date().toISOString(), failures, error: summary,
      });
      state.audit('a1_sync_error', { detail: { failures, delayMs, error: summary } });
      console.error(`[a1-sync-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
      continue;
    }
    await wait(Math.max(250, config.a1SyncIntervalMs - (Date.now() - startedAt)));
  }
}

async function createBusinessClient() {
  try {
    const appSecret = await getSecret();
    if (!appSecret) return null;
    sdkAppSecret = appSecret;
    return new lark.Client({ appId: APP_ID, appSecret, disableTokenCache: false });
  } catch (error) {
    state.audit('sdk_client_unavailable', {
      detail: { error: String(error?.message || error).slice(0, 500) },
    });
    return null;
  }
}

function updateImChannelStatus(channel, patch) {
  const previous = state.get('channel', channel, {});
  const next = {
    ...previous,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  state.set('channel', channel, next);
  if (typeof previous.connected === 'boolean'
    && previous.connected !== next.connected
    && next.enabled) {
    state.audit(next.connected ? 'im_channel_connected' : 'im_channel_disconnected', {
      detail: {
        channel,
        error: next.lastError?.error || '',
      },
    });
  }
}

function dingtalkProcessEnv() {
  return buildDingTalkProcessEnv({
    dingtalkBin: config.dingtalkBin,
    dingtalkChannel: config.dingtalkChannel,
    nodeBin: BUNDLED_NODE_BIN,
    pathEnv: process.env.PATH || '',
    baseEnv: process.env,
  });
}

function createDingTalkChannel() {
  return new DingTalkChannel({
    bin: config.dingtalkBin,
    profile: config.dingtalkProfile,
    transport: config.dingtalkTransport,
    run: (bin, args) => runBufferedProcess(bin, args, {
      cwd: WORKDIR,
      env: dingtalkProcessEnv(),
      timeoutMs: config.larkCliTimeoutMs,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    }),
    onStatus: patch => updateImChannelStatus('dingtalk', patch),
  });
}

async function runDingTalkEventConsumerOnce() {
  console.log('[dingtalk] starting official DWS personal event consumer');
  const child = spawn(config.dingtalkBin, dingTalkChannel.consumerArgs(), {
    cwd: WORKDIR,
    env: dingtalkProcessEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeDingTalkChild = child;
  let stderrTail = '';
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    stderrTail = `${stderrTail}${text}`.slice(-4_000);
    dingTalkChannel.handleStderr(text);
    process.stderr.write(chunk);
  });
  try {
    const exitCode = await consumeLinesUntilExit(child, line => {
      try {
        const accepted = dingTalkChannel.handleLine(line, payload => {
          if (enqueueInbound(payload, 'websocket-dingtalk-dws')) triggerDrain();
        });
        if (!accepted) console.error('[dingtalk-event-parse-error]', line.slice(0, 500));
      } catch (error) {
        const summary = processFailureSummary(error);
        state.audit('dingtalk_event_rejected', { detail: { error: summary } });
        console.error('[dingtalk-event-error]', error);
      }
    });
    if (stopping) return;
    throw new Error(
      `DWS event consumer stopped with exit code ${exitCode}: ${stderrTail.trim().slice(-1000)}`,
    );
  } finally {
    if (activeDingTalkChild === child) activeDingTalkChild = null;
    updateImChannelStatus('dingtalk', { connected: false });
  }
}

async function superviseDingTalkEvents() {
  let failures = 0;
  while (!stopping) {
    try {
      await runDingTalkEventConsumerOnce();
      failures = 0;
    } catch (error) {
      if (!shouldRetrySupervisor(stopping)) break;
      failures += 1;
      const summary = processFailureSummary(error);
      const authenticationFailure = /auth|login|token|ciphertext|keychain/i.test(summary);
      const delayMs = Math.min(5 * 60_000, 2_000 * (2 ** Math.min(failures, 8)));
      dingTalkChannel.reportError(error);
      updateImChannelStatus('dingtalk', {
        ...(authenticationFailure ? { authenticated: false } : {}),
        failures,
        lastError: { at: new Date().toISOString(), error: summary },
      });
      state.audit('dingtalk_channel_error', {
        detail: { failures, delayMs, error: summary },
      });
      console.error(`[dingtalk-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
    }
  }
}

async function initializeAdditionalImChannels() {
  updateImChannelStatus('dingtalk', {
    enabled: config.dingtalkEnabled,
    installed: existsSync(config.dingtalkBin),
    configured: existsSync(config.dingtalkBin),
    authenticated: false,
    connected: false,
    identityMode: 'user',
    transport: config.dingtalkTransport === 'wukong-polling'
      ? 'Wukong DWS polling'
      : 'DWS personal event stream',
  });
  updateImChannelStatus('wecom', {
    enabled: config.wecomEnabled,
    installed: true,
    configured: Boolean(config.wecomBotId),
    authenticated: false,
    connected: false,
    identityMode: 'bot',
    transport: 'official websocket sdk',
  });
  updateImChannelStatus('wechat', {
    enabled: config.geweEnabled,
    installed: true,
    configured: Boolean(config.geweAppId && config.gewePublicCallbackBaseUrl),
    authenticated: false,
    connected: false,
    callbackListening: false,
    callbackRegistered: false,
    identityMode: 'personal-third-party',
    transport: 'GeWe REST + public webhook',
    providerOfficial: false,
  });

  if (config.dingtalkEnabled) {
    if (!existsSync(config.dingtalkBin)) {
      updateImChannelStatus('dingtalk', {
        lastError: {
          at: new Date().toISOString(),
          error: `DWS executable not found: ${config.dingtalkBin}`,
        },
      });
    } else {
      dingTalkChannel = createDingTalkChannel();
      if (config.dingtalkTransport === 'event-stream') {
        dingTalkSupervisorPromise = superviseDingTalkEvents()
          .catch(error => console.error('[dingtalk-supervisor-fatal]', error));
      }
    }
  }

  if (config.wecomEnabled) {
    try {
      const secret = await getKeychainSecret(
        config.wecomKeychainService,
        config.wecomBotId,
      );
      if (!secret) throw new Error('WeCom bot secret is empty');
      weComChannel = new WeComChannel({
        botId: config.wecomBotId,
        secret,
        websocketUrl: config.wecomWebsocketUrl,
        logger: {
          debug: () => {},
          info: message => console.log(`[wecom] ${message}`),
          warn: message => console.warn(`[wecom] ${message}`),
          error: message => console.error(`[wecom] ${message}`),
        },
        onStatus: patch => updateImChannelStatus('wecom', patch),
      });
      weComChannel.start(payload => {
        if (enqueueInbound(payload, 'websocket-wecom-sdk')) triggerDrain();
      });
      console.log('[wecom] official WebSocket client started');
    } catch (error) {
      const summary = processFailureSummary(error);
      updateImChannelStatus('wecom', {
        configured: Boolean(config.wecomBotId),
        authenticated: false,
        connected: false,
        lastError: { at: new Date().toISOString(), error: summary },
      });
      state.audit('wecom_channel_error', { detail: { error: summary } });
      console.error('[wecom-start-error]', error);
    }
  }

  if (config.geweEnabled) {
    try {
      if (!config.geweAppId) throw new Error('GeWe appId is not configured');
      if (!config.gewePublicCallbackBaseUrl) {
        throw new Error('GeWe public HTTPS callback base URL is not configured');
      }
      const token = await getKeychainSecret(config.geweKeychainService, config.geweAppId);
      if (!token) throw new Error('GeWe API token is empty');
      const callbackSecret = await ensureKeychainSecret(
        config.geweKeychainService,
        `${config.geweAppId}:callback`,
      );
      geWeChannel = new GeWeChannel({
        appId: config.geweAppId,
        token,
        apiBaseUrl: config.geweApiBaseUrl,
        mentionNames: config.geweMentionNames,
        onStatus: patch => updateImChannelStatus('wechat', patch),
      });
      geWeWebhookServer = new GeWeWebhookServer({
        channel: geWeChannel,
        callbackSecret,
        port: config.geweCallbackPort,
        onStatus: patch => updateImChannelStatus('wechat', patch),
        onMessage: payload => {
          if (enqueueInbound(payload, 'webhook-gewe-personal-wechat')) triggerDrain();
        },
      });
      await geWeWebhookServer.start();
      const callbackUrl = `${config.gewePublicCallbackBaseUrl.replace(/\/$/, '')}${geWeWebhookServer.path()}`;
      await geWeChannel.setCallback(callbackUrl);
      updateImChannelStatus('wechat', { callbackRegistered: true });
      await geWeChannel.checkOnline();
      geWeMonitorPromise = superviseGeWeHealth()
        .catch(error => console.error('[wechat-gewe-monitor-fatal]', error));
      console.log(`[wechat] GeWe personal WeChat webhook listening on 127.0.0.1:${config.geweCallbackPort}`);
    } catch (error) {
      const summary = processFailureSummary(error);
      if (geWeWebhookServer) await geWeWebhookServer.stop().catch(() => {});
      geWeWebhookServer = null;
      geWeChannel = null;
      updateImChannelStatus('wechat', {
        configured: Boolean(config.geweAppId && config.gewePublicCallbackBaseUrl),
        authenticated: false,
        connected: false,
        callbackListening: false,
        lastError: { at: new Date().toISOString(), error: summary },
      });
      state.audit('wechat_channel_error', { detail: { error: summary } });
      console.error('[wechat-gewe-start-error]', error);
    }
  }
}

async function superviseGeWeHealth() {
  while (!stopping && geWeChannel) {
    await wait(30_000);
    if (stopping || !geWeChannel) break;
    try {
      await geWeChannel.checkOnline();
    } catch (error) {
      const summary = processFailureSummary(error);
      state.audit('wechat_channel_error', { detail: { error: summary } });
      console.error('[wechat-gewe-health-error]', error);
    }
  }
}

async function mainWithSdk(client) {
  if (!client || !sdkAppSecret) throw new Error('SDK event transport requires an app secret in Keychain');
  const dispatcher = new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async data => {
      const message = data?.message;
      const sender = data?.sender;
      if (!message?.message_id) return;
      enqueueInbound({ message, sender }, 'websocket-sdk');
      triggerDrain(client);
    },
  });

  let terminalError = null;
  const wsClient = new lark.WSClient({
    appId: APP_ID,
    appSecret: sdkAppSecret,
    loggerLevel: lark.LoggerLevel.info,
    handshakeTimeoutMs: 15_000,
    wsConfig: { pingTimeout: 15 },
    onReady: () => {
      state.set('health', 'last_websocket_ready_at', new Date().toISOString());
      state.set('health', 'websocket_connected', true);
    },
    onError: error => { terminalError = error || new Error('SDK websocket failed'); },
  });
  activeSdkWsClient = wsClient;
  console.log('[bridge] starting Feishu long connection');
  try {
    await wsClient.start({ eventDispatcher: dispatcher });
    while (!stopping) {
      await wait(1_000);
      const status = wsClient.getConnectionStatus();
      if (terminalError || status.state === 'failed') {
        throw terminalError || new Error('SDK websocket entered failed state');
      }
    }
  } finally {
    if (activeSdkWsClient === wsClient) {
      activeSdkWsClient = null;
      wsClient.close({ force: true });
    }
    state.set('health', 'websocket_connected', false);
  }
}

function normalizeCliEvent(event) {
  const messageType = event.message_type || 'text';
  const text = typeof event.content === 'string' ? event.content : JSON.stringify(event.content || '');
  return {
    message: {
      message_id: event.message_id || event.id || event.event_id,
      chat_id: event.chat_id,
      chat_type: event.chat_type,
      message_type: messageType,
      create_time: event.create_time || event.timestamp || String(Date.now()),
      content: JSON.stringify({ text }),
      mentions: event.chat_type === 'group' ? [{ id: APP_ID }] : [],
    },
    sender: {
      sender_type: 'user',
      sender_id: { open_id: event.sender_id || '' },
    },
  };
}

async function runLarkCliEventConsumerOnce() {
  console.log('[bridge] starting official lark-cli event consumer');
  const child = spawn(LARK_CLI, [
    'event', 'consume', 'im.message.receive_v1',
    '--as', 'bot',
  ], {
    cwd: WORKDIR,
    env: larkCliEnv(),
    // event consume treats stdin EOF as cancellation, so keep a pipe open.
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  activeEventChild = child;
  child.stderr.on('data', chunk => {
    const text = chunk.toString();
    if (text.includes('[event] ready')) {
      state.set('health', 'last_websocket_ready_at', new Date().toISOString());
      state.set('health', 'websocket_connected', true);
    }
    process.stderr.write(chunk);
  });

  const exitCode = await consumeLinesUntilExit(child, line => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      console.error('[event-parse-error]', line.slice(0, 500));
      return;
    }
    const { message, sender } = normalizeCliEvent(event);
    if (!message.message_id) return;
    enqueueInbound({ message, sender }, 'websocket-lark-cli');
    triggerDrain();
  });

  activeEventChild = null;
  state.set('health', 'websocket_connected', false);
  if (stopping) return;
  throw new Error(`lark-cli event consumer stopped with exit code ${exitCode}`);
}

async function superviseLarkCliEvents() {
  let failures = 0;
  while (!stopping) {
    try {
      await runLarkCliEventConsumerOnce();
      failures = 0;
    } catch (error) {
      if (!shouldRetrySupervisor(stopping)) break;
      failures += 1;
      const delayMs = Math.min(30_000, 1_000 * (2 ** Math.min(failures, 5)));
      state.audit('websocket_error', { detail: { failures, delayMs, error: String(error?.message || error).slice(0, 1000) } });
      console.error(`[websocket-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
    }
  }
}

async function superviseSdkEvents(client) {
  let failures = 0;
  while (!stopping) {
    try {
      await mainWithSdk(client);
      if (!stopping) throw new Error('SDK websocket stopped unexpectedly');
    } catch (error) {
      if (!shouldRetrySupervisor(stopping)) break;
      failures += 1;
      const delayMs = Math.min(5 * 60_000, 1_000 * (2 ** Math.min(failures, 9)));
      state.audit('websocket_sdk_error', {
        detail: { failures, delayMs, error: String(error?.message || error).slice(0, 1000) },
      });
      console.error(`[websocket-sdk-error] retry in ${delayMs}ms:`, error);
      await wait(delayMs);
    }
  }
}

async function runMaintenance() {
  try {
    const pruned = state.prune();
    const rotated = await Promise.all([
      rotateLogIfNeeded(join(WORKDIR, 'bridge.log')),
      rotateLogIfNeeded(join(WORKDIR, 'bridge-error.log')),
    ]);
    let backupResult = null;
    try {
      backupResult = await createVerifiedDatabaseBackup({
        db: state.db,
        backupDir: DATABASE_BACKUP_DIR,
        retain: 14,
      });
      state.set('health', 'last_database_backup_at', new Date().toISOString());
      state.set('health', 'last_database_backup_result', {
        integrity: backupResult.integrity,
        bytes: backupResult.bytes,
        retained: backupResult.retained,
      });
      state.unset('health', 'last_database_backup_error');
    } catch (backupError) {
      const summary = processFailureSummary(backupError);
      state.set('health', 'last_database_backup_error', {
        at: new Date().toISOString(),
        error: summary,
      });
      state.audit('database_backup_error', { detail: { error: summary } });
    }
    state.set('health', 'last_maintenance_at', new Date().toISOString());
    if (Object.values(pruned).some(Boolean) || rotated.some(Boolean) || backupResult) {
      console.log(`[maintenance] pruned inbound=${pruned.inbound} audit=${pruned.audit} conversation=${pruned.conversation} pending_action=${pruned.pendingAction} rate_limit=${pruned.rateLimit} mutation=${pruned.mutation} multica_dead=${pruned.multicaNotification} logs_rotated=${rotated.filter(Boolean).length} backup=${backupResult?.integrity || 'failed'}`);
    }
  } catch (error) {
    state.audit('maintenance_error', { detail: { error: String(error?.message || error).slice(0, 1000) } });
    console.error('[maintenance-error]', error);
  }
}

function stopGracefully(signal) {
  if (stopping) return;
  stopping = true;
  shutdownDelay.stop();
  console.log(`[bridge] stopping on ${signal}`);
  if (activeEventChild && !activeEventChild.killed) activeEventChild.kill('SIGTERM');
  if (activeDingTalkChild && !activeDingTalkChild.killed) activeDingTalkChild.kill('SIGTERM');
  if (weComChannel) {
    weComChannel.stop();
    weComChannel = null;
  }
  if (geWeWebhookServer) {
    geWeWebhookServer.stop().catch(() => {});
    geWeWebhookServer = null;
  }
  geWeChannel = null;
  if (activeSdkWsClient) {
    const sdkWsClient = activeSdkWsClient;
    activeSdkWsClient = null;
    sdkWsClient.close({ force: true });
  }
  const terminated = terminateAllBufferedProcesses();
  if (terminated) console.log(`[bridge] terminated ${terminated} active helper process(es)`);
}

async function main() {
  process.once('SIGTERM', () => stopGracefully('SIGTERM'));
  process.once('SIGINT', () => stopGracefully('SIGINT'));

  try {
    state.set('health', 'last_start_at', new Date().toISOString());
    state.set('health', 'ai_runtime', {
      configured: config.aiRuntime,
      selected: SELECTED_AI_RUNTIME.id,
      label: SELECTED_AI_RUNTIME.label,
    });
    state.set('health', 'websocket_connected', false);
    state.set('health', 'feishu_enabled', RUNTIME_MODE.feishuEnabled);
    const recovered = state.recoverProcessingInbound(new Date().toISOString());
    if (recovered) console.log(`[inbound] recovered ${recovered} stale message(s)`);
    await runMaintenance();
    const maintenanceTimer = setInterval(() => { runMaintenance(); }, 6 * 60 * 60_000);
    maintenanceTimer.unref();
    if (RUNTIME_MODE.feishuEnabled) {
      businessClient = await createBusinessClient();
      await initializeUserPolling();
    }
    triggerDrain();
    await initializeAdditionalImChannels();
    const dingTalkSelfPolling = await initializeOptionalPoller(
      config.dingtalkTransport === 'wukong-polling'
        ? initializeDingTalkWukongPolling
        : initializeDingTalkSelfPolling,
    );
    if (dingTalkSelfPolling.error) {
      const summary = processFailureSummary(dingTalkSelfPolling.error);
      const healthKey = config.dingtalkTransport === 'wukong-polling'
        ? 'last_dingtalk_wukong_poll_error'
        : 'last_dingtalk_self_poll_error';
      state.set('health', healthKey, {
        at: new Date().toISOString(), error: summary,
      });
      state.audit('dingtalk_self_poll_unavailable', { detail: { error: summary } });
      console.error('[dingtalk-self-poll-unavailable]', dingTalkSelfPolling.error);
    }
    if (dingTalkSelfPolling.active) {
      const runPollingLoop = config.dingtalkTransport === 'wukong-polling'
        ? runDingTalkWukongPollingLoop
        : runDingTalkSelfPollingLoop;
      dingTalkSelfPollingPromise = runPollingLoop()
        .catch(error => console.error('[dingtalk-poll-fatal]', error));
    }
    if (MULTICA_SYNCHRONIZER) {
      multicaSyncPromise = runMulticaSyncLoop()
        .catch(error => console.error('[multica-sync-fatal]', error));
      console.log(`[multica-sync] active every ${config.multicaSyncIntervalMs}ms across all workspaces`);
    }
    if (A1_SYNCHRONIZER) {
      a1SyncPromise = runA1SyncLoop()
        .catch(error => console.error('[a1-sync-fatal]', error));
      console.log(`[a1-sync] active every ${config.a1SyncIntervalMs}ms`);
    }

    if (RUNTIME_MODE.feishuEnabled) {
      if (config.eventTransport === 'sdk') {
        superviseSdkEvents(businessClient).catch(error => console.error('[websocket-sdk-supervisor-fatal]', error));
      } else {
        superviseLarkCliEvents().catch(error => console.error('[websocket-supervisor-fatal]', error));
      }
    }
    console.log(`[ai-runtime] selected ${SELECTED_AI_RUNTIME.label} (${config.aiRuntime})`);
    if (RUNTIME_MODE.feishuEnabled) {
      console.log(`[poll] user message polling active every ${POLL_INTERVAL_MS}ms; websocket auxiliary active`);
      await runUserPollingLoop();
    } else {
      console.log(`[channel] Feishu disabled; primary=${RUNTIME_MODE.primaryChannel}`);
      while (!stopping) await wait(1000);
    }
    if (drainPromise) await drainPromise.catch(() => {});
    if (multicaSyncPromise) await multicaSyncPromise.catch(() => {});
    if (a1SyncPromise) await a1SyncPromise.catch(() => {});
    if (dingTalkSupervisorPromise) await dingTalkSupervisorPromise.catch(() => {});
    if (dingTalkSelfPollingPromise) await dingTalkSelfPollingPromise.catch(() => {});
    if (geWeMonitorPromise) await geWeMonitorPromise.catch(() => {});
  } finally {
    try {
      state.close();
    } finally {
      await singletonLock.release();
    }
  }
}

main().catch(error => {
  console.error('[fatal]', error);
  process.exitCode = 1;
});
