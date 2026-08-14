import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentState } from './state.mjs';
import {
  MulticaArtifactDelivery,
  appendDeliveryRequirement,
  looksLikeArtifactProgressRequest,
  looksLikeArtifactExecutionRequest,
} from './multica-artifact-delivery.mjs';

assert.equal(looksLikeArtifactProgressRequest('PDF 做出来了不'), true);
assert.equal(looksLikeArtifactProgressRequest('到底生成了还是没有交付给我'), true);
assert.equal(looksLikeArtifactProgressRequest('你好'), false);
assert.equal(looksLikeArtifactExecutionRequest('做成PDF 最后的报告'), true);
assert.equal(looksLikeArtifactExecutionRequest('我只需要你做就好，给我PDF'), true);
assert.equal(looksLikeArtifactExecutionRequest('PDF 做出来了不'), false);

const enriched = appendDeliveryRequirement('报名提升策略', {
  formats: ['pdf'],
  request: '最终只交付 PDF 给我',
});
assert.match(enriched, /交付契约/);
assert.match(enriched, /PDF/);
assert.match(enriched, /multica attachment upload/);
assert.equal(appendDeliveryRequirement(enriched, {
  formats: ['pdf'], request: '最终只交付 PDF 给我',
}), enriched, 'delivery requirement must be idempotent');
const replacedContract = appendDeliveryRequirement(enriched, {
  formats: ['pdf', 'xlsx'], request: '改为交付 PDF 和 Excel',
});
assert.match(replacedContract, /PDF、Excel/);
assert.match(replacedContract, /改为交付 PDF 和 Excel/);
assert.equal((replacedContract.match(/AIPRO_DELIVERY_CONTRACT_START/g) || []).length, 1);

const dir = mkdtempSync(join(tmpdir(), 'aipro-artifact-delivery-'));
try {
  const state = new AgentState(join(dir, 'state.sqlite'));
  state.upsertMulticaDeliveryContract({
    issueId: 'issue-8',
    workspaceId: 'ws-1',
    channel: 'wechat',
    chatId: 'wechat:group:room-1@chatroom',
    senderId: 'wechat:wxid_group_member',
    chatType: 'group',
    formats: ['pdf'],
    request: '最终交付 PDF',
  });
  const delivered = [];
  const client = {
    listIssueComments: async () => [{
      id: 'comment-final',
      attachments: [{
        id: 'attachment-pdf',
        name: '北京公开课报名提升策略.pdf',
        content_type: 'application/pdf',
        size: 2048,
      }],
    }],
    downloadAttachment: async (attachmentId, { outputDir }) => {
      assert.equal(attachmentId, 'attachment-pdf');
      await mkdir(outputDir, { recursive: true });
      const path = join(outputDir, '北京公开课报名提升策略.pdf');
      await writeFile(path, Buffer.from('%PDF-1.7\nAIPRO test artifact\n'));
      return { path, name: '北京公开课报名提升策略.pdf' };
    },
  };
  const pipeline = new MulticaArtifactDelivery({
    client,
    state,
    artifactRoot: join(dir, 'artifacts'),
    deliver: async payload => delivered.push(payload),
  });
  const first = await pipeline.syncIssue({
    id: 'issue-8', identifier: 'MYS-8', workspace_id: 'ws-1', status: 'done',
  });
  assert.equal(first.delivered, 1);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].channel, 'wechat');
  assert.equal(delivered[0].chatId, 'wechat:group:room-1@chatroom');
  assert.equal(delivered[0].senderId, 'wechat:wxid_group_member');
  assert.equal(delivered[0].chatType, 'group');
  assert.equal(delivered[0].format, 'pdf');
  assert.match(delivered[0].path, /\.pdf$/);
  assert.equal(state.multicaDeliveryContract('issue-8').status, 'delivered');

  const replay = await pipeline.syncIssue({
    id: 'issue-8', identifier: 'MYS-8', workspace_id: 'ws-1', status: 'done',
  });
  assert.equal(replay.delivered, 0);
  assert.equal(delivered.length, 1, 'delivery must be idempotent');

  state.upsertMulticaDeliveryContract({
    issueId: 'issue-9',
    workspaceId: 'ws-1',
    channel: 'dingtalk',
    chatId: 'dingtalk:user:owner',
    senderId: 'dingtalk:owner',
    chatType: 'p2p',
    formats: ['pdf'],
    request: '最终交付 PDF',
  });
  const noArtifact = await pipeline.syncIssue({
    id: 'issue-9', identifier: 'MYS-9', workspace_id: 'ws-1', status: 'done',
  }, { comments: [] });
  assert.equal(noArtifact.waiting, 1);
  assert.equal(state.multicaDeliveryContract('issue-9').status, 'waiting_artifact');

  state.upsertMulticaDeliveryContract({
    issueId: 'issue-10',
    workspaceId: 'ws-1',
    channel: 'feishu',
    chatId: 'oc_owner',
    senderId: 'ou_owner',
    chatType: 'p2p',
    formats: ['pdf'],
    request: '最终交付 PDF',
  });
  const deliveryFailure = new MulticaArtifactDelivery({
    client,
    state,
    artifactRoot: join(dir, 'artifacts'),
    deliver: async () => { throw new Error('missing upload scope'); },
  });
  await assert.rejects(() => deliveryFailure.syncIssue({
    id: 'issue-10', identifier: 'MYS-10', workspace_id: 'ws-1', status: 'done',
  }), /missing upload scope/);
  assert.equal(
    state.multicaDeliveryContract('issue-10').status,
    'delivery_failed',
    'an uploaded artifact that failed at IM delivery must not be reported as ungenerated',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('MULTICA_ARTIFACT_DELIVERY_TEST_OK');
