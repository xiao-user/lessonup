import { describe, expect, it } from "vitest";
import { approvedPresentationGoalRequestSchema } from "./domain.js";
import { dashiGoalSchema } from "./dashi-goal.js";

const goal = {
  title: "一次函数课堂演示",
  goal: "直线为什么会这样变化？",
  themePack: "theme03" as const,
  slides: [{ layout: "theme03_page010", props: { title: "观察图象", points: ["标出两个点"] } }],
};

describe("Dashi presentation request", () => {
  it("requires a version-bound, teacher-approved native Dashi goal", () => {
    expect(approvedPresentationGoalRequestSchema.parse({
      expectedDocumentVersion: 3,
      goal,
    })).toMatchObject({ expectedDocumentVersion: 3, goal });
    expect(() => approvedPresentationGoalRequestSchema.parse({ expectedDocumentVersion: 3 })).toThrow();
  });

  it("stores Dashi's native goal without a LessonUp slide-outline schema", () => {
    expect(dashiGoalSchema.parse(goal).slides).toHaveLength(1);
    expect(() => dashiGoalSchema.parse({ ...goal, slides: [{ layout: "<script>", props: {} }] })).toThrow();
  });

  it("keeps Dashi validation technical and leaves classroom judgment to the compiler Agent", () => {
    expect(dashiGoalSchema.parse({
      ...goal,
      slides: [{ layout: "theme03_page010", props: { title: "学习目标" } }],
    }).slides).toHaveLength(1);
  });
});
