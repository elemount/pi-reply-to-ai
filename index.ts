/** reply-to-ai — /re annotates an AI reply, file copy, or Git patch in vim. */
import { writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INLINE_REVIEW_BYTES, assistantText, newComments, reviewFilePrompt, reviewPrompt, type ReviewTag } from "./core.ts";
import { editReview, type SavedReview } from "./editor.ts";
import { fileReview } from "./file.ts";
import { gitReview, parseReviewTarget, REVIEW_USAGE, type ReviewTarget } from "./git.ts";

export default function replyToAiExtension(pi: ExtensionAPI): void {
	let reviewing = false;

	const reviewCommand = {
		description: "Annotate an AI reply, file, or Git patch: /re [N | @file | c [rev] | p [base] | d]",
		getArgumentCompletions: (prefix: string) => {
			const items = ["0", "1", "2", "message", "commit", "c", "pr", "p", "diff", "d", "help"]
				.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			if (["help", "-h", "--help"].includes(args.trim())) {
				ctx.ui.notify(REVIEW_USAGE, "info");
				return;
			}
			let target: ReviewTarget;
			try { target = parseReviewTarget(args); }
			catch {
				ctx.ui.notify(REVIEW_USAGE, "warning");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/re requires interactive terminal mode.", "error");
				return;
			}
			if (reviewing || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current task and queued messages before running /re.", "warning");
				return;
			}
			reviewing = true;
			const sessionId = ctx.sessionManager.getSessionId();
			const leafId = ctx.sessionManager.getLeafId();
			let saved: SavedReview | undefined;
			let retainFile = false;
			try {
				let original: string | undefined;
				let sourceFile: string | undefined;
				let subject: string;
				let tag: ReviewTag;
				if (target.kind === "file") {
					const source = await fileReview(ctx.cwd, target.path);
					original = source.content;
					sourceFile = source.path;
					subject = "this file";
					tag = "file";
				} else if (target.kind === "message") {
					original = assistantText(ctx.sessionManager.buildSessionContext().messages, target.offset);
					subject = `AI response ${target.offset} (0 = latest)`;
					tag = "reply";
				} else {
					original = await gitReview(ctx.cwd, target);
					subject = "this Git patch";
					tag = "patch";
				}
				if (original === undefined) {
					ctx.ui.notify(target.kind === "message"
						? `No AI text response at index ${target.offset} (0 = latest).`
						: "No Git changes to review.", "info");
					return;
				}
				saved = await editReview(original, ctx, { patch: tag === "patch", extension: sourceFile ? extname(sourceFile) : undefined });
				if (saved === undefined) {
					ctx.ui.notify("Review cancelled; nothing sent.", "info");
					return;
				}
				const comments = newComments(original, saved.content);
				if (comments.length === 0) {
					ctx.ui.notify("No new @@ comments; nothing sent.", "info");
					return;
				}
				const bytes = Buffer.byteLength(saved.content, "utf8");
				const large = bytes > INLINE_REVIEW_BYTES;
				let prompt: string;
				if (large) {
					// Keep both the context and the exact NEW comment index on disk. Even a
					// huge comment must not accidentally get pasted into the model context.
					const commentsPath = join(dirname(saved.filePath), "comments.json");
					writeFileSync(commentsPath, JSON.stringify(comments, null, 2) + "\n", { mode: 0o600 });
					prompt = reviewFilePrompt(saved.filePath, commentsPath, subject, tag, sourceFile);
				} else prompt = reviewPrompt(saved.content, subject, tag, sourceFile);
				if (sessionId !== ctx.sessionManager.getSessionId() || leafId !== ctx.sessionManager.getLeafId()) {
					// Another extension may have changed the session while the TUI was stopped.
					// Keep the review as a draft rather than sending it to the wrong conversation.
					ctx.ui.pasteToEditor(prompt);
					retainFile = large;
					ctx.ui.notify("Session or branch changed; review kept in the input editor for manual sending.", "warning");
					return;
				}
				pi.sendUserMessage(prompt, { deliverAs: "followUp" });
				retainFile = large;
			} catch (error) {
				ctx.ui.notify(`/re failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally {
				if (!retainFile) saved?.cleanup();
				reviewing = false;
			}
		},
	};

	pi.registerCommand("re", reviewCommand);
	pi.registerShortcut("ctrl+alt+r", {
		description: "Review the latest AI reply in vim",
		handler: (ctx) => reviewCommand.handler("", ctx),
	});
}
