import {
  assetUrlFromResult,
  sheetModelToCsv,
  sheetModelToValues,
} from './delivery-routing.mjs';

function cleanTitle(value) {
  return String(value || '在线交付物').trim().replace(/[\r\n\t]/g, ' ').slice(0, 80) || '在线交付物';
}

function xmlEscape(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function markdownToFeishuXml(title, content) {
  const normalizedTitle = cleanTitle(title);
  const blocks = [`<title>${xmlEscape(normalizedTitle)}</title>`];
  const lines = String(content || '').split(/\r?\n/);
  const inline = value => xmlEscape(value).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  const tableCells = value => value.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim());
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    if (/^\|.*\|$/.test(line) && /^\|?\s*:?-{3,}/.test(lines[index + 1]?.trim() || '')) {
      const headers = tableCells(line);
      const rows = [];
      index += 2;
      while (index < lines.length && /^\|.*\|$/.test(lines[index].trim())) {
        rows.push(tableCells(lines[index]));
        index += 1;
      }
      index -= 1;
      blocks.push('<table><thead><tr>'
        + headers.map(cell => `<th>${inline(cell)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map(row => `<tr>${headers.map((_, cellIndex) => `<td>${inline(row[cellIndex] || '')}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>');
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const text = heading[2].trim();
      if (blocks.length === 1 && text === normalizedTitle) continue;
      blocks.push(`<h${heading[1].length}>${inline(text)}</h${heading[1].length}>`);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      const items = [bullet[1]];
      while (/^[-*]\s+(.+)$/.test(lines[index + 1]?.trim() || '')) {
        index += 1;
        items.push(lines[index].trim().match(/^[-*]\s+(.+)$/)[1]);
      }
      blocks.push(`<ul>${items.map(item => `<li>${inline(item)}</li>`).join('')}</ul>`);
      continue;
    }
    const numbered = line.match(/^\d+[.、]\s*(.+)$/);
    if (numbered) {
      const items = [numbered[1]];
      while (/^\d+[.、]\s*(.+)$/.test(lines[index + 1]?.trim() || '')) {
        index += 1;
        items.push(lines[index].trim().match(/^\d+[.、]\s*(.+)$/)[1]);
      }
      blocks.push(`<ol>${items.map(item => `<li seq="auto">${inline(item)}</li>`).join('')}</ol>`);
      continue;
    }
    blocks.push(`<p>${inline(line)}</p>`);
  }
  return blocks.join('\n');
}

function firstSheetId(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return '';
  for (const key of ['sheetId', 'sheet_id', 'id']) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  for (const child of Object.values(value)) {
    const found = firstSheetId(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function dingtalkNodeUrl(value, depth = 0) {
  const directUrl = assetUrlFromResult(value);
  if (directUrl) return directUrl;
  if (!value || typeof value !== 'object' || depth > 8) return '';
  for (const key of ['nodeId', 'node_id', 'dentryUuid', 'dentry_uuid']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      return `https://alidocs.dingtalk.com/i/nodes/${encodeURIComponent(value[key].trim())}`;
    }
  }
  for (const child of Object.values(value)) {
    const found = dingtalkNodeUrl(child, depth + 1);
    if (found) return found;
  }
  return '';
}

function dwsPrefix(profile) {
  return profile ? ['--profile', profile] : [];
}

function deepString(value, preferredKeys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return '';
  for (const key of preferredKeys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = deepString(child, preferredKeys, depth + 1);
    if (found) return found;
  }
  return '';
}

function normalizedText(value) {
  return String(value || '').replace(/\r\n/g, '\n').trim();
}

function columnLabel(count) {
  let value = Math.max(1, Number(count) || 1);
  let label = '';
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

async function deliverFeishu({ plan, title, content, sheetModel, runLark }) {
  if (typeof runLark !== 'function') throw new Error('Feishu online delivery runner is unavailable');
  const result = plan.kind === 'online_document'
    ? await runLark([
        'docs', '+create', '--as', 'user', '--doc-format', 'xml',
        '--content', '-', '--format', 'json',
      ], { input: markdownToFeishuXml(title, content) })
    : await runLark([
        'sheets', '+workbook-create', '--as', 'user', '--title', cleanTitle(title),
        '--values', '-', '--format', 'json',
      ], { input: JSON.stringify(sheetModelToValues(sheetModel)) });
  const url = assetUrlFromResult(result);
  if (!url) throw new Error('Feishu created an online asset but returned no URL');
  return { url, provider: 'feishu', kind: plan.kind, result };
}

async function deliverDingTalk({
  plan,
  title,
  content,
  sheetModel,
  dingtalkProfile,
  runDws,
}) {
  if (typeof runDws !== 'function') throw new Error('DingTalk online delivery runner is unavailable');
  const prefix = dwsPrefix(dingtalkProfile);
  if (plan.kind === 'online_document') {
    const result = await runDws([
      ...prefix, 'doc', 'create', '--name', cleanTitle(title),
      '--content', '-', '--format', 'json',
    ], { input: String(content || '') });
    const url = dingtalkNodeUrl(result);
    if (!url) throw new Error('DingTalk created an online document but returned no URL');
    const readback = await runDws([
      ...prefix, 'doc', 'read', '--node', url, '--format', 'json',
    ]);
    const readbackContent = deepString(readback, ['markdown', 'content']);
    if (!readbackContent || normalizedText(readbackContent) !== normalizedText(content)) {
      throw new Error('DingTalk online document read-back verification failed');
    }
    return { url, provider: 'dingtalk', kind: plan.kind, result };
  }

  const created = await runDws([
    ...prefix, 'sheet', 'create', '--name', cleanTitle(title), '--format', 'json',
  ]);
  const url = dingtalkNodeUrl(created);
  if (!url) throw new Error('DingTalk created an online spreadsheet but returned no URL');
  const listed = await runDws([
    ...prefix, 'sheet', 'list', '--node', url, '--format', 'json',
  ]);
  const sheetId = firstSheetId(listed);
  if (!sheetId) throw new Error('DingTalk spreadsheet returned no writable sheet ID');
  await runDws([
    ...prefix, 'sheet', 'csv-put', '--node', url, '--sheet-id', sheetId,
    '--start-cell', 'A1', '--csv', '-', '--format', 'json',
  ], { input: sheetModelToCsv(sheetModel) });
  const values = sheetModelToValues(sheetModel);
  const range = `A1:${columnLabel(values[0]?.length || 1)}${Math.max(1, values.length)}`;
  const readback = await runDws([
    ...prefix, 'sheet', 'csv-get', '--node', url, '--sheet-id', sheetId,
    '--range', range, '--format', 'json',
  ]);
  const readbackCsv = deepString(readback, ['csv', 'content', 'data']);
  if (!readbackCsv || normalizedText(readbackCsv) !== normalizedText(sheetModelToCsv(sheetModel))) {
    throw new Error('DingTalk online spreadsheet read-back verification failed');
  }
  return { url, provider: 'dingtalk', kind: plan.kind, result: created };
}

export async function deliverOnlineAsset(options) {
  if (options?.plan?.provider === 'feishu') return deliverFeishu(options);
  if (options?.plan?.provider === 'dingtalk') return deliverDingTalk(options);
  throw new Error(`Unsupported online delivery provider: ${options?.plan?.provider || 'unknown'}`);
}
