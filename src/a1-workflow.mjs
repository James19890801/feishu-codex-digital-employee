import {
  buildRequirementBody,
  classifyRequirementIntent,
  resolveProductRoute,
} from './a1-requirements.mjs';

const PENDING_KIND = 'a1_requirement';

function workitemId(text = '') {
  return String(text).match(/(?:^|\D)(\d{6,12})(?:\D|$)/)?.[1] || '';
}

function knownProduct(text = '') {
  if (/web\s*agent|webagent|网页智能体/i.test(text)) return 'WebAgent';
  if (/AI\s*(?:采购)?协同空间|协同空间|ai-native-flow-platform/i.test(text)) return 'AI协同空间';
  return '';
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
  constructor({ client, pendingStore, prepareRequirement, subscribe = () => {} } = {}) {
    if (!client) throw new Error('A1 client is required');
    if (!pendingStore) throw new Error('pendingStore is required');
    if (typeof prepareRequirement !== 'function') throw new Error('prepareRequirement is required');
    this.client = client;
    this.pendingStore = pendingStore;
    this.prepareRequirement = prepareRequirement;
    this.subscribe = subscribe;
  }

  async create({ context, request, product }) {
    const route = resolveProductRoute(product);
    const spec = await this.prepareRequirement({ request, route, clarification: '', existingBody: '' });
    const body = buildRequirementBody({ ...spec, productName: route.productName });
    const item = await this.client.createRequirement({
      projectId: route.projectId,
      title: spec.title,
      body,
    });
    await this.subscribe({
      workitemId: item.id,
      projectId: route.projectId,
      chatId: context.chatId,
      senderId: context.senderId,
      chatType: context.chatType,
      snapshot: item,
    });
    const question = (spec.openQuestions || []).map(String).find(Boolean) || '';
    if (question) {
      this.pendingStore.set(PENDING_KIND, context.chatId, context.senderId, {
        phase: 'refine',
        request,
        route,
        item,
        lastQuestion: question,
      });
    } else {
      this.pendingStore.delete(PENDING_KIND, context.chatId, context.senderId);
    }
    return {
      handled: true,
      item,
      text: `${formatWorkitem(item, '已创建需求')}${question ? `\n\n为了继续完善：${question}` : ''}`,
    };
  }

  async refine({ context, pending, clarification }) {
    const spec = await this.prepareRequirement({
      request: pending.request,
      route: pending.route,
      clarification,
      existingBody: pending.item.description || '',
    });
    const body = buildRequirementBody({ ...spec, productName: pending.route.productName });
    const item = await this.client.updateRequirement(pending.item.id, {
      title: spec.title,
      body,
    });
    const question = (spec.openQuestions || []).map(String).find(Boolean) || '';
    if (question) {
      this.pendingStore.set(PENDING_KIND, context.chatId, context.senderId, {
        ...pending,
        item,
        lastQuestion: question,
      });
    } else {
      this.pendingStore.delete(PENDING_KIND, context.chatId, context.senderId);
    }
    return {
      handled: true,
      item,
      text: `${formatWorkitem(item, '已更新需求')}${question ? `\n\n还需要确认：${question}` : ''}`,
    };
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

  async handle({ chatId, senderId, chatType = '', messageId = '', text = '' } = {}) {
    const context = { chatId, senderId, chatType, messageId };
    const cleanText = String(text || '').trim();
    const pending = this.pendingStore.get(PENDING_KIND, chatId, senderId);
    if (pending?.phase === 'product') {
      if (/^(?:取消|不用了|不建了)[。！! ]*$/.test(cleanText)) {
        this.pendingStore.delete(PENDING_KIND, chatId, senderId);
        return { handled: true, text: '好，这次需求不创建。' };
      }
      return this.create({ context, request: pending.request, product: cleanText });
    }
    if (pending?.phase === 'refine') {
      if (/^(?:结束|没有了|先这样|不用补充)[。！! ]*$/.test(cleanText)) {
        this.pendingStore.delete(PENDING_KIND, chatId, senderId);
        return { handled: true, text: `好，需求已保留当前版本。\n链接：${pending.item.url}` };
      }
      return this.refine({ context, pending, clarification: cleanText });
    }

    const intent = classifyRequirementIntent(cleanText);
    if (intent === 'none') return { handled: false, text: '' };
    if (intent === 'requirement_progress') return this.progress(cleanText);

    const id = workitemId(cleanText);
    if (intent === 'requirement_update' && id) {
      const existing = await this.client.getWorkitem(id);
      const project = existing.projectId === '2168196' ? 'AI协同空间' : 'WebAgent';
      const route = resolveProductRoute(project);
      const spec = await this.prepareRequirement({
        request: cleanText,
        route,
        clarification: cleanText,
        existingBody: existing.description,
      });
      const body = buildRequirementBody({ ...spec, productName: route.productName });
      const item = await this.client.updateRequirement(id, { title: spec.title, body });
      return { handled: true, item, text: formatWorkitem(item, '已更新需求') };
    }

    const product = knownProduct(cleanText);
    if (product) return this.create({ context, request: cleanText, product });
    this.pendingStore.set(PENDING_KIND, chatId, senderId, {
      phase: 'product', request: cleanText,
    });
    return {
      handled: true,
      text: '这个需求要做在哪个产品上：WebAgent 还是 AI协同空间？如果是其他产品，也直接告诉我产品名称。',
    };
  }
}
