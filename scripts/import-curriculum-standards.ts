import "dotenv/config";
import { createHash } from "node:crypto";
import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { parseCurriculumStandardManifest, type CurriculumStandardManifest } from "../server/curriculum/standard-manifest.js";
import { deterministicUuid } from "../server/curriculum/knowledge-sample.js";
import { parseKnowledgeBytes, withAbortTimeout } from "../server/knowledge/worker.js";

const defaultSourceDir = "data/curriculum/standards/inbox";
const defaultManifestPath = "data/curriculum/standards/manifest.local.json";
const maximumPdfBytes = 50 * 1024 * 1024;
const parseTimeoutMs = 90_000;

type Action = "init" | "validate" | "import" | "status" | "publish";

function readArguments(argv: string[]) {
  const action = (argv[0] ?? "validate") as Action;
  if (!["init", "validate", "import", "status", "publish"].includes(action)) {
    throw new Error(`curriculum_standard_action_invalid:${action}`);
  }
  const valueAfter = (flag: string) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    action,
    sourceDir: path.resolve(valueAfter("--source") ?? defaultSourceDir),
    manifestPath: path.resolve(valueAfter("--manifest") ?? defaultManifestPath),
    storePdf: argv.includes("--store-pdf"),
  };
}

async function listPdfFilenames(sourceDir: string) {
  return (await readdir(sourceDir, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".pdf"))
    .map((entry) => entry.name.normalize("NFKC"))
    .sort((left, right) => left.localeCompare(right, "zh-CN"));
}

function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function initializeManifest(sourceDir: string, manifestPath: string) {
  const filenames = await listPdfFilenames(sourceDir);
  if (!filenames.length) throw new Error(`curriculum_standard_pdfs_missing:${sourceDir}`);
  try {
    await stat(manifestPath);
    throw new Error(`curriculum_standard_manifest_exists:${manifestPath}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("curriculum_standard_manifest_exists")) throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
  }
  const manifest = {
    schemaVersion: 1,
    release: {
      seriesKey: "national-curriculum-standards",
      releaseKey: "national-curriculum-standards-2022-v1",
      title: "国家课程标准（请核对版本）",
      versionLabel: "待填写",
      authority: "中华人民共和国教育部",
      issuedYear: null,
    },
    documents: filenames.map((filename) => ({
      filename,
      title: filename.replace(/\.pdf$/i, ""),
      subject: "待填写",
      stageScope: ["待填写"],
      gradeScope: [] as string[],
      standardCode: "",
      sourceUrl: "",
    })),
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  console.log(`已生成 ${manifestPath}`);
  console.log(`共发现 ${filenames.length} 份 PDF。请补全清单元数据后运行 curriculum:standards:validate。`);
}

async function loadManifest(manifestPath: string) {
  const raw = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
  return parseCurriculumStandardManifest(raw);
}

type ValidatedPdf = {
  document: CurriculumStandardManifest["documents"][number];
  absolutePath: string;
  bytes: Buffer;
  sha256: string;
  chunkCount: number;
};

async function validateFiles(sourceDir: string, manifest: CurriculumStandardManifest, deep = true) {
  const actual = await listPdfFilenames(sourceDir);
  const expected = manifest.documents.map((document) => document.filename).sort((a, b) => a.localeCompare(b, "zh-CN"));
  const missing = expected.filter((filename) => !actual.includes(filename));
  const unexpected = actual.filter((filename) => !expected.includes(filename));
  if (missing.length || unexpected.length) {
    throw new Error(`curriculum_standard_file_set_mismatch:${JSON.stringify({ missing, unexpected })}`);
  }

  const validated: ValidatedPdf[] = [];
  for (const [index, document] of manifest.documents.entries()) {
    const absolutePath = path.join(sourceDir, document.filename);
    const bytes = await readFile(absolutePath);
    if (bytes.length === 0) throw new Error(`curriculum_standard_pdf_empty:${document.filename}`);
    if (bytes.length > maximumPdfBytes) throw new Error(`curriculum_standard_pdf_too_large:${document.filename}`);
    if (bytes.subarray(0, 5).toString("ascii") !== "%PDF-") {
      throw new Error(`curriculum_standard_pdf_signature_invalid:${document.filename}`);
    }
    let chunkCount = 0;
    if (deep) {
      const parsed = await withAbortTimeout(
        (signal) => parseKnowledgeBytes("application/pdf", bytes, signal),
        parseTimeoutMs,
      );
      chunkCount = parsed.chunks.length;
      if (!chunkCount) throw new Error(`curriculum_standard_pdf_text_missing:${document.filename}`);
    }
    validated.push({ document, absolutePath, bytes, sha256: sha256(bytes), chunkCount });
    console.log(`[${index + 1}/${manifest.documents.length}] ${document.filename} · ${(bytes.length / 1024 / 1024).toFixed(1)} MB${deep ? ` · ${chunkCount} 个解析片段` : ""}`);
  }
  return validated;
}

function serviceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("curriculum_standard_supabase_not_configured");
  return createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });
}

async function importRelease(manifest: CurriculumStandardManifest, files: ValidatedPdf[]) {
  const client = serviceClient();
  const releaseId = deterministicUuid("lessonup:curriculum-standard-release", manifest.release.releaseKey);
  for (const [index, file] of files.entries()) {
    const sourceId = deterministicUuid(releaseId, `${file.document.filename}:${file.sha256}`);
    const storageKey = `curriculum-standards/${manifest.release.releaseKey}/${file.sha256}.pdf`;
    const upload = await client.storage.from("knowledge-private").upload(storageKey, file.bytes, {
      contentType: "application/pdf",
      cacheControl: "31536000",
      upsert: true,
    });
    if (upload.error) throw new Error(`curriculum_standard_upload_failed:${file.document.filename}:${upload.error.message}`);
    const result = await client.rpc("upsert_curriculum_standard_document", {
      p_release: { ...manifest.release, id: releaseId, expectedDocumentCount: manifest.documents.length },
      p_document: file.document,
      p_source_id: sourceId,
      p_storage_key: storageKey,
      p_file_sha256: file.sha256,
    });
    if (result.error) throw new Error(`curriculum_standard_enqueue_failed:${file.document.filename}:${result.error.message}`);
    console.log(`[${index + 1}/${files.length}] 已入队 ${file.document.filename}`);
  }
  console.log("导入完成。保持知识 Worker 运行，并使用 curriculum:standards:status 查看索引进度。");
}

async function getRelease(manifest: CurriculumStandardManifest) {
  const client = serviceClient();
  const releaseResult = await client.from("curriculum_standard_releases")
    .select("id,release_key,title,status,expected_document_count,published_at")
    .eq("release_key", manifest.release.releaseKey)
    .maybeSingle();
  if (releaseResult.error) throw new Error(releaseResult.error.message);
  if (!releaseResult.data) throw new Error("curriculum_standard_release_not_imported");
  const documentsResult = await client.from("curriculum_standard_documents")
    .select("filename,title,subject,stage_scope,knowledge_source_id")
    .eq("release_id", releaseResult.data.id)
    .order("filename");
  if (documentsResult.error) throw new Error(documentsResult.error.message);
  const sourceIds = (documentsResult.data ?? []).map((item) => item.knowledge_source_id);
  const sourceResult = sourceIds.length
    ? await client.from("knowledge_sources").select("id,status,last_error,index_version,metadata").in("id", sourceIds)
    : { data: [], error: null };
  if (sourceResult.error) throw new Error(sourceResult.error.message);
  const sourceById = new Map((sourceResult.data ?? []).map((source) => [source.id, source]));
  return {
    client,
    release: releaseResult.data,
    documents: (documentsResult.data ?? []).map((document) => ({
      ...document,
      source: sourceById.get(document.knowledge_source_id) ?? null,
    })),
  };
}

async function showStatus(manifest: CurriculumStandardManifest) {
  const { release, documents } = await getRelease(manifest);
  console.log(`${release.title} · ${release.status} · ${documents.length}/${release.expected_document_count}`);
  for (const document of documents) {
    console.log(`${document.source?.status ?? "missing"}\t${document.subject}\t${document.filename}${document.source?.last_error ? `\t${document.source.last_error}` : ""}`);
  }
}

async function publishRelease(manifest: CurriculumStandardManifest) {
  const { client } = await getRelease(manifest);
  const result = await client.rpc("publish_curriculum_standard_release", {
    p_release_key: manifest.release.releaseKey,
  });
  if (result.error) throw new Error(`curriculum_standard_publish_failed:${result.error.message}`);
  console.log(`已原子发布：${manifest.release.title}`);
}

const args = readArguments(process.argv.slice(2));
if (args.action === "init") {
  await initializeManifest(args.sourceDir, args.manifestPath);
} else {
  const manifest = await loadManifest(args.manifestPath);
  if (args.action === "validate") {
    const files = await validateFiles(args.sourceDir, manifest, true);
    console.log(`校验通过：${files.length} 份 PDF，发布键 ${manifest.release.releaseKey}`);
  } else if (args.action === "import") {
    if (!args.storePdf) {
      throw new Error("curriculum_standard_raw_pdf_storage_requires_explicit_--store-pdf");
    }
    const files = await validateFiles(args.sourceDir, manifest, true);
    await importRelease(manifest, files);
  } else if (args.action === "status") {
    await showStatus(manifest);
  } else {
    await publishRelease(manifest);
  }
}
