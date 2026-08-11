function normalizeCommand(text) {
  return String(text || '').trim().replace(/[。！!？? ]+$/g, '');
}

export function matchOperatorCommand(text) {
  const normalized = normalizeCommand(text);
  if (/^(状态|运行状态|服务状态|数字人状态)$/.test(normalized)) return 'status';
  if (/^(帮助|使用说明|怎么用|你会什么)$/.test(normalized)) return 'help';
  return null;
}

function formatAge(nowMs, value) {
  const timestamp = Date.parse(value || '');
  if (!Number.isFinite(timestamp)) return '尚无成功记录';
  const ageMs = Math.max(0, nowMs - timestamp);
  if (ageMs < 60_000) return `${Math.max(0, Math.round(ageMs / 1000))} 秒前`;
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)} 分钟前`;
  return `${(ageMs / 3_600_000).toFixed(1)} 小时前`;
}

export function buildHelpReply({ dashboardUrl }) {
  return [
    '我在。使用方式：',
    '• 群聊 @ 我，再写清楚问题',
    '• 单聊直接发送问题',
    '• 发送“状态”查看通道健康',
    '• 发送“暂停接管”或“恢复接管”切换真人接管',
    '• 可以查询、创建、更新和跟进 A1 工作项；写入前会先让请求人确认',
    '• 发送“把 A1 项目变化同步到这里”开启研发变化同步',
    '',
    `可视化面板：${dashboardUrl}`,
    '面板仅在这台 Mac 上可以打开。',
  ].join('\n');
}

export function buildStatusReply({
  nowMs = Date.now(),
  feishuEnabled = true,
  startedAt,
  lastPollSuccessAt,
  lastPollError,
  websocketConnected,
  aiRuntimeLabel = '',
  dingtalkChannel = {},
  a1Enabled = false,
  lastA1SyncAt = '',
  lastA1SyncError = null,
  maxA1SyncAgeMs = 60_000,
  a1Pending = 0,
  a1Dead = 0,
  multicaEnabled = false,
  lastMulticaSyncAt = '',
  lastMulticaSyncError = null,
  maxMulticaSyncAgeMs = 60_000,
  multicaPending = 0,
  multicaDead = 0,
  inboxCounts = {},
  dashboardUrl,
  detailed = false,
}) {
  const pollTimestamp = Date.parse(lastPollSuccessAt || '');
  const pollHealthy = !feishuEnabled || (Number.isFinite(pollTimestamp)
    && nowMs - pollTimestamp <= 60_000
    && !lastPollError);
  const dingtalkHealthy = !dingtalkChannel.enabled || Boolean(dingtalkChannel.connected);
  const a1Timestamp = Date.parse(lastA1SyncAt || '');
  const a1Healthy = !a1Enabled || (
    Number.isFinite(a1Timestamp)
    && nowMs - a1Timestamp <= maxA1SyncAgeMs
    && !lastA1SyncError
    && Number(a1Pending || 0) === 0
    && Number(a1Dead || 0) === 0
  );
  const multicaTimestamp = Date.parse(lastMulticaSyncAt || '');
  const multicaHealthy = !multicaEnabled || (
    Number.isFinite(multicaTimestamp)
    && nowMs - multicaTimestamp <= maxMulticaSyncAgeMs
    && !lastMulticaSyncError
    && Number(multicaPending || 0) === 0
    && Number(multicaDead || 0) === 0
  );
  const transportHealthy = feishuEnabled
    ? Boolean(websocketConnected)
    : Boolean(dingtalkChannel.enabled && dingtalkChannel.connected);
  const healthy = pollHealthy && transportHealthy && dingtalkHealthy && a1Healthy && multicaHealthy
    && Number(inboxCounts.dead || 0) === 0;
  const lines = [
    `运行状态：${healthy ? '正常' : '需要维护'}`,
  ];
  if (feishuEnabled) {
    lines.push(
      `主消息轮询：${formatAge(nowMs, lastPollSuccessAt)}`,
      `辅助监听：${websocketConnected ? '已连接' : '未连接'}`,
    );
  } else {
    lines.push('飞书：本机禁用');
  }
  if (dingtalkChannel.enabled) {
    lines.push(`钉钉：${dingtalkChannel.connected ? '已连接' : '未连接'}`);
  }
  if (aiRuntimeLabel) lines.push(`AI 运行时：${aiRuntimeLabel}`);
  if (a1Enabled) {
    lines.push(
      `A1 同步：${formatAge(nowMs, lastA1SyncAt)}`
      + (a1Pending ? `，待补发 ${a1Pending}` : '')
      + (a1Dead ? `，死信 ${a1Dead}` : ''),
    );
  }
  if (multicaEnabled) {
    lines.push(
      `Multica 同步：${formatAge(nowMs, lastMulticaSyncAt)}`
      + (multicaPending ? `，待补发 ${multicaPending}` : '')
      + (multicaDead ? `，死信 ${multicaDead}` : ''),
    );
  }
  if (detailed) {
    lines.push(
      `主进程：运行中${startedAt ? `，启动于 ${new Date(startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}` : ''}`,
      `队列：待处理 ${Number(inboxCounts.pending || 0)}，处理中 ${Number(inboxCounts.processing || 0)}，失败/死信 ${Number(inboxCounts.failed || 0) + Number(inboxCounts.dead || 0)}`,
      `可视化面板：${dashboardUrl}`,
      '面板仅在这台 Mac 上可以打开。',
    );
  }
  return lines.join('\n');
}
