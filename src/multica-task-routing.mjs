function normalized(value) {
  return String(value || '').trim();
}

function numberedSelection(value, items) {
  const text = normalized(value).replace(/[。！!]+$/, '').trim();
  if (/^\d+$/.test(text)) {
    const index = Number(text) - 1;
    return index >= 0 && index < items.length ? items[index] : null;
  }
  const folded = text.toLowerCase();
  const exact = items.filter(item => [item.id, item.name, item.slug]
    .some(candidate => normalized(candidate).toLowerCase() === folded));
  if (exact.length === 1) return exact[0];
  const partial = items.filter(item => normalized(item.name).toLowerCase().includes(folded));
  return folded && partial.length === 1 ? partial[0] : null;
}

export function buildWorkspaceQuestion(workspaces, suggestedWorkspaceId = '') {
  if (!Array.isArray(workspaces) || !workspaces.length) {
    throw new Error('No Multica workspace is available');
  }
  const lines = ['先确认创建位置。请选择 Multica 空间（回复序号或空间名称）：'];
  workspaces.forEach((workspace, index) => {
    const suggested = workspace.id === suggestedWorkspaceId ? '（建议）' : '';
    lines.push(`${index + 1}. ${workspace.name}${suggested}`);
  });
  return lines.join('\n');
}

export function parseWorkspaceSelection(value, workspaces) {
  return numberedSelection(value, workspaces || []);
}

export function routeSelectionConsumesMessage(value, items) {
  const text = normalized(value).replace(/[。！!]+$/, '').trim();
  if (!text) return false;
  if (/^(?:取消|不用了|不创建了|放弃)$/.test(text)) return true;
  if (/^(?:0|仅创建|只创建|不执行|不启动小队|无需小队|不需要小队)$/.test(text)) return true;
  if (text.length > 80 || /[，。！？!?；;\n]/.test(text)) return false;
  return Boolean(numberedSelection(text, items || []));
}

export function buildSquadQuestion(workspace, squads) {
  if (!workspace?.id) throw new Error('A selected Multica workspace is required');
  const lines = [
    `已选择空间：${workspace.name}`,
    '请选择执行方式（回复序号或小队名称）：',
    '0. 仅创建 Issue，不启动小队',
  ];
  (squads || []).forEach((squad, index) => {
    const count = Number(squad.member_count || 0);
    lines.push(`${index + 1}. ${squad.name}（${count} 人）`);
  });
  if (!(squads || []).length) lines.push('当前空间没有可用小队，只能回复 0 仅创建。');
  return lines.join('\n');
}

export function parseSquadSelection(value, squads) {
  const text = normalized(value).replace(/[。！!]+$/, '').trim();
  if (/^(?:0|仅创建|只创建|不执行|不启动小队|无需小队|不需要小队)$/.test(text)) {
    return { mode: 'create_only', squad: null };
  }
  const squad = numberedSelection(text, squads || []);
  return squad ? { mode: 'squad', squad } : null;
}

export function applyCreateRoute(plan, { workspace, selection }) {
  if (plan?.action !== 'create') throw new Error('Only create plans can be routed');
  if (!workspace?.id) throw new Error('A selected Multica workspace is required');
  if (!selection || !['create_only', 'squad'].includes(selection.mode)) {
    throw new Error('A Multica execution mode is required');
  }
  const fields = { ...(plan.fields || {}) };
  delete fields.assignee;
  delete fields.assigneeId;
  if (selection.mode === 'squad') {
    if (!selection.squad?.id) throw new Error('A selected Multica squad is required');
    fields.assigneeId = selection.squad.id;
  }
  return {
    ...structuredClone(plan),
    workspaceId: workspace.id,
    confirmationLevel: selection.mode === 'squad' ? 'double' : plan.confirmationLevel,
    fields,
  };
}

const CONTEXTUAL_EXECUTION = /(?:继续|直接|开始|安排|让|叫|去)?\s*(?:那个|这个|刚才的|上面的)?[^。！？!?]{0,20}(?:专家团|小队|任务|issue)?[^。！？!?]{0,12}(?:执行|处理|解决|推进|完成|交付)/i;
const SUPPLEMENTAL_REQUIREMENT = /(?:PDF|补充|另外|还要|最后|并且|同时|输出|交付|格式|文件)/i;

export function resolveContextualWorkRequest(value, issue) {
  const text = normalized(value);
  if (!text || !issue?.identifier || !CONTEXTUAL_EXECUTION.test(text)) return null;
  const base = [normalized(issue.title), normalized(issue.description)].filter(Boolean).join('\n\n');
  if (!base) return null;
  return {
    issue: String(issue.identifier).toUpperCase(),
    task: SUPPLEMENTAL_REQUIREMENT.test(text)
      ? `${base}\n\n本轮补充要求：${text}`
      : base,
  };
}
