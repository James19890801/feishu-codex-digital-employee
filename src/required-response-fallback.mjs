export const REQUIRED_RESPONSE_FALLBACK_REPLY =
  '收到，这条我先接住。刚才回复生成失败了，你不用重复发，我恢复后继续处理。';

export async function resolveRequiredResponse({
  responseRequired = false,
  generate,
  fallbackText = REQUIRED_RESPONSE_FALLBACK_REPLY,
} = {}) {
  if (typeof generate !== 'function') throw new Error('generate is required');
  try {
    return { text: await generate(), fallback: false, error: '' };
  } catch (error) {
    if (!responseRequired) throw error;
    return {
      text: fallbackText,
      fallback: true,
      error: String(error?.message || error),
    };
  }
}
