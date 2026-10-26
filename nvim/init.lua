-- Added after the user's normal init.lua and plugins; do not replace their settings.
vim.opt.runtimepath:prepend(vim.env.PI_REVIEW_RUNTIME .. "/nvim")

local function start()
  local ok, err = pcall(function() require("pi_review").start(vim.env.PI_REVIEW_MANIFEST) end)
  if not ok then
    vim.api.nvim_err_writeln("/re: " .. tostring(err))
    vim.cmd("cquit 1")
  end
end

-- Run after the user's synchronous startup hooks, without deferring the review
-- to a later tick that could first draw the welcome buffer.
if vim.v.vim_did_enter == 1 then
  start()
else
  vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    nested = true, -- Opening sources must still trigger FileType/BufEnter/User hooks.
    callback = start,
  })
end
