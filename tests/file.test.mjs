import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileReview, resolveReviewPath } from "../file.ts";
import { parseReviewTarget, REVIEW_USAGE } from "../git.ts";
import { reviewFilePrompt, reviewPrompt, reviewVimScript } from "../core.ts";

async function withFiles(fn) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-file-"));
	try { await fn(cwd); }
	finally { rmSync(cwd, { recursive: true, force: true }); }
}

test("@file parsing accepts Pi's quoted completion format and literal paths without shell expansion", () => {
	for (const [input, path] of [
		["@readme.md", "readme.md"], ['@"file with spaces.ts"', "file with spaces.ts"],
		["@'file with spaces.ts'", "file with spaces.ts"], ["@file with spaces.ts", "file with spaces.ts"],
		["@/tmp/source.ts", "/tmp/source.ts"], ["@~/source.ts", "~/source.ts"],
		["@$(touch never-created).txt", "$(touch never-created).txt"],
	]) assert.deepEqual(parseReviewTarget(input), { kind: "file", path });
	for (const input of ["@", '@""', "@''", '@"unterminated', "@'unterminated", "@bad\0path"]) {
		assert.throws(() => parseReviewTarget(input), error => error.message === REVIEW_USAGE);
	}
});

test("file paths are relative to cwd, absolute, or home-relative", () => {
	assert.equal(resolveReviewPath("/tmp/project", "src/main.ts"), "/tmp/project/src/main.ts");
	assert.equal(resolveReviewPath("/tmp/project", "/tmp/absolute.txt"), "/tmp/absolute.txt");
	assert.equal(resolveReviewPath("/tmp/project", "~/example.txt"), join(homedir(), "example.txt"));
});

test("file snapshots preserve UTF-8 content, BOMs, empty files, spaces, and shell-like filenames", async () => {
	await withFiles(async (cwd) => {
		for (const [name, content] of [["source.ts", "export const x = 1;\n"], ["empty.txt", ""],
			["space name.txt", "\u4e2d\u6587\n"], ["bom.txt", "\uFEFFtext\r\n"],
			["$(touch never-created).txt", "literal filename\n"]]) {
			const path = join(cwd, name); writeFileSync(path, content);
			const snapshot = await fileReview(cwd, name);
			assert.equal(snapshot.path, realpathSync(path));
			assert.equal(snapshot.content, content);
			assert.equal(readFileSync(path, "utf8"), content);
		}
	});
});

test("symlink references identify the actual source file", async () => {
	await withFiles(async (cwd) => {
		const source = join(cwd, "source.txt"); writeFileSync(source, "source\n");
		symlinkSync(source, join(cwd, "link.txt"));
		assert.equal((await fileReview(cwd, "link.txt")).path, realpathSync(source));
	});
});

test("missing files, directories, binary/invalid UTF-8 and oversized files are rejected", async () => {
	await withFiles(async (cwd) => {
		await assert.rejects(fileReview(cwd, "missing.txt"));
		await assert.rejects(fileReview(cwd, "."), /regular text file/);
		writeFileSync(join(cwd, "binary.dat"), Buffer.from([0, 1, 2]));
		await assert.rejects(fileReview(cwd, "binary.dat"), /binary/);
		writeFileSync(join(cwd, "invalid.dat"), Buffer.from([0xff, 0xfe]));
		await assert.rejects(fileReview(cwd, "invalid.dat"), /UTF-8/);
		const huge = join(cwd, "huge.txt"); writeFileSync(huge, ""); truncateSync(huge, 32 * 1024 * 1024 + 1);
		await assert.rejects(fileReview(cwd, "huge.txt"), /32 MiB/);
	});
});

test("FIFO references are rejected without waiting for a writer", { timeout: 5000 }, async (t) => {
	await withFiles(async (cwd) => {
		const fifo = join(cwd, "pipe");
		if (spawnSync("mkfifo", [fifo]).status !== 0) { t.skip("mkfifo unavailable"); return; }
		await assert.rejects(fileReview(cwd, "pipe"), /regular text file/);
	});
});

test("file prompts distinguish the original source from the annotated private copy", () => {
	for (const prompt of [reviewPrompt("source @@ comment", "this file", "file", '/tmp/source & "name".ts'),
		reviewFilePrompt("/tmp/copy.ts", "/tmp/comments.json", "this file", "file", '/tmp/source & "name".ts')]) {
		assert.ok(prompt.includes('<file subject="this file" source="/tmp/source &amp; &quot;name&quot;.ts">'));
		assert.match(prompt, /inspect the original file/i);
		assert.match(prompt, /edit that original file, not the review snapshot/);
	}
	assert.match(reviewVimScript("/tmp/copy.ts", "auto"), /filetype on\nfiletype detect/);
});
