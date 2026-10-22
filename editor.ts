import { spawn } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { reviewDocument, reviewVimScript } from "./core.ts";

function executable(command: string, cwd: string): string | undefined {
	const candidates = isAbsolute(command) || command.includes("/") || command.includes("\\")
		? [resolve(cwd, command)]
		: (process.env.PATH ?? "").split(delimiter).map((directory) => resolve(cwd, directory, command));
	for (const candidate of candidates) {
		try {
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch { /* Try the next PATH entry. */ }
	}
	return undefined;
}

export function findReviewEditor(cwd: string): string {
	const configured = process.env.PI_REVIEW_EDITOR;
	for (const command of configured ? [configured] : ["vim"]) {
		const path = executable(command, cwd);
		if (path) return path;
	}
	throw new Error(configured
		? `Cannot find PI_REVIEW_EDITOR=${configured} (expected a vim executable name or path, without arguments).`
		: "Cannot find vim. Install it or set PI_REVIEW_EDITOR to its path.");
}

function launchEditor(editor: string, args: string[], cwd: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(editor, args, { cwd, stdio: "inherit" });
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
	try { rmSync(path, { recursive: true, force: true }); }
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
		chmodSync(savedPath, 0o600);
		handedOff = true;
		return { content, filePath: savedPath, cleanup: () => remove(directory) };
	} finally {
		if (handedOff) {
			remove(filePath);
			remove(scriptPath);
		} else remove(directory);
	}
}
