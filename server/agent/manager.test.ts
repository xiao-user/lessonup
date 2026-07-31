import { describe, expect, it } from "vitest";

import { managerModelSettings } from "./manager.js";

describe("LessonPreparationManager model settings", () => {
  it("keeps tool orchestration on Pro without long provider-native thinking", () => {
    expect(managerModelSettings).toEqual({
      temperature: 0.3,
      providerData: { thinking: { type: "disabled" } },
    });
  });
});
