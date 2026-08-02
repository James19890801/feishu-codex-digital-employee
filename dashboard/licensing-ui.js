export function normalizeInvitationCode(value) {
  const source = String(value || '');
  if (/[^\d\s]/.test(source)) return '';
  const digits = source.replace(/\s+/g, '');
  return /^\d{0,10}$/.test(digits) ? digits : '';
}

export function canShowInviteStudio(status) {
  return status?.activated === true
    && status?.edition === 'Founder'
    && status?.issuer?.authorized === true;
}

export function licensingRequestHeaders(action, token) {
  return {
    'content-type': 'application/json',
    'x-dashboard-action': action,
    'x-dashboard-session': token,
  };
}

export function invitationCsv(codes) {
  const safeCodes = Array.isArray(codes)
    ? codes.filter(code => /^\d{10}$/.test(String(code)))
    : [];
  return `AIPRO invitation code\n${safeCodes.join('\n')}\n`;
}
