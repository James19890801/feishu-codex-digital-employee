const STATE_NAMESPACE = 'wechat_recent_images';
const SOURCE_STATE_NAMESPACE = 'wechat_recent_image_sources';
const DEFAULT_LOOKBACK_MS = 30 * 60 * 1_000;
const MAX_IMAGES_PER_CHAT = 12;
const MAX_SOURCES_PER_CHAT = 50;
const MAX_THUMBNAIL_BASE64_CHARS = 512 * 1024;

export function weChatImageFailurePolicy({ contextOnly = false } = {}) {
  return contextOnly ? 'observe' : 'reply_unavailable';
}

export async function downloadWeChatImage({
  channel,
  image,
  outputDir,
  maxBytes,
  downloadContent,
  saveThumbnail,
} = {}) {
  if (!channel?.downloadImage) throw new Error('GeWe image downloader is unavailable');
  if (!String(image?.xml || '').trim()) throw new Error('GeWe image XML is missing');
  if (typeof downloadContent !== 'function') throw new Error('Public content downloader is unavailable');
  let lastError = new Error('GeWe image URL did not return an image');
  for (const type of [2, 1, 3]) {
    try {
      const url = await channel.downloadImage(image.xml, { type });
      const downloaded = await downloadContent(url, outputDir, { maxBytes });
      if (downloaded?.kind !== 'image') throw new Error('GeWe image URL did not return an image');
      return downloaded;
    } catch (error) {
      lastError = error;
    }
  }
  try {
    const thumbnail = String(image?.thumbnailBase64 || '').trim();
    if (!thumbnail || typeof saveThumbnail !== 'function') throw lastError;
    const bytes = Buffer.from(thumbnail, 'base64');
    if (!bytes.length || bytes.length > Number(maxBytes)) throw lastError;
    let extension = '';
    if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      extension = '.png';
    } else if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      extension = '.jpg';
    }
    if (!extension) throw lastError;
    const path = await saveThumbnail({ bytes, extension, outputDir });
    return { path, kind: 'image', bytes: bytes.length, thumbnail: true };
  } catch (error) {
    throw error;
  }
}

function normalizedImage(value) {
  const path = String(value?.path || '').trim();
  const messageId = String(value?.messageId || '').trim();
  if (!path || !messageId) return null;
  return {
    path,
    messageId,
    senderId: String(value?.senderId || '').trim(),
    createdAtMs: Number(value?.createdAtMs || 0),
  };
}

export function rememberWeChatImage(state, chatId, image, {
  lookbackMs = DEFAULT_LOOKBACK_MS,
  maxImages = MAX_IMAGES_PER_CHAT,
} = {}) {
  const key = String(chatId || '').trim();
  const next = normalizedImage(image);
  if (!key || !next) return [];
  const cutoff = next.createdAtMs - Math.max(1, Number(lookbackMs) || DEFAULT_LOOKBACK_MS);
  const previous = (state.get(STATE_NAMESPACE, key, []) || [])
    .map(normalizedImage)
    .filter(Boolean);
  const retained = previous
    .filter(item => item.messageId !== next.messageId && item.createdAtMs >= cutoff)
    .concat(next)
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-Math.max(1, Number(maxImages) || MAX_IMAGES_PER_CHAT));
  state.set(STATE_NAMESPACE, key, retained);
  const retainedIds = new Set(retained.map(item => item.messageId));
  return previous.filter(item => !retainedIds.has(item.messageId));
}

export function recentWeChatImages(state, chatId, {
  nowMs = Date.now(),
  limit = 4,
  lookbackMs = DEFAULT_LOOKBACK_MS,
} = {}) {
  const key = String(chatId || '').trim();
  if (!key) return [];
  const cutoff = Number(nowMs) - Math.max(1, Number(lookbackMs) || DEFAULT_LOOKBACK_MS);
  return (state.get(STATE_NAMESPACE, key, []) || [])
    .map(normalizedImage)
    .filter(item => item && item.createdAtMs >= cutoff && item.createdAtMs <= Number(nowMs))
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-Math.max(1, Number(limit) || 1));
}

function normalizedImageSource(value) {
  const xml = String(value?.xml || '').trim().slice(0, 20_000);
  const messageId = String(value?.messageId || '').trim();
  if (!xml || !messageId) return null;
  const thumbnailBase64 = String(value?.thumbnailBase64 || '').trim();
  return {
    xml,
    messageId,
    senderId: String(value?.senderId || '').trim(),
    createdAtMs: Number(value?.createdAtMs || 0),
    ...(thumbnailBase64 && thumbnailBase64.length <= MAX_THUMBNAIL_BASE64_CHARS
      ? { thumbnailBase64 }
      : {}),
  };
}

export function rememberWeChatImageSource(state, chatId, source, {
  maxSources = MAX_SOURCES_PER_CHAT,
} = {}) {
  const key = String(chatId || '').trim();
  const next = normalizedImageSource(source);
  if (!key || !next) return [];
  const previous = (state.get(SOURCE_STATE_NAMESPACE, key, []) || [])
    .map(normalizedImageSource)
    .filter(Boolean);
  const retained = previous
    .filter(item => item.messageId !== next.messageId)
    .concat(next)
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-Math.max(1, Number(maxSources) || MAX_SOURCES_PER_CHAT));
  state.set(SOURCE_STATE_NAMESPACE, key, retained);
  return retained;
}

export function recentWeChatImageSources(state, chatId, {
  limit = MAX_SOURCES_PER_CHAT,
  allowedMessageIds,
} = {}) {
  const key = String(chatId || '').trim();
  if (!key) return [];
  const allowed = allowedMessageIds instanceof Set ? allowedMessageIds : null;
  return (state.get(SOURCE_STATE_NAMESPACE, key, []) || [])
    .map(normalizedImageSource)
    .filter(item => item && (!allowed || allowed.has(item.messageId)))
    .sort((left, right) => left.createdAtMs - right.createdAtMs)
    .slice(-Math.max(1, Math.min(MAX_SOURCES_PER_CHAT, Number(limit) || 1)));
}
