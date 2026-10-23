#!/usr/bin/env node
// Non-interactive stand-in for vim, used only by the extension tests.
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const args = process.argv.slice(2);
const script = readFileSync(args[args.indexOf("-S") + 1], "utf8");
const workspaceMatch = /^let s:workspace = (.+)$/m.exec(script);
if (workspaceMatch) {
	const workspace = JSON.parse(workspaceMatch[1]);
	const manifest = JSON.parse(readFileSync(join(workspace, "manifest.json"), "utf8"));
	const mode = process.env.REVIEW_TEST_MODE;
	let sequence = 0;
	for (const item of manifest.files.slice(0, manifest.tree ? 2 : manifest.files.length)) {
		if (!existsSync(item.copy)) {
			sequence++;
			writeFileSync(join(workspace, "request.json"), JSON.stringify({ sequence, id: item.id }));
			const deadline = Date.now() + 10000;
			let loaded = false;
			while (Date.now() < deadline) {
				if (existsSync(join(workspace, "response.json"))) {
					const response = JSON.parse(readFileSync(join(workspace, "response.json"), "utf8"));
					if (response.sequence === sequence) {
						if (response.error) throw new Error(response.error);
						loaded = true; break;
					}
				}
				await sleep(10);
			}
			if (!loaded) throw new Error("Fixture copy request timed out");
			rmSync(join(workspace, "response.json"), { force: true });
		}
		if (mode !== "unchanged") appendFileSync(item.copy, "\n#REPLY: File comment\n");
		if (mode !== "cancel") writeFileSync(item.saved, readFileSync(item.copy));
		if (mode === "unsaved-after-save") appendFileSync(item.copy, "\n#REPLY: Unsaved comment\n");
	}
	if (process.env.REVIEW_TEST_LOG) writeFileSync(process.env.REVIEW_TEST_LOG, JSON.stringify({ workspace, tree: manifest.tree, files: manifest.files, args }));
	process.exit(mode === "crash" ? 3 : 0);
}
const file = args[args.indexOf("--") + 1];
const saved = JSON.parse(/^let s:saved_file = (.+)$/m.exec(script)[1]);
const mode = process.env.REVIEW_TEST_MODE;
if (process.env.REVIEW_TEST_LOG) writeFileSync(process.env.REVIEW_TEST_LOG, JSON.stringify({ args, file, saved, initialContent: readFileSync(file, "utf8") }));
if (["submit", "save-quit", "unsaved-after-save", "crash"].includes(mode)) {
	appendFileSync(file, "\nInline context #REPLY: Add an example\n#REPLY: Explain edge cases\n");
}
if (mode === "huge-comment") appendFileSync(file, "\n#REPLY: " + "x".repeat(20000) + "\n");
if (["submit", "save-quit", "unchanged", "unsaved-after-save", "huge-comment", "crash"].includes(mode)) {
	writeFileSync(saved, readFileSync(file));
}
if (mode === "unsaved-after-save") appendFileSync(file, "\n#REPLY: Unsaved comment; do not send\n");
if (mode === "crash") process.exit(3);
