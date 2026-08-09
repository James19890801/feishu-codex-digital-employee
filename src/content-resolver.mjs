import { mkdir, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';

function itemLabel(item) {
  return String(item.fileName || item.url || item.resourceId || item.kind || 'content');
}

async function mapBounded(items, concurrency, operation) {
  const output = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

export async function resolveInboundContent(envelope, {
  tempRoot,
  fetchItem,
  extractText,
  transcribe,
  videoFrames,
  concurrency = 3,
} = {}) {
  if (typeof fetchItem !== 'function') throw new Error('Content resolver fetchItem is required');
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const tempDir = await mkdtemp(join(tempRoot, 'content-'));
  const settled = await mapBounded(
    Array.isArray(envelope?.items) ? envelope.items : [],
    Math.max(1, Number(concurrency) || 3),
    async item => {
      try {
        const fetched = await fetchItem(item, tempDir);
        const effective = {
          ...item,
          ...fetched,
          fileName: item.fileName || item.url || fetched.fileName || '',
        };
        const kind = effective.kind || item.kind;
        const result = { source: itemLabel(effective), textBlocks: [], imagePaths: [] };
        if (kind === 'image') {
          result.imagePaths.push(effective.path);
        } else if (kind === 'document' || kind === 'web' || kind === 'file') {
          if (typeof extractText !== 'function') throw new Error('Document extractor is unavailable');
          const text = String(await extractText(effective.path, effective) || '').trim();
          if (!text) throw new Error('No readable text found');
          result.textBlocks.push(`来源：${result.source}\n${text}`);
        } else if (kind === 'audio') {
          if (typeof transcribe !== 'function') throw new Error('Audio transcriber is unavailable');
          result.textBlocks.push(`来源：${result.source}\n${await transcribe(effective.path, effective)}`);
        } else if (kind === 'video') {
          if (typeof transcribe === 'function') {
            const transcript = String(await transcribe(effective.path, effective) || '').trim();
            if (transcript) result.textBlocks.push(`来源：${result.source}\n${transcript}`);
          }
          if (typeof videoFrames === 'function') {
            result.imagePaths.push(...await videoFrames(effective.path, tempDir, effective));
          }
          if (!result.textBlocks.length && !result.imagePaths.length) {
            throw new Error('Video contains no readable frames or transcript');
          }
        } else {
          throw new Error(`Unsupported content kind: ${kind || 'unknown'}`);
        }
        return { ok: true, ...result };
      } catch (error) {
        return {
          ok: false,
          warning: `${itemLabel(item)}：${String(error?.message || error || '处理失败')}`,
        };
      }
    },
  );
  const successful = settled.filter(item => item?.ok);
  return {
    tempDir,
    textBlocks: successful.flatMap(item => item.textBlocks),
    imagePaths: successful.flatMap(item => item.imagePaths),
    sources: successful.map(item => item.source),
    warnings: settled.filter(item => item && !item.ok).map(item => item.warning),
  };
}
