import assert from 'node:assert/strict';
import {
  buildHelpReply,
  buildStatusReply,
  matchOperatorCommand,
} from './operator-commands.mjs';

assert.equal(matchOperatorCommand('状态'), 'status');
assert.equal(matchOperatorCommand('运行状态！'), 'status');
assert.equal(matchOperatorCommand('帮助'), 'help');
assert.equal(matchOperatorCommand('使用说明。'), 'help');
assert.equal(matchOperatorCommand('帮我看看这个项目的状态'), null);
assert.equal(matchOperatorCommand(''), null);

{
  const text = buildHelpReply({ dashboardUrl: 'http://127.0.0.1:17655' });
  assert.match(text, /群聊 @ 我/);
  assert.match(text, /单聊直接发送/);
  assert.match(text, /“状态”/);
  assert.match(text, /A1/);
  assert.doesNotMatch(text, /Multica/);
  assert.match(text, /仅在这台 Mac/);
}

{
  const text = buildStatusReply({
    nowMs: Date.parse('2026-08-03T02:00:00.000Z'),
    feishuEnabled: false,
    dingtalkChannel: { enabled: true, connected: true },
    websocketConnected: true,
    aiRuntimeLabel: 'Codex CLI',
    a1Enabled: true,
    lastA1SyncAt: '2026-08-03T01:59:55.000Z',
    lastA1SyncError: null,
    a1Pending: 0,
    a1Dead: 0,
    inboxCounts: {},
    dashboardUrl: 'http://127.0.0.1:17655',
  });
  assert.match(text, /运行状态：正常/);
  assert.match(text, /飞书：本机禁用/);
  assert.match(text, /钉钉：已连接/);
  assert.match(text, /A1 同步：5 秒前/);
  assert.doesNotMatch(text, /主消息轮询/);
  assert.doesNotMatch(text, /Multica/);
}

{
  const text = buildStatusReply({
    nowMs: Date.parse('2026-07-30T01:00:00.000Z'),
    lastPollSuccessAt: '2026-07-30T00:59:55.000Z',
    lastPollError: null,
    websocketConnected: true,
    aiRuntimeLabel: 'Codex CLI',
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:59:55.000Z',
    lastMulticaSyncError: null,
    multicaPending: 2,
    multicaDead: 1,
    inboxCounts: {},
    dashboardUrl: 'http://127.0.0.1:17655',
  });
  assert.match(text, /运行状态：需要维护/);
  assert.match(text, /待补发 2/);
  assert.match(text, /死信 1/);
}

{
  const text = buildStatusReply({
    nowMs: Date.parse('2026-07-30T01:00:00.000Z'),
    lastPollSuccessAt: '2026-07-30T00:59:55.000Z',
    lastPollError: null,
    websocketConnected: true,
    aiRuntimeLabel: 'Codex CLI',
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:58:00.000Z',
    lastMulticaSyncError: null,
    maxMulticaSyncAgeMs: 180_000,
    inboxCounts: {},
    dashboardUrl: 'http://127.0.0.1:17655',
  });
  assert.match(text, /运行状态：正常/);
}

{
  const text = buildStatusReply({
    nowMs: Date.parse('2026-07-30T01:00:00.000Z'),
    startedAt: '2026-07-30T00:00:00.000Z',
    lastPollSuccessAt: '2026-07-30T00:59:55.000Z',
    lastPollError: null,
    websocketConnected: true,
    aiRuntimeLabel: 'Codex CLI',
    multicaEnabled: true,
    lastMulticaSyncAt: '2026-07-30T00:59:50.000Z',
    lastMulticaSyncError: null,
    inboxCounts: { pending: 1, completed: 20, failed: 0, dead: 0 },
    dashboardUrl: 'http://127.0.0.1:17655',
    detailed: true,
  });
  assert.match(text, /运行状态：正常/);
  assert.match(text, /主消息轮询：5 秒前/);
  assert.match(text, /辅助监听：已连接/);
  assert.match(text, /AI 运行时：Codex CLI/);
  assert.match(text, /Multica 同步：10 秒前/);
  assert.match(text, /待处理 1/);
  assert.match(text, /http:\/\/127\.0\.0\.1:17655/);
}

{
  const text = buildStatusReply({
    nowMs: Date.parse('2026-07-30T01:00:00.000Z'),
    startedAt: '2026-07-30T00:00:00.000Z',
    lastPollSuccessAt: '2026-07-30T00:50:00.000Z',
    lastPollError: { error: 'credential unavailable' },
    websocketConnected: false,
    inboxCounts: {},
    dashboardUrl: 'http://127.0.0.1:17655',
    detailed: false,
  });
  assert.match(text, /运行状态：需要维护/);
  assert.doesNotMatch(text, /credential unavailable/);
  assert.doesNotMatch(text, /127\.0\.0\.1/);
}

console.log('OPERATOR_COMMANDS_TEST_OK');
