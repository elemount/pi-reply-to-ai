local M = {}
local api = vim.api
local ns = api.nvim_create_namespace("pi-reply-to-ai")
local manifest, manifest_path, sources, buffers, loaded, comments, tree_rows
local opened_bytes = 0
local tree_buf, source_win, input_win, input_buf, input_close
local expanded = {}

local function notify(message) vim.notify(message, vim.log.levels.WARN, { title = "/re" }) end
local function lines(text)
  local value = vim.split(text:gsub("\r\n", "\n"), "\n", { plain = true })
  if #value > 1 and value[#value] == "" then table.remove(value) end
  return value
end
local function readonly(buf)
  vim.bo[buf].modifiable = false
  vim.bo[buf].readonly = true
  vim.bo[buf].swapfile = false
  vim.bo[buf].undofile = false
  vim.bo[buf].modeline = false
  vim.bo[buf].bufhidden = "hide"
  vim.bo[buf].modified = false
end
local function plain_source(buf)
  vim.treesitter.stop(buf)
  vim.bo[buf].syntax = "OFF"
  api.nvim_buf_call(buf, function() vim.cmd("silent! syntax clear") end)
end
local function literal(value)
  return value:gsub("[%c]", function(char) return string.format("\\x%02x", char:byte()) end)
end
local function current_source() return vim.b.pi_review_source end
local function input_open()
  return input_win and api.nvim_win_is_valid(input_win) and input_buf and api.nvim_buf_is_valid(input_buf)
    and api.nvim_win_get_buf(input_win) == input_buf
end
local function anchored_comment(id, line)
  for i, comment in ipairs(comments) do
    if comment.source == id and line >= comment.line and line <= comment.endLine then return comment, i end
  end
end
local function preview(text, highlight)
  local result = {}
  for i, line in ipairs(lines(text)) do
    if i > 6 then table.insert(result, { { "    … (Enter to edit)", highlight } }); break end
    -- These are previews, not editable text. The full comment is edited in a normal split.
    local shown = vim.fn.strcharpart(line, 0, math.max(12, vim.o.columns - 12))
    table.insert(result, { { (i == 1 and "#REPLY: " or "        ") .. shown, highlight } })
  end
  return result
end
function M.render(buf)
  if not api.nvim_buf_is_loaded(buf) then return end
  api.nvim_buf_clear_namespace(buf, ns, 0, -1)
  local id = vim.b[buf].pi_review_source
  if id == nil then return end
  for _, comment in ipairs(comments) do
    if comment.source == id then
      api.nvim_buf_set_extmark(buf, ns, comment.line - 1, 0, {
        end_row = comment.endLine - 1, end_col = 0,
        virt_lines = preview(comment.text, (sources[id].side or vim.bo[buf].filetype == "diff") and "" or "Comment"), virt_lines_above = false,
        right_gravity = false,
      })
    end
  end
end

local function context(buf, first, last)
  local count = api.nvim_buf_line_count(buf)
  local from, to = math.max(1, first - 2), math.min(count, last + 2)
  local result = {}
  local function append(line)
    local text = api.nvim_buf_get_lines(buf, line - 1, line, false)[1] or ""
    local excerpt = vim.fn.strcharpart(text, 0, 1000)
    if #excerpt < #text then excerpt = excerpt .. ' … [truncated]' end
    table.insert(result, tostring(line) .. ": " .. excerpt)
  end
  if to - from <= 9 then for line = from, to do append(line) end
  else
    for line = from, from + 4 do append(line) end
    table.insert(result, "…")
    for line = to - 4, to do append(line) end
  end
  return table.concat(result, "\n")
end

-- Checkpoint only explicit saved comments. A successful editor exit delivers this
-- private result; unsaved comment drafts never enter it, and abnormal exits do not send.
local function write_result(value)
  if #value > 10000 then notify('A review is limited to 10,000 comments.'); return false end
  local encoded = vim.json.encode(value)
  if #encoded > 64 * 1024 * 1024 then notify('Review result exceeds the 64 MiB limit.'); return false end
  local partial = manifest.result .. '.partial'
  local file, error = io.open(partial, 'wb')
  if not file then notify('Could not save review: ' .. tostring(error)); return false end
  local protected, protection_error = vim.uv.fs_chmod(partial, 384) -- 0600; directory is private too.
  if not protected then file:close(); vim.uv.fs_unlink(partial); notify('Could not protect review: ' .. tostring(protection_error)); return false end
  local ok, message = file:write(encoded)
  local closed, close_error = file:close()
  if not ok or not closed then
    vim.uv.fs_unlink(partial)
    notify('Could not save review: ' .. tostring(message or close_error)); return false
  end
  local renamed, rename_error = vim.uv.fs_rename(partial, manifest.result)
  if not renamed then vim.uv.fs_unlink(partial); notify('Could not save review: ' .. tostring(rename_error)); return false end
  return true
end

function M.comment(visual, first, last)
  if input_open() then api.nvim_set_current_win(input_win); return end
  local source_buf, origin_win = api.nvim_get_current_buf(), api.nvim_get_current_win()
  local id = current_source()
  if id == nil then notify('Select a source line first.'); return end
  first = first or api.nvim_win_get_cursor(0)[1]
  last = last or first
  if visual then
    last = vim.fn.line('v')
    if first > last then first, last = last, first end
    api.nvim_feedkeys(api.nvim_replace_termcodes('<Esc>', true, false, true), 'nx', false)
  end
  if first < 1 or last < first or last > api.nvim_buf_line_count(source_buf) then notify('Select a valid source line range.'); return end
  local existing, existing_index = anchored_comment(id, first)
  if existing then first, last = existing.line, existing.endLine end
  local original_context = context(source_buf, first, last)
  local source_options = {}
  for _, name in ipairs({ 'diff', 'scrollbind', 'cursorbind', 'foldmethod', 'foldenable', 'wrap', 'linebreak', 'winbar' }) do
    source_options[name] = vim.wo[origin_win][name]
  end
  local input = api.nvim_create_buf(false, true)
  vim.bo[input].buftype = 'acwrite'
  vim.bo[input].readonly = false
  vim.bo[input].modifiable = true
  vim.bo[input].bufhidden = 'wipe'
  vim.bo[input].swapfile = false
  vim.bo[input].undofile = false
  vim.bo[input].modeline = false
  local location = literal(sources[id].label) .. ':' .. tostring(first) .. (sources[id].side and (' [' .. sources[id].side .. ']') or '')
  api.nvim_buf_set_name(input, 'pi-comment://' .. tostring(input) .. '/' .. location)
  api.nvim_buf_set_lines(input, 0, -1, false, lines(existing and existing.text or ''))
  local height = math.max(1, math.min(8, math.floor(api.nvim_win_get_height(origin_win) / 3)))
  local opened, error = pcall(vim.cmd, string.format('belowright sbuffer %d', input))
  if not opened then
    api.nvim_buf_delete(input, { force = true })
    notify('Could not open comment split: ' .. tostring(error)); return
  end
  local win = api.nvim_get_current_win()
  input_win, input_buf = win, input
  api.nvim_win_set_height(win, height)
  -- A split inherits window options from the source pane. It must never join
  -- Diffview's diff/scroll/cursor binding or fold the comment as source hunks.
  vim.wo[win].diff = false
  vim.wo[win].scrollbind = false
  vim.wo[win].cursorbind = false
  vim.wo[win].foldmethod = 'manual'
  vim.wo[win].foldenable = false
  vim.wo[win].wrap = true
  vim.wo[win].linebreak = true
  vim.wo[win].winbar = ' Comment · C-Enter / :wq save · :q! / C-Q cancel '
  local function close()
    vim.cmd('stopinsert')
    if api.nvim_buf_is_valid(input) then vim.bo[input].modified = false end
    if api.nvim_win_is_valid(win) and api.nvim_win_get_buf(win) == input then
      local normal_windows = 0
      for _, other in ipairs(api.nvim_list_wins()) do
        if api.nvim_win_get_config(other).relative == '' then normal_windows = normal_windows + 1 end
      end
      if normal_windows == 1 then
        -- :only may have closed the source pane. Return to it in this window,
        -- rather than force-quitting Neovim or discarding unrelated hidden edits.
        local target = api.nvim_buf_is_valid(source_buf) and source_buf or api.nvim_create_buf(true, true)
        api.nvim_set_current_buf(target)
        for name, value in pairs(source_options) do vim.wo[win][name] = value end
      else api.nvim_win_close(win, true) end
    end
    if api.nvim_buf_is_valid(input) then api.nvim_buf_delete(input, { force = true }) end
    if api.nvim_win_is_valid(origin_win) then api.nvim_set_current_win(origin_win) end
  end
  input_close = close
  api.nvim_create_autocmd('BufWipeout', { buffer = input, once = true, callback = function()
    if input_buf == input then input_win, input_buf, input_close = nil, nil, nil end
  end })
  local function save(and_close)
    local text = table.concat(api.nvim_buf_get_lines(input, 0, -1, false), '\n')
    if #text > 1024 * 1024 then notify('A comment is limited to 1 MiB.'); return end
    local updated = vim.deepcopy(comments)
    if text:find('%S') then
      if existing then updated[existing_index].text = text
      else
        table.insert(updated, { source = id, line = first, endLine = last, context = original_context, text = text })
        existing_index = #updated
      end
    elseif existing then table.remove(updated, existing_index) end
    if not write_result(updated) then return end
    comments = updated
    M.comments = comments
    existing = text:find('%S') and updated[existing_index] or nil
    if not existing then existing_index = nil end
    vim.bo[input].modified = false
    if and_close then close() end
    M.render(source_buf)
  end
  vim.keymap.set({ 'n', 'i' }, '<C-CR>', function() save(true) end, { buffer = input, desc = 'Save review comment' })
  vim.keymap.set({ 'n', 'i', 'x' }, '<C-q>', close, { buffer = input, desc = 'Cancel comment edit' })
  api.nvim_create_autocmd('BufWriteCmd', { buffer = input, callback = function() save(false) end })
  -- Run the user's Markdown ftplugins in the comment window, never the source pane.
  vim.bo[input].filetype = 'markdown'
  vim.bo[input].swapfile, vim.bo[input].undofile, vim.bo[input].modeline = false, false, false
  vim.bo[input].readonly, vim.bo[input].modifiable = false, true
  vim.bo[input].modified = false
  vim.cmd('startinsert')
end
function M.attach(buf, id, diff)
  vim.b[buf].pi_review_source = id
  readonly(buf)
  if not diff then
    local filetype = sources[id].reply ~= nil and "markdown" or (vim.filetype.match({ filename = sources[id].path or "", buf = buf }) or "text")
    if vim.bo[buf].filetype ~= filetype then vim.bo[buf].filetype = filetype end
  end
  if diff or vim.bo[buf].filetype == "diff" then plain_source(buf) end
  -- User FileType hooks may change local options; source protection still applies.
  readonly(buf)
  local opts = { buffer = buf, silent = true, desc = 'Add or edit a review comment' }
  vim.keymap.set("n", "<CR>", function() M.comment(false) end, opts)
  vim.keymap.set("x", "<CR>", function() M.comment(true) end, opts)
  M.render(buf)
end

function M.open(id)
  local source = sources[id]
  if not source then return end
  if not buffers[id] or not api.nvim_buf_is_valid(buffers[id]) then
    if not loaded[id] then
      local data
      if source.reply ~= nil then
        data = { content = source.content or '', bytes = #(source.content or '') }
      else
        local result = vim.system({ manifest.node, manifest.reader, manifest_path, tostring(id) }, { text = true }):wait(30000)
        local ok, decoded = pcall(vim.json.decode, result.stdout or "")
        if result.code ~= 0 or not ok or decoded.error then notify(ok and decoded.error or "Could not read review source."); return end
        data = decoded
      end
      if opened_bytes + data.bytes > 64 * 1024 * 1024 then notify("Open sources exceed the 64 MiB review limit."); return end
      loaded[id] = data.content
      opened_bytes = opened_bytes + data.bytes
    end
    local buf = api.nvim_create_buf(true, true)
    vim.b[buf].pi_review_source = id
    readonly(buf)
    local name = source.path or ("pi-reply://" .. tostring(source.reply))
    -- Session/startup plugins may already have the real file open; never reuse or alter it.
    if source.path and vim.fn.bufexists(source.path) == 1 then name = 'pi-review://' .. tostring(id) .. '/' .. source.path end
    api.nvim_buf_set_name(buf, name)
    vim.bo[buf].readonly, vim.bo[buf].modifiable = false, true
    api.nvim_buf_set_lines(buf, 0, -1, false, lines(loaded[id]))
    readonly(buf)
    buffers[id] = buf
  end
  if source_win and api.nvim_win_is_valid(source_win) then api.nvim_set_current_win(source_win) end
  api.nvim_set_current_buf(buffers[id])
  source_win = api.nvim_get_current_win()
  M.attach(buffers[id], id, false)
end
local function tree_nodes()
  local roots, root_map = {}, {}
  for _, source in ipairs(manifest.sources) do
    local root_name = source.root or "Files"
    local root = root_map[root_name]
    if not root then root = { label = root_name, children = {}, key = root_name }; root_map[root_name] = root; table.insert(roots, root) end
    local parts = source.root and vim.split(source.label, package.config:sub(1, 1), { plain = true }) or { source.label }
    local node = root
    for i, part in ipairs(parts) do
      local child
      for _, candidate in ipairs(node.children) do if candidate.label == part then child = candidate; break end end
      if not child then child = { label = part, key = node.key .. "/" .. part }; table.insert(node.children, child) end
      if i == #parts then child.id = source.id else child.children = child.children or {} end
      node = child
    end
  end
  return roots
end
function M.tree()
  if not manifest.tree then notify("This review has no directory tree; use :ls or your buffer picker."); return end
  if not tree_buf or not api.nvim_buf_is_valid(tree_buf) then
    tree_buf = api.nvim_create_buf(false, true)
    api.nvim_buf_set_name(tree_buf, "pi-review://files")
    vim.keymap.set("n", "<CR>", function()
      local row = tree_rows[api.nvim_win_get_cursor(0)[1]]
      if not row then return end
      if row.node.children then expanded[row.node.key] = not expanded[row.node.key]; M.tree()
      else M.open(row.node.id) end
    end, { buffer = tree_buf })
  end
  tree_rows = {}
  local text = {}
  local function add(nodes, depth)
    for _, node in ipairs(nodes) do
      local open = expanded[node.key]
      table.insert(text, string.rep("  ", depth) .. (node.children and (open and "▾ " or "▸ ") or "  ") .. literal(node.label))
      table.insert(tree_rows, { node = node })
      if node.children and open then add(node.children, depth + 1) end
    end
  end
  local roots = tree_nodes()
  for _, root in ipairs(roots) do if expanded[root.key] == nil then expanded[root.key] = true end end
  add(roots, 0)
  vim.bo[tree_buf].readonly, vim.bo[tree_buf].modifiable = false, true
  api.nvim_buf_set_lines(tree_buf, 0, -1, false, text)
  readonly(tree_buf)
  api.nvim_set_current_buf(tree_buf)
end
function M.submit()
  if input_open() then notify('Save or cancel the open comment first.'); return end
  for _, buf in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(buf) and vim.bo[buf].modified and (vim.bo[buf].buftype == '' or vim.bo[buf].buftype == 'acwrite') then
      notify('Save or discard other modified buffers before submitting.'); return
    end
  end
  if not write_result(comments) then return end
  local quit, quit_error = pcall(vim.cmd, 'qall')
  if not quit then notify('Could not close review: ' .. tostring(quit_error)) end
end
function M.cancel()
  local removed, message, code = vim.uv.fs_unlink(manifest.result)
  if not removed and code ~= 'ENOENT' then notify('Could not discard review: ' .. tostring(message)); return end
  comments = {}
  M.comments = comments
  if input_close then input_close() end
  for _, buf in ipairs(api.nvim_list_bufs()) do
    if api.nvim_buf_is_loaded(buf) and vim.b[buf].pi_review_source ~= nil then M.render(buf) end
  end
  local quit, quit_error = pcall(vim.cmd, 'qall')
  if not quit then notify('Review discarded; close other modified buffers before exiting: ' .. tostring(quit_error)) end
end
function M.start(path)
  manifest_path = path
  manifest = vim.json.decode(table.concat(vim.fn.readfile(path), "\n"))
  sources, buffers, loaded, comments = {}, {}, {}, {}
  for _, source in ipairs(manifest.sources) do sources[source.id] = source end
  M.sources, M.comments, M.namespace = sources, comments, ns
  api.nvim_create_user_command('ReComment', function(command) M.comment(false, command.line1, command.line2) end,
    { range = true, desc = 'Add or edit a review comment', force = false })
  api.nvim_create_user_command("ReSubmit", M.submit, { desc = "Submit the whole review", force = false })
  api.nvim_create_user_command('ReCancel', M.cancel, { desc = 'Discard the whole review', force = false })
  if manifest.tree then api.nvim_create_user_command("ReTree", M.tree, { desc = "Show review files", force = false }) end
  api.nvim_create_autocmd("BufWinEnter", { callback = function(event)
    if vim.b[event.buf].pi_review_source ~= nil then M.render(event.buf) end
  end })
  if manifest.view then
    require("pi_review_diffview").open(manifest.view, manifest.sources, M)
  else
    if manifest.tree then M.tree()
    else
      -- Explicit files/replies are immediately available as read-only buffers.
      for _, source in ipairs(manifest.sources) do M.open(source.id) end
      M.open(manifest.sources[1].id)
    end
  end
  api.nvim_exec_autocmds("User", { pattern = "PiReviewReady" })
end
return M
