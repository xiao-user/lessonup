import { describe, expect, it, vi } from "vitest";
import { clearPendingCancellation, persistPendingCancellation, readPendingCancellation, reconcileCancellation } from "./run-cancellation.js";
const command = { threadId: "thread", branchId: "branch", clientCommandId: "command" };
const run = { ...command, id: "run", status: "running" };
const ports = (status = "cancelled") => ({
  getRunCommand: vi.fn().mockResolvedValue({ run }),
  cancelRun: vi.fn().mockResolvedValue({ cancelled: true }),
  loadMessages: vi.fn().mockResolvedValue({ presentation: { run: { ...run, status } } }),
});
describe("pending run cancellation", () => {
  it("keeps a pre-acknowledgment command pending without cancelling another run or starting anything", async () => {
    const api = ports(); api.getRunCommand.mockResolvedValue({ run: null });
    expect(await reconcileCancellation(command, api)).toEqual({ phase: "cancel_pending" });
    expect(api.cancelRun).not.toHaveBeenCalled(); expect(api.loadMessages).not.toHaveBeenCalled();
  });
  it("waits for canonical terminal state even when cancel replies 200", async () => {
    const api = ports("running");
    expect(await reconcileCancellation(command, api)).toMatchObject({ phase: "cancel_pending" });
    expect(api.cancelRun).toHaveBeenCalledWith("run");
  });
  it("recognizes a lost cancel reply only after canonical cancellation is observed", async () => {
    const api = ports(); api.cancelRun.mockRejectedValue(new Error("network"));
    expect(await reconcileCancellation(command, api)).toMatchObject({ phase: "terminal", run: { status: "cancelled" } });
  });
  it("preserves completed instead of pretending a completion race was cancelled", async () => {
    expect(await reconcileCancellation(command, ports("completed"))).toMatchObject({ phase: "terminal", run: { status: "completed" } });
  });
  it("rejects mismatched command/branch receipts", async () => {
    const api = ports(); api.getRunCommand.mockResolvedValue({ run: { ...run, branchId: "other" } });
    expect(await reconcileCancellation(command, api)).toEqual({ phase: "cancel_pending" });
    expect(api.cancelRun).not.toHaveBeenCalled();
  });
  it("restores pending cancellation across reload without persisting prompts or transport objects", () => {
    const values = new Map(); const storage = { getItem: key => values.get(key), setItem: (key,value) => values.set(key,value), removeItem: key => values.delete(key) };
    persistPendingCancellation({ ...command, prompt: "private", controller: {} }, storage);
    expect(readPendingCancellation("thread", "branch", storage)).toEqual(command);
    expect(readPendingCancellation("thread", "other", storage)).toBeNull();
    clearPendingCancellation("thread", "branch", storage);
    expect(readPendingCancellation("thread", "branch", storage)).toBeNull();
  });
});
