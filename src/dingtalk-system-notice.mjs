const DINGTALK_PASSIVE_CALL_NOTICE = /^(?:最近通话[：:]|未接来电[：:]|\[?语音通话\]?\s*已取消$)/u;

export function isPassiveDingTalkSystemNotice(content) {
  return DINGTALK_PASSIVE_CALL_NOTICE.test(String(content || '').trim());
}
