#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
if (process.argv.includes("--version")) { console.log(process.env.PI_REVIEW_MOCK_VERSION || "NVIM v0.10.4"); process.exit(0); }
const manifest = JSON.parse(readFileSync(process.env.PI_REVIEW_MANIFEST, "utf8"));
if (process.env.PI_REVIEW_MOCK_ACTION !== "cancel") {
	const comments = process.env.PI_REVIEW_MOCK_ACTION === "empty" ? [] : [{ source: manifest.sources[0].id, line: 1, endLine: 1,
		context: "1: original", text: process.env.PI_REVIEW_MOCK_TEXT || "Please improve this." }];
	writeFileSync(manifest.result, JSON.stringify(comments), { mode: 0o600 });
}
if (process.env.PI_REVIEW_MOCK_ACTION === "fail") process.exitCode = 2;
