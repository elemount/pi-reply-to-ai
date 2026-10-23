import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitReview, parseReviewTarget, REVIEW_USAGE } from "../git.ts";
import { newComments, reviewDocument, reviewFilePrompt, reviewPrompt, reviewVimScript } from "../core.ts";
import { withRepository } from "./fixtures/repository.mjs";

test("parse default message, single commit, PR base, and working diff", () => {
	assert.deepEqual(parseReviewTarget(""), { kind: "message", offset: 0 });
	assert.deepEqual(parseReviewTarget("message"), { kind: "message", offset: 0 });
	assert.deepEqual(parseReviewTarget("0"), { kind: "message", offset: 0 });
	assert.deepEqual(parseReviewTarget("1"), { kind: "message", offset: 1 });
	assert.deepEqual(parseReviewTarget("message 2"), { kind: "message", offset: 2 });
	assert.deepEqual(parseReviewTarget("001"), { kind: "message", offset: 1 });
	assert.deepEqual(parseReviewTarget("commit"), { kind: "commit", revision: "HEAD" });
	assert.deepEqual(parseReviewTarget(" commit  HEAD~1 "), { kind: "commit", revision: "HEAD~1" });
	assert.deepEqual(parseReviewTarget("pr"), { kind: "pr", base: undefined });
	assert.deepEqual(parseReviewTarget("pr origin/main"), { kind: "pr", base: "origin/main" });
	assert.deepEqual(parseReviewTarget("diff"), { kind: "diff" });
	assert.deepEqual(parseReviewTarget("c"), parseReviewTarget("commit"));
	assert.deepEqual(parseReviewTarget("c HEAD~1"), parseReviewTarget("commit HEAD~1"));
	assert.deepEqual(parseReviewTarget("p"), parseReviewTarget("pr"));
	assert.deepEqual(parseReviewTarget("p origin/main"), parseReviewTarget("pr origin/main"));
	assert.deepEqual(parseReviewTarget("d"), parseReviewTarget("diff"));
	for (const input of ["unknown", "message extra", "diff HEAD", "commit a b", "pr a b", "d HEAD", "p a b", "c a b", "-1", "1.5", "1e2", "Infinity", "9007199254740992", "message -1", "1 extra"]) {
		assert.throws(() => parseReviewTarget(input), error => error.message === REVIEW_USAGE);
	}
});

test("root commit is compared with the empty tree and existing hunk markers are not comments", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("root.txt", "root contents\n");
		const hash = commit("root");
		const patch = await gitReview(cwd, { kind: "commit", revision: "HEAD" });
		assert.ok(patch.includes(hash));
		assert.match(patch, /Parent: \(root commit\)/);
		assert.match(patch, /diff --git a\/root.txt b\/root.txt/);
		assert.match(patch, /\+root contents/);
		assert.deepEqual(newComments(patch, reviewDocument(patch)), []);
		assert.deepEqual(newComments("", patch), []);
		assert.deepEqual(newComments(patch, patch + "\n#REPLY: Add a test\n"), [
			{ line: patch.split("\n").length + 1, text: "Add a test" },
		]);
	});
});

test("latest commit excludes other commits and local dirty changes; explicit revision works", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("first.txt", "first\n"); commit("first");
		write("second.txt", "second\n"); const second = commit("second");
		write("third.txt", "third\n"); const third = commit("third");
		write("third.txt", "dirty\n");
		const status = git("status", "--porcelain");
		const latest = await gitReview(cwd, parseReviewTarget("commit"));
		assert.ok(latest.includes(third));
		assert.match(latest, /\+third/);
		assert.doesNotMatch(latest, /second.txt|\+dirty/);
		const previous = await gitReview(cwd, parseReviewTarget("commit HEAD~1"));
		assert.ok(previous.includes(second));
		assert.match(previous, /\+second/);
		assert.doesNotMatch(previous, /third.txt/);
		assert.equal(git("status", "--porcelain"), status);
	});
});

test("merge commit is compared with its first parent", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("root.txt", "root\n"); commit();
		git("checkout", "--quiet", "-b", "feature");
		write("feature.txt", "feature\n"); commit();
		git("checkout", "--quiet", "main");
		write("main-only.txt", "base update\n"); const parent = commit();
		git("merge", "--quiet", "--no-ff", "feature", "-m", "merge feature");
		const patch = await gitReview(cwd, parseReviewTarget("commit"));
		assert.ok(patch.includes(`# Parent: ${parent}`));
		assert.match(patch, /\+feature/);
		assert.doesNotMatch(patch, /main-only.txt/);
	});
});

test("PR includes all feature commits since divergence, not unrelated base-branch updates", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("root.txt", "root\n"); const mergeBase = commit();
		git("checkout", "--quiet", "-b", "feature");
		write("one.txt", "feature one\n"); commit();
		write("two.txt", "feature two\n"); commit();
		git("checkout", "--quiet", "main");
		write("main-only.txt", "unrelated base update\n"); commit();
		git("checkout", "--quiet", "feature");
		write("dirty.txt", "not committed\n");
		const patch = await gitReview(cwd, parseReviewTarget("pr main"));
		assert.ok(patch.includes(`# Merge base: ${mergeBase}`));
		assert.match(patch, /\+feature one/);
		assert.match(patch, /\+feature two/);
		assert.doesNotMatch(patch, /main-only.txt|dirty.txt/);
		const automatic = await gitReview(cwd, parseReviewTarget("pr"));
		assert.match(automatic, /# Base: refs\/heads\/main/);
		assert.match(automatic, /\+feature one/);
	});
});

test("PR prefers the remote default branch even if its name is not main/master", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("root.txt", "root\n"); const base = commit();
		git("update-ref", "refs/remotes/origin/trunk", base);
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
		git("checkout", "--quiet", "-b", "feature");
		write("feature.txt", "feature\n"); commit();
		const patch = await gitReview(cwd, parseReviewTarget("pr"));
		assert.match(patch, /# Base: refs\/remotes\/origin\/trunk/);
	});
});

test("working diff combines staged and unstaged changes against HEAD, excluding untracked files", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("tracked.txt", "base\n"); commit();
		write("tracked.txt", "staged\n"); git("add", "tracked.txt");
		write("tracked.txt", "unstaged\n");
		write("added.txt", "staged addition\n"); git("add", "added.txt");
		write("untracked.txt", "untracked\n");
		const status = git("status", "--porcelain");
		const patch = await gitReview(cwd, parseReviewTarget("diff"));
		assert.match(patch, /-base\n\+unstaged/);
		assert.match(patch, /\+staged addition/);
		assert.doesNotMatch(patch, /\+staged\n|a\/untracked.txt/);
		assert.equal(git("status", "--porcelain"), status);
	});
});

test("Git reviews work from a subdirectory and include the whole repository", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("nested/one.txt", "nested\n"); write("outside.txt", "outside\n"); commit();
		const patch = await gitReview(join(cwd, "nested"), parseReviewTarget("commit"));
		assert.match(patch, /a\/nested\/one.txt/);
		assert.match(patch, /a\/outside.txt/);
	});
});

test("empty patches return nothing; missing repo/base/commit produce errors", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("root.txt", "root\n"); commit();
		assert.equal(await gitReview(cwd, parseReviewTarget("diff")), undefined);
		assert.equal(await gitReview(cwd, parseReviewTarget("pr main")), undefined);
		git("commit", "--quiet", "--allow-empty", "-m", "empty");
		assert.equal(await gitReview(cwd, parseReviewTarget("commit")), undefined);
		await assert.rejects(gitReview(cwd, parseReviewTarget("commit nonexistent")));
		await assert.rejects(gitReview(cwd, parseReviewTarget("commit --help")));
		git("checkout", "--quiet", "-b", "feature"); git("branch", "-D", "main");
		await assert.rejects(gitReview(cwd, parseReviewTarget("pr")), /Specify it explicitly/);
	});
	const directory = mkdtempSync(join(tmpdir(), "pi-review-not-git-"));
	try {
		await assert.rejects(gitReview(directory, parseReviewTarget("commit")), /not a git repository/);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("external diff and textconv programs are never executed", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("example.txt", "old\n"); commit();
		write("example.txt", "new\n");
		write(".gitattributes", "*.txt diff=reviewtest\n");
		const marker = join(cwd, "external-ran");
		git("config", "diff.reviewtest.command", `touch ${marker}`);
		git("config", "diff.reviewtest.textconv", `touch ${marker}`);
		git("config", "diff.external", `touch ${marker}`);
		const patch = await gitReview(cwd, parseReviewTarget("diff"));
		assert.match(patch, /\+new/);
		assert.equal(existsSync(marker), false);
	});
});

test("snapshot headers record reproducible commands, including merge-base lookup and quoted repo paths", async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("root.txt", "root\n"); commit();
		const root = await gitReview(cwd, parseReviewTarget("c"));
		git("checkout", "--quiet", "-b", "feature");
		write("feature.txt", "feature\n"); commit();
		const single = await gitReview(cwd, parseReviewTarget("c"));
		const pr = await gitReview(cwd, parseReviewTarget("p main"));
		write("feature.txt", "working change\n");
		const working = await gitReview(cwd, parseReviewTarget("d"));
		const before = git("status", "--porcelain");
		for (const snapshot of [root, single, pr, working]) {
			const command = /^# Generated with: (.+)$/m.exec(snapshot)[1];
			const actual = execFileSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8" });
			const expected = snapshot.slice(snapshot.indexOf("\ndiff --git ") + 1);
			assert.equal(actual, expected);
			assert.match(snapshot, /Reference snapshot only; implement review comments in the real repository files/);
		}
		const mergeCommand = /^# Merge-base command: (.+)$/m.exec(pr)[1];
		assert.equal(execFileSync("/bin/sh", ["-c", mergeCommand], { cwd, encoding: "utf8" }).trim(), git("merge-base", "main", "HEAD"));
		assert.match(root, /# Generated with: .* diff-tree --root /);
		assert.match(single, /# Generated with: .* diff /);
		assert.equal(git("status", "--porcelain"), before);
	}, "repo 'quoted' & spaced");
});

test("inline and file-based patch prompts require editing real files rather than the snapshot", () => {
	const prompts = [reviewPrompt("patch #REPLY: fix", "this Git patch", "patch"),
		reviewFilePrompt("/tmp/review.diff", "/tmp/comments.json", "this Git patch", "patch")];
	for (const prompt of prompts) {
		assert.match(prompt, /read its header for the repository and generation command/);
		assert.match(prompt, /inspect and edit the real repository files/);
		assert.match(prompt, /Do not edit or apply the review snapshot/);
	}
	assert.doesNotMatch(reviewPrompt("reply #REPLY: fix"), /real repository files/);
});

test("review padding and prompts preserve significant trailing whitespace in patch lines", () => {
	const patch = "diff --git a/file b/file\n@@ -1 +1 @@\n unchanged  \n";
	assert.equal(reviewDocument(patch), patch + "\n");
	assert.ok(reviewPrompt(patch, "this Git patch", "patch").includes("<![CDATA[\n" + patch + "]]></patch>"));
});

test("patch prompts identify Git patches in XML and retain the diff filetype without syntax colors", () => {
	const inline = reviewPrompt("patch #REPLY: comment", "this Git patch", "patch");
	assert.match(inline, /<patch subject="this Git patch"><!\[CDATA\[\npatch #REPLY: comment\n\]\]><\/patch>/);
	assert.doesNotMatch(inline, /<review|<document/);
	const filePrompt = reviewFilePrompt("/tmp/review.diff", "/tmp/comments.json", "this Git patch", "patch");
	assert.match(filePrompt, /<patch subject="this Git patch">/);
	assert.match(filePrompt, /<annotated_file>\/tmp\/review.diff<\/annotated_file>/);
	assert.ok(filePrompt.endsWith("</patch>"));
	const script = reviewVimScript("/tmp/review.diff", "diff");
	assert.match(script, /filetype=diff/);
	assert.match(script, /if &l:filetype ==# 'diff'\n  setlocal syntax=OFF\n  syntax clear/);
});
