export const isUploadBlocking = (upload) => upload.status !== "ready";

export const hasBlockingUploads = (uploads) => uploads.some(isUploadBlocking);

export const readyUploadSources = (uploads) => uploads
  .filter((upload) => upload.status === "ready")
  .map((upload) => ({
    id: upload.id,
    title: upload.title,
    kind: "private",
  }));

export const canSendAgentMessage = ({ draft, uploads, agentAvailable, status }) => (
  Boolean(agentAvailable)
  && status !== "loading"
  && status !== "awaiting_approval"
  && status !== "streaming"
  && !hasBlockingUploads(uploads)
  && (Boolean(draft.trim()) || uploads.some((upload) => upload.status === "ready"))
);

