import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewDocument, reviewVimScript } from "./core.ts";
import { editorCandidates, environmentValue, isWsl } from "./platform.ts";

function executable(candidate: string): boolean {
	try {
		if (process.platform === "win32") {
			// Use console executables directly, not batch files or Git Bash's MSYS Vim.
			if (!/\.(exe|com)$/i.test(candidate) || existsSync(join(dirname(candidate), "msys-2.0.dll"))) return false;
		}
		if (!statSync(candidate).isFile()) return false;
		accessSync(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		return true;
	} catch { return false; }
}

function windowsVimCandidates(): string[] {
	const env = process.env;
	const roots = ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"]
		.map(name => environmentValue(env, name)).filter((root): root is string => Boolean(root)).map(root => join(root, "Vim"));
	if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, "Programs", "Vim"));
	if (env.SystemDrive) roots.push(join(env.SystemDrive + "\\", "tools", "vim"));
	const scoop = env.SCOOP || (env.USERPROFILE && join(env.USERPROFILE, "scoop"));
	if (scoop) roots.push(join(scoop, "apps", "vim", "current"));
	return [...new Set(roots)].flatMap(root => {
		let versions: string[] = [];
		try { versions = readdirSync(root).filter(name => /^vim[\d.]+$/i.test(name)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true })); }
		catch { /* Not installed in this location. */ }
		return [join(root, "vim.exe"), ...versions.map(version => join(root, version, "vim.exe"))];
	});
}

export function findReviewEditor(cwd: string): string {
	const configured = environmentValue(process.env, "PI_REVIEW_EDITOR")?.replace(/^(["'])(.*)\1$/, "$2");
	if (isWsl() && configured && /\.(exe|cmd|bat)$/i.test(configured)) {
		throw new Error("Use Linux vim inside WSL, not a Windows executable. Install it in WSL or set PI_REVIEW_EDITOR=/usr/bin/vim.");
	}
	const candidates = editorCandidates(configured || "vim", cwd);
	if (!configured && process.platform === "win32") candidates.push(...windowsVimCandidates());
	const found = candidates.find(executable);
	if (found) return found;
	throw new Error(configured
		? `Cannot find a usable PI_REVIEW_EDITOR=${configured} (expected a native console vim executable path, without arguments or batch wrappers).`
		: "Cannot find vim. Install console Vim or set PI_REVIEW_EDITOR to its executable path (vim.exe on Windows).");
}

export function launchEditor(editor: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(editor, args, { cwd, stdio: "inherit", shell: false });
		child.once("error", reject);
		child.once("close", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Vim exited abnormally (${signal ?? code ?? "unknown"}); no review sent.`));
		});
	});
}

export interface SavedReview {
	content: string;
	filePath: string;
	/** Caller owns cleanup; retain the directory if the model receives a file reference. */
	cleanup(): void;
}

function remove(path: string): void {
	try { rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
	catch { /* Best-effort cleanup. */ }
}

/** undefined means no successful write. Return the last saved snapshot, not unsaved edits. */
export async function editReview(original: string, ctx: ExtensionContext, options: { patch?: boolean; extension?: string } = {}): Promise<SavedReview | undefined> {
	const editor = findReviewEditor(ctx.cwd);
	const directory = mkdtempSync(join(tmpdir(), "pi-review-"));
	const extension = options.patch ? ".diff" : options.extension === undefined ? ".md"
		: /^\.[a-zA-Z0-9_-]{1,16}$/.test(options.extension) ? options.extension : ".txt";
	const filePath = join(directory, `editing${extension}`);
	const scriptPath = join(directory, "review.vim");
	const savedPath = join(directory, `review${extension}`);
	let handedOff = false;
	try {
		writeFileSync(filePath, reviewDocument(original), { mode: 0o600 });
		writeFileSync(scriptPath, reviewVimScript(savedPath, options.patch ? "diff" : options.extension !== undefined ? "auto" : "markdown"), { mode: 0o600 });
		const failure = await ctx.ui.custom<Error | undefined>(async (tui, _theme, _keys, done) => {
			let error: Error | undefined;
			tui.stop();
			try {
				// Async spawn releases terminal input correctly, including on Windows.
				// Disable modelines BEFORE reading model-generated text; keep the user's vimrc.
				await launchEditor(editor, [
					"-n", "-i", "NONE",
					"--cmd", "set encoding=utf-8",
					"--cmd", "autocmd BufReadPre * setlocal nomodeline",
					"-S", scriptPath, "--", filePath,
				], ctx.cwd);
			} catch (cause) {
				error = cause instanceof Error ? cause : new Error(String(cause));
			} finally {
				tui.start();
				tui.requestRender(true);
			}
			done(error);
			return { render: () => [], invalidate: () => {} };
		});
		if (failure) throw failure;
		if (!existsSync(savedPath)) return undefined;
		const content = readFileSync(savedPath, "utf8").replace(/^\uFEFF/, "");
		if (process.platform !== "win32") chmodSync(savedPath, 0o600);
		handedOff = true;
		return { content, filePath: savedPath, cleanup: () => remove(directory) };
	} finally {
		if (handedOff) {
			remove(filePath);
			remove(scriptPath);
		} else remove(directory);
	}
}
