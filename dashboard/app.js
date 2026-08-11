import {
  assistantRequestHeaders,
  channelNeedsCredential,
  channelRequestHeaders,
  channelSubmitLabel,
  formatAssistantValue,
  planCanApply,
  rollbackConfirmation,
  runtimeCanSelect,
  runtimeStatusLabel,
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
  dingtalk_channel_error: '钉钉通道异常',
  wecom_channel_error: '企业微信通道异常',
  wechat_channel_error: '个人微信通道异常',
  im_channel_connected: 'IM 通道已连接',
  im_channel_disconnected: 'IM 通道已断开',
  multica_sync_error: 'Multica 同步异常',
  multica_delivery_pending: 'Multica 通知等待重试',
  multica_sync_change: 'Multica Issue 变化',
  multica_sync_notification_failed: 'Multica 通知失败',
  multica_plan_created: 'Multica 方案已生成',
  multica_action_completed: 'Multica 操作完成',
  multica_mutation_applied: 'Multica 写入完成',
  multica_mutation_failed: 'Multica 写入失败',
  a1_sync_error: 'A1 同步异常',
  a1_delivery_pending: 'A1 通知等待重试',
  a1_sync_change: 'A1 工作项变化',
  a1_sync_notification_failed: 'A1 通知失败',
  a1_sync_notification_dead_lettered: 'A1 通知进入死信',
  a1_plan_created: 'A1 方案已生成',
  a1_action_completed: 'A1 操作完成',
  a1_mutation_applied: 'A1 写入完成',
  a1_mutation_failed: 'A1 写入失败',
  sdk_client_unavailable: '业务凭据未配置',
  message_rate_limited: '消息触发限流',
  maintenance_error: '维护任务异常',
};

let refreshTimer;
let lastFetchedAt = 0;
let configSessionToken = '';
let pendingConfigPlan = null;
let configBusy = false;
let latestRuntimeState = null;
let latestChannelConfigurations = {};
let selectedChannel = '';
let channelBusy = false;

const channelCopy = {
  feishu: {
    title: '飞书通道（本机禁用）',
    description: '这台机器不使用飞书，不需要 App ID、Open ID、CLI 或登录凭据。',
  },
  dingtalk: {
    title: '连接钉钉',
    description: '优先自动使用本机 DWS CLI 与已有真人身份登录。',
  },
  wecom: {
    title: '连接企业微信',
    description: '填写官方智能机器人身份，后台建立 WebSocket 长连接。',
  },
  wechat: {
    title: '连接个人微信',
    description: '填写 GeWe 节点信息，通过第三方 REST + Webhook 接收与回复。',
  },
};

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

function renderChannel(prefix, channel, fallbackMeta) {
  const status = $(`channel${prefix}Status`);
  const meta = $(`channel${prefix}Meta`);
  const dot = $(`channel${prefix}Dot`);
  if (channel?.transport === 'disabled') {
    status.textContent = '本机禁用';
    meta.textContent = '不参与启动、健康检查或验收';
    dot.className = '';
    return;
  }
  if (!channel?.enabled) {
    status.textContent = !channel?.installed
      ? '未安装'
      : channel?.configured ? '已安装 · 待启用' : '已安装 · 待配置';
    meta.textContent = fallbackMeta;
    dot.className = '';
    return;
  }
  if (channel.connected) {
    status.textContent = '在线';
    meta.textContent = `${fallbackMeta} · ${formatDate(channel.lastReadyAt, true)}`;
    dot.className = 'good';
    return;
  }
  status.textContent = channel.authenticated ? '正在重连' : '需要认证';
  meta.textContent = channel.lastError?.error
    ? String(channel.lastError.error).slice(0, 120)
    : fallbackMeta;
  dot.className = channel.authenticated ? 'warn' : 'bad';
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
    ? '钉钉主通道在线，A1 与本机运行时可用，状态数据库完整。'
    : data.issueLabels?.[0] || '至少一条关键链路需要检查。';
  $('lastCheck').textContent = formatDate(data.checkedAt, true);

  $('issueStrip').classList.toggle('hidden', !data.issueLabels?.length);
  $('issueList').innerHTML = (data.issueLabels || []).map(label => `<span>${escapeHtml(label)}</span>`).join('');

  renderChannel(
    'Feishu',
    data.channels?.feishu,
    '真人用户身份 · 轮询 + WebSocket',
  );
  renderChannel(
    'Dingtalk',
    data.channels?.dingtalk,
    '真人用户身份 · DWS 个人事件长连接',
  );
  renderChannel(
    'Wecom',
    data.channels?.wecom,
    '智能机器人身份 · 官方 WebSocket SDK',
  );
  renderChannel(
    'Wechat',
    data.channels?.wechat,
    '个人微信身份 · GeWe 第三方 REST + Webhook',
  );

  $('processValue').textContent = data.process.alive ? '运行中' : '已停止';
  $('processMeta').textContent = data.process.alive
    ? `PID ${data.process.pid} · 启动 ${formatDate(data.process.startedAt)}`
    : '面板仍在线，可尝试重启';
  setDot('processDot', data.process.alive);

  const feishuEnabled = data.channels?.feishu?.enabled === true;
  $('pollingValue').textContent = !feishuEnabled
    ? '本机禁用'
    : data.polling.healthy ? formatAge(data.polling.ageMs) : '已停滞';
  $('pollingMeta').textContent = !feishuEnabled
    ? '飞书不参与当前运行'
    : data.polling.healthy
      ? `单次耗时 ${formatAge(data.polling.lastDurationMs)}`
      : (data.polling.lastError?.error || '轮询游标没有继续推进');
  setDot('pollingDot', !feishuEnabled || data.polling.healthy);

  $('websocketValue').textContent = data.websocket.active ? `${data.websocket.activeConsumers} 个消费者` : '未连接';
  $('websocketMeta').textContent = `最近就绪 ${formatDate(data.websocket.lastReadyAt)}`;
  setDot('websocketDot', data.websocket.active);

  $('codexValue').textContent = data.aiRuntime?.label || '未选择';
  $('codexMeta').textContent = data.aiRuntime?.configured === 'auto'
    ? `自动选择 · ${data.aiRuntime?.selected || '无可用引擎'}`
    : `固定选择 · ${data.aiRuntime?.selected || '不可用'}`;
  setDot('codexDot', data.aiRuntime?.healthy);
  renderRuntimeState(data.aiRuntime);

  $('a1Value').textContent = !data.a1.enabled
    ? '未启用'
    : data.a1.healthy ? '同步在线' : '需要维护';
  $('a1Meta').textContent = data.a1.enabled
    ? `${data.a1.authenticated ? '身份已认证' : '身份未认证'} · 最近同步 ${formatAge(data.a1.ageMs)}`
      + ` · 扫描 ${data.a1.scanned || 0} 条`
      + (data.a1.pending ? ` · 待补发 ${data.a1.pending}` : '')
      + (data.a1.dead ? ` · 死信 ${data.a1.dead}` : '')
    : '可在配置面板启用';
  setDot('a1Dot', data.a1.enabled && data.a1.healthy);

  const counts = data.database.inboxCounts || {};
  $('completedCount').textContent = counts.completed || 0;
  $('processingCount').textContent = counts.processing || 0;
  $('failedCount').textContent = (counts.failed || 0) + (counts.dead || 0);
  $('dbIntegrity').textContent = data.database.integrity === 'ok'
    ? `OK · 备份 ${formatAge(data.database.backupAgeMs)}`
    : '异常';
  setDot('databaseDot', data.database.healthy);

  $('credentialGuide').classList.toggle(
    'hidden',
    !(data.channels?.dingtalk?.enabled && !data.channels?.dingtalk?.authenticated),
  );
  renderEvents(data.recentEvents);
  lastFetchedAt = Date.now();
}

function runtimeCard(runtime, configured) {
  const card = document.createElement('article');
  const selected = runtime.id === configured
    || (runtime.id === 'auto' && configured === 'auto');
  card.className = `runtime-card ${runtime.available ? 'available' : 'unavailable'}${selected ? ' selected' : ''}`;

  const header = document.createElement('header');
  const dot = document.createElement('i');
  const title = document.createElement('h4');
  title.textContent = runtime.label;
  header.append(dot, title);

  const status = document.createElement('b');
  status.textContent = runtime.id === 'auto'
    ? 'CODEX FIRST'
    : runtimeStatusLabel(runtime).toUpperCase();
  const description = document.createElement('p');
  description.textContent = runtime.reason || runtime.description || '';
  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.runtimeId = runtime.id;
  button.textContent = selected
    ? '当前配置'
    : runtime.available ? '选择此运行时' : runtimeStatusLabel(runtime);
  button.disabled = !runtimeCanSelect(runtime, configured);
  card.append(header, status, description, button);
  return card;
}

function renderRuntimeState(state) {
  if (!state) return;
  latestRuntimeState = state;
  $('runtimeCurrent').textContent = state.label || '无可用运行时';
  $('runtimePolicy').textContent = state.configured === 'auto'
    ? `AUTO / ${(state.selected || 'NONE').toUpperCase()}`
    : `FIXED / ${String(state.configured || '').toUpperCase()}`;
  const grid = $('runtimeGrid');
  grid.replaceChildren();
  grid.append(runtimeCard({
    id: 'auto',
    label: '自动选择',
    description: '按 Codex、Qoder、CodeBuddy 的顺序选择本机可用引擎。',
    installed: true,
    available: (state.runtimes || []).some(item => item.available),
    reason: '',
  }, state.configured));
  for (const runtime of state.runtimes || []) {
    grid.append(runtimeCard(runtime, state.configured));
  }
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
  if (payload.aiRuntime) renderRuntimeState(payload.aiRuntime);
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
    latestChannelConfigurations = payload.channels || {};
    renderConfigurationOverview(payload);
    renderSnapshots(payload.snapshots);
    return payload;
  } catch (error) {
    $('configConnection').textContent = '配置通道异常';
    appendConfigMessage('system', `无法读取当前配置：${error.message}`);
    return null;
  }
}

function setChannelBusy(busy) {
  channelBusy = busy;
  $('channelTestButton').disabled = busy;
  $('channelSaveButton').disabled = busy
    || latestChannelConfigurations[selectedChannel]?.protected === true;
  $('channelDialogClose').disabled = busy;
}

function renderChannelReport(report) {
  const validation = $('channelValidation');
  validation.dataset.state = report?.state || '';
  $('channelValidationState').textContent = report?.state === 'connected'
    ? '全部通过 · 已连接'
    : report?.state === 'disabled'
      ? '通道未启用'
      : report?.state === 'failed' ? '未通过' : '尚未测试';
  const checks = $('channelValidationChecks');
  checks.replaceChildren();
  if (!report?.checks?.length) {
    const empty = document.createElement('p');
    empty.textContent = '点击“测试当前连接”，查看每一个验收项。';
    checks.append(empty);
    return;
  }
  for (const item of report.checks) {
    const row = document.createElement('div');
    row.className = `channel-check${item.passed ? ' passed' : ''}`;
    const dot = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = item.label;
    const detail = document.createElement('small');
    detail.textContent = item.detail || (item.passed ? '通过' : '未通过');
    row.append(dot, label, detail);
    checks.append(row);
  }
  if (report.detail) {
    const detail = document.createElement('p');
    detail.textContent = `最近错误：${report.detail}`;
    checks.append(detail);
  }
}

function renderChannelForm(channel, configuration) {
  selectedChannel = channel;
  const copy = channelCopy[channel];
  $('channelDialogTitle').textContent = copy?.title || '配置 IM 通道';
  $('channelDialogDescription').textContent = copy?.description || '';
  $('channelEnabledRow').classList.toggle('hidden', configuration.protected === true);
  $('channelEnabled').checked = configuration.enabled === true;
  $('channelFeishuIdentity').value = configuration.identity || '';
  $('channelDingtalkProfile').value = configuration.profile || '';
  $('channelWecomBotId').value = configuration.botId || '';
  $('channelWecomCredential').value = '';
  $('channelWecomCredentialState').textContent = configuration.credentialStored
    ? 'Keychain 已保存 · 留空不覆盖' : '尚未保存 · 启用时必填';
  $('channelWechatAppId').value = configuration.appId || '';
  $('channelWechatCredential').value = '';
  $('channelWechatCredentialState').textContent = configuration.credentialStored
    ? 'Keychain 已保存 · 留空不覆盖' : '尚未保存 · 启用时必填';
  $('channelWechatCallback').value = configuration.publicCallbackBaseUrl || '';
  $('channelWechatMentions').value = (configuration.mentionNames || []).join(', ');
  for (const section of document.querySelectorAll('[data-channel-fields]')) {
    section.classList.toggle('hidden', section.dataset.channelFields !== channel);
  }
  $('channelSaveButton').textContent = channelSubmitLabel(configuration);
  renderChannelReport(null);
  setChannelBusy(false);
}

async function openChannelDialog(channel) {
  const payload = await loadConfigurationAssistant();
  const configuration = payload?.channels?.[channel];
  if (!configuration) {
    showToast('无法读取这个通道的配置。');
    return;
  }
  renderChannelForm(channel, configuration);
  $('channelDialog').showModal();
}

function closeChannelDialog() {
  if (!channelBusy) $('channelDialog').close();
}

function channelRequestBody() {
  const base = {
    channel: selectedChannel,
    enabled: $('channelEnabled').checked,
    confirmed: true,
  };
  if (selectedChannel === 'dingtalk') {
    base.profile = $('channelDingtalkProfile').value.trim();
  } else if (selectedChannel === 'wecom') {
    base.botId = $('channelWecomBotId').value.trim();
    base.credential = $('channelWecomCredential').value;
  } else if (selectedChannel === 'wechat') {
    base.appId = $('channelWechatAppId').value.trim();
    base.credential = $('channelWechatCredential').value;
    base.publicCallbackBaseUrl = $('channelWechatCallback').value.trim();
    base.mentionNames = $('channelWechatMentions').value;
  }
  return base;
}

async function testSelectedChannel() {
  if (channelBusy || !selectedChannel) return;
  await loadConfigurationAssistant();
  if (!configSessionToken) return;
  setChannelBusy(true);
  $('channelValidationState').textContent = '正在执行真实连接测试…';
  try {
    const payload = await responseJson(await fetch('/api/channels/test', {
      method: 'POST',
      headers: assistantRequestHeaders('channel-test', configSessionToken),
      body: JSON.stringify({ channel: selectedChannel }),
    }));
    renderChannelReport(payload.report);
  } catch (error) {
    renderChannelReport({
      state: 'failed',
      detail: error.message,
      checks: [{ label: '测试接口', passed: false, detail: error.message }],
    });
  } finally {
    setChannelBusy(false);
  }
}

async function saveSelectedChannel(event) {
  event.preventDefault();
  if (channelBusy || !selectedChannel) return;
  const configuration = latestChannelConfigurations[selectedChannel];
  if (!configuration || configuration.protected) return;
  const body = channelRequestBody();
  const enteredCredential = body.credential || '';
  const requestedIdentity = selectedChannel === 'wecom' ? body.botId : body.appId;
  if (body.enabled && ['wecom', 'wechat'].includes(selectedChannel)
    && channelNeedsCredential(configuration, enteredCredential, requestedIdentity)) {
    showToast('启用前请填写当前通道的密钥。');
    $(selectedChannel === 'wecom' ? 'channelWecomCredential' : 'channelWechatCredential').focus();
    return;
  }
  if (!window.confirm('确认保存这条通道配置？系统会备份、重启并自动测试连接；失败会回滚。')) return;
  setChannelBusy(true);
  $('channelValidationState').textContent = '正在备份、连接与验收…';
  try {
    const payload = await responseJson(await fetch('/api/channels/configure', {
      method: 'POST',
      headers: channelRequestHeaders(configSessionToken),
      body: JSON.stringify(body),
    }));
    $('channelWecomCredential').value = '';
    $('channelWechatCredential').value = '';
    renderChannelReport(payload.report);
    showToast(payload.report?.state === 'disabled'
      ? '配置已保存，通道保持关闭。' : '配置已保存，真实连接测试通过。');
    await Promise.all([loadConfigurationAssistant(), refresh()]);
    renderChannelForm(selectedChannel, latestChannelConfigurations[selectedChannel]);
    renderChannelReport(payload.report);
  } catch (error) {
    renderChannelReport({
      state: 'failed',
      detail: error.message,
      checks: [{
        label: error.rolledBack ? '连接验收（已自动回滚）' : '配置保存',
        passed: false,
        detail: error.message,
      }],
    });
    showToast(error.rolledBack ? '连接失败，已自动恢复原配置。' : `配置失败：${error.message}`);
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } finally {
    setChannelBusy(false);
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

async function requestRuntimePlan(runtimeId) {
  if (configBusy) return;
  await loadConfigurationAssistant();
  if (!configSessionToken) return;
  const runtime = runtimeId === 'auto'
    ? { label: '自动选择' }
    : latestRuntimeState?.runtimes?.find(item => item.id === runtimeId);
  if (!runtime || (runtimeId !== 'auto' && !runtime.available)) {
    showToast('这个运行时尚不具备可用的无界面 CLI。');
    return;
  }
  clearConfigPlan();
  appendConfigMessage('user', `切换 AI 运行时为 ${runtime.label}`);
  setConfigBusy(true);
  try {
    const payload = await responseJson(await fetch('/api/config/runtime-plan', {
      method: 'POST',
      headers: assistantRequestHeaders('runtime-plan', configSessionToken),
      body: JSON.stringify({ runtimeId }),
    }));
    appendConfigMessage('assistant', payload.plan.answer);
    renderConfigPlan(payload.plan);
    $('configConsole').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    appendConfigMessage('system', `无法生成运行时切换方案：${error.message}`);
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
$('channelDialogClose').addEventListener('click', closeChannelDialog);
$('channelTestButton').addEventListener('click', testSelectedChannel);
$('channelForm').addEventListener('submit', saveSelectedChannel);
$('channelEnabled').addEventListener('change', () => {
  const configuration = latestChannelConfigurations[selectedChannel] || {};
  $('channelSaveButton').textContent = channelSubmitLabel({
    ...configuration,
    enabled: $('channelEnabled').checked,
  });
});
$('channelDialog').addEventListener('cancel', event => {
  if (channelBusy) event.preventDefault();
});
for (const button of document.querySelectorAll('[data-channel-open]')) {
  button.addEventListener('click', () => openChannelDialog(button.dataset.channelOpen));
}
$('runtimeGrid').addEventListener('click', event => {
  const button = event.target.closest('[data-runtime-id]');
  if (button && !button.disabled) requestRuntimePlan(button.dataset.runtimeId);
});
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
