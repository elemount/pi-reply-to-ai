# reply-to-ai

Annotate an AI reply, a private copy of a file, or a Git patch in **vim**. Save, then quit to send your comments back to the AI.

Personal Pi extension by [elemount](https://github.com/elemount). Hosted in a public GitHub repository for direct installation; not published to npm or submitted to the Pi community/gallery. The package is marked `private` to prevent accidental npm publishing and does not use the gallery-discovery keyword.

## Install

Requires Pi, Git, and Vim on macOS or Linux. No build step or runtime npm dependencies.

```bash
pi install git:github.com/elemount/reply-to-ai
```

In an existing Pi session:

```text
/reload
/re
```

Press **Ctrl+Alt+R** in Pi to review the latest AI reply immediately (the same as `/re` or `/re 0`). The shortcut shares the command's busy checks, editor, save/cancel behavior, and duplicate-launch guard. Your terminal must pass the key combination through to Pi.

The extension is named `reply-to-ai`; its command remains `/re`. Keep using `/re` arguments to select earlier replies, files, and Git patches. It requires interactive terminal mode and an idle agent with no queued messages.

If you previously copied this extension into `~/.pi/agent/extensions/reply-to-ai`, move that manual copy outside the `extensions` directory before reloading. Otherwise the manual and package-installed copies will both load.

## Update or remove

Update this extension, then run `/reload` in Pi:

```bash
pi update git:github.com/elemount/reply-to-ai
```

Remove it:

```bash
pi remove git:github.com/elemount/reply-to-ai
```

Run `/reload` after removal as well. `pi list` shows your configured packages.

## Local development

```bash
gh repo clone elemount/reply-to-ai ~/src/reply-to-ai
cd ~/src/reply-to-ai
npm test
pi --no-extensions -e ./index.ts
```

To persistently use a working clone instead of the Git-managed installation, remove the Git package first and run `pi install ~/src/reply-to-ai`. Do not install both copies at once. Pi supplies the host API, which is declared as an optional peer dependency rather than bundled. No `npm install` is needed to run the tests.

## Targets

| Command | Opens |
| --- | --- |
| `/re`, `/re 0`, or `/re message` | Latest AI text reply (the default) |
| `/re 1` | Previous AI text reply |
| `/re N` or `/re message N` | AI text reply N positions back, with 0 = latest |
| `/re @src/main.ts` | A private copy of a file, leaving the original untouched while annotating |
| `/re @"path with spaces.md"` | Same, using Pi's quoted file-reference format |
| `/re commit` or `/re c` | Latest commit (`HEAD`), compared with its first parent |
| `/re c HEAD~1` | Previous commit; any valid commit revision is accepted |
| `/re pr` or `/re p` | All committed changes from the PR base's merge base to `HEAD` |
| `/re p origin/main` | Same, with an explicit base branch or commit |
| `/re diff` or `/re d` | Staged and unstaged changes together, compared with `HEAD` |
| `/re help` | Usage |

Message indexes count **AI text replies only**, newest first, in the active session context. User messages, tool results, and thinking/tool-only assistant messages do not count. Indexes must be nonnegative integers; unavailable indexes report a message rather than silently opening a different reply. Replies no longer present after compaction are unavailable.

The long Git command names remain valid; `c`, `p`, and `d` are aliases for `commit`, `pr`, and `diff`.

For PRs, the extension tries the local `origin/HEAD` reference first, then `origin/main`, `origin/master`, `main`, and `master`. It never fetches or queries GitHub. For a different PR target branch, pass the base explicitly. The diff is `git diff $(git merge-base BASE HEAD) HEAD`, not a direct comparison with the latest base-branch tip.

### File references

Use Pi's `@` file picker or type a path after `/re @`. Paths can be relative to the working directory, absolute, or start with `~/`. Quote paths with spaces, e.g. `/re @"docs/design notes.md"`. One command reviews one file; the entire text after `@` is treated as the path, with no shell expansion.

The extension reads a regular UTF-8 text file and opens a private temporary copy. The original is never opened for writing by the extension, including on save, cancellation, or editor failure. Empty files and read-only sources are supported. Directories, binary/non-UTF-8 files, and files over 32 MiB are rejected. Symlinks resolve to the actual source path.

The copy preserves a normal filename extension so Vim can detect its filetype (otherwise `.txt` is used). The AI prompt identifies the original via `<file source="/absolute/source/path">`; the annotated copy is reference material. The AI is told to inspect the original and make requested changes there, not in the review snapshot. Small copies are sent inline; large copies follow the same 8 KiB rule as other targets.

### What is the merge base?

The merge base is the best common ancestor of two commits, usually the point where the branches split:

```text
A---B---C---D  main
     \
      E---F    feature
```

Here `B` is the merge base. A PR review compares `B` with `F`, showing the feature branch's net changes without treating unrelated changes in `C` and `D` as part of the PR. If the base branch has been merged into the feature branch, the merge base can move forward.

Commit and PR reviews exclude uncommitted changes. Root commits are compared with the empty tree; merge commits with their first parent. `/re diff` excludes untracked files and requires an existing `HEAD`.

Git patches open as `.diff` snapshots with diff highlighting and repository/commit metadata. The header includes `# Generated with:` followed by the Git command that produced the patch, including the repository path, resolved commit hashes, and diff options. PR snapshots also record `# Merge-base command:`. These commands describe the saved snapshot; working-tree output can change as files are edited.

Both inline and large-file patch prompts explicitly instruct the AI to read the header, inspect the current repository files, and implement comments in those real files. **The review snapshot is reference material, not an edit target; the AI must not edit or apply it.**

Existing diff hunk headers are not counted as new comments. Generating or saving a review does not check out a branch, change the index, or apply the patch. External diff/textconv programs are disabled. Git commands have a 30-second timeout and a 32 MiB output limit; empty diffs do not open vim.

## Comments

Use **`@@` only** to mark comments, anywhere including inline. The document opens with one blank line at the end for appending comments.

```markdown
An original paragraph. @@ Add an example.
@@ Explain the edge cases.
Original text @@ First comment @@ Second comment
```

A comment ends at the next `@@` marker or the end of its line. Empty comments and unchanged markers from the original document do not count as new comments. User-authored text can be in any language; plugin messages and prompts are in English.

### Review-buffer shortcuts

In Normal mode:

| Key | Action |
| --- | --- |
| **Enter** | Open a new line below, insert `@@ `, and enter Insert mode |
| **`,a`** | Append ` @@ ` to the current line and enter Insert mode |

These bindings apply only to the temporary review buffer (replies, files, and patches). Other buffers, Insert-mode Enter, and your vimrc are unchanged. Starting a comment does not save or send it; save and quit when ready.

## Save and quit

- Any successful write marks the review for sending **after vim exits**.
- `:wq`, `:w` then `:q`, and `:w` then `:q!` all send the **last saved version**.
- Changes made after the last save are not sent unless saved again.
- Quit without ever saving to cancel. In this review buffer, `:q` discards unsaved edits without a confirmation prompt.
- No new comments means no message, even after saving.
- An abnormal editor exit sends nothing and restores Pi's UI.

Writes are tracked using Vim events, so mappings and commands such as `:wall` and `:execute 'write'` also work. Your vimrc is not modified.

## Message size

The limit is **8 KiB of UTF-8 document bytes**, including trailing blank lines.

- **Up to 8 KiB:** one short English instruction followed by the annotated document inside XML-style tags. No separate comment index or repeated comment list.
- **Over 8 KiB:** a short XML-style prompt references `review.md` (or `review.diff` for patches, or the preserved extension for files) and `comments.json`, asking the AI to use `rg`/`grep` and read surrounding lines as needed. The JSON index identifies new comments; neither the large document nor its comments are embedded in the prompt.

The outer tag identifies the source: `<reply>` for AI replies, `<patch>` for generated Git patches, or `<file source="...">` for file references. Annotated text goes directly inside it, without an extra wrapper:

```xml
<reply subject="AI response 1 (0 = latest)"><![CDATA[
Original reply. @@ Add an example.
]]></reply>
```

CDATA preserves code, XML tags, and arbitrary user text without confusing boundaries. Literal `]]>` sequences are safely split across CDATA sections. Large-file prompts keep the same `<reply>`, `<patch>`, or `<file>` outer tag and use `<annotated_file>`, `<comments_file>`, and `<search_command>` elements instead. `<annotated_file>` is the saved source text with your comments, not a code file the AI should edit directly.

Small, cancelled, and comment-free reviews are cleaned up. Large files referenced by a message or draft remain in a private system temporary directory named `pi-review-*` (directory mode `0700`, file mode `0600`). Delete them when no longer needed; system temporary-file cleanup may also remove them. Reloading the extension does not delete referenced files.

## Editor

Only **vim** is selected by default. To specify its executable path, without arguments:

```bash
PI_REVIEW_EDITOR=/usr/bin/vim pi
```

Your Vim configuration is retained. Modelines, swap, persistent undo, and backup files are disabled for the review. This is independent of Pi's `externalEditor` setting and Ctrl+G.

## Tests

```bash
npm test
```

Requires Node.js 22.19+ for native TypeScript type stripping and Git for local-repository tests. Real Vim tests are skipped if Vim is unavailable. Git tests use disposable local repositories and never contact a remote.
