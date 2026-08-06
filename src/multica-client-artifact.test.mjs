import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MulticaClient } from './multica-client.mjs';

const calls = [];
const runner = async (command, args, options) => {
  calls.push({ command, args, options });
  if (args.includes('comment') && args.includes('list')) {
    return { stdout: JSON.stringify([{ id: 'comment-1', attachments: [{ id: 'att-1' }] }]), stderr: '' };
  }
  if (args.includes('run-messages')) {
    return { stdout: JSON.stringify([{ seq: 3, type: 'text', content: '正在生成 PDF' }]), stderr: '' };
  }
  if (args.includes('rerun')) {
    return { stdout: JSON.stringify({ id: 'run-new', status: 'queued' }), stderr: '' };
  }
  if (args.includes('attachment') && args.includes('download')) {
    await writeFile(join(options.cwd, 'report.pdf'), Buffer.from('%PDF-1.7\n'));
    return { stdout: 'Downloaded report.pdf', stderr: '' };
  }
  throw new Error(`unexpected command: ${args.join(' ')}`);
};

const client = new MulticaClient({
  bin: '/opt/multica', profile: 'desktop-api.multica.ai', runner,
});
const comments = await client.listIssueComments('MYS-8', 'ws-1');
assert.equal(comments[0].attachments[0].id, 'att-1');
const commentArgs = calls.find(call => call.args.includes('comment') && call.args.includes('list')).args;
assert.equal(commentArgs.includes('--tail'), false, 'tail is only valid for a single thread');

const messages = await client.listIssueRunMessages('run-1', {
  issue: 'MYS-8', workspaceId: 'ws-1', since: 2,
});
assert.equal(messages[0].seq, 3);
assert.equal(calls.find(call => call.args.includes('run-messages')).args.includes('--since'), true);

const rerun = await client.rerunIssue('MYS-8', 'ws-1');
assert.equal(rerun.status, 'queued');

const dir = mkdtempSync(join(tmpdir(), 'multica-download-'));
try {
  const downloaded = await client.downloadAttachment('att-1', { outputDir: dir, workspaceId: 'ws-1' });
  assert.equal(downloaded.name, 'report.pdf');
  assert.equal(downloaded.path, join(dir, 'report.pdf'));
  assert.deepEqual(calls.find(call => call.args.includes('download')).args.slice(0, 4), [
    '--profile', 'desktop-api.multica.ai', '--workspace-id', 'ws-1',
  ]);

  const downloadCallCount = calls.filter(call => call.args.includes('download')).length;
  const replayed = await client.downloadAttachment('att-1', {
    outputDir: dir,
    workspaceId: 'ws-1',
  });
  assert.deepEqual(replayed, downloaded, 'a retry must reuse the isolated downloaded file');
  assert.equal(
    calls.filter(call => call.args.includes('download')).length,
    downloadCallCount,
    'a retry must not ask Multica to overwrite an existing artifact',
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('MULTICA_CLIENT_ARTIFACT_TEST_OK');
