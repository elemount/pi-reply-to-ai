import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileSources } from "../file-workspace.ts";
import { gitComparison } from "../git.ts";
import { createGitWorkspace } from "../git-workspace.ts";
import { hasDiffview, hasNeovim, luaSaveComment, neovimReview } from "./fixtures/neovim.mjs";
import { withRepository } from "./fixtures/repository.mjs";
const options = { skip: !hasNeovim }, gitOptions = { skip: !hasNeovim || !hasDiffview };
const waitForSource = `
assert(vim.wait(15000, function()
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    if vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source ~= nil then vim.api.nvim_set_current_win(win); return true end
  end
end, 20), 'No annotated source buffer')
`;

test("empty files accept an explicit line-one comment and .patch sources keep syntax highlighting with uncolored comment previews", options, async () => {
	const cwd = mkdtempSync(join(tmpdir(), "pi-nvim-edge-"));
	try {
		writeFileSync(join(cwd, "empty.txt"), ""); writeFileSync(join(cwd, "change.patch"), "@@ -1 +1 @@\n-old\n+new\n"); writeFileSync(join(cwd, "normal.py"), "x = 1\n");
		const { sources } = await fileSources(["empty.txt", "change.patch", "normal.py"], cwd);
		const comments = await neovimReview({ title: "Files", sources }, `
local r = require('pi_review')
assert(vim.api.nvim_buf_get_lines(0,0,1,false)[1] == '')
r.comment(false)
${luaSaveComment("empty file comment")}
vim.cmd('bnext')
assert(vim.bo.filetype == 'diff' and vim.bo.syntax == 'diff')
r.comment(false)
${luaSaveComment("patch comment")}
local marks=vim.api.nvim_buf_get_extmarks(0,r.namespace,0,-1,{details=true})
assert(marks[1][4].virt_lines[1][1][2] == '')
vim.cmd('bnext')
assert(vim.bo.syntax == 'python')
r.submit()
`, { cwd });
		assert.equal(comments.length, 2); assert.equal(comments[0].line, 1); assert.equal(readFileSync(join(cwd, "empty.txt"), "utf8"), "");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
test("narrow terminals and non-ASCII multiline split comments preserve text; cancelled edits keep saved content", options, async () => {
	const sources = [{ id: 0, reply: 0, label: "reply", content: "original" }];
	const comments = await neovimReview({ title: "Reply", sources }, `
local r=require('pi_review')
vim.o.columns=28; vim.o.lines=10
r.comment(false)
local input=vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(input,0,-1,false,{'中文第一行🙂','第二行','| A | B |'})
vim.cmd('stopinsert'); vim.fn.maparg('<C-CR>','n',false,true).callback()
r.comment(false)
vim.api.nvim_buf_set_lines(0,0,-1,false,{'cancel this edit'})
vim.cmd('stopinsert'); vim.fn.maparg('<C-q>','n',false,true).callback()
assert(r.comments[1].text:find('中文第一行🙂',1,true))
r.submit()
`);
	assert.equal(comments[0].text, "中文第一行🙂\n第二行\n| A | B |");
});
test("working Diffview displays captured content even after the real working file changes", gitOptions, async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("file.txt", "base\n"); commit(); write("file.txt", "captured working content\n");
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "diff" }));
		try {
			write("file.txt", "changed externally after capture\n");
			const comments = await neovimReview({ title: "Working", sources: workspace.sources }, `
local r=require('pi_review')
${waitForSource}
for _,win in ipairs(vim.api.nvim_list_wins()) do
  local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
  if id ~= nil and r.sources[id].side == 'new' then vim.api.nvim_set_current_win(win) end
end
assert(vim.api.nvim_buf_get_lines(0,0,1,false)[1] == 'captured working content')
assert(r.sources[vim.b.pi_review_source].revision == 'working tree snapshot')
r.comment(false)
${luaSaveComment("working comment")}
r.submit()
`, { cwd, view: workspace });
			assert.match(comments[0].context, /captured working content/); assert.match(readFileSync(join(cwd, "file.txt"), "utf8"), /changed externally/);
		} finally { await workspace.cleanup(); }
	});
});
test("Diffview handles literal special filenames and filtered private comparisons without path expansion", gitOptions, async () => {
	await withRepository(async ({ cwd, write, commit }) => {
		write("root", "root\n"); commit();
		const names = ["a [name].txt", "$not_an_environment_variable.txt", "percent%hash#.txt", "quote'comma,.txt", "中文.txt"];
		for (const name of names) write(name, "literal content\n"); write(".env", "must not appear\n"); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "commit", revision: "HEAD" }));
		try {
			const comments = await neovimReview({ title: "Git", sources: workspace.sources }, `
local r=require('pi_review')
${waitForSource}
local seen={}
for _=1,${names.length} do
  for _,win in ipairs(vim.api.nvim_list_wins()) do
    local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
    if id ~= nil then
      assert(r.sources[id].gitPath ~= '.env')
      seen[id]=true
    end
  end
  local previous=vim.b.pi_review_source
  require('diffview.actions').select_next_entry()
  assert(vim.wait(10000,function()
    for _,win in ipairs(vim.api.nvim_list_wins()) do
      local id=vim.b[vim.api.nvim_win_get_buf(win)].pi_review_source
      if id ~= nil and id ~= previous then vim.api.nvim_set_current_win(win); return true end
    end
  end,20))
end
local count=0; for _ in pairs(seen) do count=count+1 end
assert(count==${names.length}, 'Missing literal-path source: '..count)
r.submit()
`, { cwd, view: workspace });
			assert.deepEqual(comments, []);
		} finally { await workspace.cleanup(); }
	});
});
test("deleted files expose the old side only and are still commentable", gitOptions, async () => {
	await withRepository(async ({ cwd, write, commit, git }) => {
		write("deleted.txt", "old deleted line\n"); commit(); git("rm", "-q", "deleted.txt"); commit();
		const workspace = await createGitWorkspace(await gitComparison(cwd, { kind: "commit", revision: "HEAD" }));
		try {
			const comments = await neovimReview({ title: "Deletion", sources: workspace.sources }, `
local r=require('pi_review')
${waitForSource}
assert(r.sources[vim.b.pi_review_source].side=='old')
assert(vim.api.nvim_buf_get_lines(0,0,1,false)[1]=='old deleted line')
r.comment(false)
${luaSaveComment("old deletion comment")}
r.submit()
`, { cwd, view: workspace });
			assert.equal(comments[0].text, "old deletion comment");
		} finally { await workspace.cleanup(); }
	});
});
