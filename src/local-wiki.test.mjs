import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchLocalWiki } from './local-wiki.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipros-local-wiki-'));
const indexPath = join(root, 'index.json');
await writeFile(indexPath, JSON.stringify({ records: [{
  id: 'doc-1',
  title: '夜间知识同步方案',
  text: '每天十八点通过 DWS Channel 增量更新知识库。',
  locator: 'local-wiki:2026-08-04#doc-1',
  date: '2026-08-04',
}] }));

const denied = await searchLocalWiki('知识同步', {
  indexPath,
  senderId: 'other',
  ownerId: 'owner',
});
assert.deepEqual(denied, []);

const results = await searchLocalWiki('DWS 知识库', {
  indexPath,
  senderId: 'owner',
  ownerId: 'owner',
});
assert.equal(results.length, 1);
assert.equal(results[0].id, 'doc-1');

await writeFile(indexPath, JSON.stringify({ records: [{
  id: 'doc-2', title: '动态内容', text: '不重启即可读取', locator: 'local-wiki:new', date: '2026-08-04',
}] }));
const reloaded = await searchLocalWiki('不重启', { indexPath, senderId: 'owner', ownerId: 'owner' });
assert.equal(reloaded[0].id, 'doc-2');

console.log('LOCAL_WIKI_TEST_OK');
