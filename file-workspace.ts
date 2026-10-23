import { execFile } from "node:child_process";
import { chmodSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INLINE_REVIEW_BYTES, fileReviewSection, fileWorkspaceReferencePrompt, reviewDocument, reviewPrompt } from "./core.ts";
import { fileReview, resolveReviewPath } from "./file.ts";
import { findReviewEditor, launchEditor } from "./editor.ts";
import { fileWorkspaceVimScript } from "./file-workspace-vim.ts";

const execute = promisify(execFile);
const MAX_FILES = 2000;
const PROBE_CONCURRENCY = 8;
const MAX_OPEN_BYTES = 64 * 1024 * 1024;
const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".venv", "venv", "__pycache__", ".cache", ".ssh", ".aws", ".gnupg", ".kube", ".pi"]);

export interface WorkspaceFile {
	id: number;
	source: string;
	copy: string;
	saved: string;
	label: string;
	root?: string;
}
interface TreeRow { key: string; label: string; depth: number; parents: string[]; directory: boolean; id?: number }
interface TreeNode { key: string; label: string; id?: number; children?: Map<string, TreeNode> }
export interface SavedFileReview { source: string; content: string; filePath: string }
export interface FileWorkspace {
	directory: string;
	files: WorkspaceFile[];
	tree: boolean;
	load(id: number): Promise<void>;
	startLoader(): () => Promise<void>;
	collect(): SavedFileReview[];
	cleanup(): void;
}

function remove(path: string): void {
	rmSync(path, { force: true, recursive: true, maxRetries: 5, retryDelay: 100 });
}
function inside(root: string, path: string): boolean {
	const rel = relative(root, path);
	return rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel);
}
function display(path: string): string {
	return path.replace(/[\u0000-\u001f\u007f]/g, char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
function skip(path: string): boolean {
	const parts = path.split(/[\\/]/);
	return parts.some(part => SKIP_DIRECTORIES.has(part)) || /^\.env(?:\.|$)/.test(parts.at(-1) ?? "")
		|| /(?:\.(?:pem|key)|^id_(?:rsa|ed25519|ecdsa)|^credentials(?:\.json)?$|^auth\.json$)/i.test(parts.at(-1) ?? "");
}
async function git(args: string[], cwd: string): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
	const { stdout } = await execute("git", ["--no-pager", "-c", "core.fsmonitor=false", ...args], {
		cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 30000,
		env,
	});
	return stdout;
}
async function directoryPaths(root: string, metadata: string): Promise<string[]> {
	let output: string;
	const exclusions = [...SKIP_DIRECTORIES].map(name => `--exclude=${name}/`);
	try {
		output = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard", ...exclusions, "--", "."], root);
	} catch {
		// Git is installed, but the selected folder need not be a repository.
		// Only this private directory receives Git metadata, never the source folder.
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

async function directoryFile(root: string, path: string, workspace: string): Promise<string | undefined> {
	if (skip(path)) return undefined;
	const full = join(root, path);
	if (!inside(root, full) || inside(workspace, full)) return undefined;
	try {
		const info = await lstat(full);
		if (!info.isFile() || info.isSymbolicLink()) return undefined;
		const canonical = await realpath(full);
		return inside(root, canonical) && await likelyText(canonical) ? canonical : undefined;
	} catch {
		// Files may disappear or be unreadable while enumerating a directory.
		return undefined;
	}
}

export async function isReviewDirectory(cwd: string, path: string): Promise<boolean> {
	return (await stat(resolveReviewPath(cwd, path))).isDirectory();
}

/** Build the read-only tree metadata; directory file contents are copied only when opened. */
export async function createFileWorkspace(paths: readonly string[], cwd: string): Promise<FileWorkspace> {
	if (!paths.length || paths.length > 64) throw new Error("Review between 1 and 64 file/directory references at once.");
	const directory = mkdtempSync(join(tmpdir(), "pi-files-"));
	const files: WorkspaceFile[] = [];
	const roots: TreeNode[] = [];
	const seen = new Set<string>();
	let tree = false, copiedBytes = 0;
	const copied = new Set<number>();
	const cleanup = () => { try { remove(directory); } catch { /* Best effort. */ } };
	try {
		function add(source: string, root?: string): WorkspaceFile | undefined {
			const identity = process.platform === "win32" ? source.toLowerCase() : source;
			if (seen.has(identity)) return undefined;
			if (files.length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} reviewable files. Select a narrower directory.`);
			seen.add(identity);
			const id = files.length;
			const originalExtension = extname(source);
			const extension = /^\.[a-zA-Z0-9_-]{1,16}$/.test(originalExtension) ? originalExtension : ".txt";
			const stem = basename(source, originalExtension).replace(/[^\p{L}\p{N}._-]/gu, "_").slice(0, 60) || "file";
			const folder = join(directory, "copies", String(id));
			const item = { id, source, root, copy: join(folder, stem + extension), saved: join(directory, "saved", `${id}.txt`), label: display(source) };
			files.push(item); return item;
		}
		for (const [index, path] of paths.entries()) {
			const source = await realpath(resolveReviewPath(cwd, path));
			const info = await stat(source);
			if (!info.isDirectory()) {
				if (!info.isFile()) throw new Error("File review requires regular text files or directories.");
				const item = add(source);
				if (item) roots.push({ key: `file-${item.id}`, label: display(source), id: item.id });
				continue;
			}
			tree = true;
			const node: TreeNode = { key: `root-${index}`, label: display(source) + "/", children: new Map() };
			roots.push(node);
			const candidates = await directoryPaths(source, join(directory, `git-scan-${index}`));
			for (let offset = 0; offset < candidates.length; offset += PROBE_CONCURRENCY) {
				// Bound open handles and stop within one batch of the file limit. Commit in Git order, not completion order.
				const batch = candidates.slice(offset, offset + PROBE_CONCURRENCY);
				const checked = await Promise.all(batch.map(path => directoryFile(source, path, directory)));
				for (const [position, canonical] of checked.entries()) {
					if (!canonical) continue;
					const item = add(canonical, source);
					if (!item) continue;
					const parts = relative(source, join(source, batch[position])).split(sep);
					let parent = node;
					for (const part of parts.slice(0, -1)) {
						let child = parent.children!.get(part);
						if (!child) { child = { key: parent.key + "/" + part, label: display(part) + "/", children: new Map() }; parent.children!.set(part, child); }
						parent = child;
					}
					parent.children!.set(parts.at(-1)!, { key: `file-${item.id}`, label: display(parts.at(-1)!), id: item.id });
				}
			}
		}
		if (!files.length) throw new Error("No reviewable text files found.");
		const rows: TreeRow[] = [];
		function flatten(nodes: TreeNode[], parents: string[] = []): void {
			for (const node of nodes.sort((a, b) => Number(Boolean(b.children)) - Number(Boolean(a.children)) || a.label.localeCompare(b.label))) {
				rows.push({ key: node.key, label: node.label, depth: parents.length, parents, directory: Boolean(node.children), ...(node.id === undefined ? {} : { id: node.id }) });
				if (node.children) flatten([...node.children.values()], [...parents, node.key]);
			}
		}
		flatten(roots);
		mkdirSync(join(directory, "saved"), { mode: 0o700 });
		async function load(id: number): Promise<void> {
			const item = files[id];
			if (!Number.isSafeInteger(id) || !item) throw new Error("Invalid review file selection.");
			if (copied.has(id) && existsSync(item.copy)) return;
			const source = await fileReview(cwd, item.source);
			if (item.root && !inside(item.root, source.path)) throw new Error("The selected file moved outside the review directory.");
			const content = reviewDocument(source.content);
			const size = Buffer.byteLength(content);
			if (copiedBytes + size > MAX_OPEN_BYTES) throw new Error("Open fewer or smaller files; review copies are limited to 64 MiB in total.");
			mkdirSync(dirname(item.copy), { recursive: true, mode: 0o700 });
			writeFileSync(item.copy + ".partial", content, { mode: 0o600 });
			renameSync(item.copy + ".partial", item.copy);
			item.source = source.path; copied.add(id); copiedBytes += size;
		}
		if (!tree) for (const item of files) await load(item.id);
		writeFileSync(join(directory, "manifest.json"), JSON.stringify({ tree, files, rows }), { mode: 0o600 });
		writeFileSync(join(directory, "workspace.vim"), fileWorkspaceVimScript(directory), { mode: 0o600 });
		writeFileSync(join(directory, "tree.txt"), "Files\n", { mode: 0o600 });
		for (const [index] of paths.entries()) remove(join(directory, `git-scan-${index}`));
		return {
			directory, files, tree, load, cleanup,
			startLoader() {
				let pending: Promise<void> | undefined;
				const requestPath = join(directory, "request.json"), responsePath = join(directory, "response.json");
				const respond = (value: object) => {
					writeFileSync(responsePath + ".partial", JSON.stringify(value), { mode: 0o600 });
					remove(responsePath);
					renameSync(responsePath + ".partial", responsePath);
				};
				const timer = setInterval(() => {
					if (pending || !existsSync(requestPath)) return;
					let request: { sequence: number; id: number };
					try { request = JSON.parse(readFileSync(requestPath, "utf8")); } catch { return; }
					try { remove(requestPath); } catch { return; }
					pending = (async () => {
						try {
							if (!Number.isSafeInteger(request.sequence) || request.sequence < 1) throw new Error("Invalid review request.");
							await load(request.id); respond({ sequence: request.sequence });
						} catch (error) {
							try { respond({ sequence: request.sequence, error: error instanceof Error ? error.message : String(error) }); } catch { /* Editor may have exited. */ }
						}
					})().finally(() => { pending = undefined; });
				}, 25);
				timer.unref();
				return async () => { clearInterval(timer); await pending; };
			},
			collect() {
				const result: SavedFileReview[] = []; let bytes = 0;
				for (const item of files) {
					if (!copied.has(item.id) || !existsSync(item.saved)) continue;
					const info = lstatSync(item.saved);
					if (!info.isFile()) throw new Error("Saved review snapshot is not a regular file.");
					if (info.size + bytes > MAX_OPEN_BYTES) throw new Error("Saved file reviews exceed the 64 MiB limit.");
					const content = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(item.saved)); bytes += info.size;
					if (content.includes("@@")) {
						if (process.platform !== "win32") chmodSync(item.saved, 0o600);
						result.push({ source: item.source, content, filePath: item.saved });
					} else remove(item.saved);
				}
				const keep = new Set(result.map(file => file.filePath));
				for (const name of readdirSync(join(directory, "saved"))) {
					const path = join(directory, "saved", name);
					if (!keep.has(path)) remove(path);
				}
				for (const name of ["copies", "manifest.json", "workspace.vim", "tree.txt", "request.json", "response.json", "response.json.partial"]) remove(join(directory, name));
				return result;
			},
		};
	} catch (error) { cleanup(); throw error; }
}

/** One Vim process: explicit files use tabs; directories use a read-only tree and lazy copies. */
export async function prepareFileWorkspaceReview(paths: readonly string[], ctx: ExtensionContext, launch = launchEditor): Promise<{ prompt: string; large: boolean; cleanup(): void } | undefined> {
	const editor = findReviewEditor(ctx.cwd);
	const workspace = await createFileWorkspace(paths, ctx.cwd);
	let handedOff = false;
	try {
		const stopLoader = workspace.startLoader();
		try {
			const failure = await ctx.ui.custom<Error | undefined>(async (tui, _theme, _keys, done) => {
				let failure: Error | undefined; tui.stop();
				try {
					const args = ["-n", "-i", "NONE", "--cmd", "set encoding=utf-8", "--cmd", "autocmd BufReadPre * setlocal nomodeline"];
					if (!workspace.tree) args.push(`-p${workspace.files.length}`);
					args.push("-S", join(workspace.directory, "workspace.vim"), "--", ...(workspace.tree ? [join(workspace.directory, "tree.txt")] : workspace.files.map(file => file.copy)));
					await launch(editor, args, ctx.cwd);
				} catch (error) { failure = error instanceof Error ? error : new Error(String(error)); }
				finally { tui.start(); tui.requestRender(true); }
				done(failure); return { render: () => [], invalidate: () => {} };
			});
			if (failure) throw failure;
		} finally { await stopLoader(); }
		const files = workspace.collect();
		if (!files.length) return undefined;
		const rawBytes = files.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
		const content = rawBytes > INLINE_REVIEW_BYTES ? "" : files.map(file => fileReviewSection(file.source, file.content)).join("\n\n");
		const large = rawBytes > INLINE_REVIEW_BYTES || Buffer.byteLength(content) > INLINE_REVIEW_BYTES;
		let prompt: string;
		if (large) {
			const manifest = join(workspace.directory, "reviews.json");
			writeFileSync(manifest, JSON.stringify(files.map(({ source, filePath }) => ({ source, annotatedFile: filePath })), null, 2), { mode: 0o600 });
			prompt = fileWorkspaceReferencePrompt(manifest, join(workspace.directory, "saved"));
		} else prompt = files.length === 1 ? reviewPrompt(files[0].content, "this file", "file", files[0].source) : reviewPrompt(content, "these files", "files");
		handedOff = true; return { prompt, large, cleanup: workspace.cleanup };
	} finally { if (!handedOff) workspace.cleanup(); }
}
