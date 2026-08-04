export const AUTOMATION_PEER_TERMINATION_TEXT = '既然是数字人，我就不跟你玩了，浪费token。';

const QUOTED_REPLY_REQUEST = /(?:帮我|请|替我|你可以|能不能|怎么|如何).{0,12}(?:回复|转述|写|改).{0,8}[“"「『]/i;
const EXPLICIT_AUTOMATION_IDENTITIES = [
  /(?:^|[，,。！？!?；;\s])(?:你好[，,\s]*)?我是\s*(?:一个|一名)?\s*(?:AI\s*(?:助理|助手|秘书|assistant|bot)|人工智能\s*(?:助理|助手)|智能\s*(?:助理|助手)|数字人|数字分身|机器人|bot)(?=$|[，,。！？!?；;\s])/i,
  /(?:^|[，,。！？!?；;\s])(?:你好[，,\s]*)?我是[^。！？!?\n]{1,48}(?:的|，[^。！？!?\n]{0,24}的)\s*(?:AI\s*(?:助理|助手|秘书|assistant|bot)|人工智能\s*(?:助理|助手)|智能\s*(?:助理|助手)|数字人|数字分身|机器人|bot)(?=$|[，,。！？!?；;\s])/i,
  /(?:本账号|这个账号|当前账号).{0,16}(?:由|是).{0,24}(?:AI\s*(?:助理|助手|assistant|bot)|人工智能\s*(?:助理|助手)|智能\s*(?:助理|助手)|数字人|数字分身|机器人|bot).{0,16}(?:自动回复|代为回复|运营|接管)/i,
];

function normalizedText(text) {
  return String(text || '').normalize('NFKC').replace(/\s+/g, ' ').trim();
}

function peerKey(chatId, senderId) {
  return `${String(chatId || '').trim()}\u001f${String(senderId || '').trim()}`;
}

function activityKey(chatId) {
  return String(chatId || '').trim();
}

export function detectExplicitAutomationPeer(text) {
  const value = normalizedText(text);
  if (!value || QUOTED_REPLY_REQUEST.test(value)) {
    return { matched: false, evidence: '' };
  }
  const matched = EXPLICIT_AUTOMATION_IDENTITIES.some(pattern => pattern.test(value));
  return {
    matched,
    evidence: matched ? 'explicit_first_person_automation_identity' : '',
  };
}

export class AutomationPeerGuard {
  constructor({
    state,
    now = Date.now,
    rapidReplyWindowMs = 30_000,
    rapidRoundLimit = 10,
  } = {}) {
    if (!state || typeof state.get !== 'function' || typeof state.set !== 'function') {
      throw new Error('Automation peer guard requires durable state');
    }
    this.state = state;
    this.now = now;
    this.rapidReplyWindowMs = Math.max(1_000, Number(rapidReplyWindowMs) || 30_000);
    this.rapidRoundLimit = Math.max(1, Number(rapidRoundLimit) || 10);
  }

  evaluateInbound({
    chatId = '', senderId = '', chatType = '', text = '', isOwner = false, selfChat = false,
    knownAutomation = false,
  } = {}) {
    if (chatType !== 'p2p' || isOwner || selfChat || !chatId || !senderId) {
      return { action: 'allow', reason: 'not_applicable', evidence: '', rapidRounds: 0 };
    }
    const blocked = this.state.get('automation_peer_block', peerKey(chatId, senderId), null);
    if (blocked) {
      return {
        action: 'suppress',
        reason: String(blocked.reason || 'explicit_automation_identity'),
        evidence: String(blocked.evidence || ''),
        rapidRounds: Number(blocked.rapidRounds || 0),
        newlyBlocked: false,
      };
    }
    if (knownAutomation) {
      return {
        action: 'terminate',
        reason: 'explicit_automation_identity',
        evidence: 'platform_automation_sender_type',
        rapidRounds: 0,
        newlyBlocked: false,
      };
    }
    const detection = detectExplicitAutomationPeer(text);
    if (detection.matched) {
      return {
        action: 'terminate',
        reason: 'explicit_automation_identity',
        evidence: detection.evidence,
        rapidRounds: 0,
        newlyBlocked: false,
      };
    }
    const nowMs = Number(this.now());
    const key = activityKey(chatId);
    const activity = this.state.get('automation_peer_activity', key, {});
    const lastOutboundAtMs = Number(activity?.lastOutboundAtMs || 0);
    const lastCountedOutboundAtMs = Number(activity?.lastCountedOutboundAtMs || 0);
    let rapidRounds = Number(activity?.rapidRounds || 0);
    if (lastOutboundAtMs > 0 && lastOutboundAtMs !== lastCountedOutboundAtMs) {
      const elapsedMs = nowMs - lastOutboundAtMs;
      rapidRounds = elapsedMs >= 0 && elapsedMs <= this.rapidReplyWindowMs
        ? rapidRounds + 1
        : 0;
      this.state.set('automation_peer_activity', key, {
        ...activity,
        rapidRounds,
        lastCountedOutboundAtMs: lastOutboundAtMs,
        lastInboundAtMs: nowMs,
      });
    }
    if (rapidRounds >= this.rapidRoundLimit) {
      this.markTerminated({
        chatId,
        senderId,
        reason: 'rapid_round_limit',
        evidence: 'rapid_reply_after_outbound',
        rapidRounds,
        newlyBlocked: true,
      });
      return {
        action: 'suppress',
        reason: 'rapid_round_limit',
        evidence: 'rapid_reply_after_outbound',
        rapidRounds,
      };
    }
    return { action: 'allow', reason: 'no_signal', evidence: '', rapidRounds };
  }

  markTerminated({
    chatId = '', senderId = '', reason = '', evidence = '', messageId = '', rapidRounds = 0,
  } = {}) {
    if (!chatId || !senderId) throw new Error('Automation peer block requires chat and sender IDs');
    const block = {
      reason: String(reason || 'explicit_automation_identity'),
      evidence: String(evidence || ''),
      messageId: String(messageId || ''),
      rapidRounds: Math.max(0, Number(rapidRounds) || 0),
      blockedAt: new Date(Number(this.now())).toISOString(),
    };
    this.state.set('automation_peer_block', peerKey(chatId, senderId), block);
    return block;
  }

  recordOutbound({ chatId = '' } = {}) {
    const key = activityKey(chatId);
    if (!key) return false;
    const activity = this.state.get('automation_peer_activity', key, {});
    this.state.set('automation_peer_activity', key, {
      ...activity,
      lastOutboundAtMs: Number(this.now()),
    });
    return true;
  }
}

export async function handleAutomationPeerInbound({
  guard,
  chatId = '',
  senderId = '',
  chatType = '',
  text = '',
  messageId = '',
  isOwner = false,
  selfChat = false,
  knownAutomation = false,
  sendTermination,
  onHandled,
} = {}) {
  if (!guard || typeof guard.evaluateInbound !== 'function') {
    throw new Error('Automation peer inbound handling requires a guard');
  }
  const decision = guard.evaluateInbound({
    chatId, senderId, chatType, text, isOwner, selfChat, knownAutomation,
  });
  if (decision.action === 'allow') {
    return { handled: false, notified: false, decision };
  }
  if (decision.action === 'suppress') {
    if (typeof onHandled === 'function') {
      await onHandled({
        name: decision.newlyBlocked
          ? 'automation_peer_rapid_round_limit'
          : 'automation_peer_suppressed',
        decision,
      });
    }
    return { handled: true, notified: false, decision };
  }
  if (typeof sendTermination !== 'function') {
    throw new Error('Automation peer termination requires a sender');
  }
  await sendTermination(AUTOMATION_PEER_TERMINATION_TEXT);
  guard.markTerminated({
    chatId,
    senderId,
    reason: decision.reason,
    evidence: decision.evidence,
    messageId,
  });
  if (typeof onHandled === 'function') {
    await onHandled({ name: 'automation_peer_detected', decision });
  }
  return { handled: true, notified: true, decision };
}

export async function sendWithAutomationPeerTracking({
  guard, chatId = '', text = '', send,
} = {}) {
  if (!guard || typeof guard.recordOutbound !== 'function') {
    throw new Error('Automation peer outbound tracking requires a guard');
  }
  if (typeof send !== 'function') {
    throw new Error('Automation peer outbound tracking requires a sender');
  }
  const result = await send();
  if (result?.suppressed !== true) guard.recordOutbound({ chatId, text });
  return result;
}
