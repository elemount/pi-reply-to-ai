import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { git, gitComparison, parseReviewTarget, REVIEW_USAGE } from "../git.ts";
import { createGitWorkspace } from "../git-workspace.ts";
import { withRepository } from "./fixtures/repository.mjs";

const diff = comparison => git(comparison.root, ["diff", "--no-ext-diff", "--no-textconv", comparison.left, ...(comparison.right ? [comparison.right] : []), "--"]);
const snapshotDiff = workspace => git(workspace.directory, ["diff", workspace.left, workspace.right, "--"]);

test("all existing target commands and short aliases retain their parsing", () => {
	for (const [input, target] of [["", { kind: "message", offset: 0 }], ["message 2", { kind: "message", offset: 2 }],
		["001", { kind: "message", offset: 1 }], ["commit", { kind: "commit", revision: "HEAD" }],
		["c HEAD~1", { kind: "commit", revision: "HEAD~1" }], ["p", { kind: "pr", base: undefined }],
		["pr origin/main", { kind: "pr", base: "origin/main" }], ["d", { kind: "diff" }]]) assert.deepEqual(parseReviewTarget(input), target);
	for (const input of ["unknown", "message extra", "diff HEAD", "c a b", "p a b", "-1", "1.5", "1e2", "9007199254740992", "1 extra"]) {
		assert.throws(() => parseReviewTarget(input), error => error.message === REVIEW_USAGE);
	}
});
test("root commit uses a private empty base; source objects and index remain unchanged", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("root.txt", "root\n"); const head = commit();
		const objects = readdirSync(join(cwd, ".git", "objects"));
		const comparison = await gitComparison(cwd, { kind: "commit", revision: "HEAD" });
		assert.equal(comparison.head, head); assert.match(comparison.provenance.join("\n"), /root commit/);
		const workspace = await createGitWorkspace(comparison);
		try {
			assert.equal(workspace.sources.length, 1); assert.equal(workspace.sources[0].side, "new");
			assert.match(await snapshotDiff(workspace), /\+root/);
			assert.equal(existsSync(join(workspace.directory, "root.txt")), false);
			assert.deepEqual(readdirSync(join(cwd, ".git", "objects")), objects);
			assert.equal(run("status", "--porcelain"), "");
		} finally { await workspace.cleanup(); }
	});
});
test("commit reviews ignore other commits and dirty files; revisions are option-safe", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("one", "one\n"); commit(); write("two", "two\n"); const second = commit();
		write("three", "three\n"); commit(); write("three", "dirty\n");
		const comparison = await gitComparison(cwd, { kind: "commit", revision: "HEAD~1" });
		assert.equal(comparison.right, second); assert.match(await diff(comparison), /\+two/); assert.doesNotMatch(await diff(comparison), /three|dirty/);
		for (const revision of ["--help", "missing"]) await assert.rejects(gitComparison(cwd, { kind: "commit", revision }));
	});
});
test("merge commits compare against their first parent", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("root", "root\n"); commit(); run("checkout", "-qb", "feature"); write("feature", "feature\n"); commit();
		run("checkout", "-q", "main"); write("main-only", "main\n"); const parent = commit();
		run("merge", "--quiet", "--no-ff", "feature", "-m", "merge");
		const comparison = await gitComparison(cwd, { kind: "commit", revision: "HEAD" });
		assert.equal(comparison.left, parent); assert.match(await diff(comparison), /\+feature/); assert.doesNotMatch(await diff(comparison), /main-only/);
	});
});
test("PR reviews compare fixed merge base through HEAD and include the full repository", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("nested/root", "root\n"); const base = commit(); run("checkout", "-qb", "feature");
		write("one", "one\n"); commit(); write("two", "two\n"); const head = commit();
		run("checkout", "-q", "main"); write("unrelated", "base\n"); commit(); run("checkout", "-q", "feature");
		const comparison = await gitComparison(join(cwd, "nested"), { kind: "pr", base: "main" });
		assert.equal(comparison.left, base); assert.equal(comparison.right, head);
		assert.match(await diff(comparison), /\+one/); assert.match(await diff(comparison), /\+two/); assert.doesNotMatch(await diff(comparison), /unrelated/);
	});
});
test("working reviews freeze staged plus unstaged content without touching the source index or object store", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("tracked", "base\n"); write("deleted", "delete me\n"); commit();
		write("tracked", "staged\n"); run("add", "tracked"); write("tracked", "unstaged\n");
		write("added", "staged addition\n"); run("add", "added"); write("untracked", "untracked\n"); unlinkSync(join(cwd, "deleted"));
		const status = run("status", "--porcelain"), index = readFileSync(join(cwd, ".git", "index"));
		const objects = run("count-objects", "-v");
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "diff" }));
		try {
			const patch = await snapshotDiff(workspace);
			assert.match(patch, /-base\n\+unstaged/); assert.match(patch, /\+staged addition/); assert.match(patch, /-delete me/);
			assert.doesNotMatch(patch, /\+staged\n|untracked/);
			write("tracked", "changed while reviewing\n");
			assert.equal(await snapshotDiff(workspace), patch);
			write("tracked", "unstaged\n");
			assert.equal(run("status", "--porcelain"), status); assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
			assert.equal(run("count-objects", "-v"), objects);
			assert.match(workspace.provenance.join("\n"), /not a durable Git revision/);
			assert.equal(workspace.sources.find(source => source.side === "new" && source.gitPath === "tracked").revision, "working tree snapshot");
		} finally { await workspace.cleanup(); await workspace.cleanup(); }
	});
});
test("staged deletion excludes an untracked file recreated at the same path", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("file", "old\n"); commit(); run("rm", "-q", "file"); write("file", "new untracked content\n");
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "diff" }));
		try { assert.equal(workspace.sources.length, 1); assert.equal(workspace.sources[0].side, "old"); assert.doesNotMatch(await snapshotDiff(workspace), /new untracked/); }
		finally { await workspace.cleanup(); }
	});
});
test("renames and unusual paths are represented as safe old/new sources", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("old name,quote'.txt", "old\n"); commit(); run("mv", "old name,quote'.txt", "new [name],quote'.txt"); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "commit", revision: "HEAD" }));
		try { assert.equal(workspace.sources.length, 2); assert.ok(workspace.sources.some(source => source.side === "old" && source.gitPath.startsWith("old"))); }
		finally { await workspace.cleanup(); }
	});
});
test("binary, invalid UTF-8, credential and symlink changes never enter the Git view allowlist", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("normal.txt", "old\n"); commit(); write("normal.txt", "new\n");
		write("binary.dat", Buffer.from([0, 1])); write("invalid.dat", Buffer.from([0xff])); write(".env", "secret\n");
		symlinkSync("normal.txt", join(cwd, "link.txt")); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "commit", revision: "HEAD" }));
		try { assert.deepEqual(workspace.paths, ["normal.txt"]); assert.match(workspace.provenance.join("\n"), /Skipped 4/); }
		finally { await workspace.cleanup(); }
	});
});
test("external diff and textconv programs cannot run during selection or private browsing preparation", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("example.txt", "old\n"); commit(); write("example.txt", "new\n"); write(".gitattributes", "*.txt diff=reviewtest\n");
		const marker = join(cwd, "external-ran");
		for (const key of ["diff.reviewtest.command", "diff.reviewtest.textconv", "diff.external"]) run("config", key, `touch ${marker}`);
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "diff" }));
		try { assert.match(await snapshotDiff(workspace), /\+new/); assert.equal(existsSync(marker), false); }
		finally { await workspace.cleanup(); }
	});
});
test("empty comparisons return nothing and inherited Git directory/index variables cannot redirect review", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("root", "root\n"); commit();
		const before = process.env.GIT_DIR;
		try { process.env.GIT_DIR = "/does/not/exist"; assert.equal(await gitComparison(cwd, { kind: "diff" }), undefined); }
		finally { if (before === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = before; }
		assert.equal(await gitComparison(cwd, { kind: "pr", base: "main" }), undefined);
	});
});
