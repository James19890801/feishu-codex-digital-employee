import assert from 'node:assert/strict';

const cli = await import('./send-gewe-daily-briefing.mjs').catch(() => ({}));
assert.equal(
  typeof cli.runGeWeDailyBriefingCli,
  'function',
  'the automation needs a testable local WeChat briefing CLI',
);

if (typeof cli.runGeWeDailyBriefingCli === 'function') {
  const writes = [];
  const deliveries = [];
  const result = await cli.runGeWeDailyBriefingCli({
    argv: ['--date', '2026-08-14'],
    readStdin: async () => 'AI 前沿早报｜资讯日 2026-08-14\n普通发送正文',
    configuration: {
      geweEnabled: true,
      geweAppId: 'app-1',
      geweKeychainService: 'aipro-gewe',
      geweApiBaseUrl: 'https://api.geweapi.com',
      geweDailyBriefingGroupId: '53822548488@chatroom',
      geweDailyBriefingGroupName: 'AI流程与组织变革交流二群',
      workdir: '/tmp/aipro-test',
    },
    readCredential: async () => 'secret-token-value',
    createState: () => ({ close() {} }),
    createChannel: options => ({ options }),
    deliver: async input => {
      deliveries.push(input);
      return { replayed: false, result: { data: { newMsgId: 'message-1' } } };
    },
    writeOutput: value => writes.push(value),
  });
  assert.equal(result.ok, true);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].content.includes('普通发送正文'), true);
  assert.equal(writes.join('').includes('secret-token-value'), false);
  assert.match(writes.at(-1), /"ok":true/);

  await assert.rejects(cli.runGeWeDailyBriefingCli({
    argv: [],
    readStdin: async () => '正文',
    configuration: {},
  }), /--date/);
}

console.log('SEND_GEWE_DAILY_BRIEFING_TEST_OK');
