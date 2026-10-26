/** /re — read-only Neovim browsing, explicit comments, concise Markdown back to Pi. */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { assistantText, assistantTextRange, MAX_REVIEW_BYTES, reviewMarkdown, type ReviewDocument, type ReviewSource } from "./core.ts";
import { prepareDelivery } from "./delivery.ts";
import { installDiffview, requireDiffview } from "./diffview.ts";
import { editReview, type ReviewView } from "./editor.ts";
import { fileSources } from "./file-workspace.ts";
import { createGitWorkspace } from "./git-workspace.ts";
import { gitComparison, parseReviewTarget, REVIEW_USAGE, type ReviewTarget } from "./git.ts";

export default function replyToAiExtension(pi: ExtensionAPI): void {
	let reviewing = false;
	const reviewCommand = {
		description: "Review replies, files/directories, or Git changes in Neovim: /re [N | N-M | @file ... | @directory | c [rev] | p [base] | d]",
		getArgumentCompletions: (prefix: string) => {
			if (/^\d+-\d+$/.test(prefix)) return [{ value: prefix, label: prefix }];
			const items = ["0", "1", "2", "0-4", "0-9", "0-10", "message", "commit", "c", "pr", "p", "diff", "d", "setup", "help"]
				.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args: string, ctx: ExtensionContext) => {
			if (["help", "-h", "--help"].includes(args.trim())) { ctx.ui.notify(REVIEW_USAGE, "info"); return; }
			let target: ReviewTarget;
			try { target = parseReviewTarget(args); } catch { ctx.ui.notify(REVIEW_USAGE, "warning"); return; }
			if (ctx.mode !== "tui") { ctx.ui.notify("/re requires interactive terminal mode.", "error"); return; }
			if (reviewing || !ctx.isIdle() || ctx.hasPendingMessages()) {
				ctx.ui.notify("Wait for the current task and queued messages before running /re.", "warning"); return;
			}
			reviewing = true;
			const sessionId = ctx.sessionManager.getSessionId(), leafId = ctx.sessionManager.getLeafId();
			let cleanup: (() => Promise<void>) | undefined;
			try {
				if (target.kind === "setup") {
					ctx.ui.notify("Installing pinned Diffview (this explicit setup requires network access)...", "info");
					ctx.ui.notify(`Diffview ready: ${await installDiffview()}`, "info"); return;
				}
				let document: ReviewDocument, tree = false, view: ReviewView | undefined;
				if (target.kind === "file" || target.kind === "files") {
					const prepared = await fileSources(target.kind === "file" ? [target.path] : target.paths, ctx.cwd);
					tree = prepared.tree;
					document = { sources: prepared.sources, title: "File review" };
				} else if (target.kind === "message" || target.kind === "range") {
					const messages = ctx.sessionManager.buildSessionContext().messages;
					let sources: ReviewSource[];
					if (target.kind === "message") {
						const text = assistantText(messages, target.offset);
						if (text === undefined) { ctx.ui.notify(`No AI text response at index ${target.offset} (0 = latest).`, "info"); return; }
						sources = [{ id: 0, label: `AI reply ${target.offset}`, reply: target.offset, content: text }];
					} else sources = assistantTextRange(messages, target.start, target.end).map(({ index, text }, id) => ({ id, label: `AI reply ${index}`, reply: index, content: text }));
					if (sources.reduce((sum, source) => sum + Buffer.byteLength(source.content ?? ""), 0) > MAX_REVIEW_BYTES) throw new Error("Selected replies exceed the 64 MiB review limit.");
					document = { sources, title: "AI reply review" };
				} else {
					const runtime = await requireDiffview();
					const comparison = await gitComparison(ctx.cwd, target);
					const workspace = comparison && await createGitWorkspace(comparison);
					if (!workspace) { ctx.ui.notify("No reviewable Git text changes.", "info"); return; }
					cleanup = workspace.cleanup;
					view = { directory: workspace.directory, left: workspace.left, right: workspace.right, paths: workspace.paths, runtime };
					document = { sources: workspace.sources, title: "Git review", provenance: workspace.provenance };
				}
				const comments = await editReview(document, ctx, { tree, view });
				if (!comments) { ctx.ui.notify("Review cancelled; nothing sent.", "info"); return; }
				if (!comments.length) { ctx.ui.notify("No review comments; nothing sent.", "info"); return; }
				const delivery = await prepareDelivery(reviewMarkdown(document, comments));
				let keep = false;
				try {
					if (sessionId !== ctx.sessionManager.getSessionId() || leafId !== ctx.sessionManager.getLeafId() || !ctx.isIdle() || ctx.hasPendingMessages()) {
						ctx.ui.pasteToEditor(delivery.prompt); keep = delivery.large;
						ctx.ui.notify("Session, branch, or task changed; review kept in the input editor for manual sending.", "warning"); return;
					}
					try { pi.sendUserMessage(delivery.prompt, { deliverAs: "followUp" }); keep = delivery.large; }
					catch (error) {
						ctx.ui.pasteToEditor(delivery.prompt); keep = delivery.large;
						ctx.ui.notify(`Could not send review; kept in the input editor: ${error instanceof Error ? error.message : String(error)}`, "warning");
					}
				} finally { if (!keep) await delivery.cleanup(); }
			} catch (error) { ctx.ui.notify(`/re failed: ${error instanceof Error ? error.message : String(error)}`, "error"); }
			finally { try { await cleanup?.(); } finally { reviewing = false; } }
		},
	};
	pi.registerCommand("re", reviewCommand);
	pi.registerShortcut("ctrl+alt+r", { description: "Review the latest AI reply in Neovim", handler: ctx => reviewCommand.handler("", ctx) });
}
