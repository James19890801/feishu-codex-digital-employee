function boundedText(value, maximum, fallback = '') {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return (normalized || fallback).slice(0, maximum);
}

export function normalizeOperatorProfile({
  displayName = '',
  role = '',
  aliases = [],
  brandName = '',
} = {}) {
  const normalizedDisplayName = boundedText(displayName, 80, '账号本人');
  const normalizedAliases = [...new Set(
    (Array.isArray(aliases) ? aliases : [])
      .map(value => boundedText(value, 80))
      .filter(Boolean),
  )].slice(0, 20);
  return {
    displayName: normalizedDisplayName,
    role: boundedText(role, 160),
    aliases: normalizedAliases,
    brandName: boundedText(brandName, 120, 'Personal Digital Human'),
    ownerLabel: normalizedDisplayName,
  };
}
