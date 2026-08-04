export function formatChannelCapabilities(channel, locale = 'en') {
  if (!channel?.capabilities) return '';
  const labels = locale === 'zh'
    ? { text: '文字', image: '图片', audio: '语音', link: '链接' }
    : { text: 'Text', image: 'Image', audio: 'Audio', link: 'Link' };
  return Object.entries(labels)
    .map(([key, label]) => `${label} ${channel.capabilities[key] ? '✓' : '×'}`)
    .join(' · ');
}
