import { execFile, spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MAX_REVIEW_BYTES, validateComments, type ReviewComment, type ReviewDocument } from "./core.ts";
import { cleanGitEnv } from "./file-workspace.ts";
import { editorCandidates, environmentValue, isWsl } from "./platform.ts";

const runtime = dirname(fileURLToPath(import.meta.url));
const execute = promisify(execFile);
function executable(candidate: string): boolean {
	try {
		if (process.platform === "win32" && (!/\.(exe|com)$/i.test(candidate) || existsSync(join(dirname(candidate), "msys-2.0.dll")))) return false;
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK); return true;
	} catch { return false; }
}
export async function findReviewEditor(cwd: string): Promise<string> {
	const configured = environmentValue(process.env, "PI_REVIEW_EDITOR")?.replace(/^(["'])(.*)\1$/, "$2");
	if (isWsl() && configured && /\.(exe|cmd|bat)$/i.test(configured)) throw new Error("Use Linux Neovim inside WSL, not a Windows executable.");
	const candidates = editorCandidates(configured || "nvim", cwd);
	if (!configured && process.platform === "win32" && process.env.ProgramFiles) candidates.push(join(process.env.ProgramFiles, "Neovim", "bin", "nvim.exe"));
	const editor = candidates.find(executable);
	if (!editor) throw new Error("Cannot find Neovim. Install Neovim >= 0.10 or set PI_REVIEW_EDITOR to its native executable path, without arguments.");
	const { stdout } = await execute(editor, ["--version"], { timeout: 10000, maxBuffer: 1024 * 1024 });
	const version = /^NVIM v(\d+)\.(\d+)/m.exec(stdout);
	if (!version || (Number(version[1]) === 0 && Number(version[2]) < 10)) throw new Error("/re requires Neovim >= 0.10. Vim is not supported.");
	return editor;
}
export type LaunchEditor = (editor: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => Promise<void>;
export const launchEditor: LaunchEditor = (editor, args, cwd, env) => new Promise((resolve, reject) => {
	const child = spawn(editor, args, { cwd, env, stdio: "inherit", shell: false });
	child.once("error", reject);
	child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Neovim exited abnormally (${signal ?? code ?? "unknown"}); no review sent.`)));
});
export interface ReviewView { directory: string; left: string; right: string; paths: string[]; runtime: string }

/** Successful editor exits deliver explicit saved comments; cancellation removes the private result. */
export async function editReview(document: ReviewDocument, ctx: ExtensionContext, options: { tree?: boolean; view?: ReviewView } = {}, launch: LaunchEditor = launchEditor): Promise<ReviewComment[] | undefined> {
	const editor = await findReviewEditor(ctx.cwd);
	const directory = await mkdtemp(join(tmpdir(), "pi-review-editor-"));
	try {
		const resultPath = join(directory, "result.json"), manifestPath = join(directory, "manifest.json");
		await writeFile(manifestPath, JSON.stringify({ ...document, ...options, cwd: ctx.cwd, node: process.execPath,
			reader: join(runtime, "source-reader.ts"), result: resultPath }), { mode: 0o600 });
		const env: NodeJS.ProcessEnv = { ...cleanGitEnv(), PI_REVIEW_RUNTIME: runtime, PI_REVIEW_MANIFEST: manifestPath };
		if (options.view) {
			// Diffview uses private metadata only. Do not inherit external diff/textconv
			// drivers, attributes, or config injection from the surrounding Git session.
			Object.assign(env, { GIT_CONFIG_GLOBAL: join(directory, "no-global-gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_ATTR_NOSYSTEM: "1", GIT_CONFIG_COUNT: "0" });
			delete env.GIT_CONFIG_PARAMETERS; delete env.GIT_EXTERNAL_DIFF;
		}
		const failure = await ctx.ui.custom<Error | undefined>(async (tui, _theme, _keys, done) => {
			let failure: Error | undefined;
			tui.stop();
			try { await launch(editor, ["-c", "lua dofile(vim.env.PI_REVIEW_RUNTIME .. '/nvim/init.lua')"], ctx.cwd, env); }
			catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
			finally { tui.start(); tui.requestRender(true); }
			done(failure); return { render: () => [], invalidate: () => {} };
		});
		if (failure) throw failure;
		let info;
		try { info = await lstat(resultPath); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
		if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_REVIEW_BYTES) throw new Error("Invalid or oversized Neovim review result.");
		return validateComments(JSON.parse(await readFile(resultPath, "utf8")), document.sources);
	} finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}
