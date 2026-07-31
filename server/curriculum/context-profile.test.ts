import { describe, expect, it } from "vitest";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import { canonicalizeLessonContextProfile } from "./context-profile.js";

describe("canonicalizeLessonContextProfile", () => {
  it("canonicalizes trusted book metadata and accepts a node from that book", async () => {
    const repository = new MemoryLessonRepository();
    await expect(canonicalizeLessonContextProfile({
      repository,
      subject: "数学",
      profile: {
        textbookId: "textbook-math-bnu",
        unitNodeId: "ch1",
        lessonNodeId: "ch1-1",
        gradeLevel: "伪造年级",
      },
    })).resolves.toMatchObject({
      textbookId: "textbook-math-bnu",
      unitNodeId: "ch1",
      lessonNodeId: "ch1-1",
      gradeLevel: "高中年级",
      textbookEdition: "北师大版 · 高中年级 · 必修 第二册",
    });
  });

  it("rejects cross-subject and cross-book context ids", async () => {
    const repository = new MemoryLessonRepository();
    await expect(canonicalizeLessonContextProfile({
      repository,
      subject: "语文",
      profile: { textbookId: "textbook-math-bnu" },
    })).rejects.toThrow("curriculum_subject_mismatch");
    await expect(canonicalizeLessonContextProfile({
      repository,
      subject: "数学",
      profile: { textbookId: "textbook-math-bnu", unitNodeId: "u1" },
    })).rejects.toThrow("curriculum_unit_not_in_textbook");
    await expect(canonicalizeLessonContextProfile({
      repository,
      subject: "数学",
      stage: "初中",
      profile: { textbookId: "textbook-math-bnu" },
    })).rejects.toThrow("curriculum_stage_mismatch");
    await expect(canonicalizeLessonContextProfile({
      repository,
      subject: "数学",
      profile: {
        textbookId: "textbook-math-bnu",
        unitNodeId: "ch2",
        lessonNodeId: "ch1-1",
      },
    })).rejects.toThrow("curriculum_lesson_not_in_unit");
    await expect(canonicalizeLessonContextProfile({
      repository,
      subject: "数学",
      profile: {
        textbookId: "textbook-math-bnu",
        lessonNodeId: "ch1-1",
      },
    })).rejects.toThrow("curriculum_lesson_requires_unit");
  });
});
