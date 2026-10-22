import assert from "node:assert/strict";
import test from "node:test";
import { chatHistoryForReview, newComments, replyRangeDocument, reviewPrompt, reviewFilePrompt } from "../core.ts";

test("all existing chat markers become @ai:, including inline text, examples, and repeated markers", () => {
	const original = "inline@@old\n@@first@@second\n```diff\n@@ -1 +1 @@\n```\n@ai: already historical\n\u4e2d\u6587";
	const expected = "inline@ai:old\n@ai:first@ai:second\n```diff\n@ai: -1 +1 @ai:\n```\n@ai: already historical\n\u4e2d\u6587";
	assert.equal(chatHistoryForReview(original), expected);
	assert.equal(chatHistoryForReview(expected), expected);
	assert.doesNotMatch(expected, /@@/);
	assert.ok(original.includes("inline@@old"));
});

test("history conversion preserves numbered sections, XML, and CDATA escaping", () => {
	const collection = replyRangeDocument([{ index: 1, text: 'old @@ comment ]]> </reply>' }, { index: 0, text: 'newer @@ old comment' }]);
	const snapshot = chatHistoryForReview(collection);
	assert.ok(snapshot.startsWith('<reply index="1">'));
	assert.ok(snapshot.includes('<reply index="0">'));
	assert.ok(snapshot.includes(']]]]><![CDATA[>'));
	assert.match(snapshot, /old @ai: comment/);
	assert.match(snapshot, /newer @ai: old comment/);
	assert.doesNotMatch(snapshot, /@@/);
});

test("past @ai: comments are ignored; a current @@ comment can repeat the same words", () => {
	const snapshot = chatHistoryForReview("@@ Add an example\n@ai: Earlier context");
	assert.deepEqual(newComments(snapshot, snapshot + "\n@ai: another past comment\n"), []);
	assert.deepEqual(newComments(snapshot, snapshot + "\n@@ Add an example\n"), [{ line: 3, text: "Add an example" }]);
});

test("chat prompts explain historical/current markers without converting newly written comments", () => {
	const annotated = "@ai: Historical comment\n@@ Current comment";
	for (const tag of ["reply", "replies"]) {
		const inline = reviewPrompt(annotated, "chat review", tag);
		const file = reviewFilePrompt("/tmp/review.md", "/tmp/comments.json", "chat review", tag);
		for (const prompt of [inline, file]) {
			assert.match(prompt, /@ai: marks past comments for context only/);
			assert.match(prompt, /@@ marks current comments/);
			assert.match(prompt, /Do not treat comments in earlier chat messages as new requests/);
		}
		assert.ok(inline.includes(annotated));
		assert.match(file, /-F .*@@/);
	}
});

test("file and patch prompts do not reinterpret their original markers as chat history", () => {
	for (const tag of ["file", "patch"]) {
		const inline = reviewPrompt("original @@ marker\n@@ new comment", "source", tag);
		const file = reviewFilePrompt("/tmp/source", "/tmp/comments.json", "source", tag);
		assert.match(inline, /original @@ marker/);
		for (const prompt of [inline, file]) assert.doesNotMatch(prompt, /@ai: marks past comments/);
	}
});
