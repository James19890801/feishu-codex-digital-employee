import { basename, extname } from 'node:path';

const DINGTALK_MEDIA_KIND = new Map([
  ['图片', 'image'],
  ['语音', 'audio'],
  ['音频', 'audio'],
  ['视频', 'video'],
]);

export function parseDingTalkMediaPlaceholder(content = '') {
  const text = String(content || '').trim();
  const kindMatch = text.match(/^\[?(图片|语音|音频|视频)消息\]?/);
  const resourceMatch = text.match(/mediaId\s*(?:=|:)\s*([^\s)]+)/i);
  if (!kindMatch || !resourceMatch) return null;
  return {
    kind: DINGTALK_MEDIA_KIND.get(kindMatch[1]),
    resourceId: resourceMatch[1].trim(),
    displayName: `${kindMatch[1]}消息`,
  };
}

export function parseDingTalkFilePlaceholder(content = '') {
  const text = String(content || '').trim();
  const match = text.match(/^(?:\[文件\]\s*)+(.+?)\s+fileId\s*:\s*([^\s]+)/i);
  if (!match) return null;
  const fileName = basename(match[1].trim()) || '未命名文件';
  return {
    kind: 'document',
    resourceId: match[2].trim(),
    fileName,
    displayName: fileName,
  };
}

export function buildDingTalkDriveDownloadArgs({
  profile = '',
  fileId,
  outputPath,
} = {}) {
  if (!String(fileId || '').trim() || !String(outputPath || '').trim()) {
    throw new Error('DingTalk drive fileId and outputPath are required');
  }
  return [
    ...(String(profile || '').trim() ? ['--profile', String(profile).trim()] : []),
    'drive', 'download',
    '--node', String(fileId).trim(),
    '--output', String(outputPath),
    '--format', 'json',
  ];
}

export function buildDingTalkMediaDownloadArgs({
  profile = '',
  resourceId,
  messageId,
  conversationId,
  outputPath,
} = {}) {
  const required = { resourceId, messageId, conversationId, outputPath };
  for (const [name, value] of Object.entries(required)) {
    if (!String(value || '').trim()) throw new Error(`DingTalk media ${name} is required`);
  }
  return [
    ...(String(profile || '').trim() ? ['--profile', String(profile).trim()] : []),
    'chat', 'message', 'download-media',
    '--type', 'mediaId',
    '--resource-id', String(resourceId).trim(),
    '--message-id', String(messageId).trim(),
    '--open-conversation-id', String(conversationId).trim(),
    '--output', String(outputPath),
    '--yes', '--format', 'json',
  ];
}

export function buildFeishuMediaDownloadArgs({
  messageId,
  fileKey,
  type,
  outputPath,
} = {}) {
  if (!String(messageId || '').trim() || !String(fileKey || '').trim()) {
    throw new Error('Feishu media messageId and fileKey are required');
  }
  if (!['image', 'file'].includes(type)) throw new Error('Feishu media type must be image or file');
  const output = String(outputPath || '').trim();
  if (!output || output.startsWith('/') || output.split('/').includes('..')) {
    throw new Error('Feishu media output path must be a safe relative path');
  }
  return [
    'im', '+messages-resources-download', '--as', 'user',
    '--message-id', String(messageId).trim(),
    '--file-key', String(fileKey).trim(),
    '--type', type,
    '--output', output,
    '--format', 'json',
  ];
}

export function buildTranscriptionInvocation({ command, args = [], inputPath } = {}) {
  const executable = String(command || '').trim();
  const input = String(inputPath || '').trim();
  if (!executable || !input) throw new Error('Transcription command and input are required');
  const commandName = basename(executable).toLowerCase();
  if (['sh', 'bash', 'zsh', 'fish', 'cmd', 'powershell', 'pwsh'].includes(commandName)
    || args.some(value => ['-c', '/c', '--command'].includes(String(value).toLowerCase()))) {
    throw new Error('Shell execution is not allowed for audio transcription');
  }
  const normalizedArgs = (Array.isArray(args) ? args : []).map(value => (
    String(value).replaceAll('{input}', input)
  ));
  if (!normalizedArgs.some(value => value.includes(input))) {
    throw new Error('Transcription arguments must contain the {input} placeholder');
  }
  return { command: executable, args: normalizedArgs };
}

export function mediaFileExtension(kind, sourceName = '') {
  const existing = extname(String(sourceName || '')).toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(existing)) return existing;
  if (kind === 'image') return '.jpg';
  if (kind === 'audio') return '.m4a';
  if (kind === 'video') return '.mp4';
  return '.bin';
}
