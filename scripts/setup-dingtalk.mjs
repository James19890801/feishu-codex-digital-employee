import { spawnSync } from 'node:child_process';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectDingTalkReadiness } from './dingtalk-readiness.mjs';

function run(command, args, { env = {}, runner = spawnSync, inherit = false } = {}) {
  const result = runner(command, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    ...(inherit ? { stdio: 'inherit' } : {}),
  });
  if (result.error || result.status !== 0) {
    const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
    throw new Error(detail || `${command} exited with status ${result.status}`);
  }
  return result;
}

function restartMainService({ platform, runner, env }) {
  if (platform === 'darwin') {
    run('/bin/launchctl', [
      'kickstart', '-k', `gui/${process.getuid()}/com.local.feishu-codex-digital-employee`,
    ], { runner, env });
    return;
  }
  if (platform === 'linux') {
    run('systemctl', ['--user', 'restart', 'james-digital-human.service'], { runner, env });
    return;
  }
  if (platform === 'win32') {
    run('schtasks.exe', ['/Run', '/TN', 'James Digital Human'], { runner, env });
  }
}

export async function configureDingTalk({
  root = '.',
  profile = '',
  channelCode,
  runner = spawnSync,
  restart = true,
  platform = process.platform,
} = {}) {
  const installRoot = resolve(root);
  const configPath = join(installRoot, 'config.local.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  const dwsBin = String(config.enterpriseChatBin || '').trim();
  if (!dwsBin) throw new Error('未找到 DWS CLI。请先重新运行一键安装。');
  const selectedChannel = channelCode === undefined
    ? String(config.enterpriseChatChannel || '').trim()
    : String(channelCode || '').trim();
  const dwsEnv = selectedChannel ? { DWS_CHANNEL: selectedChannel } : {};
  let selectedProfile = String(profile || config.enterpriseChatProfile || '').trim();
  let readiness = inspectDingTalkReadiness({
    dwsBin,
    profile: selectedProfile,
    channelCode: selectedChannel,
    env: dwsEnv,
    runner,
  });

  if (!readiness.installed) {
    throw new Error(`DWS CLI 不可用：${readiness.error || dwsBin}`);
  }
  if (!readiness.authenticated) {
    const loginArgs = [
      ...(selectedProfile ? ['--profile', selectedProfile] : []),
      'auth', 'login', '--yes', '--format', 'json',
    ];
    try {
      run(dwsBin, loginArgs, { env: dwsEnv, runner, inherit: true });
    } catch (error) {
      if (/CHANNEL_REQUIRED|channel_not_allowed|enterprise_not_authorized|channel/iu.test(String(error?.message || ''))) {
        throw new Error(
          '当前组织要求已授权的 DWS 渠道码。请向组织管理员索取，不要随机填写其他产品的渠道码。',
        );
      }
      throw error;
    }
    readiness = inspectDingTalkReadiness({
      dwsBin,
      profile: selectedProfile,
      channelCode: selectedChannel,
      env: dwsEnv,
      runner,
    });
  }
  if (!readiness.authenticated || !readiness.profileConfigured) {
    throw new Error('钉钉授权未完成，未写入服务配置。');
  }
  selectedProfile = readiness.profile;
  config.enterpriseChatEnabled = true;
  config.enterpriseChatTransport = 'event-stream';
  config.enterpriseChatProfile = selectedProfile;
  config.enterpriseChatChannel = selectedChannel;
  const temporary = join(dirname(configPath), `.config.local.json.${process.pid}.tmp`);
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, configPath);
  if (restart) restartMainService({ platform, runner, env: dwsEnv });

  return {
    ...readiness,
    profile: selectedProfile,
    channelCode: selectedChannel,
    connectorReady: true,
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : undefined;
}

async function cli() {
  const root = resolve(option('--root') || fileURLToPath(new URL('..', import.meta.url)));
  try {
    const result = await configureDingTalk({
      root,
      profile: option('--profile') || '',
      channelCode: option('--channel-code'),
      restart: !process.argv.includes('--no-restart'),
    });
    console.log('DINGTALK_SETUP_OK');
    console.log(`DINGTALK_PROFILE=${result.profile}`);
    console.log(`DINGTALK_CHANNEL_CODE_CONFIGURED=${result.channelCodeConfigured}`);
    console.log('NEXT_STEP=请让另一个受控钉钉账号给你发私聊，或在受控测试群 @ 你；DWS 会过滤你自己发的消息。');
  } catch (error) {
    console.error(`DINGTALK_SETUP_ERROR=${String(error?.message || error)}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await cli();
