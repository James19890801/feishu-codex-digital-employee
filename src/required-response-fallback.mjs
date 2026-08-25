export const REQUIRED_RESPONSE_FALLBACK_REPLY =
  '收到，刚才回复生成失败了，这次没有处理完成。请稍后再发一次，我会重新处理。';

export async function resolveRequiredResponse({
  responseRequired = false,
  generate,
  maxAttempts = 2,
} = {}) {
  if (typeof generate !== 'function') throw new Error('generate is required');
  const attempts = responseRequired ? Math.max(1, Number(maxAttempts) || 1) : 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return { text: await generate(), fallback: false, error: '' };
    } catch (error) {
      lastError = error;
      if (!responseRequired) throw error;
    }
  }
  return {
    text: REQUIRED_RESPONSE_FALLBACK_REPLY,
    fallback: true,
    error: String(lastError?.message || lastError).slice(0, 1000),
  };
}
