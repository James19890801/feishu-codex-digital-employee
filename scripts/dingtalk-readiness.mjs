import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseDwsJson(output) {
  const text = String(output || '').trim();
  if (!text) return null;
  const candidates = [text, ...text.split(/\r?\n/u).reverse()];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // DWS may print a short status line before its JSON payload.
    }
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function runDws(dwsBin, args, env, runner) {
  const result = runner(dwsBin, args, {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
  return {
    ok: !result.error && result.status === 0,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    error: String(result.error?.message || result.stderr || '').trim(),
  };
}

export function inspectDingTalkReadiness({
  dwsBin = '',
  profile = '',
  channelCode = '',
  eventStreamReady = false,
  controlledSelfChatVerified = false,
  env = {},
  runner = spawnSync,
} = {}) {
  const executable = String(dwsBin || '').trim();
  const channel = String(channelCode || '').trim();
  const versionResult = executable
    ? runDws(executable, ['--version'], env, runner)
    : { ok: false, stdout: '', stderr: '', error: 'DWS executable is not configured' };
  const installed = versionResult.ok;
  const version = installed
    ? String(versionResult.stdout || versionResult.stderr).trim().split(/\r?\n/u)[0]
    : '';
  const requestedProfile = String(profile || '').trim();
  const profileArgs = requestedProfile ? ['--profile', requestedProfile] : [];
  const authResult = installed
    ? runDws(executable, [...profileArgs, 'auth', 'status', '--format', 'json'], env, runner)
    : { ok: false, stdout: '', stderr: '', error: versionResult.error };
  const auth = parseDwsJson(authResult.stdout);
  const authenticated = authResult.ok
    && auth?.success !== false
    && auth?.authenticated === true
    && auth?.token_valid !== false;
  const profilesResult = installed
    ? runDws(executable, ['profile', 'list', '--format', 'json'], env, runner)
    : { ok: false, stdout: '', stderr: '', error: versionResult.error };
  const profiles = parseDwsJson(profilesResult.stdout);
  const selectedProfile = requestedProfile
    || String(profiles?.currentProfile || '').trim()
    || String(Array.isArray(profiles?.profiles) ? profiles.profiles[0]?.profile || '' : '').trim()
    || (auth?.corp_id && auth?.user_id ? `${auth.corp_id}:${auth.user_id}` : '');
  const profileConfigured = Boolean(selectedProfile);
  const channelCodeConfigured = Boolean(channel);
  const connectorReady = installed && authenticated && profileConfigured;

  return {
    installed,
    version,
    authenticated,
    profileConfigured,
    profile: selectedProfile,
    channelCodeConfigured,
    channelCode: channel,
    channelCodeRequired: false,
    connectorReady,
    eventStreamReady: Boolean(eventStreamReady),
    controlledSelfChatVerified: Boolean(controlledSelfChatVerified),
    error: installed
      ? (authenticated ? '' : authResult.error || String(auth?.message || '尚未登录钉钉'))
      : versionResult.error || '未找到 DWS CLI',
  };
}

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? String(process.argv[index + 1] || '') : '';
}

function cli() {
  const configPath = resolve(option('--config') || 'config.local.json');
  let config = {};
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    console.error(`DINGTALK_CONFIG_ERROR=${String(error?.message || error)}`);
    process.exitCode = 1;
    return;
  }
  const result = inspectDingTalkReadiness({
    dwsBin: config.enterpriseChatBin,
    profile: config.enterpriseChatProfile,
    channelCode: config.enterpriseChatChannel,
    env: config.enterpriseChatChannel ? { DWS_CHANNEL: config.enterpriseChatChannel } : {},
  });
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`DINGTALK_DWS_INSTALLED=${result.installed}`);
    console.log(`DINGTALK_AUTHENTICATED=${result.authenticated}`);
    console.log(`DINGTALK_PROFILE_CONFIGURED=${result.profileConfigured}`);
    console.log(`DINGTALK_CHANNEL_CODE_CONFIGURED=${result.channelCodeConfigured}`);
    console.log(`DINGTALK_CONNECTOR_READY=${result.connectorReady}`);
    console.log(`DINGTALK_EVENT_STREAM_READY=${result.eventStreamReady}`);
  }
  if (!result.connectorReady) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli();
