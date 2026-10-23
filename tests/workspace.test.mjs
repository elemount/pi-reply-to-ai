import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
			assert.equal(existsSync(join(workspace.directory, "copies")), false);
			assert.ok(workspace.files.some(file => file.source.endsWith("a.ts")));
			assert.ok(workspace.files.some(file => file.source.endsWith("b.ts")));
			assert.ok(workspace.files.every(file => !/ignored\.txt|node_modules|binary\.dat|\.env$/.test(file.source)));
			const a = workspace.files.find(file => file.source.endsWith("a.ts"));
			await workspace.load(a.id);
			assert.match(readFileSync(a.copy, "utf8"), /const a = 1;/);
			assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "const a = 1;\n");
			assert.equal(workspace.files.filter(file => existsSync(file.copy)).length, 1);
			assert.ok(workspace.files.every(file => existsSync(dirname(file.copy)) === (file.id === a.id)));
			writeFileSync(a.copy, "#REPLY: keep my edits\n"); await workspace.load(a.id);
			assert.equal(readFileSync(a.copy, "utf8"), "#REPLY: keep my edits\n");
			await assert.rejects(workspace.load(9999), /Invalid review file selection/);
		} finally { workspace.cleanup(); }
	});
});

test("directory probing is bounded and assigns IDs in Git order rather than completion order", async t => {
	await sources(async root => {
		const names = Array.from({ length: 24 }, (_, index) => `file-${String(index).padStart(2, "0")}.ts`);
		for (const name of names) writeFileSync(join(root, name), "export const a = 1;\n");
		const original = fs.lstat;
		let active = 0, peak = 0, calls = 0;
		t.mock.method(fs, "lstat", async (...args) => {
			active++; calls++; peak = Math.max(peak, active);
			try {
				const index = Number(basename(args[0]).match(/\d+/)[0]);
				await sleep(8 - index % 8);
				return await original(...args);
			} finally { active--; }
		});
		syncBuiltinESMExports();
		try {
			const workspace = await createFileWorkspace([root], root);
			try {
				assert.ok(peak > 1); assert.ok(peak <= 8); assert.equal(calls, names.length); assert.equal(active, 0);
				assert.deepEqual(workspace.files.map(file => basename(file.source)), names);
				assert.deepEqual(workspace.files.map(file => file.id), names.map((_, index) => index));
				assert.equal(existsSync(join(workspace.directory, "copies")), false);
			} finally { workspace.cleanup(); }
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	});
});

test("directory probing stops within one batch of the file limit", async t => {
	await sources(async root => {
		for (let index = 0; index < 2016; index++) writeFileSync(join(root, `file-${String(index).padStart(4, "0")}.txt`), "text\n");
		const original = fs.lstat; let calls = 0;
		t.mock.method(fs, "lstat", (...args) => { calls++; return original(...args); });
		syncBuiltinESMExports();
		try {
			await assert.rejects(createFileWorkspace([root], root), /More than 2000 reviewable files/);
			assert.ok(calls > 2000 && calls <= 2008, `Unexpected probe count: ${calls}`);
			assert.equal(existsSync(join(root, ".git")), false);
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
	});
});

test("batched probing keeps encoding, symlink, size, and disappearing-file checks", async t => {
	await sources(async base => {
		const root = join(base, "project"); mkdirSync(root);
		writeFileSync(join(base, "outside.txt"), "outside\n");
		writeFileSync(join(root, "a.txt"), "safe\n");
		writeFileSync(join(root, "invalid.txt"), Buffer.from([0xff]));
		writeFileSync(join(root, "binary.txt"), Buffer.from([0]));
		writeFileSync(join(root, "large.txt"), ""); truncateSync(join(root, "large.txt"), 33 * 1024 * 1024);
		writeFileSync(join(root, "gone.txt"), "gone\n");
		symlinkSync(join(base, "outside.txt"), join(root, "linked.txt"));
		const original = fs.lstat;
		t.mock.method(fs, "lstat", (...args) => basename(args[0]) === "gone.txt" ? Promise.reject(new Error("File disappeared")) : original(...args));
		syncBuiltinESMExports();
		try {
			const workspace = await createFileWorkspace([root], root);
			try { assert.deepEqual(workspace.files.map(file => basename(file.source)), ["a.txt"]); }
			finally { workspace.cleanup(); }
		} finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
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
			writeFileSync(workspace.files[0].saved, "#REPLY: saved comment\n");
			writeFileSync(workspace.files[0].copy, "#REPLY: later unsaved edit\n");
			writeFileSync(workspace.files[1].saved, "no comments\n");
			writeFileSync(join(workspace.directory, "saved", "unregistered.txt"), "#REPLY: ignored\n");
			const reviews = workspace.collect();
			assert.equal(reviews.length, 1); assert.equal(reviews[0].content, "#REPLY: saved comment\n");
			assert.equal(existsSync(workspace.files[1].saved), false);
			assert.equal(existsSync(join(workspace.directory, "saved", "unregistered.txt")), false);
			assert.equal(existsSync(join(workspace.directory, "copies")), false);
			assert.equal(readFileSync(join(root, "a.txt"), "utf8"), "a\n");
		} finally { workspace.cleanup(); }
	});
});

test("file submission is marker-presence only, including existing or empty markers; unsaved files are excluded", async () => {
	await sources(async root => {
		writeFileSync(join(root, "a.txt"), "#REPLY: existing\n"); writeFileSync(join(root, "b.txt"), "b\n");
		const workspace = await createFileWorkspace(["a.txt", "b.txt"], root);
		try {
			writeFileSync(workspace.files[0].saved, "#REPLY:\n");
			writeFileSync(workspace.files[1].copy, "#REPLY: not saved\n");
			assert.equal(workspace.collect().length, 1);
		} finally { workspace.cleanup(); }
	});
});

test("only #REPLY: includes saved files; diff hunks, nullish operators, and bare prefixes do not", async () => {
	await sources(async root => {
		const contents = ["@@ -1 +1 @@\n-old\n+new\n", "const value = input ?? fallback;\n", "REPLY: ordinary text\nREVIEW: ordinary text\n", "#REPLY:\n"];
		const names = contents.map((content, index) => {
			const name = `${index}.txt`; writeFileSync(join(root, name), content); return name;
		});
		for (const paths of [names, [root]]) {
			const workspace = await createFileWorkspace(paths, root);
			try {
				for (const item of workspace.files) { await workspace.load(item.id); writeFileSync(item.saved, readFileSync(item.copy)); }
				const reviews = workspace.collect();
				assert.equal(reviews.length, 1); assert.ok(reviews[0].source.endsWith("3.txt"));
				assert.equal(reviews[0].content, "#REPLY:\n\n");
				assert.ok(workspace.files.filter(item => !item.source.endsWith("3.txt")).every(item => !existsSync(item.saved)));
			} finally { workspace.cleanup(); }
		}
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
