import assert from "node:assert/strict";
import test from "node:test";
import { gitReview } from "./fixtures/comparison.mjs";
import { withRepository } from "./fixtures/repository.mjs";

async function stacked(fn) {
	await withRepository(async repo => {
		const { write, commit, git } = repo;
		write("root.txt", "root\n"); const root = commit("root");
		git("checkout", "--quiet", "-b", "parent");
		write("parent.txt", "parent feature\n"); const fork = commit("parent feature");
		git("checkout", "--quiet", "-b", "child");
		write("child.txt", "child feature\n"); const head = commit("child feature");
		await fn({ ...repo, root, fork, head });
	});
}

const automatic = cwd => gitReview(cwd, { kind: "pr" });
function onlyChild(patch) {
	assert.match(patch, /diff --git a\/child.txt b\/child.txt/);
	assert.doesNotMatch(patch, /diff --git a\/parent.txt|diff --git a\/parent-later.txt/);
}

test("recorded VS Code base selects a stacked parent instead of the repository default", async () => {
	await stacked(async ({ cwd, git, fork }) => {
		git("update-ref", "refs/remotes/origin/parent", fork);
		git("config", "branch.child.vscode-merge-base", "origin/parent");
		const before = [git("status", "--porcelain"), git("for-each-ref"), git("config", "--local", "--list")];
		const patch = await automatic(cwd);
		onlyChild(patch);
		assert.match(patch, /# Base: origin\/parent /);
		assert.match(patch, /# Base selection: branch.child.vscode-merge-base/);
		assert.deepEqual([git("status", "--porcelain"), git("for-each-ref"), git("config", "--local", "--list")], before);
	});
});

test("explicit base overrides recorded settings; gh-merge-base takes precedence over the VS Code hint", async () => {
	await stacked(async ({ cwd, git }) => {
		git("config", "branch.child.gh-merge-base", "parent");
		git("config", "branch.child.vscode-merge-base", "main");
		const patch = await automatic(cwd);
		onlyChild(patch); assert.match(patch, /# Base selection: branch.child.gh-merge-base/);
		const explicit = await gitReview(cwd, { kind: "pr", base: "main" });
		assert.match(explicit, /diff --git a\/parent.txt/);
		assert.match(explicit, /# Base selection: explicit argument/);
	});
});

test("unavailable configured bases report an error instead of silently changing the comparison", async () => {
	await stacked(async ({ cwd, git }) => {
		for (const setting of ["gh-merge-base", "vscode-merge-base"]) {
			git("config", `branch.child.${setting}`, "missing-base");
			await assert.rejects(automatic(cwd), /Configured PR base .* is unavailable.*specify \/re pr <base>/);
			onlyChild(await gitReview(cwd, { kind: "pr", base: "parent" }));
			git("config", "--unset", `branch.child.${setting}`);
		}
	});
});

test("configured revisions remain option-safe and branch names may contain slashes and dots", async () => {
	await stacked(async ({ cwd, git }) => {
		git("branch", "-m", "team/child.topic");
		git("config", "branch.team/child.topic.gh-merge-base", "--help");
		await assert.rejects(automatic(cwd), /Configured PR base/);
		git("config", "branch.team/child.topic.gh-merge-base", "parent");
		onlyChild(await automatic(cwd));
	});
});

test("history infers a stacked parent without any recorded base", async () => {
	await stacked(async ({ cwd, fork }) => {
		const patch = await automatic(cwd);
		onlyChild(patch); assert.match(patch, /# Base: refs\/heads\/parent /);
		assert.ok(patch.includes(`# Merge base: ${fork}`));
		assert.match(patch, /# Base selection: Git history/);
	});
});

test("history handles remote-only parents that advanced after the child branched", async () => {
	await stacked(async ({ cwd, git, write, commit, fork }) => {
		git("checkout", "--quiet", "parent");
		write("parent-later.txt", "not part of child PR\n"); const later = commit("parent advanced");
		git("update-ref", "refs/remotes/origin/parent", later);
		git("checkout", "--quiet", "child"); git("branch", "-D", "parent");
		const patch = await automatic(cwd);
		onlyChild(patch); assert.match(patch, /# Base: refs\/remotes\/origin\/parent /);
		assert.ok(patch.includes(`# Merge base: ${fork}`));
	});
});

test("local/remote parent aliases collapse even when the local base ref is stale", async () => {
	await stacked(async ({ cwd, git, write, commit }) => {
		git("remote", "add", "origin", "https://example.invalid/repo.git");
		git("checkout", "--quiet", "-b", "advance-parent", "parent");
		write("parent-later.txt", "parent advanced remotely\n"); const later = commit("parent advanced");
		git("update-ref", "refs/remotes/origin/parent", later);
		git("config", "branch.parent.remote", "origin"); git("config", "branch.parent.merge", "refs/heads/parent");
		git("checkout", "--quiet", "child"); git("branch", "-D", "advance-parent");
		const patch = await automatic(cwd);
		onlyChild(patch); assert.match(patch, /# Base: refs\/remotes\/origin\/parent /);
	});
});

test("the child's own tracking refs never reduce a review to only unpublished commits", async () => {
	await stacked(async ({ cwd, git, write, commit, head }) => {
		git("remote", "add", "origin", "https://example.invalid/repo.git");
		git("update-ref", "refs/remotes/origin/child", head);
		git("update-ref", "refs/remotes/origin/old-child-name", head);
		git("config", "branch.child.remote", "origin"); git("config", "branch.child.merge", "refs/heads/old-child-name");
		write("unpublished.txt", "unpublished\n"); commit("unpublished child change");
		const patch = await automatic(cwd);
		onlyChild(patch); assert.match(patch, /diff --git a\/unpublished.txt/);
		assert.match(patch, /# Base: refs\/heads\/parent /);
	});
});

test("descendants and equal-HEAD branch refs cannot masquerade as the parent", async () => {
	await stacked(async ({ cwd, git, write, commit }) => {
		git("branch", "same-head"); git("checkout", "--quiet", "-b", "descendant");
		write("descendant.txt", "descendant\n"); commit("descendant");
		git("checkout", "--quiet", "child");
		onlyChild(await automatic(cwd));
	});
});

test("history keeps the repository default when all candidates give the same merge base", async () => {
	await withRepository(async ({ cwd, git, write, commit }) => {
		write("root.txt", "root\n"); const root = commit();
		git("update-ref", "refs/remotes/origin/trunk", root);
		git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
		git("checkout", "--quiet", "-b", "sibling"); write("sibling.txt", "sibling\n"); commit();
		git("checkout", "--quiet", "-b", "feature", "main"); write("feature.txt", "feature\n"); commit();
		const patch = await automatic(cwd);
		assert.match(patch, /# Base: refs\/remotes\/origin\/trunk /);
		assert.match(patch, /# Base selection: repository default/);
		assert.doesNotMatch(patch, /diff --git a\/sibling.txt/);
	});
});

test("a unique ancestor works without any conventional main/master branch", async () => {
	await stacked(async ({ cwd, git }) => {
		git("branch", "-D", "main");
		onlyChild(await automatic(cwd));
	});
});

test("multiple aliases at the same parent commit do not create false ambiguity", async () => {
	await stacked(async ({ cwd, git, fork }) => {
		git("update-ref", "refs/remotes/origin/parent", fork);
		git("update-ref", "refs/remotes/other/parent", fork);
		onlyChild(await automatic(cwd));
	});
});

test("different plausible parent branches require an explicit base, not a timestamp-based guess", async () => {
	await stacked(async ({ cwd, git, write, commit }) => {
		for (const name of ["left", "right"]) {
			git("checkout", "--quiet", "-b", name, "parent"); write(`${name}.txt`, name + "\n"); commit(name);
		}
		git("checkout", "--quiet", "child"); git("branch", "-D", "parent");
		await assert.rejects(automatic(cwd), /Ambiguous PR base.*Specify \/re pr <base>/);
		onlyChild(await gitReview(cwd, { kind: "pr", base: "left" }));
		git("config", "branch.child.gh-merge-base", "left"); onlyChild(await automatic(cwd));
	});
});

test("incomparable ancestry-frontier commits are ambiguous even when both are merged into HEAD", async () => {
	await withRepository(async ({ cwd, git, write, commit }) => {
		write("root.txt", "root\n"); commit();
		git("checkout", "--quiet", "-b", "left"); write("left.txt", "left\n"); commit();
		git("checkout", "--quiet", "-b", "right", "main"); write("right.txt", "right\n"); commit();
		git("checkout", "--quiet", "-b", "feature", "left");
		git("merge", "--quiet", "--no-ff", "right", "-m", "merge right");
		write("feature.txt", "feature\n"); commit();
		await assert.rejects(automatic(cwd), /Ambiguous PR base/);
		assert.match(await gitReview(cwd, { kind: "pr", base: "main" }), /diff --git a\/feature.txt/);
	});
});

test("a PR already contained in the default branch does not resurrect stale feature changes", async () => {
	await stacked(async ({ cwd, git }) => {
		git("checkout", "--quiet", "main"); git("merge", "--quiet", "--no-ff", "child", "-m", "merge child");
		git("checkout", "--quiet", "child");
		assert.equal(await automatic(cwd), undefined);
	});
});

test("detached HEAD uses the repository default unless a base is explicitly supplied", async () => {
	await stacked(async ({ cwd, git }) => {
		git("checkout", "--quiet", "--detach");
		const patch = await automatic(cwd);
		assert.match(patch, /# Base: refs\/heads\/main /);
		assert.match(patch, /diff --git a\/parent.txt/);
		onlyChild(await gitReview(cwd, { kind: "pr", base: "parent" }));
	});
});

test("very large candidate sets stop with an actionable bound; configuration bypasses inference", async () => {
	await stacked(async ({ cwd, git, root }) => {
		const tree = git("rev-parse", "main^{tree}");
		for (let index = 0; index < 256; index++) {
			const hash = git("commit-tree", tree, "-p", root, "-m", `candidate ${index}`);
			git("update-ref", `refs/remotes/other/branch-${index}`, hash);
		}
		await assert.rejects(automatic(cwd), /More than 256 possible PR bases/);
		git("config", "branch.child.gh-merge-base", "parent"); onlyChild(await automatic(cwd));
	});
});
