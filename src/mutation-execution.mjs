export class MutationOutcomeAmbiguousError extends Error {
  constructor(message, { cause, executionKey, kind } = {}) {
    super(message, { cause });
    this.name = 'MutationOutcomeAmbiguousError';
    this.code = 'MUTATION_OUTCOME_AMBIGUOUS';
    this.executionKey = executionKey || '';
    this.kind = kind || '';
  }
}

function ambiguousError(executionKey, kind, cause) {
  return new MutationOutcomeAmbiguousError(
    'The external mutation may have been applied; automatic replay is blocked',
    { cause, executionKey, kind },
  );
}

export async function executeMutationOnce({
  state,
  executionKey,
  kind,
  operation,
  definitelyNotApplied = () => false,
}) {
  if (!state || !executionKey || !kind || typeof operation !== 'function') {
    throw new Error('Mutation execution requires state, key, kind, and operation');
  }
  const claim = state.beginMutationExecution(executionKey, kind);
  if (!claim.execute) {
    if (claim.status === 'succeeded') {
      return { result: claim.result, replayed: true };
    }
    if (claim.status === 'started') {
      state.markMutationAmbiguous(
        executionKey,
        'Recovered an execution that stopped before its outcome was recorded',
      );
    }
    throw ambiguousError(executionKey, kind);
  }

  try {
    const result = await operation();
    if (!state.completeMutationExecution(executionKey, result)) {
      throw new Error('Mutation success could not be recorded');
    }
    return { result, replayed: false };
  } catch (error) {
    if (definitelyNotApplied(error)) {
      state.failMutationExecutionSafely(
        executionKey,
        error?.stack || error?.message || error,
      );
      throw error;
    }
    state.markMutationAmbiguous(executionKey, error?.stack || error?.message || error);
    throw ambiguousError(executionKey, kind, error);
  }
}
