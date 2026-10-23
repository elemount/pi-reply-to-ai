/** pi-reply-to-ai — /re annotates AI replies, private file copies, directories, and Git patches. */
import { writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INLINE_REVIEW_BYTES, REVIEW_MARKER, assistantText, assistantTextRange, chatHistoryForReview, newComments, replyRangeDocument, reviewFilePrompt, reviewPrompt, type ReviewTag } from "./core.ts";
import { editReview } from "./editor.ts";
import { fileReview } from "./file.ts";
import { isReviewDirectory, prepareFileWorkspaceReview } from "./file-workspace.ts";
import { gitReview, parseReviewTarget, REVIEW_USAGE, type ReviewTarget } from "./git.ts";

export default function replyToAiExtension(pi: ExtensionAPI): void {
	let reviewing = false;

	const reviewCommand = {
		description: "Annotate replies, files/directories, or Git patches: /re [N | N-M | @file [@file ...] | @directory | c [rev] | p [base] | d]",
		getArgumentCompletions: (prefix: string) => {
			if (/^\d+-\d+$/.test(prefix)) return [{ value: prefix, label: prefix }];
			const items = ["0", "1", "2", "0-4", "0-9", "0-10", "message", "commit", "c", "pr", "p", "diff", "d", "help"]
				.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			if (["help", "-h", "--help"].includes(args.trim())) { ctx.ui.notify(REVIEW_USAGE, "info"); return; }
			let target: ReviewTarget;
			try { target = parseReviewTarget(args); }
			catch { ctx.ui.notify(REVIEW_USAGE, "warning"); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify("/re requires interactive terminal mode.", "error"); return; }
			if (reviewing || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current task and queued messages before running /re.", "warning"); return;
			}
			reviewing = true;
			const sessionId = ctx.sessionManager.getSessionId(), leafId = ctx.sessionManager.getLeafId();
			let cleanup: (() => void) | undefined;
			let retainFile = false;
			try {
				let prompt: string, large: boolean;
				if (target.kind === "files" || (target.kind === "file" && await isReviewDirectory(ctx.cwd, target.path))) {
					const paths = target.kind === "files" ? target.paths : [target.path];
					const prepared = await prepareFileWorkspaceReview(paths, ctx);
					if (!prepared) { ctx.ui.notify(`No saved files contain ${REVIEW_MARKER}; nothing sent.`, "info"); return; }
					cleanup = prepared.cleanup; prompt = prepared.prompt; large = prepared.large;
				} else {
					let original: string | undefined, sourceFile: string | undefined;
					let subject: string, tag: ReviewTag;
					if (target.kind === "file") {
						const source = await fileReview(ctx.cwd, target.path);
						original = source.content; sourceFile = source.path; subject = "this file"; tag = "file";
					} else if (target.kind === "message") {
						original = assistantText(ctx.sessionManager.buildSessionContext().messages, target.offset);
						subject = `AI response ${target.offset} (0 = latest)`; tag = "reply";
					} else if (target.kind === "range") {
						const replies = assistantTextRange(ctx.sessionManager.buildSessionContext().messages, target.start, target.end);
						original = replyRangeDocument(replies);
						subject = `AI responses ${target.start}-${target.end} (0 = latest), oldest first`; tag = "replies";
					} else {
						original = await gitReview(ctx.cwd, target); subject = "this Git patch"; tag = "patch";
					}
					if (original === undefined) {
						ctx.ui.notify(target.kind === "message" ? `No AI text response at index ${target.offset} (0 = latest).` : "No Git changes to review.", "info"); return;
					}
					if (tag === "reply" || tag === "replies") original = chatHistoryForReview(original);
					const saved = await editReview(original, ctx, { patch: tag === "patch", extension: sourceFile ? extname(sourceFile) : undefined });
					if (!saved) { ctx.ui.notify("Review cancelled; nothing sent.", "info"); return; }
					cleanup = saved.cleanup;
					// File review is deliberately presence-only; chat and generated patches retain their existing rules.
					const comments = tag === "file" ? [] : newComments(original, saved.content);
					if (tag === "file" ? !saved.content.includes(REVIEW_MARKER) : comments.length === 0) {
						ctx.ui.notify(tag === "file" ? `No ${REVIEW_MARKER} comments; nothing sent.` : `No new ${REVIEW_MARKER} comments; nothing sent.`, "info"); return;
					}
					large = Buffer.byteLength(saved.content, "utf8") > INLINE_REVIEW_BYTES;
					if (large) {
						const commentsPath = join(dirname(saved.filePath), "comments.json");
						writeFileSync(commentsPath, JSON.stringify(tag === "file" ? newComments("", saved.content) : comments, null, 2) + "\n", { mode: 0o600 });
						prompt = reviewFilePrompt(saved.filePath, commentsPath, subject, tag, sourceFile);
					} else prompt = reviewPrompt(saved.content, subject, tag, sourceFile);
				}
				if (sessionId !== ctx.sessionManager.getSessionId() || leafId !== ctx.sessionManager.getLeafId()) {
					ctx.ui.pasteToEditor(prompt); retainFile = large;
					ctx.ui.notify("Session or branch changed; review kept in the input editor for manual sending.", "warning"); return;
				}
				pi.sendUserMessage(prompt, { deliverAs: "followUp" }); retainFile = large;
			} catch (error) {
				ctx.ui.notify(`/re failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			} finally { if (!retainFile) cleanup?.(); reviewing = false; }
		},
	};
	pi.registerCommand("re", reviewCommand);
	pi.registerShortcut("ctrl+alt+r", { description: "Review the latest AI reply in vim", handler: ctx => reviewCommand.handler("", ctx) });
}
