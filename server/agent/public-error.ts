import { DocumentPatchError } from "../document-patch.js";

export function publicAgentError(error: unknown, fallback = "agent_run_failed") {
  if (error instanceof DocumentPatchError) {
    if (error.code === "stale_document" || error.code === "text_mismatch") {
      return "stale_document";
    }
    return error.code;
  }
  return error instanceof Error ? error.message : fallback;
}
