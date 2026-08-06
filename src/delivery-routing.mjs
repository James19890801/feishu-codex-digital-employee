function channelProvider(chatId) {
  const value = String(chatId || '');
  if (value.startsWith('dingtalk:')) return 'dingtalk';
  if (value.startsWith('wecom:')) return 'wecom';
  if (value.startsWith('wechat:')) return 'wechat';
  return 'feishu';
}

const FORMAT_PATTERNS = [
  ['pdf', /\bPDF\b|PDF附件|PDF文件/i],
  ['docx', /\bDOCX?\b|\bWord\b|Word文档/i],
  ['xlsx', /\bXLSX?\b|\bExcel\b|Excel表格/i],
  ['pptx', /\bPPTX?\b|PowerPoint|演示文稿/i],
  ['zip', /\bZIP\b|压缩包/i],
  ['png', /\bPNG\b|PNG图片/i],
  ['jpg', /\bJPE?G\b|JPG图片/i],
  ['mp3', /\bMP3\b|音频文件/i],
  ['mp4', /\bMP4\b|视频文件/i],
];

export function explicitArtifactFormats(request) {
  const text = String(request || '');
  return FORMAT_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([format]) => format);
}

// AIPRO only creates a file delivery contract when the user names the format.
// Generic requests for reports, plans or tables remain normal agent replies.
export function buildDeliveryPlan({ chatId, request }) {
  const formats = explicitArtifactFormats(request);
  return {
    kind: formats.length ? 'artifact' : 'message',
    provider: channelProvider(chatId),
    ...(formats.length ? { formats } : {}),
    reason: formats.length ? 'explicit_output_format' : 'agent_runtime',
  };
}
