import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  canonicalWeChatPersonId,
  parseRelationshipReflection,
  relationshipAudience,
  WeChatRelationshipMemory,
} from './wechat-relationship-memory.mjs';

assert.equal(canonicalWeChatPersonId('wxid_alice'), 'wechat:wxid_alice');
assert.equal(canonicalWeChatPersonId('wechat:wxid_alice'), 'wechat:wxid_alice');
assert.equal(canonicalWeChatPersonId('room@chatroom'), '');
assert.equal(relationshipAudience({
  surface: 'p2p', personId: 'wechat:wxid_alice', contextId: 'wechat:user:wxid_alice',
}), 'private:wechat:wxid_alice');
assert.equal(relationshipAudience({
  surface: 'group', personId: 'wechat:wxid_alice', contextId: 'wechat:group:room@chatroom',
}), 'group:room@chatroom');
assert.equal(relationshipAudience({ surface: 'moments' }), 'public_moments');

const dir = mkdtempSync(join(tmpdir(), 'aipro-relationship-memory-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  const memory = new WeChatRelationshipMemory({
    state,
    runAi: async () => JSON.stringify({ facts: [], profile: {} }),
    now: () => Date.parse('2026-08-16T04:00:00.000Z'),
  });

  assert.equal(memory.observeChat({
    senderId: 'wechat:wxid_alice', chatId: 'wechat:user:wxid_alice', chatType: 'p2p',
    messageId: 'wechat:message-private', text: '下周提醒我继续聊流程治理',
    direction: 'inbound', displayName: 'Alice', occurredAt: '2026-08-16T01:00:00.000Z',
  }), true);
  assert.equal(memory.observeChat({
    senderId: 'wechat:wxid_alice', chatId: 'wechat:user:wxid_alice', chatType: 'p2p',
    messageId: 'wechat:message-private', text: '下周提醒我继续聊流程治理',
    direction: 'inbound', displayName: 'Alice', occurredAt: '2026-08-16T01:00:00.000Z',
  }), false, 'duplicate webhook delivery must not duplicate an episode');
  memory.observeChat({
    senderId: 'wechat:wxid_numeric_time', chatId: 'wechat:user:wxid_numeric_time', chatType: 'p2p',
    messageId: 'wechat:message-numeric-time', text: '数字时间戳也要保留',
    occurredAt: String(Date.parse('2026-08-16T01:30:00.000Z')),
  });
  assert.equal(
    state.pendingRelationshipEpisodes('wechat:wxid_numeric_time')[0].occurredAt,
    '2026-08-16T01:30:00.000Z',
  );
  memory.observeChat({
    senderId: 'wechat:wxid_alice', chatId: 'wechat:group:room-a@chatroom', chatType: 'group',
    messageId: 'wechat:message-group-a', text: '我们在 A 群讨论流程责任',
    direction: 'inbound', occurredAt: '2026-08-16T02:00:00.000Z',
  });
  memory.observeChat({
    senderId: 'wechat:wxid_bob', chatId: 'wechat:group:room-a@chatroom', chatType: 'group',
    messageId: 'wechat:message-bob', text: '我是另一个同名朋友',
    direction: 'inbound', displayName: 'Alice', occurredAt: '2026-08-16T02:01:00.000Z',
  });
  memory.observeMoment({
    id: 'sns-1', userName: 'wxid_alice', nickName: 'Alice',
    content: '公开聊聊 AI 和流程协同', createTimeMs: Date.parse('2026-08-16T03:00:00.000Z'),
    comments: [{
      commentId: 7, userName: 'wxid_alice', nickName: 'Alice', content: '公开评论',
      createTimeMs: Date.parse('2026-08-16T03:01:00.000Z'),
    }],
  });

  const privateContext = memory.contextFor({
    personId: 'wechat:wxid_alice', surface: 'p2p',
    contextId: 'wechat:user:wxid_alice', query: '流程治理',
  });
  assert.match(privateContext, /下周提醒我继续聊流程治理/);
  assert.match(privateContext, /A 群讨论流程责任/, 'private recall may use shared group history');
  assert.doesNotMatch(privateContext, /另一个同名朋友/, 'same nickname cannot merge people');
  assert.doesNotMatch(memory.contextFor({
    personId: 'wechat:wxid_alice', surface: 'p2p', contextId: 'wechat:user:wxid_alice',
    query: '流程治理', excludeEventId: 'wechat:message-private',
  }), /下周提醒我继续聊流程治理/, 'the current inbound message must not be duplicated into memory context');

  const groupContext = memory.contextFor({
    personId: 'wechat:wxid_alice', surface: 'group',
    contextId: 'wechat:group:room-a@chatroom', query: '流程责任',
  });
  assert.match(groupContext, /A 群讨论流程责任/);
  assert.doesNotMatch(groupContext, /下周提醒我/, 'private memory cannot enter a group');

  const publicContext = memory.contextFor({
    wxid: 'wxid_alice', surface: 'moments', contextId: 'sns-1', query: 'AI 流程',
  });
  assert.match(publicContext, /公开聊聊 AI 和流程协同/);
  assert.doesNotMatch(publicContext, /下周提醒我/, 'private memory cannot enter Moments');
  assert.ok([...publicContext].length <= 1_200, 'relationship capsule must stay bounded');
  assert.equal(memory.contextFor({ wxid: 'wxid_unknown', surface: 'p2p', query: '你好' }), '');

  const pending = state.pendingRelationshipEpisodes('wechat:wxid_alice', 20);
  const validReflection = parseRelationshipReflection(JSON.stringify({
    facts: [{
      kind: 'professional_interest.current', content: '对方关注流程治理', confidence: 0.96,
      sourceEventIds: ['wechat:message-private'],
    }],
    profile: {
      familiarity: 'familiar', tone: '自然直接', topics: ['流程治理'],
      openLoops: ['下周继续聊流程治理'], summary: '双方持续讨论流程治理。', confidence: 0.9,
    },
  }), { episodes: pending });
  assert.equal(validReflection.facts.length, 1);
  assert.equal(validReflection.facts[0].audienceScope, 'private:wechat:wxid_alice');
  assert.throws(() => parseRelationshipReflection(JSON.stringify({
    facts: [{
      kind: 'profile.secret', content: '对方的密码是 123456', confidence: 0.99,
      sourceEventIds: ['wechat:message-private'],
    }],
    profile: {},
  }), { episodes: pending }), /sensitive/i);
  assert.throws(() => parseRelationshipReflection(JSON.stringify({
    facts: [{
      kind: 'profile.role', content: '对方是董事长', confidence: 0.99,
      sourceEventIds: ['missing-event'],
    }],
    profile: {},
  }), { episodes: pending }), /evidence/i);

  let reflectionCalls = 0;
  const consolidating = new WeChatRelationshipMemory({
    state,
    runAi: async () => {
      reflectionCalls += 1;
      return JSON.stringify({
        facts: [{
          kind: 'professional_interest.current', content: '对方关注 AI 原生流程',
          confidence: 0.98, sourceEventIds: ['wechat:message-private'],
        }],
        profile: {
          familiarity: 'familiar', tone: '自然直接', topics: ['AI 原生流程'],
          openLoops: [], summary: '持续讨论 AI 与流程。', confidence: 0.92,
        },
      });
    },
    now: () => Date.parse('2026-08-16T04:00:00.000Z'),
  });
  assert.equal(await consolidating.consolidatePerson('wechat:wxid_alice'), true);
  assert.equal(reflectionCalls, 1);
  assert.equal(state.pendingRelationshipEpisodes('wechat:wxid_alice').length, 0);
  assert.match(consolidating.contextFor({
    wxid: 'wxid_alice', surface: 'p2p', query: 'AI 流程',
  }), /关注 AI 原生流程/);
  assert.doesNotMatch(consolidating.contextFor({
    wxid: 'wxid_alice', surface: 'moments', query: 'AI 流程',
  }), /关注 AI 原生流程/, 'private fact cannot enter a public capsule');

  const audits = state.db.prepare(`SELECT detail FROM audit
    WHERE event LIKE 'wechat_relationship_%'`).all().map(row => row.detail).join('\n');
  assert.doesNotMatch(audits, /下周提醒我|关注 AI 原生流程/, 'audit must not contain memory text');

  const scheduled = [];
  const worker = new WeChatRelationshipMemory({
    state, runAi: async () => JSON.stringify({ facts: [], profile: {} }),
    setIntervalImpl: fn => { scheduled.push(fn); return { unref() {} }; },
    clearIntervalImpl: () => {},
  });
  assert.equal(worker.start(), true);
  assert.equal(worker.start(), false);
  assert.equal(scheduled.length, 1);
  assert.equal(worker.stop(), true);
  assert.equal(worker.stop(), false);

  console.log('WECHAT_RELATIONSHIP_MEMORY_TEST_OK');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
