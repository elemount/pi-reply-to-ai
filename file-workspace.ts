import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ReviewSource } from "./core.ts";
import { fileReview, resolveReviewPath } from "./file.ts";

const execute = promisify(execFile);
export const MAX_FILES = 2000;
const PROBE_CONCURRENCY = 8;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".ssh", ".aws", ".gnupg", ".kube", ".pi"]);
export function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
export function skipReviewPath(path: string): boolean {
	const parts = path.split(/[\\/]/);
	const name = parts.at(-1) ?? "";
	return parts.some(part => SKIP_DIRECTORIES.has(part)) || /^\.env(?:\.|$)/.test(name)
		|| /(?:\.(?:pem|key)|^id_(?:rsa|ed25519|ecdsa)|^credentials(?:\.json)?$|^auth\.json$)/i.test(name);
}
export function cleanGitEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", LC_ALL: "C" };
	for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
	return env;
}
async function git(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execute("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
		cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000, env: cleanGitEnv(),
	});
	return stdout;
}
async function directoryPaths(root: string, metadata: string): Promise<string[]> {
	const exclusions = [...SKIP_DIRECTORIES].map(name => `--exclude=${name}/`);
	let output: string;
	try { output = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...exclusions, "--", "."], root); }
	catch {
		// Private metadata honors nested .gitignore without creating .git in the source.
		await git(["init", "--quiet", "--bare", "--template=", metadata], root);
		output = await git([`--git-dir=${metadata}`, `--work-tree=${root}`, "ls-files", "-z", "--others", "--exclude-standard", ...exclusions, "--", "."], root);
	}
	return [...new Set(output.split("\0").filter(Boolean))].sort();
}
async function likelyText(path: string): Promise<boolean> {
	const file = await open(path, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NONBLOCK));
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 32 * 1024 * 1024) return false;
		const sample = Buffer.alloc(8192);
		const { bytesRead } = await file.read(sample, 0, sample.length, 0);
		const text = new TextDecoder("utf-8", { fatal: true }).decode(sample.subarray(0, bytesRead), { stream: bytesRead === sample.length });
		return !/[\u0000-\u0008\u000e-\u001f]/.test(text);
	} catch { return false; }
	finally { await file.close(); }
}
async function directoryFile(root: string, path: string): Promise<string | undefined> {
	if (skipReviewPath(path)) return;
	const full = join(root, path);
	if (!inside(root, full)) return;
	try {
		const info = await lstat(full);
		if (!info.isFile() || info.isSymbolicLink()) return;
		const canonical = await realpath(full);
		return inside(root, canonical) && await likelyText(canonical) ? canonical : undefined;
	} catch { return; }
}

/** Enumeration only. Contents are read into Neovim on demand, never into editable copies. */
export async function fileSources(paths: readonly string[], cwd: string): Promise<{ sources: ReviewSource[]; tree: boolean }> {
	if (!paths.length || paths.length > 64) throw new Error("Review between 1 and 64 file/directory references at once.");
	const metadata = await mkdtemp(join(tmpdir(), "pi-review-scan-"));
	const sources: ReviewSource[] = [], seen = new Set<string>();
	let tree = false;
	function add(path: string, root?: string): void {
		const identity = process.platform === "win32" ? path.toLowerCase() : path;
		if (seen.has(identity)) return;
		if (sources.length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} reviewable files. Select a narrower directory.`);
		seen.add(identity);
		sources.push({ id: sources.length, path, root, label: root ? relative(root, path) : path });
	}
	try {
		for (const [index, path] of paths.entries()) {
			const source = await realpath(resolveReviewPath(cwd, path));
			const info = await stat(source);
			if (!info.isDirectory()) { await fileReview(cwd, source); add(source); continue; }
			tree = true;
			const candidates = await directoryPaths(source, join(metadata, String(index)));
			for (let offset = 0; offset < candidates.length; offset += PROBE_CONCURRENCY) {
				const checked = await Promise.all(candidates.slice(offset, offset + PROBE_CONCURRENCY).map(path => directoryFile(source, path)));
				for (const canonical of checked) if (canonical) add(canonical, source);
			}
		}
		if (!sources.length) throw new Error("No reviewable text files found.");
		return { sources, tree };
	} finally { await rm(metadata, { recursive: true, force: true }); }
}

/** Revalidate every lazy open, including symlink races and directory containment. */
export async function readSource(source: ReviewSource, cwd: string): Promise<string> {
	if (source.reply !== undefined) return source.content ?? "";
	if (!source.path || source.blob) throw new Error("Invalid file source.");
	const file = await fileReview(cwd, source.path);
	if (file.path !== source.path || (source.root && !inside(source.root, file.path))) throw new Error("The selected file moved outside the review source.");
	return file.content;
}
