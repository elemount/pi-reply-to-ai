import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import test from "node:test";
import { createFileWorkspace } from "../file-workspace.ts";
import { parseReviewTarget } from "../git.ts";
import { withRepository } from "./fixtures/repository.mjs";

async function sources(fn) {
	const root = mkdtempSync(join(tmpdir(), "pi-workspace-source-"));
	try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("multiple references retain quoted spaces, Windows backslashes, and literal shell characters", () => {
	assert.deepEqual(parseReviewTarget('@a.ts @"two words.ts"'), { kind: "files", paths: ["a.ts", "two words.ts"] });
	assert.deepEqual(parseReviewTarget("@'one @ name.ts' @src/"), { kind: "files", paths: ["one @ name.ts", "src/"] });
	assert.deepEqual(parseReviewTarget('@C:\\src\\a.ts @"C:\\My Project\\b.ts"'), { kind: "files", paths: ["C:\\src\\a.ts", "C:\\My Project\\b.ts"] });
	assert.deepEqual(parseReviewTarget('@single path.ts'), { kind: "file", path: "single path.ts" });
	for (const input of ['@a @', '@a @"unterminated', '@"a" trailing', '@"" @b']) assert.throws(() => parseReviewTarget(input));
});

test("non-repository directories honor .gitignore, skip binary/sensitive files, and copy only opened files", async () => {
	await sources(async root => {
		mkdirSync(join(root, "nested")); mkdirSync(join(root, "node_modules"));
		writeFileSync(join(root, ".gitignore"), "ignored.txt\n");
		writeFileSync(join(root, "a.ts"), "const a = 1;\n");
		writeFileSync(join(root, "nested", "b.ts"), "const b = 2;\n");
		writeFileSync(join(root, "ignored.txt"), "ignored");
		writeFileSync(join(root, "node_modules", "pkg.js"), "ignored");
		writeFileSync(join(root, ".env"), "sensitive");
		writeFileSync(join(root, "binary.dat"), Buffer.from([0, 1, 2]));
		const workspace = await createFileWorkspace([root], root);
		try {
			assert.equal(workspace.tree, true);
			assert.equal(existsSync(join(root, ".git")), false);
			assert.ok(workspace.files.every(file => !existsSync(file.copy)));
			assert.ok(workspace.files.some(file => file.source.endsWith("a.ts")));
			assert.ok(workspace.files.some(file => file.source.endsWith("b.ts")));
			assert.ok(workspace.files.every(file => !/ignored\.txt|node_modules|binary\.dat|\.env$/.test(file.source)));
			const a = workspace.files.find(file => file.source.endsWith("a.ts"));
			await workspace.load(a.id);
			assert.match(readFileSync(a.copy, "utf8"), /const a = 1;/);
			assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "const a = 1;\n");
			assert.equal(workspace.files.filter(file => existsSync(file.copy)).length, 1);
			await assert.rejects(workspace.load(9999), /Invalid review file selection/);
		} finally { workspace.cleanup(); }
	});
});

test("directory review ignores inherited Git directory/index overrides and never initializes the source", async () => {
	await sources(async root => {
		writeFileSync(join(root, "a.txt"), "a\n");
		const names = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"];
		const before = names.map(name => process.env[name]);
		try {
			for (const name of names) process.env[name] = join(root, "must-not-create", name);
			const workspace = await createFileWorkspace([root], root);
			try { assert.equal(workspace.files.length, 1); assert.equal(existsSync(join(root, "must-not-create")), false); assert.equal(existsSync(join(root, ".git")), false); }
			finally { workspace.cleanup(); }
		} finally { names.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; }); }
	});
});

test("existing repositories and nested directory selections remain read-only", async () => {
	await withRepository(async ({ cwd, git, write, commit }) => {
		write("src/a.txt", "a\n"); write("outside.txt", "outside\n"); write(".gitignore", "src/ignored.txt\n"); commit();
		write("src/ignored.txt", "ignored\n");
		const before = git("status", "--porcelain");
		const workspace = await createFileWorkspace([join(cwd, "src")], cwd);
		try {
			assert.equal(workspace.files.length, 1);
			assert.ok(workspace.files[0].source.endsWith("a.txt"));
			assert.equal(git("status", "--porcelain"), before);
		} finally { workspace.cleanup(); }
	});
});

test("explicit files deduplicate sources and use independent copies and snapshots", async () => {
	await sources(async root => {
		writeFileSync(join(root, "a.txt"), "a\n"); writeFileSync(join(root, "b.txt"), "b\n");
		const workspace = await createFileWorkspace(["a.txt", "b.txt", "a.txt"], root);
		try {
			assert.equal(workspace.tree, false); assert.equal(workspace.files.length, 2);
			assert.ok(workspace.files.every(file => existsSync(file.copy)));
			writeFileSync(workspace.files[0].saved, "@@ saved comment\n");
			writeFileSync(workspace.files[0].copy, "@@ later unsaved edit\n");
			writeFileSync(workspace.files[1].saved, "no comments\n");
			writeFileSync(join(workspace.directory, "saved", "unregistered.txt"), "@@ ignored\n");
			const reviews = workspace.collect();
			assert.equal(reviews.length, 1); assert.equal(reviews[0].content, "@@ saved comment\n");
			assert.equal(existsSync(workspace.files[1].saved), false);
			assert.equal(existsSync(join(workspace.directory, "saved", "unregistered.txt")), false);
			assert.equal(existsSync(join(workspace.directory, "copies")), false);
			assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
		} finally { workspace.cleanup(); }
	});
});

test("file submission is marker-presence only, including existing or empty markers; unsaved files are excluded", async () => {
	await sources(async root => {
		writeFileSync(join(root, "a.txt"), "@@ existing\n"); writeFileSync(join(root, "b.txt"), "b\n");
		const workspace = await createFileWorkspace(["a.txt", "b.txt"], root);
		try {
			writeFileSync(workspace.files[0].saved, "@@\n");
			writeFileSync(workspace.files[1].copy, "@@ not saved\n");
			assert.equal(workspace.collect().length, 1);
		} finally { workspace.cleanup(); }
	});
});

test("lazy-copy request service validates indexes and answers without source modifications", async () => {
	await sources(async root => {
		writeFileSync(join(root, "a.txt"), "a\n");
		const workspace = await createFileWorkspace([root], root);
		const stop = workspace.startLoader();
		try {
			for (const [sequence, id] of [[1, 9999], [2, 0]]) {
				writeFileSync(join(workspace.directory, "request.json"), JSON.stringify({ sequence, id }));
				let response;
				for (let attempt = 0; attempt < 200; attempt++) {
					try { response = JSON.parse(readFileSync(join(workspace.directory, "response.json"), "utf8")); } catch {}
					if (response?.sequence === sequence) break;
					await sleep(10);
				}
				assert.equal(response.sequence, sequence);
				if (id === 9999) assert.match(response.error, /Invalid review file selection/);
				else { assert.equal(response.error, undefined); assert.ok(existsSync(workspace.files[0].copy)); }
			}
			assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
		} finally { await stop(); workspace.cleanup(); }
	});
});
