import { createHash } from 'node:crypto';

const STATE_SCOPE = 'wechat-newcomer-welcome';

function fingerprint(value) {
  return createHash('sha256').update(String(value || '')).digest('hex');
}

function safeDisplayName(value) {
  return String(value || '新朋友')
    .replace(/[\u0000-\u001f\u007f@＠]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || '新朋友';
}

function safeError(error) {
  return String(error?.message || error || 'unknown error')
    .replace(/\b(?:wxid_[A-Za-z0-9_-]+|\d{6,}@chatroom)\b/g, '<redacted>')
    .slice(0, 500);
}

function normalizedState(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    initialized: source.initialized === true,
    members: Array.isArray(source.members)
      ? [...new Set(source.members.map(String).filter(Boolean))].slice(0, 5_000)
      : [],
    pending: Array.isArray(source.pending)
      ? source.pending.flatMap(item => {
          const memberHash = String(item?.memberHash || '');
          if (!/^[a-f0-9]{64}$/.test(memberHash)) return [];
          return [{
            memberHash,
            displayName: safeDisplayName(item?.displayName),
            attempts: Math.max(0, Number(item?.attempts) || 0),
            nextAttemptAtMs: Math.max(0, Number(item?.nextAttemptAtMs) || 0),
          }];
        }).slice(0, 500)
      : [],
    lastCheckedAtMs: Math.max(0, Number(source.lastCheckedAtMs) || 0),
  };
}

export function buildNewcomerWelcomeText(names, groupName) {
  const displayNames = [...new Set((names || []).map(safeDisplayName))];
  const joinedNames = displayNames.length ? displayNames.join('、') : '新朋友';
  return [
    `欢迎${joinedNames}加入「${safeDisplayName(groupName)}」👋`,
    '我是小詹，詹老师的个人 AI 数字人。我可以围绕 AI、流程管理和组织变革答疑，阅读群里的图片、文件和链接，协助产出方案、报告、流程图及交付文件，也能承接明确任务持续执行。',
    '需要我时，直接在群里 @小詹 即可唤起我。',
  ].join('\n\n');
}

export class WeChatNewcomerWelcome {
  constructor({
    state,
    channel,
    groupId,
    groupName,
    intervalMs = 120_000,
    now = Date.now,
    setIntervalImpl = setInterval,
    clearIntervalImpl = clearInterval,
  }) {
    this.state = state;
    this.channel = channel;
    this.groupId = String(groupId || '').trim();
    this.groupName = String(groupName || '').trim();
    this.intervalMs = Math.max(30_000, Math.min(900_000, Number(intervalMs) || 120_000));
    this.now = now;
    this.setIntervalImpl = setIntervalImpl;
    this.clearIntervalImpl = clearIntervalImpl;
    this.timer = null;
    this.tail = Promise.resolve();
    this.stateKey = `group-${fingerprint(this.groupId).slice(0, 24)}`;
  }

  readState() {
    return normalizedState(this.state.get(STATE_SCOPE, this.stateKey, null));
  }

  writeState(value) {
    this.state.set(STATE_SCOPE, this.stateKey, normalizedState(value));
  }

  memberHash(memberId) {
    return fingerprint(`${this.groupId}\0${String(memberId || '')}`);
  }

  async verifyGroup() {
    const info = await this.channel.getChatroomInfo(this.groupId);
    if (String(info?.nickName || '').trim() === this.groupName) return true;
    this.state.audit('wechat_newcomer_welcome_group_mismatch', {
      detail: { reason: 'configured_group_name_mismatch' },
    });
    return false;
  }

  async flushPending(current) {
    const nowMs = this.now();
    const due = current.pending.filter(item => item.nextAttemptAtMs <= nowMs);
    if (!due.length) return current;

    const dueHashes = new Set(due.map(item => item.memberHash));
    const attempts = Math.max(...due.map(item => item.attempts), 0) + 1;
    const sendingState = {
      ...current,
      pending: current.pending.map(item => dueHashes.has(item.memberHash)
        ? { ...item, attempts }
        : item),
    };
    this.writeState(sendingState);

    try {
      await this.channel.send(
        { channel: 'wechat', kind: 'group', id: this.groupId },
        buildNewcomerWelcomeText(due.map(item => item.displayName), this.groupName),
      );
      const sentState = {
        ...sendingState,
        pending: sendingState.pending.filter(item => !dueHashes.has(item.memberHash)),
      };
      this.writeState(sentState);
      this.state.audit('wechat_newcomer_welcome_sent', {
        detail: { newcomerCount: due.length, attempts },
      });
      return sentState;
    } catch (error) {
      const retryDelayMs = Math.min(5 * 60_000, 5_000 * (2 ** Math.min(attempts - 1, 6)));
      const failedState = {
        ...sendingState,
        pending: sendingState.pending.map(item => dueHashes.has(item.memberHash)
          ? { ...item, nextAttemptAtMs: nowMs + retryDelayMs }
          : item),
      };
      this.writeState(failedState);
      this.state.audit('wechat_newcomer_welcome_retry', {
        detail: { newcomerCount: due.length, attempts, retryDelayMs, error: safeError(error) },
      });
      return failedState;
    }
  }

  async reconcile(reason = 'manual') {
    let current = this.readState();
    try {
      if (!await this.verifyGroup()) {
        return { disabled: true, pendingCount: current.pending.length };
      }
      const roster = await this.channel.getChatroomMemberList(this.groupId);
      const members = new Map();
      for (const member of roster) {
        const memberId = String(member?.memberId || '').trim();
        if (!memberId) continue;
        members.set(this.memberHash(memberId), safeDisplayName(member?.displayName));
      }
      const memberHashes = [...members.keys()];
      if (!current.initialized) {
        current = {
          initialized: true,
          members: memberHashes,
          pending: [],
          lastCheckedAtMs: this.now(),
        };
        this.writeState(current);
        this.state.audit('wechat_newcomer_welcome_baseline', {
          detail: { memberCount: memberHashes.length },
        });
        return { baselineCreated: true, memberCount: memberHashes.length, pendingCount: 0 };
      }

      const previousMembers = new Set(current.members);
      const activeMembers = new Set(memberHashes);
      const pendingByMember = new Map(
        current.pending
          .filter(item => activeMembers.has(item.memberHash))
          .map(item => [item.memberHash, item]),
      );
      for (const memberHash of memberHashes) {
        if (previousMembers.has(memberHash) || pendingByMember.has(memberHash)) continue;
        pendingByMember.set(memberHash, {
          memberHash,
          displayName: members.get(memberHash),
          attempts: 0,
          nextAttemptAtMs: this.now(),
        });
      }
      current = {
        ...current,
        members: memberHashes,
        pending: [...pendingByMember.values()],
        lastCheckedAtMs: this.now(),
      };
      this.writeState(current);
      current = await this.flushPending(current);
      return {
        reason: String(reason || '').slice(0, 50),
        memberCount: memberHashes.length,
        pendingCount: current.pending.length,
      };
    } catch (error) {
      this.state.audit('wechat_newcomer_welcome_reconcile_error', {
        detail: { reason: String(reason || '').slice(0, 50), error: safeError(error) },
      });
      return { error: true, pendingCount: current.pending.length };
    }
  }

  triggerReconcile(reason = 'system-event') {
    const operation = this.tail.then(() => this.reconcile(reason));
    this.tail = operation.catch(() => {});
    return operation;
  }

  async start() {
    await this.triggerReconcile('startup');
    if (this.timer) return;
    this.timer = this.setIntervalImpl(() => {
      this.triggerReconcile('periodic').catch(() => {});
    }, this.intervalMs);
    this.timer?.unref?.();
  }

  stop() {
    if (!this.timer) return;
    this.clearIntervalImpl(this.timer);
    this.timer = null;
  }
}
