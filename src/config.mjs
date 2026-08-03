import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedInteger } from './reliability.mjs';
import {
  validateDingTalkConfiguration,
  validateFeishuConfiguration,
} from './runtime-mode.mjs';
import { normalizeOperatorProfile } from './operator-profile.mjs';
import { normalizeCommunicationBlocklist } from './communication-blocklist.mjs';

const srcDir = dirname(fileURLToPath(import.meta.url));
const workdir = resolve(srcDir, '..');
const configPath = process.env.DIGITAL_EMPLOYEE_CONFIG || join(workdir, 'config.local.json');
if (!existsSync(configPath)) {
  throw new Error(`缺少配置文件：${configPath}\n请复制 config.example.json 为 config.local.json 并填写。`);
}
const raw = JSON.parse(readFileSync(configPath, 'utf8'));
const home = process.env.HOME || '';
const operatorProfile = normalizeOperatorProfile({
  displayName: raw.ownerDisplayName,
  role: raw.ownerRole,
  aliases: raw.ownerAliases,
  brandName: raw.digitalHumanBrand,
});
if (!Array.isArray(raw.authorizedChatIds || [])) {
  throw new Error('config.local.json 的 authorizedChatIds 必须是数组');
}

export const config = {
  ownerDisplayName: operatorProfile.displayName,
  ownerRole: operatorProfile.role,
  ownerAliases: operatorProfile.aliases,
  digitalHumanBrand: operatorProfile.brandName,
  automaticCommunicationBlocklist: normalizeCommunicationBlocklist(
    raw.automaticCommunicationBlocklist,
  ),
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
    name: 'pollIntervalMs', fallback: 5000, min: 1000, max: 60000,
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
  aiRuntime: raw.aiRuntime || 'auto',
  dingtalkEnabled: raw.dingtalkEnabled === true,
  dingtalkTransport: String(raw.dingtalkTransport || 'event-stream').trim(),
  dingtalkProfile: raw.dingtalkProfile || '',
  dingtalkChannel: String(raw.dingtalkChannel || '').trim(),
  dingtalkOwnerOpenId: String(raw.dingtalkOwnerOpenId || '').trim(),
  dingtalkBin: raw.dingtalkBin || join(home, '.npm-global', 'bin', 'dws'),
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
  geweMentionNames: Array.isArray(raw.geweMentionNames)
    ? raw.geweMentionNames.map(value => String(value).trim()).filter(Boolean).slice(0, 10)
    : [],
  a1Enabled: raw.a1Enabled === true,
  a1Bin: raw.a1Bin || join(home, '.qoderwork', 'bin', 'a1'),
  a1WebAgentProjectId: String(raw.a1WebAgentProjectId || '2165415').trim(),
  a1AiCollaborationProjectId: String(raw.a1AiCollaborationProjectId || '2168196').trim(),
  a1WebAgentRepo: String(raw.a1WebAgentRepo || 'enterprise-development/ai-lab-agent').trim(),
  a1AiCollaborationRepo: String(raw.a1AiCollaborationRepo
    || 'enterprise-development/ai-native-flow-platform').trim(),
  a1AiCollaborationBranch: String(raw.a1AiCollaborationBranch
    || 'feature/20260606_29656382_init_project_1').trim(),
  a1SyncIntervalMs: boundedInteger(raw.a1SyncIntervalMs, {
    name: 'a1SyncIntervalMs', fallback: 300000, min: 5000, max: 300000,
  }),
  a1MaxWorkitems: boundedInteger(raw.a1MaxWorkitems, {
    name: 'a1MaxWorkitems', fallback: 500, min: 50, max: 5000,
  }),
  multicaEnabled: raw.multicaEnabled === true,
  multicaProfile: raw.multicaProfile || 'desktop-api.multica.ai',
  multicaAppUrl: raw.multicaAppUrl || 'https://multica.ai',
  multicaDefaultWorkspaceId: raw.multicaDefaultWorkspaceId || '',
  multicaOwnerSquad: String(raw.multicaOwnerSquad || '').trim(),
  multicaSyncIntervalMs: boundedInteger(raw.multicaSyncIntervalMs, {
    name: 'multicaSyncIntervalMs', fallback: 10000, min: 5000, max: 300000,
  }),
  multicaMaxIssues: boundedInteger(raw.multicaMaxIssues, {
    name: 'multicaMaxIssues', fallback: 5000, min: 100, max: 20000,
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
validateDingTalkConfiguration(config);
if (config.wecomEnabled && !config.wecomBotId) {
  throw new Error('启用 wecomEnabled 时必须填写 wecomBotId');
}
if (!/^wss:\/\/[^/\s]+(?:\/.*)?$/i.test(config.wecomWebsocketUrl)) {
  throw new Error('wecomWebsocketUrl 必须是 wss 地址');
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
if (config.a1Enabled) {
  for (const [name, value] of [
    ['a1WebAgentProjectId', config.a1WebAgentProjectId],
    ['a1AiCollaborationProjectId', config.a1AiCollaborationProjectId],
  ]) {
    if (!/^\d{5,20}$/.test(value)) throw new Error(`${name} 必须是数字项目 ID`);
  }
  for (const [name, value] of [
    ['a1WebAgentRepo', config.a1WebAgentRepo],
    ['a1AiCollaborationRepo', config.a1AiCollaborationRepo],
  ]) {
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value)) throw new Error(`${name} 必须是 group/repo 路径`);
  }
}
