import { randomBytes } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';

function boundedVoiceBytes(value, maxBytes) {
  const source = String(value || '').trim();
  if (!source || source.length > Math.ceil(maxBytes * 1.5) + 16
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(source)) return null;
  const bytes = Buffer.from(source, 'base64');
  if (!bytes.length || bytes.length > maxBytes) return null;
  return bytes;
}

export async function downloadWeChatVoice({
  channel,
  voice,
  outputDir,
  maxBytes = 25 * 1024 * 1024,
  downloadContent,
} = {}) {
  if (!channel || !voice?.xml || !voice?.msgId || !outputDir) {
    throw new Error('GeWe voice download context is incomplete');
  }
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const callbackBytes = boundedVoiceBytes(voice.bufferBase64, maxBytes);
  if (callbackBytes) {
    const path = join(outputDir, `${randomBytes(16).toString('hex')}-wechat-voice.silk`);
    await writeFile(path, callbackBytes, { mode: 0o600, flag: 'wx' });
    return { path, fileName: 'wechat-voice.silk', bytes: callbackBytes.length, source: 'callback' };
  }
  if (typeof downloadContent !== 'function') {
    throw new Error('GeWe long voice downloader is unavailable');
  }
  const fileUrl = await channel.downloadVoice(voice.xml, { msgId: String(voice.msgId) });
  const downloaded = await downloadContent(fileUrl, outputDir, { maxBytes });
  const info = await lstat(downloaded.path);
  if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > maxBytes) {
    throw new Error('Downloaded GeWe voice is invalid');
  }
  return {
    ...downloaded,
    bytes: Number(downloaded.bytes || info.size),
    source: 'api',
  };
}

export function pcm16MonoToWav(pcm, { sampleRate = 24_000 } = {}) {
  const audio = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm || []);
  if (!audio.length || audio.length % 2 !== 0) {
    throw new Error('PCM audio must contain complete 16-bit samples');
  }
  const rate = Number(sampleRate);
  if (!Number.isSafeInteger(rate) || rate < 8_000 || rate > 192_000) {
    throw new Error('PCM sample rate is invalid');
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + audio.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(audio.length, 40);
  return Buffer.concat([header, audio]);
}

export async function decodeSilkVoice(inputPath, {
  decoderPath,
  run,
  sampleRate = 24_000,
} = {}) {
  const source = String(inputPath || '').trim();
  const decoder = String(decoderPath || '').trim();
  if (!source || !decoder || typeof run !== 'function') {
    throw new Error('Silk decoder, input path, and process runner are required');
  }
  const pcmPath = `${source}.pcm`;
  const wavPath = `${source}.wav`;
  try {
    await run(decoder, [source, pcmPath]);
    const pcm = await readFile(pcmPath);
    const wav = pcm16MonoToWav(pcm, { sampleRate });
    await writeFile(wavPath, wav, { mode: 0o600 });
    return wavPath;
  } finally {
    await rm(pcmPath, { force: true }).catch(() => {});
  }
}
