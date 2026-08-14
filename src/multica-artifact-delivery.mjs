import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { explicitArtifactFormats } from './delivery-routing.mjs';
import { artifactFormatForPath } from './artifact-channel-delivery.mjs';
import { processFailureSummary } from './process-runner.mjs';

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const CONTRACT_START = '<!-- AIPRO_DELIVERY_CONTRACT_START -->';
const CONTRACT_END = '<!-- AIPRO_DELIVERY_CONTRACT_END -->';
const FORMAT_LABELS = {
  pdf: 'PDF', doc: 'Word', docx: 'Word', xls: 'Excel', xlsx: 'Excel',
  ppt: 'PPT', pptx: 'PPT', zip: 'ZIP', png: 'PNG', jpg: 'JPG', jpeg: 'JPG',
  mp3: 'MP3', wav: 'WAV', m4a: 'M4A', ogg: 'OGG', mp4: 'MP4', mov: 'MOV',
  html: 'HTML', htm: 'HTML', opus: 'Opus',
};

function normalizedFormats(formats) {
  return [...new Set((Array.isArray(formats) ? formats : [])
    .map(value => String(value || '').trim().toLowerCase()).filter(Boolean))];
}

export function looksLikeArtifactProgressRequest(value) {
  const text = String(value || '').trim();
  return Boolean(text) && /(?:PDF|Word|Excel|PPT|文件|附件|产物).{0,18}(?:做出来|做好了|做好了吗|生成了|完成了|交付了|发了|下载|好了没|出来了不)|(?:到底|现在|还没).{0,18}(?:生成|交付|下载)/i.test(text);
}

export function looksLikeArtifactExecutionRequest(value) {
  const text = String(value || '').trim();
  if (!explicitArtifactFormats(text).length || looksLikeArtifactProgressRequest(text)) return false;
  return /(?:做成|生成|制作|输出|导出|交付|给我|发我|只需要|最后)/i.test(text);
}

export function appendDeliveryRequirement(description, contract) {
  const source = String(description || '').trim();
  const formats = normalizedFormats(contract?.formats);
  if (!formats.length) return source;
  const labels = formats.map(format => FORMAT_LABELS[format] || format.toUpperCase());
  const block = [
    CONTRACT_START,
    '## AIPRO 交付契约',
    `- 最终产物格式：${labels.join('、')}`,
    `- 原始交付要求：${String(contract?.request || '').trim().slice(0, 1000) || '按指定格式交付'}`,
    '- 验收：必须生成真实文件，不得只回复“可以生成”或只提交文字说明。',
    '- 完成前使用 `multica attachment upload <文件路径>` 上传最终文件；确认附件上传成功后再结束任务。',
    CONTRACT_END,
  ].join('\n');
  const start = source.indexOf(CONTRACT_START);
  const end = source.indexOf(CONTRACT_END, start + CONTRACT_START.length);
  if (start >= 0 && end >= start) {
    const current = source.slice(start, end + CONTRACT_END.length);
    if (current === block) return source;
    return `${source.slice(0, start)}${block}${source.slice(end + CONTRACT_END.length)}`.trim();
  }
  return [source, block].filter(Boolean).join('\n\n');
}

function attachmentValue(attachment, names) {
  for (const name of names) {
    const value = attachment?.[name];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return '';
}

function normalizeAttachment(value) {
  const id = String(attachmentValue(value, ['id', 'attachment_id', 'attachmentId'])).trim();
  const name = basename(String(attachmentValue(value, ['name', 'file_name', 'filename', 'title']) || 'artifact'));
  const format = artifactFormatForPath(name);
  return {
    id,
    name,
    format,
    size: Number(attachmentValue(value, ['size', 'file_size', 'bytes']) || 0),
    contentType: String(attachmentValue(value, ['content_type', 'contentType', 'mime_type']) || ''),
  };
}

async function validateDownloadedArtifact(path, outputDir, expectedFormat) {
  const root = await realpath(outputDir);
  const resolved = await realpath(path);
  if (resolved !== root && !resolved.startsWith(`${root}${sep}`)) {
    throw new Error('Downloaded artifact escaped its isolated directory');
  }
  const info = await lstat(resolved);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Downloaded artifact is not a regular file');
  if (info.size <= 0 || info.size > MAX_ARTIFACT_BYTES) throw new Error('Downloaded artifact size is invalid');
  const format = artifactFormatForPath(resolved);
  if (!format || format !== expectedFormat) throw new Error('Downloaded artifact format does not match its contract');
  return { path: resolved, bytes: info.size, format };
}

export class MulticaArtifactDelivery {
  constructor({ client, state, deliver, artifactRoot, audit = () => {} }) {
    this.client = client;
    this.state = state;
    this.deliver = deliver;
    this.artifactRoot = resolve(String(artifactRoot || 'data/multica-artifacts'));
    this.audit = audit;
  }

  async syncIssue(issue, { comments } = {}) {
    const contract = this.state.multicaDeliveryContract(issue?.id);
    if (!contract || contract.status === 'delivered') return { delivered: 0, waiting: 0 };
    if (contract.status === 'delivery_ambiguous') {
      return { delivered: 0, waiting: 0, ambiguous: 1 };
    }
    if (contract.status === 'delivering') {
      return { delivered: 0, waiting: 1, inFlight: 1 };
    }
    let hasMatchingArtifact = false;
    let deliveryAttempted = false;
    try {
      const availableComments = comments || await this.client.listIssueComments(
        issue.id,
        issue.workspace_id || contract.workspaceId,
      );
      const requested = new Set(contract.formats);
      const attachments = availableComments.flatMap(comment => comment?.attachments || [])
        .map(normalizeAttachment)
        .filter(item => item.id && requested.has(item.format));
      const unique = [...new Map(attachments.map(item => [item.id, item])).values()];
      if (!unique.length) {
        this.state.updateMulticaDeliveryContract(issue.id, {
          status: 'waiting_artifact', lastError: '',
        });
        return { delivered: 0, waiting: 1 };
      }
      hasMatchingArtifact = true;

      let delivered = 0;
      for (const attachment of unique) {
        const latest = this.state.multicaDeliveryContract(issue.id);
        if (!latest || ['delivered', 'delivery_ambiguous'].includes(latest.status)) {
          return { delivered, waiting: 0, ambiguous: latest?.status === 'delivery_ambiguous' ? 1 : 0 };
        }
        if (latest.artifactIds.includes(attachment.id)) continue;
        const digest = createHash('sha256').update(attachment.id).digest('hex').slice(0, 16);
        const outputDir = join(this.artifactRoot, String(issue.id), digest);
        await mkdir(outputDir, { recursive: true, mode: 0o700 });
        const downloaded = await this.client.downloadAttachment(attachment.id, {
          outputDir,
          workspaceId: issue.workspace_id || contract.workspaceId,
        });
        const checked = await validateDownloadedArtifact(
          downloaded.path,
          outputDir,
          attachment.format,
        );
        const claim = this.state.claimMulticaArtifactDelivery(issue.id, attachment.id);
        if (!claim.claimed) {
          const status = claim.contract?.status || '';
          return {
            delivered,
            waiting: status === 'delivered' || status === 'delivery_ambiguous' ? 0 : 1,
            ...(status === 'delivery_ambiguous' ? { ambiguous: 1 } : { inFlight: 1 }),
          };
        }
        deliveryAttempted = true;
        await this.deliver({
          issueId: issue.id,
          identifier: issue.identifier || '',
          attachmentId: attachment.id,
          channel: contract.channel,
          chatId: contract.chatId,
          senderId: contract.senderId,
          chatType: contract.chatType,
          path: checked.path,
          name: downloaded.name || attachment.name,
          format: checked.format,
          bytes: checked.bytes,
          idempotencyKey: `multica-artifact-${digest}`,
        });
        delivered += 1;
        this.state.updateMulticaDeliveryContract(issue.id, {
          status: 'delivering',
          lastError: '',
        });
      }

      const deliveredIds = new Set(
        this.state.multicaDeliveryContract(issue.id)?.artifactIds || [],
      );
      const deliveredFormats = new Set(unique
        .filter(item => deliveredIds.has(item.id)).map(item => item.format));
      const complete = contract.formats.every(format => deliveredFormats.has(format));
      this.state.updateMulticaDeliveryContract(issue.id, {
        status: complete ? 'delivered' : 'waiting_artifact',
        artifactIds: [...deliveredIds],
        lastError: '',
        ...(complete ? { deliveredAt: new Date().toISOString() } : {}),
      });
      this.audit('multica_artifact_delivery', {
        issueId: issue.id,
        channel: contract.channel,
        delivered,
        complete,
      });
      return { delivered, waiting: complete ? 0 : 1 };
    } catch (error) {
      const failure = processFailureSummary(error);
      const latest = this.state.multicaDeliveryContract(issue.id) || contract;
      this.state.updateMulticaDeliveryContract(issue.id, {
        status: deliveryAttempted ? 'delivery_ambiguous' : (hasMatchingArtifact ? 'delivery_failed' : 'failed'),
        attempts: latest.attempts + 1,
        lastError: failure,
      });
      this.audit(deliveryAttempted
        ? 'multica_artifact_delivery_ambiguous'
        : 'multica_artifact_delivery_failed', {
        issueId: issue.id,
        channel: contract.channel,
        error: failure,
      });
      throw error;
    }
  }
}
