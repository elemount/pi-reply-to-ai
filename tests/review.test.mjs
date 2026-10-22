import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import extension from "../index.ts";
import { INLINE_REVIEW_BYTES, assistantText, newComments, reviewDocument, reviewFilePrompt, reviewPrompt, reviewVimScript } from "../core.ts";
import { findReviewEditor } from "../editor.ts";
import { withRepository } from "./fixtures/repository.mjs";

const fixture = fileURLToPath(new URL("./fixtures/editor.mjs", import.meta.url));
const assistant = (text, extra = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });

function harness(messages = [assistant("Original response.")]) {
	const commands = new Map();
	const shortcuts = new Map();
	const sent = [], notices = [], lifecycle = [], drafts = [];
	const pi = {
		registerCommand: (name, command) => commands.set(name, command),
		registerShortcut: (key, shortcut) => shortcuts.set(key, shortcut),
		sendUserMessage: (...args) => sent.push(args),
	};
	const ctx = {
		cwd: process.cwd(), mode: "tui", isIdle: () => true, hasPendingMessages: () => false,
		sessionManager: {
			buildSessionContext: () => ({ messages }),
			getSessionId: () => "session-1", getLeafId: () => "leaf-1",
		},
		ui: {
			notify: (...args) => notices.push(args), pasteToEditor: (text) => drafts.push(text),
			custom: async (factory) => {
				let done = false, result;
				await factory({
					stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start"),
					requestRender: (full) => lifecycle.push(["render", full]),
				}, {}, {}, (value) => { done = true; result = value; });
				assert.equal(done, true);
				return result;
			},
		},
	};
	extension(pi);
	return { ctx, sent, notices, lifecycle, drafts, commands, shortcuts,
		command: (args = "") => commands.get("re").handler(args, ctx),
		shortcut: () => shortcuts.get("ctrl+alt+r").handler(ctx),
	};
}

async function fakeEditor(mode, fn) {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-test-"));
	const names = ["PI_REVIEW_EDITOR", "REVIEW_TEST_MODE", "REVIEW_TEST_LOG"];
	const previous = names.map((name) => process.env[name]);
	process.env.PI_REVIEW_EDITOR = fixture;
	process.env.REVIEW_TEST_MODE = mode;
	process.env.REVIEW_TEST_LOG = join(directory, "invocation.json");
	try {
		await fn(() => JSON.parse(readFileSync(process.env.REVIEW_TEST_LOG, "utf8")));
	} finally {
		names.forEach((name, index) => {
			if (previous[index] === undefined) delete process.env[name];
			else process.env[name] = previous[index];
		});
		rmSync(directory, { recursive: true, force: true });
	}
}

test("AI reply indexes count only text replies, newest first, ignoring user/tool/thinking messages", () => {
	const messages = [
		assistant("oldest"),
		{ role: "user", content: "question" },
		assistant("middle"),
		{ role: "assistant", content: [{ type: "thinking", thinking: "secret" }, { type: "text", text: " A" }, { type: "toolCall", name: "read" }, { type: "text", text: "B " }] },
		{ role: "toolResult", content: [{ type: "text", text: "tool output" }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
		{ role: "assistant", stopReason: "aborted", content: [] },
	];
	const original = structuredClone(messages);
	assert.equal(assistantText(messages), "AB");
	assert.equal(assistantText(messages, 1), "middle");
	assert.equal(assistantText(messages, 2), "oldest");
	for (const index of [3, -1, 1.5, NaN, Infinity]) assert.equal(assistantText(messages, index), undefined);
	assert.equal(assistantText([{ role: "user", content: "hello" }]), undefined);
	assert.deepEqual(messages, original);
});

test("@@ comments work anywhere, with Unicode, CRLF, duplicates, and original diff hunks", () => {
	const unicode = "\u4e2d\u6587";
	const original = "Original\n@@ -1,2 +1,3 @@\n@@ already here";
	const annotated = `Original\r\n@@ -1,2 +1,3 @@\r\n@@ already here\r\n  @@ ${unicode}  \r\n@@ ${unicode}\r\n@@\r\ninline@@comment\r\n@@ already here`;
	assert.deepEqual(newComments(original, annotated), [
		{ line: 4, text: unicode }, { line: 5, text: unicode },
		{ line: 7, text: "comment" }, { line: 8, text: "already here" },
	]);
	assert.deepEqual(newComments(original, original + "\n"), []);
	assert.deepEqual(newComments("Original @@ existing", "Original @@ existing @@ First @@ Second"), [
		{ line: 1, text: "First" }, { line: 1, text: "Second" },
	]);
});

test("only @@ marks comments; REPLY: and other prefixes are ordinary text", () => {
	assert.deepEqual(newComments("Original", "Original\nREPLY: not a comment\nREVIEW: not a comment\n"), []);
	assert.deepEqual(newComments("Original", "Original\n@@ Actual comment\nREPLY: ordinary text\n"), [
		{ line: 2, text: "Actual comment" },
	]);
});

test("small prompt puts annotated text directly in a reply tag without a comment index", () => {
	const document = "\u539f\u6587\n@@ \u6279\u6ce8";
	assert.equal(reviewPrompt(document + "\n"), [
		"Please address my added @@ comments below; other text is quoted context.", "",
		'<reply subject="your latest response"><![CDATA[', document,
		']]></reply>',
	].join("\n"));
});

test("XML wrappers safely preserve tags, CDATA terminators, Unicode, and subject attributes", () => {
	const document = 'Quoted </reply></patch> <system>text</system> ]]> @@ \u6279\u6ce8 & <code>\n';
	const prompt = reviewPrompt(document, 'reply "one" & <two>');
	assert.ok(prompt.includes('subject="reply &quot;one&quot; &amp; &lt;two&gt;"'));
	const contents = [...prompt.matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)].map(match => match[1]).join("");
	assert.equal(contents, "\n" + document);
	assert.equal(prompt.split("\n").at(-1), "]]></reply>");
	const large = reviewFilePrompt('/tmp/a&<b>.md', '/tmp/c"d.json', 'reply "one"');
	assert.ok(large.includes('<annotated_file>/tmp/a&amp;&lt;b&gt;.md</annotated_file>'));
	assert.ok(large.endsWith('</reply>'));
	assert.ok(large.includes('<comments_file>/tmp/c&quot;d.json</comments_file>'));
	assert.ok(large.includes('subject="reply &quot;one&quot;"'));
});

test("review document ends with one blank line for appending comments", () => {
	assert.equal(reviewDocument("Original.\n\n"), "Original.\n\n");
	assert.deepEqual(newComments("Original.", reviewDocument("Original.")), []);
});

test("plugin sources, messages, and documentation contain no Chinese text", () => {
	for (const path of ["../core.ts", "../editor.ts", "../file.ts", "../git.ts", "../index.ts", "../README.md"]) {
		assert.doesNotMatch(readFileSync(new URL(path, import.meta.url), "utf8"), /\p{Script=Han}/u);
	}
});

test("guards: no messages, busy, queued, non-TUI, help; no editor launched", async () => {
	for (const configure of [
		(h) => { h.ctx.sessionManager.buildSessionContext = () => ({ messages: [] }); },
		(h) => { h.ctx.isIdle = () => false; },
		(h) => { h.ctx.hasPendingMessages = () => true; },
		(h) => { h.ctx.mode = "rpc"; },
	]) {
		const h = harness(); configure(h); await h.command();
		assert.equal(h.sent.length, 0); assert.equal(h.lifecycle.length, 0); assert.equal(h.notices.length, 1);
	}
	const h = harness(); await h.command("help");
	assert.equal(h.lifecycle.length, 0); assert.match(h.notices[0][0], /Usage: \/re \[/);
	assert.deepEqual([...h.commands.keys()], ["re"]);
});

test("saved review sends one user message, restores TUI, and cleans small inline documents", async () => {
	await fakeEditor("submit", async (invocation) => {
		const h = harness(); await h.command();
		assert.equal(h.sent.length, 1);
		assert.match(h.sent[0][0], /Add an example/);
		assert.match(h.sent[0][0], /Original response/);
		assert.deepEqual(h.sent[0][1], { deliverAs: "followUp" });
		assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true]]);
		assert.equal(h.notices.length, 0);
		const launched = invocation();
		assert.equal(launched.initialContent, "Original response.\n\n");
		assert.equal(existsSync(dirname(launched.file)), false);
		assert.ok(launched.args.includes("autocmd BufReadPre * setlocal nomodeline"));
	});
});

test("Ctrl+Alt+R reviews the latest reply through the same flow as /re", async () => {
	await fakeEditor("submit", async (invocation) => {
		const messages = [assistant("older"), assistant("latest")];
		const command = harness(messages); const shortcut = harness(messages);
		assert.deepEqual([...shortcut.shortcuts.keys()], ["ctrl+alt+r"]);
		assert.match(shortcut.shortcuts.get("ctrl+alt+r").description, /latest AI reply/);
		await command.command(); await shortcut.shortcut();
		assert.equal(invocation().initialContent, "latest\n\n");
		assert.deepEqual(shortcut.sent, command.sent);
		assert.deepEqual(shortcut.lifecycle, command.lifecycle);
		assert.equal(shortcut.sent.length, 1);
	});
});

test("shortcut respects TUI, busy, queued-message, and missing-reply guards", async () => {
	for (const configure of [
		(h) => { h.ctx.mode = "rpc"; }, (h) => { h.ctx.isIdle = () => false; },
		(h) => { h.ctx.hasPendingMessages = () => true; },
		(h) => { h.ctx.sessionManager.buildSessionContext = () => ({ messages: [] }); },
	]) {
		const h = harness(); configure(h); await h.shortcut();
		assert.equal(h.sent.length, 0); assert.equal(h.lifecycle.length, 0); assert.equal(h.notices.length, 1);
	}
});

test("shortcut cancellation, unchanged reviews, and editor failures do not send", async () => {
	for (const mode of ["cancel", "unchanged", "crash"]) {
		await fakeEditor(mode, async () => {
			const h = harness(); await h.shortcut();
			assert.equal(h.sent.length, 0);
			assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true]]);
		});
	}
});

test("shortcut and command share a lock against duplicate editor launches", async () => {
	await fakeEditor("submit", async () => {
		const h = harness(); const custom = h.ctx.ui.custom; let release;
		h.ctx.ui.custom = async (...args) => {
			await new Promise(resolve => { release = resolve; });
			return custom(...args);
		};
		const running = h.shortcut();
		try {
			await h.shortcut(); await h.command();
			assert.equal(h.notices.length, 2);
			assert.ok(h.notices.every(([, type]) => type === "warning"));
		} finally { release(); await running; }
		assert.equal(h.sent.length, 1);
		assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true]]);
	});
});

test("never saved and unchanged saved documents never send", async () => {
	for (const mode of ["cancel", "unchanged"]) {
		await fakeEditor(mode, async (invocation) => {
			const h = harness(); await h.command();
			assert.equal(h.sent.length, 0);
			assert.equal(h.notices[0][1], "info");
			assert.equal(existsSync(dirname(invocation().file)), false);
			assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true]]);
		});
	}
});

test("editor crash never sends, even with a saved snapshot, and always restores TUI", async () => {
	await fakeEditor("crash", async (invocation) => {
		const h = harness(); await h.command();
		assert.equal(h.sent.length, 0);
		assert.equal(h.notices[0][1], "error");
		assert.deepEqual(h.lifecycle, ["stop", "start", ["render", true]]);
		assert.equal(existsSync(dirname(invocation().file)), false);
	});
});

test("changed conversation keeps a draft instead of sending to the wrong branch", async () => {
	await fakeEditor("submit", async () => {
		const h = harness(); let reads = 0;
		h.ctx.sessionManager.getLeafId = () => ++reads === 1 ? "leaf-1" : "leaf-2";
		await h.command();
		assert.equal(h.sent.length, 0); assert.equal(h.drafts.length, 1);
		assert.match(h.drafts[0], /Add an example/);
	});
});

test("missing executable is reported without stopping TUI, and lock is released", async () => {
	await fakeEditor("submit", async () => {
		const h = harness(); process.env.PI_REVIEW_EDITOR = "/nonexistent/pi-review-editor";
		assert.throws(() => findReviewEditor(process.cwd()), /Cannot find/);
		await h.command();
		assert.equal(h.notices[0][1], "error"); assert.equal(h.lifecycle.length, 0);
		process.env.PI_REVIEW_EDITOR = fixture;
		await h.command(); assert.equal(h.sent.length, 1);
	});
});

test("default editor is vim only, even when nvim is present", async () => {
	await fakeEditor("submit", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-review-path-"));
		const previousPath = process.env.PATH;
		try {
			delete process.env.PI_REVIEW_EDITOR;
			process.env.PATH = directory;
			symlinkSync(process.execPath, join(directory, "nvim"));
			assert.throws(() => findReviewEditor(process.cwd()), /Cannot find vim/);
			symlinkSync(process.execPath, join(directory, "vim"));
			assert.equal(findReviewEditor(process.cwd()), join(directory, "vim"));
		} finally {
			if (previousPath === undefined) delete process.env.PATH;
			else process.env.PATH = previousPath;
			rmSync(directory, { recursive: true, force: true });
		}
	});
});

test("any save followed by quit sends the last saved version, not later unsaved edits", async () => {
	for (const mode of ["save-quit", "unsaved-after-save"]) {
		await fakeEditor(mode, async (invocation) => {
			const h = harness(); await h.command();
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0][0], /Add an example/);
			assert.doesNotMatch(h.sent[0][0], /Unsaved comment/);
			assert.equal(existsSync(dirname(invocation().saved)), false);
		});
	}
});

test("large UTF-8 documents and huge comments stay on disk with bounded prompts", async () => {
	for (const [mode, original] of [["submit", "\u539f".repeat(3000)], ["huge-comment", "Original"]]) {
		await fakeEditor(mode, async (invocation) => {
			const h = harness([assistant(original)]); await h.command();
			const { file, saved } = invocation();
			const directory = dirname(saved);
			try {
				assert.equal(h.sent.length, 1);
				const prompt = h.sent[0][0];
				assert.ok(Buffer.byteLength(prompt) < INLINE_REVIEW_BYTES);
				assert.match(prompt, /rg -n -F/);
				assert.ok(prompt.includes(saved));
				assert.doesNotMatch(prompt, /Add an example|x{100}|\p{Script=Han}/u);
				assert.ok(prompt.includes("<comments_file>"));
				assert.ok(Buffer.byteLength(readFileSync(saved)) > INLINE_REVIEW_BYTES);
				const commentsPath = join(directory, "comments.json");
				const comments = JSON.parse(readFileSync(commentsPath, "utf8"));
				assert.equal(comments.length, mode === "submit" ? 2 : 1);
				assert.ok(comments.every(c => c.line > 0 && c.text.length));
				assert.equal(existsSync(file), false);
				assert.equal(existsSync(join(directory, "review.vim")), false);
				assert.equal(statSync(directory).mode & 0o777, 0o700);
				assert.equal(statSync(saved).mode & 0o777, 0o600);
				assert.equal(statSync(commentsPath).mode & 0o777, 0o600);
			} finally { rmSync(directory, { recursive: true, force: true }); }
		});
	}
});

test("8 KiB boundary includes exact-size documents inline and retains larger ones", async () => {
	assert.equal(INLINE_REVIEW_BYTES, 8 * 1024);
	const suffix = "\n\n\nInline context @@ Add an example\n@@ Explain edge cases\n";
	for (const bytes of [INLINE_REVIEW_BYTES, INLINE_REVIEW_BYTES + 1]) {
		await fakeEditor("submit", async (invocation) => {
			const original = "x".repeat(bytes - Buffer.byteLength(suffix));
			const h = harness([assistant(original)]); await h.command();
			const { saved } = invocation();
			try {
				assert.equal(h.sent.length, 1);
				if (bytes === INLINE_REVIEW_BYTES) {
					assert.match(h.sent[0][0], /Add an example/);
					assert.doesNotMatch(h.sent[0][0], /<comments_file>|comments\.json/);
					assert.equal(existsSync(saved), false);
				} else {
					assert.doesNotMatch(h.sent[0][0], /Add an example/);
					assert.equal(statSync(saved).size, bytes);
				}
			} finally { rmSync(dirname(saved), { recursive: true, force: true }); }
		});
	}
});

test("large unchanged saved document is cleaned without sending", async () => {
	await fakeEditor("unchanged", async (invocation) => {
		const h = harness([assistant("x".repeat(INLINE_REVIEW_BYTES + 1))]); await h.command();
		assert.equal(h.sent.length, 0);
		assert.equal(existsSync(dirname(invocation().saved)), false);
	});
});

test("large review on a changed branch retains file references in the draft", async () => {
	await fakeEditor("submit", async (invocation) => {
		const h = harness([assistant("x".repeat(INLINE_REVIEW_BYTES))]); let reads = 0;
		h.ctx.sessionManager.getLeafId = () => ++reads === 1 ? "leaf-1" : "leaf-2";
		await h.command();
		const { saved } = invocation();
		try {
			assert.equal(h.sent.length, 0); assert.equal(h.drafts.length, 1);
			assert.ok(h.drafts[0].includes(saved)); assert.equal(existsSync(saved), true);
		} finally { rmSync(dirname(saved), { recursive: true, force: true }); }
	});
});

test("grep command safely quotes paths containing spaces and single quotes", () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-quote-"));
	try {
		const file = join(directory, "review 'quoted' .md");
		writeFileSync(file, "Original @@ Comment\n");
		const prompt = reviewFilePrompt(file, join(directory, "comments.json"));
		const command = /<search_command><!\[CDATA\[([\s\S]*?)\]\]><\/search_command>/.exec(prompt)[1].replace(/^rg /, "grep ");
		const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8" });
		assert.equal(result.status, 0); assert.match(result.stdout, /1:Original @@ Comment/);
		assert.equal(prompt.split("\n").length, 7);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("command help, invalid arguments and target completions do not open an editor", async () => {
	const h = harness();
	for (const args of ["help", "--help", "bad-target", "commit one two", "diff HEAD"]) await h.command(args);
	assert.equal(h.lifecycle.length, 0); assert.equal(h.sent.length, 0);
	assert.ok(h.notices.every(([text]) => text.startsWith("Usage: /re [")));
	const completions = h.commands.get("re").getArgumentCompletions;
	assert.deepEqual(completions("c"), [{ value: "commit", label: "commit" }, { value: "c", label: "c" }]);
	assert.deepEqual(completions("1"), [{ value: "1", label: "1" }]);
	assert.equal(completions("commit HEAD"), null);
});

test("@file reviews open private copies outside Git, identify the source, and leave originals untouched", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-source-"));
	try {
		for (const [name, content, extension] of [["source & name.ts", "export const answer = 42;\n", "ts"],
			["empty.txt", "", "txt"], ["no-extension", "Text\n", "txt"]]) {
			const source = join(directory, name); writeFileSync(source, content); chmodSync(source, 0o444);
			await fakeEditor("submit", async (invocation) => {
				const h = harness([]); h.ctx.cwd = directory; await h.command(`@"${name}"`);
				assert.equal(h.sent.length, 1);
				const prompt = h.sent[0][0];
				assert.ok(prompt.includes('<file subject="this file" source="'));
				assert.ok(prompt.includes(realpathSync(source).replaceAll("&", "&amp;")));
				assert.match(prompt, /edit that original file, not the review snapshot/);
				assert.ok(invocation().file.endsWith(`editing.${extension}`));
				assert.equal(invocation().initialContent, reviewDocument(content));
				assert.equal(readFileSync(source, "utf8"), content);
				assert.equal(statSync(source).mode & 0o777, 0o444);
				assert.equal(existsSync(dirname(invocation().saved)), false);
			});
		}
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("large @file reviews preserve private copies and source references, not full inline contents", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-source-"));
	try {
		const source = join(directory, "large.md"); const content = "source line\n".repeat(1000); writeFileSync(source, content);
		await fakeEditor("submit", async (invocation) => {
			const h = harness([]); h.ctx.cwd = directory; await h.command("@large.md");
			const { saved } = invocation();
			try {
				assert.equal(h.sent.length, 1);
				const prompt = h.sent[0][0];
				assert.match(prompt, /<file subject="this file" source=/);
				assert.match(prompt, /<annotated_file>/);
				assert.ok(prompt.includes(saved)); assert.doesNotMatch(prompt, /source line/);
				assert.match(readFileSync(saved, "utf8"), /@@ Add an example/);
				assert.equal(readFileSync(source, "utf8"), content);
			} finally { rmSync(dirname(saved), { recursive: true, force: true }); }
		});
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("file cancellation, unchanged reviews, and editor failure never touch the source or send", async () => {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-source-"));
	try {
		const source = join(directory, "source.txt"); const content = "Text @@ already present\n"; writeFileSync(source, content);
		for (const mode of ["cancel", "unchanged", "crash"]) {
			await fakeEditor(mode, async (invocation) => {
				const h = harness([]); h.ctx.cwd = directory; await h.command("@source.txt");
				assert.equal(h.sent.length, 0);
				assert.equal(readFileSync(source, "utf8"), content);
				assert.equal(existsSync(dirname(invocation().file)), false);
			});
		}
		await fakeEditor("submit", async () => {
			const h = harness(); h.ctx.cwd = directory; await h.command("@missing.txt");
			assert.equal(h.notices.at(-1)[1], "error"); assert.equal(h.lifecycle.length, 0);
			await h.command(); assert.equal(h.sent.length, 1);
		});
	} finally { rmSync(directory, { recursive: true, force: true }); }
});

test("numeric targets select the requested AI reply without counting user/tool messages", async () => {
	const messages = [assistant("oldest"), { role: "user", content: "question" }, assistant("middle"),
		{ role: "toolResult", content: [{ type: "text", text: "tool" }] }, assistant("latest")];
	for (const [args, expected, offset] of [["", "latest", 0], ["0", "latest", 0], ["1", "middle", 1], ["2", "oldest", 2], ["message 1", "middle", 1]]) {
		await fakeEditor("submit", async (invocation) => {
			const h = harness(messages); await h.command(args);
			assert.equal(invocation().initialContent, expected + "\n\n");
			assert.equal(h.sent.length, 1);
			assert.ok(h.sent[0][0].includes(`<reply subject="AI response ${offset} (0 = latest)"><![CDATA[`));
			assert.doesNotMatch(h.sent[0][0], /<document>|<review/);
		});
	}
	for (const args of ["3", "999", "9007199254740991", "-1", "1.5", "9007199254740992"]) {
		const h = harness(messages); await h.command(args);
		assert.equal(h.sent.length, 0); assert.equal(h.lifecycle.length, 0);
		assert.equal(h.notices.length, 1);
	}
});

test("large earlier replies retain the requested reply and XML subject", async () => {
	await fakeEditor("submit", async (invocation) => {
		const h = harness([assistant("older ".repeat(2000)), assistant("latest")]);
		await h.command("1");
		const { saved } = invocation();
		try {
			assert.equal(h.sent.length, 1);
			assert.ok(h.sent[0][0].includes('<reply subject="AI response 1 (0 = latest)">'));
			assert.ok(h.sent[0][0].includes("<annotated_file>"));
			assert.match(readFileSync(saved, "utf8"), /^older /);
			assert.doesNotMatch(readFileSync(saved, "utf8"), /latest/);
		} finally { rmSync(dirname(saved), { recursive: true, force: true }); }
	});
});

test("p and d aliases open PR and working patches", async () => {
	await withRepository(async ({ cwd, git, write, commit }) => {
		write("root.txt", "root\n"); commit();
		git("checkout", "--quiet", "-b", "feature");
		write("feature.txt", "feature\n"); commit();
		write("feature.txt", "dirty\n");
		for (const [args, title] of [["p main", "PR changes"], ["d", "working tree changes"]]) {
			await fakeEditor("submit", async (invocation) => {
				const h = harness([]); h.ctx.cwd = cwd; await h.command(args);
				assert.equal(h.sent.length, 1);
				assert.ok(invocation().initialContent.includes(title));
				assert.match(invocation().file, /editing\.diff$/);
			});
		}
	});
});

test("commit target opens a .diff snapshot even without an AI message and sends patch comments", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("example.txt", "root content\n"); commit();
		await fakeEditor("submit", async (invocation) => {
			const h = harness([]); h.ctx.cwd = cwd;
			await h.command("c");
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0][0], /<patch subject="this Git patch"><!\[CDATA\[/);
			assert.match(h.sent[0][0], /diff --git a\/example.txt/);
			assert.match(h.sent[0][0], /Add an example/);
			assert.match(invocation().file, /editing\.diff$/);
			assert.equal(existsSync(dirname(invocation().saved)), false);
		});
	});
});

test("unchanged patch hunk headers do not trigger a response", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("example.txt", "root content\n"); commit();
		await fakeEditor("unchanged", async () => {
			const h = harness(); h.ctx.cwd = cwd;
			await h.command("commit");
			assert.equal(h.sent.length, 0);
			assert.match(h.notices[0][0], /No new @@ comments/);
		});
	});
});

test("large Git patches retain .diff files and get short source-aware prompts", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("large.txt", "x".repeat(9000) + "\n"); commit();
		await fakeEditor("submit", async (invocation) => {
			const h = harness(); h.ctx.cwd = cwd;
			await h.command("commit");
			const { saved } = invocation();
			try {
				assert.equal(h.sent.length, 1);
				assert.match(h.sent[0][0], /<patch subject="this Git patch">/);
				assert.match(h.sent[0][0], /<annotated_file>/);
				assert.ok(h.sent[0][0].includes(saved));
				assert.match(saved, /review\.diff$/);
				assert.ok(statSync(saved).size > INLINE_REVIEW_BYTES);
				assert.ok(existsSync(join(dirname(saved), "comments.json")));
			} finally { rmSync(dirname(saved), { recursive: true, force: true }); }
		});
	});
});

test("empty and invalid Git targets do not open vim, and release the review lock", async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("example.txt", "root content\n"); commit();
		await fakeEditor("submit", async () => {
			const h = harness(); h.ctx.cwd = cwd;
			await h.command("diff");
			assert.match(h.notices.at(-1)[0], /No Git changes/);
			await h.command("commit nonexistent");
			assert.equal(h.notices.at(-1)[1], "error");
			assert.equal(h.lifecycle.length, 0);
			await h.command("message");
			assert.equal(h.sent.length, 1);
			assert.match(h.sent[0][0], /<reply subject="AI response 0 \(0 = latest\)">/);
		});
	});
});

// Exercise actual successful-write hooks and quit behavior in Vim, not just a mock.
for (const editor of ["vim"]) {
	const installed = spawnSync(editor, ["--version"], { encoding: "utf8" }).status === 0;
	for (const [label, keys, shouldSubmit] of [
		["wq", ":wq\\<CR>", true], ["wq!", ":wq!\\<CR>", true],
		["q with unsaved changes", ":q\\<CR>", false], ["q!", ":q!\\<CR>", false],
		["w then q", ":w\\<CR>:q\\<CR>", true], ["w then q!", ":w\\<CR>:q!\\<CR>", true],
		["w! then q", ":w!\\<CR>:q\\<CR>", true], ["wall then q", ":wall\\<CR>:q\\<CR>", true],
		["execute write then q", ":execute 'write'\\<CR>:q\\<CR>", true],
		["execute wq", ":execute 'wq'\\<CR>", true],
		["write another file", ":execute 'write ' . fnameescape(g:other_file)\\<CR>:q\\<CR>", true],
		["save then add unsaved comment", ":w\\<CR>:call append(line('$'), '@@ unsaved')\\<CR>:q\\<CR>", true],
		["save twice", ":w\\<CR>:call append(line('$'), '@@ second save')\\<CR>:w\\<CR>:q\\<CR>", true],
		["x", ":x\\<CR>", true], ["ZZ", "ZZ", true], ["ZQ", "ZQ", false],
	]) {
		test(`${editor}: ${label}`, { skip: !installed }, () => {
			const directory = mkdtempSync(join(tmpdir(), "pi-review-vim-"));
			// Include quotes, spaces, Unicode and % to catch Vimscript path escaping bugs.
			const file = join(directory, `review '\u5f15\u53f7' %.md`);
			const saved = join(directory, "saved.md");
			try {
				writeFileSync(file, "Original response.\n");
				writeFileSync(join(directory, "review.vim"), reviewVimScript(saved));
				writeFileSync(join(directory, "driver.vim"), [
					`let g:other_file = ${JSON.stringify(join(directory, "other.md"))}`,
					"call append(line('$'), '@@ Add an example')",
					`call feedkeys("${keys}", 'xt')`,
					"cquit 70", // Fail if the tested key sequence did not exit the editor.
				].join("\n"));
				const result = spawnSync(editor, [
					"-u", "NONE", "-i", "NONE", "-n", "-es",
					"-S", join(directory, "review.vim"), "-S", join(directory, "driver.vim"), "--", file,
				], { encoding: "utf8", timeout: 10000 });
				assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
				assert.equal(existsSync(saved), shouldSubmit);
				if (shouldSubmit) {
					const content = readFileSync(saved, "utf8");
					assert.match(content, /@@ Add an example/);
					assert.doesNotMatch(content, /@@ unsaved/);
					if (label === "save twice") assert.match(content, /@@ second save/);
				}
			} finally { rmSync(directory, { recursive: true, force: true }); }
		});
	}
}
