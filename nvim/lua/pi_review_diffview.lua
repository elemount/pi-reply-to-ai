-- Diffview supplies its own navigation; review adds only source anchoring and safety.
local M = {}
local api = vim.api
local function normalize(path)
  return package.config:sub(1, 1) == "\\" and path:gsub("\\", "/") or path
end

-- Public hooks expose the layout side but not the path. Match the pinned runtime's
-- revision-buffer name against our allowlist; fail closed for null/unknown buffers.
function M.source_for_buffer(name, symbol, view, sources)
  local side = symbol == "a" and "old" or symbol == "b" and "new" or nil
  if not side then return nil end
  local revision = side == "old" and view.left or view.right
  for _, source in ipairs(sources) do
    if source.side == side then
      local suffix = "/" .. revision:sub(1, 11) .. "/" .. normalize(source.gitPath)
      if normalize(name):sub(-#suffix) == suffix then return source.id end
    end
  end
end
local function review_keymaps(config, actions)
  local blocked = {}
  for _, name in ipairs({ 'toggle_stage_entry', 'stage_all', 'unstage_all', 'restore_entry',
    'goto_file', 'goto_file_edit', 'goto_file_split', 'goto_file_tab', 'diffget', 'diffput' }) do
    blocked[actions[name]] = true
  end
  -- Factory-created default merge actions have distinct closures, not public action identities.
  for _, maps in pairs(config.defaults.keymaps) do
    if type(maps) == 'table' then
      for _, map in ipairs(maps) do
        local desc = map[4] and map[4].desc or ''
        if desc:match('^Choose ') or desc:match('^Delete the conflict') or desc:match('^Obtain the diff') then blocked[map[3]] = true end
      end
    end
  end
  local maps = vim.deepcopy(config.get_config().keymaps)
  maps.disable_defaults = true -- These are already the user's resolved defaults/customizations.
  for name, entries in pairs(maps) do
    if type(entries) == 'table' then
      maps[name] = vim.tbl_filter(function(map) return not blocked[map[3]] end, entries)
    end
  end
  return maps
end
local function check_loaded_diffview(view)
  local source = debug.getinfo(require('diffview').open, 'S').source
  local root = source:sub(1, 1) == '@' and vim.fn.fnamemodify(source:sub(2), ':h:h:h') or ''
  local function revision(directory)
    local result = vim.system({ 'git', '-C', directory, 'rev-parse', '--verify', 'HEAD' }, { text = true }):wait(5000)
    return result.code == 0 and vim.trim(result.stdout or '') or nil
  end
  local expected = revision(view.runtime)
  if root == '' or not expected or revision(root) ~= expected then
    error('Your already loaded Diffview must use the tested commit from /re setup. Pin it in your Neovim plugin configuration; the review will not replace your loaded plugin.')
  end
end
function M.open(view, sources, review)
  -- Keep an already configured Diffview instance, including its layout, hooks and navigation.
  if package.loaded['diffview'] then check_loaded_diffview(view)
  else vim.opt.runtimepath:prepend(view.runtime) end
  vim.cmd("runtime plugin/diffview.lua")
  local diffview = require('diffview')
  local config = require('diffview.config')
  local options = vim.deepcopy(config.get_config())
  options.keymaps = review_keymaps(config, require('diffview.actions'))
  options.diff_binaries = true -- Our source allowlist has already checked UTF-8 and size limits.
  options.watch_index = false
  options.git_cmd = { 'git', '-c', 'core.fsmonitor=false', '-c', 'diff.renames=false' }
  options.default_args.DiffviewOpen = {} -- Never imply a mutable local side for fixed revisions.
  local opened = false
  local function hook(event, callback)
    local previous = options.hooks[event]
    options.hooks[event] = function(...)
      if previous then previous(...) end
      callback(...)
    end
  end
  local function attach(buf, _, ctx)
    local id = M.source_for_buffer(api.nvim_buf_get_name(buf), ctx.symbol, view, sources)
    if id ~= nil then
      review.attach(buf, id, true)
    end
  end
  hook('view_opened', function() opened = true end)
  hook('diff_buf_read', function(buf, ctx) attach(buf, api.nvim_get_current_win(), ctx) end)
  hook('diff_buf_win_enter', attach)
  diffview.setup(options)
  -- The private comparison contains only allowed changes; no filename/pathspec expansion.
  assert(vim.uv.chdir(view.directory))
  diffview.open({ view.left .. ".." .. view.right })
  if not opened then error("Diffview could not open the prepared comparison.") end
end
return M
