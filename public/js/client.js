/* Client dashboard: own files (read/download) + mailbox to send documents to the office */
(function () {
  const t = window.__t, UI = window.UI;
  const esc = UI.esc;

  let me = null;
  let files = [], sent = [];
  let q = '', folderSel = '';
  let pending = [];
  let chatMessages = [];
  let folders = [];

  const state = { ready: false };

  async function init() {
    try { await UI.boot('client'); } catch { return; }
    UI.bindTopActions();
    await UI.loadBrand();
    await refresh();
    state.ready = true;
    window.__onLangChange = () => { UI.loadBrand(); render(); renderSent(); renderPending(); };
  }

  async function refresh() {
    try {
      const d = await UI.api('/me');
      me = d.user; files = d.files || []; sent = d.sent || []; folders = orderFolders(d.folders || []); files = orderFilesByFolder(files, folders);
      await loadChat();
      render(); renderSent();
    } catch (e) { UI.errToast(e); }
  }


  function orderFolders(list) {
    const byParent = new Map();
    list.forEach(f => { const key = f.parent_id == null ? 'root' : String(f.parent_id); if (!byParent.has(key)) byParent.set(key, []); byParent.get(key).push(f); });
    for (const arr of byParent.values()) arr.sort((a,b) => (Number(a.sort_order)||0)-(Number(b.sort_order)||0) || String(a.name).localeCompare(String(b.name)));
    const out=[];
    function walk(parent){ const key=parent==null?'root':String(parent); for(const f of (byParent.get(key)||[])){ out.push(f); walk(f.id); } }
    walk(null); return out;
  }
  function orderFilesByFolder(list, folderList) {
    const rank=new Map(folderList.map((f,i)=>[String(f.id),i]));
    return [...list].sort((a,b)=>(rank.get(String(a.folder_id)) ?? 999999)-(rank.get(String(b.folder_id)) ?? 999999) || String(a.name).localeCompare(String(b.name)));
  }

  const myName = () => (window.I18N.lang === 'ar' && me && me.name_ar) ? me.name_ar : (me ? me.name : '');

  function directChildFolders(parentId) {
    const pid = parentId == null ? null : String(parentId);
    return folders
      .filter((f) => (f.parent_id == null ? null : String(f.parent_id)) === pid)
      .sort((a, b) => (Number(a.sort_order) || 0) - (Number(b.sort_order) || 0) || String(a.name).localeCompare(String(b.name)));
  }

  function directFiles(parentId) {
    const pid = parentId == null ? null : String(parentId);
    return files
      .filter((f) => (f.folder_id == null ? null : String(f.folder_id)) === pid)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  function folderRowHtml(f, compact = false) {
    const count = Number(f.file_count) || 0;
    return `
      <button type="button" class="frow client-folder-row" data-folder-open="${esc(f.id)}" title="${esc(t('open_folder'))}" style="width:100%;text-align:start;border:0;background:transparent;cursor:pointer">
        <div class="f-ico">${UI.icon('folder')}</div>
        <div class="f-main">
          <div class="f-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="f-meta"><span class="tag blue">${esc(t('folder_type'))}</span> · ${count} ${esc(t('files_count'))}</div>
        </div>
        <span class="btn ghost sm">${UI.icon('eye')}<span>${esc(t('open_folder'))}</span></span>
      </button>`;
  }

  function fileRowHtml(f) {
    return `
      <div class="frow" data-id="${f.id}">
        <div class="f-ico">${UI.icon('file')}</div>
        <div class="f-main">
          <div class="f-name" title="${esc(f.name)}">${esc(f.name)}</div>
          <div class="f-meta">${window.I18N.fmtSize(f.size)} · ${esc(window.I18N.fmtDate(f.created_at))}${f.folder ? `<span class="tag blue">${esc(f.folder)}</span>` : ''}</div>
        </div>
        <a class="btn ghost sm" href="/api/file/${f.id}/download" download>${UI.icon('download')}<span>${esc(t('download'))}</span></a>
      </div>`;
  }

  function wireFolderRows(root = document) {
    root.querySelectorAll('[data-folder-open]').forEach((b) => {
      b.onclick = () => openClientFolderModal(Number(b.dataset.folderOpen));
    });
  }

  function openClientFolderModal(folderId) {
    const folder = folders.find((f) => Number(f.id) === Number(folderId));
    if (!folder) return;
    const children = directChildFolders(folder.id);
    const inside = directFiles(folder.id);
    const rows = [...children.map((f) => folderRowHtml(f, true)), ...inside.map(fileRowHtml)].join('');
    const path = [];
    let cur = folder;
    while (cur) { path.unshift(cur); cur = cur.parent_id == null ? null : folders.find(x => Number(x.id) === Number(cur.parent_id)); }
    UI.openModal(`
      <div class="modal-head">
        <div><h2>${UI.icon('folder')} ${esc(folder.name)}</h2><p class="sub">${path.map(x => esc(x.name)).join(' / ')} · ${esc(t('folder_contents'))}</p></div>
        <button class="iconbtn" id="clientFolderClose">${UI.icon('x')}</button>
      </div>
      <div class="filelist" id="clientFolderContents" style="max-height:55vh;overflow:auto">
        ${rows || `<div class="muted" style="padding:20px;text-align:center">${esc(t('no_folder_contents'))}</div>`}
      </div>
      <div class="modal-foot"><button class="btn ghost" id="clientFolderCloseBtn">${esc(t('close'))}</button></div>`, { wide: true });
    document.getElementById('clientFolderClose').onclick = () => UI.closeModal();
    document.getElementById('clientFolderCloseBtn').onclick = () => UI.closeModal();
    wireFolderRows(document.getElementById('clientFolderContents'));
  }

  function render() {
    if (!me) return;
    document.getElementById('meName').textContent = myName();
    document.getElementById('stCount').textContent = files.length;

    // Only root folders are shown as the main folder chips. Subfolders are shown
    // inside their parent as file-like rows with a clear "Folder" type.
    const rootFolders = directChildFolders(null);
    const chips = document.getElementById('myFolderChips');
    chips.innerHTML = rootFolders.length
      ? [`<button class="fchip ${!folderSel ? 'active' : ''}" data-f="">${esc(t('all'))}</button>`]
          .concat(rootFolders.map((f) => `<button class="fchip ${String(folderSel) === String(f.id) ? 'active' : ''}" data-f="${f.id}">${UI.icon('folder')} ${esc(f.name)} <span class="muted folder-count">${Number(f.file_count)||0} ${esc(t('files_count'))}</span></button>`)).join('')
      : '';
    chips.querySelectorAll('.fchip').forEach((b) => (b.onclick = () => { folderSel = b.dataset.f === folderSel ? '' : b.dataset.f; render(); }));

    const selectedParent = folderSel ? Number(folderSel) : null;
    const visibleFolders = directChildFolders(selectedParent);
    const shown = directFiles(selectedParent).filter((f) => !q.trim() || f.name.toLowerCase().includes(q.trim().toLowerCase()));
    const box = document.getElementById('myFiles');
    const empty = document.getElementById('myEmpty');

    const folderRows = visibleFolders.map((f) => folderRowHtml(f)).join('');
    const fileRows = shown.map(fileRowHtml).join('');
    if (!folderRows && !fileRows) {
      box.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `<div class="big"><svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5ZM7 12h10v1.6H7V12Zm0 3.4h10V17H7v-1.6Z"/></svg></div>${esc(files.length ? t('all_files_empty') : t('no_files_client'))}`;
      return;
    }
    empty.hidden = true;
    box.innerHTML = folderRows + fileRows;
    wireFolderRows(box);
  }

  function renderSent() {
    const el = document.getElementById('sentList');
    if (!sent.length) { el.innerHTML = `<li class="muted" style="border-style:dashed">${esc(t('no_sent'))}</li>`; return; }
    el.innerHTML = sent.map((s) => `
      <li data-id="${s.id}">
        ${UI.icon('upload')}
        <span class="nm" title="${esc(s.name)}">${esc(s.name)}</span>
        <span class="when">${esc(window.I18N.fmtDate(s.created_at))}</span>
        ${s.is_read
          ? `<span class="tag green">${esc(t('sent_read'))}</span>`
          : `<span class="tag gold">${esc(t('sent_pending'))}</span><button class="iconbtn danger" data-rm="${s.id}" title="${esc(t('remove'))}">${UI.icon('trash')}</button>`}
      </li>`).join('');
    el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = async () => {
      if (!(await UI.confirmBox(t('remove_sent_confirm')))) return;
      try { await UI.api('/me/sent/' + b.dataset.rm, { method: 'DELETE' }); UI.toast(t('deleted'), 'ok'); refresh(); }
      catch (e) { UI.errToast(e); refresh(); }
    }));
  }

  /* ------------------------------ send mailbox ------------------------------ */
  const drop = document.getElementById('sendDrop');
  const input = document.getElementById('sendInput');
  UI.wireDropzone(drop, input, (fl) => {
    const ok = UI.clientCheckFiles(fl);
    for (const f of ok) {
      if (pending.some((p) => p.name === f.name && p.size === f.size)) continue;
      pending.push(f);
    }
    renderPending();
  });

  function renderPending() {
    const ul = document.getElementById('pendList');
    ul.innerHTML = pending.map((f, i) => `
      <li><span>${UI.icon('file')}</span><span class="nm" title="${esc(f.name)}">${esc(f.name)}</span>
      <span class="muted">${window.I18N.fmtSize(f.size)}</span><button class="rm" data-i="${i}" title="${esc(t('remove'))}">✕</button></li>`).join('');
    ul.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { pending.splice(+b.dataset.i, 1); renderPending(); }));
    document.getElementById('sendBtn').disabled = pending.length === 0;
  }

  document.getElementById('sendBtn').onclick = async () => {
    if (!pending.length) return;
    const btn = document.getElementById('sendBtn');
    btn.disabled = true;
    const fd = new FormData();
    for (const f of pending) fd.append('files', f);
    const note = document.getElementById('sendNote').value.trim();
    if (note) fd.append('note', note);
    try {
      await UI.api('/me/send', { method: 'POST', body: fd, loadingMessage: t('uploading') });
      UI.toast(t('send_ok'), 'ok');
      pending = []; renderPending();
      document.getElementById('sendNote').value = '';
      refresh();
    } catch (e) { UI.errToast(e); }
    btn.disabled = pending.length === 0;
  };

  document.getElementById('mySearch').addEventListener('input', (e) => { q = e.target.value; render(); });

  async function loadChat(){ try{ const d=await UI.api('/chat/'+me.id,{csrf:false}); chatMessages=d.messages||[]; renderChat(); }catch(e){ UI.errToast(e); } }
  function renderChat(){ const el=document.getElementById('chatList'); if(!el)return; el.innerHTML=chatMessages.length?chatMessages.map(m=>{const sender=m.sender_role==='client'?myName():(window.I18N.lang==='ar'&&m.sender_name_ar?m.sender_name_ar:(m.sender_name||t('office_panel'))); return `<div style="padding:9px 11px;border-radius:10px;background:${m.sender_role==='client'?'var(--line-soft)':'#fff'};border:1px solid var(--line);align-self:${m.sender_role==='client'?'flex-end':'flex-start'};max-width:80%"><b>${esc(sender)}</b><div>${esc(m.message)}</div><small class="muted">${esc(window.I18N.fmtDate(m.created_at))}</small></div>`;}).join(''):`<div class="muted">${esc(t('no_messages_today'))}</div>`; el.scrollTop=el.scrollHeight; }
  document.getElementById('chatSend').onclick=async()=>{const input=document.getElementById('chatInput');const message=input.value.trim();if(!message)return;try{await UI.api('/chat/'+me.id,{method:'POST',body:{message},loadingMessage:t('sending')});input.value='';await loadChat();}catch(e){UI.errToast(e);}};
  document.getElementById('chatInput').addEventListener('keydown',e=>{if(e.key==='Enter')document.getElementById('chatSend').click();});

  init();
})();
