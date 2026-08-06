import { extname } from 'node:path';

const ALLOWED_FORMATS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mov',
]);

export function artifactFormatForPath(path) {
  const format = extname(String(path || '')).slice(1).toLowerCase();
  return ALLOWED_FORMATS.has(format) ? format : '';
}

export function buildFeishuArtifactSendArgs({ chatId, relativePath, uuid = '' }) {
  const target = String(chatId || '').trim();
  const path = String(relativePath || '').trim();
  if (!target) throw new Error('Feishu artifact target is required');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error('Feishu artifact requires a safe relative path');
  }
  if (!artifactFormatForPath(path)) throw new Error('Unsupported artifact file format');
  const args = [
    'im', '+messages-send', '--as', 'user', '--chat-id', target,
    '--file', path, '--format', 'json',
  ];
  if (uuid) args.push('--idempotency-key', String(uuid).slice(0, 50));
  return args;
}

export function buildDingTalkArtifactSendArgs({ target, path, uuid = '' }) {
  const targetId = String(target?.id || '').trim();
  if (target?.channel !== 'dingtalk' || !targetId || !['user', 'group'].includes(target?.kind)) {
    throw new Error('A valid DingTalk artifact target is required');
  }
  const filePath = String(path || '').trim();
  if (!filePath || !artifactFormatForPath(filePath)) {
    throw new Error('Unsupported artifact file format');
  }
  const recipient = target.kind === 'group'
    ? ['--group', targetId]
    : ['--open-dingtalk-id', targetId];
  const args = [
    'chat', 'message', 'send', ...recipient,
    '--msg-type', 'file', '--file-path', filePath,
    '--ai-tag=false',
  ];
  if (uuid) args.push('--uuid', String(uuid).slice(0, 128));
  args.push('--yes', '--format', 'json');
  return args;
}
