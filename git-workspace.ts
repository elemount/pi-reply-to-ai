import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_REVIEW_BYTES, type ReviewSource } from "./core.ts";
import { fileReview } from "./file.ts";
import { inside, MAX_FILES, skipReviewPath } from "./file-workspace.ts";
import { diffOptions, git, type GitComparison } from "./git.ts";

interface Change { oldMode: string; newMode: string; oldBlob: string; newBlob: string; path: string }
function changes(raw: string): Change[] {
	const parts = raw.split("\0"), result: Change[] = [];
	for (let i = 0; i < parts.length - 1; i += 2) {
		const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) [A-Z]\d*$/.exec(parts[i]);
		if (!match || parts[i + 1] === undefined) throw new Error("Invalid Git change list.");
		result.push({ oldMode: match[1], newMode: match[2], oldBlob: match[3], newBlob: match[4], path: parts[i + 1] });
	}
	return result;
}
const regular = (mode: string) => mode === "000000" || mode === "100644" || mode === "100755";
function text(content: string): boolean { return !/[\u0000-\u0008\u000e-\u001f]/.test(content); }
async function blob(root: string, hash: string): Promise<string> {
	const size = Number((await git(root, ["cat-file", "-s", hash])).trim());
	if (!Number.isSafeInteger(size) || size > 32 * 1024 * 1024) throw new Error("Git source exceeds the 32 MiB review limit.");
	const content = await git(root, ["cat-file", "blob", hash]);
	if (!text(content)) throw new Error("Git source is binary data.");
	return content;
}

export interface GitWorkspace {
	directory: string;
	left: string;
	right: string;
	paths: string[];
	sources: ReviewSource[];
	provenance: string[];
	cleanup(): Promise<void>;
}

/**
 * Isolate Diffview from the real index/worktree. Objects are read through Git's
 * alternates mechanism; only captured working blobs and tiny trees/commits are
 * written privately. There is no checkout and no editable source/diff copy.
 */
export async function createGitWorkspace(comparison: GitComparison): Promise<GitWorkspace | undefined> {
	const directory = await mkdtemp(join(tmpdir(), "pi-review-git-view-"));
	const cleanup = () => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	let handedOff = false;
	try {
		const format = (await git(comparison.root, ["rev-parse", "--show-object-format"])).trim();
		await git(directory, ["init", "--quiet", "--template=", `--object-format=${format}`]);
		const objects = (await git(comparison.root, ["rev-parse", "--path-format=absolute", "--git-path", "objects"])).trim();
		if (/[\r\n]/.test(objects)) throw new Error("Git object directory contains a newline.");
		await mkdir(join(directory, ".git", "objects", "info"), { recursive: true });
		await writeFile(join(directory, ".git", "objects", "info", "alternates"), objects + "\n", { mode: 0o600 });
		await mkdir(join(directory, ".git", "no-hooks"));
		for (const [key, value] of [["core.hooksPath", join(directory, ".git", "no-hooks")], ["core.autocrlf", "false"], ["commit.gpgsign", "false"], ["user.name", "Pi Review"], ["user.email", "review@localhost"]]) {
			await git(directory, ["config", key, value]);
		}
		// Materialize the empty tree privately (root commits, including SHA-256 repositories).
		const empty = (await git(directory, ["hash-object", "-w", "-t", "tree", "--stdin"])).trim();
		const left = comparison.left === empty
			? (await git(directory, ["commit-tree", empty, "-m", "Empty review base"])).trim() : comparison.left;
		const raw = await git(comparison.root, ["diff", ...diffOptions, "--raw", "--abbrev=64", "-z", comparison.left, ...(comparison.right ? [comparison.right] : []), "--"]);
		const candidates = changes(raw);
		if (candidates.length > MAX_FILES) throw new Error(`More than ${MAX_FILES} changed files. Review a smaller target.`);
		let bytes = 0, skipped = 0;
		const sources: ReviewSource[] = [], paths: string[] = [];
		const included: { path: string; mode: string; blob: string }[] = [];
		for (const change of candidates) {
			const path = resolve(comparison.root, change.path);
			if (!inside(comparison.root, path) || skipReviewPath(change.path) || !regular(change.oldMode) || !regular(change.newMode)) { skipped++; continue; }
			let oldContent = "", newContent = "", newBlob = change.newBlob;
			try {
				if (change.oldMode !== "000000") oldContent = await blob(comparison.root, change.oldBlob);
				if (change.newMode !== "000000") {
					if (comparison.right) newContent = await blob(comparison.root, newBlob);
					else {
						const file = await fileReview(comparison.root, change.path);
						if (file.path !== await realpath(path) || !inside(comparison.root, file.path) || file.path !== path) throw new Error("Unsafe working file path.");
						newContent = file.content;
						newBlob = (await git(directory, ["hash-object", "-w", "--stdin"], false, newContent)).trim();
					}
				}
			} catch (error) {
				// Binary, invalid UTF-8, oversized, symlinked, or vanished files are not review targets.
				if (error instanceof Error && /capture limit|Cannot find git/.test(error.message)) throw error;
				skipped++; continue;
			}
			bytes += Buffer.byteLength(oldContent) + Buffer.byteLength(newContent);
			if (bytes > MAX_REVIEW_BYTES) throw new Error("Git review sources exceed the 64 MiB limit. Review a smaller target.");
			included.push({ path: change.path, mode: change.newMode, blob: newBlob });
			paths.push(change.path);
			for (const [side, mode, hash] of [["old", change.oldMode, change.oldBlob], ["new", change.newMode, newBlob]] as const) {
				if (mode === "000000") continue;
				sources.push({ id: sources.length, path, label: change.path, gitPath: change.path, side, blob: hash,
					revision: side === "old" ? comparison.left : comparison.right ?? "working tree snapshot" });
			}
		}
		if (!paths.length) return;
		let right = comparison.right;
		if (!right || skipped) {
			// Filter in private trees instead of passing filenames through Diffview's
			// expansion/pathspec parser. Literal $, %, #, brackets and spaces stay literal.
			await git(directory, ["read-tree", comparison.left]);
			for (const item of included) {
				if (item.mode === "000000") await git(directory, ["update-index", "--force-remove", "--", item.path]);
				else await git(directory, ["update-index", "--add", "--cacheinfo", `${item.mode},${item.blob},${item.path}`]);
			}
			right = (await git(directory, ["commit-tree", (await git(directory, ["write-tree"])).trim(), "-p", left, "-m", "Read-only review snapshot"])).trim();
		}
		// Give the private repository a valid HEAD; Diffview never needs the source repository's refs.
		await git(directory, ["update-ref", "refs/heads/review", right]);
		await git(directory, ["symbolic-ref", "HEAD", "refs/heads/review"]);
		handedOff = true;
		return { directory, left, right, paths, sources, cleanup,
			provenance: [...comparison.provenance, `Comparison: ${comparison.left} → ${comparison.right ?? "frozen working content"}`,
				...(skipped ? [`Skipped ${skipped} unsafe, sensitive, non-text, oversized, or unavailable file(s).`] : [])] };
	} finally { if (!handedOff) await cleanup(); }
}
