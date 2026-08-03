const L3_PATTERNS = [
  /(?:付款|转账|汇款|支付).{0,12}(?:元|款|钱|费用|账)/,
  /(?:签署|签订|代签).{0,10}(?:合同|协议|承诺书)/,
  /(?:录用|辞退|解雇|薪资承诺|法律承诺)/,
  /(?:密码|验证码|私钥|身份证号)/,
  /(?:冒充|假装是|不要让.{0,8}知道是AI|分不清.{0,8}真人)/i,
  /(?:删除|清空).{0,10}(?:全部|重要|数据|文件|记录)/,
  /(?:替|代替|代表).{0,12}(?:阿充|詹老师|James|老师|本人)?.{0,8}(?:决定|拍板|批准|同意|选择|表态)/i,
  /(?:决定|拍板|批准|同意|选择|表态).{0,12}(?:替|代替|代表).{0,8}(?:阿充|詹老师|James|老师|本人)/i,
  /(?:原文|逐字|完整|全部).{0,16}(?:桌面|本机|文件|资料|聊天记录|通讯录|客户名单|隐私|敏感数据).{0,12}(?:发|给|转发|公开|提供|导出)/,
  /(?:发|给|转发|公开|提供|导出).{0,16}(?:桌面|本机|文件|资料|聊天记录|通讯录|客户名单|隐私|敏感数据).{0,12}(?:原文|逐字|完整|全部)/,
  /(?:桌面|本机|聊天记录|通讯录|客户名单|隐私|敏感数据).{0,20}(?:原文|逐字|完整|全部).{0,12}(?:发|给|转发|公开|提供|导出)/,
];

const L2_PATTERNS = [
  /(?:发给|发送给|转发给|回复给).{0,30}(?:老师|领导|客户|同事|群|邮箱)/,
  /(?:发布|投稿|提交|报名|申请|答复邀约)/,
  /(?:创建|新建|修改|取消).{0,8}(?:待办|任务|日程|会议|群聊|权限)/,
  /(?:代表我|以我的名义|替我承诺)/,
];

export function classifyIntent(text = '', context = {}) {
  if (context.hasImages) return 'image_understanding';
  if (context.hasFile) return 'file_understanding';
  if (/(?:需求|工作项|需求池).{0,20}(?:创建|新建|更新|修改|补充|进展|进度|状态|查询|查看)|(?:创建|新建|更新|修改|补充|查询|查看).{0,20}(?:需求|工作项|需求池)|\b\d{6,12}\b.{0,20}(?:需求|工作项|进展|进度|状态)/i.test(text)) {
    return 'a1_requirement';
  }
  if (/(待办|任务|提醒)/.test(text)) return 'task';
  if (/(日程|日历|安排|会议时间)/.test(text)) return 'calendar';
  if (/(报告|方案|对比|总结).{0,12}(?:生成|制作|输出|整理|发回)|(?:生成|制作|输出|整理).{0,12}(?:报告|方案|对比|总结)/.test(text)) return 'artifact';
  if (/(会议|纪要|文档|资料|飞书)/.test(text)) return 'knowledge';
  return 'conversation';
}

export function decideWorkflow(text = '', context = {}) {
  const intent = classifyIntent(text, context);
  if (L3_PATTERNS.some(pattern => pattern.test(text))) {
    return { intent, level: 'L3', action: 'refuse', reason: '禁止代办或隐瞒身份' };
  }
  if (L2_PATTERNS.some(pattern => pattern.test(text))) {
    return { intent, level: 'L2', action: 'preview_confirm', reason: '会影响外部对象或真实工作状态' };
  }
  if (intent === 'artifact') {
    return { intent, level: 'L1', action: 'execute_report', reason: '当前会话明确要求低风险交付物' };
  }
  return { intent, level: 'L0', action: 'execute', reason: '读取、整理、分析或当前会话回复' };
}

export function workflowInstruction(decision) {
  return `Bible 决策：意图=${decision.intent}；等级=${decision.level}；动作=${decision.action}；原因=${decision.reason}。`;
}
