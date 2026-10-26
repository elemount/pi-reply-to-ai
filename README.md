# pi-reply-to-ai

A personal [Pi](https://pi.dev) extension for reviewing AI replies, files,
directories, and Git changes in **Neovim**. Browse read-only sources, attach
comments to lines or ranges, then send one concise review back to the AI.

## Install

```sh
pi install git:github.com/elemount/pi-reply-to-ai
```

Requirements: Node.js >= 22.19, **Neovim >= 0.10**, and Git >= 2.31.
Set `PI_REVIEW_EDITOR` to a native Neovim executable path if `nvim` is not on PATH.
Arguments, shell wrappers, and Vim are not supported. In WSL, install Linux Neovim
inside WSL and use Linux paths (`/mnt/c/...` for Windows files).

Reviews start Neovim normally with **your configuration, plugins, theme, and
keymaps**, then load the review runtime. No `--clean`, replacement `init.lua`, or
reset of global options. Filetype plugins, indentation, syntax and Tree-sitter
follow your configuration. Only review-owned buffers get read-only/file-write
protections. Existing Pi sessions need `/reload` after extension updates.

For Git reviews, run **`/re setup` once** to install Diffview at the tested commit
`4516612fe98ff56ae0415a259ff6361a89419b0a`. This explicit setup downloads it into
`$XDG_CACHE_HOME/pi-reply-to-ai` (normally `~/.cache/pi-reply-to-ai`); normal reviews
never download or update anything. Alternatively set `PI_REVIEW_DIFFVIEW` to your
own checkout at that exact commit. An already loaded Diffview is kept rather than
replaced, and must also be pinned to this commit. Files, directories, and replies
need no Diffview.

## Commands

| Command | Review |
| --- | --- |
| `/re` or `/re 0` | Latest AI text reply |
| `/re 2` or `/re message 2` | Third newest AI text reply |
| `/re 0-4` or `/re message 0-4` | Five replies, oldest first |
| `/re @src/main.ts` | A file |
| `/re @"file with spaces.ts" @README.md` | Multiple files |
| `/re @src` | A directory, with a lazy file tree |
| `/re c [revision]` | A commit versus its first parent (empty tree for a root commit) |
| `/re p [base]` | PR changes: merge base through the captured HEAD |
| `/re d` | Tracked working changes: HEAD through staged + unstaged content |
| `/re help` | Usage |
| `/re setup` | Explicit one-time Diffview installation (network required) |

Long aliases: `commit`, `pr`, `diff`. **Ctrl+Alt+R** reviews the latest AI reply.
Reply indexes count assistant text only, not user/tool/thinking-only messages;
missing range indexes are errors rather than silently omitted replies. Home-relative,
absolute, quoted, and literal paths are supported without shell expansion.

## In Neovim

- **Enter** on a source line opens a small, ordinary **horizontal split
  below that pane** to add or edit a comment. No floating window or inserted source lines.
- **Visual selection + Enter**: comment on an inclusive line range.
- In the comment split, **Ctrl+Enter** or **`:wq`** saves and closes; **`:w`** saves
  without closing. **Enter** and **Esc** keep normal Vim behavior: newline in
  Insert mode and return to Normal mode, without saving or closing the split.
- **`:q!` / Ctrl+Q** discards unsaved edits, preserving any previously saved
  version. Clear an existing comment and save to delete it.
- **Normal Neovim exit** (e.g. **`:qa`**) sends all saved comments. **`:ReSubmit`**
  explicitly finishes the same way; **`:ReCancel`** discards the entire review.
  An abnormal editor exit sends nothing.
- Files/replies are normal listed buffers: use your buffer picker, **`:bnext`** /
  **`:bprevious`**, or **`:ls`**. There are no review-specific navigation keys.
- For directories, **`:ReTree`** returns to the file tree; **Enter** expands a
  folder or opens a file lazily. This is not a comment sidebar.
- Git navigation, layout, file panel, and hooks follow your Diffview configuration.
  Defaults include **Tab / Shift+Tab** for files and native **`]c` / `[c`** for
  hunks; **`:DiffviewFocusFiles`** opens the file panel. Both sides accept comments.
  Diff text and comment previews are uncolored without changing your global theme.

Saved comments appear as virtual-line previews below read-only source lines; they
never become part of the diff. Comment state survives file switches and buffer
recreation. The comment split is not diff/scroll/cursor-bound to Diffview's panes.
Only **Enter** in sources and **Ctrl+Enter / Ctrl+Q** in the comment split get
review mappings. Inside the comment split, **Enter / Esc / Shift+Enter** keep
native behavior. Global mappings, including **ZZ / ZQ**, are left alone. File
trees and Diffview's file panel keep their own Enter navigation.

Saving a comment checkpoints the review privately; Pi sends it when Neovim exits
successfully, not after every individual edit. Unsaved drafts are never included.
Close/save the comment split before `:ReSubmit`. Other modified normal buffers
must also be saved or discarded; submission does not force-quit them. A review
with no saved comments sends nothing.

Your terminal must send a distinct **Ctrl+Enter** key for that shortcut to work.
No special keyboard protocol is needed for **`:ReComment`** to open a comment,
**`:1,5ReComment`** (or a Visual selection followed by `:ReComment`) to select a
range, and **`:wq`** to save and close.

### What the AI receives

Simple Markdown: source path, line/range, old/new side and fixed revision where
applicable, a short numbered excerpt, and your comment. No full annotated file or
diff copies, no thread database, and no public JSON schema. Selected AI replies
are quoted in full, since conversation compaction can otherwise remove them.
Fences safely quote Markdown tables, code fences, XML, and arbitrary comment text.

The **complete exported Markdown** is sent directly when it is at most
**16 KiB (16,384 UTF-8 bytes)**. Only larger reviews retain a private `review.md`
and send a reference. Temporary editor data and Git metadata are cleaned up;
large retained review documents are deliberately left for the AI to read.

`#REPLY:` is only a label in the export. Literal `#REPLY:`, `@@`, or `??` in sources
never creates a comment. Historical replies are preserved verbatim as quoted context.

## Git base selection (offline)

PR reviews choose a base in this order:

1. Explicit `/re pr <base>`.
2. `branch.<current>.gh-merge-base`.
3. `branch.<current>.vscode-merge-base`.
4. Unambiguous ancestry inference from local and remote-tracking refs.
5. Repository default: `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master`.

A configured but unavailable base is an error. Inference groups aliases, excludes
the current branch and its own tracking refs, and compares ancestry rather than
commit timestamps. Ambiguous parents or more than 256 candidates require an
explicit base. Detached HEAD uses the default unless a base is specified.
No automatic fetch or GitHub query is performed. Partial/promisor clones are
rejected to prevent Git from lazily fetching missing objects. Base-selection
provenance and fixed comparison revisions are included in the review.

For a stable stacked-PR target:

```sh
git config branch.my-feature.gh-merge-base origin/parent-feature
```

Diffview runs against **private Git metadata**, reading existing objects via
alternates. It does not use or modify the real index. Working content is frozen
into private blobs before browsing; later edits cannot shift those review anchors.
These working snapshots are temporary, not durable revisions: their comments carry
original excerpts and tell the AI to inspect the current real files. Untracked
files are excluded from `/re d`; review them explicitly with `@file` if needed.
Built-in stage, unstage, discard, merge, and editable-file actions are filtered
from the review's Diffview mappings; navigation and other user mappings are kept.

## Safety and limits

- Interactive Pi TUI only; busy/queued tasks and duplicate launches are blocked.
  If the session, conversation branch, or task changes, the finished review is
  kept as an input draft instead of sent into the wrong context.
- Files are frozen in memory on their first open, including when a buffer is
  recreated. Unopened directory files are read and revalidated only when selected.
- Review source buffers cannot be edited or saved and disable modelines, swap,
  and persistent undo locally; no editable source/diff copies or resident server.
  Your startup scripts and plugins run normally, and unrelated buffers are not
  protected. This prevents accidental review writes, not deliberate commands or
  actions performed by your own plugins; Neovim is not a sandbox.
- Up to 64 input references, 2,000 files, 32 MiB per file, and 64 MiB opened file
  content per review (both Git sides count). Only regular UTF-8 text is reviewable.
- Directory discovery respects Git ignore rules and filters dependency/cache,
  credential, and sensitive paths. Symlinks and escaping paths are skipped;
  explicit file symlinks resolve to their actual source. Every initial lazy read
  revalidates the source. Explicit references can intentionally select otherwise filtered files.
- Ordinary directories do not need a repository; scanning uses private metadata
  and never creates a source `.git`. Directory probing uses eight bounded workers.

## Development

```sh
npm test
git diff --check
pi --no-extensions --extension ./index.ts
```

The isolated development command avoids loading an older installed `/re` alongside
this checkout. Neovim integration tests run when Neovim >= 0.10 is available; set
`PI_REVIEW_REQUIRE_NVIM=1` to make its absence an error (as CI does).
Git UI tests also require the pinned Diffview checkout; `/re setup` installs it.
`/reload` reloads the currently configured extension source; it does **not** switch
an installed Git package to this development checkout. To try the checkout from
another directory, use `pi --no-extensions -e /absolute/path/to/pi-reply-to-ai/index.ts`
(add `--continue` to resume that directory's session).
CI tests Neovim 0.10 with the pinned dependency. No npm runtime dependencies or
publication are required.

[Diffview](https://github.com/sindrets/diffview.nvim) is a separately installed
GPL-3.0-or-later dependency, not vendored or relicensed by this repository. Its
upstream checkout retains its license and source. The integration uses its
`setup`/`open` entry points, documented hooks and actions. Because hooks expose the
layout side but not a path, a small adapter matches the pinned revision-buffer
names against the source allowlist; real Neovim tests cover this boundary. Test
it before updating the pin. Annotation state and Markdown export do not depend
on Diffview objects.

### Migration from 0.6

This is a Neovim-only replacement, not a compatibility layer. Editable private
copies, marker scanning, Vim scripts, and `comments.json` / `reviews.json` exports
have been removed. Your normal Neovim configuration is loaded. Use Enter or
`:ReComment` to open an ordinary comment split, then Ctrl+Enter or `:wq` to save
and close. Enter/Esc remain native Vim keys inside the comment split; normal
Neovim exit sends the saved review. Use `:ReCancel` to discard it. ZZ/ZQ and navigation keys are not rebound.
The `/re` target commands and Pi shortcut remain the same.
