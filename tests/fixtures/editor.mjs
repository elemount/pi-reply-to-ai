#!/usr/bin/env node
// Non-interactive stand-in for vim, used only by the extension tests.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const script = readFileSync(args[args.indexOf("-S") + 1], "utf8");
const file = args[args.indexOf("--") + 1];
const saved = JSON.parse(/^let s:saved_file = (.+)$/m.exec(script)[1]);
const mode = process.env.REVIEW_TEST_MODE;
if (process.env.REVIEW_TEST_LOG) writeFileSync(process.env.REVIEW_TEST_LOG, JSON.stringify({ args, file, saved, initialContent: readFileSync(file, "utf8") }));
if (["submit", "save-quit", "unsaved-after-save", "crash"].includes(mode)) {
	appendFileSync(file, "\nInline context @@ Add an example\n@@ Explain edge cases\n");
}
if (mode === "huge-comment") appendFileSync(file, "\n@@ " + "x".repeat(20000) + "\n");
if (["submit", "save-quit", "unchanged", "unsaved-after-save", "huge-comment", "crash"].includes(mode)) {
	writeFileSync(saved, readFileSync(file));
}
if (mode === "unsaved-after-save") appendFileSync(file, "\n@@ Unsaved comment; do not send\n");
if (mode === "crash") process.exit(3);
