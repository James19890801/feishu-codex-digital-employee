export async function resolveRequiredResponse({
  generate,
} = {}) {
  if (typeof generate !== 'function') throw new Error('generate is required');
  return { text: await generate(), fallback: false, error: '' };
}
