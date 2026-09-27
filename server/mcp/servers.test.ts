import { describe, expect, it } from "vitest";
import {
  CURRICULUM_STANDARD_RETRIEVAL_VERSION,
  curriculumStandardSearchCacheIdentity,
  normalizedCurriculumStandardQuery,
  searchScopedCurriculumStandards,
} from "./servers.js";
import { MemoryLessonRepository } from "../repositories/memory-repository.js";
import type { McpScope } from "../security/mcp-token.js";

describe("curriculum standard search cache identity", () => {
  it("pins the current grade-aware retrieval contract", () => {
    expect(CURRICULUM_STANDARD_RETRIEVAL_VERSION).toBe("grade-aware-v2");
  });

  it("reuses whitespace-equivalent queries in the same published scope", () => {
    const first = curriculumStandardSearchCacheIdentity({
      releaseFingerprint: "release-v1",
      subject: "数学",
      stage: "初中",
      grade: "七年级",
      query: "理解负数的意义  并比较有理数",
    });
    const second = curriculumStandardSearchCacheIdentity({
      releaseFingerprint: "release-v1",
      subject: "数学",
      stage: "初中",
      grade: "七年级",
      query: "  理解负数的意义 并比较有理数  ",
    });
    expect(normalizedCurriculumStandardQuery("  负数\n意义  ")).toBe("负数 意义");
    expect(second).toEqual(first);
  });

  it("invalidates reuse when the release or verified lesson scope changes", () => {
    const baseline = curriculumStandardSearchCacheIdentity({
      releaseFingerprint: "release-v1",
      subject: "数学",
      stage: "初中",
      grade: "七年级",
      query: "负数",
    });
    const changedRelease = curriculumStandardSearchCacheIdentity({
      releaseFingerprint: "release-v2",
      subject: "数学",
      stage: "初中",
      grade: "七年级",
      query: "负数",
    });
    const changedGrade = curriculumStandardSearchCacheIdentity({
      releaseFingerprint: "release-v1",
      subject: "数学",
      stage: "初中",
      grade: "八年级",
      query: "负数",
    });
    expect(changedRelease.contextFingerprint).not.toBe(baseline.contextFingerprint);
    expect(changedGrade.contextFingerprint).not.toBe(baseline.contextFingerprint);
    expect(changedRelease.querySha256).toBe(baseline.querySha256);
  });

  it("skips both embedding and retrieval when the latest exact result is cached", async () => {
    const repository = new MemoryLessonRepository();
    const userId = "00000000-0000-4000-8000-00000000000a";
    await repository.createNotebook(userId, {
      title: "七年级数学",
      className: "七年级一班",
      year: "2026",
      subject: "数学",
      stage: "初中",
      grade: "七年级",
      edition: "人教版",
      tone: "teal",
    }).then(async (notebook) => {
      let embedCalls = 0;
      let searchCalls = 0;
      repository.searchCurriculumStandards = async () => {
        searchCalls += 1;
        return [{
          id: "standard-1",
          title: "义务教育数学课程标准",
          kind: "public",
          passage: "理解负数的意义。",
          score: 1,
          section: "四、课程内容",
        }];
      };
      repository.recordRunEvidence = async () => undefined;
      const scope: McpScope = {
        userId,
        runId: "00000000-0000-4000-8000-00000000000b",
        notebookId: notebook.id,
        lessonFileId: "file-1",
        allowedKnowledgeScopes: ["public"],
        attachmentSourceIds: [],
      };
      const embed = async () => { embedCalls += 1; return Array(1024).fill(0); };
      const first = await searchScopedCurriculumStandards({
        repository, scope, query: "理解负数的意义  并比较有理数", limit: 6, embed,
      });
      const second = await searchScopedCurriculumStandards({
        repository, scope, query: "  理解负数的意义 并比较有理数  ", limit: 6, embed,
      });
      expect(first.freshness).toBe("retrieved");
      expect(second.freshness).toBe("reused");
      expect(second.results).toEqual(first.results);
      expect(embedCalls).toBe(1);
      expect(searchCalls).toBe(1);
    });
  });
});
