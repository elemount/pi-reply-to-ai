-- Added after the user's normal init.lua and plugins; do not replace their settings.
vim.opt.runtimepath:prepend(vim.env.PI_REVIEW_RUNTIME .. "/nvim")

local function start()
  local ok, err = pcall(function() require("pi_review").start(vim.env.PI_REVIEW_MANIFEST) end)
  if not ok then
    vim.api.nvim_err_writeln("/re: " .. tostring(err))
    vim.cmd("cquit 1")
  end
end

-- Let the user's startup hooks finish before opening the review.
if vim.v.vim_did_enter == 1 then
  vim.schedule(start)
else
  vim.api.nvim_create_autocmd("VimEnter", {
    once = true,
    callback = function() vim.schedule(start) end,
  })
end
