import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INLINE_REVIEW_BYTES, reviewReferencePrompt } from "./core.ts";

/** Small reviews never need a file or a model tool read. Large ones retain only review.md. */
export async function prepareDelivery(markdown: string): Promise<{ prompt: string; large: boolean; cleanup(): Promise<void> }> {
	if (Buffer.byteLength(markdown, "utf8") <= INLINE_REVIEW_BYTES) return { prompt: markdown, large: false, cleanup: async () => {} };
	const directory = await mkdtemp(join(tmpdir(), "pi-review-"));
	try {
		const path = join(directory, "review.md");
		await writeFile(path, markdown, { mode: 0o600 });
		return { prompt: reviewReferencePrompt(path), large: true, cleanup: () => rm(directory, { recursive: true, force: true }) };
	} catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
}
