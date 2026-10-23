import assert from "node:assert/strict";
import test from "node:test";
import { assistantText, assistantTextRange, newComments, replyRangeDocument, reviewDocument, reviewFilePrompt, reviewPrompt } from "../core.ts";
import { parseReviewTarget, REVIEW_USAGE } from "../git.ts";

const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });

test("inclusive range parsing preserves single-message, file, and Git targets", () => {
	for (const [input, start, end] of [["0-10", 0, 10], ["3-7", 3, 7], ["message 0-9", 0, 9], ["0-0", 0, 0], ["01-02", 1, 2]]) {
		assert.deepEqual(parseReviewTarget(input), { kind: "range", start, end });
	}
	assert.deepEqual(parseReviewTarget("0"), { kind: "message", offset: 0 });
	assert.deepEqual(parseReviewTarget("@0-10"), { kind: "file", path: "0-10" });
	assert.deepEqual(parseReviewTarget("c 0-10"), { kind: "commit", revision: "0-10" });
	for (const input of ["10-0", "0--1", "-1-2", "0-1-2", "1.5-2", "0-1e2", "0-9007199254740992", "9007199254740992-9007199254740992", "0-1 extra", "message 3-1", "0 - 10"]) {
		assert.throws(() => parseReviewTarget(input), error => error.message === REVIEW_USAGE);
	}
});

test("ranges count AI text replies only and return the selected interval oldest first", () => {
	const messages = [assistant("four"), { role: "user", content: "user" }, assistant("three"),
		{ role: "toolResult", content: [{ type: "text", text: "tool" }] }, assistant("two"),
		{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] }, assistant("one"), assistant("zero"),
		{ role: "assistant", stopReason: "aborted", content: [] }];
	const original = structuredClone(messages);
	assert.deepEqual(assistantTextRange(messages, 1, 3), [
		{ index: 3, text: "three" }, { index: 2, text: "two" }, { index: 1, text: "one" },
	]);
	assert.deepEqual(assistantTextRange(messages, 0, 0), [{ index: 0, text: assistantText(messages) }]);
	assert.equal(assistantTextRange(messages, 0, 4).length, 5);
	assert.deepEqual(messages, original);
});

test("0-10 selects eleven replies rather than ten", () => {
	const messages = Array.from({ length: 11 }, (_, index) => assistant(`text ${index}`));
	const replies = assistantTextRange(messages, 0, 10);
	assert.equal(replies.length, 11);
	assert.deepEqual(replies[0], { index: 10, text: "text 0" });
	assert.deepEqual(replies.at(-1), { index: 0, text: "text 10" });
	assert.equal(assistantTextRange(messages, 0, 9).length, 10);
});

test("unavailable ranges report the actual available interval without partial results or huge allocations", () => {
	const messages = [assistant("oldest"), assistant("middle"), assistant("latest")];
	for (const [start, end] of [[0, 3], [3, 7], [0, Number.MAX_SAFE_INTEGER]]) {
		assert.throws(() => assistantTextRange(messages, start, end), /Available AI reply indexes: 0-2/);
	}
	assert.throws(() => assistantTextRange([], 0, 1), /No AI text replies are available/);
	for (const [start, end] of [[-1, 2], [2, 1], [0.5, 2], [0, Infinity]]) {
		assert.throws(() => assistantTextRange(messages, start, end), /Invalid AI reply range/);
	}
});

test("collection sections preserve indexes, XML/code/CDATA text and one trailing blank line", () => {
	const text = 'Code </reply> & <tag> ]]> #REPLY: existing \u4e2d\u6587';
	const collection = replyRangeDocument([{ index: 1, text }, { index: 0, text: "latest" }]);
	assert.ok(collection.startsWith('<reply index="1"><![CDATA[\n'));
	assert.ok(collection.endsWith('\nlatest\n]]></reply>'));
	assert.ok(collection.includes(']]]]><![CDATA[>'));
	const content = [...collection.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map(match => match[1]).join("");
	assert.equal(content, "\n" + text + "\n\nlatest\n");
	assert.deepEqual(newComments(collection, reviewDocument(collection)), []);
	assert.equal(newComments(collection, collection + "\n#REPLY: New comment\n").length, 1);
	assert.ok(reviewDocument(collection).endsWith("</reply>\n\n"));
});

test("inline and file collection prompts identify numbered replies and chronological ordering", () => {
	for (const prompt of [reviewPrompt("collection", "AI responses 0-10", "replies"),
		reviewFilePrompt("/tmp/review.md", "/tmp/comments.json", "AI responses 0-10", "replies")]) {
		assert.ok(prompt.includes('<replies subject="AI responses 0-10">'));
		assert.match(prompt, /numbered <reply> blocks, ordered oldest to newest/);
		assert.ok(prompt.endsWith("</replies>"));
	}
});
