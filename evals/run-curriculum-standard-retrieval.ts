/**
 * Scores curriculum-standard retrieval against curriculum-standard-cases.jsonl
 * using the production D1 read repository.
 *
 *   npm run eval:curriculum-standards [-- --remote] [--lexical-only]
 *
 * By default queries are embedded, as the native Pi `search_curriculum_standards`
 * tool does when an embedding service is configured. --lexical-only sends no
 * query vector: the tool's fallback when no service is configured or the call
 * fails, and a measure of how far text ranking alone gets.
 */
import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { z } from "zod";
import { config, hasEmbeddingProvider } from "../server/config.js";
import { ConfiguredEmbeddingProvider } from "../server/providers/embeddings.js";
import { D1CurriculumStandardReadRepository } from "../server/repositories/d1-curriculum-standard-repository.js";
import { d1TargetFromArguments, describeD1Target, openD1 } from "../scripts/lib/wrangler-d1.js";

const caseSchema = z.object({
  id: z.string().min(1),
  query: z.string().min(1),
  subject: z.string().min(1),
  stage: z.string().min(1),
  grade: z.string().min(1),
  expectedTitle: z.string().min(1),
  expectedSectionAny: z.array(z.string().min(1)).min(1),
  expectedPassageAll: z.array(z.string().min(1)).min(1),
  forbiddenSectionAny: z.array(z.string().min(1)).default([]),
  maximumRank: z.number().int().min(1).max(8),
});

const cases = (await readFile(new URL("./curriculum-standard-cases.jsonl", import.meta.url), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line) => caseSchema.parse(JSON.parse(line)));

const lexicalOnly = process.argv.includes("--lexical-only");
if (!lexicalOnly && !hasEmbeddingProvider) throw new Error("missing_required_environment:embedding_configuration");

const target = d1TargetFromArguments(process.argv.slice(2));
console.log(`目标：${describeD1Target(target)} · ${lexicalOnly ? "lexical-only" : "embedding"}`);
const d1 = await openD1(target);
const repository = new D1CurriculumStandardReadRepository(d1.db);
const results = [];
try {
  const vectors = lexicalOnly
    ? []
    : await new ConfiguredEmbeddingProvider().embed(cases.map((testCase) => testCase.query));

  for (const [index, testCase] of cases.entries()) {
    const candidates = await repository.searchCurriculumStandards({
      query: testCase.query,
      embedding: lexicalOnly ? undefined : vectors[index],
      subject: testCase.subject,
      stage: testCase.stage,
      grade: testCase.grade,
      limit: 8,
    });
    const targetIndex = candidates.findIndex((candidate) => (
      candidate.title.includes(testCase.expectedTitle)
      && testCase.expectedSectionAny.some((section) => (candidate.section ?? "").includes(section))
      && testCase.expectedPassageAll.every((term) => candidate.passage.includes(term))
    ));
    const rank = targetIndex < 0 ? null : targetIndex + 1;
    const crossSubjectLeakage = candidates.some((candidate) => (
      !candidate.title.includes(testCase.expectedTitle)
      && !candidate.title.includes("义务教育课程方案")
      && !candidate.title.includes(`${testCase.subject}课程标准`)
    ));
    const forbiddenSectionLeakage = candidates.some((candidate) => (
      testCase.forbiddenSectionAny.some((section) => (candidate.section ?? "").includes(section))
    ));
    const passed = rank !== null
      && rank <= testCase.maximumRank
      && !crossSubjectLeakage
      && !forbiddenSectionLeakage;
    const result = {
      id: testCase.id,
      passed,
      rank,
      maximumRank: testCase.maximumRank,
      crossSubjectLeakage,
      forbiddenSectionLeakage,
      top: candidates.slice(0, 3).map((candidate) => ({
        title: candidate.title,
        page: candidate.page,
        section: candidate.section,
        score: Number(candidate.score.toFixed(4)),
      })),
    };
    results.push(result);
    console.log(`${passed ? "PASS" : "FAIL"}\t${testCase.id}\trank=${rank ?? "missing"}`);
  }

} finally {
  await d1.close();
}

const hitAt1 = results.filter((result) => result.rank === 1).length / results.length;
const hitAt3 = results.filter((result) => result.rank !== null && result.rank <= 3).length / results.length;
const meanReciprocalRank = results.reduce((sum, result) => (
  sum + (result.rank == null ? 0 : 1 / result.rank)
), 0) / results.length;
const report = {
  generatedAt: new Date().toISOString(),
  target: describeD1Target(target),
  mode: lexicalOnly ? "lexical-only" : "embedding",
  indexModel: config.EMBEDDING_MODEL,
  caseCount: results.length,
  passed: results.filter((result) => result.passed).length,
  metrics: { hitAt1, hitAt3, meanReciprocalRank },
  results,
};
const outputDir = process.env.LESSONUP_EVAL_OUTPUT_DIR
  ? path.resolve(process.env.LESSONUP_EVAL_OUTPUT_DIR)
  : path.join(tmpdir(), "lessonup-evals");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "curriculum-standards-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(`报告：${path.join(outputDir, "curriculum-standards-latest.json")}`);
console.log(JSON.stringify(report.metrics));
if (report.passed !== report.caseCount) process.exitCode = 1;
