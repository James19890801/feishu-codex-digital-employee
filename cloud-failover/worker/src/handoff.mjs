function handoffError(code, message) {
  return Object.assign(new Error(message), { code });
}

export async function executeCloudHandoff({
  repository,
  handoffId,
  digest,
  execute,
  now = () => Date.now(),
} = {}) {
  if (!repository || typeof execute !== 'function') {
    throw new TypeError('Handoff repository and executor are required');
  }
  if (!handoffId) {
    return {
      result: await execute(),
      handoff: { status: 'untracked', replayed: false },
    };
  }
  if (!/^[a-f0-9]{64}$/.test(String(handoffId))) {
    throw handoffError('invalid_handoff', 'Cloud handoff ID is invalid');
  }
  const started = await repository.beginHandoff(handoffId, digest, now());
  if (!started.accepted) {
    if (started.record?.digest !== digest) {
      throw handoffError('handoff_mismatch', 'Cloud handoff digest does not match');
    }
    if (started.record?.state === 'completed' && started.record?.result) {
      return {
        result: started.record.result,
        handoff: { status: 'completed', replayed: true },
      };
    }
    throw handoffError('handoff_in_progress', 'Cloud handoff is already in progress');
  }
  try {
    const result = await execute();
    await repository.completeHandoff(handoffId, result, now());
    return { result, handoff: { status: 'completed', replayed: false } };
  } catch (error) {
    await repository.failHandoff(handoffId).catch(() => {});
    throw error;
  }
}
