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
  fileUrl = '',
  fileName = '',
  caption = '',
  idempotencyKey = '',
} = {}) {
  const provider = String(channel || '').trim().toLowerCase();
  let attachmentArgs;
  let file;
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
  } else if (provider === 'wechat') {
    file = {
      fileUrl: String(fileUrl || ''),
      fileName: String(fileName || ''),
    };
  } else {
    throw new Error(`Artifact delivery is not implemented for ${provider || 'unknown channel'}`);
  }
  return {
    channel: provider,
    ...(attachmentArgs ? { attachmentArgs } : {}),
    ...(file ? { file } : {}),
    caption: String(caption || ''),
    captionIdempotencyKey: idempotencyKey ? `${idempotencyKey}-caption`.slice(0, 50) : '',
  };
}
