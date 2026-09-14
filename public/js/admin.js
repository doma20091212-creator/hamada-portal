/* Office panel: clients & folders, inbox (mailbox), all files */
(function () {
  const t = window.__t, UI = window.UI;
  const esc = UI.esc;

  const S = {
    tab: 'clients',
    clients: [],
    inbox: [],
    files: [],
    clientQ: '',
    fileQ: '',
    fileClient: '',
    folderView: null,      // {client, files, folders}
    folderFilter: '',
    pending: [],
  };

  async function init() {
    try { await UI.boot('admin'); } catch { return; }
    UI.bindTopActions();
    const nm = document.getElementById('sideName');
    if (nm) nm.textContent = window.APP.user.name;

    document.querySelectorAll('.navlink').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    document.getElementById('addClientBtn').onclick = () => clientFormModal(null);

    let d1; document.getElementById('clientSearch').addEventListener('input', (e) => { S.clientQ = e.target.value; clearTimeout(d1); d1 = setTimeout(renderClients, 180); });
    let d2; document.getElementById('fileSearch').addEventListener('input', (e) => { S.fileQ = e.target.value; clearTimeout(d2); d2 = setTimeout(loadAllFiles, 300); });
    document.getElementById('fileClientFilter').addEventListener('change', (e) => { S.fileClient = e.target.value; loadAllFiles(); });

    window.__onLangChange = () => render();
    await refreshAll();
  }

  async function refreshAll() {
    await Promise.all([loadStats(), loadClients()]);
    render();
  }

  function setTab(tab) {
    S.tab = tab;
    document.querySelectorAll('.navlink').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
    render();
  }

  const TAB_TITLE = () => ({ clients: t('clients'), inbox: t('inbox'), files: t('all_files') })[S.tab];

  function render() {
    document.getElementById('pageTitle').textContent = TAB_TITLE();
    document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + S.tab));
    if (S.tab === 'clients') renderClients();
    if (S.tab === 'inbox') renderInbox();
    if (S.tab === 'files') { refreshClientFilter(); renderFiles(); }
  }

  /* --------------------------------- stats ---------------------------------- */
  async function loadStats() {
    try {
      const d = await UI.api('/admin/overview');
      const s = d.stats;
      document.getElementById('stClients').textContent = s.clients;
      document.getElementById('stFiles').textContent = s.files;
      document.getElementById('stUnread').textContent = s.unread;
      document.getElementById('stBytes').textContent = window.I18N.fmtSize(s.bytes);
      const badge = document.getElementById('inboxBadge');
      badge.hidden = !s.unread;
      badge.textContent = s.unread > 99 ? '99+' : s.unread;
    } catch (e) { UI.errToast(e); }
  }

  /* -------------------------------- clients ----------------------------------- */
  async function loadClients() {
    try { S.clients = (await UI.api('/admin/clients')).clients || []; }
    catch (e) { UI.errToast(e); }
  }

  const cname = (c) => (window.I18N.lang === 'ar' && c.name_ar) ? c.name_ar : c.name;

  function renderClients() {
    const q = S.clientQ.trim().toLowerCase();
    const rows = S.clients.filter((c) => !q || [c.name, c.name_ar, c.email, c.phone].join(' ').toLowerCase().includes(q));
    const tbl = document.getElementById('clientsTbl');
    const empty = document.getElementById('clientsEmpty');
    if (!rows.length) {
      tbl.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `<div class="big"><svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9a7 7 0 0 1 14 0v1H2v-1Zm16-9.5a3.5 3.5 0 1 0-2.2-6.28A5 5 0 0 1 17 9.5h1Zm-1 9.5a6 6 0 0 0-2.4-4.8A8 8 0 0 1 22 20v1h-6v-.5Z"/></svg></div>${esc(S.clients.length ? t('all_files_empty') : t('no_clients'))}`;
      return;
    }
    empty.hidden = true;
    tbl.innerHTML = `
      <thead><tr>
        <th>${esc(t('client'))}</th><th>${esc(t('contact'))}</th><th>${esc(t('files'))}</th>
        <th>${esc(t('size'))}</th><th>${esc(t('last_activity'))}</th><th></th>
      </tr></thead>
      <tbody>${rows.map((c) => `
        <tr data-id="${c.id}">
          <td>
            <div class="cell-main">${esc(cname(c))} ${c.active ? '' : `<span class="tag red">${esc(t('disabled'))}</span>`}</div>
            ${c.name_ar && cname(c) === c.name ? `<div class="cell-sub">${esc(c.name_ar)}</div>` : ''}
          </td>
          <td><div>${esc(c.email)}</div><div class="cell-sub">${esc(c.phone)}</div></td>
          <td>${c.nfiles}</td>
          <td>${esc(window.I18N.fmtSize(c.bytes))}</td>
          <td class="cell-sub">${esc(window.I18N.fmtDate(c.last_upload))}</td>
          <td><div class="row-actions">
            <button class="iconbtn" data-act="folder" title="${esc(t('open_folder'))}">${UI.icon('eye')}</button>
            <button class="iconbtn" data-act="edit" title="${esc(t('edit'))}">${UI.icon('pencil')}</button>
            <button class="iconbtn" data-act="reset" title="${esc(t('reset_password'))}">${UI.icon('key')}</button>
            <button class="iconbtn danger" data-act="del" title="${esc(t('remove'))}">${UI.icon('trash')}</button>
          </div></td>
        </tr>`).join('')}</tbody>`;

    tbl.querySelectorAll('tbody [data-act]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const id = +b.closest('tr').dataset.id;
      const c = S.clients.find((x) => x.id === id);
      if (b.dataset.act === 'folder') openFolder(id);
      if (b.dataset.act === 'edit') clientFormModal(c);
      if (b.dataset.act === 'reset') resetPw(c);
      if (b.dataset.act === 'del') delClient(c);
    }));
    tbl.querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => openFolder(+tr.dataset.id)));
  }

  async function resetPw(c) {
    if (!(await UI.confirmBox(`${esc(cname(c))} — ${esc(t('reset_password'))}?`, false))) return;
    try {
      const r = await UI.api('/admin/clients/' + c.id + '/reset', { method: 'POST', body: {} });
      infoModal(t('reset_done'), `<b>${esc(r.initial_password)}</b>`);
    } catch (e) { UI.errToast(e); }
  }

  async function delClient(c) {
    if (!(await UI.confirmBox(`${t('delete_client_confirm')} (${esc(cname(c))})`))) return;
    try {
      await UI.api('/admin/clients/' + c.id, { method: 'DELETE' });
      UI.toast(t('client_deleted'), 'ok');
      await refreshAll();
    } catch (e) { UI.errToast(e); }
  }

  function clientFormModal(c) {
    const isEdit = !!c;
    const html = `
      <h2>${esc(isEdit ? t('edit_client_title') : t('add_client_title'))}</h2>
      <div class="grid2">
        <label class="field"><span>${esc(t('name_en'))}</span><input class="input" id="fName" maxlength="80" value="${c ? esc(c.name) : ''}" required></label>
        <label class="field"><span>${esc(t('name_ar'))}</span><input class="input" id="fNameAr" dir="rtl" maxlength="80" value="${c ? esc(c.name_ar || '') : ''}"></label>
        <label class="field"><span>${esc(t('email'))}</span><input class="input" id="fEmail" type="email" maxlength="254" value="${c ? esc(c.email) : ''}" required></label>
        <label class="field"><span>${esc(t('phone'))}</span><input class="input" id="fPhone" dir="ltr" maxlength="20" value="${c ? esc(c.phone) : ''}" required placeholder="01xxxxxxxxx"></label>
      </div>
      ${isEdit ? `<label class="check"><input type="checkbox" id="fActive" ${c.active ? 'checked' : ''}> ${esc(t('active'))}</label>`
        : `<label class="field"><span>${esc(t('initial_password'))}</span><input class="input" id="fPw" type="text" minlength="8" maxlength="120" autocomplete="off"></label>
           <p class="muted" style="margin-block:-.4rem 0">${esc(t('initial_password_hint'))}</p>`}
      <div class="form-error" id="fErr" hidden></div>
      <div class="modal-foot">
        <button class="btn ghost" id="fCancel">${esc(t('cancel'))}</button>
        <button class="btn primary" id="fSave">${esc(isEdit ? t('save') : t('create'))}</button>
      </div>`;
    UI.openModal(html);
    const err = document.getElementById('fErr');
    document.getElementById('fCancel').onclick = () => UI.closeModal();
    document.getElementById('fSave').onclick = async () => {
      err.hidden = true;
      const body = {
        name: document.getElementById('fName').value.trim(),
        name_ar: document.getElementById('fNameAr').value.trim(),
        email: document.getElementById('fEmail').value.trim(),
        phone: document.getElementById('fPhone').value.trim(),
      };
      if (isEdit) body.active = document.getElementById('fActive').checked ? 1 : 0;
      else { const pw = document.getElementById('fPw').value; if (pw) body.password = pw; }
      try {
        if (isEdit) await UI.api('/admin/clients/' + c.id, { method: 'PUT', body });
        else {
          const r = await UI.api('/admin/clients', { method: 'POST', body });
          UI.closeModal();
          if (r.used_phone_as_password) infoModal(t('client_created'), `<b>${esc(body.phone.trim())}</b>`);
          else UI.toast(t('saved'), 'ok');
        }
        await refreshAll();
      } catch (e) {
        err.textContent = t('err_' + (e.code || 'server_error'));
        err.hidden = false;
      }
    };
  }

  function infoModal(title, bodyHtml) {
    UI.openModal(`
      <div class="info-block">${title}${bodyHtml}</div>
      <p class="muted" style="margin-block-end:2px">${esc(t('initial_password_hint'))}</p>
      <div class="modal-foot"><button class="btn primary" id="imOk">${esc(t('close'))}</button></div>`);
    document.getElementById('imOk').onclick = () => UI.closeModal();
  }

  /* ------------------------------ folder modal -------------------------------- */
  async function openFolder(id) {
    try {
      S.folderView = await UI.api('/admin/client-folders/' + id);
      S.folderFilter = ''; S.pending = [];
      const entry = renderFolderModal();
      if (entry) entry.onClose = () => { S.folderView = null; S.pending = []; };
    }
    catch (e) { UI.errToast(e); }
  }

  function renderFolderModal() {
    const { client, files, folders } = S.folderView;
    const html = `
      <div class="modal-head">
        <div>
          <h2>${UI.icon('folder')} ${esc(cname(client))}</h2>
          <p class="sub">${esc(client.email)} · ${esc(client.phone)}</p>
        </div>
        <button class="iconbtn" id="fmX">${UI.icon('x')}</button>
      </div>
      <div class="dropzone" id="fmDrop" tabindex="0">
        <svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 3 6.5 8.5 7.9 9.9 11 6.8V16h2V6.8l3.1 3.1 1.4-1.4L12 3ZM5 18v3h14v-3h-2v1H7v-1H5Z"/></svg>
        <p class="dz-big">${esc(t('upload_here'))}</p>
        <p class="muted">${esc(t('upload_hint'))}</p>
        <input type="file" id="fmInput" multiple hidden accept=".pdf,.doc,.docx,.xls,.xlsx,.xlsm,.csv,.txt,.rtf,.odt,.ods,.ppt,.pptx,.zip,.rar,.7z,.jpg,.jpeg,.png,.webp,.gif,.heic,.tif,.tiff">
      </div>
      <ul class="pendlist" id="fmPend"></ul>
      <div class="grid2" style="align-items:end">
        <label class="field"><span>${esc(t('subfolder'))}</span><input class="input" id="fmFolder" maxlength="60" list="fmFolders" placeholder="${esc(t('subfolder_ph'))}"></label>
        <button class="btn primary" id="fmUpload" style="margin-block-end:.95rem" disabled>${UI.icon('upload')} ${esc(t('upload'))}</button>
      </div>
      <datalist id="fmFolders">${folders.map((f) => `<option value="${esc(f)}">`).join('')}</datalist>
      <div class="folder-chips" id="fmChips" style="margin-block:4px 8px"></div>
      <table class="tbl" id="fmTbl"></table>
      <div class="empty" id="fmEmpty" hidden><div class="big"><svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M3 5h6l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 4v10h18V9H3Z"/></svg></div>${esc(t('no_files_client'))}</div>`;
    const entry = UI.openModal(html, { wide: true });
    entry.box.querySelector('#fmX').onclick = () => UI.closeModal();

    UI.wireDropzone(entry.box.querySelector('#fmDrop'), entry.box.querySelector('#fmInput'), (fl) => {
      for (const f of UI.clientCheckFiles(fl)) S.pending.push(f);
      renderPending();
    });
    function renderPending() {
      const ul = document.getElementById('fmPend');
      ul.innerHTML = S.pending.map((f, i) => `<li><span>${UI.icon('file')}</span><span class="nm">${esc(f.name)}</span><span class="muted">${window.I18N.fmtSize(f.size)}</span><button class="rm" data-i="${i}">✕</button></li>`).join('');
      ul.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => { S.pending.splice(+b.dataset.i, 1); renderPending(); }));
      document.getElementById('fmUpload').disabled = !S.pending.length;
    }
    renderPending();

    document.getElementById('fmUpload').onclick = async () => {
      if (!S.pending.length) return;
      const fd = new FormData();
      for (const f of S.pending) fd.append('files', f);
      const folder = document.getElementById('fmFolder').value.trim();
      if (folder) fd.append('folder', folder);
      const btn = document.getElementById('fmUpload');
      btn.disabled = true;
      try {
        const r = await UI.api(`/admin/clients/${client.id}/files`, { method: 'POST', body: fd });
        UI.toast(`${r.saved} ${t('uploaded_n')}`, 'ok');
        S.pending = [];
        document.getElementById('fmPend').innerHTML = '';
        const d = await UI.api('/admin/client-folders/' + client.id);
        S.folderView = d;
        const dl = document.getElementById('fmFolders');
        if (dl) dl.innerHTML = d.folders.map((f) => `<option value="${esc(f)}">`).join('');
        renderFolderTable();
        await Promise.all([loadStats(), loadClients()]); renderClients();
      } catch (e) { UI.errToast(e); btn.disabled = !S.pending.length; }
    };

    renderFolderTable();
    return entry;
  }

  function renderFolderTable() {
    if (!S.folderView || !document.getElementById('fmTbl')) return;
    const { files, folders } = S.folderView;
    const chips = document.getElementById('fmChips');
    if (folders.length) {
      chips.innerHTML = [`<button class="fchip ${!S.folderFilter ? 'active' : ''}" data-f="">${esc(t('all'))}</button>`]
        .concat(folders.map((f) => `<button class="fchip ${S.folderFilter === f ? 'active' : ''}" data-f="${esc(f)}">${esc(f)}</button>`)).join('');
      chips.querySelectorAll('.fchip').forEach((b) => (b.onclick = () => { S.folderFilter = b.dataset.f; renderFolderTable(); }));
    } else chips.innerHTML = '';
    const shown = files.filter((f) => !S.folderFilter || f.folder === S.folderFilter);
    document.getElementById('fmTbl').innerHTML = fileTableHTML(shown, { showClient: false });
    document.getElementById('fmEmpty').hidden = shown.length > 0;
    wireFolderActions();
  }

  function fileTableHTML(rows, { showClient }) {
    if (!rows.length) return '';
    return `
      <thead><tr>
        <th>${esc(t('file'))}</th>${showClient ? `<th>${esc(t('client'))}</th>` : ''}<th>${esc(t('folder'))}</th>
        <th>${esc(t('size'))}</th><th>${esc(t('date'))}</th><th></th>
      </tr></thead>
      <tbody>${rows.map((f) => `
        <tr data-id="${f.id}">
          <td><div class="cell-main" style="display:flex;gap:.5rem;align-items:center;max-width:340px"><span style="color:var(--navy)">${UI.icon('file')}</span><span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(f.name)}">${esc(f.name)}</span></div></td>
          ${showClient ? `<td class="cell-sub">${esc(f.client_name || '')}</td>` : ''}
          <td>${f.folder ? `<span class="tag blue">${esc(f.folder)}</span>` : '<span class="muted">—</span>'}</td>
          <td class="cell-sub">${esc(window.I18N.fmtSize(f.size))}</td>
          <td class="cell-sub">${esc(window.I18N.fmtDate(f.created_at))}</td>
          <td><div class="row-actions">
            <a class="iconbtn" href="/api/file/${f.id}/download" download title="${esc(t('download'))}">${UI.icon('download')}</a>
            <button class="iconbtn" data-act="rn" title="${esc(t('rename'))}">${UI.icon('pencil')}</button>
            <button class="iconbtn" data-act="mv" title="${esc(t('move'))}">${UI.icon('move')}</button>
            <button class="iconbtn danger" data-act="del" title="${esc(t('remove'))}">${UI.icon('trash')}</button>
          </div></td>
        </tr>`).join('')}</tbody>`;
  }

  const refreshFolder = () => UI.api('/admin/client-folders/' + S.folderView.client.id).then((d) => { S.folderView = d; renderFolderTable(); Promise.all([loadStats(), loadClients()]).then(renderClients); });
  function wireFolderActions() {
    const tbl = document.getElementById('fmTbl');
    tbl.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async (e) => {
      e.stopPropagation();
      const id = +b.closest('tr').dataset.id;
      const f = S.folderView.files.find((x) => x.id === id);
      if (!f) return;
      if (b.dataset.act === 'rn') renameModal(f, refreshFolder);
      if (b.dataset.act === 'mv') moveModal(f, refreshFolder);
      if (b.dataset.act === 'del') delFile(f, refreshFolder);
    }));
  }

  /* ----------------------- rename / move / delete a file ---------------------- */
  function renameModal(f, after) {
    UI.openModal(`
      <h2>${esc(t('rename'))}</h2>
      <p class="sub">${esc(f.name)}</p>
      <label class="field"><span>${esc(t('new_name'))}</span><input class="input" id="rnName" value="${esc(f.name)}"></label>
      <label class="field"><span>${esc(t('subfolder'))}</span><input class="input" id="rnFolder" value="${esc(f.folder || '')}" maxlength="60"></label>
      <div class="modal-foot"><button class="btn ghost" id="rnC">${esc(t('cancel'))}</button><button class="btn primary" id="rnS">${esc(t('save'))}</button></div>`);
    document.getElementById('rnC').onclick = () => UI.closeModal();
    document.getElementById('rnS').onclick = async () => {
      try {
        await UI.api('/admin/files/' + f.id, { method: 'PUT', body: { name: document.getElementById('rnName').value.trim(), folder: document.getElementById('rnFolder').value.trim() } });
        UI.closeModal(); UI.toast(t('saved'), 'ok');
        if (after) after(); else S.tab === 'files' ? loadAllFiles() : renderFolderTable();
      } catch (e) { UI.errToast(e); }
    };
  }

  function moveModal(f, after) {
    const opts = S.clients.map((c) => `<option value="${c.id}" ${c.id === f.client_id ? 'selected' : ''}>${esc(cname(c))}</option>`).join('');
    UI.openModal(`
      <h2>${esc(t('move_title'))}</h2>
      <p class="sub">${esc(f.name)}</p>
      <label class="field"><span>${esc(t('destination'))}</span>
        <select class="input" id="mvClient">${opts}</select></label>
      <label class="field"><span>${esc(t('subfolder'))}</span><input class="input" id="mvFolder" value="${esc(f.folder || '')}" maxlength="60"></label>
      <div class="modal-foot"><button class="btn ghost" id="mvC">${esc(t('cancel'))}</button><button class="btn primary" id="mvS">${esc(t('move'))}</button></div>`);
    document.getElementById('mvC').onclick = () => UI.closeModal();
    document.getElementById('mvS').onclick = async () => {
      try {
        await UI.api('/admin/files/' + f.id, { method: 'PUT', body: {
          client_id: +document.getElementById('mvClient').value,
          folder: document.getElementById('mvFolder').value.trim(),
          inbox: 0,
        } });
        UI.closeModal(); UI.toast(t('moved'), 'ok');
        if (after) after();
        else {
          await Promise.all([loadStats(), loadClients()]);
          render();
          if (S.folderView) refreshFolder();
        }
      } catch (e) { UI.errToast(e); }
    };
  }

  async function delFile(f, after) {
    if (!(await UI.confirmBox(t('delete_file_confirm')))) return;
    try {
      await UI.api('/admin/files/' + f.id, { method: 'DELETE' });
      UI.toast(t('deleted'), 'ok');
      if (after) after();
      else { await Promise.all([loadStats(), loadClients()]); render(); if (S.folderView) refreshFolder(); }
    } catch (e) { UI.errToast(e); }
  }

  /* ---------------------------------- inbox ----------------------------------- */
  async function loadInbox() {
    try { S.inbox = (await UI.api('/admin/inbox')).inbox || []; }
    catch (e) { UI.errToast(e); }
  }

  async function renderInbox() {
    await loadInbox();
    loadStats(); // badge clears after marking read
    const list = document.getElementById('inboxList');
    const empty = document.getElementById('inboxEmpty');
    if (!S.inbox.length) {
      list.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `<div class="big"><svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 10 3.2 3.2H9l1-1h4l1 1h2.8L21 13V5H3v8Z"/></svg></div>${esc(t('no_inbox'))}`;
      return;
    }
    empty.hidden = true;
    list.innerHTML = S.inbox.map((f) => `
      <div class="inbox-item" data-id="${f.id}">
        <div class="inbox-ico">${UI.icon('inbox')}</div>
        <div class="inbox-body">
          <div class="inbox-title">${esc(f.name)} <span class="muted" style="font-weight:400"> · ${esc(window.I18N.fmtSize(f.size))} · ${esc(window.I18N.fmtDate(f.created_at))}</span></div>
          <div class="cell-sub">${esc(t('from'))}: <b>${esc(f.sender_name)}</b> · ${esc(f.sender_email)} · ${esc(f.sender_phone)}</div>
          ${f.note ? `<div class="inbox-note">${esc(f.note)}</div>` : ''}
        </div>
        <div class="inbox-actions">
          <a class="iconbtn" href="/api/file/${f.id}/download" download title="${esc(t('download'))}">${UI.icon('download')}</a>
          <button class="btn sm primary" data-act="save">${esc(t('save_to_folder'))}</button>
          <button class="btn sm danger" data-act="del">${UI.icon('trash')} ${esc(t('discard'))}</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
      const id = +b.closest('.inbox-item').dataset.id;
      const f = S.inbox.find((x) => x.id === id);
      if (!f) return;
      if (b.dataset.act === 'save') moveModal({ ...f, folder: '' }, () => { renderInbox(); loadClients(); loadStats(); });
      if (b.dataset.act === 'del') {
        if (!(await UI.confirmBox(t('delete_file_confirm')))) return;
        try { await UI.api('/admin/files/' + f.id, { method: 'DELETE' }); UI.toast(t('deleted'), 'ok'); renderInbox(); Promise.all([loadStats(), loadClients()]).then(renderClients); }
        catch (e) { UI.errToast(e); }
      }
    }));
  }

  /* -------------------------------- all files ---------------------------------- */
  function refreshClientFilter() {
    const sel = document.getElementById('fileClientFilter');
    const cur = S.fileClient;
    sel.innerHTML = `<option value="">${esc(t('all'))}</option>` + S.clients.map((c) => `<option value="${c.id}" ${String(c.id) === String(cur) ? 'selected' : ''}>${esc(cname(c))}</option>`).join('');
  }

  async function loadAllFiles() {
    const p = new URLSearchParams();
    if (S.fileQ.trim()) p.set('q', S.fileQ.trim());
    if (S.fileClient) p.set('client_id', S.fileClient);
    try { S.files = (await UI.api('/admin/files?' + p.toString())).files || []; renderFiles(); }
    catch (e) { UI.errToast(e); }
  }

  function renderFiles() {
    refreshClientFilter();
    const tbl = document.getElementById('allFilesTbl');
    const empty = document.getElementById('filesEmpty');
    if (!S.files.length) {
      tbl.innerHTML = '';
      empty.hidden = false;
      empty.innerHTML = `<div class="big"><svg viewBox="0 0 24 24" width="34" height="34"><path fill="currentColor" d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5ZM7 12h10v1.6H7V12Zm0 3.4h10V17H7v-1.6Z"/></svg></div>${esc(t('all_files_empty'))}`;
      return;
    }
    empty.hidden = true;
    tbl.innerHTML = fileTableHTML(S.files, { showClient: true });
    tbl.querySelectorAll('[data-act]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const id = +b.closest('tr').dataset.id;
      const f = S.files.find((x) => x.id === id);
      if (!f) return;
      const after = () => { loadAllFiles(); Promise.all([loadStats(), loadClients()]).then(() => renderClients()); if (S.folderView) refreshFolder(); };
      if (b.dataset.act === 'rn') renameModal(f, after);
      if (b.dataset.act === 'mv') moveModal(f, after);
      if (b.dataset.act === 'del') delFile(f, after);
    }));
  }

  init();
})();
