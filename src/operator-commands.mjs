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
    '• 账号本人发送“数字人请退场”、“数字人停止”或“数字人先不要你了”，当前会话静默至少 5 分钟',
    '• 可以查询、创建、更新和跟进 1A 需求；需求会直接写入、回读并返回真实链接',
    '• 新需求会先确认 WebAgent、AI协同空间或其他产品，再按对应需求池处理',
    '• 已创建需求的真实状态变化会自动通知原提出人',
    '• 账号本人可在钉钉私聊查询和阅读企业邮箱；发送、回复或转发会先展示完整预览，收到“确认”后才执行',
    '',
    `可视化面板：${dashboardUrl}`,
    '面板仅在这台 Mac 上可以打开。',
  ].join('\n');
}

export function buildStatusReply({
  nowMs = Date.now(),
  startedAt,
  lastPollSuccessAt,
  lastPollError,
  websocketConnected,
  aiRuntimeLabel = '',
  a1Enabled = false,
  lastA1SyncAt = '',
  lastA1SyncError = null,
  maxA1SyncAgeMs = 600_000,
  a1Pending = 0,
  a1Dead = 0,
  inboxCounts = {},
  dashboardUrl,
  detailed = false,
}) {
  const pollTimestamp = Date.parse(lastPollSuccessAt || '');
  const pollHealthy = Number.isFinite(pollTimestamp)
    && nowMs - pollTimestamp <= 60_000
    && !lastPollError;
  const a1Timestamp = Date.parse(lastA1SyncAt || '');
  const a1Healthy = !a1Enabled || (
    Number.isFinite(a1Timestamp)
    && nowMs - a1Timestamp <= maxA1SyncAgeMs
    && !lastA1SyncError
    && Number(a1Pending || 0) === 0
    && Number(a1Dead || 0) === 0
  );
  const healthy = pollHealthy && websocketConnected && a1Healthy
    && Number(inboxCounts.dead || 0) === 0;
  const lines = [
    `运行状态：${healthy ? '正常' : '需要维护'}`,
    `主消息轮询：${formatAge(nowMs, lastPollSuccessAt)}`,
    `辅助监听：${websocketConnected ? '已连接' : '未连接'}`,
  ];
  if (aiRuntimeLabel) lines.push(`AI 运行时：${aiRuntimeLabel}`);
  if (a1Enabled) {
    lines.push(
      `1A 同步：${formatAge(nowMs, lastA1SyncAt)}`
      + (a1Pending ? `，待补发 ${a1Pending}` : '')
      + (a1Dead ? `，死信 ${a1Dead}` : ''),
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
