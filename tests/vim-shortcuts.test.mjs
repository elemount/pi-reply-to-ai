import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { newComments, reviewDocument, reviewVimScript } from "../core.ts";

const installed = spawnSync("vim", ["--version"], { encoding: "utf8" }).status === 0;

function withVim(filetype, commands, check, { extension, syntax = false } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-keys-"));
	const file = join(directory, `editing.${extension ?? (filetype === "diff" ? "diff" : filetype === "auto" ? "py" : "md")}`);
	const saved = join(directory, "saved.txt");
	const report = join(directory, "report.json");
	try {
		writeFileSync(file, reviewDocument("Original response."));
		writeFileSync(join(directory, "review.vim"), reviewVimScript(saved, filetype));
		writeFileSync(join(directory, "driver.vim"), [
			`let g:report_file = ${JSON.stringify(report)}`,
			"call cursor(1, 1)",
			...commands,
			"cquit 70", // A tested quit sequence must exit before reaching this line.
		].join("\n"));
		const result = spawnSync("vim", ["-u", "NONE", "-i", "NONE", "-n", "-es",
			...(syntax ? ["--cmd", "filetype on | syntax on"] : []),
			"-S", join(directory, "review.vim"), "-S", join(directory, "driver.vim"), "--", file,
		], { encoding: "utf8", timeout: 10000 });
		assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
		check({ file, saved, report });
	} finally { rmSync(directory, { recursive: true, force: true }); }
}

for (const filetype of ["markdown", "diff", "auto"]) {
	test(`vim ${filetype}: Normal-mode Enter starts a new #REPLY: comment below`, { skip: !installed }, () => {
		withVim(filetype, ['call feedkeys("\\<CR>Below comment\\<Esc>:wq\\<CR>", \'xt\')'], ({ saved }) => {
			const content = readFileSync(saved, "utf8");
			assert.match(content, /^Original response\.\n#REPLY: Below comment\n/);
			assert.deepEqual(newComments("Original response.", content), [{ line: 2, text: "Below comment" }]);
		});
	});

	test(`vim ${filetype}: ,a appends an inline #REPLY: comment`, { skip: !installed }, () => {
		withVim(filetype, ['call feedkeys(",aInline comment\\<Esc>:wq\\<CR>", \'xt\')'], ({ saved }) => {
			assert.match(readFileSync(saved, "utf8"), /^Original response\. #REPLY: Inline comment\n/);
		});
	});
}

test("vim still highlights #REPLY: in chat reviews, not @@, ??, or bare REPLY:", { skip: !installed }, () => {
	withVim("markdown", [
		"call setline(1, ['@@ -1 +1 @@', 'const value = input ?? fallback;', 'REPLY: ordinary text', '#REPLY: Current comment', 'context #REPLY: Inline comment'])",
		"let groups = []",
		"for [lnum, column] in [[1, 1], [2, 21], [3, 1], [4, 1], [5, 9]]",
		"  call add(groups, synIDattr(synID(lnum, column, 1), 'name'))",
		"endfor",
		"call writefile([json_encode(groups)], g:report_file)",
		"qall!",
	], ({ report }) => {
		const groups = JSON.parse(readFileSync(report, "utf8"));
		assert.ok(groups.slice(0, 3).every(group => group !== "PiReviewComment"));
		assert.deepEqual(groups.slice(3), ["PiReviewComment", "PiReviewComment"]);
	});
});

for (const [filetype, extension] of [["diff", "diff"], ["auto", "diff"], ["auto", "patch"]]) {
	test(`vim ${filetype} .${extension}: no diff or annotation colors even when syntax is enabled`, { skip: !installed }, () => {
		withVim(filetype, [
			"call setline(1, ['diff --git a/file b/file', '@@ -1 +1 @@', '-old', '+new', '#REPLY: Comment', 'context #REPLY: Inline'])",
			"let result = {'filetype': &l:filetype, 'syntax': &l:syntax, 'enabled': exists('g:syntax_on'), 'colors': []}",
			"for lnum in range(1, line('$'))",
			"  for column in range(1, strlen(getline(lnum)))",
			"    let name = synIDattr(synID(lnum, column, 1), 'name')",
			"    if !empty(name) | call add(result.colors, name) | endif",
			"  endfor",
			"endfor",
			"enew!",
			"setfiletype python",
			"call setline(1, 'def example():')",
			"let result.other_syntax = &l:syntax",
			"let result.other_color = synIDattr(synID(1, 1, 1), 'name')",
			"call writefile([json_encode(result)], g:report_file)",
			"qall!",
		], ({ report }) => {
			const result = JSON.parse(readFileSync(report, "utf8"));
			assert.equal(result.filetype, "diff"); assert.equal(result.syntax, "OFF");
			assert.equal(result.enabled, 1); assert.deepEqual(result.colors, []);
			assert.equal(result.other_syntax, "python"); assert.ok(result.other_color);
		}, { extension, syntax: true });
	});
}

test("vim file copies detect their filetype from the preserved extension", { skip: !installed }, () => {
	withVim("auto", ["call writefile([&l:filetype], g:report_file)", "qall!"], ({ report }) => {
		assert.equal(readFileSync(report, "utf8").trim(), "python");
	});
});

test("vim comment shortcuts do not save automatically", { skip: !installed }, () => {
	withVim("markdown", ['call feedkeys("\\<CR>Unsaved comment\\<Esc>:q\\<CR>", \'xt\')'], ({ file, saved }) => {
		assert.equal(existsSync(saved), false);
		assert.equal(readFileSync(file, "utf8"), reviewDocument("Original response."));
	});
});

test("vim shortcuts are normal-mode and buffer-local; other buffers and Insert-mode Enter stay unchanged", { skip: !installed }, () => {
	withVim("markdown", [
		'let result = {"enter": maparg("\\<CR>", "n", 0, 1), "inline": maparg(",a", "n", 0, 1), "insert": maparg("\\<CR>", "i", 0, 1)}',
		"enew!",
		'let result.other_enter = maparg("\\<CR>", "n", 0, 1)',
		'let result.other_inline = maparg(",a", "n", 0, 1)',
		"call writefile([json_encode(result)], g:report_file)",
		"qall!",
	], ({ report }) => {
		const bindings = JSON.parse(readFileSync(report, "utf8"));
		assert.equal(bindings.enter.buffer, 1);
		assert.equal(bindings.inline.buffer, 1);
		assert.equal(bindings.enter.rhs, "o#REPLY:<Space>");
		assert.equal(bindings.inline.rhs, "A<Space>#REPLY:<Space>");
		assert.deepEqual(bindings.insert, {});
		assert.deepEqual(bindings.other_enter, {});
		assert.deepEqual(bindings.other_inline, {});
	});
});
