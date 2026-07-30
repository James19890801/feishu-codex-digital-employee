const $ = id => document.getElementById(id);
const stateLabels = {
  online: { title: '运行正常', kicker: '主通道正在真实工作', code: 'LIVE' },
  degraded: { title: '需要维护', kicker: '进程在线，但关键链路异常', code: 'WARN' },
  offline: { title: '主进程离线', kicker: '看门人在线，数字员工已停止', code: 'DOWN' },
  error: { title: '面板失联', kicker: '无法读取本机状态 API', code: 'ERR' },
};
const eventLabels = {
  message_replied: '消息已回复',
  message_received: '收到消息',
  inbound_enqueued: '消息进入队列',
  inbound_retry_scheduled: '安排消息重试',
  inbound_failed_final: '消息最终失败',
  inbound_dead_lettered: '消息进入死信',
  poller_error: '主轮询异常',
  websocket_error: '辅助监听异常',
  sdk_client_unavailable: '业务凭据未配置',
  message_rate_limited: '消息触发限流',
  maintenance_error: '维护任务异常',
};

let refreshTimer;
let lastFetchedAt = 0;

function formatAge(ms) {
  if (ms === null || !Number.isFinite(ms)) return '未知';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} 秒`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} 分钟`;
  return `${(ms / 3_600_000).toFixed(1)} 小时`;
}

function formatDate(value, timeOnly = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    ...(timeOnly
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }),
  }).format(date);
}

function setDot(id, good) {
  $(id).className = good ? 'good' : 'bad';
}

function renderEvents(events) {
  if (!events?.length) {
    $('timeline').innerHTML = '<p class="empty">暂时没有审计事件。</p>';
    return;
  }
  $('timeline').innerHTML = events.map(item => {
    const error = /error|failed|dead|unavailable/.test(item.event);
    const success = /replied|created|resumed|ready/.test(item.event);
    const detail = item.detail?.error
      ? String(item.detail.error).slice(0, 180)
      : Object.keys(item.detail || {}).length ? JSON.stringify(item.detail) : '正常记录';
    return `
      <div class="event ${error ? 'error' : success ? 'success' : ''}">
        <i class="event-dot"></i>
        <span class="event-name">${escapeHtml(eventLabels[item.event] || item.event)}</span>
        <span class="event-detail">${escapeHtml(detail)}</span>
        <time>${formatDate(item.at, true)}</time>
      </div>`;
  }).join('');
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value);
  return node.innerHTML;
}

function render(data) {
  const visual = stateLabels[data.state] || stateLabels.error;
  $('hero').dataset.state = data.state;
  $('statusTitle').textContent = visual.title;
  $('statusKicker').textContent = visual.kicker;
  $('statusCode').textContent = visual.code;
  $('statusSummary').textContent = data.state === 'online'
    ? '消息轮询持续推进，辅助监听在线，状态数据库完整。'
    : data.issueLabels?.[0] || '至少一条关键链路需要检查。';
  $('lastCheck').textContent = formatDate(data.checkedAt, true);

  $('issueStrip').classList.toggle('hidden', !data.issueLabels?.length);
  $('issueList').innerHTML = (data.issueLabels || []).map(label => `<span>${escapeHtml(label)}</span>`).join('');

  $('processValue').textContent = data.process.alive ? '运行中' : '已停止';
  $('processMeta').textContent = data.process.alive
    ? `PID ${data.process.pid} · 启动 ${formatDate(data.process.startedAt)}`
    : '面板仍在线，可尝试重启';
  setDot('processDot', data.process.alive);

  $('pollingValue').textContent = data.polling.healthy ? formatAge(data.polling.ageMs) : '已停滞';
  $('pollingMeta').textContent = data.polling.healthy
    ? `单次耗时 ${formatAge(data.polling.lastDurationMs)}`
    : (data.polling.lastError?.error || '轮询游标没有继续推进');
  setDot('pollingDot', data.polling.healthy);

  $('websocketValue').textContent = data.websocket.active ? `${data.websocket.activeConsumers} 个消费者` : '未连接';
  $('websocketMeta').textContent = `最近就绪 ${formatDate(data.websocket.lastReadyAt)}`;
  setDot('websocketDot', data.websocket.active);

  $('codexValue').textContent = data.codex.proxyReachable ? '可连接' : '网络不可达';
  $('codexMeta').textContent = data.codex.model || '模型未配置';
  setDot('codexDot', data.codex.proxyReachable);

  const counts = data.database.inboxCounts || {};
  $('completedCount').textContent = counts.completed || 0;
  $('processingCount').textContent = counts.processing || 0;
  $('failedCount').textContent = (counts.failed || 0) + (counts.dead || 0);
  $('dbIntegrity').textContent = data.database.integrity === 'ok' ? 'OK' : '异常';
  setDot('databaseDot', data.database.healthy);

  $('credentialGuide').classList.toggle('hidden', !data.maintenance?.credentialBlocked);
  renderEvents(data.recentEvents);
  lastFetchedAt = Date.now();
}

function renderError() {
  $('hero').dataset.state = 'error';
  $('statusTitle').textContent = stateLabels.error.title;
  $('statusKicker').textContent = stateLabels.error.kicker;
  $('statusCode').textContent = stateLabels.error.code;
  $('statusSummary').textContent = '如果刷新浏览器仍无法连接，请检查独立 Dashboard LaunchAgent。';
}

async function refresh() {
  $('refreshButton').disabled = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    renderError();
    showToast(`状态读取失败：${error.message}`);
  } finally {
    $('refreshButton').disabled = false;
  }
}

async function restart() {
  if (!window.confirm('确认重启数字员工主进程？面板不会关闭。')) return;
  $('restartButton').disabled = true;
  try {
    const response = await fetch('/api/restart', {
      method: 'POST',
      headers: { 'X-Dashboard-Action': 'restart' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showToast('重启指令已发送，正在等待主进程恢复。');
    setTimeout(refresh, 2500);
  } catch (error) {
    showToast(`重启失败：${error.message}`);
  } finally {
    setTimeout(() => { $('restartButton').disabled = false; }, 2500);
  }
}

function showToast(message) {
  $('toast').textContent = message;
  $('toast').classList.add('show');
  setTimeout(() => $('toast').classList.remove('show'), 3600);
}

function tick() {
  $('clock').textContent = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  $('refreshAge').textContent = lastFetchedAt ? `${Math.max(0, Math.floor((Date.now() - lastFetchedAt) / 1000))}s AGO` : '连接中';
}

$('refreshButton').addEventListener('click', refresh);
$('restartButton').addEventListener('click', restart);
setInterval(tick, 1000);
refreshTimer = setInterval(refresh, 5000);
window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
tick();
refresh();
