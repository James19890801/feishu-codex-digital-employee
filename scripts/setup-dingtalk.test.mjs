import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDingTalk } from './setup-dingtalk.mjs';

const root = await mkdtemp(join(tmpdir(), 'james-setup-dingtalk-'));
const configPath = join(root, 'config.local.json');
await writeFile(configPath, `${JSON.stringify({
  enterpriseChatEnabled: false,
  enterpriseChatTransport: 'event-stream',
  enterpriseChatProfile: '',
  enterpriseChatChannel: '',
  enterpriseChatBin: '/fake/dws',
}, null, 2)}\n`, 'utf8');

let loggedIn = false;
const calls = [];
const runner = (command, args, options) => {
  calls.push({ command, args, channel: options.env.DWS_CHANNEL || '' });
  if (args.includes('--version')) return { status: 0, stdout: 'dws v1.0.58\n', stderr: '' };
  if (args.includes('login')) {
    loggedIn = true;
    return { status: 0, stdout: '{"success":true}\n', stderr: '' };
  }
  if (args.includes('status')) {
    return {
      status: 0,
      stdout: JSON.stringify(loggedIn
        ? { success: true, authenticated: true, corp_id: 'corp-1', user_id: 'user-1' }
        : { success: true, authenticated: false }),
      stderr: '',
    };
  }
  if (args.includes('list')) {
    return {
      status: 0,
      stdout: loggedIn
        ? '{"success":true,"currentProfile":"corp-1:user-1","profiles":[{"profile":"corp-1:user-1"}]}'
        : '{"success":true,"profiles":[]}',
      stderr: '',
    };
  }
  return { status: 2, stdout: '', stderr: 'unexpected command' };
};

const result = await configureDingTalk({
  root,
  channelCode: 'approved-channel',
  runner,
  restart: false,
});
assert.equal(result.connectorReady, true);
assert.equal(result.profile, 'corp-1:user-1');
assert.equal(calls.some(call => call.args.includes('login')), true);
assert.equal(calls.every(call => call.channel === 'approved-channel'), true);

const config = JSON.parse(await readFile(configPath, 'utf8'));
assert.equal(config.enterpriseChatEnabled, true);
assert.equal(config.enterpriseChatTransport, 'event-stream');
assert.equal(config.enterpriseChatProfile, 'corp-1:user-1');
assert.equal(config.enterpriseChatChannel, 'approved-channel');
assert.equal(config.feishuEnabled, undefined, 'DingTalk setup must not enable unrelated channels');

console.log('SETUP_DINGTALK_TEST_OK');
