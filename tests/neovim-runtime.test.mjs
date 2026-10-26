import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileSources } from "../file-workspace.ts";
import { createGitWorkspace } from "../git-workspace.ts";
import { gitComparison } from "../git.ts";
import { withRepository } from "./fixtures/repository.mjs";
import { hasDiffview, hasNeovim, luaSaveComment, neovimReview } from "./fixtures/neovim.mjs";
const reply = { title: "Reply", sources: [{ id: 0, reply: 0, label: "reply", content: "# Original reply\n\nOriginal text." }] };

test("normal init.lua, plugins, ftplugins, theme, options and user keymaps survive review startup", { skip: !hasNeovim }, async () => {
	const comments = await neovimReview(reply, `
local r = require('pi_review')
assert(vim.g.user_init and vim.g.user_plugin and vim.g.user_startup_hook)
assert(vim.b.user_markdown_ftplugin and vim.bo.textwidth == 72)
assert(vim.g.colors_name == 'pi-user')
assert(vim.api.nvim_get_hl(0,{name='Normal'}).bg == 0x112233)
assert(vim.api.nvim_get_hl(0,{name='Comment'}).fg == 0x55aa77)
assert(vim.o.statusline == 'User statusline' and vim.o.laststatus == 1)
assert(not vim.wo.number and not vim.wo.wrap and not vim.wo.linebreak)
assert(not vim.o.termguicolors and vim.o.mouse == '')
assert(vim.go.backup and vim.go.writebackup and vim.go.swapfile and vim.go.undofile and vim.go.modeline)
assert(vim.bo.readonly and not vim.bo.modifiable and not vim.bo.modeline and not vim.bo.swapfile and not vim.bo.undofile)
if vim.fn.has('nvim-0.12') == 1 then
  assert(#vim.api.nvim_get_runtime_file('parser/markdown.*', true) > 0, 'Lost bundled parser runtime path')
  assert(vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] ~= nil)
end
for _,key in ipairs({'ZZ','ZQ',',a',',d',']r','[r',']f','[f','<C-s>','q'}) do
  local map=vim.fn.maparg(key,'n',false,true)
  assert(map.desc == 'user:'..key and map.buffer == 0, 'Overwrote user map '..key)
end
assert(vim.fn.maparg('<CR>','n',false,true).buffer == 1)
assert(vim.fn.maparg('<C-CR>','n',false,true).buffer ~= 1)
assert(vim.fn.maparg('<Esc>','n',false,true).desc == 'user:<Esc>')
assert(vim.fn.exists(':ReCancel') == 2 and vim.fn.exists(':ReComment') == 2 and vim.fn.exists(':ReTree') == 0)
vim.fn.maparg('<CR>','n',false,true).callback()
assert(vim.fn.maparg('<CR>','n',false,true).desc == 'user:<CR>')
assert(vim.fn.maparg('ZZ','n',false,true).desc == 'user:ZZ')
assert(vim.fn.maparg('<C-s>','n',false,true).desc == 'user:<C-s>')
assert(vim.fn.maparg('q','n',false,true).desc == 'user:q')
assert(vim.fn.maparg('<C-CR>','i',false,true).buffer == 1)
for _,key in ipairs({'<CR>','<Esc>','<S-CR>'}) do
  local map=vim.fn.maparg(key,'i',false,true)
  assert(map.desc=='user_i:'..key and map.buffer==0)
end
assert(vim.fn.maparg('<C-q>','i',false,true).buffer == 1)
${luaSaveComment("comment using my configuration")}
assert(vim.o.statusline == 'User statusline' and not vim.wo.wrap)
vim.cmd('ReSubmit')
`, { userConfig: `
vim.g.user_init = true
vim.o.number = false
vim.o.wrap = false
vim.o.linebreak = false
vim.o.termguicolors = false
vim.o.mouse = ''
vim.o.statusline = 'User statusline'
vim.o.laststatus = 1
vim.o.backup = true
vim.o.writebackup = true
vim.o.swapfile = true
vim.o.undofile = true
vim.o.modeline = true
vim.cmd('syntax enable')
vim.cmd('colorscheme pi-user')
for _,key in ipairs({'ZZ','ZQ',',a',',d',']r','[r',']f','[f','<C-s>','q'}) do
  vim.keymap.set('n',key,'<Nop>',{desc='user:'..key})
end
for _,key in ipairs({'<CR>','<Esc>','<S-CR>'}) do
  vim.keymap.set('n',key,'<Nop>',{desc='user:'..key})
  vim.keymap.set('i',key,'<Nop>',{desc='user_i:'..key})
end
`, userFiles: {
		"plugin/user.lua": "vim.g.user_plugin=true; vim.api.nvim_create_autocmd('VimEnter',{callback=function() vim.g.user_startup_hook=true end})",
		"after/ftplugin/markdown.lua": "vim.b.user_markdown_ftplugin=true; vim.bo.textwidth=72; vim.bo.modifiable=true; vim.bo.readonly=false",
		"colors/pi-user.lua": "vim.g.colors_name='pi-user'; vim.api.nvim_set_hl(0,'Normal',{bg=0x112233}); vim.api.nvim_set_hl(0,'Comment',{fg=0x55aa77})",
	} });
	assert.equal(comments[0].text, "comment using my configuration");
});

test("a user's disabled ftplugins/syntax stay disabled; no Tree-sitter parser is imposed", { skip: !hasNeovim }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-review-no-parser-"));
	try {
		writeFileSync(join(cwd, "source.md"), "# Markdown source\n\nA paragraph.\n");
		const { sources } = await fileSources(["source.md"], cwd);
		const document = { title: "Markdown", sources: [reply.sources[0], { ...sources[0], id: 1 }] };
		const comments = await neovimReview(document, `
local r = require('pi_review')
assert(vim.fn.exists('#filetypeplugin#FileType') == 0)
assert(vim.fn.exists('#filetypeindent#FileType') == 0)
assert(vim.g.syntax_on == nil and vim.bo.syntax == '')
assert(vim.v.errmsg == '', vim.v.errmsg)
r.comment(false)
${luaSaveComment("reply comment without a parser")}
vim.cmd('bnext')
assert(vim.bo.filetype == 'markdown' and vim.bo.syntax == '')
r.comment(false)
${luaSaveComment("file comment without a parser")}
assert(_G.pi_review_ts_attempts == 0)
assert(vim.v.errmsg == '', vim.v.errmsg)
r.submit()
`, { cwd, userConfig: "vim.cmd('filetype plugin indent off'); vim.cmd('syntax off')", beforeInit: `
_G.pi_review_ts_attempts = 0
vim.treesitter.start = function()
  _G.pi_review_ts_attempts = _G.pi_review_ts_attempts + 1
  error('Parser could not be created: parsers are deliberately unavailable in this test')
end
` });
		assert.deepEqual(comments.map(comment => comment.text), ["reply comment without a parser", "file comment without a parser"]);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("minimal split-editor maps are local and ordinary quit delivers saved comments", { skip: !hasNeovim }, async () => {
	const comments = await neovimReview(reply, `
local r=require('pi_review')
for _,key in ipairs({'ZZ','ZQ',',a',',d',']r','[r',']f','[f'}) do assert(vim.fn.maparg(key,'n') == '', key) end
local source=vim.api.nvim_get_current_buf()
local count=#vim.api.nvim_list_wins()
vim.fn.maparg('<CR>','n',false,true).callback()
assert(#vim.api.nvim_list_wins() == count+1)
assert(vim.api.nvim_win_get_config(0).relative == '')
assert(vim.api.nvim_get_current_buf() ~= source)
assert(vim.fn.maparg('<C-s>','i',false,true).buffer ~= 1 and vim.fn.maparg('q','n',false,true).buffer ~= 1)
for _,key in ipairs({'<CR>','<Esc>','<S-CR>'}) do assert(vim.fn.maparg(key,'i',false,true).buffer ~= 1, key) end
vim.api.nvim_buf_set_lines(0,0,-1,false,{'saved, then ordinary quit'})
vim.cmd('stopinsert')
vim.fn.maparg('<C-CR>','n',false,true).callback()
assert(#r.comments == 1 and #vim.api.nvim_list_wins() == count)
assert(vim.api.nvim_get_current_buf() == source)
vim.cmd('qall')
`);
	assert.equal(comments[0].text, 'saved, then ordinary quit');
});

test("unrelated buffers keep normal options and unsaved edits block submission instead of being discarded", { skip: !hasNeovim }, async () => {
	assert.deepEqual(await neovimReview(reply, `
local source=vim.api.nvim_get_current_buf()
vim.cmd('new')
local other=vim.api.nvim_get_current_buf()
assert(vim.bo.modifiable and not vim.bo.readonly)
assert(vim.bo.modeline and vim.bo.swapfile and vim.bo.undofile)
vim.api.nvim_buf_set_lines(other,0,-1,false,{'unsaved user data'})
vim.bo[other].bufhidden='hide'
vim.api.nvim_set_current_buf(source)
vim.cmd('ReSubmit')
local manifest=vim.json.decode(table.concat(vim.fn.readfile(vim.env.PI_REVIEW_MANIFEST),'\\n'))
assert(vim.fn.filereadable(manifest.result) == 0)
assert(vim.bo[other].modified)
assert(vim.api.nvim_buf_get_lines(other,0,1,false)[1] == 'unsaved user data')
vim.bo[other].modified=false
vim.cmd('ReSubmit')
`, { userConfig: "vim.o.modeline=true; vim.o.swapfile=true; vim.o.undofile=true" }), []);
});

test("a file already opened by user startup stays separate, preserving unsaved editor contents", { skip: !hasNeovim }, async () => {
	const cwd = mkdtempSync(join(tmpdir(), 'pi-review-existing-buffer-'));
	try {
		writeFileSync(join(cwd, 'source.txt'), 'original on disk\n');
		const { sources } = await fileSources(['source.txt'], cwd);
		assert.deepEqual(await neovimReview({ title: 'Existing source', sources }, `
local previous=vim.g.user_existing_buf
assert(previous ~= vim.api.nvim_get_current_buf())
assert(vim.api.nvim_buf_get_name(0):find('pi-review://',1,true))
assert(vim.api.nvim_buf_get_lines(0,0,1,false)[1] == 'original on disk')
assert(vim.bo.readonly and not vim.bo.modifiable)
assert(vim.bo[previous].modifiable and not vim.bo[previous].readonly and vim.bo[previous].modified)
assert(vim.api.nvim_buf_get_lines(previous,0,1,false)[1] == 'unsaved user draft')
assert(vim.v.errmsg == '',vim.v.errmsg)
vim.bo[previous].modified=false
vim.cmd('ReSubmit')
`, { cwd, userConfig: `
vim.o.hidden=true
vim.cmd('edit source.txt')
vim.g.user_existing_buf=vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(0,0,-1,false,{'unsaved user draft'})
` }), []);
		assert.equal(readFileSync(join(cwd, 'source.txt'), 'utf8'), 'original on disk\n');
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("Diffview keeps user layout, hooks, navigation and global theme; only review buffers lose diff colors", { skip: !hasNeovim || !hasDiffview }, async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write('file.md', '# Before\n'); commit(); write('file.md', '# After\n'); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: 'commit', revision: 'HEAD' }));
		try {
			const comments = await neovimReview({ title: 'Git', sources: workspace.sources }, `
local r=require('pi_review')
assert(vim.wait(10000,function()
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
    if id ~= nil then vim.api.nvim_set_current_win(win); return true end
  end
end,20))
assert(vim.g.user_diffview_opened and vim.g.user_diffview_read)
assert(vim.b.user_diffview_hook)
local cfg=require('diffview.config').get_config()
assert(cfg.view.default.layout == 'diff2_vertical')
assert(cfg.file_panel.win_config.width == 21)
local custom, native, discard=false,false,false
for _,map in ipairs(cfg.keymaps.file_panel) do
  if map[2]=='s' and map[3]==require('diffview.actions').select_next_entry then custom=true end
  if map[2]=='<tab>' then native=true end
  if map[3]==require('diffview.actions').restore_entry then discard=true end
end
assert(custom and native and not discard)
assert(vim.api.nvim_get_hl(0,{name='DiffAdd'}).bg == 0x123456)
assert(vim.api.nvim_get_hl(0,{name='Comment'}).fg == 0x55aa77)
assert(vim.wo.winhighlight:find('DiffAdd:Normal',1,true))
assert(vim.wo.winhighlight:find('CursorLine:Visual',1,true))
assert(vim.treesitter.highlighter.active[vim.api.nvim_get_current_buf()] == nil)
r.comment(false)
${luaSaveComment('comment with my Diffview configuration')}
vim.cmd('DiffviewClose')
assert(vim.g.user_diffview_closed)
vim.cmd('ReSubmit')
`, { cwd, view: workspace, userConfig: `
vim.cmd('syntax enable')
local manifest=vim.json.decode(table.concat(vim.fn.readfile(vim.env.PI_REVIEW_MANIFEST),'\\n'))
vim.opt.runtimepath:prepend(manifest.view.runtime)
vim.api.nvim_set_hl(0,'DiffAdd',{bg=0x123456})
vim.api.nvim_set_hl(0,'Comment',{fg=0x55aa77})
local actions=require('diffview.actions')
require('diffview').setup({
  use_icons=false,
  view={default={layout='diff2_vertical'}},
  file_panel={win_config={width=21}},
  keymaps={file_panel={{'n','s',actions.select_next_entry}}},
  hooks={
    view_opened=function() vim.g.user_diffview_opened=true end,
    view_closed=function() vim.g.user_diffview_closed=true end,
    diff_buf_read=function(buf,ctx)
      assert(ctx.layout_name=='diff2_vertical')
      vim.g.user_diffview_read=true
      vim.b[buf].user_diffview_hook=true
      vim.wo.winhighlight='CursorLine:Visual'
    end,
  },
})
` });
			assert.equal(comments[0].text, 'comment with my Diffview configuration');
		} finally { await workspace.cleanup(); }
	});
});

test("an incompatible already loaded Diffview is not silently replaced or used", { skip: !hasNeovim || !hasDiffview }, async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write('file.txt', 'before\n'); commit(); write('file.txt', 'after\n'); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: 'commit', revision: 'HEAD' }));
		try {
			await assert.rejects(neovimReview({ title: 'Git', sources: workspace.sources }, "error('Review should not start')", {
				cwd, view: workspace, userConfig: "require('diffview')",
				userFiles: { 'lua/diffview/init.lua': "return {open=function() error('Unverified Diffview opened') end}" },
			}), /already loaded Diffview must use the tested commit/);
		} finally { await workspace.cleanup(); }
	});
});

test("Neovim stderr errors fail the harness even when the review exits successfully", { skip: !hasNeovim }, async () => {
	await assert.rejects(neovimReview(reply, `
vim.api.nvim_err_writeln('E5113: simulated autocommand failure')
require('pi_review').submit()
`), /E5113: simulated autocommand failure/);
});
