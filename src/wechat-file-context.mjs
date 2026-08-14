const FILE_STATE_NAMESPACE = 'wechat_recent_files';
const SOURCE_STATE_NAMESPACE = 'wechat_recent_file_sources';
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const MAX_FILES_PER_CHAT = 12;
const MAX_SOURCES_PER_CHAT = 50;

function safeFileName(value) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]/g, '_')
    .trim()
    .slice(0, 180) || '微信文件.bin';
}

function normalizedSource(value) {
  const xml = String(value?.xml || '').trim().slice(0, 40_000);
  const messageId = String(value?.messageId || '').trim();
  if (!xml || !messageId) return null;
  return {
    xml,
    fileName: safeFileName(value?.fileName),
    sizeBytes: Math.max(0, Math.trunc(Number(value?.sizeBytes) || 0)),
    messageId,
    senderId: String(value?.senderId || '').trim(),
    createdAtMs: Number(value?.createdAtMs || 0),
  };
}

function normalizedFile(value) {
  const path = String(value?.path || '').trim();
  const messageId = String(value?.messageId || '').trim();
  if (!path || !messageId) return null;
  return {
    path,
    fileName: safeFileName(value?.fileName),
    messageId,
    senderId: String(value?.senderId || '').trim(),
    createdAtMs: Number(value?.createdAtMs || 0),
  };
}

function recentValues(state, namespace, chatId, normalize, {
  nowMs = Date.now(),
  limit,
  lookbackMs = DEFAULT_LOOKBACK_MS,
  allowedMessageIds,
} = {}) {
  const key = String(chatId || '').trim();
  if (!key) return [];
  const allowed = allowedMessageIds instanceof Set ? allowedMessageIds : null;
  const cutoff = Number(nowMs) - Math.max(1, Number(lookbackMs) || DEFAULT_LOOKBACK_MS);
  return (state.get(namespace, key, []) || [])
    .map(normalize)
    .filter(item => item
      && item.createdAtMs >= cutoff
      && item.createdAtMs <= Number(nowMs)
      && (!allowed || allowed.has(item.messageId)))
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-Math.max(1, Number(limit) || 4));
}

function rememberValue(state, namespace, chatId, value, normalize, maxItems) {
  const key = String(chatId || '').trim();
  const next = normalize(value);
  if (!key || !next) return [];
  const retained = (state.get(namespace, key, []) || [])
    .map(normalize)
    .filter(item => item && item.messageId !== next.messageId)
    .concat(next)
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-Math.max(1, Number(maxItems) || 1));
  state.set(namespace, key, retained);
  return retained;
}

export function rememberWeChatFileSource(state, chatId, source, options = {}) {
  return rememberValue(
    state, SOURCE_STATE_NAMESPACE, chatId, source, normalizedSource,
    options.maxSources || MAX_SOURCES_PER_CHAT,
  );
}

export function recentWeChatFileSources(state, chatId, options = {}) {
  return recentValues(state, SOURCE_STATE_NAMESPACE, chatId, normalizedSource, options);
}

export function rememberWeChatFile(state, chatId, file, options = {}) {
  return rememberValue(
    state, FILE_STATE_NAMESPACE, chatId, file, normalizedFile,
    options.maxFiles || MAX_FILES_PER_CHAT,
  );
}

export function recentWeChatFiles(state, chatId, options = {}) {
  return recentValues(state, FILE_STATE_NAMESPACE, chatId, normalizedFile, options);
}

export function resolveWeChatFileContext(state, {
  chatId,
  messageId,
  senderId = '',
  createdAtMs = Date.now(),
  currentFile,
  shouldRead = false,
  allowedMessageIds,
  limit = 4,
  fileExists = () => true,
} = {}) {
  const currentSource = currentFile ? normalizedSource({
    ...currentFile,
    messageId,
    senderId,
    createdAtMs,
  }) : null;
  if (currentSource) rememberWeChatFileSource(state, chatId, currentSource);
  if (!shouldRead) return { files: [], sources: [] };

  const sourceIds = new Set(allowedMessageIds instanceof Set ? allowedMessageIds : []);
  if (currentSource) sourceIds.add(currentSource.messageId);
  const options = {
    nowMs: createdAtMs,
    limit,
    ...(sourceIds.size ? { allowedMessageIds: sourceIds } : {}),
  };
  const files = recentWeChatFiles(state, chatId, options)
    .filter(item => fileExists(item.path));
  const cachedIds = new Set(files.map(item => item.messageId));
  const sources = recentWeChatFileSources(state, chatId, options)
    .filter(item => !cachedIds.has(item.messageId));
  return { files, sources };
}

export async function downloadWeChatFile({
  channel,
  file,
  outputDir,
  maxBytes,
  downloadContent,
} = {}) {
  if (!channel?.downloadFile) throw new Error('GeWe file downloader is unavailable');
  if (!String(file?.xml || '').trim()) throw new Error('GeWe file XML is missing');
  if (typeof downloadContent !== 'function') throw new Error('Public content downloader is unavailable');
  const declaredBytes = Math.max(0, Math.trunc(Number(file?.sizeBytes) || 0));
  if (declaredBytes > Number(maxBytes)) throw new Error('GeWe file exceeds size limit');
  const url = await channel.downloadFile(file.xml);
  const downloaded = await downloadContent(url, outputDir, { maxBytes });
  if (!['document', 'file'].includes(downloaded?.kind)) {
    throw new Error('GeWe file URL did not return a document');
  }
  return { ...downloaded, fileName: safeFileName(file?.fileName || downloaded?.fileName) };
}
