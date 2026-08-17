import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedInteger } from './reliability.mjs';
import {
  validateEnterpriseChatConfiguration,
  validateFeishuConfiguration,
} from './runtime-mode.mjs';

const srcDir = dirname(fileURLToPath(import.meta.url));
const workdir = resolve(srcDir, '..');
const configPath = process.env.DIGITAL_EMPLOYEE_CONFIG || join(workdir, 'config.local.json');
if (!existsSync(configPath)) {
  throw new Error(`缺少配置文件：${configPath}\n请复制 config.example.json 为 config.local.json 并填写。`);
}
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const home = process.env.HOME || '';
if (!Array.isArray(raw.authorizedChatIds || [])) {
  throw new Error('config.local.json 的 authorizedChatIds 必须是数组');
}

function boundedNumber(value, { name, fallback, min, max }) {
  const effective = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(effective) || effective < min || effective > max) {
    throw new Error(`${name} must be a number between ${min} and ${max}`);
  }
  return effective;
}

function semanticGroupAliases(value) {
  const effective = value === undefined
    ? ['AIPRO', '詹老师助理', '数字人', '詹老师']
    : value;
  if (!Array.isArray(effective) || effective.length > 20
    || effective.some(item => typeof item !== 'string' || !item.trim() || item.length > 100)) {
    throw new Error('semanticGroupAliases must contain at most 20 non-empty strings');
  }
  return [...new Set(effective.map(item => item.trim()))];
}

function boundedStringArray(value, { name, maxItems = 20, maxLength = 500 } = {}) {
  const effective = value === undefined ? [] : value;
  if (!Array.isArray(effective) || effective.length > maxItems
    || effective.some(item => typeof item !== 'string' || !item.trim() || item.length > maxLength)) {
    throw new Error(`${name} must contain at most ${maxItems} non-empty strings`);
  }
  return [...new Set(effective.map(item => item.trim()))];
}

function dailyWindow(value, { name, fallback }) {
  const normalized = String(value === undefined ? fallback : value).trim();
  const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)-([01]\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`${name} must use HH:MM-HH:MM`);
  const start = Number(match[1]) * 60 + Number(match[2]);
  const end = Number(match[3]) * 60 + Number(match[4]);
  if (end - start < 30) throw new Error(`${name} must end at least 30 minutes after it starts`);
  return normalized;
}

export const config = {
  feishuEnabled: raw.feishuEnabled !== false,
  feishuAppId: raw.feishuAppId || '',
  ownerOpenId: raw.ownerOpenId || '',
  keychainService: raw.keychainService || 'codex-feishu-digital-employee',
  authorizedChatIds: raw.authorizedChatIds || [],
  allowAllChats: raw.allowAllChats === true,
  ownerContactPhone: String(raw.ownerContactPhone || '').trim(),
  actionItemDocumentToken: raw.actionItemDocumentToken || '',
  digitalTwinLabel: raw.digitalTwinLabel ?? '【AI数字分身】',
  eventTransport: raw.eventTransport || 'lark-cli',
  pollIntervalMs: boundedInteger(raw.pollIntervalMs, {
    name: 'pollIntervalMs', fallback: 30000, min: 1000, max: 60000,
  }),
  pollOverlapMs: boundedInteger(raw.pollOverlapMs, {
    name: 'pollOverlapMs', fallback: 180000, min: 60000, max: 3600000,
  }),
  pollInitialLookbackMs: boundedInteger(raw.pollInitialLookbackMs, {
    name: 'pollInitialLookbackMs', fallback: 900000, min: 60000, max: 86400000,
  }),
  pollMaxCatchupMs: boundedInteger(raw.pollMaxCatchupMs, {
    name: 'pollMaxCatchupMs', fallback: 86400000, min: 60000, max: 7 * 86400000,
  }),
  pollWindowMs: boundedInteger(raw.pollWindowMs, {
    name: 'pollWindowMs', fallback: 900000, min: 60000, max: 3600000,
  }),
  maxConcurrentReplies: boundedInteger(raw.maxConcurrentReplies, {
    name: 'maxConcurrentReplies', fallback: 2, min: 1, max: 4,
  }),
  larkCliTimeoutMs: boundedInteger(raw.larkCliTimeoutMs, {
    name: 'larkCliTimeoutMs', fallback: 45000, min: 5000, max: 180000,
  }),
  codexTimeoutMs: boundedInteger(raw.codexTimeoutMs, {
    name: 'codexTimeoutMs', fallback: 120000, min: 10000, max: 300000,
  }),
  helperTimeoutMs: boundedInteger(raw.helperTimeoutMs, {
    name: 'helperTimeoutMs', fallback: 30000, min: 5000, max: 120000,
  }),
  rateLimitWindowMs: boundedInteger(raw.rateLimitWindowMs, {
    name: 'rateLimitWindowMs', fallback: 300000, min: 60000, max: 3600000,
  }),
  rateLimitMaxMessages: boundedInteger(raw.rateLimitMaxMessages, {
    name: 'rateLimitMaxMessages', fallback: 10, min: 1, max: 100,
  }),
  semanticRepeatGuardEnabled: raw.semanticRepeatGuardEnabled !== false,
  semanticRepeatWindowMs: boundedInteger(raw.semanticRepeatWindowMs, {
    name: 'semanticRepeatWindowMs', fallback: 30 * 60_000, min: 60_000, max: 24 * 60 * 60_000,
  }),
  semanticRepeatMaxReplies: boundedInteger(raw.semanticRepeatMaxReplies, {
    name: 'semanticRepeatMaxReplies', fallback: 2, min: 2, max: 5,
  }),
  semanticGroupEngagementEnabled: raw.semanticGroupEngagementEnabled !== false,
  semanticGroupReplyThreshold: boundedNumber(raw.semanticGroupReplyThreshold, {
    name: 'semanticGroupReplyThreshold', fallback: 0.86, min: 0.5, max: 0.99,
  }),
  semanticGroupEntryCooldownMs: boundedInteger(raw.semanticGroupEntryCooldownMs, {
    name: 'semanticGroupEntryCooldownMs', fallback: 120_000, min: 30_000, max: 60 * 60_000,
  }),
  semanticGroupAliases: semanticGroupAliases(raw.semanticGroupAliases),
  groupHostModeEnabled: raw.groupHostModeEnabled === true,
  groupHostChatIds: boundedStringArray(raw.groupHostChatIds, { name: 'groupHostChatIds' }),
  groupHostSilenceMs: boundedInteger(raw.groupHostSilenceMs, {
    name: 'groupHostSilenceMs', fallback: 75_000, min: 30_000, max: 180_000,
  }),
  groupHostReplyCooldownMs: boundedInteger(raw.groupHostReplyCooldownMs, {
    name: 'groupHostReplyCooldownMs', fallback: 180_000, min: 60_000, max: 900_000,
  }),
  adaptiveDiscussionEnabled: raw.adaptiveDiscussionEnabled !== false,
  adaptiveDiscussionMaxReplies: boundedInteger(raw.adaptiveDiscussionMaxReplies, {
    name: 'adaptiveDiscussionMaxReplies', fallback: 100, min: 10, max: 100,
  }),
  adaptiveDiscussionLowValueLimit: boundedInteger(raw.adaptiveDiscussionLowValueLimit, {
    name: 'adaptiveDiscussionLowValueLimit', fallback: 3, min: 2, max: 10,
  }),
  adaptiveDiscussionCooldownMs: boundedInteger(raw.adaptiveDiscussionCooldownMs, {
    name: 'adaptiveDiscussionCooldownMs', fallback: 30 * 60_000,
    min: 60_000, max: 120 * 60_000,
  }),
  webReaderEnabled: raw.webReaderEnabled !== false,
  webReaderMaxUrls: boundedInteger(raw.webReaderMaxUrls, {
    name: 'webReaderMaxUrls', fallback: 2, min: 1, max: 3,
  }),
  audioTranscriptionCommand: String(raw.audioTranscriptionCommand
    || join(home, 'Applications', 'AIPRO.app', 'Contents', 'MacOS', 'AIPROTranscribe')).trim(),
  audioTranscriptionArgs: Array.isArray(raw.audioTranscriptionArgs)
    ? raw.audioTranscriptionArgs.map(value => String(value)).slice(0, 20)
    : ['{input}', 'zh-CN'],
  aiRuntime: raw.aiRuntime || 'auto',
  enterpriseChatEnabled: raw.enterpriseChatEnabled === true,
  enterpriseChatTransport: String(raw.enterpriseChatTransport || 'event-stream').trim(),
  enterpriseChatProfile: raw.enterpriseChatProfile || '',
  enterpriseChatChannel: String(raw.enterpriseChatChannel || '').trim(),
  enterpriseChatOwnerOpenId: String(raw.enterpriseChatOwnerOpenId || '').trim(),
  enterpriseChatBin: raw.enterpriseChatBin || join(home, '.npm-global', 'bin', 'connector'),
  wecomEnabled: raw.wecomEnabled === true,
  wecomBotId: raw.wecomBotId || '',
  wecomKeychainService: raw.wecomKeychainService || 'aipro-wecom-bot',
  wecomWebsocketUrl: raw.wecomWebsocketUrl || 'wss://openws.work.weixin.qq.com',
  geweEnabled: raw.geweEnabled === true,
  geweAppId: raw.geweAppId || '',
  geweKeychainService: raw.geweKeychainService || 'aipro-gewe',
  geweApiBaseUrl: raw.geweApiBaseUrl || 'https://api.geweapi.com',
  gewePublicCallbackBaseUrl: raw.gewePublicCallbackBaseUrl || '',
  geweCallbackPort: boundedInteger(raw.geweCallbackPort, {
    name: 'geweCallbackPort', fallback: 17656, min: 1024, max: 65535,
  }),
  geweSilkDecoderCommand: String(raw.geweSilkDecoderCommand
    || join(workdir, 'data', 'tools', 'silk-v3-decoder', 'silk', 'decoder')).trim(),
  geweMentionNames: Array.isArray(raw.geweMentionNames)
    ? raw.geweMentionNames.map(value => String(value).trim()).filter(Boolean).slice(0, 10)
    : [],
  geweRelationshipMemoryEnabled: raw.geweRelationshipMemoryEnabled !== false,
  geweRelationshipMemoryIntervalMs: boundedInteger(raw.geweRelationshipMemoryIntervalMs, {
    name: 'geweRelationshipMemoryIntervalMs', fallback: 120_000, min: 60_000, max: 3_600_000,
  }),
  geweRelationshipMemoryBatchSize: boundedInteger(raw.geweRelationshipMemoryBatchSize, {
    name: 'geweRelationshipMemoryBatchSize', fallback: 10, min: 1, max: 50,
  }),
  geweRelationshipMemoryCapsuleMaxChars: boundedInteger(raw.geweRelationshipMemoryCapsuleMaxChars, {
    name: 'geweRelationshipMemoryCapsuleMaxChars', fallback: 1_200, min: 300, max: 4_000,
  }),
  geweRelationshipMemoryRecallLimit: boundedInteger(raw.geweRelationshipMemoryRecallLimit, {
    name: 'geweRelationshipMemoryRecallLimit', fallback: 6, min: 1, max: 12,
  }),
  geweNewcomerWelcomeEnabled: raw.geweNewcomerWelcomeEnabled === true,
  geweNewcomerWelcomeGroupId: String(raw.geweNewcomerWelcomeGroupId || '').trim(),
  geweNewcomerWelcomeGroupName: String(raw.geweNewcomerWelcomeGroupName || '').trim(),
  geweNewcomerWelcomeIntervalMs: boundedInteger(raw.geweNewcomerWelcomeIntervalMs, {
    name: 'geweNewcomerWelcomeIntervalMs', fallback: 120_000, min: 30_000, max: 900_000,
  }),
  geweDailyBriefingGroupId: String(raw.geweDailyBriefingGroupId || '').trim(),
  geweDailyBriefingGroupName: String(raw.geweDailyBriefingGroupName || '').trim(),
  geweMomentsEngagementEnabled: raw.geweMomentsEngagementEnabled === true,
  geweMomentsScanIntervalMs: boundedInteger(raw.geweMomentsScanIntervalMs, {
    name: 'geweMomentsScanIntervalMs', fallback: 300_000, min: 60_000, max: 86_400_000,
  }),
  geweMomentsMaxProactivePerDay: boundedInteger(raw.geweMomentsMaxProactivePerDay, {
    name: 'geweMomentsMaxProactivePerDay', fallback: 20, min: 1, max: 20,
  }),
  geweMomentsMaxRepliesPerDay: boundedInteger(raw.geweMomentsMaxRepliesPerDay, {
    name: 'geweMomentsMaxRepliesPerDay', fallback: 20, min: 1, max: 100,
  }),
  geweMomentsMaxThreadDepth: boundedInteger(raw.geweMomentsMaxThreadDepth, {
    name: 'geweMomentsMaxThreadDepth', fallback: 4, min: 1, max: 10,
  }),
  geweMomentsPostMaxAgeHours: boundedInteger(raw.geweMomentsPostMaxAgeHours, {
    name: 'geweMomentsPostMaxAgeHours', fallback: 36, min: 1, max: 168,
  }),
  geweMomentsPublisherEnabled: raw.geweMomentsPublisherEnabled === true,
  geweMomentsPublisherIntervalMs: boundedInteger(raw.geweMomentsPublisherIntervalMs, {
    name: 'geweMomentsPublisherIntervalMs', fallback: 60_000, min: 60_000, max: 900_000,
  }),
  geweMomentsPublisherMorningWindow: dailyWindow(raw.geweMomentsPublisherMorningWindow, {
    name: 'geweMomentsPublisherMorningWindow', fallback: '10:00-12:00',
  }),
  geweMomentsPublisherEveningWindow: dailyWindow(raw.geweMomentsPublisherEveningWindow, {
    name: 'geweMomentsPublisherEveningWindow', fallback: '18:30-21:00',
  }),
  geweOwnerArticleSyndicationEnabled: raw.geweOwnerArticleSyndicationEnabled === true,
  geweOwnerArticlePublisherIds: boundedStringArray(
    raw.geweOwnerArticlePublisherIds === undefined
      ? ['gh_07e3d1422f5e', 'BPM321GO', 'gh_63f557f95450', 'HuaYu_Consulting_21']
      : raw.geweOwnerArticlePublisherIds,
    { name: 'geweOwnerArticlePublisherIds', maxItems: 20, maxLength: 256 },
  ),
  geweOwnerArticleWechatIds: boundedStringArray(
    raw.geweOwnerArticleWechatIds === undefined ? ['fung5115'] : raw.geweOwnerArticleWechatIds,
    { name: 'geweOwnerArticleWechatIds', maxItems: 20, maxLength: 256 },
  ),
  multicaEnabled: raw.multicaEnabled === true,
  multicaProfile: raw.multicaProfile || 'desktop-api.multica.ai',
  multicaAppUrl: raw.multicaAppUrl || 'https://multica.ai',
  multicaDefaultWorkspaceId: raw.multicaDefaultWorkspaceId || '',
  multicaOwnerSquad: String(raw.multicaOwnerSquad || '詹老师的开发团伙').trim(),
  multicaSyncIntervalMs: boundedInteger(raw.multicaSyncIntervalMs, {
    name: 'multicaSyncIntervalMs', fallback: 10000, min: 5000, max: 300000,
  }),
  multicaMaxIssues: boundedInteger(raw.multicaMaxIssues, {
    name: 'multicaMaxIssues', fallback: 5000, min: 100, max: 20000,
  }),
  dailyLearningEnabled: raw.dailyLearningEnabled !== false,
  dailyLearningHour: boundedInteger(raw.dailyLearningHour, {
    name: 'dailyLearningHour', fallback: 1, min: 0, max: 23,
  }),
  dailyLearningConversationLimit: boundedInteger(raw.dailyLearningConversationLimit, {
    name: 'dailyLearningConversationLimit', fallback: 1_000, min: 1, max: 5_000,
  }),
  dashboardPort: boundedInteger(raw.dashboardPort, {
    name: 'dashboardPort', fallback: 17655, min: 1024, max: 65535,
  }),
  licensingEnforced: raw.licensingEnforced === true,
  licensingServiceUrl: String(raw.licensingServiceUrl || '').trim(),
  licensingProxyUrl: String(raw.licensingProxyUrl || raw.codexProxyUrl || '').trim(),
  licensingPublicKey: String(raw.licensingPublicKey || '').trim(),
  licensingProductId: String(raw.licensingProductId || 'AIPRO').trim(),
  workdir,
  codexBin: raw.codexBin || '/Applications/ChatGPT.app/Contents/Resources/codex',
  codexModel: raw.codexModel || 'gpt-5.6-terra',
  codexProxyUrl: raw.codexProxyUrl || '',
  larkCli: raw.larkCli || join(home, '.local', 'bin', 'lark-cli'),
  nodeBin: raw.nodeBin || join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin'),
  pythonBin: raw.pythonBin || join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
  multicaBin: raw.multicaBin
    || '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica',
};

export function validateCoreConfiguration(value = config) {
  validateFeishuConfiguration(value);
  if (!value.allowAllChats && !value.authorizedChatIds.length) {
    throw new Error('未启用 allowAllChats 时，config.local.json 至少需要一个 authorizedChatIds');
  }
}

if (!config.licensingEnforced) validateCoreConfiguration(config);
if (config.ownerContactPhone
  && !/^\+?[0-9][0-9 ()-]{5,28}[0-9]$/.test(config.ownerContactPhone)) {
  throw new Error('ownerContactPhone 格式无效');
}
if (config.codexProxyUrl) {
  const proxy = new URL(config.codexProxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error('codexProxyUrl 只能使用 http 或 https');
  }
}
if (config.licensingServiceUrl) {
  const licensingUrl = new URL(config.licensingServiceUrl);
  if (licensingUrl.protocol !== 'https:'
    || licensingUrl.username
    || licensingUrl.password
    || licensingUrl.search
    || licensingUrl.hash) {
    throw new Error('licensingServiceUrl 必须是不含凭据、查询或锚点的 HTTPS 地址');
  }
}
if (config.licensingProxyUrl) {
  const proxy = new URL(config.licensingProxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)
    || proxy.username
    || proxy.password
    || proxy.search
    || proxy.hash
    || !['', '/'].includes(proxy.pathname)) {
    throw new Error('licensingProxyUrl 必须是不含凭据、查询、路径或锚点的 http/https 地址');
  }
}
if (config.licensingEnforced) {
  if (!config.licensingServiceUrl) throw new Error('启用 licensingEnforced 时必须填写 licensingServiceUrl');
  if (!/^[A-Za-z0-9_-]{40,256}$/.test(config.licensingPublicKey)) {
    throw new Error('启用 licensingEnforced 时必须填写有效的 licensingPublicKey');
  }
  if (config.licensingProductId !== 'AIPRO') {
    throw new Error('licensingProductId 必须是 AIPRO');
  }
}
{
  const multicaAppUrl = new URL(config.multicaAppUrl);
  if (!['http:', 'https:'].includes(multicaAppUrl.protocol)
    || multicaAppUrl.username || multicaAppUrl.password) {
    throw new Error('multicaAppUrl 只能使用 http 或 https，且不能包含账号密码');
  }
}
if (!['lark-cli', 'sdk'].includes(config.eventTransport)) {
  throw new Error('eventTransport 只能是 lark-cli 或 sdk');
}
if (!['auto', 'codex', 'qoder', 'codebuddy', 'trae'].includes(config.aiRuntime)) {
  throw new Error('aiRuntime 只能是 auto、codex、qoder、codebuddy 或 trae');
}
validateEnterpriseChatConfiguration(config);
if (config.wecomEnabled && !config.wecomBotId) {
  throw new Error('启用 wecomEnabled 时必须填写 wecomBotId');
}
if (!/^wss:\/\/[^/\s]+(?:\/.*)?$/i.test(config.wecomWebsocketUrl)) {
  throw new Error('wecomWebsocketUrl 必须是 wss 地址');
}
if (config.geweNewcomerWelcomeEnabled) {
  if (!config.geweNewcomerWelcomeGroupId.endsWith('@chatroom')
    || config.geweNewcomerWelcomeGroupId.length > 500) {
    throw new Error('geweNewcomerWelcomeGroupId 必须是有效的 @chatroom 群标识');
  }
  if (!config.geweNewcomerWelcomeGroupName
    || config.geweNewcomerWelcomeGroupName.length > 200) {
    throw new Error('geweNewcomerWelcomeGroupName 必须是非空群名称');
  }
}
if (config.geweDailyBriefingGroupId || config.geweDailyBriefingGroupName) {
  if (!config.geweDailyBriefingGroupId.endsWith('@chatroom')
    || config.geweDailyBriefingGroupId.length > 500) {
    throw new Error('geweDailyBriefingGroupId 必须是有效的 @chatroom 群标识');
  }
  if (!config.geweDailyBriefingGroupName
    || config.geweDailyBriefingGroupName.length > 200) {
    throw new Error('geweDailyBriefingGroupName 必须是非空群名称');
  }
}
for (const [name, value] of [
  ['geweApiBaseUrl', config.geweApiBaseUrl],
  ['gewePublicCallbackBaseUrl', config.gewePublicCallbackBaseUrl],
]) {
  if (!value && name === 'gewePublicCallbackBaseUrl') continue;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} 必须是不含凭据、查询或锚点的 HTTPS 地址`);
  }
}
if (config.multicaDefaultWorkspaceId
  && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(config.multicaDefaultWorkspaceId)) {
  throw new Error('multicaDefaultWorkspaceId 必须是 UUID');
}
