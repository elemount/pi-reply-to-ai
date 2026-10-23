import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("personal Git package exposes one extension without npm/gallery publication", () => {
	assert.equal(manifest.name, "@elemount/pi-reply-to-ai");
	assert.equal(manifest.private, true);
	assert.equal(manifest.repository.url, "https://github.com/elemount/pi-reply-to-ai.git");
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
	assert.ok(!(manifest.keywords ?? []).includes("pi-package"));
	assert.ok(existsSync(new URL("../index.ts", import.meta.url)));
});

test("documentation uses the renamed repository and ~/repos checkout", () => {
	const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
	assert.ok(readme.startsWith("# pi-reply-to-ai\n"));
	assert.ok(readme.includes("pi install git:github.com/elemount/pi-reply-to-ai"));
	assert.ok(readme.includes("gh repo clone elemount/pi-reply-to-ai ~/repos/pi-reply-to-ai"));
	assert.ok(readme.includes("pi install ~/repos/pi-reply-to-ai"));
	assert.ok(!readme.includes("~/src/reply-to-ai"));
});

test("Pi host API is a peer dependency, not a bundled runtime dependency", () => {
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.deepEqual(manifest.dependencies ?? {}, {});
});
