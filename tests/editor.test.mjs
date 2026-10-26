import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { editReview } from "../editor.ts";
import { editorCandidates, environmentValue, formatShellCommand, isWsl } from "../platform.ts";

const mock = fileURLToPath(new URL("./fixtures/mock-nvim.mjs", import.meta.url));
const document = { title: "Reply", sources: [{ id: 0, reply: 0, label: "reply", content: "original" }] };
async function run(launch) {
	const previous = process.env.PI_REVIEW_EDITOR; process.env.PI_REVIEW_EDITOR = mock;
	const lifecycle = []; let manifestPath;
	const ctx = { cwd: process.cwd(), ui: { custom: factory => new Promise((resolve, reject) => {
		Promise.resolve(factory({ stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start"), requestRender: () => lifecycle.push("render") }, {}, {}, resolve)).catch(reject);
	}) } };
	try {
		return await editReview(document, ctx, {}, async (editor, args, cwd, env) => {
			manifestPath = env.PI_REVIEW_MANIFEST;
			assert.equal(editor, mock);
			assert.deepEqual(args, ["-c", "lua dofile(vim.env.PI_REVIEW_RUNTIME .. '/nvim/init.lua')"]);
			for (const flag of ['--clean', '--noplugin', '-u', '-i', '-n']) assert.ok(!args.includes(flag));
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
			await launch(manifest);
		});
	} finally {
		assert.deepEqual(lifecycle, ["stop", "start", "render"]);
		if (manifestPath) assert.equal(existsSync(dirname(manifestPath)), false);
		if (previous === undefined) delete process.env.PI_REVIEW_EDITOR; else process.env.PI_REVIEW_EDITOR = previous;
	}
}
test("one-shot editor data is cleaned after cancellation and after successful submission", async () => {
	assert.equal(await run(async () => {}), undefined);
	assert.deepEqual(await run(async manifest => writeFileSync(manifest.result, "[]")), []);
});
test("spawn errors always restore the Pi TUI and remove transient manifest/result data", async () => {
	await assert.rejects(run(async () => { throw new Error("spawn ENOENT"); }), /spawn ENOENT/);
});
test("malformed, oversized, unregistered and symlinked editor results cannot submit", async () => {
	for (const write of [
		manifest => writeFileSync(manifest.result, "not JSON"),
		manifest => writeFileSync(manifest.result, JSON.stringify([{ source: 99, line: 1, endLine: 1, context: "1: x", text: "x" }])),
		manifest => { writeFileSync(manifest.result, ""); truncateSync(manifest.result, 64 * 1024 * 1024 + 1); },
		manifest => symlinkSync("manifest.json", manifest.result),
	]) await assert.rejects(run(async manifest => write(manifest)));
});
test("editor filesystem cleanup does not follow symlinked results or touch original files", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-source-")), original = join(directory, "source.txt"); writeFileSync(original, "unchanged\n");
	try {
		await assert.rejects(run(async manifest => symlinkSync(original, manifest.result)), /Invalid/);
		assert.equal(readFileSync(original, "utf8"), "unchanged\n");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
test("native executable discovery and shell provenance retain Windows/WSL-safe pure helpers", () => {
	assert.equal(environmentValue({ Path: "value" }, "PATH", "win32"), "value");
	assert.deepEqual(editorCandidates("nvim", "C:\\project", { Path: '"C:\\Program Files\\Neovim\\bin";C:\\other' }, "win32"),
		["C:\\Program Files\\Neovim\\bin\\nvim.exe", "C:\\Program Files\\Neovim\\bin\\nvim.com", "C:\\other\\nvim.exe", "C:\\other\\nvim.com"]);
	assert.equal(isWsl({ WSL_DISTRO_NAME: "Ubuntu" }, "linux"), true);
	assert.match(formatShellCommand("git", ["-C", "C:\\a'b", "diff"], "win32"), /^& 'git' '-C' 'C:\\a''b' 'diff'$/);
	assert.equal(formatShellCommand("git", ["-C", "/tmp/a'b", "diff"], "linux"), "git -C '/tmp/a'\\''b' diff");
});
