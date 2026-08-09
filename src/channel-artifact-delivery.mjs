import {
  buildDingTalkArtifactSendArgs,
  buildFeishuArtifactSendArgs,
} from './artifact-channel-delivery.mjs';

export function buildChannelArtifactDeliveryPlan({
  channel,
  chatId,
  target,
  path,
  relativePath,
  videoCoverRelativePath = '',
  caption = '',
  idempotencyKey = '',
} = {}) {
  const provider = String(channel || '').trim().toLowerCase();
  let attachmentArgs;
  if (provider === 'feishu') {
    attachmentArgs = buildFeishuArtifactSendArgs({
      chatId,
      relativePath,
      videoCoverRelativePath,
      uuid: idempotencyKey,
    });
  } else if (provider === 'dingtalk') {
    attachmentArgs = buildDingTalkArtifactSendArgs({
      target,
      path,
      uuid: idempotencyKey,
    });
  } else {
    throw new Error(`Artifact delivery is not implemented for ${provider || 'unknown channel'}`);
  }
  return {
    channel: provider,
    attachmentArgs,
    caption: String(caption || ''),
    captionIdempotencyKey: idempotencyKey ? `${idempotencyKey}-caption`.slice(0, 50) : '',
  };
}
