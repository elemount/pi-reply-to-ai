import assert from "node:assert/strict";
import test from "node:test";
import { assistantText, reviewMarkdown, validateComments } from "../core.ts";

const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });
test("reply selection ignores tools, user text, thinking-only and empty assistant messages", () => {
	const messages = [assistant("old"), { role: "toolResult", content: [{ type: "text", text: "tool" }] },
		{ role: "user", content: "user" }, assistant("new"), { role: "assistant", content: [{ type: "thinking", thinking: "secret" }] },
		{ role: "assistant", content: [] }, { role: "assistant", content: [{ type: "text", text: 42 }] }];
	assert.equal(assistantText(messages), "new"); assert.equal(assistantText(messages, 1), "old");
	for (const offset of [2, -1, Infinity, 0.5]) assert.equal(assistantText(messages, offset), undefined);
});
test("source marker text is quoted verbatim and never becomes comment data", () => {
	const original = "@@ hunk\n?? operator\n#REPLY: historical\nREPLY: ordinary";
	const source = { id: 0, reply: 0, label: "reply", content: original };
	assert.deepEqual(validateComments([], [source]), []);
	const result = reviewMarkdown({ title: "Replies", sources: [source] }, []);
	assert.ok(!result.includes(original)); assert.doesNotMatch(result, /@ai:/);
	assert.equal(result.split("## Comments")[1].trim(), "");
	const context = original.split("\n").map((line, index) => `${index + 1}: ${line}`).join("\n");
	const markdown = reviewMarkdown({ title: "Replies", sources: [source] }, [
		{ source: 0, line: 3, endLine: 3, context, text: "My current request" },
	]);
	assert.ok(markdown.includes(context));
	assert.match(markdown, /#REPLY:\n```\nMy current request/);
});
