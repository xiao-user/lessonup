import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { dashiGoalSchema, type DashiGoal } from "./dashi-goal.js";

const execFileAsync = promisify(execFile);
const installedSkillRoot = fileURLToPath(new URL("../agent/skills/dashi-ppt/", import.meta.url));
const installedProjectRoot = path.join(installedSkillRoot, "project");
const installedRenderScript = path.join(installedSkillRoot, "scripts", "render_goal_deck.sh");
const installedPreviewScript = path.join(installedProjectRoot, "scripts", "start-preview-server.mjs");
const installedLayoutQueryScript = path.join(installedProjectRoot, "scripts", "layout-query.mjs");
const installedInspectLayoutScript = path.join(installedProjectRoot, "scripts", "inspect-layout.mjs");
const installedPropsSafeScript = path.join(installedProjectRoot, "scripts", "write-safe-props.mjs");
const installedGoalValidationScript = path.join(installedProjectRoot, "scripts", "validate-goal-spec.mjs");
const defaultDeckRoot = path.join(tmpdir(), "lessonup-dashi-decks");

export type NativeDashiDeck = {
  deckKey: string;
  previewUrl: string;
  checksum: string;
  pageCount: number;
};

export type NativeDashiBundle = {
  files: Array<{ path: string; body: Uint8Array }>;
  byteSize: number;
};

type PreviewState = { httpUrl?: string };

function deckWorkspace(root: string, presentationId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(presentationId)) throw new Error("presentation_id_invalid");
  return path.join(root, presentationId);
}

function safeBundlePath(value: string) {
  const normalized = value.replaceAll("\\", "/");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("presentation_bundle_path_invalid");
  }
  return normalized;
}

function nativeError(stage: string, cause?: unknown) {
  const commandError = cause as { stderr?: unknown; stdout?: unknown } | undefined;
  const detail = [commandError?.stderr, commandError?.stdout]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .slice(0, 8_000);
  const classifiedStage = stage === "render" && /validate:goal-copy/i.test(detail)
    ? "copy_validation"
    : stage === "render" && /validate:goal-spec/i.test(detail)
      ? "goal_validation"
      : stage === "render" && /npm run props:safe/i.test(detail)
        ? "props_validation"
        : stage;
  const error = new Error(`dashi_native_${classifiedStage}_failed`, { cause }) as Error & { detail?: string };
  if (detail) error.detail = detail;
  return error;
}

export class NativeDashiPptSkill {
  constructor(private readonly decksRoot = defaultDeckRoot) {}

  private async run(
    executable: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal; timeout?: number; stage: string },
  ) {
    if (options.signal?.aborted) throw new Error("presentation_cancelled");
    try {
      return await execFileAsync(executable, args, {
        cwd: options.cwd,
        signal: options.signal,
        timeout: options.timeout ?? 300_000,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          ...process.env,
          // LessonUp itself uses PORT=8787. Dashi's native preview daemon
          // honors PORT before its CLI argument, so clear the inherited API
          // port and let Dashi's own scanner pass its chosen preview port.
          PORT: "",
          INIT_CWD: options.cwd,
          DASHI_PPT_PREVIEW_PORT: "5200",
        },
      });
    } catch (error) {
      if (options.signal?.aborted) throw new Error("presentation_cancelled", { cause: error });
      throw nativeError(options.stage, error);
    }
  }

  private async ensureOfficialRuntime(signal?: AbortSignal) {
    try {
      await Promise.all([
        access(installedRenderScript),
        access(installedLayoutQueryScript),
        access(installedInspectLayoutScript),
        access(path.join(installedProjectRoot, "package.json")),
      ]);
    } catch (error) {
      throw nativeError("skill_not_installed", error);
    }
    try {
      await access(path.join(installedProjectRoot, "node_modules", ".package-lock.json"));
    } catch {
      // This is the same first-run dependency step in Dashi's official
      // render_goal_deck.sh; it remains inside the installed Skill directory.
      await this.run("npm", ["install"], {
        cwd: installedProjectRoot,
        signal,
        timeout: 300_000,
        stage: "install",
      });
    }
  }

  private async previewFor(workspace: string, signal?: AbortSignal) {
    const deckDirectory = path.join(workspace, "ppt");
    await this.run(process.execPath, [installedPreviewScript, deckDirectory, "5200"], {
      cwd: workspace,
      signal,
      timeout: 30_000,
      stage: "preview",
    });
    const source = await readFile(path.join(deckDirectory, ".preview-server.json"), "utf8");
    const preview = JSON.parse(source) as PreviewState;
    if (!preview.httpUrl?.startsWith("http://127.0.0.1:")) throw nativeError("preview_url");
    return preview.httpUrl;
  }

  async queryLayouts(input: {
    theme: DashiGoal["themePack"];
    role: string;
    keyword?: string;
    seed?: string;
    limit?: number;
    signal?: AbortSignal;
  }) {
    await this.ensureOfficialRuntime(input.signal);
    const args = [
      installedLayoutQueryScript,
      "--theme", input.theme,
      "--role", input.role,
      "--limit", String(input.limit ?? 8),
    ];
    if (input.keyword) args.push("--keyword", input.keyword);
    if (input.seed) args.push("--seed", input.seed);
    const result = await this.run(process.execPath, args, {
      cwd: installedProjectRoot, signal: input.signal, stage: "layout_query",
    });
    return JSON.parse(result.stdout) as unknown;
  }

  async inspectLayouts(input: { layouts: string[]; signal?: AbortSignal }) {
    await this.ensureOfficialRuntime(input.signal);
    if (!input.layouts.length || input.layouts.length > 12) throw new Error("dashi_layout_selection_invalid");
    const result = await this.run(process.execPath, [
      installedInspectLayoutScript,
      "--compact",
      ...input.layouts,
    ], { cwd: installedProjectRoot, signal: input.signal, stage: "layout_inspect" });
    return JSON.parse(result.stdout) as unknown;
  }

  async prepareGoal(goalInput: DashiGoal, signal?: AbortSignal): Promise<DashiGoal> {
    await this.ensureOfficialRuntime(signal);
    const workspace = path.join(tmpdir(), "lessonup-dashi-validation", crypto.randomUUID());
    const goalPath = path.join(workspace, "goal.json");
    await mkdir(workspace, { recursive: true });
    try {
      await writeFile(goalPath, `${JSON.stringify(dashiGoalSchema.parse(goalInput), null, 2)}\n`, "utf8");
      await this.run(process.execPath, [installedPropsSafeScript, "--goal", goalPath, "--write"], {
        cwd: workspace,
        signal,
        stage: "props_validation",
      });
      await this.run(process.execPath, [installedGoalValidationScript, goalPath], {
        cwd: workspace,
        signal,
        stage: "goal_validation",
      });
      return dashiGoalSchema.parse(JSON.parse(await readFile(goalPath, "utf8")));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }

  async renderGoal(input: {
    presentationId: string;
    goal: DashiGoal;
    signal?: AbortSignal;
  }): Promise<NativeDashiDeck> {
    await this.ensureOfficialRuntime(input.signal);
    const workspace = deckWorkspace(this.decksRoot, input.presentationId);
    const goalPath = path.join(workspace, "goal.json");
    const deckPath = path.join(workspace, "ppt", "index.html");
    await rm(workspace, { recursive: true, force: true });
    await mkdir(workspace, { recursive: true });
    try {
      const goal = dashiGoalSchema.parse({
        ...input.goal,
        pageCount: input.goal.slides.length,
      });
      await writeFile(goalPath, `${JSON.stringify(goal, null, 2)}\n`, "utf8");
      // This invokes the installed Dashi script itself. Its headless-shell
      // download is explicitly optional (`|| true`), but `npx` can wait on an
      // unreachable registry before returning. Skip only that optional step;
      // Dashi still owns props-safe, validation, rendering, preview, editing
      // and export with the locally available browser.
      await this.run("bash", [
        "-c",
        "npx() { return 1; }; export -f npx; exec bash \"$@\"",
        "lessonup-dashi-render",
        installedRenderScript,
        goalPath,
        deckPath,
      ], {
        cwd: workspace,
        signal: input.signal,
        timeout: 360_000,
        stage: "render",
      });
      const previewUrl = await this.readExistingPreview(workspace) ?? await this.previewFor(workspace, input.signal);
      const finalGoal = await readFile(goalPath, "utf8");
      return {
        deckKey: input.presentationId,
        previewUrl,
        checksum: createHash("sha256").update(finalGoal).digest("hex"),
        pageCount: goal.slides.length,
      };
    } catch (error) {
      await rm(workspace, { recursive: true, force: true });
      throw error;
    }
  }

  async hasDeck(presentationId: string) {
    try {
      await access(path.join(deckWorkspace(this.decksRoot, presentationId), "ppt", "index.html"));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Dashi still owns the editable directory. This method only serializes its
   * finished workspace for durable private storage; preview state/log files
   * are process-local and deliberately excluded.
   */
  async exportBundle(presentationId: string): Promise<NativeDashiBundle> {
    const root = path.join(deckWorkspace(this.decksRoot, presentationId), "ppt");
    const files: NativeDashiBundle["files"] = [];
    const visit = async (directory: string) => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === ".preview-server.json" || entry.name === ".preview-server.log") continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        const relative = safeBundlePath(path.relative(root, absolute));
        files.push({ path: relative, body: await readFile(absolute) });
      }
    };
    await visit(root);
    if (!files.some((file) => file.path === "index.html")) throw new Error("presentation_native_deck_missing");
    const byteSize = files.reduce((total, file) => total + file.body.byteLength, 0);
    return { files: files.sort((left, right) => left.path.localeCompare(right.path)), byteSize };
  }

  /** Restore a previously persisted native workspace before starting Dashi. */
  async importBundle(presentationId: string, bundle: NativeDashiBundle) {
    const workspace = deckWorkspace(this.decksRoot, presentationId);
    const deckDirectory = path.join(workspace, "ppt");
    await rm(deckDirectory, { recursive: true, force: true });
    await mkdir(deckDirectory, { recursive: true });
    for (const file of bundle.files) {
      const relative = safeBundlePath(file.path);
      const target = path.join(deckDirectory, relative);
      if (!target.startsWith(`${deckDirectory}${path.sep}`)) throw new Error("presentation_bundle_path_invalid");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.body);
    }
    if (!await this.hasDeck(presentationId)) throw new Error("presentation_native_deck_missing");
  }

  private async readExistingPreview(workspace: string) {
    try {
      const source = await readFile(path.join(workspace, "ppt", ".preview-server.json"), "utf8");
      const preview = JSON.parse(source) as PreviewState;
      return preview.httpUrl?.startsWith("http://127.0.0.1:") ? preview.httpUrl : null;
    } catch {
      return null;
    }
  }

  async open(presentationId: string, signal?: AbortSignal) {
    const workspace = deckWorkspace(this.decksRoot, presentationId);
    try {
      await access(path.join(workspace, "ppt", "index.html"));
    } catch (error) {
      throw new Error("presentation_native_deck_missing", { cause: error });
    }
    return this.previewFor(workspace, signal);
  }

  async remove(presentationId: string) {
    await rm(deckWorkspace(this.decksRoot, presentationId), { recursive: true, force: true });
  }
}
