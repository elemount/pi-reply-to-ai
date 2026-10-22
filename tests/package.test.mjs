import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("personal Git package exposes one extension without npm/gallery publication", () => {
	assert.equal(manifest.name, "@elemount/reply-to-ai");
	assert.equal(manifest.private, true);
	assert.equal(manifest.repository.url, "https://github.com/elemount/reply-to-ai.git");
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]);
	assert.ok(!(manifest.keywords ?? []).includes("pi-package"));
	assert.ok(existsSync(new URL("../index.ts", import.meta.url)));
});

test("Pi host API is a peer dependency, not a bundled runtime dependency", () => {
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], "*");
	assert.deepEqual(manifest.dependencies ?? {}, {});
});
