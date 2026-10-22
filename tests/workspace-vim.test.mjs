import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { launchEditor } from "../editor.ts";
import { prepareFileWorkspaceReview } from "../file-workspace.ts";

const installed = spawnSync("vim", ["--version"], { encoding: "utf8" }).status === 0;

async function runWorkspace({ tree, commands, check }) {
	const root = mkdtempSync(join(tmpdir(), "pi-real-workspace-"));
	const lifecycle = [], observed = {};
	let result;
	try {
		writeFileSync(join(root, "a.ts"), "const a = 1;\n"); writeFileSync(join(root, "b.ts"), "const b = 2;\n");
		mkdirSync(join(root, "nested")); writeFileSync(join(root, "nested", "unused.ts"), "unused\n");
		const driver = join(root, "driver.vim"), report = join(root, "report.json"), log = join(root, "vim.log");
		// Create the driver only after directory enumeration, so it is not a tree candidate.
		const ctx = { cwd: root, ui: { custom: async factory => {
			let result;
			await factory({ stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start"), requestRender: () => {} }, {}, {}, value => { result = value; });
			return result;
		} } };
		const runner = async (editor, args, cwd) => {
			const script = args[args.indexOf("-S") + 1];
			const manifest = JSON.parse(readFileSync(join(dirname(script), "manifest.json"), "utf8"));
			writeFileSync(driver, [
				`let g:report_file = ${JSON.stringify(report)}`,
				...commands,
				"cquit 70",
			].join("\n"));
			const separator = args.indexOf("--");
			try {
				await launchEditor(editor, ["-u", "NONE", "-es", "-V1" + log, ...args.slice(0, separator), "-S", driver, ...args.slice(separator)], cwd);
			} catch (error) { throw new Error(String(error) + "\n" + (existsSync(log) ? readFileSync(log, "utf8") : "")); }
			observed.loaded = manifest.files.filter(file => existsSync(file.copy)).map(file => basename(file.source));
		};
		result = await prepareFileWorkspaceReview(tree ? [root] : ["a.ts", "b.ts"], ctx, runner);
		assert.deepEqual(lifecycle, ["stop", "start"]);
		assert.equal(readFileSync(join(root, "a.ts"), "utf8"), "const a = 1;\n");
		assert.equal(readFileSync(join(root, "b.ts"), "utf8"), "const b = 2;\n");
		await check({ result, report, observed });
	} finally { result?.cleanup(); rmSync(root, { recursive: true, force: true }); }
}

test("real Vim opens explicit files in separate tabs with @@ shortcuts and per-file snapshots", { skip: !installed, timeout: 15000 }, async () => {
	await runWorkspace({ tree: false, commands: [
		"call writefile([string(tabpagenr('$'))], g:report_file)",
		"tabfirst",
		'call feedkeys(",aFirst comment\\<Esc>:w\\<CR>", \'xt\')',
		"tabnext",
		'call feedkeys(",aSecond comment\\<Esc>:wqa\\<CR>", \'xt\')',
	], check: ({ result, report }) => {
		assert.equal(readFileSync(report, "utf8").trim(), "2");
		assert.ok(result); assert.equal(result.large, false);
		assert.match(result.prompt, /<files subject="these files">/);
		assert.match(result.prompt, /@@ First comment/); assert.match(result.prompt, /@@ Second comment/);
	} });
});

test("real Vim directory tree is read-only and lazy-opens only selected copies", { skip: !installed, timeout: 15000 }, async () => {
	await runWorkspace({ tree: true, commands: [
		"call writefile([json_encode({'modifiable': &l:modifiable, 'readonly': &l:readonly, 'type': &l:buftype})], g:report_file)",
		"call search('a.ts$', 'W')",
		'call feedkeys("\\<CR>,aFirst comment\\<Esc>:w\\<CR>", \'xt\')',
		"ReTree",
		"call search('b.ts$', 'W')",
		'call feedkeys("\\<CR>,aSecond comment\\<Esc>:wqa\\<CR>", \'xt\')',
	], check: ({ result, report, observed }) => {
		assert.deepEqual(JSON.parse(readFileSync(report, "utf8")), { modifiable: 0, readonly: 1, type: "nofile" });
		assert.deepEqual(observed.loaded.sort(), ["a.ts", "b.ts"]);
		assert.ok(result); assert.match(result.prompt, /First comment/); assert.match(result.prompt, /Second comment/);
		assert.doesNotMatch(result.prompt, /unused.ts|reply-to-ai files/);
	} });
});

test("real Vim tree expands nested directories before opening a selected file", { skip: !installed, timeout: 15000 }, async () => {
	await runWorkspace({ tree: true, commands: [
		"call search('nested/$', 'W')",
		'call feedkeys("\\<CR>", \'xt\')',
		"call search('unused.ts$', 'W')",
		'call feedkeys("\\<CR>,aNested comment\\<Esc>:wqa\\<CR>", \'xt\')',
	], check: ({ result, observed }) => {
		assert.deepEqual(observed.loaded, ["unused.ts"]);
		assert.ok(result); assert.match(result.prompt, /@@ Nested comment/);
		assert.match(result.prompt, /unused.ts/);
	} });
});

test("real Vim submits only saved markers and drops later unsaved edits across files", { skip: !installed, timeout: 15000 }, async () => {
	await runWorkspace({ tree: false, commands: [
		"tabfirst",
		'call feedkeys(",aSaved comment\\<Esc>:w\\<CR>,aUnsaved tail\\<Esc>", \'xt\')',
		"tabnext",
		'call feedkeys(",aNever saved\\<Esc>:q\\<CR>", \'xt\')',
	], check: ({ result }) => {
		assert.ok(result); assert.match(result.prompt, /@@ Saved comment/);
		assert.doesNotMatch(result.prompt, /Unsaved tail|Never saved/);
	} });
});
