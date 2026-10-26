import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DIFFVIEW_COMMIT, diffviewPath, installDiffview, requireDiffview } from "../diffview.ts";

async function isolated(fn) {
	const previous = process.env.PI_REVIEW_DIFFVIEW, cache = process.env.XDG_CACHE_HOME;
	const directory = mkdtempSync(join(tmpdir(), "pi-diffview-dependency-"));
	try { await fn(directory); }
	finally {
		if (previous === undefined) delete process.env.PI_REVIEW_DIFFVIEW; else process.env.PI_REVIEW_DIFFVIEW = previous;
		if (cache === undefined) delete process.env.XDG_CACHE_HOME; else process.env.XDG_CACHE_HOME = cache;
		rmSync(directory, { recursive: true, force: true });
	}
}
test("missing dependencies produce setup guidance without creating directories or contacting a remote", async () => {
	await isolated(async directory => {
		delete process.env.PI_REVIEW_DIFFVIEW; process.env.XDG_CACHE_HOME = directory;
		const path = diffviewPath(); assert.ok(path.endsWith(DIFFVIEW_COMMIT.slice(0, 12)));
		await assert.rejects(requireDiffview(), /Run \/re setup once/); assert.equal(existsSync(path), false);
	});
});
test("setup never replaces a custom runtime or an invalid existing standard cache checkout", async () => {
	await isolated(async directory => {
		process.env.PI_REVIEW_DIFFVIEW = join(directory, "custom");
		await assert.rejects(installDiffview(), /Update it manually/); assert.equal(existsSync(process.env.PI_REVIEW_DIFFVIEW), false);
		delete process.env.PI_REVIEW_DIFFVIEW; process.env.XDG_CACHE_HOME = directory;
		mkdirSync(diffviewPath(), { recursive: true });
		await assert.rejects(installDiffview(), /already exists/);
	});
});
test("setup is offline and idempotent when the exact pinned runtime is already installed", async t => {
	let installed;
	try { installed = await requireDiffview(); }
	catch { if (process.env.PI_REVIEW_REQUIRE_NVIM) throw new Error("Pinned Diffview missing"); t.skip("Diffview not installed"); return; }
	assert.equal(await installDiffview(), installed); assert.equal(await requireDiffview(), installed);
});
