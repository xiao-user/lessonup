import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "./use-agent-chat.js";

const mocks = vi.hoisted(() => ({
  agentApi: Object.fromEntries(["runtime", "listThreads", "listBranches", "getConversationSnapshot", "getLessonFile"].map((name) => [name, vi.fn()])),
  consumeAgentStream: vi.fn(),
}));
vi.mock("@/lib/agent-api", () => mocks);

const proposal = { id: "approval", runId: "run", assistantMessageId: "assistant", state: "pending", continuationStatus: "pending",
  patch: { kind: "presentation_storyboard", goal: { goal: "课堂演示", themePack: "theme09", slides: [] } } };
const thread = { id: "thread", status: "awaiting_approval" };
const snapshot = (approval = proposal, runStatus = "awaiting_approval") => ({
  messages: [{ id: "assistant", role: "assistant", content: "请确认", status: "completed" }],
  approvals: approval ? [approval] : [], events: [],
  latestRun: { id: "run", status: runStatus }, throughSequence: 1, aggregateVersion: "snapshot",
});

let root;
let chat;
let durable;
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

async function mount(onBeforeRun) {
  function Harness() {
    chat = useAgentChat({ notebookId: "notebook", lessonFileId: "file", documentVersion: 9,
      activeSectionId: "process", onBeforeRun, starterSuggestionsEnabled: false });
    return null;
  }
  await act(async () => { root.render(React.createElement(Harness)); });
  expect(chat.status).toBe("awaiting_approval");
}

function complete(onEvent) {
  onEvent({ type: "run.started", runId: "run", threadId: "thread", branchId: "branch" });
  onEvent({ type: "approval.decided", runId: "run", approvalId: "approval", decision: "approved" });
  onEvent({ type: "approval.delivered", runId: "run", approvalId: "approval", presentationId: "deck" });
  durable = snapshot({ ...proposal, state: "approved", continuationStatus: "completed", delivery: { status: "ready", presentationId: "deck" } }, "completed");
  onEvent({ type: "run.completed", runId: "run" });
}

beforeEach(() => {
  vi.resetAllMocks();
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const storage = new Map();
  window.localStorage = { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.getElementById("root"));
  durable = snapshot();
  mocks.agentApi.runtime.mockResolvedValue({ agent: true });
  mocks.agentApi.listThreads.mockResolvedValue([thread]);
  mocks.agentApi.listBranches.mockResolvedValue([{ id: "branch" }]);
  // Thread selection checks branch approvals when its durable status is awaiting.
  mocks.agentApi.listApprovals = vi.fn().mockResolvedValue([proposal]);
  mocks.agentApi.getConversationSnapshot.mockImplementation(async (_thread, branch) => branch === "branch-b" ? snapshot(null, "completed") : durable);
  mocks.agentApi.getLessonFile.mockResolvedValue({ documentVersion: 9 });
  mocks.consumeAgentStream.mockImplementation(async (_path, _input, onEvent) => complete(onEvent));
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

describe("approval command / snapshot integration (actual React hook)", () => {
  it.each(["none", "snapshot", "document", "thread-list", "late-stream-error"])("cannot undo completed delivery when %s fails", async (failure) => {
    await mount();
    if (failure === "snapshot") mocks.agentApi.getConversationSnapshot.mockRejectedValue(new Error("snapshot unavailable"));
    if (failure === "document") mocks.agentApi.getLessonFile.mockRejectedValue(new Error("document unavailable"));
    if (failure === "thread-list") mocks.agentApi.listThreads.mockRejectedValue(new Error("list unavailable"));
    if (failure === "late-stream-error") mocks.consumeAgentStream.mockImplementation(async (_path, _input, onEvent) => {
      complete(onEvent);
      throw new Error("body stream closed");
    });
    await act(async () => { await chat.respondApproval(true); });
    expect(chat.status).toBe("ready");
    expect(chat.approval).toBeNull();
    expect(chat.approvals[0]).toMatchObject({ state: "approved", continuationStatus: "completed" });
    expect(chat.error).toBeNull();
    if (["snapshot", "document", "thread-list"].includes(failure)) expect(chat.syncError).toBe("conversation_sync_failed");
    expect(mocks.consumeAgentStream).toHaveBeenCalledTimes(1);
  });

  it("requires only synchronization when both the response and the snapshot are unavailable", async () => {
    await mount();
    mocks.consumeAgentStream.mockRejectedValue(new Error("connection lost"));
    mocks.agentApi.getConversationSnapshot.mockRejectedValue(new Error("offline"));
    await act(async () => { await chat.respondApproval(true); });
    expect(chat.approval).toMatchObject({ state: "pending", transport: "unknown" });
    await act(async () => { await chat.respondApproval(true); });
    expect(mocks.consumeAgentStream).toHaveBeenCalledTimes(1);
    durable = snapshot({ ...proposal, state: "approved", continuationStatus: "completed" }, "completed");
    mocks.agentApi.getConversationSnapshot.mockResolvedValue(durable);
    await act(async () => { await chat.synchronizeConversation(); });
    expect(chat.approval).toBeNull();
    expect(chat.status).toBe("ready");
  });

  it("recovers a saved artifact's failed reply without offering to regenerate", async () => {
    await mount();
    mocks.consumeAgentStream.mockImplementation(async (_path, _input, onEvent) => {
      onEvent({ type: "approval.decided", runId: "run", approvalId: "approval", decision: "approved" });
      durable = snapshot({ ...proposal, state: "approved", continuationStatus: "ready", continuationError: "approval_resume_failed", delivery: { status: "ready", presentationId: "deck" } }, "failed");
      onEvent({ type: "run.failed", runId: "run", error: "approval_resume_failed" });
    });
    await act(async () => { await chat.respondApproval(true); });
    expect(chat.approval).toMatchObject({ state: "approved", continuationStatus: "ready", delivery: { status: "ready" } });
    expect(chat.status).toBe("awaiting_approval");
  });

  it("serializes clicks before the editor flush resolves", async () => {
    const flush = deferred();
    const onBeforeRun = vi.fn(() => flush.promise);
    await mount(onBeforeRun);
    await act(async () => {
      const first = chat.respondApproval(true);
      const second = chat.respondApproval(true);
      flush.resolve({ documentVersion: 9 });
      await Promise.all([first, second]);
    });
    expect(onBeforeRun).toHaveBeenCalledTimes(1);
    expect(mocks.consumeAgentStream).toHaveBeenCalledTimes(1);
  });

  it("ignores a snapshot started before terminal events arrived", async () => {
    await mount();
    const stale = deferred();
    mocks.agentApi.getConversationSnapshot.mockImplementationOnce(() => stale.promise);
    let syncing;
    await act(async () => { syncing = chat.synchronizeConversation(); });
    await act(async () => { await chat.respondApproval(true); });
    await act(async () => { stale.resolve(snapshot()); await syncing; });
    expect(chat.approval).toBeNull();
    expect(chat.status).toBe("ready");
  });

  it("does not mutate the newly selected branch after the old command disconnects", async () => {
    await mount();
    const stream = deferred();
    mocks.consumeAgentStream.mockImplementation(async () => { await stream.promise; throw new Error("old branch disconnected"); });
    let command;
    await act(async () => { command = chat.respondApproval(true); });
    await act(async () => { await chat.switchBranch("branch-b"); });
    await act(async () => { stream.resolve(); await command; });
    expect(chat.activeBranchId).toBe("branch-b");
    expect(chat.approval).toBeNull();
    expect(chat.status).toBe("ready");
    expect(chat.error).toBeNull();
  });
});
