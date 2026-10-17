import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

import type { DecisionRating } from "./decision-quality.js";

const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("./run-decision-quality.ts", import.meta.url));

it("exports then summarizes with documented argument ordering without modifying the key", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "decision-quality-cli-"));
  try {
    const casesFile = path.join(directory, "cases.json");
    const exportDirectory = path.join(directory, "export");
    const packetFile = path.join(exportDirectory, "packet.json");
    const keyFile = path.join(exportDirectory, "coordinator-key.json");
    const summaryFile = path.join(directory, "summary.json");
    await writeFile(casesFile, JSON.stringify({ cases: [{
      caseId: "case-1",
      decisionType: "verification",
      context: "Check independent student understanding.",
      baseline: "Ask students to repeat the explanation.",
      treatment: "Ask students to explain a new example independently.",
    }] }));

    const exported = await execFileAsync(process.execPath, ["--import", "tsx", cli, "export", casesFile, exportDirectory]);
    expect(exported.stdout).toContain("Exported 2 blinded decision briefs.");
    const originalKey = await readFile(keyFile);
    const template: DecisionRating[] = JSON.parse(await readFile(path.join(exportDirectory, "rating-template.json"), "utf8"));
    const ratingFiles = await Promise.all(["reviewer-a", "reviewer-b"].map(async (reviewerId) => {
      const file = path.join(directory, `${reviewerId}.json`);
      await writeFile(file, JSON.stringify(template.map((rating) => ({
        ...rating,
        reviewerId,
        expertise: { subject: "Language", stage: "Primary", experience: "10 years" },
        dimensions: Object.fromEntries(Object.keys(rating.dimensions).map((dimension) => [
          dimension, { score: 2, evidence: "The brief names a check of student understanding." },
        ])),
      }))));
      return file;
    }));

    const summarized = await execFileAsync(process.execPath, [
      "--import", "tsx", cli, "summarize", packetFile, keyFile, summaryFile, ...ratingFiles,
    ]);
    expect(JSON.parse(summarized.stdout)).toMatchObject({ status: "reviewed", meanDifference: 0 });
    const summary = JSON.parse(await readFile(summaryFile, "utf8"));
    expect(summary).toMatchObject({
      packetId: template[0].packetId,
      packetFingerprint: template[0].packetFingerprint,
      status: "reviewed",
      incompleteSamples: [],
      cases: [{ caseId: "case-1", baseline: 2, treatment: 2, difference: 0 }],
      summary: { baselineAverage: 2, treatmentAverage: 2, meanDifference: 0, direction: "equal", agreement: { decision_clarity: null } },
    });
    expect(await readFile(keyFile)).toEqual(originalKey);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
