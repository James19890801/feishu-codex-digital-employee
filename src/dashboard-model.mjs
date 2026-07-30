const ISSUE_LABELS = {
  process_not_running: 'AIPRO 主进程已停止',
  poll_cursor_stale: '主消息轮询已停止推进',
  messages_processing_stale: '存在超时处理中消息',
  messages_failed: '存在待处理失败或死信',
  sqlite_integrity_failed: '状态数据库完整性异常',
  websocket_consumer_missing: 'WebSocket 辅助监听未连接',
  codex_proxy_unreachable: 'Codex 网络代理不可达',
  credential_access_blocked: '后台进程无法读取飞书用户凭据',
  multica_sync_stale: 'Multica 全空间同步已停止推进',
  multica_sync_error: 'Multica 最近一次同步失败',
  multica_delivery_pending: 'Multica 变化通知正在等待重试',
};

export function isCredentialAccessBlocked(lastPollError) {
  return /keychain access blocked/i.test(String(lastPollError?.error || ''));
}

export function buildOperatorView(input) {
  const pollAgeMs = Number.isFinite(input.pollCursorMs)
    ? Math.max(0, input.nowMs - input.pollCursorMs)
    : null;
  const issues = [];
  const multicaSyncAgeMs = input.multicaEnabled && input.lastMulticaSyncAt
    ? Math.max(0, input.nowMs - new Date(input.lastMulticaSyncAt).getTime())
    : null;
  if (!input.processAlive) issues.push('process_not_running');
  if (pollAgeMs === null || pollAgeMs > input.maxPollAgeMs) issues.push('poll_cursor_stale');
  if (input.staleProcessing > 0) issues.push('messages_processing_stale');
  if (input.overdueFailed > 0 || input.deadCount > 0) issues.push('messages_failed');
  if (input.sqliteIntegrity !== 'ok') issues.push('sqlite_integrity_failed');
  if (!input.websocketActive) issues.push('websocket_consumer_missing');
  if (!input.codexProxyReachable) issues.push('codex_proxy_unreachable');
  if (input.credentialBlocked) issues.push('credential_access_blocked');
  if (input.multicaEnabled
    && (multicaSyncAgeMs === null || !Number.isFinite(multicaSyncAgeMs)
      || multicaSyncAgeMs > input.maxMulticaSyncAgeMs)) {
    issues.push('multica_sync_stale');
  }
  if (input.multicaEnabled && input.lastMulticaSyncError) issues.push('multica_sync_error');
  if (input.multicaEnabled && Number(input.lastMulticaSyncResult?.pending || 0) > 0) {
    issues.push('multica_delivery_pending');
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
    codex: {
      proxyReachable: Boolean(input.codexProxyReachable),
      model: input.codexModel || '',
    },
    multica: {
      enabled: Boolean(input.multicaEnabled),
      healthy: !input.multicaEnabled
        || (!issues.includes('multica_sync_stale')
          && !issues.includes('multica_sync_error')
          && !issues.includes('multica_delivery_pending')),
      lastSyncAt: input.lastMulticaSyncAt || '',
      ageMs: multicaSyncAgeMs,
      lastError: input.lastMulticaSyncError || null,
      scanned: Number(input.lastMulticaSyncResult?.scanned || 0),
      changes: Number(input.lastMulticaSyncResult?.changes || 0),
      notified: Number(input.lastMulticaSyncResult?.notified || 0),
      pending: Number(input.lastMulticaSyncResult?.pending || 0),
      failed: Number(input.lastMulticaSyncResult?.failed || 0),
    },
    database: {
      healthy: input.sqliteIntegrity === 'ok',
      integrity: input.sqliteIntegrity || 'unknown',
      staleProcessing: Number(input.staleProcessing || 0),
      overdueFailed: Number(input.overdueFailed || 0),
      deadCount: Number(input.deadCount || 0),
      inboxCounts: input.inboxCounts || {},
    },
    recentEvents: Array.isArray(input.recentEvents) ? input.recentEvents : [],
    configuration: input.configuration || {},
    maintenance: {
      credentialBlocked: Boolean(input.credentialBlocked),
    },
  };
}
