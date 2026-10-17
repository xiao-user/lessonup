import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  createDecisionPacket,
  decisionAnchors,
  decisionDimensions,
  summarizeDecisionReviews,
} from "./decision-quality.js";

const [mode, input, output, keyFile, ...ratingFiles] = process.argv.slice(2);
const usage = "usage: npm run eval:decision-quality -- export <cases.json> <new-output-directory> | summarize <packet.json> <key.json> <new-summary.json> <ratings.json>...";
if (!input || !output || !["export", "summarize"].includes(mode ?? "")) throw new Error(usage);

const read = async (file: string) => JSON.parse(await readFile(path.resolve(file), "utf8"));

if (mode === "export") {
  const { packet, key } = createDecisionPacket(await read(input));
  const directory = path.resolve(output);
  await mkdir(directory, { mode: 0o700 });
  await Promise.all([
    writeFile(path.join(directory, "packet.json"), JSON.stringify(packet, null, 2)),
    writeFile(path.join(directory, "coordinator-key.json"), JSON.stringify(key, null, 2), { mode: 0o600 }),
    writeFile(path.join(directory, "rubric.json"), JSON.stringify({
      packetFingerprint: key.packetFingerprint,
      dimensions: decisionDimensions,
      anchors: decisionAnchors,
      instructions: "对每份匿名简报独立打 0–3 分；证据必须可定位。任一维度相差两级以上进入仲裁，不要用平均分掩盖分歧。",
      boundary: "内部专家代理评审，不等于外部专家共识、课堂实施或学生学习效果。",
    }, null, 2)),
    writeFile(path.join(directory, "rating-template.json"), JSON.stringify(packet.samples.map((sample) => ({
      packetId: packet.packetId,
      packetFingerprint: key.packetFingerprint,
      sampleId: sample.sampleId,
      reviewerId: "",
      expertise: { subject: "", stage: "", experience: "" },
      dimensions: Object.fromEntries(decisionDimensions.map((dimension) => [dimension, { score: null, evidence: "" }])),
      criticalFindings: [],
    })), null, 2)),
  ]);
  console.log(`Exported ${packet.samples.length} blinded decision briefs. Keep coordinator-key.json away from reviewers.`);
} else {
  if (!keyFile) throw new Error(usage);
  const ratings = (await Promise.all(ratingFiles.map(read))).flat();
  const report = summarizeDecisionReviews(await read(input), await read(keyFile), ratings);
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({
    status: report.status,
    meanDifference: report.summary.meanDifference,
    differenceInterval: report.summary.differenceInterval,
    disagreements: report.disagreements.length,
    criticalFindings: report.criticalFindings.length,
  }));
  if (report.status === "needs_adjudication" || report.status === "pending") process.exitCode = 1;
}
