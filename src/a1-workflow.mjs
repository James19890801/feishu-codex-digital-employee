import {
  buildRequirementBody,
  classifyRequirementIntent,
  resolveProductRoute,
} from './a1-requirements.mjs';

const PENDING_KIND = 'a1_requirement';
const CANCELLATION = /^(?:取消|不用了|不建了|不更新了)[。！! ]*$/u;

function workitemId(text = '') {
  return String(text).match(/(?:^|\D)(\d{6,12})(?:\D|$)/)?.[1] || '';
}

function knownProduct(text = '') {
  if (/web\s*agent|webagent|网页智能体/i.test(text)) return 'WebAgent';
  if (/AI\s*(?:采购)?协同空间|协同空间|ai-native-flow-platform/i.test(text)) return 'AI协同空间';
  return '';
}

function cleanLabel(value = '', fallback = '') {
  const text = String(value || '').replace(/[\r\n|]/gu, ' ').trim().slice(0, 200);
  return text || fallback;
}

export function extractRequestedAssignee(text = '') {
  const value = String(text || '');
  const patterns = [
    /负责人(?:是|为|：|:)?\s*([\p{Script=Han}A-Za-z0-9._-]{1,30})/u,
    /指派给\s*([\p{Script=Han}A-Za-z0-9._-]{1,30})/u,
    /帮\s*([\p{Script=Han}A-Za-z0-9._-]{1,20})\s*(?:建|建立|创建)/u,
  ];
  for (const pattern of patterns) {
    const candidate = cleanLabel(value.match(pattern)?.[1]);
    if (candidate && !/^(?:我|他|她|别人|大家|我们)$/u.test(candidate)) return candidate;
  }
  return '';
}

function combinedRequest(text, history = '') {
  const current = String(text || '').trim();
  const context = String(history || '').trim();
  if (!context || context.includes(current)) return current;
  return `${context}\n当前请求：${current}`.slice(-20_000);
}

function sourceRequester(context) {
  const metadata = context.metadata || {};
  if (metadata.channel === 'dingtalk' && metadata.selfChat === true) {
    const ownerLabel = cleanLabel(metadata.ownerLabel, context.requester || context.senderId || 'Owner');
    return `${ownerLabel}（钉钉自聊）`;
  }
  return cleanLabel(context.requester, context.senderId || '未知');
}

function sourceSection(context, assignee) {
  return `## 来源与责任

- 提出人：${sourceRequester(context)}
- A1 负责人：${cleanLabel(assignee, '未显式指定，使用需求池默认规则')}
- 来源渠道：${cleanLabel(context.metadata?.channel, 'dingtalk')}
- 来源消息：${cleanLabel(context.messageId, '未提供')}`;
}

function formatWorkitem(item, prefix = '需求状态') {
  const parts = [
    `${prefix}：${item.title || item.id}`,
    `ID：${item.id}`,
    item.status ? `状态：${item.status}` : '',
    item.assignee ? `负责人：${item.assignee}` : '',
    item.updatedAt ? `更新时间：${item.updatedAt}` : '',
    `链接：${item.url}`,
  ];
  return parts.filter(Boolean).join('\n');
}

function formatList(items, projectName) {
  if (!items.length) return `${projectName} 当前没有读取到需求。`;
  const lines = items.slice(0, 20).map(item => {
    const id = item.id || item.identifier || '';
    const title = item.title || item.subject || '';
    const status = item.status?.displayValue || item.status || '';
    return `- ${id} ${title}${status ? `（${status}）` : ''}`.trim();
  });
  return `${projectName} 最近的需求：\n${lines.join('\n')}`;
}

export class A1RequirementWorkflow {
  constructor({
    client,
    pendingStore,
    prepareRequirement,
    subscribe = () => {},
  } = {}) {
    if (!client) throw new Error('A1 client is required');
    if (!pendingStore) throw new Error('pendingStore is required');
    if (typeof prepareRequirement !== 'function') throw new Error('prepareRequirement is required');
    this.client = client;
    this.pendingStore = pendingStore;
    this.prepareRequirement = prepareRequirement;
    this.subscribe = subscribe;
  }

  _set(context, value) {
    this.pendingStore.set(PENDING_KIND, context.chatId, context.senderId, value);
  }

  _delete(context) {
    this.pendingStore.delete(PENDING_KIND, context.chatId, context.senderId);
  }

  async _prepareCreate(context, request, product, assignee = '') {
    const route = resolveProductRoute(product);
    if (route.needsClarification || !route.projectId) {
      this._set(context, { phase: 'product', request, assignee, requester: context.requester });
      return {
        handled: true,
        text: '这个需求必须明确进入哪个已配置需求池：WebAgent 还是 AI协同空间？其他产品不会默认写进 WebAgent。',
      };
    }
    const owner = assignee || extractRequestedAssignee(request);
    const spec = await this.prepareRequirement({
      request,
      route,
      clarification: '',
      existingBody: '',
      context,
    });
    const body = `${buildRequirementBody({ ...spec, productName: route.productName })}\n\n${sourceSection(context, owner)}`;
    return this._execute(context, {
      operation: 'create',
      route,
      request,
      requester: cleanLabel(context.requester, context.senderId),
      assignee: owner,
      priority: '高',
      spec,
      body,
      origin: {
        chatId: context.chatId,
        senderId: context.senderId,
        chatType: context.chatType,
        messageId: context.messageId,
      },
    });
  }

  async _prepareUpdate(context, request, id) {
    const existing = await this.client.getWorkitem(id);
    const product = existing.projectId === '2168196' ? 'AI协同空间' : 'WebAgent';
    const route = resolveProductRoute(product);
    const assignee = extractRequestedAssignee(request) || existing.assignee || '';
    const spec = await this.prepareRequirement({
      request,
      route,
      clarification: request,
      existingBody: existing.description,
      context,
    });
    const body = `${buildRequirementBody({ ...spec, productName: route.productName })}\n\n${sourceSection(context, assignee)}`;
    return this._execute(context, {
      operation: 'update',
      workitemId: id,
      route,
      request,
      requester: cleanLabel(context.requester, context.senderId),
      assignee,
      priority: '',
      spec,
      body,
      origin: {
        chatId: context.chatId,
        senderId: context.senderId,
        chatType: context.chatType,
        messageId: context.messageId,
      },
    });
  }

  async _execute(context, pending) {
    let item;
    if (pending.operation === 'update') {
      item = await this.client.updateRequirement(pending.workitemId, {
        title: pending.spec.title,
        body: pending.body,
        assignee: pending.assignee,
      });
    } else {
      item = await this.client.createRequirement({
        projectId: pending.route.projectId,
        title: pending.spec.title,
        body: pending.body,
        assignee: pending.assignee,
        priority: pending.priority,
      });
    }
    const readback = await this.client.getWorkitem(item.id);
    await this.subscribe({
      workitemId: readback.id,
      projectId: pending.route.projectId,
      chatId: pending.origin.chatId,
      senderId: pending.origin.senderId,
      chatType: pending.origin.chatType,
      snapshot: readback,
    });
    const text = formatWorkitem(readback, pending.operation === 'update' ? '已更新需求' : '已创建需求');
    this.pendingStore.set(PENDING_KIND, pending.origin.chatId, pending.origin.senderId, {
      phase: 'created',
      item: readback,
      route: pending.route,
    });
    return { handled: true, item: readback, text };
  }

  async progress(text) {
    const id = workitemId(text);
    if (id) return { handled: true, text: formatWorkitem(await this.client.getWorkitem(id)) };
    const product = knownProduct(text);
    if (!product) {
      return { handled: true, text: '你要查 WebAgent 还是 AI协同空间的需求进度？也可以直接发工作项 ID。' };
    }
    const route = resolveProductRoute(product);
    const items = await this.client.listRequirements({ projectId: route.projectId, pageSize: 20 });
    return { handled: true, text: formatList(items, route.projectName) };
  }

  async handle({
    chatId,
    senderId,
    chatType = '',
    messageId = '',
    text = '',
    history = '',
    requester = '',
    assignee = '',
    metadata = {},
  } = {}) {
    const context = {
      chatId, senderId, chatType, messageId, requester, metadata,
    };
    const cleanText = String(text || '').trim();
    const pending = this.pendingStore.get(PENDING_KIND, chatId, senderId);
    if (pending?.phase === 'created') {
      const currentIntent = classifyRequirementIntent(cleanText);
      if (currentIntent === 'none' && /(?:这个|该|刚才|上面|它)?.{0,8}(?:需求|工作项)|能不能决定/u.test(cleanText)) {
        return {
          handled: true,
          item: pending.item,
          text: `这个需求已经创建，后续可以继续补充或查询进度。\n${formatWorkitem(pending.item)}`,
        };
      }
      if (currentIntent !== 'none') this._delete(context);
    }
    if (pending?.phase === 'product') {
      if (CANCELLATION.test(cleanText)) {
        this._delete(context);
        return { handled: true, text: '好，这次需求不创建。' };
      }
      const product = knownProduct(cleanText);
      if (!product) {
        return { handled: true, text: '目前只允许选择 WebAgent 或 AI协同空间，请明确其中一个。' };
      }
      this._delete(context);
      return this._prepareCreate(
        { ...context, requester: pending.requester || context.requester },
        pending.request,
        product,
        pending.assignee || assignee,
      );
    }
    const request = combinedRequest(cleanText, history);
    const intent = classifyRequirementIntent(cleanText);
    if (intent === 'none') return { handled: false, text: '' };
    if (intent === 'requirement_progress') return this.progress(cleanText);
    const id = workitemId(cleanText);
    if (intent === 'requirement_update' && id) return this._prepareUpdate(context, request, id);
    const product = knownProduct(request);
    if (product) return this._prepareCreate(context, request, product, assignee || extractRequestedAssignee(request));
    this._set(context, {
      phase: 'product', request, assignee: assignee || extractRequestedAssignee(request), requester: context.requester,
    });
    return {
      handled: true,
      text: '这个需求必须明确进入哪个已配置需求池：WebAgent 还是 AI协同空间？其他产品不会默认写进 WebAgent。',
    };
  }
}
