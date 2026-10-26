import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileSources } from "../file-workspace.ts";
import { gitComparison } from "../git.ts";
import { createGitWorkspace } from "../git-workspace.ts";
import { hasDiffview, hasNeovim, luaSaveComment, neovimReview } from "./fixtures/neovim.mjs";
import { withRepository } from "./fixtures/repository.mjs";
const options = { skip: !hasNeovim };
const gitOptions = { skip: !hasNeovim || !hasDiffview };
const document = { title: "Reply review", sources: [{ id: 0, reply: 0, label: "AI reply 0", content: "first\nsecond\n#REPLY: historical\nlast" }] };

test("real Neovim anchors explicit comments as extmarks without modifying original reply text", options, async () => {
	const comments = await neovimReview(document, `
local review = require('pi_review')
local source = vim.api.nvim_get_current_buf()
assert(vim.bo.modifiable == false and vim.bo.readonly)
assert(vim.bo.buftype == 'nofile')
assert(#review.comments == 0)
local original = vim.api.nvim_buf_get_lines(source, 0, -1, false)
vim.api.nvim_win_set_cursor(0, {2, 0})
review.comment(false)
${luaSaveComment("请改第二行")}
assert(vim.api.nvim_get_current_buf() == source)
assert(vim.deep_equal(vim.api.nvim_buf_get_lines(source, 0, -1, false), original))
local marks = vim.api.nvim_buf_get_extmarks(source, review.namespace, 0, -1, { details = true })
assert(#marks == 1 and marks[1][2] == 1 and #marks[1][4].virt_lines == 1)
assert(marks[1][4].virt_lines[1][1][1]:find('#REPLY:', 1, true))
review.submit()
`);
	assert.equal(comments.length, 1); assert.equal(comments[0].line, 2); assert.equal(comments[0].text, "请改第二行");
	assert.match(comments[0].context, /2: second/); assert.match(comments[0].context, /#REPLY: historical/);
});
test("visual line ranges, multiline comments, editing and deletion operate on sidecar data only", options, async () => {
	const comments = await neovimReview(document, `
local r = require('pi_review')
vim.api.nvim_win_set_cursor(0, {1,0})
vim.cmd('normal! Vj')
r.comment(true)
local input = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(input, 0, -1, false, {'range comment', 'second paragraph'})
vim.cmd('stopinsert')
vim.fn.maparg('<C-CR>','n',false,true).callback()
assert(r.comments[1].line == 1 and r.comments[1].endLine == 2)
vim.api.nvim_win_set_cursor(0, {2,0})
r.comment(false)
${luaSaveComment("edited range comment")}
assert(#r.comments == 1 and r.comments[1].endLine == 2)
r.comment(false)
${luaSaveComment("")}
assert(#r.comments == 0)
vim.api.nvim_win_set_cursor(0, {4,0})
r.comment(false)
${luaSaveComment("last line")}
r.submit()
`);
	assert.equal(comments.length, 1); assert.equal(comments[0].line, 4); assert.equal(comments[0].text, "last line");
});
test("ordinary quit delivers saved comments; explicit cancellation discards them", options, async () => {
	const comments = await neovimReview(document, `local r=require('pi_review'); r.comment(false)\n${luaSaveComment("saved and sent on exit")}\nvim.cmd('qall')`);
	assert.equal(comments[0].text, 'saved and sent on exit');
	assert.equal(await neovimReview(document, `local r=require('pi_review'); r.comment(false)\n${luaSaveComment("saved but discarded")}\nvim.cmd('ReCancel')`), undefined);
	assert.equal(await neovimReview(document, "vim.cmd('ReCancel')"), undefined);
	assert.equal(await neovimReview(document, "vim.cmd('qall')"), undefined);
	assert.deepEqual(await neovimReview(document, "require('pi_review').submit()"), []);
});
test("a cancelled split edit does not create a comment", options, async () => {
	assert.deepEqual(await neovimReview(document, `
local r = require('pi_review')
r.comment(false)
vim.cmd('stopinsert')
local mapping = vim.fn.maparg('<C-q>', 'n', false, true)
mapping.callback()
assert(#r.comments == 0)
r.submit()
`), []);
});
test("explicit files open as protected buffers with no swap, backup, annotated copy or source writes", options, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-nvim-files-"));
	try {
		writeFileSync(join(cwd, "one.ts"), "const one = 1;\n// vim: set modifiable:\n"); writeFileSync(join(cwd, "two.py"), "two = 2\n");
		const { sources } = await fileSources(["one.ts", "two.py"], cwd);
		const comments = await neovimReview({ title: "Files", sources }, `
local r=require('pi_review')
assert(vim.bo.modifiable == false and not vim.bo.modeline and not vim.bo.swapfile)
assert(vim.bo.filetype == 'typescript' and vim.bo.syntax == 'typescript')
local ok = pcall(vim.cmd, 'write!')
assert(not ok)
r.comment(false)
${luaSaveComment("first file")}
vim.cmd('bnext')
assert(vim.bo.filetype == 'python' and vim.bo.readonly)
r.comment(false)
${luaSaveComment("second file")}
vim.cmd('bprevious')
assert(#vim.api.nvim_buf_get_extmarks(0, r.namespace, 0, -1, {}) == 1)
r.submit()
`, { cwd });
		assert.equal(comments.length, 2); assert.match(readFileSync(join(cwd, "one.ts"), "utf8"), /^const one = 1;/);
		assert.deepEqual(readdirSync(cwd).sort(), ["one.ts", "two.py"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("directory tree opens files lazily and restores comment previews after buffer recreation", options, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-nvim-tree-"));
	try {
		mkdirSync(join(cwd, "nested")); writeFileSync(join(cwd, "nested/a.ts"), "a\n"); writeFileSync(join(cwd, "b.ts"), "b\n");
		const { sources } = await fileSources(["."], cwd);
		const id = sources.find(source => source.label === "nested/a.ts").id;
		const comments = await neovimReview({ title: "Directory", sources }, `
local r=require('pi_review')
assert(vim.api.nvim_buf_get_name(0) == 'pi-review://files')
for _, buf in ipairs(vim.api.nvim_list_bufs()) do assert(vim.b[buf].pi_review_source == nil) end
r.open(${id})
r.comment(false)
${luaSaveComment("lazy comment")}
local old = vim.api.nvim_get_current_buf()
r.tree()
-- An external edit must not shift an already-reviewed source on buffer recreation.
local file=assert(io.open(r.sources[${id}].path, 'wb')); file:write('changed externally\\n'); file:close()
vim.api.nvim_buf_delete(old, {force=true})
r.open(${id})
assert(vim.api.nvim_buf_get_lines(0, 0, 1, false)[1] == 'a')
assert(#vim.api.nvim_buf_get_extmarks(0, r.namespace, 0, -1, {}) == 1)
r.submit()
`, { cwd, tree: true });
		assert.equal(comments[0].source, id); assert.equal(comments[0].text, "lazy comment");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("real pinned Diffview maps both revision sides to sources and keeps comments across file switches", gitOptions, async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("a file.txt", "old one\nold two\n"); write("b.txt", "before\n"); commit();
		write("a file.txt", "new one\nnew two\n"); write("b.txt", "after\n"); commit();
		const status = git("status", "--porcelain"), index = readFileSync(join(cwd, ".git", "index"));
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "commit", revision: "HEAD" }));
		try {
			const comments = await neovimReview({ title: "Git", sources: workspace.sources }, `
local r = require('pi_review')
assert(vim.wait(15000, function()
  local count=0
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    if vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source ~= nil then count=count+1 end
  end
  return count >= 2
end, 20), 'Diffview did not attach both revision buffers')
local old_win, new_win
for _,win in ipairs(vim.api.nvim_list_wins()) do
  local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
  if id ~= nil and r.sources[id].gitPath == 'a file.txt' then
    if r.sources[id].side == 'old' then old_win=win else new_win=win end
  end
end
assert(old_win and new_win, 'Could not identify old/new source side')
vim.api.nvim_set_current_win(old_win)
assert(vim.bo.readonly and not vim.bo.modifiable and vim.bo.syntax == 'OFF')
assert(vim.wo.winhighlight:find('DiffviewDiffAdd:Normal', 1, true))
assert(vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] == nil)
r.comment(false)
${luaSaveComment("old-side comment")}
vim.api.nvim_set_current_win(new_win)
r.comment(false)
${luaSaveComment("new-side comment")}
local old_id=r.comments[1].source
require('diffview.actions').select_next_entry()
assert(vim.wait(10000, function()
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
    if id ~= nil and r.sources[id].gitPath == 'b.txt' then return true end
  end
end,20))
for _,buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.b[buf].pi_review_source == old_id then vim.api.nvim_buf_delete(buf, {force=true}) end
end
require('diffview.actions').select_prev_entry()
assert(vim.wait(10000, function()
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    local buf=vim.api.nvim_win_get_buf(win)
    if vim.b[buf].pi_review_source == old_id then return #vim.api.nvim_buf_get_extmarks(buf, r.namespace, 0, -1, {}) == 1 end
  end
end,20))
-- No mutating default actions survive in the panel configuration.
local maps=require('diffview.config').get_config().keymaps.file_panel
for _,map in ipairs(maps) do assert(map[2] ~= 's' and map[2] ~= 'X' and map[2] ~= '-') end
r.submit()
`, { cwd, view: workspace });
			assert.equal(comments.length, 2);
			assert.equal(workspace.sources[comments[0].source].side, "old"); assert.equal(workspace.sources[comments[1].source].side, "new");
			assert.match(comments[0].context, /old one/); assert.match(comments[1].context, /new one/);
			assert.equal(git("status", "--porcelain"), status); assert.deepEqual(readFileSync(join(cwd, ".git", "index")), index);
		} finally { await workspace.cleanup(); }
	});
});
test("root additions and deletions in Diffview expose only the real source side, not null buffers", gitOptions, async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("root.txt", "root\n"); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "commit", revision: "HEAD" }));
		try {
			const comments = await neovimReview({ title: "Root", sources: workspace.sources }, `
local r = require('pi_review')
assert(vim.wait(15000, function()
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    local id = vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
    if id ~= nil then vim.api.nvim_set_current_win(win); return true end
  end
end, 20))
assert(r.sources[vim.b.pi_review_source].side == 'new')
r.comment(false)
${luaSaveComment("root comment")}
r.submit()
`, { cwd, view: workspace });
			assert.equal(comments.length, 1);
		} finally { await workspace.cleanup(); }
	});
});
