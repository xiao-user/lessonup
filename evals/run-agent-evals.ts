import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { resolveEvalGraderConfig } from "./config.js";
import { gradeBusinessResponse } from "./grading.js";

type EvalCase = {
  id: string;
  prompt: string;
  requiredAnyTools?: string[];
  requiredTools?: string[];
  forbiddenTools?: string[];
  requiresApproval: boolean;
  requiresSource: boolean;
  rubric: string[];
  minimumRubricScore?: number;
  requireDocumentGrounding?: boolean;
  rejectGeneric?: boolean;
  rejectUnsupportedPrecision?: boolean;
};

type AgentEvent = {
  type: string;
  runId?: string;
  name?: string;
  approvalId?: string;
  source?: { id?: string };
  error?: string;
  patch?: unknown;
};

const requiredEnvironment = [
  "LESSONUP_EVAL_ACCESS_TOKEN",
  "LESSONUP_EVAL_NOTEBOOK_ID",
  "LESSONUP_EVAL_LESSON_FILE_ID",
] as const;

for (const name of requiredEnvironment) {
  if (!process.env[name]) {
    throw new Error(`missing_required_environment:${name}`);
  }
}

const baseUrl = process.env.LESSONUP_EVAL_BASE_URL ?? "http://127.0.0.1:8787";
const headers = {
  authorization: `Bearer ${process.env.LESSONUP_EVAL_ACCESS_TOKEN}`,
  "content-type": "application/json",
};
const graderConfig = resolveEvalGraderConfig(process.env);
const grader = new OpenAI({
  apiKey: graderConfig.apiKey,
  baseURL: graderConfig.baseURL,
});

async function request<T>(pathname: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { ...headers, ...init.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `request_failed:${response.status}`);
  }
  return response.status === 204 ? null as T : response.json() as Promise<T>;
}

async function consumeSse(pathname: string, body: unknown) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: { ...headers, accept: "text/event-stream" },
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) throw new Error(`stream_failed:${response.status}`);

  const events: AgentEvent[] = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (data) events.push(JSON.parse(data) as AgentEvent);
      boundary = buffer.indexOf("\n\n");
    }
    if (done) break;
  }
  return events;
}

const caseSource = await readFile(new URL("./cases.jsonl", import.meta.url), "utf8");
const cases = caseSource.split("\n").filter(Boolean).map((line) => JSON.parse(line) as EvalCase);
const results = [];

for (const testCase of cases) {
  const created = await request<{
    thread: { id: string };
    branch: { id: string };
  }>("/api/agent/threads", {
    method: "POST",
    body: JSON.stringify({
      notebookId: process.env.LESSONUP_EVAL_NOTEBOOK_ID,
      lessonFileId: process.env.LESSONUP_EVAL_LESSON_FILE_ID,
      title: `Eval · ${testCase.id}`,
    }),
  });

  let events: AgentEvent[] = [];
  let lessonFile: { documentVersion: number; document: unknown } | undefined;
  let assistantResponse = "";
  try {
    lessonFile = await request<{ documentVersion: number; document: unknown }>(
      `/api/lesson-files/${process.env.LESSONUP_EVAL_LESSON_FILE_ID}`,
    );
    events = await consumeSse(`/api/agent/threads/${created.thread.id}/runs`, {
      branchId: created.branch.id,
      message: testCase.prompt,
      activeSectionId: "basics",
      documentVersion: lessonFile.documentVersion,
    });
    const messages = await request<Array<{ role: string; content: string }>>(
      `/api/agent/threads/${created.thread.id}/messages?branchId=${created.branch.id}`,
    );
    assistantResponse = [...messages].reverse()
      .find((message) => message.role === "assistant")?.content ?? "";
    const approval = events.find((event) => event.type === "approval.required");
    if (!assistantResponse && approval?.patch) {
      assistantResponse = `待审批修改：${JSON.stringify(approval.patch)}`;
    }
    if (approval?.approvalId && approval.runId) {
      await consumeSse(
        `/api/agent/runs/${approval.runId}/approvals/${approval.approvalId}`,
        { approved: false },
      );
    }
  } finally {
    await request(`/api/agent/threads/${created.thread.id}`, { method: "DELETE" }).catch(() => null);
  }

  const toolNames = events
    .filter((event) => event.type === "tool.started" && event.name)
    .map((event) => event.name as string);
  const failures: string[] = [];
  for (const tool of testCase.requiredTools ?? []) {
    if (!toolNames.includes(tool)) failures.push(`missing_required_tool:${tool}`);
  }
  if (testCase.requiredAnyTools?.length && !testCase.requiredAnyTools.some((tool) => toolNames.includes(tool))) {
    failures.push(`missing_required_tool_group:${testCase.requiredAnyTools.join("|")}`);
  }
  for (const tool of testCase.forbiddenTools ?? []) {
    if (toolNames.includes(tool)) failures.push(`forbidden_tool:${tool}`);
  }
  const hasApproval = events.some((event) => event.type === "approval.required");
  if (hasApproval !== testCase.requiresApproval) failures.push(`approval_mismatch:${hasApproval}`);
  const hasSource = events.some((event) => event.type === "source.added");
  if (testCase.requiresSource && !hasSource) failures.push("missing_source");
  if (events.some((event) => event.type === "run.failed")) failures.push("run_failed");
  const businessGrade = await gradeBusinessResponse({
    client: grader,
    model: graderConfig.model,
    prompt: testCase.prompt,
    response: assistantResponse,
    document: lessonFile?.document,
    rubric: {
      criteria: testCase.rubric,
      minimumScore: testCase.minimumRubricScore ?? 0.75,
      requireDocumentGrounding: testCase.requireDocumentGrounding,
      rejectGeneric: testCase.rejectGeneric,
      rejectUnsupportedPrecision: testCase.rejectUnsupportedPrecision,
    },
    observed: { toolNames, hasApproval, hasSource },
  });
  failures.push(...businessGrade.failures);

  results.push({
    id: testCase.id,
    passed: failures.length === 0,
    failures,
    observed: {
      toolNames,
      hasApproval,
      hasSource,
      terminalEvent: events.at(-1)?.type,
    },
    assistantResponse,
    businessGrade,
  });
}

const output = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  cases: results,
  passed: results.filter((result) => result.passed).length,
  total: results.length,
};
const resultsDir = path.resolve("evals/results");
await mkdir(resultsDir, { recursive: true });
await writeFile(path.join(resultsDir, "latest.json"), `${JSON.stringify(output, null, 2)}\n`);
console.log(`Agent evals: ${output.passed}/${output.total} automated gates passed.`);
for (const result of results) {
  console.log(`${result.passed ? "PASS" : "FAIL"} ${result.id}${result.failures.length ? ` ${result.failures.join(",")}` : ""}`);
}
if (output.passed !== output.total) process.exitCode = 1;
