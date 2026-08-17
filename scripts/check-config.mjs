import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const localConfigPath = join(root, 'config.local.json');
const explicitConfig = String(process.env.DIGITAL_EMPLOYEE_CONFIG || '').trim();
const distributionConfigPath = join(root, 'config.distribution.json');
const templateMode = (!explicitConfig && !existsSync(localConfigPath))
  || (explicitConfig && resolve(explicitConfig) === distributionConfigPath);
if (templateMode) process.env.DIGITAL_EMPLOYEE_CONFIG = distributionConfigPath;
const { config } = await import('../src/config.mjs');

if (templateMode) {
  for (const file of [
    'config.distribution.json',
    'templates/PERSONA.example.md',
    'templates/BIBLE.example.md',
    'templates/knowledge-catalog.example.json',
  ]) {
    if (!existsSync(join(root, file))) throw new Error(`缺少 ${file}`);
  }
  console.log('CONFIG_TEMPLATE_OK');
} else {
  for (const file of ['PERSONA.md', 'BIBLE.md', 'knowledge-catalog.json']) {
    if (!existsSync(join(root, file))) throw new Error(`缺少 ${file}`);
  }
  if (config.feishuEnabled) {
    for (const key of ['feishuAppId', 'ownerOpenId']) {
      if (!config[key] || /xxxx/.test(config[key])) throw new Error(`${key} 尚未填写`);
    }
  }
  if (!Array.isArray(config.authorizedChatIds)) {
    throw new Error('authorizedChatIds 必须是数组');
  }
  if (config.allowAllChats !== true && !config.authorizedChatIds.length) {
    throw new Error('未启用 allowAllChats 时，authorizedChatIds 至少填写一个会话 ID');
  }
  for (const chatId of config.authorizedChatIds) {
    if (config.feishuEnabled && !/^oc_[A-Za-z0-9]+$/.test(chatId)) {
      throw new Error(`authorizedChatIds 包含无效 chat_id：${chatId}`);
    }
  }
  for (const [name, path] of [
    ...(config.feishuEnabled ? [['larkCli', config.larkCli]] : []),
    ...(config.pythonBin ? [['pythonBin', config.pythonBin]] : []),
    ['node', join(config.nodeBin, 'node')],
    ...(config.enterpriseChatEnabled ? [['enterpriseChatBin', config.enterpriseChatBin]] : []),
    ...(config.multicaEnabled ? [['multicaBin', config.multicaBin]] : []),
  ]) {
    if (!existsSync(path)) throw new Error(`${name} 不存在：${path}`);
  }
  const { discoverAiRuntimes, selectAiRuntime } = await import('../src/ai-runtime.mjs');
  const selectedRuntime = selectAiRuntime(
    discoverAiRuntimes({ configuredCodexBin: config.codexBin }),
    config.aiRuntime,
  );
  if (selectedRuntime.id === 'codex'
    && !existsSync(join(process.env.HOME || '', '.codex', 'auth.json'))) {
    throw new Error('Codex 登录凭据不存在，请先登录 Codex');
  }
  console.log(`CONFIG_OK runtime=${selectedRuntime.id}`);
}
