import { describe, expect, it } from "vitest";
import { RunEventDispatcher } from "./run-event-dispatcher.js";

describe("RunEventDispatcher", () => {
  it("makes durable persistence the visibility barrier and preserves order", async () => {
    let releasePersistence!: () => void;
    const gate = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const streamed: string[] = [];
    const persisted: string[] = [];
    const dispatcher = new RunEventDispatcher(
      async (event: string) => { streamed.push(event); },
      async (event: string) => {
        await gate;
        persisted.push(event);
      },
    );

    dispatcher.dispatch("first");
    dispatcher.dispatch("second");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(streamed).toEqual([]);
    expect(persisted).toEqual([]);

    releasePersistence();
    expect(await dispatcher.flush()).toEqual([]);
    expect(persisted).toEqual(["first", "second"]);
  });

  it("does not expose later events after a durable journal gap", async () => {
    const persisted: string[] = [];
    const dispatcher = new RunEventDispatcher(
      async () => undefined,
      async (event: string) => {
        if (event === "first") throw new Error("temporary failure");
        persisted.push(event);
      },
    );

    dispatcher.dispatch("first");
    dispatcher.dispatch("second");
    expect(await dispatcher.flush()).toHaveLength(1);
    expect(persisted).toEqual([]);
  });
});
