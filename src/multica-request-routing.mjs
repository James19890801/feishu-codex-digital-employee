import {
  looksLikeArtifactExecutionRequest,
  looksLikeArtifactProgressRequest,
} from './multica-artifact-delivery.mjs';
import { looksLikeMulticaRequest } from './multica-planner.mjs';

export function multicaRequestRoute(value) {
  const text = String(value || '').trim();
  if (!text) return 'other';
  if (looksLikeArtifactProgressRequest(text)) return 'artifact_followup';
  const artifactExecution = looksLikeArtifactExecutionRequest(text);
  if (looksLikeMulticaRequest(text)) return 'multica';
  if (artifactExecution) return 'artifact_followup';
  return 'other';
}
