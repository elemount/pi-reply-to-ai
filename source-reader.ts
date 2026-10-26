/** Short-lived lazy reader invoked by the Neovim review runtime. No server. */
import { readFileSync } from "node:fs";
import { readSource } from "./file-workspace.ts";

try {
	const manifest = JSON.parse(readFileSync(process.argv[2], "utf8"));
	const id = Number(process.argv[3]);
	const source = manifest.sources.find((source: { id: number }) => source.id === id);
	if (!Number.isSafeInteger(id) || !source) throw new Error("Invalid review file selection.");
	const content = await readSource(source, manifest.cwd);
	process.stdout.write(JSON.stringify({ content, bytes: Buffer.byteLength(content) }));
} catch (error) {
	process.stdout.write(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
	process.exitCode = 1;
}
