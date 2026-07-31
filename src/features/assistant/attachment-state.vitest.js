import { describe, expect, it } from "vitest";

import {
  canSendAgentMessage,
  hasBlockingUploads,
  readyUploadSources,
} from "./attachment-state.js";

const upload = (status, overrides = {}) => ({
  id: `${status}-id`,
  title: `${status}.md`,
  status,
  ...overrides,
});

describe("assistant attachment state", () => {
  it("blocks sending until every visible upload is ready or removed", () => {
    expect(hasBlockingUploads([upload("queued")])).toBe(true);
    expect(hasBlockingUploads([upload("processing")])).toBe(true);
    expect(hasBlockingUploads([upload("failed")])).toBe(true);
    expect(hasBlockingUploads([upload("ready")])).toBe(false);
  });

  it("allows an attachment-only first turn once indexing is complete", () => {
    expect(canSendAgentMessage({
      draft: "",
      uploads: [upload("ready")],
      agentAvailable: true,
      status: "ready",
    })).toBe(true);
    expect(canSendAgentMessage({
      draft: "请阅读",
      uploads: [upload("processing")],
      agentAvailable: true,
      status: "ready",
    })).toBe(false);
  });

  it("snapshots only ready uploads as private message sources", () => {
    expect(readyUploadSources([
      upload("ready", { id: "source-1", title: "课堂观察.md" }),
      upload("processing"),
    ])).toEqual([{ id: "source-1", title: "课堂观察.md", kind: "private" }]);
  });
});

