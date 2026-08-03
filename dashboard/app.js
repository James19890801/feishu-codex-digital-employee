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
  wechatPocRequestHeaders,
} from './config-ui.js';
import { normalizeLocale, translate } from './i18n.js';
import {
  canShowInviteStudio,
  invitationCsv,
  licensingRequestHeaders,
  normalizeInvitationCode,
} from './licensing-ui.js';

const $ = id => document.getElementById(id);
const stateLabelKeys = {
  online: { title: 'onlineTitle', kicker: 'onlineKicker', code: 'LIVE' },
  degraded: { title: 'degradedTitle', kicker: 'degradedKicker', code: 'WARN' },
  offline: { title: 'offlineTitle', kicker: 'offlineKicker', code: 'DOWN' },
  error: { title: 'errorTitle', kicker: 'errorKicker', code: 'ERR' },
};
const eventLabelKeys = {
  message_replied: 'eventMessageReplied',
  message_received: 'eventMessageReceived',
  inbound_enqueued: 'eventInboundEnqueued',
  inbound_retry_scheduled: 'eventRetryScheduled',
  inbound_failed_final: 'eventInboundFailed',
  inbound_dead_lettered: 'eventDeadLettered',
  poller_error: 'eventPollerError',
  websocket_error: 'eventWebsocketError',
  dingtalk_channel_error: 'eventDingtalkError',
  wecom_channel_error: 'eventWecomError',
  wechat_channel_error: 'eventWechatError',
  im_channel_connected: 'eventChannelConnected',
  im_channel_disconnected: 'eventChannelDisconnected',
  a1_sync_error: 'eventA1SyncError',
  a1_status_changed: 'eventA1Change',
  a1_status_notification_failed: 'eventA1NotifyFailed',
  a1_requirement_handled: 'eventA1Handled',
  a1_requirement_failed: 'eventA1Failed',
  sdk_client_unavailable: 'eventCredentialsMissing',
  message_rate_limited: 'eventRateLimited',
  maintenance_error: 'eventMaintenanceError',
};

const issueLabelKeys = {
  process_not_running: 'issueProcessStopped',
  poll_cursor_stale: 'issuePollingStale',
  messages_processing_stale: 'issueProcessingStale',
  messages_failed: 'issueMessagesFailed',
  sqlite_integrity_failed: 'issueSqliteIntegrity',
  database_backup_stale: 'issueBackupStale',
  database_backup_error: 'issueBackupError',
  websocket_consumer_missing: 'issueWebsocketMissing',
  codex_proxy_unreachable: 'issueProxyUnavailable',
  ai_runtime_unavailable: 'issueRuntimeUnavailable',
  ai_runtime_last_call_failed: 'issueRuntimeFailed',
  credential_access_blocked: 'issueCredentialBlocked',
  a1_sync_stale: 'issueA1Stale',
  a1_sync_error: 'issueA1Error',
  a1_delivery_pending: 'issueA1Pending',
  a1_delivery_dead: 'issueA1Dead',
  dingtalk_channel_unavailable: 'issueDingtalkUnavailable',
  wecom_channel_unavailable: 'issueWecomUnavailable',
  wechat_channel_unavailable: 'issueWechatUnavailable',
  self_chat_circuit_open: 'issueSelfChatCircuit',
};

const runtimeDescriptionKeys = {
  codex: 'runtimeCodexDescription',
  qoder: 'runtimeQoderDescription',
  codebuddy: 'runtimeCodebuddyDescription',
  trae: 'runtimeTraeDescription',
};

const channelCheckLabelKeys = {
  '主进程': 'checkCoreService',
  '用户消息轮询': 'checkUserPolling',
  'WebSocket 辅助监听': 'checkWebsocket',
  '通道开关': 'checkChannelSwitch',
  '本机运行时': 'checkLocalRuntime',
  '必要配置': 'checkRequiredConfig',
  '身份认证': 'checkAuthentication',
  '实时连接': 'checkLiveConnection',
};

function localizeChannelReportText(value) {
  const text = String(value || '');
  if (channelCheckLabelKeys[text]) return tr(channelCheckLabelKeys[text]);
  if (text === '当前未启用，不影响飞书主通道') return tr('channelOffSafe');
  if (text === '通道当前未启用') return tr('channelCurrentlyDisabled');
  return text;
}

let refreshTimer;
let lastFetchedAt = 0;
let configSessionToken = '';
let pendingConfigPlan = null;
let configBusy = false;
let latestRuntimeState = null;
let latestChannelConfigurations = {};
let latestChannelReport = null;
let selectedChannel = '';
let channelBusy = false;
let wechatPocBusy = false;
let locale = normalizeLocale(localStorage.getItem('aipro.locale'));
let latestStatusData = null;
let latestConfigPayload = null;
let licensingSessionToken = '';
let latestLicensingStatus = null;
let operationsStarted = false;
let activeInvitationCodes = [];

const channelCopyKeys = {
  feishu: {
    title: 'feishuPrimaryTitle',
    description: 'feishuPrimaryDescription',
  },
  dingtalk: {
    title: 'dingtalkTitle',
    description: 'dingtalkDescription',
  },
  wecom: {
    title: 'wecomTitle',
    description: 'wecomDescription',
  },
  wechat: {
    title: 'wechatTitle',
    description: 'wechatDescription',
  },
};

function tr(key, variables) {
  return translate(locale, key, variables);
}

function applyStaticTranslations() {
  document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  document.title = tr('pageTitle');
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = tr(element.dataset.i18n);
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.placeholder = tr(element.dataset.i18nPlaceholder);
  }
  for (const element of document.querySelectorAll('[data-i18n-aria]')) {
    element.setAttribute('aria-label', tr(element.dataset.i18nAria));
  }
  for (const element of document.querySelectorAll('[data-i18n-title]')) {
    element.title = tr(element.dataset.i18nTitle);
  }
  for (const element of document.querySelectorAll('[data-i18n-alt]')) {
    element.alt = tr(element.dataset.i18nAlt);
  }
  for (const element of document.querySelectorAll('[data-i18n-prompt]')) {
    element.dataset.configPrompt = tr(element.dataset.i18nPrompt);
  }
  $('languageCode').textContent = locale === 'zh' ? '中' : 'EN';
  if (latestLicensingStatus) {
    $('contactDeveloperLabel').textContent = tr(
      latestLicensingStatus.activated ? 'contactDeveloper' : 'getInvitation',
    );
  }
  if (latestStatusData) applyOperatorBrand(latestStatusData);
}

function applyOperatorBrand(data) {
  const brandName = String(data.operator?.brandName || '').trim();
  if (!brandName) return;
  const brand = document.querySelector('[data-i18n="brandName"]');
  if (brand) brand.textContent = brandName;
  document.title = locale === 'zh'
    ? `${brandName} · Codex 驱动`
    : `${brandName} · Powered by Codex`;
}

function setLocale(value, { persist = true } = {}) {
  locale = normalizeLocale(value);
  if (persist) localStorage.setItem('aipro.locale', locale);
  applyStaticTranslations();
  if (latestStatusData) render(latestStatusData);
  if (latestConfigPayload) {
    renderConfigurationOverview(latestConfigPayload);
    renderSnapshots(latestConfigPayload.snapshots);
  }
  if (selectedChannel && latestChannelConfigurations[selectedChannel]) {
    renderChannelLocale(selectedChannel, latestChannelConfigurations[selectedChannel]);
    if (latestChannelReport) renderChannelReport(latestChannelReport, { remember: false });
  } else if (latestRuntimeState) {
    renderRuntimeState(latestRuntimeState);
  }
  tick();
}

function formatAge(ms) {
  if (ms === null || !Number.isFinite(ms)) return tr('unknown');
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return tr('seconds', { value: (ms / 1000).toFixed(ms < 10_000 ? 1 : 0) });
  if (ms < 3_600_000) return tr('minutes', { value: Math.round(ms / 60_000) });
  return tr('hours', { value: (ms / 3_600_000).toFixed(1) });
}

function formatDate(value, timeOnly = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
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
  if (!channel?.enabled) {
    status.textContent = !channel?.installed
      ? tr('notInstalled')
      : channel?.configured ? tr('installedDisabled') : tr('installedNeedsSetup');
    meta.textContent = fallbackMeta;
    dot.className = '';
    return;
  }
  if (channel.connected) {
    status.textContent = tr('online');
    meta.textContent = `${fallbackMeta} · ${formatDate(channel.lastReadyAt, true)}`;
    dot.className = 'good';
    return;
  }
  status.textContent = channel.authenticated ? tr('reconnecting') : tr('authenticationRequired');
  meta.textContent = channel.lastError?.error
    ? String(channel.lastError.error).slice(0, 120)
    : fallbackMeta;
  dot.className = channel.authenticated ? 'warn' : 'bad';
}

function renderWeChatPoc(channel) {
  if (!channel) return;
  const labels = {
    not_installed: tr('serviceNotInstalled'),
    offline: tr('serviceOffline'),
    disabled: tr('disabled'),
    starting: tr('starting'),
    online: tr('running'),
    degraded: tr('pendingWork'),
    uncertain: tr('deliveryUncertain'),
  };
  $('wechatPocStatus').textContent = labels[channel.state] || tr('checking');
  $('wechatPocToggle').checked = channel.control?.enabled === true;
  $('wechatPocToggle').disabled = wechatPocBusy || !channel.processAlive;
  $('wechatPocOpenClient').disabled = wechatPocBusy;
  $('wechatPocEmergencyStop').disabled = wechatPocBusy || !channel.processAlive;
  const dot = $('wechatPocDot');
  dot.className = channel.state === 'online'
    ? 'good'
    : ['degraded', 'starting', 'uncertain'].includes(channel.state) ? 'warn' : channel.state === 'offline' ? 'bad' : '';
  const permission = channel.permissionState === 'granted'
    ? tr('accessibilityGranted')
    : channel.permissionState === 'missing' ? tr('accessibilityRequired') : tr('permissionPending');
  $('wechatPocMeta').textContent = `${channel.clientRunning ? tr('wechatOpen') : tr('wechatClosed')} · ${permission} · ${tr('pendingCount', { count: channel.pending || 0 })}`;
  $('wechatPocDetail').textContent = channel.lastError?.error
    ? tr('recentError', { value: String(channel.lastError.error).slice(0, 130) })
    : tr('recentActions', {
      action: channel.lastAction || tr('waiting'),
      received: formatDate(channel.lastReceiveAt, true),
      replied: formatDate(channel.lastReplyAt, true),
    });
}

function renderEvents(events) {
  if (!events?.length) {
    $('timeline').innerHTML = `<p class="empty">${escapeHtml(tr('noAuditEvents'))}</p>`;
    return;
  }
  $('timeline').innerHTML = events.map(item => {
    const error = /error|failed|dead|unavailable/.test(item.event);
    const success = /replied|created|resumed|ready/.test(item.event);
    const detail = item.detail?.error
      ? String(item.detail.error).slice(0, 180)
      : Object.keys(item.detail || {}).length ? JSON.stringify(item.detail) : tr('routineRecord');
    return `
      <div class="event ${error ? 'error' : success ? 'success' : ''}">
        <i class="event-dot"></i>
        <span class="event-name">${escapeHtml(eventLabelKeys[item.event] ? tr(eventLabelKeys[item.event]) : item.event)}</span>
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
  latestStatusData = data;
  applyOperatorBrand(data);
  const visual = stateLabelKeys[data.state] || stateLabelKeys.error;
  $('hero').dataset.state = data.state;
  $('statusTitle').textContent = tr(visual.title);
  $('statusKicker').textContent = tr(visual.kicker);
  $('statusCode').textContent = visual.code;
  $('statusSummary').textContent = data.state === 'online'
    ? tr('onlineSummary')
    : (data.issues?.[0] && issueLabelKeys[data.issues[0]]
      ? tr(issueLabelKeys[data.issues[0]])
      : data.issueLabels?.[0] || tr('degradedSummary'));
  $('lastCheck').textContent = formatDate(data.checkedAt, true);

  $('issueStrip').classList.toggle('hidden', !data.issueLabels?.length);
  $('issueList').innerHTML = (data.issues || []).map((issue, index) => {
    const label = issueLabelKeys[issue] ? tr(issueLabelKeys[issue]) : data.issueLabels?.[index] || issue;
    return `<span>${escapeHtml(label)}</span>`;
  }).join('');

  renderChannel(
    'Feishu',
    data.channels?.feishu,
    tr('feishuMeta'),
  );
  renderChannel(
    'Dingtalk',
    data.channels?.dingtalk,
    tr('dingtalkMeta'),
  );
  renderChannel(
    'Wecom',
    data.channels?.wecom,
    tr('wecomMeta'),
  );
  renderChannel(
    'Wechat',
    data.channels?.wechat,
    tr('wechatLegacyMeta'),
  );
  $('channelFeishuRole').textContent = tr(data.primaryChannel === 'feishu'
    ? 'primaryRole'
    : data.channels?.feishu?.enabled ? 'optionalRole' : 'disabledRole');
  $('channelDingtalkRole').textContent = tr(data.primaryChannel === 'dingtalk'
    ? 'primaryRole'
    : data.channels?.dingtalk?.enabled ? 'optionalRole' : 'disabledRole');
  renderWeChatPoc(data.wechatPoc || data.channels?.wechatPoc);

  $('processValue').textContent = data.process.alive ? tr('processRunning') : tr('processStopped');
  $('processMeta').textContent = data.process.alive
    ? tr('processStarted', { pid: data.process.pid, time: formatDate(data.process.startedAt) })
    : tr('dashboardStillOnline');
  setDot('processDot', data.process.alive);

  $('pollingValue').textContent = !data.polling.applicable
    ? tr('disabled')
    : data.polling.healthy ? formatAge(data.polling.ageMs) : tr('pollingStalled');
  $('pollingMeta').textContent = !data.polling.applicable
    ? tr('notEnabled')
    : data.polling.healthy
    ? tr('cycleDuration', { value: formatAge(data.polling.lastDurationMs) })
    : (data.polling.lastError?.error || tr('pollingNotAdvancing'));
  setDot('pollingDot', !data.polling.applicable || data.polling.healthy);

  $('websocketValue').textContent = data.websocket.active
    ? tr('consumers', { count: data.websocket.activeConsumers }) : tr('disconnected');
  $('websocketMeta').textContent = tr('lastReady', { time: formatDate(data.websocket.lastReadyAt) });
  setDot('websocketDot', data.websocket.active);

  renderRuntimeState(data.aiRuntime);

  $('a1Value').textContent = !data.a1.enabled
    ? tr('notEnabled')
    : data.a1.healthy ? tr('syncOnline') : tr('degradedTitle');
  $('a1Meta').textContent = data.a1.enabled
    ? tr('lastSync', { age: formatAge(data.a1.ageMs), count: data.a1.scanned || 0 })
      + (data.a1.pending ? tr('pendingDelivery', { count: data.a1.pending }) : '')
      + (data.a1.dead ? tr('deadLetters', { count: data.a1.dead }) : '')
    : tr('enableInConfig');
  setDot('a1Dot', data.a1.enabled && data.a1.healthy);

  const counts = data.database.inboxCounts || {};
  $('completedCount').textContent = counts.completed || 0;
  $('processingCount').textContent = counts.processing || 0;
  $('failedCount').textContent = (counts.failed || 0) + (counts.dead || 0);
  $('dbIntegrity').textContent = data.database.integrity === 'ok'
    ? `OK · ${formatAge(data.database.backupAgeMs)}`
    : tr('abnormal');
  setDot('databaseDot', data.database.healthy);

  $('credentialGuide').classList.toggle('hidden', !data.maintenance?.credentialBlocked);
  renderEvents(data.recentEvents);
  lastFetchedAt = Date.now();
  tick();
}

function runtimeCard(runtime, selectedId, configured) {
  const card = document.createElement('article');
  const selected = runtime.id === selectedId;
  card.className = `runtime-card ${runtime.available ? 'available' : 'unavailable'}${selected ? ' selected' : ''}`;
  if (selected) card.setAttribute('aria-current', 'true');

  const header = document.createElement('header');
  const dot = document.createElement('i');
  const title = document.createElement('h4');
  title.textContent = runtime.label;
  header.append(dot, title);

  const status = document.createElement('b');
  status.textContent = runtimeStatusLabel(runtime, locale).toUpperCase();
  const description = document.createElement('p');
  const localizedDescription = runtimeDescriptionKeys[runtime.id]
    ? tr(runtimeDescriptionKeys[runtime.id])
    : runtime.description || '';
  const localizedReason = runtime.reason
    ? !runtime.installed
      ? tr('notInstalled')
      : runtime.id === 'trae' ? tr('runtimeTraeReason') : runtime.reason
    : '';
  description.textContent = localizedReason || localizedDescription;
  card.append(header, status, description);
  if (!selected) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.runtimeId = runtime.id;
    button.textContent = runtime.available ? tr('selectRuntime') : runtimeStatusLabel(runtime, locale);
    button.disabled = !runtimeCanSelect(runtime, configured);
    card.append(button);
  }
  return card;
}

function renderRuntimeState(state) {
  if (!state) return;
  latestRuntimeState = state;
  const grid = $('runtimeGrid');
  grid.replaceChildren();
  const selectedId = String(state.selected || '').toLowerCase();
  for (const runtime of state.runtimes || []) {
    grid.append(runtimeCard(runtime, selectedId, state.configured));
  }
}

function renderError() {
  $('hero').dataset.state = 'error';
  $('statusTitle').textContent = tr(stateLabelKeys.error.title);
  $('statusKicker').textContent = tr(stateLabelKeys.error.kicker);
  $('statusCode').textContent = stateLabelKeys.error.code;
  $('statusSummary').textContent = tr('dashboardApiError');
}

function renderLicensingStatus(status) {
  latestLicensingStatus = status;
  licensingSessionToken = status.sessionToken || licensingSessionToken;
  const activated = status.activated === true;
  $('activationGate').classList.toggle('hidden', activated);
  $('operationsConsole').classList.toggle('hidden', !activated);
  $('inviteStudio').classList.toggle('hidden', !canShowInviteStudio(status));
  $('contactDeveloperLabel').textContent = tr(activated ? 'contactDeveloper' : 'getInvitation');
  if (activated && !operationsStarted) startOperationsConsole();
}

async function loadLicensingStatus() {
  try {
    const response = await fetch('/api/licensing/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const status = await response.json();
    renderLicensingStatus(status);
    return status;
  } catch (error) {
    $('activationGate').classList.remove('hidden');
    $('operationsConsole').classList.add('hidden');
    $('activationMessage').textContent = `${tr('activationFailed')} ${error.message}`;
    return null;
  }
}

function startOperationsConsole() {
  if (operationsStarted) return;
  operationsStarted = true;
  refresh();
  loadConfigurationAssistant();
  refreshTimer = setInterval(refresh, 5000);
}

async function activateAipro(event) {
  event.preventDefault();
  const code = normalizeInvitationCode($('activationCode').value);
  if (code.length !== 10) {
    $('activationMessage').textContent = tr('activationFailed');
    $('activationCode').focus();
    return;
  }
  $('activationSubmit').disabled = true;
  $('activationMessage').textContent = tr('activating');
  try {
    const status = await responseJson(await fetch('/api/licensing/activate', {
      method: 'POST',
      headers: licensingRequestHeaders('licensing-activate', licensingSessionToken),
      body: JSON.stringify({ code }),
    }));
    $('activationMessage').textContent = tr('activationComplete');
    $('activationCode').value = '';
    renderLicensingStatus({ ...status, sessionToken: licensingSessionToken });
    setTimeout(refresh, 1800);
  } catch {
    $('activationMessage').textContent = tr('activationFailed');
  } finally {
    $('activationSubmit').disabled = false;
  }
}

function renderInvitationBatch(batch) {
  activeInvitationCodes = [...batch.codes];
  $('invitationBatchId').textContent = batch.id || '—';
  $('invitationCodes').replaceChildren(...activeInvitationCodes.map(code => {
    const item = document.createElement('li');
    item.textContent = code;
    return item;
  }));
  $('copyInvitesButton').disabled = false;
  $('downloadInvitesButton').disabled = false;
}

async function generateInvitations() {
  if (!latestLicensingStatus?.issuer?.authorized) return;
  $('generateInvitesButton').disabled = true;
  $('inviteStudioMessage').textContent = tr('generatingInvites');
  try {
    const payload = await responseJson(await fetch('/api/licensing/invites', {
      method: 'POST',
      headers: licensingRequestHeaders('licensing-generate', licensingSessionToken),
      body: JSON.stringify({ customerNote: $('invitationNote').value.trim() }),
    }));
    renderInvitationBatch(payload.batch);
    $('inviteStudioMessage').textContent = tr('invitationsReady');
  } catch {
    $('inviteStudioMessage').textContent = tr('invitationGenerationFailed');
  } finally {
    $('generateInvitesButton').disabled = false;
  }
}

async function copyInvitations() {
  if (!activeInvitationCodes.length) return;
  await navigator.clipboard.writeText(activeInvitationCodes.join('\n'));
  showToast(tr('copied'));
}

function downloadInvitations() {
  if (!activeInvitationCodes.length) return;
  const blob = new Blob([invitationCsv(activeInvitationCodes)], { type: 'text/csv;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `aipro-invitations-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function loadContactCard({ force = false } = {}) {
  const image = $('contactCardImage');
  if (image.src && !force && !image.classList.contains('hidden')) return;
  $('contactCardLoading').classList.remove('hidden');
  $('contactCardError').classList.add('hidden');
  image.classList.add('hidden');
  image.onload = () => {
    $('contactCardLoading').classList.add('hidden');
    $('contactCardError').classList.add('hidden');
    image.classList.remove('hidden');
  };
  image.onerror = () => {
    $('contactCardLoading').classList.add('hidden');
    $('contactCardError').classList.remove('hidden');
    image.classList.add('hidden');
  };
  image.src = `/api/licensing/contact-card${force ? `?retry=${Date.now()}` : ''}`;
}

function openContactDialog() {
  $('contactDialog').showModal();
  loadContactCard();
}

async function refresh() {
  $('refreshButton').disabled = true;
  try {
    const response = await fetch('/api/status', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    render(await response.json());
  } catch (error) {
    renderError();
    showToast(`${tr('errorTitle')}: ${error.message}`);
  } finally {
    $('refreshButton').disabled = false;
  }
}

async function restart() {
  if (!window.confirm(locale === 'zh'
    ? '确认重启数字人主进程？面板不会关闭。'
    : 'Restart the digital-human core service? This dashboard will remain open.')) return;
  $('restartButton').disabled = true;
  try {
    const response = await fetch('/api/restart', {
      method: 'POST',
      headers: { 'X-Dashboard-Action': 'restart' },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    showToast(locale === 'zh'
      ? '重启指令已发送，正在等待主进程恢复。'
      : 'Restart requested. Waiting for the core service to recover.');
    setTimeout(refresh, 2500);
  } catch (error) {
    showToast(`${locale === 'zh' ? '重启失败' : 'Restart failed'}: ${error.message}`);
  } finally {
    setTimeout(() => { $('restartButton').disabled = false; }, 2500);
  }
}

async function ensureDashboardSession() {
  if (!configSessionToken) await loadConfigurationAssistant();
  if (!configSessionToken) throw new Error(locale === 'zh'
    ? '控制会话尚未就绪，请刷新页面'
    : 'The control session is not ready. Refresh the page.');
}

async function postWeChatPoc(path, action, body = {}) {
  await ensureDashboardSession();
  wechatPocBusy = true;
  for (const id of ['wechatPocToggle', 'wechatPocOpenClient', 'wechatPocEmergencyStop']) $(id).disabled = true;
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: wechatPocRequestHeaders(action, configSessionToken),
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || `HTTP ${response.status}`);
    showToast(payload.message || (locale === 'zh' ? '个人微信操作已完成' : 'Personal WeChat action completed.'));
  } finally {
    wechatPocBusy = false;
    await refresh();
  }
}

async function toggleWeChatPoc(event) {
  const enabled = event.target.checked;
  if (enabled && !window.confirm(locale === 'zh'
    ? '确认恢复个人微信自动回复？单聊全部回复，群聊仅明确 @，仅处理文本。启用状态会跨重启保留，可随时紧急停止。'
    : 'Enable personal WeChat auto-reply? Direct chats are answered; group chats require an explicit @ mention; text only. The switch persists across restarts and can be stopped at any time.')) {
    event.target.checked = false;
    return;
  }
  try {
    await postWeChatPoc('/api/wechat-poc/control', 'wechat-poc-control', { enabled, confirmed: true });
  } catch (error) {
    showToast(`${locale === 'zh' ? '个人微信切换失败' : 'Personal WeChat switch failed'}: ${error.message}`);
    event.target.checked = !enabled;
  }
}

async function emergencyStopWeChatPoc() {
  if (!window.confirm(locale === 'zh'
    ? '立即关闭个人微信自动回复并取消待发送任务？'
    : 'Stop personal WeChat auto-reply and cancel pending sends now?')) return;
  try {
    await postWeChatPoc('/api/wechat-poc/emergency-stop', 'wechat-poc-stop');
  } catch (error) {
    showToast(`${locale === 'zh' ? '紧急停止失败' : 'Emergency stop failed'}: ${error.message}`);
  }
}

async function openWeChatClient() {
  try {
    await postWeChatPoc('/api/wechat-poc/open-client', 'wechat-poc-open');
  } catch (error) {
    showToast(`${locale === 'zh' ? '微信打开失败' : 'Could not open WeChat'}: ${error.message}`);
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
  latestConfigPayload = payload;
  const configuration = payload.configuration || {};
  $('configScope').textContent = configuration.allowAllChats
    ? tr('allChats')
    : tr('selectedChats', { count: configuration.authorizedChatIds?.length || 0 });
  $('configPoll').textContent = Number.isFinite(configuration.pollIntervalMs)
    ? `${(configuration.pollIntervalMs / 1000).toFixed(
      configuration.pollIntervalMs % 1000 ? 1 : 0,
    )}${locale === 'zh' ? ' 秒' : 's'}`
    : '—';
  $('configProfile').textContent =
    tr('characters', { count: `${payload.profile?.personaCharacters || 0} + ${payload.profile?.bibleCharacters || 0}` });
  $('configKnowledge').textContent = tr('documents', { count: payload.profile?.knowledgeDocuments || 0 });
  $('configConnection').textContent = tr('safeModeConnected');
  if (payload.aiRuntime) renderRuntimeState(payload.aiRuntime);
}

function renderSnapshots(snapshots) {
  const history = $('configHistory');
  history.replaceChildren();
  if (!snapshots?.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = tr('noBackups');
    history.append(empty);
    return;
  }
  for (const snapshot of snapshots) {
    const row = document.createElement('div');
    row.className = 'snapshot';

    const detail = document.createElement('div');
    const summary = document.createElement('strong');
    const originalSummary = String(snapshot.summary || '');
    if (locale === 'en' && /[\u3400-\u9fff]/.test(originalSummary)) {
      const runtime = originalSummary.match(/切换 AI 运行时为\s*([^（\n]+)/)?.[1]?.trim();
      const seconds = originalSummary.match(/(?:调整为|从\s*\d+\s*秒调整为)\s*(\d+)\s*秒/)?.[1];
      summary.textContent = /自动选择/.test(originalSummary)
        ? tr('beforeRuntimeAuto')
        : runtime ? tr('beforeRuntime', { runtime })
          : seconds ? tr('beforePolling', { seconds })
            : /沟通风格|表达习惯|简短/.test(originalSummary)
              ? tr('beforePersona') : tr('beforeConfigurationChange');
      summary.title = originalSummary;
    } else {
      summary.textContent = originalSummary || tr('configurationBackup');
    }
    const meta = document.createElement('small');
    const time = document.createElement('time');
    time.textContent = `${formatDate(snapshot.createdAt)} · ${snapshot.id}`;
    meta.append(time);
    detail.append(summary, meta);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'button';
    button.textContent = tr('rollback');
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
    $('configConnection').textContent = tr('configChannelError');
    appendConfigMessage('system', `${locale === 'zh' ? '无法读取当前配置' : 'Could not read the current configuration'}: ${error.message}`);
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

function renderChannelReport(report, { remember = true } = {}) {
  if (remember) latestChannelReport = report;
  const validation = $('channelValidation');
  validation.dataset.state = report?.state || '';
  $('channelValidationState').textContent = report?.state === 'connected'
    ? tr('connectedAllPassed')
    : report?.state === 'disabled'
      ? tr('channelDisabled')
      : report?.state === 'failed' ? tr('failed') : tr('notTested');
  const checks = $('channelValidationChecks');
  checks.replaceChildren();
  if (!report?.checks?.length) {
    const empty = document.createElement('p');
    empty.textContent = tr('testHint');
    checks.append(empty);
    return;
  }
  for (const item of report.checks) {
    const row = document.createElement('div');
    row.className = `channel-check${item.passed ? ' passed' : ''}`;
    const dot = document.createElement('i');
    const label = document.createElement('span');
    label.textContent = localizeChannelReportText(item.label);
    const detail = document.createElement('small');
    detail.textContent = item.detail
      ? localizeChannelReportText(item.detail)
      : item.passed ? tr('passed') : tr('failed');
    row.append(dot, label, detail);
    checks.append(row);
  }
  if (report.detail) {
    const detail = document.createElement('p');
    detail.textContent = tr('latestError', { value: localizeChannelReportText(report.detail) });
    checks.append(detail);
  }
}

function renderChannelLocale(channel, configuration) {
  const copy = channelCopyKeys[channel];
  $('channelDialogTitle').textContent = copy?.title ? tr(copy.title) : tr('channelDialogTitle');
  $('channelDialogDescription').textContent = copy?.description ? tr(copy.description) : '';
  $('channelWecomCredentialState').textContent = configuration.credentialStored
    ? tr('keychainStored') : tr('credentialMissing');
  $('channelWechatCredentialState').textContent = configuration.credentialStored
    ? tr('keychainStored') : tr('credentialMissing');
  $('channelSaveButton').textContent = channelSubmitLabel(configuration, locale);
}

function renderChannelForm(channel, configuration) {
  selectedChannel = channel;
  renderChannelLocale(channel, configuration);
  $('channelEnabledRow').classList.toggle('hidden', configuration.protected === true);
  $('channelEnabled').checked = configuration.enabled === true;
  $('channelFeishuIdentity').value = configuration.identity || '';
  $('channelDingtalkProfile').value = configuration.profile || '';
  $('channelWecomBotId').value = configuration.botId || '';
  $('channelWecomCredential').value = '';
  $('channelWechatAppId').value = configuration.appId || '';
  $('channelWechatCredential').value = '';
  $('channelWechatCallback').value = configuration.publicCallbackBaseUrl || '';
  $('channelWechatMentions').value = (configuration.mentionNames || []).join(', ');
  for (const section of document.querySelectorAll('[data-channel-fields]')) {
    section.classList.toggle('hidden', section.dataset.channelFields !== channel);
  }
  renderChannelReport(null);
  setChannelBusy(false);
}

async function openChannelDialog(channel) {
  const payload = await loadConfigurationAssistant();
  const configuration = payload?.channels?.[channel];
  if (!configuration) {
    showToast(locale === 'zh' ? '无法读取这个通道的配置。' : 'Could not read this channel configuration.');
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
  $('channelValidationState').textContent = tr('testRunning');
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
      checks: [{ label: tr('testApi'), passed: false, detail: error.message }],
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
    showToast(tr('enterCredential'));
    $(selectedChannel === 'wecom' ? 'channelWecomCredential' : 'channelWechatCredential').focus();
    return;
  }
  if (!window.confirm(tr('saveChannelConfirm'))) return;
  setChannelBusy(true);
  $('channelValidationState').textContent = tr('savingTesting');
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
      ? tr('configSavedDisabled') : tr('configSavedConnected'));
    await Promise.all([loadConfigurationAssistant(), refresh()]);
    renderChannelForm(selectedChannel, latestChannelConfigurations[selectedChannel]);
    renderChannelReport(payload.report);
  } catch (error) {
    renderChannelReport({
      state: 'failed',
      detail: error.message,
      checks: [{
        label: error.rolledBack ? tr('connectionAcceptanceRollback') : tr('configurationSave'),
        passed: false,
        detail: error.message,
      }],
    });
    showToast(error.rolledBack
      ? tr('connectionRollback')
      : `${locale === 'zh' ? '配置失败' : 'Configuration failed'}: ${error.message}`);
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } finally {
    setChannelBusy(false);
  }
}

function riskLabel(plan) {
  if (!planCanApply(plan)) return [tr('noChanges'), ''];
  if (plan.confirmationLevel === 'double') return [tr('sensitiveRisk'), 'double'];
  return [tr('standardRisk'), 'single'];
}

function renderConfigPlan(plan) {
  pendingConfigPlan = plan;
  const canApply = planCanApply(plan);
  $('planEmpty').classList.toggle('hidden', canApply);
  $('planCard').classList.toggle('hidden', !canApply);
  const [label, className] = riskLabel(plan);
  $('planRisk').textContent = label;
  $('planRisk').className = className;
  $('planSummary').textContent = plan.summary || tr('configRecommendation');
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
      [tr('before'), change.before, 'before'],
      [tr('after'), change.after, 'after'],
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
  $('planRisk').textContent = tr('waitingForRequest');
  $('planRisk').className = '';
  $('planChanges').replaceChildren();
  $('confirmationInput').value = '';
}

async function submitConfigRequest(event) {
  event.preventDefault();
  if (configBusy) return;
  const message = $('configInput').value.trim();
  if (!message) {
    showToast(tr('describeChange'));
    return;
  }
  await loadConfigurationAssistant();
  if (!configSessionToken) return;
  clearConfigPlan();
  appendConfigMessage('user', message);
  $('configInput').value = '';
  const loading = appendConfigMessage('assistant', tr('generatingPlan'), {
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
        ? tr('planReady')
        : tr('noPlanChanges')),
    );
    renderConfigPlan(plan);
  } catch (error) {
    loading.remove();
    appendConfigMessage('system', `${locale === 'zh' ? '方案生成失败' : 'Plan generation failed'}: ${error.message}`);
  } finally {
    setConfigBusy(false);
  }
}

async function requestRuntimePlan(runtimeId) {
  if (configBusy) return;
  await loadConfigurationAssistant();
  if (!configSessionToken) return;
  const runtime = runtimeId === 'auto'
    ? { label: tr('autoSelect') }
    : latestRuntimeState?.runtimes?.find(item => item.id === runtimeId);
  if (!runtime || (runtimeId !== 'auto' && !runtime.available)) {
    showToast(tr('runtimeUnavailable'));
    return;
  }
  clearConfigPlan();
  appendConfigMessage('user', tr('switchRuntime', { runtime: runtime.label }));
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
    appendConfigMessage('system', `${locale === 'zh' ? '无法生成运行时切换方案' : 'Could not generate a runtime change plan'}: ${error.message}`);
  } finally {
    setConfigBusy(false);
  }
}

async function applyConfigPlan() {
  if (configBusy || !planCanApply(pendingConfigPlan)) return;
  const confirmationCode = $('confirmationInput').value.trim();
  if (pendingConfigPlan.confirmationLevel === 'double'
    && confirmationCode !== pendingConfigPlan.confirmationCode) {
    showToast(tr('confirmationCodeRequired'));
    $('confirmationInput').focus();
    return;
  }
  setConfigBusy(true);
  appendConfigMessage('system', tr('applyingPlan'));
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
      tr('planApplied', {
        state: payload.state || tr('normal'),
        snapshot: payload.snapshot?.id || '—',
      }),
    );
    clearConfigPlan();
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } catch (error) {
    appendConfigMessage(
      'system',
      error.rolledBack
        ? `${locale === 'zh' ? '应用失败，但系统已经自动恢复到修改前' : 'Apply failed; the previous configuration was restored'}: ${error.message}`
        : `${locale === 'zh' ? '应用失败' : 'Apply failed'}: ${error.message}`,
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
  appendConfigMessage('system', tr('planDiscarded'));
}

async function rollbackSnapshot(snapshotId) {
  if (configBusy) return;
  if (!window.confirm(tr('rollbackConfirm', { snapshot: snapshotId }))) return;
  setConfigBusy(true);
  appendConfigMessage('system', tr('rollbackRunning', { snapshot: snapshotId }));
  try {
    const payload = await responseJson(await fetch('/api/config/rollback', {
      method: 'POST',
      headers: assistantRequestHeaders('config-rollback', configSessionToken),
      body: JSON.stringify({
        snapshotId,
        confirmation: rollbackConfirmation(snapshotId),
      }),
    }));
    appendConfigMessage('assistant', tr('rollbackComplete', { state: payload.state || tr('normal') }));
    clearConfigPlan();
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } catch (error) {
    appendConfigMessage('system', `${locale === 'zh' ? '回滚失败' : 'Rollback failed'}: ${error.message}`);
    await Promise.all([loadConfigurationAssistant(), refresh()]);
  } finally {
    setConfigBusy(false);
  }
}

function tick() {
  $('clock').textContent = new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    timeZone: 'Asia/Shanghai',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).format(new Date());
  $('refreshAge').textContent = lastFetchedAt
    ? tr('ago', { seconds: Math.max(0, Math.floor((Date.now() - lastFetchedAt) / 1000)) })
    : tr('connecting');
}

$('languageToggle').addEventListener('click', () => setLocale(locale === 'en' ? 'zh' : 'en'));
$('contactDeveloperButton').addEventListener('click', openContactDialog);
$('contactDialogClose').addEventListener('click', () => $('contactDialog').close());
$('contactCardRetry').addEventListener('click', () => loadContactCard({ force: true }));
$('activationForm').addEventListener('submit', activateAipro);
$('activationCode').addEventListener('input', event => {
  const normalized = normalizeInvitationCode(event.target.value);
  if (normalized || event.target.value === '') event.target.value = normalized;
});
$('generateInvitesButton').addEventListener('click', generateInvitations);
$('copyInvitesButton').addEventListener('click', () => {
  copyInvitations().catch(() => showToast(tr('invitationGenerationFailed')));
});
$('downloadInvitesButton').addEventListener('click', downloadInvitations);
$('refreshButton').addEventListener('click', refresh);
$('restartButton').addEventListener('click', restart);
$('wechatPocToggle').addEventListener('change', toggleWeChatPoc);
$('wechatPocEmergencyStop').addEventListener('click', emergencyStopWeChatPoc);
$('wechatPocOpenClient').addEventListener('click', openWeChatClient);
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
  }, locale);
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
window.addEventListener('beforeunload', () => {
  if (refreshTimer) clearInterval(refreshTimer);
});
setLocale(locale, { persist: false });
loadLicensingStatus();
