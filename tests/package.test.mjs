import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
const root = new URL("../", import.meta.url);
const read = path => readFileSync(new URL(path, root), "utf8");
test("personal package exposes one extension without npm runtime dependencies or gallery publication", () => {
	const manifest = JSON.parse(read("package.json"));
	assert.equal(manifest.name, "@elemount/pi-reply-to-ai"); assert.equal(manifest.version, "0.7.0");
	assert.equal(manifest.private, true); assert.equal(manifest.license, "UNLICENSED");
	assert.deepEqual(manifest.pi.extensions, ["./index.ts"]); assert.equal(manifest.dependencies, undefined);
	assert.equal(manifest.repository.url, "https://github.com/elemount/pi-reply-to-ai.git");
});
test("Neovim-only rewrite removes the Vim runtime and documents its breaking interaction changes", () => {
	assert.equal(existsSync(new URL("file-workspace-vim.ts", root)), false);
	assert.doesNotMatch(read("core.ts"), /reviewVimScript|newComments|chatHistoryForReview/);
	assert.match(read("README.md"), /Neovim >= 0.10/); assert.match(read("README.md"), /ReSubmit/);
	assert.match(read("README.md"), /16,384 UTF-8 bytes/);
});
test("Diffview remains a separate pinned dependency with its own license", () => {
	assert.match(read("diffview.ts"), /4516612fe98ff56ae0415a259ff6361a89419b0a/);
	assert.match(read("README.md"), /GPL-3.0-or-later/);
	assert.equal(existsSync(new URL("vendor", root)), false);
	assert.match(read("nvim/lua/pi_review_diffview.lua"), /disable_defaults = true/);
	assert.match(read("nvim/lua/pi_review_diffview.lua"), /blocked\[actions\[name\]\] = true/);
	assert.doesNotMatch(read("nvim/lua/pi_review_diffview.lua"), /vim\.keymap\.set/);
});
