const L3_PATTERNS = [
  /(?:付款|转账|汇款|支付).{0,12}(?:元|款|钱|费用|账)/,
  /(?:签署|签订|代签).{0,10}(?:合同|协议|承诺书)/,
  /(?:录用|辞退|解雇|薪资承诺|法律承诺)/,
  /(?:密码|验证码|私钥|身份证号)/,
  /(?:冒充|假装是|不要让.{0,8}知道是AI|分不清.{0,8}真人)/i,
  /(?:删除|清空).{0,10}(?:全部|重要|数据|文件|记录)/,
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
