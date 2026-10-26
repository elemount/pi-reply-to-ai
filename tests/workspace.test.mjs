import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileSources, readSource } from "../file-workspace.ts";
import { parseReviewTarget } from "../git.ts";
import { withRepository } from "./fixtures/repository.mjs";

async function withFiles(fn) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-files-test-"));
	const write = (name, content = "text\n") => { const path = join(cwd, name); mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); };
	try { await fn({ cwd, write }); } finally { rmSync(cwd, { recursive: true, force: true }); }
}
test("multiple-reference parsing preserves quoted spaces, literal @ and Windows backslashes", () => {
	for (const [input, paths] of [['@"a b.ts" @c.ts', ["a b.ts", "c.ts"]], ["@a@b @c", ["a@b", "c"]],
		['@"C:\\a b\\x.ts" @C:\\other\\x.ts', ["C:\\a b\\x.ts", "C:\\other\\x.ts"]]]) assert.deepEqual(parseReviewTarget(input), { kind: "files", paths });
	for (const input of ['@a @', '@"a" garbage', '@a @"unfinished']) assert.throws(() => parseReviewTarget(input));
});
test("explicit files preserve ordering, deduplicate canonical paths and create no source artifacts", async () => {
	await withFiles(async ({ cwd, write }) => {
		write("b.txt", "B\n"); write("a.txt", "A\n"); symlinkSync("a.txt", join(cwd, "alias"));
		const prepared = await fileSources(["b.txt", "a.txt", "alias"], cwd);
		assert.equal(prepared.tree, false); assert.equal(prepared.sources.length, 2);
		assert.match(prepared.sources[0].path, /b.txt$/); assert.equal(await readSource(prepared.sources[0], cwd), "B\n");
		assert.deepEqual(readdirSync(cwd).sort(), ["a.txt", "alias", "b.txt"]);
	});
});
test("ordinary directories honor nested ignore rules without requiring or creating a source repository", async () => {
	await withFiles(async ({ cwd, write }) => {
		write(".gitignore", "ignored.txt\n"); write("ignored.txt"); write("nested/.gitignore", "ignored-child\n"); write("nested/ignored-child"); write("nested/keep.txt");
		const prepared = await fileSources(["."], cwd);
		assert.equal(prepared.tree, true); assert.ok(prepared.sources.some(source => source.label === "nested/keep.txt"));
		assert.ok(prepared.sources.every(source => !source.path.includes("ignored")));
		assert.equal(existsSync(join(cwd, ".git")), false);
		assert.ok(prepared.sources.every(source => !('copy' in source) && !('saved' in source) && !('content' in source)));
	});
});
test("repository directories respect ignore rules, retain tracked ignored files and are deterministic", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("tracked.txt", "tracked\n"); commit(); write(".gitignore", "*.txt\n"); write("ignored.txt", "ignored\n"); write("z.ts", "z\n"); write("a.ts", "a\n");
		const a = await fileSources(["."], cwd), b = await fileSources(["."], cwd);
		assert.deepEqual(a, b); assert.ok(a.sources.some(source => source.label === "tracked.txt")); assert.ok(a.sources.every(source => source.label !== "ignored.txt"));
	});
});
test("directory filtering excludes credentials, dependency caches, symlinks, binary and oversized files", async () => {
	await withFiles(async ({ cwd, write }) => {
		for (const name of ["ok.ts", ".env", ".env.local", "secret.pem", "auth.json", "credentials.json", ".ssh/id_ed25519", "node_modules/pkg/x.ts", ".pi/session"]) write(name);
		write("binary", Buffer.from([0, 1])); write("invalid", Buffer.from([0xff])); write("huge"); truncateSync(join(cwd, "huge"), 32 * 1024 * 1024 + 1);
		symlinkSync("ok.ts", join(cwd, "alias.ts"));
		const result = await fileSources(["."], cwd);
		assert.deepEqual(result.sources.map(source => source.label), ["ok.ts"]);
		assert.equal(readFileSync(join(cwd, "ok.ts"), "utf8"), "text\n");
	});
});
test("lazy opens validate the full UTF-8 content rather than only the discovery sample", async () => {
	await withFiles(async ({ cwd, write }) => {
		write("late-invalid.txt", Buffer.concat([Buffer.alloc(9000, 97), Buffer.from([0xff])]));
		const result = await fileSources(["."], cwd);
		assert.equal(result.sources.length, 1); await assert.rejects(readSource(result.sources[0], cwd), /UTF-8/);
	});
});
test("lazy opens reject replacement symlinks even when they point at a readable text file", async () => {
	await withFiles(async ({ cwd, write }) => {
		write("root/one.txt"); write("outside.txt", "outside\n");
		const result = await fileSources(["root"], cwd), path = join(cwd, "root/one.txt");
		rmSync(path); symlinkSync("../outside.txt", path);
		await assert.rejects(readSource(result.sources[0], cwd), /moved outside/);
	});
});
test("input and file-count bounds are enforced with no source metadata left behind", async () => {
	await withFiles(async ({ cwd, write }) => {
		await assert.rejects(fileSources([], cwd), /1 and 64/);
		await assert.rejects(fileSources(Array(65).fill("."), cwd), /1 and 64/);
		for (let i = 0; i < 2001; i++) write(`many/${i}.txt`);
		await assert.rejects(fileSources(["many"], cwd), /More than 2000/);
		assert.equal(existsSync(join(cwd, "many/.git")), false);
	});
});
