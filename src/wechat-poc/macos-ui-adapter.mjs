import { runBufferedProcess } from '../process-runner.mjs';
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { WeChatNativeTelemetry } from './native-telemetry.mjs';

function assertNoCoordinates(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (['x', 'y', 'point', 'coordinates'].includes(key.toLowerCase())) {
      throw new Error('Screen coordinates are forbidden in the WeChat POC adapter');
    }
    if (nested && typeof nested === 'object') assertNoCoordinates(nested);
  }
}

function centerY(item) {
  return Number(item?.y || 0) + Number(item?.height || 0) / 2;
}

function lineText(words, lineY, minX = 0.13, maxX = 0.36) {
  return words.filter(word => Number(word.x) >= minX && Number(word.x) <= maxX
      && Math.abs(centerY(word) - lineY) <= 0.018
      && !/^\d{1,2}:\d{2}$/.test(String(word.text || '').trim()))
    .sort((left, right) => Number(left.x) - Number(right.x))
    .map(word => String(word.text || '').trim()).filter(Boolean).join(' ')
    .replace(/\s*\d{1,2}:\d{2}$/, '').trim();
}

function unreadRows(analysis) {
  const words = Array.isArray(analysis?.words) ? analysis.words : [];
  const badges = (Array.isArray(analysis?.redBadges) ? analysis.redBadges : [])
    .filter(badge => Number(badge.x) >= 0.10 && Number(badge.x) <= 0.14
      && Number(badge.width) >= 0.014 && Number(badge.height) >= 0.018);
  return badges.map(badge => {
    const badgeY = centerY(badge);
    const near = words.filter(word => Number(word.x) >= 0.13 && Number(word.x) <= 0.36
        && Math.abs(centerY(word) - badgeY) <= 0.052
        && !/^\d{1,2}:\d{2}$/.test(String(word.text || '').trim()))
      .sort((left, right) => Math.abs(centerY(left) - badgeY) - Math.abs(centerY(right) - badgeY));
    if (!near.length) return null;
    const titleY = centerY(near[0]);
    const title = lineText(words, titleY);
    const below = words.filter(word => Number(word.x) >= 0.13 && Number(word.x) <= 0.36
        && centerY(word) < titleY - 0.018 && centerY(word) >= titleY - 0.11)
      .sort((left, right) => centerY(right) - centerY(left));
    const snippetY = below.length ? centerY(below[0]) : 0;
    const snippet = snippetY ? lineText(words, snippetY) : '';
    const timeWord = words.find(word => Number(word.x) >= 0.13 && Number(word.x) <= 0.36
      && Math.abs(centerY(word) - badgeY) <= 0.045
      && /\d{1,2}:\d{2}$/.test(String(word.text || '').trim()));
    const time = timeWord ? String(timeWord.text).match(/(\d{1,2}:\d{2})$/)?.[1] || '' : '';
    if (!title || !snippet) return null;
    return {
      title, snippet, time,
      titleCenterX: Number(near[0].x) + Number(near[0].width || 0) / 2,
      titleCenterY: titleY,
    };
  }).filter(Boolean);
}

function observedAt(row, fallback = '') {
  if (!row.time) return fallback || new Date().toISOString();
  const [hours, minutes] = row.time.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toISOString();
}

function headerMatches(analysis, title) {
  const expected = String(title || '').replace(/\s+/g, '');
  return (analysis?.words || []).some(word => {
    const text = String(word.text || '').replace(/\s+/g, '');
    return Number(word.x) >= 0.34 && centerY(word) >= 0.88
      && (text.includes(expected) || expected.includes(text));
  });
}

export class MacOsWeChatUiAdapter {
  constructor({
    scriptPath,
    runner = runBufferedProcess,
    timeoutMs = 8_000,
    helperPath = '',
    telemetry = new WeChatNativeTelemetry(),
  }) {
    if (!scriptPath) throw new Error('WeChat POC JXA script path is required');
    this.scriptPath = scriptPath;
    this.helperPath = helperPath || join(dirname(scriptPath), '..', 'data', 'wechat-poc', 'bin', 'wechat-poc-vision');
    this.runner = runner;
    this.timeoutMs = timeoutMs;
    this.telemetry = telemetry;
  }

  async run(action, payload = {}) {
    assertNoCoordinates(payload);
    const encoded = Buffer.from(JSON.stringify({ ...payload, helperPath: this.helperPath }), 'utf8').toString('base64');
    const result = await this.runner('/usr/bin/osascript', [
      '-l', 'JavaScript', this.scriptPath, action, encoded,
    ], {
      timeoutMs: this.timeoutMs,
      maxStdoutBytes: 1024 * 1024,
      maxStderrBytes: 256 * 1024,
    });
    try {
      const parsed = JSON.parse(String(result.stdout || '').trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('result is not an object');
      }
      return parsed;
    } catch (error) {
      throw new Error(`WeChat POC UI adapter returned invalid JSON: ${error.message}`);
    }
  }

  async runJson(command, args, options = {}) {
    const result = await this.runner(command, args, {
      timeoutMs: options.timeoutMs || this.timeoutMs,
      maxStdoutBytes: options.maxStdoutBytes || 2 * 1024 * 1024,
      maxStderrBytes: options.maxStderrBytes || 256 * 1024,
    });
    try { return JSON.parse(String(result.stdout || '').trim()); }
    catch (error) { throw new Error(`WeChat POC helper returned invalid JSON: ${error.message}`); }
  }

  async analyzeWindow() {
    let info;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        info = await this.runJson(this.helperPath, ['window-info']);
        if (info?.ok === true) break;
      } catch (error) { lastError = error; }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!info) throw lastError || new Error('wechat_window_unavailable');
    if (info?.ok !== true) throw new Error(info?.error || 'wechat_window_unavailable');
    const imagePath = join(tmpdir(), `aipro-wechat-poc-${process.pid}-${randomUUID()}.png`);
    try {
      await this.runner('/usr/sbin/screencapture', [
        '-x', '-o', '-l', String(info.windowId), imagePath,
      ], {
        timeoutMs: this.timeoutMs,
        maxStdoutBytes: 8 * 1024,
        maxStderrBytes: 64 * 1024,
      });
      const analysis = await this.runJson(this.helperPath, [imagePath], { timeoutMs: 15_000 });
      if (analysis?.ok !== true) throw new Error(analysis?.error || 'wechat_vision_failed');
      return { info, analysis };
    } finally {
      await rm(imagePath, { force: true }).catch(() => {});
    }
  }

  probe() {
    return this.run('probe');
  }

  async scan({ boundaryAt = '' } = {}) {
    const result = await this.run('scan-notifications', { boundaryAt });
    if (result?.available !== true || !Array.isArray(result?.observations)) {
      throw new Error(result?.reason || 'wechat_notification_scan_unavailable');
    }
    return result.observations;
  }

  async scanProtectedWindow({ boundaryAt = '' } = {}) {
    const { analysis } = await this.analyzeWindow();
    const boundaryMs = Date.parse(boundaryAt);
    const excluded = /^(?:文件传输助手|公众号|腾讯新闻|微信团队|微信支付|服务通知|订阅号消息)$/;
    return unreadRows(analysis).filter(row => !excluded.test(row.title)).map(row => {
      const timestamp = observedAt(row, boundaryAt);
      if (Number.isFinite(boundaryMs) && Date.parse(timestamp) + 60_000 < boundaryMs) return null;
      const mentionedSelf = /[@＠]/.test(row.snippet) && /我/i.test(row.snippet);
      const group = mentionedSelf || /[:：]/.test(row.snippet) || /群/.test(row.title);
      return {
        sourceMessageId: [row.title, row.snippet, row.time].join('|'),
        conversationKind: group ? 'group' : 'direct',
        conversationTitle: row.title,
        senderName: group ? row.snippet.split(/[:：]/)[0].trim() : row.title,
        direction: 'incoming', contentType: 'text',
        text: group ? row.snippet.replace(/^.*?[:：]\s*/, '') : row.snippet,
        mentionedSelf, observedAt: timestamp, messageAt: timestamp,
      };
    }).filter(Boolean);
  }

  async resolveTarget(event) {
    const title = String(event?.conversationTitle || '').trim();
    if (!title) return { matched: false, reason: 'missing_target_title' };
    const afterCursor = typeof this.telemetry.refreshCursor === 'function'
      ? await this.telemetry.refreshCursor()
      : this.telemetry.cursor();
    const searched = await this.run('search-target', { conversationTitle: title });
    if (searched?.ok !== true) return { matched: false, reason: searched?.reason || 'target_search_failed' };
    const selection = await this.telemetry.waitForSelection({ title, afterCursor });
    if (!selection || selection.itemName !== title
      || Number(selection.itemType) !== 3 || Number(selection.moduleType) !== 2) {
      return { matched: false, reason: 'unsafe_search_result' };
    }
    const current = await this.runJson(this.helperPath, ['window-info']);
    return {
      matched: true,
      proof: {
        windowId: Number(current.windowId),
        conversationTitle: title,
        conversationKind: event?.conversationKind === 'group' ? 'group' : 'direct',
        itemType: Number(selection.itemType),
        moduleType: Number(selection.moduleType),
        selectedAt: Number(selection.clickedAt || Date.now()),
        telemetryCursor: Number(selection.cursor || afterCursor),
      },
    };
  }

  async verifyTarget(proof) {
    const current = await this.runJson(this.helperPath, ['window-info']);
    return current?.ok === true && Number(current.windowId) === Number(proof?.windowId)
      && Boolean(String(proof?.conversationTitle || '').trim())
      && Number(proof?.itemType) === 3
      && Number(proof?.moduleType) === 2
      && Date.now() - Number(proof?.selectedAt || 0) <= 8_000;
  }

  insertText(proof, text) {
    return this.run('insert-text', { targetProof: proof, text: String(text || '') });
  }

  clearText(proof) {
    return this.run('clear-text', { targetProof: proof });
  }

  async send(proof) {
    assertNoCoordinates(proof);
    const afterCursor = typeof this.telemetry.refreshCursor === 'function'
      ? await this.telemetry.refreshCursor()
      : this.telemetry.cursor();
    const result = await this.run('send', { targetProof: proof });
    if (result?.sent !== true) return { sent: false, uncertain: true, error: result?.reason || 'send_action_failed' };
    const receipt = await this.telemetry.waitForSendReceipt({ afterCursor });
    if (!receipt) return { sent: false, uncertain: true, error: 'send_receipt_timeout' };
    const isGroup = String(receipt.chatName || '').endsWith('@chatroom');
    const expectedGroup = proof?.conversationKind === 'group';
    if (isGroup !== expectedGroup) {
      return { sent: false, uncertain: true, error: 'send_destination_kind_mismatch', receipt };
    }
    return { sent: true, uncertain: false, receipt };
  }

  verifySent(proof, textHash) {
    return this.run('verify-sent', { targetProof: proof, textHash: String(textHash || '') });
  }
}
