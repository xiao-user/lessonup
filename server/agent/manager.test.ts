import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  agentsSdkVersion,
  managerModelSettings,
  specialistRunTracingConfig,
} from "./manager.js";

describe("LessonPreparationManager model settings", () => {
  it("keeps tool orchestration on Flash with low reasoning effort", () => {
    expect(managerModelSettings).toEqual({
      temperature: 0.3,
      reasoning: { effort: "low" },
      store: false,
    });
  });

  it("pins the persisted agent definition to the installed Agents SDK version", () => {
    const require = createRequire(import.meta.url);
    const entrypoint = require.resolve("@openai/agents");
    const installed = JSON.parse(
      readFileSync(join(dirname(entrypoint), "..", "package.json"), "utf8"),
    ) as { version: string };
    expect(agentsSdkVersion).toBe(installed.version);
  });

  it("keeps nested specialist traces free of model and tool payloads", () => {
    expect(specialistRunTracingConfig).toEqual({
      tracingDisabled: false,
      traceIncludeSensitiveData: false,
    });
  });
});
