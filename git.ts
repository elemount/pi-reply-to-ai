import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { commandShell, formatShellCommand } from "./platform.ts";

export const REVIEW_USAGE = "Usage: /re [N | N-M | @file [@file ...] | @directory | message [N or N-M] | commit [revision] | pr [base] | diff] (aliases: c, p, d)";
export type ReviewTarget =
	| { kind: "message"; offset: number }
	| { kind: "range"; start: number; end: number }
	| { kind: "file"; path: string }
	| { kind: "files"; paths: string[] }
	| { kind: "commit"; revision: string }
	| { kind: "pr"; base?: string }
	| { kind: "diff" };

function messageTarget(value: string): ReviewTarget {
	const range = /^(\d+)-(\d+)$/.exec(value);
	if (range) {
		const start = Number(range[1]), end = Number(range[2]);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) throw new Error(REVIEW_USAGE);
		return { kind: "range", start, end };
	}
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(REVIEW_USAGE);
	return { kind: "message", offset: Number(value) };
}

export function parseReviewTarget(args: string): ReviewTarget {
	const input = args.trim();
	if (input.startsWith("@")) {
		const paths: string[] = [];
		let cursor = 0;
		while (cursor < input.length) {
			if (input[cursor++] !== "@") throw new Error(REVIEW_USAGE);
			let path: string;
			const quote = input[cursor];
			if (quote === '"' || quote === "'") {
				const end = input.indexOf(quote, cursor + 1);
				if (end < 0) throw new Error(REVIEW_USAGE);
				path = input.slice(cursor + 1, end);
				cursor = end + 1;
				if (cursor < input.length && !/\s/.test(input[cursor])) throw new Error(REVIEW_USAGE);
			} else {
				// Preserve unquoted spaces within one path; whitespace + @ starts the next reference.
				const next = /\s+@/.exec(input.slice(cursor));
				const end = next ? cursor + next.index : input.length;
				path = input.slice(cursor, end).trim();
				cursor = end;
			}
			if (!path || path.includes("\0")) throw new Error(REVIEW_USAGE);
			paths.push(path);
			while (cursor < input.length && /\s/.test(input[cursor])) cursor++;
		}
		return paths.length === 1 ? { kind: "file", path: paths[0] } : { kind: "files", paths };
	}
	const [kind = "message", ref, ...extra] = input.split(/\s+/).filter(Boolean);
	if (extra.length) throw new Error(REVIEW_USAGE);
	if (kind === "message") return messageTarget(ref ?? "0");
	if (/^\d+(?:-\d+)?$/.test(kind) && !ref) return messageTarget(kind);
	if (kind === "commit" || kind === "c") return { kind: "commit", revision: ref ?? "HEAD" };
	if (kind === "pr" || kind === "p") return { kind: "pr", base: ref };
	if ((kind === "diff" || kind === "d") && !ref) return { kind: "diff" };
	throw new Error(REVIEW_USAGE);
}

const execute = promisify(execFile);
const gitPrefix = ["--no-pager", "-c", "core.fsmonitor=false"];
const diffOptions = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];

async function git(cwd: string, args: string[], allowNoResult = false): Promise<string> {
	try {
		const result = await execute("git", [...gitPrefix, ...args], {
			cwd, encoding: "utf8", timeout: 30000, maxBuffer: 32 * 1024 * 1024,
			env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
		});
		return result.stdout;
	} catch (cause) {
		const error = cause as Error & { stderr?: string; code?: string | number };
		// symbolic-ref/config/merge-base use exit 1 for an absent optional result.
		if (allowNoResult && error.code === 1) return "";
		if (error.code === "ENOENT") throw new Error("Cannot find git. Install it before reviewing patches.");
		if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new Error("Git output exceeds the 32 MiB capture limit. Review a smaller target.");
		throw new Error(error.stderr?.trim() || error.message);
	}
}

async function resolveCommit(cwd: string, revision: string): Promise<string> {
	// Never pass a user-supplied revision directly to diff/show as an option or path.
	return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`])).trim();
}

interface PrBase { name: string; commit: string; source: string }
interface BranchRef { name: string; commit: string; symbolic: string; upstream: string }
const MAX_HISTORY_BASES = 256;

/** Infer from local refs only. Commit ancestry is evidence, not a stored PR target. */
async function prBase(cwd: string, head: string, explicit?: string): Promise<PrBase> {
	if (explicit !== undefined) return { name: explicit, commit: await resolveCommit(cwd, explicit), source: "explicit argument" };
	const current = (await git(cwd, ["symbolic-ref", "--quiet", "HEAD"], true)).trim();
	const branch = current.replace(/^refs\/heads\//, "");
	if (current) {
		for (const setting of ["gh-merge-base", "vscode-merge-base"]) {
			const key = `branch.${branch}.${setting}`;
			const name = (await git(cwd, ["config", "--get", key], true)).trim();
			if (!name) continue;
			try { return { name, commit: await resolveCommit(cwd, name), source: key }; }
			catch { throw new Error(`Configured PR base ${JSON.stringify(name)} from ${key} is unavailable. Update that setting or specify /re pr <base>.`); }
		}
	}
	const output = await git(cwd, ["for-each-ref", "--format=%(refname)%09%(objectname)%09%(symref)%09%(upstream)%09%(objecttype)", "refs/heads/", "refs/remotes/"]);
	const refs: BranchRef[] = output.trimEnd().split("\n").filter(Boolean).flatMap(line => {
		const [name, commit, symbolic, upstream, type] = line.split("\t");
		return type === "commit" ? [{ name, commit, symbolic, upstream }] : [];
	});
	const byName = new Map(refs.map(ref => [ref.name, ref]));
	const defaults = [byName.get("refs/remotes/origin/HEAD")?.symbolic,
		"refs/remotes/origin/main", "refs/remotes/origin/master", "refs/heads/main", "refs/heads/master"];
	// A local base and its remote-tracking branch are one logical candidate; prefer the remote snapshot.
	const canonical = (ref: BranchRef) => ref.upstream.startsWith("refs/remotes/") ? byName.get(ref.upstream) ?? ref : ref;
	const defaultRef = defaults.map(name => name ? byName.get(name) : undefined).find(Boolean);
	const fallback = defaultRef ? { ...canonical(defaultRef), source: "repository default" } : undefined;
	const cannotDetermine = () => new Error("Cannot determine the PR base. Specify it explicitly, e.g. /re pr origin/main.");
	if (!current) { if (fallback) return fallback; throw cannotDetermine(); }
	const ownUpstream = byName.get(current)?.upstream;
	const eligible = new Set((await git(cwd, ["for-each-ref", `--no-contains=${head}`, "--format=%(refname)", "refs/heads/", "refs/remotes/"])).trim().split("\n"));
	// If HEAD is already in the default branch, do not resurrect changes using an older feature ref.
	if (fallback && !eligible.has(fallback.name)) return fallback;
	const groups = new Map<string, BranchRef[]>();
	for (const ref of refs) {
		if (ref.symbolic || ref.name === current || !eligible.has(ref.name) || canonical(ref).name !== ref.name) continue;
		if (ref.name === ownUpstream || (ref.name.startsWith("refs/remotes/") && ref.name.split("/").slice(3).join("/") === branch)) continue;
		const aliases = groups.get(ref.commit) ?? [];
		aliases.push(ref); groups.set(ref.commit, aliases);
	}
	if (!groups.size) { if (fallback) return fallback; throw cannotDetermine(); }
	if (groups.size > MAX_HISTORY_BASES) throw new Error(`More than ${MAX_HISTORY_BASES} possible PR bases. Specify /re pr <base> or configure branch.${branch}.gh-merge-base.`);
	// Multiple arguments model a merge of the candidates: --all yields the ancestry frontier,
	// not the branch with the newest timestamp or the shortest numeric commit count.
	const points = (await git(cwd, ["merge-base", "--all", head, ...groups.keys()], true)).trim().split(/\s+/).filter(Boolean);
	const ambiguous = () => new Error("Ambiguous PR base in Git history. Specify /re pr <base> or configure the current branch's gh-merge-base.");
	if (points.length > 1) throw ambiguous();
	if (!points.length) { if (fallback) return fallback; throw cannotDetermine(); }
	const contains = new Set((await git(cwd, ["for-each-ref", `--contains=${points[0]}`, "--format=%(refname)", "refs/heads/", "refs/remotes/"])).trim().split("\n"));
	const matches = [...groups.entries()].filter(([, aliases]) => aliases.some(ref => contains.has(ref.name)));
	// When history gives the same diff as the known default, keep its stable identity.
	if (fallback && matches.some(([, aliases]) => aliases.some(ref => ref.name === fallback.name))) return fallback;
	const ancestor = matches.find(([commit]) => commit === points[0]);
	const selected = ancestor ?? (matches.length === 1 ? matches[0] : undefined);
	if (!selected) throw ambiguous();
	const ref = selected[1].find(ref => ref.name.startsWith("refs/remotes/origin/")) ?? selected[1][0];
	return { name: ref.name, commit: ref.commit, source: "Git history (inferred)" };
}

function gitCommand(cwd: string, args: string[]): string {
	return formatShellCommand("git", ["-C", cwd, ...gitPrefix, ...args]);
}

/** Generate a read-only snapshot of a Git patch; no checkout, fetch, or index changes. */
export async function gitReview(cwd: string, target: Exclude<ReviewTarget, { kind: "message" | "range" | "file" | "files" }>): Promise<string | undefined> {
	const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).trim();
	const header = [`# Repository: ${JSON.stringify(root)}`, `# Command shell: ${commandShell()}`];
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
			const selected = await prBase(root, head, target.base);
			const baseName = selected.name, base = selected.commit;
			const mergeBaseArgs = ["merge-base", base, head];
			const mergeBase = (await git(root, mergeBaseArgs)).trim();
			header.unshift("# Git patch: PR changes");
			header.push(`# Base: ${baseName} (${base})`, `# Base selection: ${selected.source}`, `# Merge base: ${mergeBase}`, `# Head: ${head}`,
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
