import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import extension from "../index.ts";
import { findReviewEditor } from "../editor.ts";
import { requireDiffview } from "../diffview.ts";
import { withRepository } from "./fixtures/repository.mjs";

const mock = fileURLToPath(new URL("./fixtures/mock-nvim.mjs", import.meta.url));
const assistant = text => ({ role: "assistant", content: [{ type: "text", text }] });
async function withEditor(fn, action) {
	const old = { ...process.env };
	process.env.PI_REVIEW_EDITOR = mock;
	if (action) process.env.PI_REVIEW_MOCK_ACTION = action; else delete process.env.PI_REVIEW_MOCK_ACTION;
	try { await fn(); }
	finally {
		for (const key of Object.keys(process.env)) if (!(key in old)) delete process.env[key];
		Object.assign(process.env, old);
	}
}
function harness({ cwd = process.cwd(), messages = [assistant("Original AI answer.")], onEditor, sendError = false } = {}) {
	let command, shortcut;
	const sent = [], notices = [], drafts = [], manifests = [], lifecycle = [];
	const state = { session: "session", leaf: "leaf", idle: true, pending: false };
	const pi = {
		registerCommand(name, value) { assert.equal(name, "re"); command = value; },
		registerShortcut(key, value) { assert.equal(key, "ctrl+alt+r"); shortcut = value; },
		sendUserMessage(prompt, options) { if (sendError) throw new Error("send failed"); sent.push({ prompt, options }); },
	};
	extension(pi);
	const ctx = { cwd, mode: "tui", isIdle: () => state.idle, hasPendingMessages: () => state.pending,
		sessionManager: { getSessionId: () => state.session, getLeafId: () => state.leaf, buildSessionContext: () => ({ messages }) },
		ui: { notify: (text, level) => notices.push({ text, level }), pasteToEditor: text => drafts.push(text),
			custom: factory => new Promise((resolve, reject) => {
				onEditor?.(state);
				Promise.resolve(factory({ stop: () => lifecycle.push("stop"), start: () => lifecycle.push("start"), requestRender: () => lifecycle.push("render") }, {}, {}, resolve)).catch(reject);
			}) },
	};
	return { command, shortcut, ctx, state, sent, notices, drafts, manifests, lifecycle, run: args => command.handler(args, ctx) };
}

test("command registration, completions and shortcut retain their public surface", () => {
	const h = harness(); assert.match(h.shortcut.description, /Neovim/);
	assert.ok(h.command.getArgumentCompletions("p").some(item => item.value === "pr"));
	assert.deepEqual(h.command.getArgumentCompletions("0-10"), [{ value: "0-10", label: "0-10" }]);
	assert.equal(h.command.getArgumentCompletions("missing"), null);
});
test("interactive, idle and queued-message guards reject before launching an editor", async () => {
	await withEditor(async () => {
		for (const change of [h => h.ctx.mode = "rpc", h => h.state.idle = false, h => h.state.pending = true]) {
			const h = harness(); change(h); await h.run(""); assert.equal(h.sent.length, 0); assert.equal(h.lifecycle.length, 0); assert.ok(h.notices.length);
		}
		const h = harness(); await h.run("help"); await h.run("invalid args"); assert.equal(h.lifecycle.length, 0);
	});
});
test("small reviews go directly to chat as one Markdown message with the commented reply excerpt", async () => {
	await withEditor(async () => {
		const h = harness({ messages: [assistant("older answer"), assistant("latest answer")] });
		await h.run("1");
		assert.equal(h.sent.length, 1); assert.equal(h.sent[0].options.deliverAs, "followUp");
		assert.match(h.sent[0].prompt, /older answer/); assert.doesNotMatch(h.sent[0].prompt, /latest answer/);
		assert.match(h.sent[0].prompt, /AI reply 1 — lines 1/); assert.match(h.sent[0].prompt, /Please improve this/);
		assert.deepEqual(h.lifecycle, ["stop", "start", "render"]);
	});
});
test("inclusive reply ranges export only commented replies with their original indexes", async () => {
	await withEditor(async () => {
		const h = harness({ messages: [assistant("old"), assistant("middle"), assistant("latest")] });
		await h.run("message 0-2"); const prompt = h.sent[0].prompt;
		assert.match(prompt, /### AI reply 2 — lines 1/);
		assert.match(prompt, /1: old\n```/);
		assert.doesNotMatch(prompt, /AI reply [01]|middle|latest|Selected AI replies/);
	});
});
test("long replies with small comments stay inline and omit text away from the comment", async () => {
	await withEditor(async () => {
		const original = "Commented line\nNearby context\nMore nearby context\n" + "Unrelated distant text\n".repeat(1000);
		for (const onEditor of [undefined, state => state.session = "new"]) {
			const h = harness({ messages: [assistant(original)], onEditor }); await h.run("");
			const prompt = h.sent[0]?.prompt ?? h.drafts[0];
			assert.match(prompt, /1: Commented line\n2: Nearby context\n3: More nearby context/);
			assert.match(prompt, /Please improve this/);
			assert.doesNotMatch(prompt, /Unrelated distant text|Selected AI replies|review\.md/);
			assert.ok(Buffer.byteLength(prompt) < 16384);
		}
	});
});
test("missing replies and unavailable ranges never launch an editor or send partial reviews", async () => {
	await withEditor(async () => {
		const h = harness(); await h.run("4"); await h.run("0-9");
		assert.equal(h.sent.length, 0); assert.equal(h.lifecycle.length, 0);
		assert.match(h.notices.map(item => item.text).join("\n"), /No AI text response.*\n.*unavailable/);
	});
});
test("cancel, empty explicit submission and abnormal exit never send, even with marker-containing originals", async () => {
	for (const action of ["cancel", "empty", "fail"]) await withEditor(async () => {
		const h = harness({ messages: [assistant("#REPLY: old\n@@ diff\n?? code")] }); await h.run("");
		assert.equal(h.sent.length, 0); assert.equal(h.drafts.length, 0); assert.deepEqual(h.lifecycle, ["stop", "start", "render"]);
		assert.match(h.notices[0].text, action === "fail" ? /abnormally/ : /nothing sent/);
	}, action);
});
test("new explicit comments count even when their text already occurs in the quoted original", async () => {
	await withEditor(async () => {
		const h = harness({ messages: [assistant("#REPLY: Please improve this.")] }); await h.run(""); assert.equal(h.sent.length, 1);
	});
});
test("session, leaf, idle-state and queued-message changes retain a draft rather than send", async () => {
	await withEditor(async () => {
		for (const change of [state => state.session = "other", state => state.leaf = "other", state => state.idle = false, state => state.pending = true]) {
			const h = harness({ onEditor: change }); await h.run("");
			assert.equal(h.sent.length, 0); assert.equal(h.drafts.length, 1); assert.match(h.drafts[0], /Please improve this/);
			assert.match(h.notices[0].text, /manual sending/);
		}
	});
});
test("Ctrl+Alt+R and /re share duplicate-launch locking and release it after completion", async () => {
	await withEditor(async () => {
		let entered; const ready = new Promise(resolve => entered = resolve);
		const h = harness({ onEditor: () => entered() });
		const first = h.run(""); await ready; await h.shortcut.handler(h.ctx); await first;
		assert.equal(h.sent.length, 1); assert.ok(h.notices.some(item => /Wait for/.test(item.text)));
		await h.shortcut.handler(h.ctx); assert.equal(h.sent.length, 2);
	});
});
test("send failures keep the complete prompt as a draft", async () => {
	await withEditor(async () => {
		const h = harness({ sendError: true }); await h.run(""); assert.equal(h.drafts.length, 1); assert.match(h.notices[0].text, /kept in the input editor/);
	});
});
test("large reviews and large changed-session drafts retain only review.md, not editor or source artifacts", async () => {
	await withEditor(async () => {
		process.env.PI_REVIEW_MOCK_TEXT = "Large comment\n" + "x".repeat(17000);
		for (const onEditor of [undefined, state => state.session = "new"]) {
			const h = harness({ messages: [assistant("Reply excerpt")], onEditor }); await h.run("");
			const prompt = h.sent[0]?.prompt ?? h.drafts[0]; const path = JSON.parse(/in (".*") and address/.exec(prompt)[1]);
			try {
				assert.deepEqual(readdirSync(dirname(path)), ["review.md"]);
				const markdown = readFileSync(path, "utf8");
				assert.match(markdown, /1: Reply excerpt/);
				assert.ok(markdown.includes(process.env.PI_REVIEW_MOCK_TEXT));
				assert.doesNotMatch(markdown, /Selected AI replies/);
			} finally { rmSync(dirname(path), { recursive: true, force: true }); }
		}
	});
});
test("file and directory commands export only comments and quoted excerpts, not full source copies", async () => {
	await withEditor(async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-command-files-"));
		try {
			const original = "#REPLY: source literal\n" + "unnecessary full source\n".repeat(1000);
			writeFileSync(join(cwd, "one.ts"), original); writeFileSync(join(cwd, "two.ts"), "two\n");
			for (const arg of ["@one.ts", "@one.ts @two.ts", "@."]) {
				const h = harness({ cwd }); await h.run(arg); assert.equal(h.sent.length, 1);
				assert.doesNotMatch(h.sent[0].prompt, /unnecessary full source/); assert.match(h.sent[0].prompt, /one.ts/);
			}
			assert.equal(readFileSync(join(cwd, "one.ts"), "utf8"), original); assert.equal(existsSync(join(cwd, ".git")), false);
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
});
test("Git commands preserve fixed comparison provenance and do not export full diffs", async t => {
	try { await requireDiffview(); } catch { if (process.env.PI_REVIEW_REQUIRE_NVIM) throw new Error("Pinned Diffview missing"); t.skip("Diffview not installed"); return; }
	await withEditor(async () => {
		await withRepository(async ({ cwd, write, commit, git }) => {
			write("root.txt", "root\n"); const base = commit(); git("checkout", "-qb", "feature"); write("file.txt", "full diff should not be sent\n"); const head = commit();
			write("file.txt", "dirty\n"); const before = git("status", "--porcelain");
			for (const arg of ["c", "p main", "d"]) {
				const h = harness({ cwd }); await h.run(arg); assert.equal(h.sent.length, 1, JSON.stringify(h.notices));
				assert.ok(h.sent[0].prompt.includes(head)); assert.doesNotMatch(h.sent[0].prompt, /diff --git|full diff should not be sent/);
				if (arg === "p main") assert.ok(h.sent[0].prompt.includes(base));
			}
			assert.equal(git("status", "--porcelain"), before);
		});
	});
});
test("editor executable must identify as Neovim >= 0.10; failures do not strand the launch lock", async () => {
	await withEditor(async () => {
		for (const version of ["VIM - Vi IMproved 9.1", "NVIM v0.9.5"]) {
			process.env.PI_REVIEW_MOCK_VERSION = version; await assert.rejects(findReviewEditor(process.cwd()), /Neovim >= 0.10/);
		}
		process.env.PI_REVIEW_MOCK_VERSION = "NVIM v0.10.4";
		const h = harness(); await h.run(""); assert.equal(h.sent.length, 1);
		process.env.PI_REVIEW_EDITOR = "/missing/nvim"; await h.run(""); assert.match(h.notices.at(-1).text, /Cannot find Neovim/);
		process.env.PI_REVIEW_EDITOR = mock; await h.run(""); assert.equal(h.sent.length, 2);
	});
});
