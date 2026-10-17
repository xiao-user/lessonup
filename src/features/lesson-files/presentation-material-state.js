/** Preserve object identity when polling returns the same canonical artifact.
 * A spurious identity change remeasures and paginates the entire A4 document. */
export function reconcilePresentationMaterial(current, presentation, generation, generationError) {
  const sameArtifact = current.presentation?.id === presentation?.id
    && current.presentation?.updatedAt === presentation?.updatedAt
    && current.presentation?.checksum === presentation?.checksum;
  const state = current.state === "deleting" ? "deleting" : generation?.status === "generating" ? "generating" : "idle";
  const error = current.state === "deleting" ? current.error : generationError;
  if (sameArtifact && current.state === state && current.error === error) return current;
  return { ...current, presentation: sameArtifact ? current.presentation : presentation, state, error,
    confirmingDelete: sameArtifact ? current.confirmingDelete : false };
}
