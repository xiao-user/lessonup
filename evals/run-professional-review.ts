import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProfessionalPacket, professionalAnchors, summarizeProfessionalReviews } from "./professional-review.js";

const [mode, input, output, ...ratingFiles] = process.argv.slice(2);
if (!input || !output || !["export", "summarize"].includes(mode ?? "")) throw new Error("usage: npm run eval:professional -- export <agent-results.json> <new-output-directory> | summarize <packet.json> <new-summary.json> <ratings.json>...");
const read = async (file: string) => JSON.parse(await readFile(path.resolve(file), "utf8"));
if (mode === "export") {
  const { packet, key } = createProfessionalPacket(await read(input));
  const directory = path.resolve(output);
  await mkdir(directory, { mode: 0o700 }); // Never overwrite a review packet or its mapping.
  await Promise.all([
    writeFile(path.join(directory, "packet.json"), JSON.stringify(packet, null, 2)),
    writeFile(path.join(directory, "coordinator-key.json"), JSON.stringify(key, null, 2), { mode: 0o600 }),
    writeFile(path.join(directory, "rubric.json"), JSON.stringify({ packetFingerprint: key.packetFingerprint, anchors: professionalAnchors }, null, 2)),
    writeFile(path.join(directory, "rating-template.json"), JSON.stringify(packet.samples.map((sample) => ({
      packetId: packet.packetId, packetFingerprint: key.packetFingerprint, sampleId: sample.sampleId,
      reviewerId: "", authorType: "human", independent: true, expertise: { subject: "", stage: "", experience: "" },
      dimensions: Object.fromEntries(Object.keys(professionalAnchors).map((key) => [key, { score: null, evidence: "" }])), criticalFindings: [],
    })), null, 2)),
  ]);
  console.log(`Exported ${packet.samples.length} blinded samples. Keep coordinator-key.json separate from reviewers.`);
} else {
  const ratings = (await Promise.all(ratingFiles.map(read))).flat();
  const report = summarizeProfessionalReviews(await read(input), ratings);
  await writeFile(path.resolve(output), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ passed: report.passed, samples: report.samples.map(({ sampleId, status, reviewers }) => ({ sampleId, status, reviewers })) }));
  if (!report.passed) process.exitCode = 1;
}
