import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';

const moduleUnderTest = await import('./gewe-daily-briefing.mjs').catch(() => ({}));
assert.equal(
  typeof moduleUnderTest.deliverGeWeDailyBriefing,
  'function',
  'a tested personal WeChat daily briefing delivery function is required',
);

if (typeof moduleUnderTest.deliverGeWeDailyBriefing === 'function') {
  const directory = mkdtempSync(join(tmpdir(), 'aipro-gewe-briefing-'));
  try {
    const state = new AgentState(join(directory, 'state.sqlite'));
    const sends = [];
    let groupInfoCalls = 0;
    const channel = {
      getChatroomInfo: async chatroomId => {
        groupInfoCalls += 1;
        return {
          chatroomId,
          nickName: 'AI流程与组织变革交流二群',
        };
      },
      send: async (target, content, options) => {
        sends.push({ target, content, options });
        return { data: { newMsgId: 'message-1' } };
      },
    };
    const input = {
      state,
      channel,
      briefingDate: '2026-08-14',
      groupId: '53822548488@chatroom',
      groupName: 'AI流程与组织变革交流二群',
      content: 'AI 前沿早报｜资讯日 2026-08-14\n\n海外 3 条\n第一条重要资讯。\n\n大家怎么看？欢迎直接说判断。',
    };
    const first = await moduleUnderTest.deliverGeWeDailyBriefing(input);
    assert.equal(first.replayed, false);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[0].target, {
      channel: 'wechat',
      kind: 'group',
      id: '53822548488@chatroom',
    });
    assert.equal(sends[0].options, undefined, 'ordinary WeChat delivery must not carry ats');
    assert.equal(/@所有人|<@all>/u.test(sends[0].content), false);

    const replay = await moduleUnderTest.deliverGeWeDailyBriefing(input);
    assert.equal(replay.replayed, true);
    assert.equal(sends.length, 1, 'same briefing date must not send twice');
    assert.equal(groupInfoCalls, 1, 'same-day replay must not depend on another network check');

    await assert.rejects(moduleUnderTest.deliverGeWeDailyBriefing({
      ...input,
      briefingDate: '2026-08-13',
      channel: {
        ...channel,
        getChatroomInfo: async chatroomId => ({ chatroomId, nickName: '另一个群' }),
      },
    }), /群名|name mismatch/iu);
    assert.equal(sends.length, 1);

    await assert.rejects(moduleUnderTest.deliverGeWeDailyBriefing({
      ...input,
      briefingDate: '2026-08-12',
      content: 'AI 前沿早报｜资讯日 2026-08-12\n<@all> 大家怎么看？欢迎直接说判断。',
    }), /@所有人|ordinary|普通/iu);
    state.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

console.log('GEWE_DAILY_BRIEFING_TEST_OK');
