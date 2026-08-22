import { isMulticaSyncStale } from './reliability.mjs';

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
  dingtalk_channel_unavailable: '钉钉通道已启用但未连接',
  wecom_channel_unavailable: '企业微信通道已启用但未连接',
  wechat_channel_unavailable: '个人微信通道已启用但未连接',
  wechat_reliability_state_stale: '个人微信端到端健康状态缺失或已过期',
  wechat_local_callback_unavailable: '个人微信本地回调不可用',
  wechat_tunnel_unavailable: '个人微信公网隧道不可用',
  wechat_public_callback_unavailable: '个人微信公网回调不可达',
  wechat_provider_unavailable: '个人微信第三方接口或账号不可用',
  wechat_callback_registration_stale: '个人微信回调注册未对齐',
  wechat_recovery_circuit_open: '个人微信自动恢复已熔断',
  self_chat_circuit_open: '自聊防循环熔断器已开启，当前正在静默冷却',
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
  const dingtalkChannel = input.dingtalkChannel || {};
  const wecomChannel = input.wecomChannel || {};
  const geweChannel = input.geweChannel || {};
  const wechatReliability = input.wechatReliability || null;
  const reliabilityCheckedAtMs = Number(wechatReliability?.checkedAtMs);
  const reliabilityMaxAgeMs = Math.max(
    30_000,
    Number(input.wechatReliabilityIntervalMs || 15_000) * 3,
  );
  const reliabilityFresh = Boolean(wechatReliability)
    && Number.isFinite(reliabilityCheckedAtMs)
    && input.nowMs >= reliabilityCheckedAtMs
    && input.nowMs - reliabilityCheckedAtMs <= reliabilityMaxAgeMs;
  const reliabilityLayers = reliabilityFresh ? wechatReliability.layers || {} : {};
  const wechatIngress = {
    localListening: reliabilityLayers.local_service?.ok === true,
    tunnelReady: reliabilityLayers.tunnel?.ok === true,
    activeConnections: Math.max(0, Number(reliabilityLayers.tunnel?.activeConnections || 0)),
    publicReachable: reliabilityLayers.public_callback?.ok === true,
    callbackRegistered: reliabilityLayers.callback_registration?.ok === true,
    providerOnline: reliabilityLayers.provider?.ok === true,
  };
  const wechatIngressHealthy = reliabilityFresh
    && Object.entries(wechatIngress).every(([name, value]) => (
      name === 'activeConnections' ? value > 0 : value === true
    ))
    && wechatReliability.state === 'healthy';
  const multicaSyncAgeMs = input.multicaEnabled && input.lastMulticaSyncAt
    ? Math.max(0, input.nowMs - new Date(input.lastMulticaSyncAt).getTime())
    : null;
  const backupAgeMs = input.backupRequired && input.lastBackupAt
    ? Math.max(0, input.nowMs - new Date(input.lastBackupAt).getTime())
    : null;
  const webReaderAvailable = input.webReaderEnabled === true;
  const audioTranscriberAvailable = input.audioTranscriberAvailable === true;
  const semanticRepeatInput = input.semanticRepeat || {};
  const latestSemanticSuppression = semanticRepeatInput.latestSuppression;
  const semanticRepeat = {
    enabled: input.semanticRepeatGuardEnabled !== false,
    windowMs: Number(input.semanticRepeatWindowMs || 30 * 60_000),
    maxReplies: Number(input.semanticRepeatMaxReplies || 2),
    activeTopics: Number(semanticRepeatInput.activeTopics || 0),
    totalSuppressed: Number(semanticRepeatInput.totalSuppressed || 0),
    latestSuppression: latestSemanticSuppression ? {
      channel: String(latestSemanticSuppression.channel || ''),
      chatId: String(latestSemanticSuppression.chatId || ''),
      senderId: String(latestSemanticSuppression.senderId || ''),
      at: String(latestSemanticSuppression.at || ''),
      count: Number(latestSemanticSuppression.count || 0),
      suppressedCount: Number(latestSemanticSuppression.suppressedCount || 0),
      similarity: Number(latestSemanticSuppression.similarity || 0),
    } : null,
  };
  const semanticGroupInput = input.semanticGroupEngagement || {};
  const semanticGroupLastError = semanticGroupInput.lastError;
  const semanticGroupEngagement = {
    enabled: input.semanticGroupEngagementEnabled !== false,
    threshold: Number(input.semanticGroupReplyThreshold || 0.86),
    cooldownMs: Number(input.semanticGroupEntryCooldownMs || 120_000),
    observed: Number(semanticGroupInput.observed || 0),
    classified: Number(semanticGroupInput.classified || 0),
    replied: Number(semanticGroupInput.replied || 0),
    suppressed: Number(semanticGroupInput.suppressed || 0),
    lastError: semanticGroupLastError ? {
      at: String(semanticGroupLastError.at || ''),
      error: String(semanticGroupLastError.error || '').slice(0, 500),
    } : null,
  };
  const discussionInput = input.discussion || {};
  const latestDiscussionClosure = discussionInput.latestClosure;
  const discussion = {
    enabled: input.adaptiveDiscussionEnabled !== false,
    maxReplies: Number(input.adaptiveDiscussionMaxReplies || 100),
    lowValueLimit: Number(input.adaptiveDiscussionLowValueLimit || 3),
    cooldownMs: Number(input.adaptiveDiscussionCooldownMs || 30 * 60_000),
    activeSessions: Number(discussionInput.activeSessions || 0),
    coolingSessions: Number(discussionInput.coolingSessions || 0),
    closedSessions: Number(discussionInput.closedSessions || 0),
    latestClosure: latestDiscussionClosure ? {
      channel: String(latestDiscussionClosure.channel || ''),
      chatId: String(latestDiscussionClosure.chatId || ''),
      sessionNo: Number(latestDiscussionClosure.sessionNo || 0),
      replyCount: Number(latestDiscussionClosure.replyCount || 0),
      reason: String(latestDiscussionClosure.reason || ''),
      at: String(latestDiscussionClosure.at || ''),
      cooldownUntil: String(latestDiscussionClosure.cooldownUntil || ''),
    } : null,
  };
  if (!input.processAlive) issues.push('process_not_running');
  if (feishuEnabled && (pollAgeMs === null || pollAgeMs > input.maxPollAgeMs)) {
    issues.push('poll_cursor_stale');
  }
  if (input.staleProcessing > 0) issues.push('messages_processing_stale');
  if (input.overdueFailed > 0) issues.push('messages_failed');
  if (input.sqliteIntegrity !== 'ok') issues.push('sqlite_integrity_failed');
  if (input.backupRequired
    && (backupAgeMs === null || !Number.isFinite(backupAgeMs)
      || backupAgeMs > input.maxBackupAgeMs)) {
    issues.push('database_backup_stale');
  }
  if (input.backupRequired && input.lastBackupError) issues.push('database_backup_error');
  const dingtalkNeedsWebsocket = dingtalkChannel.enabled
    && dingtalkChannel.transport !== 'Wukong DWS polling';
  if ((feishuEnabled || dingtalkNeedsWebsocket) && !input.websocketActive) {
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
  const selfChatCircuitOpen = Number(input.selfChatCircuitLast?.openUntilMs || 0) > input.nowMs;
  if (selfChatCircuitOpen) issues.push('self_chat_circuit_open');
  if (input.multicaEnabled && isMulticaSyncStale({
    nowMs: input.nowMs,
    lastCompletedAt: input.lastMulticaSyncAt,
    lastStartedAt: input.lastMulticaSyncStartedAt,
    syncIntervalMs: Math.max(1_000, Number(input.maxMulticaSyncAgeMs || 60_000) / 6),
    maxCycleMs: Number(input.maxMulticaSyncCycleMs || 5 * 60_000),
  })) {
    issues.push('multica_sync_stale');
  }
  if (input.multicaEnabled && input.lastMulticaSyncError) issues.push('multica_sync_error');
  if (input.multicaEnabled && Number(input.lastMulticaSyncResult?.pending || 0) > 0) {
    issues.push('multica_delivery_pending');
  }
  if (input.multicaEnabled && Number(input.multicaDeadCount || 0) > 0) {
    issues.push('multica_delivery_dead');
  }
  if (dingtalkChannel.enabled && !dingtalkChannel.connected) {
    issues.push('dingtalk_channel_unavailable');
  }
  if (wecomChannel.enabled && !wecomChannel.connected) {
    issues.push('wecom_channel_unavailable');
  }
  if (geweChannel.enabled) {
    if (!reliabilityFresh) issues.push('wechat_reliability_state_stale');
    else {
      if (!wechatIngress.localListening) issues.push('wechat_local_callback_unavailable');
      if (!wechatIngress.tunnelReady || wechatIngress.activeConnections < 1) {
        issues.push('wechat_tunnel_unavailable');
      }
      if (!wechatIngress.publicReachable) issues.push('wechat_public_callback_unavailable');
      if (!wechatIngress.providerOnline) issues.push('wechat_provider_unavailable');
      if (!wechatIngress.callbackRegistered) issues.push('wechat_callback_registration_stale');
      if (wechatReliability.state === 'circuit_open') issues.push('wechat_recovery_circuit_open');
      if (wechatReliability.state !== 'healthy'
        && !issues.some(issue => issue.startsWith('wechat_'))) {
        issues.push('wechat_channel_unavailable');
      }
    }
    if (!geweChannel.connected && !reliabilityFresh) {
      issues.push('wechat_channel_unavailable');
    }
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
        capabilities: {
          text: feishuEnabled && Boolean(input.processAlive),
          image: feishuEnabled && Boolean(input.processAlive) && !input.credentialBlocked,
          audio: feishuEnabled && Boolean(input.processAlive)
            && !input.credentialBlocked && audioTranscriberAvailable,
          link: feishuEnabled && Boolean(input.processAlive) && webReaderAvailable,
        },
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
        capabilities: {
          text: Boolean(dingtalkChannel.enabled && dingtalkChannel.connected),
          image: Boolean(dingtalkChannel.enabled && dingtalkChannel.connected),
          audio: Boolean(dingtalkChannel.enabled && dingtalkChannel.connected
            && audioTranscriberAvailable),
          link: Boolean(dingtalkChannel.enabled && dingtalkChannel.connected
            && webReaderAvailable),
        },
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
        capabilities: {
          text: Boolean(wecomChannel.enabled && wecomChannel.connected),
          image: false,
          audio: false,
          link: Boolean(wecomChannel.enabled && wecomChannel.connected
            && webReaderAvailable),
        },
      },
      wechat: {
        enabled: Boolean(geweChannel.enabled),
        installed: Boolean(geweChannel.installed),
        configured: Boolean(geweChannel.configured),
        authenticated: Boolean(geweChannel.authenticated),
        connected: Boolean(geweChannel.enabled && wechatIngressHealthy),
        callbackListening: wechatIngress.localListening,
        callbackRegistered: wechatIngress.callbackRegistered,
        healthy: !geweChannel.enabled || wechatIngressHealthy,
        status: !geweChannel.enabled
          ? 'disabled'
          : reliabilityFresh ? String(wechatReliability.state || 'starting') : 'stale',
        ingress: wechatIngress,
        reliabilityCheckedAt: reliabilityFresh
          ? new Date(reliabilityCheckedAtMs).toISOString()
          : '',
        lastPublicSuccessAt: Number.isFinite(reliabilityLayers.public_callback?.lastSuccessAtMs)
          ? new Date(reliabilityLayers.public_callback.lastSuccessAtMs).toISOString()
          : '',
        lastCallbackRegistrationAt:
          String(reliabilityLayers.callback_registration?.lastRegisteredAt || ''),
        recovery: wechatReliability?.recovery || null,
        nextRecoveryAt: Number.isFinite(wechatReliability?.nextRecoveryAtMs)
          ? new Date(wechatReliability.nextRecoveryAtMs).toISOString()
          : '',
        circuitOpenUntil: Number.isFinite(wechatReliability?.circuitOpenUntilMs)
          ? new Date(wechatReliability.circuitOpenUntilMs).toISOString()
          : '',
        identityMode: geweChannel.identityMode || 'personal-third-party',
        transport: geweChannel.transport || 'GeWe REST + public webhook',
        lastReadyAt: geweChannel.lastReadyAt || '',
        lastError: geweChannel.lastError || null,
        risk: 'third-party-unofficial-wechat-api',
        capabilities: {
          text: Boolean(geweChannel.enabled && wechatIngressHealthy),
          image: Boolean(geweChannel.enabled && wechatIngressHealthy),
          audio: false,
          link: Boolean(geweChannel.enabled && wechatIngressHealthy
            && webReaderAvailable),
        },
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
      selfChatCircuitOpen,
      selfChatCircuitLast: input.selfChatCircuitLast || null,
      semanticRepeat,
      semanticGroupEngagement,
      discussion,
    },
  };
}
