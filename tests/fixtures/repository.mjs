import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Local disposable repo; never reads credentials, runs hooks, or contacts a remote. */
export async function withRepository(fn, name = "repo") {
	const directory = mkdtempSync(join(tmpdir(), "pi-review-git-"));
	const cwd = join(directory, name);
	mkdirSync(cwd);
	const hooks = join(cwd, ".empty-hooks");
	mkdirSync(hooks);
	const git = (...args) => execFileSync("git", [
		"-c", `core.hooksPath=${hooks}`, "-c", "commit.gpgsign=false",
		"-c", "user.name=Review Tests", "-c", "user.email=review@example.invalid", ...args,
	], {
		cwd, encoding: "utf8",
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
	const write = (path, content) => {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), content);
	};
	const commit = (message = "test commit") => {
		git("add", "-A"); git("commit", "--quiet", "-m", message);
		return git("rev-parse", "HEAD");
	};
	try {
		git("init", "--quiet", "-b", "main");
		await fn({ cwd, git, write, commit });
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
