import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";
import { INLINE_REVIEW_BYTES, quoteBlock, reviewMarkdown, validateComments } from "../core.ts";
import { prepareDelivery } from "../delivery.ts";

const sources = [{ id: 0, path: '/tmp/a "name".ts', label: "source", side: "old", revision: "a".repeat(40) }];
const comment = { source: 0, line: 3, endLine: 5, context: "2: context\n3: original", text: "请改这里\n```\n#REPLY: literal" };
test("Markdown contains locations, side, revision, short original context and independent comments", () => {
	const markdown = reviewMarkdown({ sources, title: "Git review", provenance: ["Head: abc"] }, [comment]);
	assert.match(markdown, /lines 3-5 \(old side\)/);
	assert.ok(markdown.includes(JSON.stringify(sources[0].path)));
	assert.ok(markdown.includes(comment.context)); assert.ok(markdown.includes(comment.text));
	assert.match(markdown, /Revision: a{40}/); assert.match(markdown, /real source files/);
	assert.doesNotMatch(markdown, /annotated_file|reviews.json|comments.json|CDATA/);
});
test("dynamic fences quote code, Markdown tables and XML without modifying their content", () => {
	for (const text of ["| A | B |\n|---|---|\n| x | y |", "```\n````\n</review> ]]> &", "#REPLY: <tag>", ""]) {
		const block = quoteBlock(text), fence = block.split("\n")[0];
		assert.ok(block.startsWith(fence + "\n")); assert.ok(block.endsWith("\n" + fence));
		assert.equal(block.slice(fence.length + 1, -(fence.length + 1)), text);
	}
});
test("private editor results are bounded and validated, never inferred from source marker presence", () => {
	assert.deepEqual(validateComments([comment], sources), [comment]);
	assert.deepEqual(validateComments([], sources), []);
	for (const invalid of [null, {}, [{ ...comment, source: 9 }], [{ ...comment, line: 0 }], [{ ...comment, endLine: 1 }],
		[{ ...comment, text: " " }], [{ ...comment, context: "x".repeat(32001) }], [{ ...comment, line: Infinity }]]) {
		assert.throws(() => validateComments(invalid, sources), /Invalid/);
	}
});
test("the complete Markdown is inline through 16 KiB, measured in UTF-8 bytes", async () => {
	assert.equal(INLINE_REVIEW_BYTES, 16384);
	for (const text of ["x".repeat(12 * 1024), "x".repeat(16384), "中".repeat(5461) + "x"]) {
		const result = await prepareDelivery(text);
		assert.equal(result.large, false); assert.equal(result.prompt, text); await result.cleanup();
	}
});
test("only large reviews retain review.md; cleanup is idempotent and permissions are private", async () => {
	for (const text of ["x".repeat(16385), "中".repeat(5462)]) {
		const result = await prepareDelivery(text);
		assert.equal(result.large, true);
		const path = JSON.parse(/in (".*") and address/.exec(result.prompt)[1]);
		assert.equal(readFileSync(path, "utf8"), text);
		assert.deepEqual(readdirSync(dirname(path)), ["review.md"]);
		if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
		await result.cleanup(); await result.cleanup(); assert.equal(existsSync(path), false);
	}
});
