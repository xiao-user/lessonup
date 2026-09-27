import { describe, expect, it } from "vitest";
import { parseCurriculumStandardManifest } from "./standard-manifest.js";

const manifest = {
  schemaVersion: 1,
  release: {
    seriesKey: "national-curriculum-standards",
    releaseKey: "national-curriculum-standards-2022-v1",
    title: "国家课程标准",
    versionLabel: "2022年版",
    authority: "教育部",
    issuedYear: 2022,
  },
  documents: [{
    filename: "语文.pdf",
    title: "义务教育语文课程标准",
    subject: "语文",
    stageScope: ["小学", "初中"],
    gradeScope: ["七年级"],
    standardCode: "",
    sourceUrl: "",
  }],
};

describe("curriculum standard manifest", () => {
  it("accepts complete versioned metadata", () => {
    expect(parseCurriculumStandardManifest(manifest).documents[0]?.subject).toBe("语文");
  });

  it("rejects generated placeholders and duplicate filenames", () => {
    expect(() => parseCurriculumStandardManifest({
      ...manifest,
      documents: [
        { ...manifest.documents[0], subject: "待填写" },
        { ...manifest.documents[0] },
      ],
    })).toThrow();
  });

  it("rejects an unfinished release header", () => {
    expect(() => parseCurriculumStandardManifest({
      ...manifest,
      release: { ...manifest.release, versionLabel: "待填写" },
    })).toThrow();
  });
});
