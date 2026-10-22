import { REVIEW_VIM_KEYMAPS, reviewVimBufferSettings } from "./core.ts";

/** Reuse the single-buffer settings and mappings, but keep one save handler per file. */
export function fileWorkspaceVimScript(directory: string): string {
	const settings = reviewVimBufferSettings("auto");
	const mappings = REVIEW_VIM_KEYMAPS;
	return `scriptencoding utf-8
set encoding=utf-8
set nocompatible
let s:saved_cpo = &cpoptions
set cpoptions&vim
set hidden
let s:workspace = ${JSON.stringify(directory)}
let s:manifest = json_decode(join(readfile(s:workspace . '/manifest.json'), "\\n"))
let s:files = s:manifest.files
let s:tree_buf = -1
let s:tree_win = -1
let s:edit_win = -1
let s:sequence = 0
let s:closed = {}
let s:line_rows = {}
for row in s:manifest.rows
  if row.directory && row.depth > 0
    let s:closed[row.key] = 1
  endif
endfor

function! s:ReviewCommand() abort
  if getcmdtype() ==# ':' && index(['q', 'q!', 'quit', 'quit!', 'qa', 'qa!', 'qall', 'qall!'], trim(getcmdline())) >= 0
    return "\\<C-E>\\<C-U>qall!\\<CR>"
  endif
  return "\\<CR>"
endfunction

function! s:Saved(buffer) abort
  let id = getbufvar(a:buffer, 'reply_to_ai_id', -1)
  if id >= 0 && writefile(getbufline(a:buffer, 1, '$'), s:files[id].saved) != 0
    throw 'Could not save file review snapshot.'
  endif
endfunction

function! s:PathKey(path) abort
  let path = tr(resolve(a:path), nr2char(92), '/')
  return has('win32') || has('win64') ? tolower(path) : path
endfunction

function! s:SetupBuffer() abort
  if exists('b:reply_to_ai_id')
    return
  endif
  let current = s:PathKey(expand('%:p'))
  for item in s:files
    if current ==# s:PathKey(item.copy)
      let b:reply_to_ai_id = item.id
      let saved_cpo = &cpoptions
      set cpoptions&vim
      setlocal modifiable noreadonly
${settings}
      let &l:statusline = ' %<' . substitute(item.label, '%', '%%', 'g') . ' | Enter: comment | ,a: inline | :wqa send %=%l/%L '
${mappings}
      execute 'autocmd ReplyToAiFiles BufWritePost,FileWritePost,FileAppendPost <buffer=' . bufnr('%') . '> call ' . expand('<SID>') . 'Saved(' . bufnr('%') . ')'
      let &cpoptions = saved_cpo
      return
    endif
  endfor
endfunction

function! s:LoadCopy(id) abort
  if filereadable(s:files[a:id].copy)
    return 1
  endif
  let s:sequence += 1
  let response_file = s:workspace . '/response.json'
  call delete(response_file)
  call writefile([json_encode({'sequence': s:sequence, 'id': a:id})], s:workspace . '/request.json')
  let started = reltime()
  echo 'Loading ' . s:files[a:id].label
  redraw
  while reltimefloat(reltime(started)) < 30
    if filereadable(response_file)
      try
        let response = json_decode(join(readfile(response_file), "\\n"))
        if response.sequence == s:sequence
          if has_key(response, 'error')
            echohl ErrorMsg
            echomsg response.error
            echohl None
            return 0
          endif
          return 1
        endif
      catch
        " The atomic response may have been replaced while checking it.
      endtry
    endif
    sleep 10m
  endwhile
  echohl ErrorMsg
  echomsg 'Timed out loading the review copy. Return to Pi and try again.'
  echohl None
  return 0
endfunction

function! s:RenderTree() abort
  let cursor_line = line('.')
  let lines = ['reply-to-ai files', 'Enter: expand/open | :wqa save/quit | :q quit', '']
  let s:line_rows = {}
  for row in s:manifest.rows
    let visible = 1
    for parent in row.parents
      if has_key(s:closed, parent)
        let visible = 0
        break
      endif
    endfor
    if visible
      call add(lines, repeat('  ', row.depth) . (row.directory ? (has_key(s:closed, row.key) ? '+ ' : '- ') : '  ') . row.label)
      let s:line_rows[len(lines)] = row
    endif
  endfor
  setlocal modifiable noreadonly
  silent %delete _
  call setline(1, lines)
  setlocal nomodified nomodifiable readonly
  call cursor(min([cursor_line, len(lines)]), 1)
endfunction

function! s:OpenTreeRow() abort
  if !has_key(s:line_rows, line('.'))
    return
  endif
  let row = s:line_rows[line('.')]
  if row.directory
    if has_key(s:closed, row.key)
      call remove(s:closed, row.key)
    else
      let s:closed[row.key] = 1
    endif
    call s:RenderTree()
    return
  endif
  let item = s:files[row.id]
  if !s:LoadCopy(row.id)
    return
  endif
  if !win_gotoid(s:edit_win)
    rightbelow vnew
    let s:edit_win = win_getid()
  endif
  execute 'edit ' . fnameescape(item.copy)
  call s:SetupBuffer()
endfunction

function! s:ShowTree() abort
  let saved_cpo = &cpoptions
  set cpoptions&vim
  if !win_gotoid(s:tree_win)
    if exists('b:reply_to_ai_id')
      let s:edit_win = win_getid()
    endif
    leftabove vnew
    let s:tree_win = win_getid()
    if bufexists(s:tree_buf)
      execute 'buffer ' . s:tree_buf
    else
      let s:tree_buf = bufnr('%')
      file [reply-to-ai-files]
    endif
  endif
  setlocal buftype=nofile bufhidden=hide noswapfile nobuflisted nowrap nonumber norelativenumber
  let &l:statusline = ' Files | Enter: expand/open | :wqa save and quit '
  nnoremap <buffer> <CR> :call <SID>OpenTreeRow()<CR>
  nnoremap <buffer> o :call <SID>OpenTreeRow()<CR>
  nnoremap <buffer> q :qall!<CR>
  cnoremap <buffer> <expr> <CR> <SID>ReviewCommand()
  vertical resize 36
  call s:RenderTree()
  let &cpoptions = saved_cpo
endfunction
command! ReTree call <SID>ShowTree()
augroup ReplyToAiFiles
  autocmd!
  autocmd BufEnter * call <SID>SetupBuffer()
augroup END

if s:manifest.tree
  let s:tree_buf = bufnr('%')
  let s:tree_win = win_getid()
  file [reply-to-ai-files]
  rightbelow vnew
  let s:edit_win = win_getid()
  setlocal buftype=nofile bufhidden=wipe noswapfile nobuflisted
  call setline(1, 'Choose a file from the tree. Original files are never opened for editing.')
  setlocal nomodified nomodifiable readonly
  call s:ShowTree()
  call cursor(4, 1)
else
  tabdo call s:SetupBuffer()
  tabfirst
endif
let &cpoptions = s:saved_cpo
`;
}
