/** Pure helpers for the /re extension. No Pi runtime imports. */
import { commandShell, formatShellCommand } from "./platform.ts";
export { shellQuote } from "./platform.ts";
export interface MessageLike {
	role: string;
	content?: unknown;
	stopReason?: string;
}

function* aiTextReplies(messages: readonly MessageLike[]): Generator<string> {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text) yield text;
	}
}

/** Select an AI text reply by recency: 0 = latest. Ignore user/tool/thinking-only messages. */
export function assistantText(messages: readonly MessageLike[], offset = 0): string | undefined {
	if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
	for (const text of aiTextReplies(messages)) if (offset-- === 0) return text;
	return undefined;
}

export interface IndexedReply {
	index: number;
	text: string;
}

/** Inclusive indexes, returned oldest first. Missing replies are never silently omitted. */
export function assistantTextRange(messages: readonly MessageLike[], start: number, end: number): IndexedReply[] {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) {
		throw new Error("Invalid AI reply range; use nonnegative integer indexes with start <= end.");
	}
	const selected: IndexedReply[] = [];
	let index = 0;
	for (const text of aiTextReplies(messages)) {
		if (index >= start) selected.push({ index, text });
		if (index === end) return selected.reverse();
		index++;
	}
	if (!index) throw new Error("No AI text replies are available.");
	throw new Error(`Reply range ${start}-${end} is unavailable. Available AI reply indexes: 0-${index - 1} (0 = latest).`);
}

export interface ReviewComment {
	line: number;
	text: string;
}

function commentTexts(line: string): string[] {
	// Every @@ starts a comment, including inline and repeated markers on one line.
	return line.split("@@").slice(1).map((text) => text.trim()).filter(Boolean);
}

/** Ignore existing markers, including Git diff hunks, rather than resending them. */
export function newComments(original: string, annotated: string): ReviewComment[] {
	if (!annotated.includes("@@")) return [];
	const existing = new Map<string, number>();
	for (const line of original.includes("@@") ? original.split(/\r?\n/) : []) {
		for (const text of commentTexts(line)) existing.set(text, (existing.get(text) ?? 0) + 1);
	}
	const comments: ReviewComment[] = [];
	annotated.split(/\r?\n/).forEach((line, index) => {
		for (const text of commentTexts(line)) {
			const count = existing.get(text) ?? 0;
			if (count > 0) existing.set(text, count - 1);
			else comments.push({ line: index + 1, text });
		}
	});
	return comments;
}

/** Demote every existing marker in a chat review copy, never the stored conversation. */
export function chatHistoryForReview(text: string): string {
	return text.replaceAll("@@", "@ai:");
}

/** Leave one blank line for appending comments in Vim. */
export function reviewDocument(original: string): string {
	return `${original.replace(/\r\n/g, "\n").replace(/\n+$/, "")}\n\n`;
}

function xmlEscape(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function cdata(value: string): string {
	return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

/** Editable collection with independently numbered, safely quoted reply sections. */
export function replyRangeDocument(replies: readonly IndexedReply[]): string {
	return replies.map(({ index, text }) =>
		`<reply index="${index}">${cdata("\n" + text.replace(/\r\n/g, "\n") + "\n")}</reply>`
	).join("\n\n");
}

export type ReviewTag = "reply" | "replies" | "patch" | "file" | "files";

const FILES_REVIEW_INSTRUCTIONS = "Each file review identifies its original source. Inspect and edit those real files as requested, not the temporary annotated copies. Only saved files containing @@ are included.";

const HISTORY_COMMENT_INSTRUCTIONS = "In this review, @ai: marks past comments for context only; @@ marks current comments. Do not treat comments in earlier chat messages as new requests.";

const RANGE_REVIEW_INSTRUCTIONS = "The quoted collection contains numbered <reply> blocks, ordered oldest to newest. Use each block's index and surrounding text to locate my comments.";

const PATCH_REVIEW_INSTRUCTIONS = "The patch is reference only: read its header for the repository and generation command, then inspect and edit the real repository files. Do not edit or apply the review snapshot.";

const FILE_REVIEW_INSTRUCTIONS = "The annotated copy is reference only. Inspect the original file named by the source attribute; if changes are needed, edit that original file, not the review snapshot.";

function openReviewTag(tag: ReviewTag, subject: string, sourceFile?: string): string {
	return `<${tag} subject="${xmlEscape(subject)}"${sourceFile ? ` source="${xmlEscape(sourceFile)}"` : ""}>`;
}

export function reviewPrompt(annotated: string, subject = "your latest response", tag: ReviewTag = "reply", sourceFile?: string): string {
	return [
		"Please address my added @@ comments below; other text is quoted context.",
		...(tag === "reply" || tag === "replies" ? [HISTORY_COMMENT_INSTRUCTIONS] : []),
		...(tag === "patch" ? [PATCH_REVIEW_INSTRUCTIONS] : tag === "file" ? [FILE_REVIEW_INSTRUCTIONS] : tag === "files" ? [FILES_REVIEW_INSTRUCTIONS] : tag === "replies" ? [RANGE_REVIEW_INSTRUCTIONS] : []),
		"",
		`${openReviewTag(tag, subject, sourceFile)}${cdata("\n" + annotated.replace(/(?:\r?\n)+$/, "") + "\n")}</${tag}>`,
	].join("\n");
}

/** Full documents up to 16 KiB (UTF-8) are included inline; larger ones stay on disk. */
export const INLINE_REVIEW_BYTES = 16 * 1024;

export function reviewFilePrompt(filePath: string, commentsPath: string, subject = "your latest response", tag: ReviewTag = "reply", sourceFile?: string): string {
	return [
		"Please address my added @@ comments in the annotated file. Use rg/grep and read surrounding lines as needed, not the whole file.",
		...(tag === "reply" || tag === "replies" ? [HISTORY_COMMENT_INSTRUCTIONS] : []),
		...(tag === "patch" ? [PATCH_REVIEW_INSTRUCTIONS] : tag === "file" ? [FILE_REVIEW_INSTRUCTIONS] : tag === "files" ? [FILES_REVIEW_INSTRUCTIONS] : tag === "replies" ? [RANGE_REVIEW_INSTRUCTIONS] : []),
		"",
		openReviewTag(tag, subject, sourceFile),
		`<annotated_file>${xmlEscape(filePath)}</annotated_file>`,
		`<comments_file>${xmlEscape(commentsPath)}</comments_file>`,
		...(process.platform === "win32" ? [`<command_shell>${commandShell()}</command_shell>`] : []),
		`<search_command>${cdata(formatShellCommand("rg", ["-n", "-F", "--", "@@", filePath]))}</search_command>`,
		`</${tag}>`,
	].join("\n");
}

export function fileReviewSection(source: string, content: string): string {
	return `<file source="${xmlEscape(source)}">${cdata("\n" + content.replace(/(?:\r?\n)+$/, "") + "\n")}</file>`;
}

export function fileWorkspaceReferencePrompt(manifest: string, savedDirectory: string): string {
	return [
		"Please address my @@ comments in these saved file reviews. Read the manifest to map annotated copies to original files.",
		FILES_REVIEW_INSTRUCTIONS,
		"Use rg/grep for @@ and read surrounding lines as needed; do not load every file in full.",
		"", "<files>",
		`<review_manifest>${xmlEscape(manifest)}</review_manifest>`,
		...(process.platform === "win32" ? [`<command_shell>${commandShell()}</command_shell>`] : []),
		`<search_command>${cdata(formatShellCommand("rg", ["-n", "-F", "--", "@@", savedDirectory]))}</search_command>`,
		"</files>",
	].join("\n");
}

export function reviewVimBufferSettings(filetype: "markdown" | "diff" | "auto"): string {
	return `setlocal nomodeline noundofile noswapfile wrap linebreak
${filetype === "auto" ? "filetype on\nfiletype detect" : `setlocal filetype=${filetype}`}
setlocal fileencoding=utf-8 fileformat=unix
set nobackup nowritebackup
set laststatus=2
let &l:statusline = ' /re | Enter: comment below | ,a: inline @@ | save then quit to send %=%l/%L '
syntax match PiReviewComment /@@.*$/
highlight default link PiReviewComment Todo
`;
}

export const REVIEW_VIM_KEYMAPS = `cnoremap <buffer> <expr> <CR> <SID>ReviewCommand()
nnoremap <buffer> ZZ :x<CR>
nnoremap <buffer> ZQ :qall!<CR>
nnoremap <buffer> <CR> o@@<Space>
nnoremap <buffer> ,a A<Space>@@<Space>`;

/** Snapshot every successful write. :w then :q sends the LAST SAVED contents. */
export function reviewVimScript(savedPath: string, filetype: "markdown" | "diff" | "auto" = "markdown"): string {
	return `scriptencoding utf-8
set encoding=utf-8
set nocompatible
let s:saved_cpo = &cpoptions
set cpoptions&vim
let s:saved_file = ${JSON.stringify(savedPath)}
${reviewVimBufferSettings(filetype)}

function! s:Saved() abort
  if writefile(getline(1, '$'), s:saved_file) != 0
    throw 'Could not save review snapshot.'
  endif
endfunction
augroup PiReviewSave
  autocmd!
  autocmd BufWritePost,FileWritePost,FileAppendPost <buffer> call <SID>Saved()
augroup END

function! s:ReviewCommand() abort
  if getcmdtype() ==# ':' && index(['q', 'q!', 'quit', 'quit!', 'qa', 'qa!', 'qall', 'qall!'], trim(getcmdline())) >= 0
    return "\\<C-E>\\<C-U>qall!\\<CR>"
  endif
  return "\\<CR>"
endfunction
${REVIEW_VIM_KEYMAPS}
let &cpoptions = s:saved_cpo
`;
}
