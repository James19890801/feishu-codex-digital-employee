export function parseParityConfig(config) {
  const token = config?.parityToken;
  const encoded = config?.parityEncryptionKeyBase64;
  if (!token && !encoded) return { parityToken: undefined, parityEncryptionKey: undefined };
  if (!token || !encoded) throw new Error('incomplete parity configuration');
  const key = Buffer.from(String(encoded), 'base64');
  if (typeof token !== 'string' || token.length < 32 || key.length !== 32
    || key.toString('base64') !== encoded) throw new Error('invalid parity configuration');
  return { parityToken: token, parityEncryptionKey: key };
}
