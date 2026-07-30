import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedInteger } from './reliability.mjs';

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

export const config = {
  feishuAppId: raw.feishuAppId || '',
  ownerOpenId: raw.ownerOpenId || '',
  keychainService: raw.keychainService || 'codex-feishu-digital-employee',
  authorizedChatIds: raw.authorizedChatIds || [],
  allowAllChats: raw.allowAllChats === true,
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
  dingtalkProfile: raw.dingtalkProfile || '',
  dingtalkBin: raw.dingtalkBin || join(home, '.npm-global', 'bin', 'dws'),
  wecomEnabled: raw.wecomEnabled === true,
  wecomBotId: raw.wecomBotId || '',
  wecomKeychainService: raw.wecomKeychainService || 'aipro-wecom-bot',
  wecomWebsocketUrl: raw.wecomWebsocketUrl || 'wss://openws.work.weixin.qq.com',
  multicaEnabled: raw.multicaEnabled === true,
  multicaProfile: raw.multicaProfile || 'desktop-api.multica.ai',
  multicaDefaultWorkspaceId: raw.multicaDefaultWorkspaceId || '',
  multicaSyncIntervalMs: boundedInteger(raw.multicaSyncIntervalMs, {
    name: 'multicaSyncIntervalMs', fallback: 10000, min: 5000, max: 300000,
  }),
  multicaMaxIssues: boundedInteger(raw.multicaMaxIssues, {
    name: 'multicaMaxIssues', fallback: 5000, min: 100, max: 20000,
  }),
  dashboardPort: boundedInteger(raw.dashboardPort, {
    name: 'dashboardPort', fallback: 17655, min: 1024, max: 65535,
  }),
  workdir,
  artifactDir: raw.artifactDir || join(home, 'Desktop', '数字员工交付物'),
  codexBin: raw.codexBin || '/Applications/ChatGPT.app/Contents/Resources/codex',
  codexModel: raw.codexModel || 'gpt-5.6-terra',
  codexProxyUrl: raw.codexProxyUrl || '',
  larkCli: raw.larkCli || join(home, '.local', 'bin', 'lark-cli'),
  nodeBin: raw.nodeBin || join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'node', 'bin'),
  pythonBin: raw.pythonBin || join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
  multicaBin: raw.multicaBin
    || '/Applications/Multica.app/Contents/Resources/app.asar.unpacked/resources/bin/multica',
};

for (const key of ['feishuAppId', 'ownerOpenId']) {
  if (!config[key]) throw new Error(`config.local.json 缺少 ${key}`);
}
if (!/^cli_[0-9a-fA-F]{16}$/.test(config.feishuAppId)) {
  throw new Error('feishuAppId 格式无效');
}
if (!/^ou_[A-Za-z0-9]+$/.test(config.ownerOpenId)) {
  throw new Error('ownerOpenId 格式无效');
}
if (config.codexProxyUrl) {
  const proxy = new URL(config.codexProxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) {
    throw new Error('codexProxyUrl 只能使用 http 或 https');
  }
}
if (!['lark-cli', 'sdk'].includes(config.eventTransport)) {
  throw new Error('eventTransport 只能是 lark-cli 或 sdk');
}
if (!['auto', 'codex', 'qoder', 'codebuddy', 'trae'].includes(config.aiRuntime)) {
  throw new Error('aiRuntime 只能是 auto、codex、qoder、codebuddy 或 trae');
}
if (config.wecomEnabled && !config.wecomBotId) {
  throw new Error('启用 wecomEnabled 时必须填写 wecomBotId');
}
if (!/^wss:\/\/[^/\s]+(?:\/.*)?$/i.test(config.wecomWebsocketUrl)) {
  throw new Error('wecomWebsocketUrl 必须是 wss 地址');
}
if (config.multicaDefaultWorkspaceId
  && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    .test(config.multicaDefaultWorkspaceId)) {
  throw new Error('multicaDefaultWorkspaceId 必须是 UUID');
}
if (!config.allowAllChats && !config.authorizedChatIds.length) {
  throw new Error('未启用 allowAllChats 时，config.local.json 至少需要一个 authorizedChatIds');
}
