/** Separately installed, pinned Neovim dependency. Normal reviews never access the network. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { git } from "./git.ts";

export const DIFFVIEW_COMMIT = "4516612fe98ff56ae0415a259ff6361a89419b0a";
export const DIFFVIEW_URL = "https://github.com/sindrets/diffview.nvim.git";
export function diffviewPath(): string {
	if (process.env.PI_REVIEW_DIFFVIEW) return resolve(process.env.PI_REVIEW_DIFFVIEW);
	const cache = process.env.XDG_CACHE_HOME || (process.platform === "win32" ? process.env.LOCALAPPDATA : undefined) || join(homedir(), ".cache");
	return join(cache, "pi-reply-to-ai", `diffview.nvim-${DIFFVIEW_COMMIT.slice(0, 12)}`);
}
export async function requireDiffview(): Promise<string> {
	const path = diffviewPath();
	try {
		if (existsSync(join(path, "plugin", "diffview.lua")) && (await git(path, ["rev-parse", "HEAD"])).trim() === DIFFVIEW_COMMIT) return path;
	} catch { /* Report a single actionable dependency error. */ }
	throw new Error(`Diffview ${DIFFVIEW_COMMIT.slice(0, 12)} is not installed. Run /re setup once (network required), or set PI_REVIEW_DIFFVIEW to a checkout at that commit.`);
}

/** Explicit setup only. Never called automatically by review or extension loading. */
export async function installDiffview(): Promise<string> {
	try { return await requireDiffview(); } catch { /* Install the standard cache location below. */ }
	if (process.env.PI_REVIEW_DIFFVIEW) throw new Error("PI_REVIEW_DIFFVIEW is not a matching Diffview checkout. Update it manually or unset it before /re setup.");
	const target = diffviewPath(), parent = resolve(target, "..");
	if (existsSync(target)) throw new Error(`An invalid dependency checkout already exists at ${target}. Move it aside before /re setup.`);
	await mkdir(parent, { recursive: true, mode: 0o700 });
	const temporary = await mkdtemp(join(parent, ".diffview-install-"));
	try {
		await git(temporary, ["init", "--quiet", "--template="]);
		await git(temporary, ["remote", "add", "origin", DIFFVIEW_URL]);
		await git(temporary, ["fetch", "--quiet", "--depth=1", "origin", DIFFVIEW_COMMIT]);
		const noHooks = join(temporary, ".git", "no-hooks");
		await mkdir(noHooks);
		await git(temporary, ["-c", `core.hooksPath=${noHooks}`, "-c", "core.autocrlf=false", "checkout", "--quiet", "--detach", DIFFVIEW_COMMIT]);
		if ((await git(temporary, ["rev-parse", "HEAD"])).trim() !== DIFFVIEW_COMMIT) throw new Error("Diffview commit verification failed.");
		try { await rename(temporary, target); }
		catch (error) { if (!existsSync(target)) throw error; }
		return await requireDiffview();
	} finally { await rm(temporary, { recursive: true, force: true }); }
}
