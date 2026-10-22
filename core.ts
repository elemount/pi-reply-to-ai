/** Pure helpers for the /re extension. No Pi runtime imports. */
import { commandShell, formatShellCommand } from "./platform.ts";
export { shellQuote } from "./platform.ts";
export interface MessageLike {
	role: string;
	content?: unknown;
	stopReason?: string;
}

/** Select an AI text reply by recency: 0 = latest. Ignore user/tool/thinking-only messages. */
export function assistantText(messages: readonly MessageLike[], offset = 0): string | undefined {
	if (!Number.isSafeInteger(offset) || offset < 0) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join("")
			.trim();
		if (text && offset-- === 0) return text;
	}
	return undefined;
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
	const existing = new Map<string, number>();
	for (const line of original.split(/\r?\n/)) {
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

export type ReviewTag = "reply" | "patch" | "file";

const PATCH_REVIEW_INSTRUCTIONS = "The patch is reference only: read its header for the repository and generation command, then inspect and edit the real repository files. Do not edit or apply the review snapshot.";

const FILE_REVIEW_INSTRUCTIONS = "The annotated copy is reference only. Inspect the original file named by the source attribute; if changes are needed, edit that original file, not the review snapshot.";

function openReviewTag(tag: ReviewTag, subject: string, sourceFile?: string): string {
	return `<${tag} subject="${xmlEscape(subject)}"${sourceFile ? ` source="${xmlEscape(sourceFile)}"` : ""}>`;
}

export function reviewPrompt(annotated: string, subject = "your latest response", tag: ReviewTag = "reply", sourceFile?: string): string {
	return [
		"Please address my added @@ comments below; other text is quoted context.",
		...(tag === "patch" ? [PATCH_REVIEW_INSTRUCTIONS] : tag === "file" ? [FILE_REVIEW_INSTRUCTIONS] : []),
		"",
		`${openReviewTag(tag, subject, sourceFile)}${cdata("\n" + annotated.replace(/(?:\r?\n)+$/, "") + "\n")}</${tag}>`,
	].join("\n");
}

/** Full documents up to 8 KiB (UTF-8) are included inline; larger ones stay on disk. */
export const INLINE_REVIEW_BYTES = 8 * 1024;

export function reviewFilePrompt(filePath: string, commentsPath: string, subject = "your latest response", tag: ReviewTag = "reply", sourceFile?: string): string {
	return [
		"Please address my added @@ comments in the annotated file. Use rg/grep and read surrounding lines as needed, not the whole file.",
		...(tag === "patch" ? [PATCH_REVIEW_INSTRUCTIONS] : tag === "file" ? [FILE_REVIEW_INSTRUCTIONS] : []),
		"",
		openReviewTag(tag, subject, sourceFile),
		`<annotated_file>${xmlEscape(filePath)}</annotated_file>`,
		`<comments_file>${xmlEscape(commentsPath)}</comments_file>`,
		...(process.platform === "win32" ? [`<command_shell>${commandShell()}</command_shell>`] : []),
		`<search_command>${cdata(formatShellCommand("rg", ["-n", "-F", "--", "@@", filePath]))}</search_command>`,
		`</${tag}>`,
	].join("\n");
}

/** Snapshot every successful write. :w then :q sends the LAST SAVED contents. */
export function reviewVimScript(savedPath: string, filetype: "markdown" | "diff" | "auto" = "markdown"): string {
	return `scriptencoding utf-8
set encoding=utf-8
set nocompatible
let s:saved_cpo = &cpoptions
set cpoptions&vim
let s:saved_file = ${JSON.stringify(savedPath)}
setlocal nomodeline noundofile noswapfile wrap linebreak
${filetype === "auto" ? "filetype on\nfiletype detect" : `setlocal filetype=${filetype}`}
setlocal fileencoding=utf-8 fileformat=unix
set nobackup nowritebackup
set laststatus=2
let &l:statusline = ' /re | Enter: comment below | ,a: inline @@ | save then quit to send %=%l/%L '
syntax match PiReviewComment /@@.*$/
highlight default link PiReviewComment Todo

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
cnoremap <buffer> <expr> <CR> <SID>ReviewCommand()
nnoremap <buffer> ZZ :x<CR>
nnoremap <buffer> ZQ :qall!<CR>
nnoremap <buffer> <CR> o@@<Space>
nnoremap <buffer> ,a A<Space>@@<Space>
let &cpoptions = s:saved_cpo
`;
}
