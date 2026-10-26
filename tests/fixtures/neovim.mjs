import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { editReview } from "../../editor.ts";
import { diffviewPath, requireDiffview } from "../../diffview.ts";
const execute = promisify(execFile);
const version = spawnSync("nvim", ["--version"], { encoding: "utf8" });
const match = /^NVIM v(\d+)\.(\d+)/m.exec(version.stdout ?? "");
export const hasNeovim = Boolean(match && (Number(match[1]) > 0 || Number(match[2]) >= 10));
export const hasDiffview = existsSync(join(diffviewPath(), "plugin", "diffview.lua"));
if ((!hasNeovim || !hasDiffview) && process.env.PI_REVIEW_REQUIRE_NVIM) throw new Error("Neovim >= 0.10 and pinned Diffview are required for this test run.");

export async function neovimReview(document, lua, { cwd = process.cwd(), tree = false, view, beforeInit,
	userConfig = 'vim.cmd("syntax enable")', userFiles = {} } = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-nvim-test-")), script = join(directory, "test.lua"), setup = join(directory, "before-init.lua");
	writeFileSync(script, lua);
	if (beforeInit) writeFileSync(setup, beforeInit);
	// Exercise normal Neovim startup with a deterministic user configuration, not --clean/-u.
	const config = join(directory, 'config', 'nvim');
	for (const [path, content] of Object.entries({ 'init.lua': userConfig, ...userFiles })) {
		const target = join(config, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
	}
	let stopped = 0, restarted = 0;
	const ctx = { cwd, ui: { custom: factory => new Promise((resolve, reject) => {
		Promise.resolve(factory({ stop: () => stopped++, start: () => restarted++, requestRender() {} }, {}, {}, resolve)).catch(reject);
	}) } };
	try {
		const preparedView = view ? { directory: view.directory, left: view.left, right: view.right, paths: view.paths, runtime: await requireDiffview() } : undefined;
		const comments = await editReview(document, ctx, { tree, view: preparedView }, async (editor, args, cwd, env) => {
			try {
				const preinit = beforeInit ? ["--cmd", "lua dofile(vim.env.PI_REVIEW_TEST_BEFORE_INIT)"] : [];
				const result = await execute(editor, [...args, ...preinit, "--headless", "-c", `lua vim.api.nvim_create_autocmd('User', {pattern='PiReviewReady', once=true, callback=function() vim.schedule(function() local ok, err = pcall(dofile, vim.env.PI_REVIEW_TEST_SCRIPT); if not ok then io.stderr:write(tostring(err)..'\\n'..vim.fn.execute('messages')..'\\n'); for _,b in ipairs(vim.api.nvim_list_bufs()) do io.stderr:write(vim.api.nvim_buf_get_name(b)..' source='..tostring(vim.b[b].pi_review_source)..' ft='..vim.bo[b].filetype..' syntax='..vim.bo[b].syntax..'\\n') end; vim.cmd('cquit 3') end end) end})`], {
					cwd, env: { ...env, PI_REVIEW_TEST_SCRIPT: script, PI_REVIEW_TEST_BEFORE_INIT: setup, NVIM_APPNAME: 'nvim',
						XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'),
						XDG_STATE_HOME: join(directory, 'state'), XDG_CACHE_HOME: join(directory, 'cache') }, timeout: 30000, maxBuffer: 4 * 1024 * 1024,
				});
				// Autocommand errors can be printed without a nonzero process exit.
				if (/Error (?:in|detected)|E5113:/.test(result.stderr)) throw new Error(result.stderr);
			} catch (error) { throw new Error(`${error.message}\n${error.stderr ?? ""}`); }
		});
		if (stopped !== 1 || restarted !== 1) throw new Error("TUI lifecycle mismatch");
		return comments;
	} finally { rmSync(directory, { recursive: true, force: true }); }
}
export const luaSaveComment = text => `
local input = vim.api.nvim_get_current_buf()
vim.api.nvim_buf_set_lines(input, 0, -1, false, { ${JSON.stringify(text)} })
vim.cmd('stopinsert')
vim.fn.maparg('<C-CR>', 'n', false, true).callback()
`;
