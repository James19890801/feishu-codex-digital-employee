import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLocalWiki,
  extractKnowledgeFromHtml,
  inventoryKnowledgeHtml,
} from './local-wiki-index.mjs';

const root = await mkdtemp(join(tmpdir(), 'local-wiki-index-'));
const articles = join(root, '公众号文章');
await mkdir(articles, { recursive: true });
const articlePath = join(articles, 'ai-flow.html');
await writeFile(articlePath, `<!doctype html><html><head><title>未来流程中的协同</title><style>.x{color:red}</style></head><body>
<button>一键复制</button><article><h1>未来流程中的协同</h1>
<p>未来 AI 进入流程，关键问题会从单点提效转向 AI、AI 与人的责任分配和协同机制。</p>
<script>alert('ignore')</script><h2>核心判断</h2><p>人负责目标、判断和责任，AI 负责分析、执行与连接。</p>
</article></body></html>`);
await mkdir(join(root, 'project', 'dist'), { recursive: true });
await writeFile(join(root, 'project', 'dist', 'index.html'), '<html><body>不应索引</body></html>');

const extracted = extractKnowledgeFromHtml(await readFile(articlePath, 'utf8'));
assert.equal(extracted.title, '未来流程中的协同');
assert.match(extracted.text, /AI、AI 与人的责任分配/);
assert.doesNotMatch(extracted.text, /一键复制|alert|color:red/);
assert.ok(extracted.chunks.length >= 1);

const inventory = await inventoryKnowledgeHtml({ roots: [root] });
assert.equal(inventory.files.length, 1);
assert.equal(inventory.excludedCount >= 1, true);

const outputDir = join(root, 'wiki-runtime');
const first = await buildLocalWiki({ roots: [root], outputDir });
assert.equal(first.sourceCount, 1);
assert.ok(first.chunkCount >= 1);
assert.equal(first.updatedCount, 1);
assert.equal(first.unchangedCount, 0);

const second = await buildLocalWiki({ roots: [root], outputDir });
assert.equal(second.sourceCount, 1);
assert.equal(second.updatedCount, 0);
assert.equal(second.unchangedCount, 1);

await writeFile(articlePath, (await readFile(articlePath, 'utf8')).replace('协同机制', '协同机制与治理规则'));
const third = await buildLocalWiki({ roots: [root], outputDir });
assert.equal(third.updatedCount, 1);

const index = JSON.parse(await readFile(join(outputDir, 'index.json'), 'utf8'));
assert.equal(index.version, 1);
assert.equal(index.sources.length, 1);
assert.doesNotMatch(JSON.stringify(index), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(index.chunks[0].text, /AI/);

console.log('LOCAL_WIKI_INDEX_TEST_OK');
