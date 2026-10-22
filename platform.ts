import { posix, win32 } from "node:path";

export function environmentValue(env: NodeJS.ProcessEnv, name: string, platform = process.platform): string | undefined {
	if (platform !== "win32") return env[name];
	const key = Object.keys(env).find(key => key.toLowerCase() === name.toLowerCase());
	return key === undefined ? undefined : env[key];
}

export function isWsl(env: NodeJS.ProcessEnv = process.env, platform = process.platform): boolean {
	return platform === "linux" && Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}

/** Only native executable suffixes are searched on Windows, never batch wrappers. */
export function editorCandidates(command: string, cwd: string, env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
	const paths = platform === "win32" ? win32 : posix;
	const explicit = paths.isAbsolute(command) || command.includes("/") || (platform === "win32" && command.includes("\\"));
	const path = environmentValue(env, "PATH", platform);
	const bases = explicit ? [paths.resolve(cwd, command)] : path === undefined ? []
		: path.split(platform === "win32" ? ";" : ":").map(directory => {
			if (platform === "win32") directory = directory.trim().replace(/^"(.*)"$/, "$1");
			return paths.resolve(cwd, directory, command);
		});
	return bases.flatMap(base => platform === "win32" && !win32.extname(base) ? [base + ".exe", base + ".com"] : [base]);
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Display commands for the user's native shell. Execution always uses argv, not a shell. */
export function formatShellCommand(command: string, args: readonly string[], platform = process.platform): string {
	if (platform === "win32") return "& " + [command, ...args].map(value => `'${value.replaceAll("'", "''")}'`).join(" ");
	return [command, ...args].map(value => /^[a-zA-Z0-9_./:=+-]+$/.test(value) ? value : shellQuote(value)).join(" ");
}

export function commandShell(platform = process.platform): string {
	return platform === "win32" ? "PowerShell" : "POSIX sh";
}
