import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REQUIRED_CONFIGURATION_FILES = Object.freeze([
  'config.local.json',
  'PERSONA.md',
  'BIBLE.md',
  'knowledge-catalog.json',
]);

export function assertRequiredConfigurationFiles(root) {
  for (const file of REQUIRED_CONFIGURATION_FILES) {
    if (!existsSync(join(root, file))) throw new Error(`缺少 ${file}`);
  }
}

export async function checkConfiguration() {
  const [{ config }, { discoverAiRuntimes, selectAiRuntime }] = await Promise.all([
    import('../src/config.mjs'),
    import('../src/ai-runtime.mjs'),
  ]);
  assertRequiredConfigurationFiles(config.configRoot);
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
  for (const [name, pathname] of [
    ...(config.feishuEnabled ? [['larkCli', config.larkCli]] : []),
    ['pythonBin', config.pythonBin],
    ['node', join(config.nodeBin, 'node')],
    ...(config.dingtalkEnabled ? [['dingtalkBin', config.dingtalkBin]] : []),
    ...(config.multicaEnabled ? [['multicaBin', config.multicaBin]] : []),
  ]) {
    if (!existsSync(pathname)) throw new Error(`${name} 不存在：${pathname}`);
  }
  const selectedRuntime = selectAiRuntime(
    discoverAiRuntimes({ configuredCodexBin: config.codexBin }),
    config.aiRuntime,
  );
  if (selectedRuntime.id === 'codex'
    && !existsSync(join(process.env.HOME || '', '.codex', 'auth.json'))) {
    throw new Error('Codex 登录凭据不存在，请先登录 Codex');
  }
  return { runtime: selectedRuntime.id };
}

async function main() {
  const result = await checkConfiguration();
  console.log(`CONFIG_OK runtime=${result.runtime}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
