import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.mjs';
import { discoverAiRuntimes, selectAiRuntime } from '../src/ai-runtime.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const requiredFiles = ['config.local.json', 'PERSONA.md', 'BIBLE.md', 'knowledge-catalog.json'];
for (const file of requiredFiles) {
  if (!existsSync(join(root, file))) throw new Error(`缺少 ${file}`);
}
for (const key of ['feishuAppId', 'ownerOpenId']) {
  if (!config[key] || /xxxx/.test(config[key])) throw new Error(`${key} 尚未填写`);
}
if (!Array.isArray(config.authorizedChatIds)) {
  throw new Error('authorizedChatIds 必须是数组');
}
if (config.allowAllChats !== true && !config.authorizedChatIds.length) {
  throw new Error('未启用 allowAllChats 时，authorizedChatIds 至少填写一个会话 ID');
}
for (const chatId of config.authorizedChatIds) {
  if (!/^oc_[A-Za-z0-9]+$/.test(chatId)) throw new Error(`authorizedChatIds 包含无效 chat_id：${chatId}`);
}
for (const [name, path] of [
  ['larkCli', config.larkCli],
  ['pythonBin', config.pythonBin],
  ['node', join(config.nodeBin, 'node')],
  ...(config.multicaEnabled ? [['multicaBin', config.multicaBin]] : []),
]) {
  if (!existsSync(path)) throw new Error(`${name} 不存在：${path}`);
}
const selectedRuntime = selectAiRuntime(
  discoverAiRuntimes({ configuredCodexBin: config.codexBin }),
  config.aiRuntime,
);
if (selectedRuntime.id === 'codex'
  && !existsSync(join(process.env.HOME || '', '.codex', 'auth.json'))) {
  throw new Error('Codex 登录凭据不存在，请先登录 Codex');
}
console.log(`CONFIG_OK runtime=${selectedRuntime.id}`);
