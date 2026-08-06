function safeText(value, max = 500) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

export function formatMulticaLiveProgress(issue, messages) {
  const items = Array.isArray(messages) ? messages : [];
  const maxSeq = items.reduce((max, item) => Math.max(max, Number(item?.seq || 0)), 0);
  const visible = items
    .filter(item => item?.type === 'text')
    .map(item => safeText(item.content))
    .filter(Boolean)
    .slice(-3);
  if (!visible.length) return { text: '', maxSeq };
  const title = [issue?.identifier || '当前任务', issue?.title || ''].filter(Boolean).join(' · ');
  return {
    text: [`Multica 实时进度：${title}`, ...visible.map(value => `- ${value}`)].join('\n'),
    maxSeq,
  };
}
