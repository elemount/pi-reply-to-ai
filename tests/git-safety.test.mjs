import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { cleanGitEnv } from "../file-workspace.ts";
import { git, gitComparison } from "../git.ts";
import { createGitWorkspace } from "../git-workspace.ts";
import { withRepository } from "./fixtures/repository.mjs";

test("offline reviews reject promisor/partial-clone configuration before reading objects", async () => {
	await withRepository(async ({ cwd, git: run, write, commit }) => {
		write("file", "old\n"); commit(); write("file", "new\n");
		for (const value of ["true", "yes", "on", "1", ""]) {
			run("config", "remote.origin.promisor", value);
			await assert.rejects(gitComparison(cwd, { kind: "diff" }), /full local repository/);
		}
		run("config", "remote.origin.promisor", "false"); assert.ok(await gitComparison(cwd, { kind: "diff" }));
		run("config", "extensions.partialClone", "origin");
		await assert.rejects(gitComparison(cwd, { kind: "diff" }), /partial\/promisor/);
		assert.equal(cleanGitEnv().GIT_NO_LAZY_FETCH, "1");
	});
});
test("linked worktrees use the common object store but never modify either real index", async () => {
	await withRepository(async ({ cwd, write, commit, git: run }) => {
		write("file", "base\n"); commit();
		const directory = mkdtempSync(join(tmpdir(), "pi-linked-worktree-")), linked = join(directory, "linked 'quoted' worktree");
		try {
			run("worktree", "add", "--quiet", "--detach", linked);
			const originalIndex = readFileSync(join(cwd, ".git", "index"));
			const comparison = await gitComparison(linked, { kind: "commit", revision: "HEAD" });
			const indexPath = (await git(linked, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
			const linkedIndex = readFileSync(indexPath);
			const workspace = await createGitWorkspace(comparison);
			try {
				assert.equal(workspace.sources.length, 1);
				assert.match(await git(workspace.directory, ["show", `${workspace.right}:file`]), /^base/);
				assert.deepEqual(readFileSync(indexPath), linkedIndex);
				assert.deepEqual(readFileSync(join(cwd, ".git", "index")), originalIndex);
			} finally { await workspace.cleanup(); }
		} finally { run("worktree", "remove", "--force", linked); rmSync(directory, { recursive: true, force: true }); }
	}, "repo 'quoted' & spaced");
});
