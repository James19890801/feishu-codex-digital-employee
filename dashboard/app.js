import {
  assistantRequestHeaders,
  formatAssistantValue,
  planCanApply,
  rollbackConfirmation,
} from './config-ui.js';

const $ = id => document.getElementById(id);
const stateLabels = {
  online: { title: '运行正常', kicker: '主通道正在真实工作', code: 'LIVE' },
  degraded: { title: '需要维护', kicker: '进程在线，但关键链路异常', code: 'WARN' },
  offline: { title: '主进程离线', kicker: '看门人在线，AIPRO 已停止', code: 'DOWN' },
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
let configSessionToken = '';
let pendingConfigPlan = null;
let configBusy = false;

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
  if (!window.confirm('确认重启 AIPRO 主进程？面板不会关闭。')) return;
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

async function responseJson(response) {
  const payload = await response.json().catch(() => ({
    ok: false,
    error: `HTTP ${response.status}`,
  }));
  if (!response.ok || payload.ok === false) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.rolledBack = Boolean(payload.rolledBack);
    throw error;
  }
  return payload;
}

function appendConfigMessage(role, text, { loading = false } = {}) {
  const message = document.createElement('div');
  message.className = `assistant-message ${role}${loading ? ' loading' : ''}`;
  const label = document.createElement('span');
  label.textContent = role === 'user'
    ? 'YOU'
    : role === 'system' ? 'SYSTEM' : 'CONFIG COPILOT';
  const content = document.createElement('p');
  content.textContent = String(text || '');
  message.append(label, content);
  $('configMessages').append(message);
  $('configMessages').scrollTop = $('configMessages').scrollHeight;
  return message;
}

function setConfigBusy(busy) {
  configBusy = busy;
  $('configSendButton').disabled = busy;
  $('configInput').disabled = busy;
  $('applyPlanButton').disabled = busy || !planCanApply(pendingConfigPlan);
  $('cancelPlanButton').disabled = busy;
}

function renderConfigurationOverview(payload) {
  const configuration = payload.configuration || {};
  $('configScope').textContent = configuration.allowAllChats
    ? '全部群聊与单聊'
    : `指定会话 ${configuration.authorizedChatIds?.length || 0} 个`;
  $('configPoll').textContent = Number.isFinite(configuration.pollIntervalMs)
    ? `${(configuration.pollIntervalMs / 1000).toFixed(
      configuration.pollIntervalMs % 1000 ? 1 : 0,
    )} 秒`
    : '—';
  $('configProfile').textContent =
    `${payload.profile?.personaCharacters || 0} + ${payload.profile?.bibleCharacters || 0} 字符`;
  $('configKnowledge').textContent = `${payload.profile?.knowledgeDocuments || 0} 份`;
  $('configConnection').textContent = '安全模式已连接';
}

function renderSnapshots(snapshots) {
  const history = $('configHistory');
  history.replaceChildren();
  if (!snapshots?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '还没有配置备份。首次应用修改时会自动创建。';
    history.append(empty);
    return;
  }
  for (const snapshot of snapshots) {
    const row = document.createElement('div');
    row.className = 'snapshot';

    const detail = document.createElement('div');
    const summary = document.createElement('strong');
    summary.textContent = snapshot.summary || '配置备份';
    const meta = document.createElement('small');
    const time = document.createElement('time');
    time.textContent = `${formatDate(snapshot.createdAt)} · ${snapshot.id}`;
    meta.append(time);
    detail.append(summary, meta);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.textContent = '回滚';
    button.addEventListener('click', () => rollbackSnapshot(snapshot.id));
    row.append(detail, button);
    history.append(row);
  }
}

async function loadConfigurationAssistant() {
  try {
    const payload = await responseJson(await fetch('/api/config', { cache: 'no-store' }));
    configSessionToken = payload.sessionToken;
    renderConfigurationOverview(payload);
    renderSnapshots(payload.snapshots);
  } catch (error) {
    $('configConnection').textContent = '配置通道异常';
    appendConfigMessage('system', `无法读取当前配置：${error.message}`);
  }
}

function riskLabel(plan) {
  if (!planCanApply(plan)) return ['无需修改', ''];
  if (plan.confirmationLevel === 'double') return ['敏感变更 · 二次确认', 'double'];
  return ['常规变更 · 一次确认', 'single'];
}

function renderConfigPlan(plan) {
  pendingConfigPlan = plan;
  const canApply = planCanApply(plan);
  $('planEmpty').classList.toggle('hidden', canApply);
  $('planCard').classList.toggle('hidden', !canApply);
  const [label, className] = riskLabel(plan);
  $('planRisk').textContent = label;
  $('planRisk').className = className;
  $('planSummary').textContent = plan.summary || '配置建议';
  $('confirmationInput').value = '';

  const changes = $('planChanges');
  changes.replaceChildren();
  for (const change of plan.changes || []) {
    const card = document.createElement('section');
    card.className = 'plan-change';

    const header = document.createElement('header');
    const title = document.createElement('strong');
    title.textContent = change.label || change.key || change.target;
    const target = document.createElement('span');
    target.textContent = change.target === 'config' ? 'CONFIG' : 'IDENTITY';
    header.append(title, target);

    const comparison = document.createElement('div');
    comparison.className = 'change-values';
    for (const [caption, value, direction] of [
      ['修改前', change.before, 'before'],
      ['修改后', change.after, 'after'],
    ]) {
      const column = document.createElement('div');
      column.className = direction;
      const heading = document.createElement('span');
      heading.textContent = caption;
      const pre = document.createElement('pre');
      pre.textContent = formatAssistantValue(value);
      column.append(heading, pre);
      comparison.append(column);
    }
    card.append(header, comparison);
    if (change.reason) {
      const reason = document.createElement('p');
      reason.className = 'change-reason';
      reason.textContent = change.reason;
      card.append(reason);
    }
    changes.append(card);
  }

  const requiresCode = plan.confirmationLevel === 'double';
  $('confirmationBox').classList.toggle('hidden', !requiresCode);
  $('confirmationHint').textContent = requiresCode ? plan.confirmationCode : '------';
  $('applyPlanButton').disabled = configBusy || !canApply;
}

function clearConfigPlan() {
  pendingConfigPlan = null;
  $('planEmpty').classList.remove('hidden');
  $('planCard').classList.add('hidden');
  $('planRisk').textContent = '等待指令';
  $('planRisk').className = '';
  $('planChanges').replaceChildren();
  $('confirmationInput').value = '';
}

async function submitConfigRequest(event) {
  event.preventDefault();
  if (configBusy) return;
  const message = $('configInput').value.trim();
  if (!message) {
    showToast('请先描述你希望调整的效果。');
    return;
  }
  await loadConfigurationAssistant();
  if (!configSessionToken) return;
  clearConfigPlan();
  appendConfigMessage('user', message);
  $('configInput').value = '';
  const loading = appendConfigMessage('assistant', '正在读取当前配置并生成受限修改方案', {
    loading: true,
  });
  setConfigBusy(true);
  try {
    const payload = await responseJson(await fetch('/api/config/plan', {
      method: 'POST',
      headers: assistantRequestHeaders('config-plan', configSessionToken),
      body: JSON.stringify({ message }),
    }));
    loading.remove();
    const plan = payload.plan;
    appendConfigMessage(
      'assistant',
      plan.answer || (planCanApply(plan)
        ? '方案已生成。请检查右侧的修改前后对比，确认后再应用。'
        : '我检查了当前配置，这个请求不需要修改。'),
    );
    renderConfigPlan(plan);
  } catch (error) {
    loading.remove();
    appendConfigMessage('system', `方案生成失败：${error.message}`);
  } finally {
    setConfigBusy(false);
  }
}

async function applyConfigPlan() {
  if (configBusy || !planCanApply(pendingConfigPlan)) return;
  const confirmationCode = $('confirmationInput').value.trim();
  if (pendingConfigPlan.confirmationLevel === 'double'
    && confirmationCode !== pendingConfigPlan.confirmationCode) {
    showToast('请输入右侧显示的 6 位确认码。');
    $('confirmationInput').focus();
    return;
  }
  setConfigBusy(true);
  appendConfigMessage('system', '正在备份、写入、重启并执行健康检查，请不要关闭页面。');
  try {
    const payload = await responseJson(await fetch('/api/config/apply', {
      method: 'POST',
      headers: assistantRequestHeaders('config-apply', configSessionToken),
      body: JSON.stringify({
        planId: pendingConfigPlan.id,
        confirmationCode,
      }),
    }));
    appendConfigMessage(
      'assistant',
      `配置已应用并通过健康检查。当前状态：${payload.state || '正常'}。已保留回滚点 ${payload.snapshot?.id || ''}。`,
    );
    clearConfigPlan();
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } catch (error) {
    appendConfigMessage(
      'system',
      error.rolledBack
        ? `应用失败，但系统已经自动恢复到修改前：${error.message}`
        : `应用失败：${error.message}`,
    );
    if (error.rolledBack) clearConfigPlan();
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } finally {
    setConfigBusy(false);
  }
}

function cancelConfigPlan() {
  if (configBusy) return;
  clearConfigPlan();
  appendConfigMessage('system', '已放弃这份方案，没有修改任何配置。');
}

async function rollbackSnapshot(snapshotId) {
  if (configBusy) return;
  if (!window.confirm(`确认恢复到备份 ${snapshotId}？恢复后会重启并执行健康检查。`)) return;
  setConfigBusy(true);
  appendConfigMessage('system', `正在恢复备份 ${snapshotId} 并验证服务状态。`);
  try {
    const payload = await responseJson(await fetch('/api/config/rollback', {
      method: 'POST',
      headers: assistantRequestHeaders('config-rollback', configSessionToken),
      body: JSON.stringify({
        snapshotId,
        confirmation: rollbackConfirmation(snapshotId),
      }),
    }));
    appendConfigMessage('assistant', `备份已恢复并通过健康检查。当前状态：${payload.state || '正常'}。`);
    clearConfigPlan();
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } catch (error) {
    appendConfigMessage('system', `回滚失败：${error.message}`);
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } finally {
    setConfigBusy(false);
  }
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
$('configForm').addEventListener('submit', submitConfigRequest);
$('applyPlanButton').addEventListener('click', applyConfigPlan);
$('cancelPlanButton').addEventListener('click', cancelConfigPlan);
$('configInput').addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    $('configForm').requestSubmit();
  }
});
for (const chip of document.querySelectorAll('[data-config-prompt]')) {
  chip.addEventListener('click', () => {
    $('configInput').value = chip.dataset.configPrompt || '';
    $('configInput').focus();
  });
}
setInterval(tick, 1000);
refreshTimer = setInterval(refresh, 5000);
window.addEventListener('beforeunload', () => clearInterval(refreshTimer));
tick();
refresh();
loadConfigurationAssistant();
