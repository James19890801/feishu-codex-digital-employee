import { createHash } from 'node:crypto';
import { extname, normalize, sep } from 'node:path';

const EXCLUDED_SEGMENTS = new Set([
  '.cache', '.git', '.npm', '.ssh', '.trash', '.wrangler',
  'build', 'coverage', 'dist', 'library', 'node_modules', 'test-results',
  'tmp', 'xwechat_files',
]);

const ARTICLE_SIGNALS = [
  /公众号|微信文章|wechat[-_ ]?article/i,
  /<article\b/i,
  /一键复制|作者名片|金句|阅读原文|扫码关注|wechat/i,
];

const PROFESSIONAL_KNOWLEDGE_EXTENSIONS = new Set([
  '.pdf', '.ppt', '.pptx', '.doc', '.docx', '.md', '.txt',
]);
const PROFESSIONAL_KNOWLEDGE_SIGNAL = /(?:流程(?:管理|治理|架构|设计|优化|绩效|运营|建模|规划|洞察|数字化|变革|思维|型组织|即组织力|穿越)|业务(?:流程|架构)|数字化研发流水线|华为.{0,8}(?:流程|经营管理)|变革之心|(?:AI|人工智能).{0,12}(?:流程|组织|企业|变革|协同)|(?:流程|组织|企业|变革).{0,12}(?:AI|人工智能)|(?:Agent|智能体|数字人).{0,12}(?:流程|组织|企业|协同)|Enterprise[_ -]?AI|AI[_ -]?Process|BPM|SOP)/i;
const PRIVATE_DOCUMENT_SIGNAL = /(?:客户|甲方|乙方|合作方|诊断报告|合同|报价|账单|简历|对话记录|回复[_\s-]|逐字稿|会议纪要|单据样例|联系人|通讯录)/i;

const COMPANY_SUFFIX = '(?:有限责任公司|股份有限公司|有限公司|集团(?:有限公司)?|公司|研究院|事务所|中心)';

export function isExcludedKnowledgePath(path = '') {
  const segments = normalize(String(path || '')).split(sep).map(value => value.toLowerCase());
  return segments.some(segment => EXCLUDED_SEGMENTS.has(segment))
    || segments.some(segment => /^\.env(?:\.|$)/.test(segment))
    || /(?:^|[/\\])(?:data|logs?)(?:[/\\]|$)/i.test(String(path || ''));
}

export function isLikelyKnowledgeHtml({ path = '', html = '' } = {}) {
  if (extname(path).toLowerCase() !== '.html' || isExcludedKnowledgePath(path)) return false;
  const source = String(html || '');
  if (source.length < 100) return false;
  if (/istanbul|coverage report|vite client|webpack bootstrap/i.test(source)) return false;
  const visibleLength = source.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().length;
  if (visibleLength < 40) return false;
  const pathSignal = /公众号|微信文章|wechat[-_ ]?article/i.test(path);
  const publishingControl = /一键复制|复制全文/.test(source);
  const articleStructure = /<article\b|<main\b/i.test(source);
  const publishingFooter = /作者名片|阅读原文|扫码关注/.test(source);
  return pathSignal || (publishingControl && (articleStructure || publishingFooter));
}

export function isLikelyProfessionalKnowledgeFile(path = '') {
  const value = String(path || '');
  const extension = extname(value).toLowerCase();
  if (!PROFESSIONAL_KNOWLEDGE_EXTENSIONS.has(extension) || isExcludedKnowledgePath(value)) return false;
  const name = value.split(/[/\\]/).at(-1) || '';
  if (!name || /^\.~|^~\$/.test(name) || PRIVATE_DOCUMENT_SIGNAL.test(name)) return false;
  return PROFESSIONAL_KNOWLEDGE_SIGNAL.test(name);
}

export function opaqueSourceHandle(path = '') {
  return `src_${createHash('sha256').update(String(path)).digest('hex').slice(0, 16)}`;
}

export function abstractPrivateKnowledge(value = '') {
  let text = String(value || '');
  let redactionCount = 0;
  const replace = (pattern, replacement) => {
    text = text.replace(pattern, (...args) => {
      redactionCount += 1;
      return typeof replacement === 'function' ? replacement(...args) : replacement;
    });
  };

  replace(new RegExp(`([\u4e00-\u9fffA-Za-z0-9·（）()]{2,40})${COMPANY_SUFFIX}`, 'g'), '某企业');
  replace(/(?:客户|甲方|乙方|合作方)\s*[：:]\s*[^\n，。；]{2,60}/g, '客户：某企业');
  replace(/(?:合作)?项目(?:名称)?\s*[：:]\s*[^\n，。；]{2,60}/g, '项目：某项目');
  replace(/(?:联系人|负责人|对接人)\s*[：:]\s*[\u4e00-\u9fffA-Za-z·]{2,30}/g, '联系人：某负责人');
  replace(/(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)(?:0\d{2,3}[- ]?)?\d{7,8}(?!\d)/g, '[联系方式已隐去]');
  replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[邮箱已隐去]');
  replace(/https?:\/\/[^\s<>()]+/gi, '[内部链接已隐去]');
  replace(/(?:合同金额|报价|预算|回款|营收)\s*[：:]?\s*(?:人民币|¥|￥)?\s*[\d,.]+\s*(?:万|亿|元)?/g, '[金额已隐去]');
  replace(/(?:合作|客户|项目)[^\n。；]{0,8}(?:代号|名称)\s*[：:]\s*[^\n，。；]{2,60}/g, '某项目');

  text = text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const unsafe = /(?:客户|甲方|乙方|合作方|联系人|负责人|对接人)\s*[：:]\s*(?!某)/.test(text)
    || /(?<!\d)1[3-9]\d{9}(?!\d)/.test(text)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text);
  return { text, safe: !unsafe, redactionCount };
}

const UNSAFE_EVIDENCE_PATTERNS = [
  /(?:^|\s)\/(?:Users|Volumes|private|var)\//i,
  /(?:^|\s)[A-Za-z]:\\(?:Users|Documents|Desktop)\\/i,
  /(?:客户|合作方|甲方|乙方).{0,20}(?:项目|公司|企业|合同|联系人|资料)/,
  /(?:项目|公司|企业|合同|联系人|资料).{0,20}(?:客户|合作方|甲方|乙方)/,
  /(?<!\d)1[3-9]\d{9}(?!\d)/,
  /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i,
  /https?:\/\/[^\s<>()]+/i,
];

export function isSafeKnowledgeEvidence(value = '') {
  const text = String(value || '').trim();
  return text.length >= 16 && !UNSAFE_EVIDENCE_PATTERNS.some(pattern => pattern.test(text));
}

export function safeKnowledgeTitle(value = '') {
  const result = abstractPrivateKnowledge(String(value || '').slice(0, 200));
  return result.safe ? result.text.replace(/[\r\n]+/g, ' ').slice(0, 100) : '知识条目';
}
