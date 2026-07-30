export function formatAssistantValue(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return 'Not set';
  return JSON.stringify(value, null, 2);
}

export function assistantRequestHeaders(action, sessionToken) {
  return {
    'Content-Type': 'application/json',
    'X-Dashboard-Action': action,
    'X-Dashboard-Session': sessionToken,
  };
}

export function planCanApply(plan) {
  return Boolean(plan && Array.isArray(plan.changes) && plan.changes.length);
}

export function rollbackConfirmation(snapshotId) {
  return `ROLLBACK ${snapshotId}`;
}

export function runtimeCanSelect(runtime, selectedId) {
  return Boolean(runtime?.available && runtime.id !== selectedId);
}

export function runtimeStatusLabel(runtime) {
  if (runtime?.available) return '可用';
  if (runtime?.installed) return '仅检测到应用';
  return '未安装';
}
