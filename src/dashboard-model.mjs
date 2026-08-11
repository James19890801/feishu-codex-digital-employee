const ISSUE_LABELS = {
  process_not_running: 'AIPRO 主进程已停止',
  poll_cursor_stale: '主消息轮询已停止推进',
  messages_processing_stale: '存在超时处理中消息',
  messages_failed: '存在待处理失败或死信',
  sqlite_integrity_failed: '状态数据库完整性异常',
  database_backup_stale: '状态数据库备份已过期或尚未生成',
  database_backup_error: '最近一次状态数据库备份失败',
  websocket_consumer_missing: 'WebSocket 辅助监听未连接',
  codex_proxy_unreachable: 'AI 运行时网络代理不可达',
  ai_runtime_unavailable: '所选 AI 编码运行时不可用',
  ai_runtime_last_call_failed: 'AI 运行时最近一次调用失败',
  credential_access_blocked: '后台进程无法读取飞书用户凭据',
  multica_sync_stale: 'Multica 全空间同步已停止推进',
  multica_sync_error: 'Multica 最近一次同步失败',
  multica_delivery_pending: 'Multica 变化通知正在等待重试',
  multica_delivery_dead: 'Multica 变化通知已进入死信，需要人工处理',
  a1_runtime_unavailable: 'A1 CLI 未安装或不可执行',
  a1_auth_unavailable: 'A1 身份认证不可用',
  a1_sync_stale: 'A1 工作项同步已停止推进',
  a1_sync_error: 'A1 最近一次同步失败',
  a1_delivery_pending: 'A1 变化通知正在等待重试',
  a1_delivery_dead: 'A1 变化通知已进入死信，需要人工处理',
  dingtalk_channel_unavailable: '钉钉通道已启用但未连接',
  wecom_channel_unavailable: '企业微信通道已启用但未连接',
  wechat_channel_unavailable: '个人微信通道已启用但未连接',
};

export function isCredentialAccessBlocked(lastPollError) {
  return /keychain access blocked/i.test(String(lastPollError?.error || ''));
}

export function buildOperatorView(input) {
  const pollAgeMs = Number.isFinite(input.pollCursorMs)
    ? Math.max(0, input.nowMs - input.pollCursorMs)
    : null;
  const issues = [];
  const feishuEnabled = input.feishuEnabled !== false;
  const multicaSyncAgeMs = input.multicaEnabled && input.lastMulticaSyncAt
    ? Math.max(0, input.nowMs - new Date(input.lastMulticaSyncAt).getTime())
    : null;
  const a1SyncAgeMs = input.a1Enabled && input.lastA1SyncAt
    ? Math.max(0, input.nowMs - new Date(input.lastA1SyncAt).getTime())
    : null;
  const backupAgeMs = input.backupRequired && input.lastBackupAt
    ? Math.max(0, input.nowMs - new Date(input.lastBackupAt).getTime())
    : null;
  if (!input.processAlive) issues.push('process_not_running');
  if (feishuEnabled && (pollAgeMs === null || pollAgeMs > input.maxPollAgeMs)) {
    issues.push('poll_cursor_stale');
  }
  if (input.staleProcessing > 0) issues.push('messages_processing_stale');
  if (input.overdueFailed > 0 || input.deadCount > 0) issues.push('messages_failed');
  if (input.sqliteIntegrity !== 'ok') issues.push('sqlite_integrity_failed');
  if (input.backupRequired
    && (backupAgeMs === null || !Number.isFinite(backupAgeMs)
      || backupAgeMs > input.maxBackupAgeMs)) {
    issues.push('database_backup_stale');
  }
  if (input.backupRequired && input.lastBackupError) issues.push('database_backup_error');
  if ((feishuEnabled || input.dingtalkChannel?.enabled) && !input.websocketActive) {
    issues.push('websocket_consumer_missing');
  }
  if (!input.codexProxyReachable) issues.push('codex_proxy_unreachable');
  if (input.aiRuntime && !input.aiRuntime.available) issues.push('ai_runtime_unavailable');
  if (input.lastAiRuntimeError?.at
    && (!input.lastAiRuntimeSuccessAt
      || input.lastAiRuntimeError.at > input.lastAiRuntimeSuccessAt)) {
    issues.push('ai_runtime_last_call_failed');
  }
  if (feishuEnabled && input.credentialBlocked) issues.push('credential_access_blocked');
  if (input.multicaEnabled
    && (multicaSyncAgeMs === null || !Number.isFinite(multicaSyncAgeMs)
      || multicaSyncAgeMs > input.maxMulticaSyncAgeMs)) {
    issues.push('multica_sync_stale');
  }
  if (input.multicaEnabled && input.lastMulticaSyncError) issues.push('multica_sync_error');
  if (input.multicaEnabled && Number(input.lastMulticaSyncResult?.pending || 0) > 0) {
    issues.push('multica_delivery_pending');
  }
  if (input.multicaEnabled && Number(input.multicaDeadCount || 0) > 0) {
    issues.push('multica_delivery_dead');
  }
  if (input.a1Enabled && !input.a1Installed) issues.push('a1_runtime_unavailable');
  if (input.a1Enabled && !input.a1Authenticated) issues.push('a1_auth_unavailable');
  if (input.a1Enabled
    && (a1SyncAgeMs === null || !Number.isFinite(a1SyncAgeMs)
      || a1SyncAgeMs > input.maxA1SyncAgeMs)) {
    issues.push('a1_sync_stale');
  }
  if (input.a1Enabled && input.lastA1SyncError) issues.push('a1_sync_error');
  if (input.a1Enabled && Number(input.lastA1SyncResult?.pending || 0) > 0) {
    issues.push('a1_delivery_pending');
  }
  if (input.a1Enabled && Number(input.a1DeadCount || 0) > 0) {
    issues.push('a1_delivery_dead');
  }
  const dingtalkChannel = input.dingtalkChannel || {};
  const wecomChannel = input.wecomChannel || {};
  const geweChannel = input.geweChannel || {};
  if (dingtalkChannel.enabled && !dingtalkChannel.connected) {
    issues.push('dingtalk_channel_unavailable');
  }
  if (wecomChannel.enabled && !wecomChannel.connected) {
    issues.push('wecom_channel_unavailable');
  }
  if (geweChannel.enabled && !geweChannel.connected) {
    issues.push('wechat_channel_unavailable');
  }

  const state = !input.processAlive ? 'offline' : issues.length ? 'degraded' : 'online';
  return {
    state,
    healthy: state === 'online',
    checkedAt: new Date(input.nowMs).toISOString(),
    issues,
    issueLabels: issues.map(issue => ISSUE_LABELS[issue] || issue),
    process: {
      alive: input.processAlive,
      pid: input.processPid || null,
      startedAt: input.processStartedAt || '',
    },
    polling: {
      healthy: !issues.includes('poll_cursor_stale'),
      cursorAt: Number.isFinite(input.pollCursorMs)
        ? new Date(input.pollCursorMs).toISOString()
        : '',
      ageMs: pollAgeMs,
      lastSuccessAt: input.lastPollSuccessAt || '',
      lastDurationMs: Number(input.lastPollDurationMs || 0),
      lastError: input.lastPollError || null,
    },
    websocket: {
      active: Boolean(input.websocketActive),
      activeConsumers: Number(input.activeConsumers || 0),
      lastReadyAt: input.lastWebsocketReadyAt || '',
    },
    channels: {
      feishu: {
        enabled: feishuEnabled,
        installed: feishuEnabled,
        configured: feishuEnabled,
        authenticated: feishuEnabled && !input.credentialBlocked,
        connected: feishuEnabled && Boolean(input.processAlive)
          && !issues.includes('poll_cursor_stale'),
        healthy: !feishuEnabled || (Boolean(input.processAlive)
          && !issues.includes('poll_cursor_stale')
          && !issues.includes('credential_access_blocked')),
        identityMode: 'user',
        transport: feishuEnabled ? 'polling + websocket' : 'disabled',
        lastReadyAt: input.lastPollSuccessAt || '',
        lastError: input.lastPollError || null,
      },
      dingtalk: {
        enabled: Boolean(dingtalkChannel.enabled),
        installed: Boolean(dingtalkChannel.installed),
        configured: Boolean(dingtalkChannel.configured ?? dingtalkChannel.installed),
        authenticated: Boolean(dingtalkChannel.authenticated),
        connected: Boolean(dingtalkChannel.connected),
        healthy: !dingtalkChannel.enabled || Boolean(dingtalkChannel.connected),
        identityMode: dingtalkChannel.identityMode || 'user',
        transport: dingtalkChannel.transport || 'websocket',
        lastReadyAt: dingtalkChannel.lastReadyAt || '',
        lastError: dingtalkChannel.lastError || null,
      },
      wecom: {
        enabled: Boolean(wecomChannel.enabled),
        installed: Boolean(wecomChannel.installed),
        configured: Boolean(wecomChannel.configured),
        authenticated: Boolean(wecomChannel.authenticated),
        connected: Boolean(wecomChannel.connected),
        healthy: !wecomChannel.enabled || Boolean(wecomChannel.connected),
        identityMode: wecomChannel.identityMode || 'bot',
        transport: wecomChannel.transport || 'websocket',
        lastReadyAt: wecomChannel.lastReadyAt || '',
        lastError: wecomChannel.lastError || null,
      },
      wechat: {
        enabled: Boolean(geweChannel.enabled),
        installed: Boolean(geweChannel.installed),
        configured: Boolean(geweChannel.configured),
        authenticated: Boolean(geweChannel.authenticated),
        connected: Boolean(geweChannel.connected),
        healthy: !geweChannel.enabled || Boolean(geweChannel.connected),
        identityMode: geweChannel.identityMode || 'personal-third-party',
        transport: geweChannel.transport || 'GeWe REST + public webhook',
        lastReadyAt: geweChannel.lastReadyAt || '',
        lastError: geweChannel.lastError || null,
        risk: 'third-party-unofficial-wechat-api',
      },
    },
    codex: {
      proxyReachable: Boolean(input.codexProxyReachable),
      model: input.codexModel || '',
    },
    aiRuntime: {
      configured: input.aiRuntime?.configured || 'auto',
      selected: input.aiRuntime?.selected || '',
      label: input.aiRuntime?.label || '',
      available: input.aiRuntime?.available !== false,
      healthy: input.aiRuntime?.available !== false
        && !issues.includes('codex_proxy_unreachable')
        && !issues.includes('ai_runtime_last_call_failed'),
      error: input.aiRuntime?.error || '',
      lastSuccessAt: input.lastAiRuntimeSuccessAt || '',
      lastError: input.lastAiRuntimeError || null,
      runtimes: Array.isArray(input.aiRuntime?.runtimes)
        ? structuredClone(input.aiRuntime.runtimes)
        : [],
    },
    multica: {
      enabled: Boolean(input.multicaEnabled),
      healthy: !input.multicaEnabled
        || (!issues.includes('multica_sync_stale')
          && !issues.includes('multica_sync_error')
          && !issues.includes('multica_delivery_pending')
          && !issues.includes('multica_delivery_dead')),
      lastSyncAt: input.lastMulticaSyncAt || '',
      ageMs: multicaSyncAgeMs,
      lastError: input.lastMulticaSyncError || null,
      scanned: Number(input.lastMulticaSyncResult?.scanned || 0),
      changes: Number(input.lastMulticaSyncResult?.changes || 0),
      notified: Number(input.lastMulticaSyncResult?.notified || 0),
      pending: Number(input.lastMulticaSyncResult?.pending || 0),
      failed: Number(input.lastMulticaSyncResult?.failed || 0),
      dead: Number(input.multicaDeadCount || 0),
    },
    a1: {
      enabled: Boolean(input.a1Enabled),
      installed: Boolean(input.a1Installed),
      authenticated: Boolean(input.a1Authenticated),
      healthy: !input.a1Enabled
        || (!issues.includes('a1_runtime_unavailable')
          && !issues.includes('a1_auth_unavailable')
          && !issues.includes('a1_sync_stale')
          && !issues.includes('a1_sync_error')
          && !issues.includes('a1_delivery_pending')
          && !issues.includes('a1_delivery_dead')),
      lastSyncAt: input.lastA1SyncAt || '',
      ageMs: a1SyncAgeMs,
      lastError: input.lastA1SyncError || null,
      scanned: Number(input.lastA1SyncResult?.scanned || 0),
      changes: Number(input.lastA1SyncResult?.changes || 0),
      notified: Number(input.lastA1SyncResult?.notified || 0),
      pending: Number(input.lastA1SyncResult?.pending || 0),
      failed: Number(input.lastA1SyncResult?.failed || 0),
      dead: Number(input.a1DeadCount || 0),
    },
    database: {
      healthy: input.sqliteIntegrity === 'ok'
        && !issues.includes('database_backup_stale')
        && !issues.includes('database_backup_error'),
      integrity: input.sqliteIntegrity || 'unknown',
      staleProcessing: Number(input.staleProcessing || 0),
      overdueFailed: Number(input.overdueFailed || 0),
      deadCount: Number(input.deadCount || 0),
      inboxCounts: input.inboxCounts || {},
      backupHealthy: !input.backupRequired
        || (!issues.includes('database_backup_stale')
          && !issues.includes('database_backup_error')),
      lastBackupAt: input.lastBackupAt || '',
      backupAgeMs,
      lastBackupError: input.lastBackupError || null,
    },
    recentEvents: Array.isArray(input.recentEvents) ? input.recentEvents : [],
    configuration: input.configuration || {},
    maintenance: {
      credentialBlocked: Boolean(input.credentialBlocked),
    },
  };
}
