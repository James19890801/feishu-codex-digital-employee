function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

export function consoleAuthorized(request, username, password) {
  const expectedUsername = String(username || '');
  const expected = String(password || '');
  if (!expectedUsername || !expected) return false;
  const authorization = request.headers.get('authorization') || '';
  if (!authorization.startsWith('Basic ')) return false;
  try {
    const decoded = atob(authorization.slice(6));
    const separator = decoded.indexOf(':');
    return decoded.slice(0, separator) === expectedUsername && decoded.slice(separator + 1) === expected;
  } catch {
    return false;
  }
}

function formatAge(milliseconds) {
  const value = Number(milliseconds);
  if (!Number.isFinite(value)) return '尚未收到';
  if (value < 60_000) return `${Math.round(value / 1_000)} 秒`;
  if (value < 3_600_000) return `${Math.round(value / 60_000)} 分钟`;
  return `${Math.round(value / 3_600_000)} 小时`;
}

export function renderCloudConsole(status = {}) {
  const state = String(status.state || 'UNKNOWN');
  const tone = state === 'LOCAL_PRIMARY' ? 'local'
    : state === 'CLOUD_ACTIVE' ? 'cloud'
      : state === 'DEGRADED' ? 'danger' : 'transition';
  const checkedAt = new Date().toISOString();
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="15"><title>AIPR0S Cloud Failover</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui;background:#07100d;color:#ecfff7}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 15% 0,#16372a 0,transparent 35%),#07100d;padding:48px 22px}.wrap{max-width:980px;margin:auto}.eyebrow{color:#77f5b2;letter-spacing:.18em;text-transform:uppercase;font-size:12px}h1{font-size:clamp(32px,6vw,68px);margin:10px 0 8px;line-height:1}.sub{color:#9db7aa;margin-bottom:36px}.hero,.card{border:1px solid #244a39;background:#0d1b16cc;border-radius:22px;box-shadow:0 24px 80px #0008}.hero{padding:30px;display:flex;justify-content:space-between;align-items:end}.state{font-size:clamp(28px,5vw,52px);font-weight:800}.pill{padding:9px 14px;border-radius:999px;background:#153a2b;color:#7affb8}.cloud .pill{background:#172e55;color:#8fc5ff}.danger .pill{background:#4d1d23;color:#ff9da9}.transition .pill{background:#4a3c18;color:#ffe184}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:16px}.card{padding:22px}.label{color:#86a294;font-size:13px}.value{display:block;margin-top:10px;font-size:26px;font-weight:700}.footer{display:flex;justify-content:space-between;color:#6f8b7d;font-size:12px;margin-top:24px}.notice{margin-top:22px;padding:16px 18px;border-left:3px solid #77f5b2;background:#0c1814;color:#9db7aa}@media(max-width:700px){.grid{grid-template-columns:1fr}.hero{align-items:start;gap:20px;flex-direction:column}}
</style></head><body><main class="wrap ${tone}"><div class="eyebrow">AIPR0S · LOCAL FIRST · CLOUDFLARE + RAILWAY</div><h1>云端兜底控制台</h1><p class="sub">本地为主，Railway 待机；Qoder Cloud Agent 仅处理经过脱敏的 L0/L1 文本。</p>
<section class="hero"><div><div class="label">当前协调状态</div><div class="state">${escapeHtml(state)}</div></div><span class="pill">GEN ${escapeHtml(status.generation || 0)}</span></section>
<section class="grid"><article class="card"><span class="label">心跳距离现在</span><strong class="value">${escapeHtml(formatAge(status.heartbeatAgeMs))}</strong></article><article class="card"><span class="label">云端运行时</span><strong class="value">${status.containerReady ? 'ACTIVE' : 'STANDBY'}</strong></article><article class="card"><span class="label">云端处理中</span><strong class="value">${escapeHtml(status.inFlight || 0)}</strong></article></section>
${status.lastErrorCode ? `<div class="notice">最近异常代码：${escapeHtml(status.lastErrorCode)}</div>` : '<div class="notice">页面每 15 秒刷新；不展示消息、会话、身份或凭据。</div>'}
<footer class="footer"><span>Protocol ${escapeHtml(status.protocolVersion || '1')}</span><span>${escapeHtml(checkedAt)}</span></footer></main></body></html>`;
}
