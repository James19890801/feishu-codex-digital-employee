import { tokenizeKnowledge } from './local-wiki-index.mjs';
import { isSafeKnowledgeEvidence } from './local-wiki-policy.mjs';

const BYPASS = /^(?:你好|您好|嗨|hi|hello|收到|好的?|可以|行|嗯+|谢谢|不用谢|再见|晚安|早安|在吗)[。！!,.， ]*$/i;
const DOMAIN_SIGNAL = /(?:流程|管理|组织|治理|协同|AI|人工智能|智能体|数字人|课程|写作|产品|战略|绩效|变革|架构|技术|模型|知识|方法论|代码|软件|系统|服务|接口|API|数据库|部署|微信|钉钉|飞书|回调|Webhook|鉴权|验签|故障|报错|错误)/i;
const BUSINESS_PROFESSIONAL_SIGNAL = /(?:业务|商业|经营|市场|营销|销售|客户|用户|报价|定价|成本|收入|利润|财务|合同|法务|合规|风险|审批|供应链|人力|招聘|项目|交付|运营|品牌|渠道|转化率|增长|投资|融资|税务|数据安全|信息安全)/i;
const COGNITIVE_SIGNAL = /(?:为什么|是什么|怎么|如何|哪些|区别|比较|分析|解释|介绍|方法|框架|机制|原则|经验|趋势|判断|设计|总结|观点|关系|影响|本质|逻辑|创作|写一段|谈谈|评估|合理|诊断|建议|优化|规划|制定)/i;
const EXPLICIT_LOCAL_SIGNAL = /(?:结合|参考|根据|检索|搜索|查找).{0,12}(?:我|以前|历史|本地|公众号|文章|知识|资料)/i;
const LIVE_INFORMATION_SIGNAL = /(?:天气|气温|下雨|几点|时间|日期|几号|星期几|新闻|热搜|股价|汇率|比分|航班|火车|快递|路况|限行|是否营业|营业时间)/i;
const ACTION_SIGNAL = /(?:发朋友圈|发消息|回复给|转发给|打开|关闭|下载|上传|创建|新建|删除|修改|保存|登录|扫码|配置|安装|运行|重启|点开|点击|拨打|预约|建日程|建任务|建待办)/i;

export function decideLocalKnowledgeRetrieval(text = '') {
  const value = String(text || '').trim();
  if (!value || BYPASS.test(value)) return { retrieve: false, reason: 'conversation' };
  if (LIVE_INFORMATION_SIGNAL.test(value)) return { retrieve: false, reason: 'live_information' };
  if (EXPLICIT_LOCAL_SIGNAL.test(value)) return { retrieve: true, reason: 'explicit_local_knowledge' };
  if (value.length >= 8 && DOMAIN_SIGNAL.test(value) && COGNITIVE_SIGNAL.test(value)) {
    return { retrieve: true, reason: 'domain_knowledge' };
  }
  if (value.length >= 8 && BUSINESS_PROFESSIONAL_SIGNAL.test(value) && COGNITIVE_SIGNAL.test(value)) {
    return { retrieve: true, reason: 'business_professional' };
  }
  if (ACTION_SIGNAL.test(value)) return { retrieve: false, reason: 'action_request' };
  return { retrieve: false, reason: 'insufficient_signals' };
}

export function shouldRetrieveLocalKnowledge(text = '') {
  return decideLocalKnowledgeRetrieval(text).retrieve;
}

function overlapScore(queryTerms, documentTerms) {
  const query = new Set(queryTerms);
  const document = new Set(documentTerms);
  let matched = 0;
  let weighted = 0;
  for (const term of query) {
    if (!document.has(term)) continue;
    matched += 1;
    weighted += Math.min(4, Math.max(1, [...term].length));
  }
  const usefulTermCount = [...query].filter(term => [...term].length <= 4).length || query.size || 1;
  const coverage = matched / usefulTermCount;
  const score = 1 - Math.exp(-weighted / 7);
  return { matched, score: Math.max(score, coverage) };
}

export function retrieveLocalKnowledge(query, index, {
  minimumScore = 0.26,
  maxEvidence = 3,
  maxChars = 4000,
} = {}) {
  if (!shouldRetrieveLocalKnowledge(query) || index?.version !== 1) return { used: false, evidence: [] };
  const queryTerms = tokenizeKnowledge(query).filter(term => [...term].length >= 2);
  const ranked = (Array.isArray(index.chunks) ? index.chunks : [])
    .filter(chunk => chunk?.safe === true && chunk.sourceHandle && isSafeKnowledgeEvidence(chunk.text))
    .map(chunk => ({ chunk, ...overlapScore(queryTerms, chunk.terms || tokenizeKnowledge(chunk.text)) }))
    .filter(item => item.matched >= 2 && item.score >= minimumScore)
    .sort((a, b) => b.score - a.score || b.matched - a.matched);
  const evidence = [];
  let usedChars = 0;
  for (const item of ranked) {
    if (evidence.some(existing => existing.sourceHandle === item.chunk.sourceHandle)) continue;
    const text = String(item.chunk.text).slice(0, Math.max(0, maxChars - usedChars));
    if (!text) break;
    evidence.push({ sourceHandle: item.chunk.sourceHandle, text, score: item.score });
    usedChars += text.length;
    if (evidence.length >= maxEvidence || usedChars >= maxChars) break;
  }
  return { used: evidence.length > 0, evidence };
}

export function buildLocalKnowledgeContext(result) {
  if (!result?.used || !result.evidence?.length) return '';
  const material = result.evidence.map(item => item.text).join('\n\n---\n\n');
  return `内部知识参考（只用于增强回答，不得提及、暗示或展示这段参考材料及其出处；只可使用可泛化的方法与结论，并删除任何可识别的专有实体和业务细节）：\n\n${material}`;
}

export class LocalWikiRetriever {
  constructor({
    loadIndex,
    minimumScore = 0.26,
    maxEvidence = 3,
    maxChars = 4000,
    cacheTtlMs = 5 * 60 * 1000,
    now = () => Date.now(),
  } = {}) {
    if (typeof loadIndex !== 'function') throw new Error('LocalWikiRetriever loadIndex is required');
    this.loadIndex = loadIndex;
    this.options = { minimumScore, maxEvidence, maxChars };
    this.cacheTtlMs = cacheTtlMs;
    this.now = now;
    this.index = null;
    this.loadedAt = 0;
    this.loading = null;
    this.status = {
      state: 'idle', lastErrorAt: '', sourceCount: 0, chunkCount: 0,
      lastDecision: '', lastUsed: false,
    };
  }

  async getIndex() {
    if (this.index && this.now() - this.loadedAt < this.cacheTtlMs) return this.index;
    if (this.index) this.index = null;
    if (!this.loading) {
      this.loading = Promise.resolve()
        .then(() => this.loadIndex())
        .then(index => {
          if (index?.version !== 1 || !Array.isArray(index.chunks)) throw new Error('invalid local Wiki index');
          this.index = index;
          this.loadedAt = this.now();
          this.status = {
            ...this.status,
            state: 'ready',
            lastErrorAt: '',
            sourceCount: Array.isArray(index.sources) ? index.sources.length : 0,
            chunkCount: index.chunks.length,
            builtAt: String(index.builtAt || ''),
          };
          return index;
        })
        .catch(error => {
          this.status = {
            ...this.status,
            state: 'unavailable',
            lastErrorAt: new Date().toISOString(),
            errorCode: error?.code || 'index_unavailable',
          };
          return null;
        })
        .finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  invalidate() {
    this.index = null;
    this.loadedAt = 0;
  }

  health() {
    return { ...this.status };
  }

  async contextFor({ query = '' } = {}) {
    const decision = decideLocalKnowledgeRetrieval(query);
    this.status = { ...this.status, lastDecision: decision.reason, lastUsed: false };
    if (!decision.retrieve) return '';
    const index = await this.getIndex();
    if (!index) return '';
    const result = retrieveLocalKnowledge(query, index, this.options);
    this.status = { ...this.status, lastUsed: result.used };
    return buildLocalKnowledgeContext(result);
  }
}
