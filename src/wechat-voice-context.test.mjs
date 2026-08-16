import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decodeSilkVoice,
  downloadWeChatVoice,
  pcm16MonoToWav,
} from './wechat-voice-context.mjs';

const root = await mkdtemp(join(tmpdir(), 'aipro-wechat-voice-'));

try {
  {
    let apiCalls = 0;
    const bytes = Buffer.from('#!SILK_V3\x01\x02', 'binary');
    const downloaded = await downloadWeChatVoice({
      channel: { downloadVoice: async () => { apiCalls += 1; } },
      voice: {
        xml: '<msg><voicemsg /></msg>',
        msgId: '1169533812',
        bufferBase64: bytes.toString('base64'),
      },
      outputDir: root,
      maxBytes: 1024,
    });
    assert.equal(apiCalls, 0, 'short GeWe voice should use callback bytes without another API call');
    assert.equal(downloaded.bytes, bytes.length);
    assert.equal(downloaded.path.endsWith('.silk'), true);
    assert.deepEqual(await readFile(downloaded.path), bytes);
  }

  {
    const calls = [];
    const downloaded = await downloadWeChatVoice({
      channel: {
        downloadVoice: async (xml, options) => {
          calls.push({ xml, options });
          return 'https://media.example.com/long-voice.silk';
        },
      },
      voice: {
        xml: '<msg><voicemsg voicelength="12000" /></msg>',
        msgId: '7788',
      },
      outputDir: root,
      maxBytes: 1024,
      downloadContent: async (url, outputDir, options) => {
        const path = join(root, 'downloaded-long-voice.silk');
        await writeFile(path, Buffer.alloc(512, 1));
        return {
          url,
          outputDir,
          options,
          path,
          fileName: 'long-voice.silk',
          bytes: 512,
        };
      },
    });
    assert.deepEqual(calls, [{
      xml: '<msg><voicemsg voicelength="12000" /></msg>',
      options: { msgId: '7788' },
    }]);
    assert.equal(downloaded.path, join(root, 'downloaded-long-voice.silk'));
    assert.equal(downloaded.bytes, 512);
  }

  {
    const pcm = Buffer.from([0x01, 0x00, 0xff, 0x7f]);
    const wav = pcm16MonoToWav(pcm, { sampleRate: 24_000 });
    assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(wav.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.deepEqual(wav.subarray(44), pcm);
  }

  {
    const inputPath = join(root, 'voice.silk');
    const decoderPath = join(root, 'decoder');
    await writeFile(inputPath, Buffer.from('#!SILK_V3\x01', 'binary'));
    await writeFile(decoderPath, 'fake executable');
    const calls = [];
    const wavPath = await decodeSilkVoice(inputPath, {
      decoderPath,
      run: async (command, args) => {
        calls.push({ command, args });
        await writeFile(args[1], Buffer.from([0x01, 0x00, 0x02, 0x00]));
        return { stdout: '', stderr: '' };
      },
    });
    assert.equal(wavPath, `${inputPath}.wav`);
    assert.deepEqual(calls, [{ command: decoderPath, args: [inputPath, `${inputPath}.pcm`] }]);
    assert.equal((await readFile(wavPath)).subarray(0, 4).toString('ascii'), 'RIFF');
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('WECHAT_VOICE_CONTEXT_TEST_OK');
