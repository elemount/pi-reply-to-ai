import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { gitComparison } from "../git.ts";
import { createGitWorkspace } from "../git-workspace.ts";
import { hasDiffview, hasNeovim, luaSaveComment, neovimReview } from "./fixtures/neovim.mjs";
import { withRepository } from "./fixtures/repository.mjs";
const options = { skip: !hasNeovim };
const document = { title: "Reply", sources: [{ id: 0, reply: 0, label: "reply", content: "original one\noriginal two" }] };

test("Enter opens comments while comment Enter/Esc stay native and Ctrl-Enter/:wq save", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
local source, origin=vim.api.nvim_get_current_buf(),vim.api.nvim_get_current_win()
local count=#vim.api.nvim_list_wins()
local original=vim.api.nvim_buf_get_lines(source,0,-1,false)
local input
vim.api.nvim_win_set_cursor(0,{2,0})
local steps={
  function() vim.api.nvim_input('<CR>') end,
  function()
    assert(vim.fn.mode()=='i', 'Comment did not start in insert mode: '..vim.fn.mode())
    assert(#vim.api.nvim_list_wins()==count+1)
    assert(vim.api.nvim_win_get_config(0).relative=='')
    input=vim.api.nvim_get_current_buf()
    assert(input~=source)
    assert(not vim.wo.diff and not vim.wo.scrollbind and not vim.wo.cursorbind)
    assert(vim.bo[source].readonly and not vim.bo[source].modifiable)
    vim.api.nvim_input('first<CR>second<Esc>')
  end,
  function()
    assert(vim.fn.mode()=='n' and vim.api.nvim_get_current_buf()==input)
    assert(#r.comments==0, 'Enter/Esc saved an uncommitted draft')
    assert(vim.deep_equal(vim.api.nvim_buf_get_lines(input,0,-1,false),{'first','second'}))
    vim.api.nvim_input('<C-CR>')
  end,
  function()
    assert(vim.api.nvim_get_current_win()==origin and #vim.api.nvim_list_wins()==count)
    assert(r.comments[1].text=='first\\nsecond' and r.comments[1].line==2)
    vim.api.nvim_input('<CR>')
  end,
  function() vim.api.nvim_input('discard this<C-q>') end,
  function()
    assert(vim.api.nvim_get_current_win()==origin and r.comments[1].text=='first\\nsecond')
    vim.api.nvim_input('<CR>')
  end,
  function() vim.api.nvim_input('discard with command<Esc>:q!<CR>') end,
  function()
    assert(vim.api.nvim_get_current_win()==origin and r.comments[1].text=='first\\nsecond')
    vim.api.nvim_input('<CR>')
  end,
  function() vim.api.nvim_input('prefix <C-CR>') end,
  function()
    assert(vim.api.nvim_get_current_win()==origin and r.comments[1].text=='prefix first\\nsecond')
    vim.api.nvim_input('<CR>')
  end,
  function() vim.api.nvim_input('<Esc>gg0cwfinal<Esc>:wq<CR>') end,
  function()
    assert(vim.api.nvim_get_current_win()==origin and #vim.api.nvim_list_wins()==count)
    assert(r.comments[1].text=='final first\\nsecond', vim.inspect(r.comments))
    assert(vim.deep_equal(vim.api.nvim_buf_get_lines(source,0,-1,false),original))
    vim.cmd('qall')
  end,
}
local index=0
local function advance()
  index=index+1
  local ok,err=pcall(steps[index])
  if not ok then io.stderr:write('Key step '..index..': '..tostring(err)); vim.cmd('cquit 3'); return end
  if index<#steps then vim.defer_fn(advance,50) end
end
advance()
`);
	assert.equal(comments[0].text, "final first\nsecond");
});

test("ReComment opens line/range comments without a modified-key terminal protocol", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
vim.cmd('1,2ReComment')
vim.api.nvim_buf_set_lines(0,0,-1,false,{'range using native commands'})
vim.cmd('stopinsert'); vim.cmd('wq')
assert(r.comments[1].line==1 and r.comments[1].endLine==2)
vim.cmd('ReComment')
vim.api.nvim_buf_set_lines(0,0,-1,false,{'edited range'})
vim.cmd('stopinsert'); vim.cmd('wq')
assert(#r.comments==1 and r.comments[1].endLine==2)
vim.cmd('qall')
`);
	assert.equal(comments[0].text, 'edited range');
});

test("normal exit sends only checkpointed comments, never the currently unsaved split draft", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
r.comment(false)
${luaSaveComment('saved version')}
r.comment(false)
vim.api.nvim_buf_set_lines(0,0,-1,false,{'unsaved replacement must not leak'})
vim.cmd('stopinsert')
vim.cmd('qall!')
`);
	assert.equal(comments[0].text, "saved version");
	assert.equal(await neovimReview(document, `
require('pi_review').comment(false)
vim.api.nvim_buf_set_lines(0,0,-1,false,{'new unsaved draft'})
vim.cmd('stopinsert'); vim.cmd('qall!')
`), undefined);
});

test("failed checkpoint replacement keeps the split draft open and the previously saved review intact", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
r.comment(false)
${luaSaveComment('previously saved')}
r.comment(false)
local input=vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(input,0,-1,false,{'failed replacement'})
local rename=vim.uv.fs_rename
vim.uv.fs_rename=function() return nil,'simulated rename failure' end
vim.cmd('stopinsert')
vim.fn.maparg('<C-CR>','n',false,true).callback()
vim.uv.fs_rename=rename
assert(vim.api.nvim_get_current_buf()==input and vim.bo.modified)
assert(r.comments[1].text=='previously saved')
local manifest=vim.json.decode(table.concat(vim.fn.readfile(vim.env.PI_REVIEW_MANIFEST),'\\n'))
assert(vim.uv.fs_stat(manifest.result).mode % 512 == 384)
assert(not vim.uv.fs_stat(manifest.result..'.partial'))
assert(vim.json.decode(table.concat(vim.fn.readfile(manifest.result),'\\n'))[1].text=='previously saved')
vim.fn.maparg('<C-q>','n',false,true).callback()
vim.cmd('qall')
`);
	assert.equal(comments[0].text, "previously saved");
});

test("failed native write-quit keeps the draft window and the previous saved review", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
r.comment(false)
${luaSaveComment('saved before failed wq')}
r.comment(false)
local input,win=vim.api.nvim_get_current_buf(),vim.api.nvim_get_current_win()
vim.api.nvim_buf_set_lines(input,0,-1,false,{'draft from failed wq'})
vim.cmd('stopinsert')
local rename=vim.uv.fs_rename
vim.uv.fs_rename=function() return nil,'simulated native write failure' end
pcall(vim.cmd,'wq')
vim.uv.fs_rename=rename
assert(vim.api.nvim_buf_is_valid(input) and vim.api.nvim_win_is_valid(win))
assert(vim.bo[input].modified and r.comments[1].text=='saved before failed wq')
assert(vim.api.nvim_buf_get_lines(input,0,1,false)[1]=='draft from failed wq')
vim.fn.maparg('<C-q>','n',false,true).callback()
vim.cmd('qall')
`);
	assert.equal(comments[0].text, 'saved before failed wq');
});

test("abnormal exits never deliver saved checkpoints", options, async () => {
	await assert.rejects(neovimReview(document, `
require('pi_review').comment(false)
${luaSaveComment('saved before abnormal exit')}
vim.cmd('cquit 7')
`), /Command failed/);
});

test("native write stays in the comment split, repeated writes update one comment, and write-quit closes only that split", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
local source,origin=vim.api.nvim_get_current_buf(),vim.api.nvim_get_current_win()
local count=#vim.api.nvim_list_wins()
r.comment(false)
local input=vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(input,0,-1,false,{'first write'})
vim.cmd('stopinsert'); vim.cmd('write')
assert(vim.api.nvim_get_current_buf()==input and not vim.bo.modified and #r.comments==1)
vim.api.nvim_buf_set_lines(input,0,-1,false,{'second write'})
vim.cmd('write')
assert(#r.comments==1 and r.comments[1].text=='second write')
vim.api.nvim_buf_set_lines(input,0,-1,false,{'final write'})
vim.cmd('wq')
assert(vim.api.nvim_get_current_win()==origin and #vim.api.nvim_list_wins()==count)
assert(vim.api.nvim_get_current_buf()==source)
assert(#r.comments==1 and r.comments[1].text=='final write')
vim.cmd('qall')
`);
	assert.equal(comments[0].text, "final write");
});

test("closing or replacing a comment window does not leave a stale editor lock", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
local source=vim.api.nvim_get_current_buf()
r.comment(false)
vim.cmd('stopinsert'); vim.cmd('quit!')
r.comment(false)
${luaSaveComment('saved after native close')}
r.comment(false)
vim.cmd('stopinsert'); vim.cmd('buffer! '..source)
assert(vim.api.nvim_get_current_buf()==source)
r.comment(false)
${luaSaveComment('saved after buffer replacement')}
vim.cmd('qall')
`);
	assert.equal(comments.length, 1);
	assert.equal(comments[0].text, "saved after buffer replacement");
});

test("saving or cancelling the last remaining comment window returns to the source without losing hidden user edits", options, async () => {
	const comments = await neovimReview(document, `
local r=require('pi_review')
local source=vim.api.nvim_get_current_buf()
local wrap,winbar=vim.wo.wrap,vim.wo.winbar
local other=vim.api.nvim_create_buf(true,false)
vim.bo[other].readonly=false; vim.bo[other].modifiable=true
vim.api.nvim_buf_set_lines(other,0,-1,false,{'unrelated unsaved text'})
r.comment(false)
vim.cmd('stopinsert'); vim.cmd('only!')
${luaSaveComment('saved after only')}
assert(vim.api.nvim_get_current_buf()==source and #vim.api.nvim_list_wins()==1)
assert(vim.wo.wrap==wrap and vim.wo.winbar==winbar)
assert(vim.bo[other].modified)
r.comment(false)
vim.cmd('stopinsert'); vim.cmd('only!')
vim.api.nvim_buf_set_lines(0,0,-1,false,{'discarded after only'})
vim.fn.maparg('<C-q>','n',false,true).callback()
assert(vim.api.nvim_get_current_buf()==source)
assert(vim.bo[other].modified and r.comments[1].text=='saved after only')
vim.bo[other].modified=false
vim.cmd('qall')
`);
	assert.equal(comments[0].text, 'saved after only');
});

test("comment splits do not change either Diffview source, bindings or hunk alignment; other-file comments survive recreation", { skip: !hasNeovim || !hasDiffview }, async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write('a.txt', 'old a\nunchanged\n'); write('b.txt', 'old b\n'); commit();
		write('a.txt', 'new a\nunchanged\n'); write('b.txt', 'new b\n'); commit();
		const index = readFileSync(join(cwd, '.git', 'index')), status = git('status', '--porcelain');
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: 'commit', revision: 'HEAD' }));
		try {
			const comments = await neovimReview({ title: 'Git', sources: workspace.sources }, `
local r=require('pi_review')
local function source_window(path,side)
  local found
  assert(vim.wait(10000,function()
    for _,win in ipairs(vim.api.nvim_list_wins()) do
      local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
      if id~=nil and r.sources[id].gitPath==path and r.sources[id].side==side then found=win; return true end
    end
  end,20))
  return found
end
local old,new=source_window('a.txt','old'),source_window('a.txt','new')
local count=#vim.api.nvim_list_wins()
local snapshot={}
for _,win in ipairs({old,new}) do
  local buf=vim.api.nvim_win_get_buf(win)
  snapshot[win]={buf=buf,lines=vim.api.nvim_buf_get_lines(buf,0,-1,false),height=vim.api.nvim_win_get_height(win),width=vim.api.nvim_win_get_width(win),
    filler=vim.api.nvim_win_call(win,function() return vim.fn.diff_filler(1) end)}
end
vim.api.nvim_set_current_win(old)
r.comment(false)
assert(#vim.api.nvim_list_wins()==count+1)
assert(not vim.wo.diff and not vim.wo.scrollbind and not vim.wo.cursorbind)
for win,entry in pairs(snapshot) do
  assert(vim.wo[win].diff and vim.wo[win].scrollbind and vim.wo[win].cursorbind)
  assert(vim.bo[entry.buf].readonly and not vim.bo[entry.buf].modifiable)
  assert(vim.deep_equal(vim.api.nvim_buf_get_lines(entry.buf,0,-1,false),entry.lines))
  vim.api.nvim_win_call(win,function() vim.cmd('diffupdate') end)
end
${luaSaveComment('a old comment')}
for win,entry in pairs(snapshot) do
  assert(vim.api.nvim_win_get_height(win)==entry.height and vim.api.nvim_win_get_width(win)==entry.width)
  assert(vim.api.nvim_win_call(win,function() return vim.fn.diff_filler(1) end)==entry.filler)
  assert(vim.deep_equal(vim.api.nvim_buf_get_lines(entry.buf,0,-1,false),entry.lines))
end
local old_id=r.comments[1].source
vim.api.nvim_set_current_win(new)
r.comment(false)
${luaSaveComment('a new comment')}
require('diffview.actions').select_next_entry()
local b=source_window('b.txt','new')
vim.api.nvim_set_current_win(b)
r.comment(false)
${luaSaveComment('b new comment')}
for _,buf in ipairs(vim.api.nvim_list_bufs()) do
  if vim.b[buf].pi_review_source==old_id then vim.api.nvim_buf_delete(buf,{force=true}) end
end
require('diffview.actions').select_prev_entry()
old=source_window('a.txt','old')
assert(#vim.api.nvim_buf_get_extmarks(vim.api.nvim_win_get_buf(old),r.namespace,0,-1,{})==1)
assert(#r.comments==3)
vim.cmd('qall')
`, { cwd, view: workspace });
			assert.deepEqual(comments.map(comment => comment.text), ['a old comment', 'a new comment', 'b new comment']);
			assert.equal(git('status', '--porcelain'), status);
			assert.deepEqual(readFileSync(join(cwd, '.git', 'index')), index);
		} finally { await workspace.cleanup(); }
	});
});
