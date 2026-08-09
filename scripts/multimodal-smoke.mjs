import { createHash } from 'node:crypto';
import { relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildDingTalkArtifactSendArgs,
  buildFeishuArtifactSendArgs,
} from '../src/artifact-channel-delivery.mjs';
import { parseChannelChatId } from '../src/im-channels.mjs';
import { runBufferedProcess } from '../src/process-runner.mjs';

function insideWorkspace(path, workspaceRoot) {
  const fromRoot = relative(resolve(workspaceRoot), resolve(path));
  return fromRoot !== '..' && !fromRoot.startsWith(`..${sep}`);
}

function smokeId(channel, path) {
  return `aipro-mm-smoke-${createHash('sha256').update(`${channel}:${path}`).digest('hex').slice(0, 16)}`;
}

export function buildMultimodalSmokePlan({
  workspaceRoot,
  channels = [],
  feishuChatId = '',
  dingtalkChatId = '',
  files = [],
} = {}) {
  const providers = [...new Set(channels.map(value => String(value).trim().toLowerCase()))];
  if (providers.includes('feishu') && !/^oc_[A-Za-z0-9_=-]+$/.test(feishuChatId)) {
    throw new Error('A configured Feishu test chat is required');
  }
  const dingTarget = parseChannelChatId(dingtalkChatId);
  if (providers.includes('dingtalk')
    && (dingTarget?.channel !== 'dingtalk' || dingTarget.kind !== 'group')) {
    throw new Error('A configured DingTalk test group is required');
  }
  const normalizedFiles = files.map(path => resolve(String(path || '')));
  if (normalizedFiles.some(path => !insideWorkspace(path, workspaceRoot))) {
    throw new Error('Smoke artifacts must stay inside the AIPRO workspace');
  }
  const plans = [];
  for (const channel of providers) {
    for (const path of normalizedFiles) {
      const relativePath = relative(resolve(workspaceRoot), path);
      const idempotencyKey = smokeId(channel, relativePath);
      if (channel === 'feishu') {
        plans.push({
          channel,
          target: feishuChatId,
          path,
          args: buildFeishuArtifactSendArgs({
            chatId: feishuChatId,
            relativePath,
            uuid: idempotencyKey,
          }),
        });
      } else if (channel === 'dingtalk') {
        plans.push({
          channel,
          target: dingtalkChatId,
          path,
          args: buildDingTalkArtifactSendArgs({
            target: dingTarget,
            path,
            uuid: idempotencyKey,
          }),
        });
      }
    }
  }
  return plans;
}

export function redactSmokePlan(plans) {
  return plans.map(plan => ({
    channel: plan.channel,
    target: '<configured-test-target>',
    file: relative(process.cwd(), plan.path),
    kind: plan.args.includes('--image') ? 'image'
      : plan.args.includes('--video') ? 'video'
        : plan.args.includes('--audio') ? 'audio' : 'file',
  }));
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

async function main() {
  const { config } = await import('../src/config.mjs');
  const channels = (option('--channels') || 'feishu,dingtalk').split(',').filter(Boolean);
  const files = option('--files').split(',').filter(Boolean);
  const plan = buildMultimodalSmokePlan({
    workspaceRoot: config.workdir,
    channels,
    feishuChatId: option('--feishu-chat') || process.env.AIPRO_FEISHU_TEST_CHAT_ID || '',
    dingtalkChatId: option('--dingtalk-chat')
      || process.env.AIPRO_DINGTALK_TEST_CHAT_ID
      || config.groupHostChatIds?.[0]
      || '',
    files,
  });
  if (!process.argv.includes('--yes')) {
    console.log(JSON.stringify({ dryRun: true, plan: redactSmokePlan(plan) }, null, 2));
    return;
  }
  const results = [];
  for (const item of plan) {
    const command = item.channel === 'feishu' ? config.larkCli : config.dingtalkBin;
    const args = item.channel === 'dingtalk' && config.dingtalkProfile
      ? ['--profile', config.dingtalkProfile, ...item.args]
      : item.args;
    await runBufferedProcess(command, args, {
      cwd: config.workdir,
      timeoutMs: config.larkCliTimeoutMs,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: 1024 * 1024,
    });
    results.push({ channel: item.channel, target: '<configured-test-target>', ok: true });
  }
  console.log(JSON.stringify({ dryRun: false, results }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
