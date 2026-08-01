import { normalizeObservedMessage } from './message-policy.mjs';

class SendCancelledError extends Error {
  constructor(message, code = 'send_cancelled') {
    super(message);
    this.name = 'SendCancelledError';
    this.code = code;
  }
}

function errorSummary(error) {
  return String(error?.message || error || 'unknown error').slice(0, 1000);
}

export class WeChatPocBridge {
  constructor({
    controlStore,
    state,
    ui,
    responder,
    maxQueue = 20,
  }) {
    if (!controlStore || !state || !ui || !responder) {
      throw new Error('WeChat POC bridge dependencies are required');
    }
    this.controlStore = controlStore;
    this.state = state;
    this.ui = ui;
    this.responder = responder;
    this.maxQueue = Math.max(1, Math.min(100, Number(maxQueue) || 20));
    this.initialized = false;
    this.stopped = false;
  }

  async initialize() {
    const control = await this.controlStore.failClosed('worker_start');
    this.state.cancelBeforeGeneration(control.generation, 'worker_start');
    this.state.audit('wechat_poc_worker_started', {
      detail: { enabled: false, generation: control.generation },
    });
    this.initialized = true;
    return control;
  }

  async failClosed(reason) {
    const control = await this.controlStore.failClosed(reason);
    const cancelled = this.state.cancelBeforeGeneration(control.generation, reason);
    this.state.audit('wechat_poc_fail_closed', {
      detail: { reason, generation: control.generation, cancelled },
    });
    return control;
  }

  async assertSendAllowed(generation, event, proof = null) {
    const control = await this.controlStore.read();
    if (!control.enabled || control.generation !== generation) {
      throw new SendCancelledError('WeChat POC switch generation changed', 'generation_changed');
    }
    if (proof) {
      const matches = await this.ui.verifyTarget(proof, event);
      if (!matches) throw new SendCancelledError('WeChat target changed', 'target_mismatch');
    }
    return control;
  }

  async process(event) {
    const generation = Number(event.generation);
    let proof = null;
    let inserted = false;
    try {
      await this.assertSendAllowed(generation, event);
      const answer = String(await this.responder.reply(event)).trim();
      if (!answer) throw new Error('WeChat POC responder returned an empty reply');
      await this.assertSendAllowed(generation, event);

      const resolved = await this.ui.resolveTarget(event);
      if (!resolved?.matched || !resolved?.proof) {
        throw new SendCancelledError('WeChat target could not be verified', 'target_mismatch');
      }
      proof = resolved.proof;
      await this.assertSendAllowed(generation, event, proof);
      await this.ui.insertText(proof, answer);
      inserted = true;
      await this.assertSendAllowed(generation, event, proof);
      const result = await this.ui.send(proof);
      if (result?.uncertain || result?.sent !== true) {
        this.state.markUncertain(event.fingerprint, result?.error || 'send result unavailable');
        this.state.audit('wechat_poc_send_uncertain', {
          chatId: event.chatId,
          messageId: event.messageId,
          detail: { generation },
        });
        return { status: 'uncertain' };
      }

      this.state.remember(event.chatId, event.senderId, 'user', event.text);
      this.state.remember(event.chatId, event.senderId, 'assistant', answer);
      this.state.complete(event.fingerprint);
      this.state.audit('wechat_poc_reply_sent', {
        chatId: event.chatId,
        messageId: event.messageId,
        detail: { generation, answerChars: answer.length },
      });
      return { status: 'completed' };
    } catch (error) {
      if (inserted && proof && typeof this.ui.clearText === 'function') {
        await this.ui.clearText(proof).catch(() => {});
      }
      if (error instanceof SendCancelledError) {
        this.state.cancel(event.fingerprint, error.code);
        this.state.audit('wechat_poc_send_cancelled', {
          chatId: event.chatId,
          messageId: event.messageId,
          detail: { generation, reason: error.code },
        });
        return { status: 'cancelled', reason: error.code };
      }
      if (error?.uncertain === true) {
        this.state.markUncertain(event.fingerprint, errorSummary(error));
        return { status: 'uncertain' };
      }
      this.state.fail(event.fingerprint, errorSummary(error));
      this.state.audit('wechat_poc_reply_failed', {
        chatId: event.chatId,
        messageId: event.messageId,
        detail: { generation, error: errorSummary(error) },
      });
      return { status: 'failed' };
    }
  }

  async drain() {
    const results = [];
    while (!this.stopped) {
      const event = this.state.claimNext();
      if (!event) break;
      results.push(await this.process(event));
    }
    return results;
  }

  async tick() {
    if (!this.initialized) throw new Error('WeChat POC bridge is not initialized');
    if (this.stopped) return { scanned: 0, accepted: 0, results: [] };
    const control = await this.controlStore.read();
    if (!control.enabled) {
      this.state.cancelBeforeGeneration(control.generation, 'switch_disabled');
      return { scanned: 0, accepted: 0, results: [] };
    }

    let probe;
    try {
      probe = await this.ui.probe();
    } catch (error) {
      await this.failClosed('ui_probe_failed');
      return { scanned: 0, accepted: 0, results: [], error: errorSummary(error) };
    }
    if (probe?.available !== true) {
      const reason = `ui_${String(probe?.reason || 'unavailable').slice(0, 80)}`;
      await this.failClosed(reason);
      return { scanned: 0, accepted: 0, results: [], degraded: reason };
    }

    let observations;
    try {
      observations = await this.ui.scan({ boundaryAt: control.boundaryAt });
    } catch (error) {
      await this.failClosed('ui_scan_failed');
      return { scanned: 0, accepted: 0, results: [], error: errorSummary(error) };
    }
    if (!Array.isArray(observations)) observations = [];
    let accepted = 0;
    let active = (() => {
      const counts = this.state.statusCounts();
      return Number(counts.pending || 0) + Number(counts.processing || 0);
    })();
    for (const observation of observations) {
      const normalized = normalizeObservedMessage(observation);
      if (!normalized.accepted) continue;
      const event = normalized.event;
      if (this.state.wasObserved(event.messageId)) continue;
      this.state.recordObservation(event.messageId, event);
      if (active >= this.maxQueue) {
        this.state.audit('wechat_poc_message_dropped', {
          chatId: event.chatId,
          messageId: event.messageId,
          detail: { reason: 'queue_cap', maxQueue: this.maxQueue },
        });
        continue;
      }
      if (this.state.enqueue(event.messageId, event, control.generation)) {
        accepted += 1;
        active += 1;
        this.state.audit('wechat_poc_message_enqueued', {
          chatId: event.chatId,
          messageId: event.messageId,
          detail: { generation: control.generation },
        });
      }
    }
    const results = await this.drain();
    return { scanned: observations.length, accepted, results };
  }

  async stop(reason = 'worker_stop') {
    if (this.stopped) return;
    this.stopped = true;
    await this.failClosed(reason);
  }
}
