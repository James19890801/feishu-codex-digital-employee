import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLocalWiki,
  extractKnowledgeFromHtml,
  extractKnowledgeFromText,
  inventoryKnowledgeHtml,
  inventoryKnowledgeSources,
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

const downloads = join(root, 'Downloads');
await mkdir(downloads, { recursive: true });
await writeFile(join(downloads, '流程管理实用手册.pdf'), 'book-one');
await writeFile(join(downloads, '流程管理实用手册 (1).pdf'), 'book-one-copy');
await writeFile(join(downloads, 'AI赋能流程管理实战工作坊.pptx'), 'course-one');
await writeFile(join(downloads, 'AI流程管理旧课件.ppt'), 'legacy-course');
await writeFile(join(downloads, '客户A流程诊断报告.pdf'), 'private-report');
await writeFile(join(downloads, '旅游攻略.pdf'), 'travel');

const sourceInventory = await inventoryKnowledgeSources({
  htmlRoots: [root],
  documentRoots: [downloads],
});
assert.equal(sourceInventory.files.length, 5, '应收录 1 篇公众号、2 份同内容书籍和 2 份 AI 课件');
assert.equal(sourceInventory.files.filter(item => item.kind === 'document').length, 4);

const extractedBook = extractKnowledgeFromText(`
[第 1 章]
流程管理不是画图，而是端到端地设计价值流、责任和绩效闭环。
联系人：张三，电话 13800138000。
`, { title: '流程管理实用手册.pdf' });
assert.equal(extractedBook.title, '流程管理实用手册');
assert.match(extractedBook.text, /价值流/);
assert.doesNotMatch(extractedBook.text, /张三|13800138000/);
assert.ok(extractedBook.chunks.length >= 1);

const outputDir = join(root, 'wiki-runtime');
const extractedDocuments = new Map([
  ['流程管理实用手册.pdf', '流程管理要围绕端到端价值流设计，建立流程所有者、绩效和持续改进闭环。流程管理者还要跨部门识别交接断点，用客户价值校准局部目标。'],
  ['流程管理实用手册 (1).pdf', '流程管理要围绕端到端价值流设计，建立流程所有者、绩效和持续改进闭环。流程管理者还要跨部门识别交接断点，用客户价值校准局部目标。'],
  ['AI赋能流程管理实战工作坊.pptx', 'AI 进入流程后，要按目标、任务、判断和责任设计人与多个智能体的协同机制。人保留例外决策与最终责任，智能体负责可验证的分析、执行和交接。'],
]);
let extractCalls = 0;
const extractDocumentText = async path => {
  extractCalls += 1;
  if (path.endsWith('.ppt')) throw new Error('legacy Office conversion failed');
  return extractedDocuments.get(path.split('/').at(-1)) || '';
};
const first = await buildLocalWiki({
  roots: [root], documentRoots: [downloads], outputDir, extractDocumentText,
});
assert.equal(first.sourceCount, 3);
assert.ok(first.chunkCount >= 1);
assert.equal(first.updatedCount, 3);
assert.equal(first.unchangedCount, 0);
assert.equal(first.duplicateCount, 1);
assert.equal(first.extractionFailureCount, 1);
assert.equal(extractCalls, 4);

const second = await buildLocalWiki({
  roots: [root], documentRoots: [downloads], outputDir, extractDocumentText,
});
assert.equal(second.sourceCount, 3);
assert.equal(second.updatedCount, 0);
assert.equal(second.unchangedCount, 3);
assert.equal(extractCalls, 5, '未变更的成功大文件不应重复提取，失败文件可在下次刷新重试');

await writeFile(articlePath, (await readFile(articlePath, 'utf8')).replace('协同机制', '协同机制与治理规则'));
const third = await buildLocalWiki({
  roots: [root], documentRoots: [downloads], outputDir, extractDocumentText,
});
assert.equal(third.updatedCount, 1);

const index = JSON.parse(await readFile(join(outputDir, 'index.json'), 'utf8'));
assert.equal(index.version, 1);
assert.equal(index.sources.length, 3);
assert.doesNotMatch(JSON.stringify(index), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
assert.match(index.chunks.map(item => item.text).join('\n'), /AI/);
assert.match(index.chunks.map(item => item.text).join('\n'), /端到端价值流/);

console.log('LOCAL_WIKI_INDEX_TEST_OK');
