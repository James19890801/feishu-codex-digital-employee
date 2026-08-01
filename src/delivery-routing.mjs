const LOCAL_FILE_REQUEST = /(?:\bpdf\b|\bword\b|\.pdf\b|\.docx?\b|PDF|Word|本地文件|作为附件|附件形式)/i;
const DEVELOPMENT_IMPLEMENTATION = /(?:实现|开发|编写|修改|修复|重构|部署|调试).{0,16}(?:代码|程序|脚本|接口|功能|项目|仓库|bug)|(?:代码|程序|脚本|接口|功能|项目|仓库|bug).{0,16}(?:实现|开发|编写|修改|修复|重构|部署|调试)/i;
const SPREADSHEET_REQUEST = /(?:电子表格|AI\s*表格|数据表|表格|台账|看板|工作簿|预算表|排期表)/i;
const DOCUMENT_REQUEST = /(?:方案|报告|复盘|总结|文档|计划书|建议书|纪要|说明书).{0,16}(?:生成|制作|输出|整理|写|做|给我|发我)?|(?:生成|制作|输出|整理|写|做).{0,16}(?:方案|报告|复盘|总结|文档|计划书|建议书|纪要|说明书)/i;

function channelProvider(chatId) {
  const value = String(chatId || '');
  if (value.startsWith('dingtalk:')) return 'dingtalk';
  if (value.startsWith('wecom:')) return 'wecom';
  if (value.startsWith('wechat:')) return 'wechat';
  return 'feishu';
}

export function buildDeliveryPlan({ chatId, request }) {
  const text = String(request || '').trim();
  const provider = channelProvider(chatId);
  if (LOCAL_FILE_REQUEST.test(text) || DEVELOPMENT_IMPLEMENTATION.test(text)) {
    return { kind: 'local_file', provider, reason: LOCAL_FILE_REQUEST.test(text)
      ? 'explicit_file_format' : 'development_artifact' };
  }
  const asset = SPREADSHEET_REQUEST.test(text)
    ? 'online_spreadsheet'
    : DOCUMENT_REQUEST.test(text) ? 'online_document' : '';
  if (!asset) return { kind: 'message', provider, reason: 'conversation' };
  if (!['feishu', 'dingtalk'].includes(provider)) {
    return { kind: 'online_unavailable', provider, reason: 'native_online_asset_not_configured' };
  }
  return {
    kind: asset,
    provider,
    reason: asset === 'online_spreadsheet'
      ? 'channel_native_spreadsheet'
      : 'channel_native_document',
  };
}

function jsonObject(text) {
  const source = String(text || '').trim();
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const candidate = fenced || source.slice(source.indexOf('{'), source.lastIndexOf('}') + 1);
  return JSON.parse(candidate);
}

function cellValue(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  return String(value ?? '');
}

export function parseOnlineSheetModel(text) {
  const parsed = jsonObject(text);
  const columns = (Array.isArray(parsed?.columns) ? parsed.columns : [])
    .slice(0, 30)
    .map(value => String(value ?? '').trim().slice(0, 100));
  if (!columns.length || columns.some(value => !value)) throw new Error('Online sheet model has no valid columns');
  const rows = (Array.isArray(parsed?.rows) ? parsed.rows : [])
    .slice(0, 2000)
    .map(row => columns.map((_, index) => cellValue(Array.isArray(row) ? row[index] : '')));
  return {
    title: String(parsed?.title || '在线表格').trim().slice(0, 80) || '在线表格',
    columns,
    rows,
  };
}

export function sheetModelToValues(model) {
  return [model.columns, ...(model.rows || [])];
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function sheetModelToCsv(model) {
  return sheetModelToValues(model).map(row => row.map(csvCell).join(',')).join('\r\n');
}

export function assetUrlFromResult(value, depth = 0) {
  if (!value || depth > 8) return '';
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value.trim()) ? value.trim() : '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['url', 'nodeUrl', 'node_url', 'documentUrl', 'document_url', 'spreadsheetUrl']) {
    const found = assetUrlFromResult(value[key], depth + 1);
    if (found) return found;
  }
  for (const child of Object.values(value)) {
    const found = assetUrlFromResult(child, depth + 1);
    if (found) return found;
  }
  return '';
}
