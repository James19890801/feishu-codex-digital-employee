const IMAGE_DATA_URL = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MODEL = '@cf/moondream/moondream3.1-9B-A2B';

function hex(bytes) {
  return [...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export async function describeCloudImage({ ai, input, model = DEFAULT_MODEL } = {}) {
  if (!ai?.run) throw Object.assign(new Error('Workers AI binding is unavailable'), { code: 'vision_unavailable' });
  const match = String(input?.image || '').match(IMAGE_DATA_URL);
  if (!match) throw Object.assign(new Error('Cloud image must be an allowed base64 data URI'), { code: 'invalid_image' });
  const bytes = decodeBase64(match[2]);
  if (!bytes.byteLength || bytes.byteLength > MAX_IMAGE_BYTES || Number(input?.bytes) !== bytes.byteLength) {
    throw Object.assign(new Error('Cloud image size metadata is invalid'), { code: 'invalid_image_size' });
  }
  const digest = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
  if (digest !== String(input?.digest || '')) {
    throw Object.assign(new Error('Cloud image digest does not match'), { code: 'image_tampered' });
  }
  const result = await ai.run(model, {
    task: 'query', image: input.image,
    question: '请完整描述这张图片，识别其中可见文字、界面状态和关键对象；不确定的内容必须明确说明。',
    reasoning: false, stream: false, max_tokens: 2_048,
  });
  const text = String(result?.answer || result?.response || result?.caption || '').trim();
  if (!text) throw Object.assign(new Error('Workers AI returned an empty vision result'), { code: 'vision_empty' });
  return { text: text.slice(0, 8_000), model };
}
