import { extname } from 'node:path';

const ALLOWED_FORMATS = new Set([
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'zip',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp3', 'wav', 'm4a', 'ogg', 'mp4', 'mov',
  'opus', 'html', 'htm',
]);

const IMAGE_FORMATS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const VIDEO_FORMATS = new Set(['mp4', 'mov']);

export function artifactFormatForPath(path) {
  const format = extname(String(path || '')).slice(1).toLowerCase();
  return ALLOWED_FORMATS.has(format) ? format : '';
}

export function buildFeishuArtifactSendArgs({
  chatId,
  relativePath,
  videoCoverRelativePath = '',
  uuid = '',
}) {
  const target = String(chatId || '').trim();
  const path = String(relativePath || '').trim();
  if (!target) throw new Error('Feishu artifact target is required');
  if (!path || path.startsWith('/') || path.split('/').includes('..')) {
    throw new Error('Feishu artifact requires a safe relative path');
  }
  const format = artifactFormatForPath(path);
  if (!format) throw new Error('Unsupported artifact file format');
  const args = [
    'im', '+messages-send', '--as', 'user', '--chat-id', target,
  ];
  if (IMAGE_FORMATS.has(format)) {
    args.push('--image', path);
  } else if (VIDEO_FORMATS.has(format)) {
    const cover = String(videoCoverRelativePath || '').trim();
    if (!cover || cover.startsWith('/') || cover.split('/').includes('..')) {
      throw new Error('Feishu video artifact requires a safe relative cover path');
    }
    args.push('--video', path, '--video-cover', cover);
  } else if (format === 'opus') {
    args.push('--audio', path);
  } else {
    args.push('--file', path);
  }
  args.push('--format', 'json');
  if (uuid) args.push('--idempotency-key', String(uuid).slice(0, 50));
  return args;
}

export function buildEnterpriseChatArtifactSendArgs({ target, path, uuid = '' }) {
  const targetId = String(target?.id || '').trim();
  if (target?.channel !== 'enterpriseChat' || !targetId || !['user', 'group'].includes(target?.kind)) {
    throw new Error('A valid EnterpriseChat artifact target is required');
  }
  const filePath = String(path || '').trim();
  if (!filePath || !artifactFormatForPath(filePath)) {
    throw new Error('Unsupported artifact file format');
  }
  const recipient = target.kind === 'group'
    ? ['--group', targetId]
    : ['--user', targetId];
  const args = [
    'chat', 'message', 'send', ...recipient,
    '--msg-type', 'file', '--file-path', filePath,
    '--transport-mode=standard',
  ];
  if (uuid) args.push('--uuid', String(uuid).slice(0, 128));
  args.push('--yes', '--format', 'json');
  return args;
}
