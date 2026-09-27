import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { config, hasEmbeddingProvider } from "../server/config.js";
import { ConfiguredEmbeddingProvider } from "../server/providers/embeddings.js";

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

if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("missing_required_environment:SUPABASE_URL_or_SUPABASE_SERVICE_ROLE_KEY");
}
if (!hasEmbeddingProvider) throw new Error("missing_required_environment:embedding_configuration");

const client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const embeddings = new ConfiguredEmbeddingProvider();
const vectors = await embeddings.embed(cases.map((testCase) => testCase.query));
const results = [];

for (const [index, testCase] of cases.entries()) {
  const response = await client.rpc("search_curriculum_standards", {
    p_query: testCase.query,
    p_query_embedding: vectors[index],
    p_subject: testCase.subject,
    p_stage: testCase.stage,
    p_grade: testCase.grade,
    p_limit: 8,
  });
  if (response.error) throw new Error(`${testCase.id}:${response.error.message}`);
  const candidates = (response.data ?? []) as Array<{
    title: string;
    page: number;
    section: string;
    passage: string;
    score: number;
  }>;
  const targetIndex = candidates.findIndex((candidate) => (
    candidate.title.includes(testCase.expectedTitle)
    && testCase.expectedSectionAny.some((section) => candidate.section.includes(section))
    && testCase.expectedPassageAll.every((term) => candidate.passage.includes(term))
  ));
  const rank = targetIndex < 0 ? null : targetIndex + 1;
  const crossSubjectLeakage = candidates.some((candidate) => (
    !candidate.title.includes(testCase.expectedTitle)
    && !candidate.title.includes("义务教育课程方案")
    && !candidate.title.includes(`${testCase.subject}课程标准`)
  ));
  const forbiddenSectionLeakage = candidates.some((candidate) => (
    testCase.forbiddenSectionAny.some((section) => candidate.section.includes(section))
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

const hitAt1 = results.filter((result) => result.rank === 1).length / results.length;
const hitAt3 = results.filter((result) => result.rank !== null && result.rank <= 3).length / results.length;
const meanReciprocalRank = results.reduce((sum, result) => (
  sum + (result.rank == null ? 0 : 1 / result.rank)
), 0) / results.length;
const report = {
  generatedAt: new Date().toISOString(),
  indexModel: config.EMBEDDING_MODEL,
  caseCount: results.length,
  passed: results.filter((result) => result.passed).length,
  metrics: { hitAt1, hitAt3, meanReciprocalRank },
  results,
};
const outputDir = path.resolve("evals/results");
await mkdir(outputDir, { recursive: true });
await writeFile(path.join(outputDir, "curriculum-standards-latest.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report.metrics));
if (report.passed !== report.caseCount) process.exitCode = 1;
