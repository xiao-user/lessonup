import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAgentChat } from "./use-agent-chat.js";

const mocks = vi.hoisted(() => ({
  agentApi: Object.fromEntries(["runtime", "listThreads", "listBranches", "getConversationSnapshot", "getLessonFile", "getRunCommand", "cancelRun"].map(name => [name, vi.fn()])),
  consumeAgentStream: vi.fn(),
}));
vi.mock("@/lib/agent-api", () => mocks);
let root, chat, durable;
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const run = { id: "run", threadId: "thread", branchId: "branch", status: "running" };
async function mount(onBeforeRun) {
  function Harness() {
    chat = useAgentChat({ notebookId: "n", lessonFileId: "f", documentVersion: 9,
      activeSectionId: "process", onBeforeRun, starterSuggestionsEnabled: false });
    return null;
  }
  await act(async () => root.render(React.createElement(Harness)));
}
beforeEach(() => {
  vi.resetAllMocks();
  const { window, document } = parseHTML("<html><body><div id='root'></div></body></html>");
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  window.localStorage = storage;
  window.sessionStorage = storage;
  vi.stubGlobal("sessionStorage", storage);
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.getElementById("root"));
  durable = { messages: [], approvals: [], events: [], latestRun: null };
  mocks.agentApi.runtime.mockResolvedValue({ agent: true });
  mocks.agentApi.listThreads.mockResolvedValue([{ id: "thread", status: "idle" }]);
  mocks.agentApi.listBranches.mockResolvedValue([{ id: "branch" }]);
  mocks.agentApi.getConversationSnapshot.mockImplementation(async () => durable);
  mocks.agentApi.getLessonFile.mockResolvedValue({ documentVersion: 9 });
  mocks.agentApi.getRunCommand.mockResolvedValue({ run: null });
});
afterEach(async () => { await act(async () => root.unmount()); vi.unstubAllGlobals(); });

describe("actual hook early cancellation", () => {
  it("skips POST when Stop happens while the editor is flushing", async () => {
    const flush = deferred();
    await mount(() => flush.promise);
    let sending;
    await act(async () => { sending = chat.send("teacher input"); });
    await act(async () => { await chat.stop(); });
    expect(mocks.consumeAgentStream).not.toHaveBeenCalled();
    await act(async () => { flush.resolve({ documentVersion: 9, document: {} }); await sending; });
    expect(mocks.consumeAgentStream).not.toHaveBeenCalled();
    expect(chat.status).toBe("ready");
    expect(chat.draft).toBe("teacher input");
  });

  it("does not abort pre-ack SSE and settles only after canonical cancellation", async () => {
    const stream = deferred();
    let event, signal, payload;
    mocks.consumeAgentStream.mockImplementation((_path, input, onEvent, options) => {
      event = onEvent; signal = options.signal; payload = input; return stream.promise;
    });
    await mount(async () => ({ documentVersion: 9, document: {} }));
    let sending;
    await act(async () => { sending = chat.send("teacher input"); });
    await act(async () => { await chat.stop(); });
    expect(signal.aborted).toBe(false);
    expect(chat.status).toBe("syncing");
    mocks.agentApi.getRunCommand.mockImplementation(async () => ({ run: { ...run, clientCommandId: payload.clientCommandId } }));
    mocks.agentApi.cancelRun.mockImplementation(async () => {
      durable = { ...durable, latestRun: { ...run, status: "cancelled" } }; return { cancelled: true };
    });
    await act(async () => {
      event({ type: "run.started", runId: "run", threadId: "thread", branchId: "branch" });
      await new Promise(resolve => setImmediate(resolve));
    });
    expect(mocks.agentApi.cancelRun).toHaveBeenCalledWith("run");
    expect(signal.aborted).toBe(true);
    expect(chat.status).toBe("ready");
    expect(mocks.consumeAgentStream).toHaveBeenCalledTimes(1);
    await act(async () => { stream.resolve(); await sending; });
  });

  it("restores pending cancellation after remount without resending", async () => {
    const stream = deferred();
    let payload;
    mocks.consumeAgentStream.mockImplementation((_path, input) => { payload = input; return stream.promise; });
    await mount(async () => ({ documentVersion: 9, document: {} }));
    let sending;
    await act(async () => { sending = chat.send("teacher input"); });
    await act(async () => { await chat.stop(); });
    expect(chat.status).toBe("syncing");
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("root"));
    mocks.agentApi.getRunCommand.mockResolvedValue({ run: { ...run, clientCommandId: payload.clientCommandId } });
    mocks.agentApi.cancelRun.mockImplementation(async () => {
      durable = { ...durable, latestRun: { ...run, status: "cancelled" } }; return { cancelled: true };
    });
    await mount();
    await act(async () => { await new Promise(resolve => setImmediate(resolve)); });
    expect(mocks.agentApi.getRunCommand).toHaveBeenCalledWith("thread", "branch", payload.clientCommandId);
    expect(mocks.agentApi.cancelRun).toHaveBeenCalledWith("run");
    expect(mocks.consumeAgentStream).toHaveBeenCalledTimes(1);
    expect(chat.status).toBe("ready");
    await act(async () => { stream.resolve(); await sending; });
  });
});
