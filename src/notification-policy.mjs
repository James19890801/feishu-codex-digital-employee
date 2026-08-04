export function notificationEvent(previousState, currentState) {
  if (previousState === currentState) return null;
  if (!previousState) return currentState === 'online' ? null : 'incident';
  if (currentState === 'online') return 'recovered';
  if (previousState === 'offline' && currentState === 'degraded') return 'partial_recovery';
  return 'incident';
}
