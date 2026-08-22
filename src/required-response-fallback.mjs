export const REQUIRED_RESPONSE_FALLBACK_REPLY = '我收到你的消息了。刚刚处理服务有点忙，这次没能完整生成回复。你可以再发一句，我会继续处理。';

export async function resolveRequiredResponse({
  generate,
} = {}) {
  if (typeof generate !== 'function') throw new Error('generate is required');
  const text = String(await generate() || '').trim();
  if (!text) throw new Error('AI returned an empty response');
  return { text, fallback: false, error: '' };
}
