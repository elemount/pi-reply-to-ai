import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote } from "./core.ts";

export const REVIEW_USAGE = "Usage: /re [N | @file | message [N] | commit [revision] | pr [base] | diff] (aliases: c, p, d)";
export type ReviewTarget =
	| { kind: "message"; offset: number }
	| { kind: "file"; path: string }
	| { kind: "commit"; revision: string }
	| { kind: "pr"; base?: string }
	| { kind: "diff" };

function messageTarget(value: string): ReviewTarget {
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(REVIEW_USAGE);
	return { kind: "message", offset: Number(value) };
}

export function parseReviewTarget(args: string): ReviewTarget {
	const input = args.trim();
	if (input.startsWith("@")) {
		let path = input.slice(1).trim();
		if (path.startsWith('"') || path.startsWith("'")) {
			if (path.length < 2 || path.at(-1) !== path[0]) throw new Error(REVIEW_USAGE);
			path = path.slice(1, -1);
		}
		if (!path || path.includes("\0")) throw new Error(REVIEW_USAGE);
		return { kind: "file", path };
	}
	const [kind = "message", ref, ...extra] = input.split(/\s+/).filter(Boolean);
	if (extra.length) throw new Error(REVIEW_USAGE);
	if (kind === "message") return messageTarget(ref ?? "0");
	if (/^\d+$/.test(kind) && !ref) return messageTarget(kind);
	if (kind === "commit" || kind === "c") return { kind: "commit", revision: ref ?? "HEAD" };
	if (kind === "pr" || kind === "p") return { kind: "pr", base: ref };
	if ((kind === "diff" || kind === "d") && !ref) return { kind: "diff" };
	throw new Error(REVIEW_USAGE);
}

const execute = promisify(execFile);
const gitPrefix = ["--no-pager", "-c", "core.fsmonitor=false"];
const diffOptions = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const result = await execute("git", [...gitPrefix, ...args], {
			cwd, encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
		});
		return result.stdout;
	} catch (cause) {
		const error = cause as Error & { stderr?: string; code?: string };
		if (error.code === "ENOENT") throw new Error("Cannot find git. Install it before reviewing patches.");
		if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Git output exceeds the 32 MiB capture limit. Review a smaller target.");
		throw new Error(error.stderr?.trim() || error.message);
	}
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
	// Never pass a user-supplied revision directly to diff/show as an option or path.
	return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).trim();
}

async function defaultBase(cwd: string): Promise<string> {
	const candidates: string[] = [];
	try {
		candidates.push((await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])).trim());
	} catch { /* The local remote-HEAD reference is optional. No network access. */ }
	candidates.push("refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master");
	for (const candidate of candidates) {
		try {
			await resolveCommit(cwd, candidate);
			return candidate;
		} catch { /* Try the next conventional base. */ }
	}
	throw new Error("Cannot determine the PR base. Specify it explicitly, e.g. /re pr origin/main.");
}

function gitCommand(cwd: string, args: string[]): string {
	return ["git", "-C", cwd, ...gitPrefix, ...args]
		.map((arg) => /^[a-zA-Z0-9_./:=+-]+$/.test(arg) ? arg : shellQuote(arg)).join(" ");
}

/** Generate a read-only snapshot of a Git patch; no checkout, fetch, or index changes. */
export async function gitReview(cwd: string, target: Exclude<ReviewTarget, { kind: "message" | "file" }>): Promise<string | undefined> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	const header = [`# Repository: ${JSON.stringify(root)}`];
	let patchArgs: string[];
	if (target.kind === "commit") {
		const commit = await resolveCommit(root, target.revision);
		const [, parent] = (await git(root, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/);
		header.unshift(`# Git patch: commit ${commit}`);
		header.push(`# Parent: ${parent ?? "(root commit)"}`);
		// Merge commits are compared with their first parent; root commits with the empty tree.
		patchArgs = parent
			? ["diff", ...diffOptions, parent, commit, "--"]
			: ["diff-tree", "--root", "--no-commit-id", "-r", "-p", ...diffOptions, commit, "--"];
	} else {
		const head = await resolveCommit(root, "HEAD");
		if (target.kind === "pr") {
			const baseName = target.base ?? await defaultBase(root);
			const base = await resolveCommit(root, baseName);
			const mergeBaseArgs = ["merge-base", base, head];
			const mergeBase = (await git(root, mergeBaseArgs)).trim();
			header.unshift("# Git patch: PR changes");
			header.push(`# Base: ${baseName} (${base})`, `# Merge base: ${mergeBase}`, `# Head: ${head}`,
				`# Merge-base command: ${gitCommand(root, mergeBaseArgs)}`);
			patchArgs = ["diff", ...diffOptions, mergeBase, head, "--"];
		} else {
			header.unshift("# Git patch: working tree changes (staged + unstaged)");
			header.push(`# Head: ${head}`, "# Untracked files are excluded.");
			patchArgs = ["diff", ...diffOptions, head, "--"];
		}
	}
	const patch = await git(root, patchArgs);
	if (!patch.trim()) return undefined;
	header.push(`# Generated with: ${gitCommand(root, patchArgs)}`,
		"# Reference snapshot only; implement review comments in the real repository files.");
	return `${header.join("\n")}\n\n${patch}`;
}
