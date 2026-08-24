const MEDIA_GENERATION = /(?:(?:生成|制作|创建|产出|设计|绘制|画|做|编辑|修改|替换|换|合成)[^。！？!?\n]{0,28}(?:图片|图像|海报|头像|插画|封面|视频|动画))|(?:(?:图片|图像|海报|头像|插画|封面|视频|动画)[^。！？!?\n]{0,28}(?:生成|制作|创建|产出|设计|绘制|画|做|编辑|修改|替换|换|合成))/iu;
const ARTIFACT_GENERATION = /(?:(?:生成|制作|创建|产出|输出|导出|整理|做成)[^。！？!?\n]{0,28}(?:PDF|PPTX?|PowerPoint|Word|DOCX?|Excel|XLSX?|HTML|附件|文件))|(?:(?:PDF|PPTX?|PowerPoint|Word|DOCX?|Excel|XLSX?|HTML|附件|文件)[^。！？!?\n]{0,28}(?:生成|制作|创建|产出|输出|导出|整理|做成|发给|交付))/iu;
const LONG_REPORT = /(?:(?:生成|制作|创建|产出|输出|整理|撰写|编写|写一份|做一份)[^。！？!?\n]{0,40}(?:报告|白皮书|调研|研究))|(?:(?:完整|全面|深度|系统性|长篇)[^。！？!?\n]{0,18}(?:报告|调研|研究|方案))|(?:白皮书)/iu;

function clean(value, limit = 240) {
  return String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

export function classifyHighCostRequest(request = '') {
  const text = clean(request, 4_000);
  if (!text) return { required: false, category: '', summary: '', reason: '' };
  if (MEDIA_GENERATION.test(text)) {
    return {
      required: true,
      category: 'media_generation',
      summary: clean(text),
      reason: '图片或视频生成会消耗较多模型资源',
    };
  }
  if (ARTIFACT_GENERATION.test(text)) {
    return {
      required: true,
      category: 'artifact_generation',
      summary: clean(text),
      reason: '文件型交付会启动生成与校验流程',
    };
  }
  if (LONG_REPORT.test(text)) {
    return {
      required: true,
      category: 'long_report',
      summary: clean(text),
      reason: '长篇报告会消耗较多模型资源',
    };
  }
  return { required: false, category: '', summary: clean(text), reason: '' };
}

export function requiresOwnerCostApproval({ request = '', ownerAuthorized = false } = {}) {
  return !ownerAuthorized && classifyHighCostRequest(request).required;
}

export function costCategoryLabel(category = '') {
  return ({
    media_generation: '图片或视频生成任务',
    artifact_generation: '文件型交付任务',
    long_report: '长篇报告任务',
  })[String(category || '')] || '高成本生成任务';
}
