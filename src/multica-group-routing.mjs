import { routeSelectionConsumesMessage } from './multica-task-routing.mjs';
import { buildDeliveryPlan } from './delivery-routing.mjs';
import { appendDeliveryRequirement } from './multica-artifact-delivery.mjs';

const MUTATION_FOLLOWUP = /^(?:确认|确认执行|确定|可以|行|没问题|好|好哦)(?:\s*\d{6})?(?:[，,。！! ]|$)|^(?:取消|不用了|不执行|放弃)[。！! ]*$/;

export function isPendingWeChatMulticaContinuation({
  channel = '',
  chatType = '',
  contextOnly = false,
  text = '',
  pendingCreateRoute = null,
  pendingMutation = null,
} = {}) {
  if (channel !== 'wechat' || chatType !== 'group' || contextOnly !== true) return false;
  if (pendingCreateRoute) {
    const items = pendingCreateRoute.stage === 'workspace'
      ? pendingCreateRoute.workspaces
      : pendingCreateRoute.squads;
    return routeSelectionConsumesMessage(text, items || [])
      || buildDeliveryPlan({ chatId: 'wechat:group:pending', request: text }).kind === 'artifact';
  }
  return Boolean(pendingMutation && MUTATION_FOLLOWUP.test(String(text || '').trim()));
}

export function extendPendingCreateDelivery(pending, {
  request = '',
  channel = '',
  chatId = '',
  senderId = '',
  chatType = '',
} = {}) {
  if (!pending || !['workspace', 'squad'].includes(pending.stage)) return { matched: false };
  const deliveryPlan = buildDeliveryPlan({ chatId, request });
  if (deliveryPlan.kind !== 'artifact') return { matched: false };
  const previousFormats = Array.isArray(pending.deliveryContract?.formats)
    ? pending.deliveryContract.formats : [];
  const formats = [...new Set([...previousFormats, ...deliveryPlan.formats])];
  const combinedRequest = [pending.originalRequest, request]
    .map(value => String(value || '').trim()).filter(Boolean).join('\n');
  const deliveryContract = {
    channel: String(channel || '').trim().toLowerCase(),
    chatId,
    senderId,
    chatType,
    formats,
    request: combinedRequest,
  };
  const plan = structuredClone(pending.plan);
  plan.fields = {
    ...(plan.fields || {}),
    description: appendDeliveryRequirement(plan.fields?.description, deliveryContract),
  };
  return {
    matched: true,
    pending: {
      ...structuredClone(pending),
      originalRequest: combinedRequest,
      plan,
      deliveryContract,
    },
  };
}
