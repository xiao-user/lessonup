import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "./use-agent-chat.js";

const mocks = vi.hoisted(() => ({
  agentApi: Object.fromEntries(["runtime", "listThreads", "listBranches", "getConversationSnapshot", "getLessonFile", "queueInput"].map(name => [name, vi.fn()])),
  consumeAgentStream: vi.fn(),
}));
vi.mock("@/lib/agent-api", () => mocks);
let root, chat, durable;
const scope = { threadId: "thread", branchId: "branch" };
const completedRun = id => ({ id, ...scope, status: "completed" });
const approvalFor = (id, runId) => ({ id, runId, assistantMessageId: `assistant-${runId}`, toolCallId: `tool-${runId}`,
  patch: { fileId: "file", baseDocumentVersion: 9, summary: id, operations: [] }, state: "pending", continuationStatus: "pending" });

beforeEach(async () => {
  vi.resetAllMocks();
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  window.localStorage = storage; window.sessionStorage = storage;
  vi.stubGlobal("sessionStorage", storage); vi.stubGlobal("window", window); vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  durable = { messages: [], approvals: [], events: [], latestRun: null };
  mocks.agentApi.runtime.mockResolvedValue({ agent: true });
  mocks.agentApi.listThreads.mockResolvedValue([{ id: "thread", status: "idle" }]);
  mocks.agentApi.listBranches.mockResolvedValue([{ id: "branch" }]);
  mocks.agentApi.getConversationSnapshot.mockImplementation(async () => durable);
  mocks.agentApi.getLessonFile.mockResolvedValue({ documentVersion: 9 });
  root = createRoot(document.getElementById("root"));
  function Harness() {
    chat = useAgentChat({ notebookId: "notebook", lessonFileId: "file", documentVersion: 9,
      activeSectionId: "assessment", onBeforeRun: async () => ({ documentVersion: 9 }), starterSuggestionsEnabled: false });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("historical A4 approvals do not revive runs", () => {
  it("rejects the first draft, adopts the second, preserves both outcomes, then POSTs a decision request instead of queueing", async () => {
    let starts = 0;
    let secondEvents;
    mocks.consumeAgentStream.mockImplementation(async (path, input, emit) => {
      if (path.endsWith("/runs")) {
        const runId = `run-${++starts}`;
        emit({ type: "run.started", runId, ...scope });
        if (starts === 2) secondEvents = emit;
        if (starts > 2) {
          durable = { ...durable, latestRun: completedRun(runId) };
          emit({ type: "run.completed", runId });
          return;
        }
        const approval = approvalFor(`approval-${starts}`, runId);
        emit({ type: "approval.required", runId, approvalId: approval.id, assistantMessageId: approval.assistantMessageId,
          toolCallId: approval.toolCallId, patch: approval.patch });
        durable = { ...durable, latestRun: completedRun(runId), approvals: [...durable.approvals, approval],
          messages: [...durable.messages, { id: approval.assistantMessageId, role: "assistant", content: `draft ${starts}`, status: "completed", turn: { runId, status: "completed" } }] };
        emit({ type: "run.completed", runId });
        return;
      }
      const match = path.match(/\/runs\/([^/]+)\/approvals\/([^/]+)$/);
      if (!match) throw new Error(`unexpected stream:${path}`);
      const [, runId, approvalId] = match;
      const decision = input.approved ? "approved" : "rejected";
      emit({ type: "approval.decided", runId, approvalId, decision });
      durable = { ...durable, approvals: durable.approvals.map(item => item.id === approvalId
        ? { ...item, state: decision, continuationStatus: "completed" } : item) };
      emit({ type: "approval.settled", runId, approvalId, decision });
    });

    await act(async () => { await chat.send("first A4 draft"); });
    await act(async () => { await chat.respondApproval(false, chat.approvals.find(item => item.id === "approval-1")); });
    expect(chat.approvals.find(item => item.id === "approval-1")).toMatchObject({ state: "rejected", continuationStatus: "completed" });
    expect(chat.status).toBe("ready");
    await act(async () => { await chat.send("second A4 draft"); });
    expect(starts).toBe(2);
    await act(async () => { await chat.respondApproval(true, chat.approvals.find(item => item.id === "approval-2")); });
    // A late historical outcome still belongs to run-1, but it must not become
    // the active run while the canonical latest run is completed run-2.
    await act(async () => {
      secondEvents({ type: "approval.settled", runId: "run-1", approvalId: "approval-1", decision: "rejected" });
      await chat.synchronizeConversation();
    });
    expect(chat.approvals.map(({ id, state, continuationStatus }) => ({ id, state, continuationStatus }))).toEqual([
      { id: "approval-1", state: "rejected", continuationStatus: "completed" },
      { id: "approval-2", state: "approved", continuationStatus: "completed" },
    ]);
    expect(chat.messages.map(item => item.id)).toEqual(["assistant-run-1", "assistant-run-2"]);
    expect(chat.status).toBe("ready");
    expect(chat.runId).toBeNull();
    await act(async () => { await chat.send("prepare a decision", { taskIntent: { type: "decision_proposal" } }); });
    expect(starts).toBe(3);
    expect(mocks.consumeAgentStream.mock.calls.filter(([path]) => path.endsWith("/runs"))).toHaveLength(3);
    expect(mocks.consumeAgentStream.mock.calls.at(-1)[1].taskIntent).toEqual({ type: "decision_proposal" });
    expect(mocks.agentApi.queueInput).not.toHaveBeenCalled();
  });
});
