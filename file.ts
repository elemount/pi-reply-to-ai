import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const MAX_FILE_BYTES = 32 * 1024 * 1024;

export function resolveReviewPath(cwd: string, path: string): string {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return resolve(cwd, path);
}

/** Read a regular UTF-8 text file without ever opening the original for writing. */
export async function fileReview(cwd: string, path: string): Promise<{ path: string; content: string }> {
	const source = await realpath(resolveReviewPath(cwd, path));
	// Nonblocking open also avoids hanging if the supplied path names a FIFO.
	const file = await open(source, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		const info = await file.stat();
		if (!info.isFile()) throw new Error("File review requires a regular text file.");
		if (info.size > MAX_FILE_BYTES) throw new Error("File exceeds the 32 MiB review limit.");
		// Bound reads even if a log file grows after stat().
		const chunks: Buffer[] = [];
		let length = 0;
		while (true) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, MAX_FILE_BYTES + 1 - length));
			const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
			if (!bytesRead) break;
			length += bytesRead;
			if (length > MAX_FILE_BYTES) throw new Error("File exceeds the 32 MiB review limit.");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		const bytes = Buffer.concat(chunks, length);
		let content: string;
		try { content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
		catch { throw new Error("File review requires UTF-8 text, not binary or another encoding."); }
		if (/[\u0000-\u0008\u000e-\u001f]/.test(content)) throw new Error("File review requires text, not binary data.");
		return { path: source, content };
	} finally { await file.close(); }
}
