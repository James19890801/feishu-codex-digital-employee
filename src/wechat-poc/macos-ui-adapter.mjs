import { runBufferedProcess } from '../process-runner.mjs';

function assertNoCoordinates(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (['x', 'y', 'point', 'coordinates'].includes(key.toLowerCase())) {
      throw new Error('Screen coordinates are forbidden in the WeChat POC adapter');
    }
    if (nested && typeof nested === 'object') assertNoCoordinates(nested);
  }
}

export class MacOsWeChatUiAdapter {
  constructor({
    scriptPath,
    runner = runBufferedProcess,
    timeoutMs = 8_000,
  }) {
    if (!scriptPath) throw new Error('WeChat POC JXA script path is required');
    this.scriptPath = scriptPath;
    this.runner = runner;
    this.timeoutMs = timeoutMs;
  }

  async run(action, payload = {}) {
    assertNoCoordinates(payload);
    const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
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

  probe() {
    return this.run('probe');
  }

  async scan({ boundaryAt = '' } = {}) {
    const result = await this.run('scan', { boundaryAt });
    return Array.isArray(result.observations) ? result.observations : [];
  }

  resolveTarget(event) {
    return this.run('resolve-target', {
      chatId: event?.chatId || '',
      conversationTitle: event?.conversationTitle || '',
      conversationKind: event?.conversationKind || '',
    });
  }

  async verifyTarget(proof, event) {
    const result = await this.run('verify-target', {
      targetProof: proof,
      chatId: event?.chatId || '',
      conversationTitle: event?.conversationTitle || '',
    });
    return result.matches === true;
  }

  insertText(proof, text) {
    return this.run('insert-text', { targetProof: proof, text: String(text || '') });
  }

  clearText(proof) {
    return this.run('clear-text', { targetProof: proof });
  }

  send(proof) {
    assertNoCoordinates(proof);
    return this.run('send', { targetProof: proof });
  }

  verifySent(proof, textHash) {
    return this.run('verify-sent', { targetProof: proof, textHash: String(textHash || '') });
  }
}
