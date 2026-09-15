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
    profile: { is_owner: false, permissions: [] },
    admins: [],
    permissionDefs: [],
  };

  async function init() {
    try { await UI.boot('admin'); } catch { return; }
    UI.bindTopActions();
    const nm = document.getElementById('sideName');
    if (nm) nm.textContent = window.APP.user.name;

    document.querySelectorAll('.navlink').forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
    document.getElementById('addClientBtn').onclick = () => clientFormModal(null);
    const importBtn = document.getElementById('importClientsBtn');
    const importFile = document.getElementById('importClientsFile');
    if (importBtn && importFile) {
      importBtn.onclick = () => importFile.click();
      importFile.onchange = async (e) => {
        const file = e.target.files?.[0]; if (!file) return;
        try {
          const parsed = JSON.parse(await file.text());
          const clients = Array.isArray(parsed) ? parsed : parsed?.clients;
          if (!Array.isArray(clients)) throw { code: 'invalid_import_format' };
          if (!clients.length) throw { code: 'import_no_clients' };
          if (clients.length > 1000) throw { code: 'import_too_large' };
          importClientsModal(clients, file.name);
        } catch (err) { UI.toast(t(err?.code || 'invalid_import_format'), 'err'); }
        finally { importFile.value = ''; }
      };
    }
    const addAdmin = document.getElementById('addAdminBtn'); if (addAdmin) addAdmin.onclick = () => adminFormModal(null);
    const saveSettings = document.getElementById('saveSettingsBtn'); if (saveSettings) saveSettings.onclick = saveSettingsForm;
    const discardAll = document.getElementById('discardAllBtn'); if (discardAll) { discardAll.hidden = !has('delete_files'); discardAll.onclick = discardAllInbox; }
    await loadProfile();

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

  const TAB_TITLE = () => ({ clients: t('clients'), inbox: t('inbox'), files: t('all_files'), admins: t('admins_permissions'), settings: t('portal_settings') })[S.tab] || 'Admin';

  function render() {
    document.getElementById('pageTitle').textContent = TAB_TITLE();
    document.querySelectorAll('.tab').forEach((s) => (s.hidden = s.id !== 'tab-' + S.tab));
    if (S.tab === 'clients') renderClients();
    if (S.tab === 'inbox') renderInbox();
    if (S.tab === 'files') { refreshClientFilter(); renderFiles(); }
    if (S.tab === 'admins') { loadAdmins().then(renderAdmins); }
    if (S.tab === 'settings') { loadSettings(); loadAudit(); }
  }


  async function loadProfile() {
    try {
      S.profile = await UI.api('/admin/profile');
      const owner = !!S.profile.is_owner;
      const adminsNav = document.getElementById('adminsNav'); if (adminsNav) adminsNav.hidden = !owner;
      const settingsNav = document.getElementById('settingsNav'); if (settingsNav) settingsNav.hidden = !owner && !S.profile.permissions.includes('settings');
      const canManageClients = owner || S.profile.permissions.includes('manage_clients');
    const addClient = document.getElementById('addClientBtn'); if (addClient) addClient.hidden = !canManageClients;
    const importClients = document.getElementById('importClientsBtn'); if (importClients) importClients.hidden = !canManageClients;
    } catch (e) { UI.errToast(e); }
  }

  function has(p) { return !!S.profile.is_owner || S.profile.permissions.includes(p); }

  async function loadAdmins() {
    if (!S.profile.is_owner) return;
    try { const d=await UI.api('/admin/admins'); S.admins=d.admins||[]; S.permissionDefs=d.permissions||[]; } catch(e){UI.errToast(e);}
  }

  function fmtExpiry(x){return x?window.I18N.fmtDate(x):t('permanent_access_hint').split('.')[0];}
  function renderAdmins(){
    const tbl=document.getElementById('adminsTbl'), empty=document.getElementById('adminsEmpty'); if(!tbl)return;
    if(!S.admins.length){tbl.innerHTML='';empty.hidden=false;empty.textContent=t('no_admins');return;} empty.hidden=true;
    tbl.innerHTML=`<thead><tr><th>${esc(t('name'))}</th><th>${esc(t('contact'))}</th><th>${esc(t('status'))}</th><th>${esc(t('permissions'))}</th><th>${esc(t('clients_access'))}</th><th></th></tr></thead><tbody>${S.admins.map(a=>{
      const ps=a.is_owner?[t('owner_everything')]:a.permissions.map(p=>`${p.permission_key}${p.expires_at?' · '+fmtExpiry(p.expires_at):''}`);
      return `<tr data-id="${a.id}"><td><div class="cell-main">${esc(a.name)} ${a.is_owner?`<span class="tag gold">${esc(t('owner_everything'))}</span>`:''}</div><div class="cell-sub">${esc(a.name_ar||'')}</div></td><td>${esc(a.email)}<div class="cell-sub">${esc(a.phone)}</div></td><td>${a.active?`<span class="tag green">${esc(t('active_status'))}</span>`:`<span class="tag red">${esc(t('disabled_status'))}</span>`}</td><td>${ps.map(x=>`<span class="tag blue" style="margin:2px">${esc(x)}</span>`).join('')}</td><td>${a.is_owner?esc(t('all')):a.client_access.length}</td><td><div class="row-actions">${a.is_owner?'':`<button class="btn ghost sm" data-act="perm">${esc(t('permissions'))}</button><button class="iconbtn" data-act="edit">${UI.icon('pencil')}</button><button class="iconbtn danger" data-act="del">${UI.icon('trash')}</button>`}</div></td></tr>`;}).join('')}</tbody>`;
    tbl.querySelectorAll('[data-act]').forEach(b=>b.onclick=()=>{const a=S.admins.find(x=>x.id===+b.closest('tr').dataset.id);if(!a)return;if(b.dataset.act==='perm')permissionModal(a);if(b.dataset.act==='edit')adminFormModal(a);if(b.dataset.act==='del')deleteAdmin(a);});
  }

  function adminFormModal(a){
    const edit=!!a; UI.openModal(`<h2>${edit?t('edit_admin'):t('add_admin')}</h2><div class="grid2"><label class="field"><span>${esc(t('name'))}</span><input class="input" id="afName" maxlength="120" value="${edit?esc(a.name):''}"></label><label class="field"><span>${esc(t('arabic_name'))}</span><input class="input" id="afAr" dir="rtl" maxlength="120" value="${edit?esc(a.name_ar||''):''}"></label><label class="field"><span>${esc(t('email'))}</span><input class="input" id="afEmail" type="email" value="${edit?esc(a.email):''}"></label><label class="field"><span>${esc(t('phone'))}</span><input class="input" id="afPhone" value="${edit?esc(a.phone):''}"></label>${edit?`<label class="check"><input id="afActive" type="checkbox" ${a.active?'checked':''}> ${esc(t('active_status'))}</label>`:''}<label class="field"><span>${esc(edit?t('new_password_optional'):t('initial_password_optional'))}</span><input class="input" id="afPw" type="password" minlength="8"></label></div><div class="modal-foot"><button class="btn ghost" id="afCancel">${esc(t('cancel'))}</button><button class="btn primary" id="afSave">${esc(t('save'))}</button></div>`);
    document.getElementById('afCancel').onclick=()=>UI.closeModal(); document.getElementById('afSave').onclick=async()=>{const body={name:afName.value.trim(),name_ar:afAr.value.trim(),email:afEmail.value.trim(),phone:afPhone.value.trim()};const pw=afPw.value.trim();if(pw)body.password=pw;if(edit)body.active=afActive.checked?1:0;try{const r=await UI.api(edit?'/admin/admins/'+a.id:'/admin/admins',{method:edit?'PUT':'POST',body});UI.closeModal();UI.toast(edit?t('saved'):`${t('admin_created')}${r.initial_password}`,'ok');loadAdmins().then(renderAdmins);}catch(e){UI.errToast(e);}};
  }

  function toIsoOrNull(id){const v=document.getElementById(id)?.value;return v?new Date(v).toISOString():null;}
  function permissionModal(a){
    const rows=S.permissionDefs.map(p=>{p.label=t(p.key);const cur=a.permissions.find(x=>x.permission_key===p.key);const ex=cur&&cur.expires_at?new Date(cur.expires_at):null;const val=ex&&!Number.isNaN(ex.getTime())?new Date(ex.getTime()-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';return `<div style="display:grid;grid-template-columns:1fr 220px;gap:10px;align-items:center;border-bottom:1px solid var(--line);padding:9px 0"><label class="check"><input type="checkbox" data-perm="${esc(p.key)}" ${cur?'checked':''}> ${esc(p.label)}</label><input class="input" type="datetime-local" data-exp="${esc(p.key)}" value="${val}" placeholder="${esc(t('permanent_access_hint'))}"></div>`;}).join('');
    const clients=S.clients.map(c=>{const x=a.client_access.find(y=>y.client_id===c.id);return `<label class="check" style="display:flex;gap:8px;margin:5px 0"><input type="checkbox" data-client="${c.id}" ${x?'checked':''}> ${esc(cname(c))}</label>`;}).join('');
    UI.openModal(`<h2>Permissions — ${esc(a.name)}</h2><p class="muted">${esc(t('permanent_access_hint'))}</p><h3>${esc(t('what_admin_do'))}</h3><div>${rows}</div><h3 style="margin-top:18px">${esc(t('which_clients'))}</h3><div style="max-height:220px;overflow:auto">${clients||`<span class="muted">${esc(t('no_clients'))}</span>`}</div><label class="field" style="margin-top:12px"><span>${esc(t('client_access_expires'))}</span><input class="input" id="accessExp" type="datetime-local"></label><div class="modal-foot"><button class="btn ghost" id="pmCancel">${esc(t('cancel'))}</button><button class="btn primary" id="pmSave">${esc(t('save_permissions'))}</button></div>`,{wide:true});
    document.getElementById('pmCancel').onclick=()=>UI.closeModal(); document.getElementById('pmSave').onclick=async()=>{const permissions=[...document.querySelectorAll('[data-perm]:checked')].map(x=>({permission_key:x.dataset.perm,expires_at:document.querySelector(`[data-exp="${x.dataset.perm}"]`)?.value?new Date(document.querySelector(`[data-exp="${x.dataset.perm}"]`).value).toISOString():null}));const accessExp=toIsoOrNull('accessExp');const clients=[...document.querySelectorAll('[data-client]:checked')].map(x=>({client_id:+x.dataset.client,expires_at:accessExp}));try{await UI.api('/admin/admins/'+a.id+'/permissions',{method:'PUT',body:{permissions}});await UI.api('/admin/admins/'+a.id+'/client-access',{method:'PUT',body:{clients}});UI.closeModal();UI.toast(t('permissions_saved'),'ok');loadAdmins().then(renderAdmins);}catch(e){UI.errToast(e);}};
  }

  async function deleteAdmin(a){if(!(await UI.confirmBox(`${t('delete_admin_confirm')} (${a.name})`)))return;try{await UI.api('/admin/admins/'+a.id,{method:'DELETE'});UI.toast(t('admin_deleted'),'ok');loadAdmins().then(renderAdmins);}catch(e){UI.errToast(e);}}

  async function loadSettings(){if(!has('settings'))return;try{const d=await UI.api('/settings');const x=d.settings||{};setNameEn.value=x['brand.name_en']||'';setNameAr.value=x['brand.name_ar']||'';setTagEn.value=x['brand.tagline_en']||'';setTagAr.value=x['brand.tagline_ar']||'';}catch(e){UI.errToast(e);}}
  async function saveSettingsForm(){try{await UI.api('/settings',{method:'PUT',body:{'brand.name_en':setNameEn.value.trim(),'brand.name_ar':setNameAr.value.trim(),'brand.tagline_en':setTagEn.value.trim(),'brand.tagline_ar':setTagAr.value.trim()}});UI.toast(t('saved'),'ok');}catch(e){UI.errToast(e);}}
  async function loadAudit(){const tEl=document.getElementById('auditTbl');if(!tEl||!has('settings'))return;try{const d=await UI.api('/admin/audit');tEl.innerHTML=`<thead><tr><th>${esc(t('date'))}</th><th>${esc(t('name'))}</th><th>${esc(t('actions'))}</th><th>${esc(t('file'))}</th></tr></thead><tbody>${(d.logs||[]).map(x=>`<tr><td class="cell-sub">${esc(window.I18N.fmtDate(x.created_at))}</td><td>${esc(x.actor_name||'System')}</td><td>${esc(x.action)}</td><td>${esc(x.entity_type)} ${esc(x.entity_id||'')}</td></tr>`).join('')}</tbody>`;}catch(e){UI.errToast(e);}}

  /* --------------------------------- stats ---------------------------------- */
  async function loadStats() {
    try {
      const d = await UI.api('/admin/overview');
      const s = d.stats;
      document.getElementById('stClients').textContent = s.clients;
      document.getElementById('stFiles').textContent = s.files;
      document.getElementById('stUnread').textContent = s.inbox_count ?? s.unread;
      document.getElementById('stBytes').textContent = window.I18N.fmtSize(s.bytes);
      const badge = document.getElementById('inboxBadge');
      const inboxCount = s.inbox_count ?? s.unread;
      badge.hidden = !inboxCount;
      badge.textContent = inboxCount > 99 ? '99+' : inboxCount;
    } catch (e) { UI.errToast(e); }
  }

  /* -------------------------------- clients ----------------------------------- */
  function importClientsModal(clients, fileName) {
    const preview = clients.slice(0, 8).map((c, i) => `<tr><td>${i + 1}</td><td><b>${esc(c?.name || '—')}</b>${c?.name_ar ? `<div class="cell-sub">${esc(c.name_ar)}</div>` : ''}</td><td>${esc(c?.email || '—')}</td><td>${esc(c?.phone || '—')}</td></tr>`).join('');
    UI.openModal(`<div class="modal-head"><div><h2>${esc(t('import_clients_title'))}</h2><p class="sub">${esc(fileName)} · ${clients.length} ${esc(t('clients').toLowerCase())}</p></div></div><div class="import-summary"><div><b>${clients.length}</b><span>${esc(t('import_ready'))}</span></div><div><span>${esc(t('import_clients_hint'))}</span></div></div><div class="import-preview"><table class="tbl"><thead><tr><th>#</th><th>${esc(t('client'))}</th><th>${esc(t('email'))}</th><th>${esc(t('phone'))}</th></tr></thead><tbody>${preview}</tbody></table>${clients.length > 8 ? `<div class="import-more">+ ${clients.length - 8} more</div>` : ''}</div><div class="form-error" id="importErr" hidden></div><div class="modal-foot"><button class="btn ghost" id="importCancel">${esc(t('cancel'))}</button><button class="btn primary" id="importRun">${esc(t('import_now'))}</button></div>`, { wide: true });
    const run=document.getElementById('importRun'), err=document.getElementById('importErr');
    document.getElementById('importCancel').onclick=()=>UI.closeModal();
    run.onclick=async()=>{run.disabled=true;run.textContent=t('importing');err.hidden=true;try{const result=await UI.api('/admin/clients/import',{method:'POST',body:{clients}});UI.closeModal();const c=result.counts||{};UI.toast(`${c.created||0} ${t('import_created')} · ${c.skipped||0} ${t('import_skipped')} · ${c.invalid||0} ${t('import_invalid')}`,c.created?'ok':'');await refreshAll();if((c.skipped||0)+(c.invalid||0))importResultsModal(result);}catch(e){run.disabled=false;run.textContent=t('import_now');err.textContent=t('err_'+(e.code||'server_error'));err.hidden=false;}};
  }

  function importResultsModal(result) {
    const skipped=result.skipped||[], invalid=result.invalid||[];
    const reason=x=>x.reason==='email_exists'?t('import_email_exists'):x.reason==='phone_exists'?t('import_phone_exists'):x.reason==='duplicate_in_file'?t('import_duplicate_file'):(x.reasons||[]).map(r=>t('err_'+r)).join(', ');
    const rows=[...skipped,...invalid].slice(0,80).map(x=>`<tr><td>${x.row}</td><td>${esc(x.name||'—')}</td><td>${esc(x.email||'—')}</td><td>${esc(reason(x))}</td></tr>`).join('');
    UI.openModal(`<h2>${esc(t('import_clients_title'))}</h2><p class="sub">${esc(t('import_skipped'))}: ${skipped.length} · ${esc(t('import_invalid'))}: ${invalid.length}</p><div class="import-preview"><table class="tbl"><thead><tr><th>#</th><th>${esc(t('client'))}</th><th>${esc(t('email'))}</th><th>${esc(t('status'))}</th></tr></thead><tbody>${rows}</tbody></table></div><div class="modal-foot"><button class="btn primary" id="importResultClose">${esc(t('close'))}</button></div>`,{wide:true});
    document.getElementById('importResultClose').onclick=()=>UI.closeModal();
  }

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
            ${has('chat') ? `<button class="iconbtn" data-act="chat" title="${esc(t('daily_chat'))}">💬</button>` : ''}
            ${has('manage_clients') ? `<button class="iconbtn" data-act="edit" title="${esc(t('edit'))}">${UI.icon('pencil')}</button>` : ''}
            ${has('manage_clients') ? `<button class="iconbtn" data-act="reset" title="${esc(t('reset_password'))}">${UI.icon('key')}</button><button class="iconbtn danger" data-act="del" title="${esc(t('remove'))}">${UI.icon('trash')}</button>` : ''}
          </div></td>
        </tr>`).join('')}</tbody>`;

    tbl.querySelectorAll('tbody [data-act]').forEach((b) => (b.onclick = (e) => {
      e.stopPropagation();
      const id = +b.closest('tr').dataset.id;
      const c = S.clients.find((x) => x.id === id);
      if (b.dataset.act === 'folder') openFolder(id);
      if (b.dataset.act === 'chat') chatModal(c);
      if (b.dataset.act === 'edit') clientFormModal(c);
      if (b.dataset.act === 'reset') resetPw(c);
      if (b.dataset.act === 'del') delClient(c);
    }));
    tbl.querySelectorAll('tbody tr').forEach((tr) => (tr.onclick = () => openFolder(+tr.dataset.id)));
  }

  async function chatModal(c){
    if(!has('chat'))return;
    let msgs=[]; try{msgs=(await UI.api('/chat/'+c.id,{csrf:false})).messages||[];}catch(e){UI.errToast(e);return;}
    const renderMsgs=(arr)=>arr.length?arr.map(m=>{const sender=m.sender_role==='admin'?(window.I18N.lang==='ar'&&m.sender_name_ar?m.sender_name_ar:(m.sender_name||t('office_panel'))):(window.I18N.lang==='ar'&&c.name_ar?c.name_ar:c.name);return `<div style="align-self:${m.sender_role==='admin'?'flex-end':'flex-start'};max-width:80%;padding:8px 10px;border:1px solid var(--line);border-radius:9px"><b>${esc(sender)}</b><div>${esc(m.message)}</div><small class="muted">${esc(window.I18N.fmtDate(m.created_at))}</small></div>`;}).join(''):`<span class="muted">${esc(t('no_messages_today'))}</span>`;
    UI.openModal(`<h2>${esc(t('daily_chat'))} — ${esc(cname(c))}</h2><p class="muted">${esc(t('chat_resets'))}</p><div id="admChatList" style="height:300px;overflow:auto;display:flex;flex-direction:column;gap:8px;border:1px solid var(--line);padding:10px;border-radius:8px">${renderMsgs(msgs)}</div><div style="display:flex;gap:8px;margin-top:10px"><input class="input" id="admChatInput" maxlength="1000" placeholder="${esc(t('write_message'))}"><button class="btn primary" id="admChatSend">${esc(t('send'))}</button></div><div class="modal-foot"><button class="btn ghost" id="admChatClose">${esc(t('close'))}</button></div>`,{wide:true});
    const box=document.getElementById('admChatList'); box.scrollTop=box.scrollHeight;
    document.getElementById('admChatClose').onclick=()=>UI.closeModal();
    const send=async()=>{const i=document.getElementById('admChatInput'),m=i.value.trim();if(!m)return;try{await UI.api('/chat/'+c.id,{method:'POST',body:{message:m}});i.value='';const d=await UI.api('/chat/'+c.id,{csrf:false});box.innerHTML=renderMsgs(d.messages||[]);box.scrollTop=box.scrollHeight;}catch(e){UI.errToast(e);}};
    document.getElementById('admChatSend').onclick=send; document.getElementById('admChatInput').addEventListener('keydown',e=>{if(e.key==='Enter')send();});
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
        <label class="field"><span>${esc(t('destination_folder'))}</span><select class="input" id="fmFolderId"><option value="">${esc(t('root'))}</option>${(S.folderView.folderTree||[]).map(f=>`<option value="${f.id}">${esc(f.name)} · ${Number(f.file_count)||0} ${esc(t('files_count'))}</option>`).join('')}</select></label>
        <button class="btn primary" id="fmUpload" style="margin-block-end:.95rem" disabled>${UI.icon('upload')} ${esc(t('upload'))}</button>
      </div>
      ${has('manage_folders')?`<button class="btn ghost sm" id="manageFoldersBtn" style="margin-bottom:10px">${esc(t('folders'))}</button>`:''}
      ${(has('manage_clients') || has('manage_folders'))?`<button class="btn ghost sm" id="clientFolderAccessBtn" style="margin:0 0 10px 6px">${esc(t('client_folder_visibility'))}</button>`:''}
      <div id="fmChips" style="margin-block:4px 8px"></div>
      <div id="fmBrowser" class="filelist" style="margin-block:8px 10px"></div>
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
      const folderId = document.getElementById('fmFolderId').value;
      if (folderId) { const node=(S.folderView.folderTree||[]).find(x=>String(x.id)===String(folderId)); fd.append('folder_id',folderId); if(node) fd.append('folder',node.name); }
      const btn = document.getElementById('fmUpload');
      btn.disabled = true;
      try {
        const r = await UI.api(`/admin/clients/${client.id}/files`, { method: 'POST', body: fd, loadingMessage: t('uploading') });
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

    const mfb=document.getElementById('manageFoldersBtn'); if(mfb) mfb.onclick=()=>folderManagerModal(client.id);
    const cvb=document.getElementById('clientFolderAccessBtn'); if(cvb) cvb.onclick=()=>folderVisibilityModal(client.id);
    renderFolderTable();
    return entry;
  }


  async function folderVisibilityModal(clientId){
    try {
      const d=await UI.api('/admin/clients/'+clientId+'/folder-visibility');
      const folders=d.folders||[];
      const roots=folders.filter(f=>!f.parent_id);
      const children=(id)=>folders.filter(f=>f.parent_id===id);
      const tree=(items,level=0)=>items.map(f=>`<label style="display:flex;align-items:center;gap:9px;padding:8px 0 8px ${level*22}px;border-bottom:1px solid var(--line-soft)"><input type="checkbox" class="folder-access-check" data-folder="${f.id}" ${f.selected?'checked':''}><span>${UI.icon('folder')}</span><span style="flex:1"><b>${esc(f.name)}</b><span class="muted" style="margin-left:7px">${Number(f.file_count)||0} ${esc(t('files_count'))}</span></span></label>${tree(children(f.id),level+1)}`).join('');
      UI.openModal(`<h2>${esc(t('client_folder_visibility'))}</h2><p class="muted">${esc(t('visibility_hint'))}</p><label class="check" style="margin:12px 0;display:flex;gap:8px"><input type="checkbox" id="folderAccessRestricted" ${d.restricted?'checked':''}> ${esc(t('restrict_selected'))}</label><div id="folderAccessTree" style="max-height:360px;overflow:auto;border:1px solid var(--line);border-radius:10px;padding:4px 10px">${tree(roots)||`<div class="muted" style="padding:12px">${esc(t('no_folders_exist'))}</div>`}</div><div class="modal-foot"><button class="btn ghost" id="favCancel">${esc(t('cancel'))}</button><button class="btn primary" id="favSave">${esc(t('save_visibility'))}</button></div>`,{wide:true});
      const sync=()=>{const on=document.getElementById('folderAccessRestricted').checked;document.querySelectorAll('.folder-access-check').forEach(x=>x.disabled=!on);};
      document.getElementById('folderAccessRestricted').onchange=sync; sync();
      document.getElementById('favCancel').onclick=()=>UI.closeModal();
      document.getElementById('favSave').onclick=async()=>{
        const restricted=document.getElementById('folderAccessRestricted').checked;
        const folder_ids=[...document.querySelectorAll('.folder-access-check:checked')].map(x=>+x.dataset.folder);
        if(restricted && !folder_ids.length){ if(!(await UI.confirmBox(t('no_folder_selected'))) ) return; }
        try {
          await UI.api('/admin/clients/'+clientId+'/folder-visibility',{method:'PUT',body:{restricted,folder_ids}});
          UI.closeModal(); UI.toast(restricted?t('client_visibility_saved'):t('client_can_see_all'),'ok');
          if(S.folderView && S.folderView.client && S.folderView.client.id===clientId) { S.folderView=await UI.api('/admin/client-folders/'+clientId); renderFolderTable(); }
        } catch(e){UI.errToast(e);}
      };
    } catch(e){UI.errToast(e);}
  }

  async function folderManagerModal(clientId){
    try {
      const d=await UI.api('/admin/clients/'+clientId+'/folders'); const folders=d.folders||[]; const roots=folders.filter(f=>!f.parent_id); const children=(id)=>folders.filter(f=>f.parent_id===id);
      const count=(n)=>`<span class="folder-count">${Number(n)||0} ${esc(t('files_count'))}</span>`;
       const tree=(items,level=0)=>items.map(f=>`<div class="folder-row" draggable="true" data-folder-id="${f.id}" data-folder-parent="${f.parent_id??''}" style="display:flex;align-items:center;gap:8px;padding:8px 0 8px ${level*22}px;border-bottom:1px solid var(--line-soft)"><span class="folder-drag" title="${esc(t('drag_to_reorder'))}" aria-label="${esc(t('drag_to_reorder'))}">⠿</span><span>${UI.icon('folder')}</span><b style="flex:1">${esc(f.name)}</b>${count(f.file_count)}<button class="iconbtn" data-ren="${f.id}" title="${esc(t('rename_folder'))}">${UI.icon('pencil')}</button><button class="iconbtn danger" data-delete="${f.id}" title="${esc(t('remove'))}">${UI.icon('trash')}</button></div>${tree(children(f.id),level+1)}`).join('');
      UI.openModal(`<h2>${esc(t('folders'))}</h2><p class="muted">${esc(t('folder_hint'))}</p><div id="folderTree">${tree(roots)||`<div class="muted">${esc(t('no_folders'))}</div>`}</div><div class="modal-foot"><button class="btn primary" id="newFolderBtn">+ ${esc(t('new_folder'))}</button><button class="btn ghost" id="folderClose">${esc(t('close'))}</button></div>`,{wide:true});
      document.getElementById('folderClose').onclick=()=>UI.closeModal();
      document.getElementById('newFolderBtn').onclick=async()=>{const opts=`<option value="">${esc(t('root'))}</option>`+folders.map(f=>`<option value="${f.id}">${esc(f.name)}</option>`).join('');UI.openModal(`<h2>${esc(t('new_folder'))}</h2><label class="field"><span>${esc(t('name'))}</span><input class="input" id="nfName" maxlength="120"></label><label class="field"><span>${esc(t('inside'))}</span><select class="input" id="nfParent">${opts}</select></label><div class="modal-foot"><button class="btn ghost" id="nfC">${esc(t('cancel'))}</button><button class="btn primary" id="nfS">${esc(t('create'))}</button></div>`);document.getElementById('nfC').onclick=()=>UI.closeModal();document.getElementById('nfS').onclick=async()=>{try{await UI.api('/admin/clients/'+clientId+'/folders',{method:'POST',body:{name:document.getElementById('nfName').value.trim(),parent_id:document.getElementById('nfParent').value||null}});UI.closeModal();UI.closeModal();await openFolder(clientId);}catch(e){UI.errToast(e);}};};
      document.querySelectorAll('[data-ren]').forEach(b=>b.onclick=async()=>{const f=folders.find(x=>x.id===+b.dataset.ren);if(!f)return;UI.openModal(`<h2>${esc(t('rename_folder'))}</h2><label class="field"><span>${esc(t('name'))}</span><input class="input" id="rfName" value="${esc(f.name)}"></label><div class="modal-foot"><button class="btn ghost" id="rfC">${esc(t('cancel'))}</button><button class="btn primary" id="rfS">${esc(t('save'))}</button></div>`);document.getElementById('rfC').onclick=()=>UI.closeModal();document.getElementById('rfS').onclick=async()=>{try{await UI.api('/admin/folders/'+f.id,{method:'PUT',body:{name:document.getElementById('rfName').value.trim()}});UI.closeModal();UI.closeModal();await openFolder(clientId);}catch(e){UI.errToast(e);}};});
      document.querySelectorAll('[data-delete]').forEach(b=>b.onclick=async()=>{
        const f=folders.find(x=>x.id===+b.dataset.delete);
        if(!f)return;
        const ok=await UI.confirmBox(`${t('delete_folder_confirm')}\n\n${f.name}`);
        if(!ok)return;
        try{
          await UI.api('/admin/folders/'+f.id,{method:'DELETE'});
          UI.toast(t('folder_deleted'),'ok');
          if(S.folderFilter && Number(S.folderFilter)===Number(f.id)) S.folderFilter=f.parent_id?String(f.parent_id):'';
          UI.closeModal();
          await folderManagerModal(clientId);
          await openFolder(clientId);
        }catch(e){
          if(e && e.code==='folder_not_empty') UI.toast(t('folder_not_empty'),'err');
          else if(e && e.code==='folder_drive_delete_failed') UI.toast(t('folder_drive_delete_failed'),'err');
          else UI.errToast(e);
        }
      });
      // Drag-and-drop reordering: drag a folder and drop it onto a sibling to place it there.
      let draggedFolderId=null;
      const rows=[...document.querySelectorAll('.folder-row')];
      rows.forEach(row=>{
        row.addEventListener('dragstart',e=>{ draggedFolderId=Number(row.dataset.folderId); row.classList.add('dragging'); if(e.dataTransfer){e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',String(draggedFolderId));} });
        row.addEventListener('dragend',()=>{draggedFolderId=null;rows.forEach(r=>r.classList.remove('dragging','drag-over'));});
        row.addEventListener('dragover',e=>{
          const source=folders.find(x=>x.id===draggedFolderId), target=folders.find(x=>x.id===Number(row.dataset.folderId));
          if(!source || !target || source.id===target.id || (source.parent_id??null)!==(target.parent_id??null)) return;
          e.preventDefault(); if(e.dataTransfer)e.dataTransfer.dropEffect='move'; rows.forEach(r=>r.classList.remove('drag-over')); row.classList.add('drag-over');
        });
        row.addEventListener('dragleave',()=>row.classList.remove('drag-over'));
        row.addEventListener('drop',async e=>{
          e.preventDefault(); row.classList.remove('drag-over');
          const sourceId=draggedFolderId || Number(e.dataTransfer?.getData('text/plain')); const targetId=Number(row.dataset.folderId);
          rows.forEach(r=>r.classList.remove('dragging','drag-over')); if(!sourceId || sourceId===targetId)return;
          const source=folders.find(x=>x.id===sourceId), target=folders.find(x=>x.id===targetId);
          if(!source || !target)return;
          if((source.parent_id??null)!==(target.parent_id??null)){UI.toast(t('drag_same_level'),'error');return;}
          const siblings=folders.filter(x=>(x.parent_id??null)===(source.parent_id??null)).sort((a,b)=>a.sort_order-b.sort_order);
          const from=siblings.findIndex(x=>x.id===sourceId), to=siblings.findIndex(x=>x.id===targetId); if(from<0||to<0)return;
          const [moved]=siblings.splice(from,1); siblings.splice(to,0,moved);
          try{ await UI.api('/admin/folders/reorder',{method:'PUT',body:{items:siblings.map((x,i)=>({id:x.id,sort_order:i+1}))}}); UI.toast(t('folder_order_saved'),'ok'); UI.closeModal(); await folderManagerModal(clientId); }catch(err){UI.errToast(err);}
        });
      });
    }catch(e){UI.errToast(e);}
  }

  function renderFolderTable() {
    if (!S.folderView || !document.getElementById('fmTbl')) return;
    const { files, folders, folderTree } = S.folderView;
    const chips = document.getElementById('fmChips');
    const browser = document.getElementById('fmBrowser');
    const currentId = S.folderFilter ? Number(S.folderFilter) : null;
    const nodes = folderTree || [];
    const byId = new Map(nodes.map(f => [Number(f.id), f]));
    const children = (pid) => nodes
      .filter(f => (f.parent_id == null ? null : Number(f.parent_id)) === (pid == null ? null : Number(pid)))
      .sort((a,b) => (Number(a.sort_order)||0)-(Number(b.sort_order)||0) || String(a.name).localeCompare(String(b.name)));
    const current = currentId ? byId.get(currentId) : null;
    const direct = children(currentId);
    const directFiles = files.filter(f => (f.folder_id == null ? null : Number(f.folder_id)) === (currentId == null ? null : currentId))
      .sort((a,b) => String(a.name||'').localeCompare(String(b.name||'')));

    // Explorer-style navigation: only root folders appear at the root level.
    // A subfolder is shown only after its parent is opened.
    const roots = children(null);
    const crumbs = [];
    let cursor = current;
    while (cursor) { crumbs.unshift(cursor); cursor = cursor.parent_id ? byId.get(Number(cursor.parent_id)) : null; }
    chips.innerHTML = `<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
      <button class="fchip ${!currentId?'active':''}" data-nav-folder="">${UI.icon('folder')} ${esc(t('all'))}</button>
      ${crumbs.map((c,i)=>`<span class="muted">/</span><button class="fchip ${i===crumbs.length-1?'active':''}" data-nav-folder="${c.id}">${esc(c.name)}</button>`).join('')}
    </div>`;
    chips.querySelectorAll('[data-nav-folder]').forEach(b=>b.onclick=()=>{ S.folderFilter=b.dataset.navFolder; renderFolderTable(); });

    const rows = direct.map(f => `
      <button type="button" class="frow" data-open-admin-folder="${f.id}" style="width:100%;text-align:start;border:0;background:transparent;cursor:pointer;padding:10px;border-bottom:1px solid var(--line-soft);display:flex;align-items:center;gap:10px">
        <span>${UI.icon('folder')}</span><span style="flex:1"><b>${esc(f.name)}</b><div class="f-meta"><span class="tag blue">${esc(t('folder_type'))}</span> · ${Number(f.file_count)||0} ${esc(t('files_count'))}</div></span><span class="btn ghost sm">${UI.icon('eye')}</span>
      </button>`).join('');
    browser.innerHTML = rows || '';
    browser.querySelectorAll('[data-open-admin-folder]').forEach(b=>b.onclick=()=>{ S.folderFilter=String(b.dataset.openAdminFolder); renderFolderTable(); });
    browser.hidden = !rows;

    // Only show files directly inside the current folder. Nested folders are never
    // flattened into the parent or shown beside their parent.
    document.getElementById('fmTbl').innerHTML = fileTableHTML(directFiles, { showClient: false });
    document.getElementById('fmEmpty').hidden = directFiles.length > 0 || direct.length > 0;
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
            ${has('view_files') ? `<button class="iconbtn ${f.has_unread_note ? 'note-unread' : ''}" data-act="note" title="${esc(f.has_unread_note ? t('unread_note') : t('note_button'))}">📝</button>` : ''}${has('rename_files') ? `<button class="iconbtn" data-act="rn" title="${esc(t('rename'))}">${UI.icon('pencil')}</button>` : ''}
            ${has('manage_folders') ? `<button class="iconbtn" data-act="mv" title="${esc(t('move'))}">${UI.icon('move')}</button>` : ''}
            ${has('delete_files') ? `<button class="iconbtn danger" data-act="del" title="${esc(t('remove'))}">${UI.icon('trash')}</button>` : ''}
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
      if (b.dataset.act === 'note') noteModal(f, refreshFolder);
      if (b.dataset.act === 'rn') renameModal(f, refreshFolder);
      if (b.dataset.act === 'mv') moveModal(f, refreshFolder);
      if (b.dataset.act === 'del') delFile(f, refreshFolder);
    }));
  }

  /* -------------------------------- file notes -------------------------------- */
  async function noteModal(f, after) {
    try {
      const d = await UI.api('/admin/files/' + f.id + '/notes');
      f.has_unread_note = false;
      const render = (notes) => notes.length ? notes.map(n => `<div class="note-card"><div class="note-head"><b>${esc(n.author_name || t('name'))}</b><span class="muted">${esc(window.I18N.fmtDate(n.created_at))}</span></div><div class="note-body">${esc(n.note).replace(/\n/g,'<br>')}</div>${has('delete_notes') ? `<button class="iconbtn danger" data-note-delete="${n.id}" title="${esc(t('delete_note'))}">${UI.icon('trash')}</button>` : ''}</div>`).join('') : `<div class="muted" style="padding:12px 0">${esc(t('no_notes'))}</div>`;
      UI.openModal(`<h2>📝 ${esc(t('notes'))}</h2><p class="sub">${esc(f.name)}</p><div id="notesList" class="notes-list">${render(d.notes||[])}</div><label class="field"><span>${esc(t('note_button'))}</span><textarea class="input" id="fileNoteInput" rows="4" maxlength="2000" placeholder="${esc(t('note_placeholder'))}"></textarea></label><p class="muted" style="font-size:.85rem">${esc(t('note_permission_hint'))}</p><div class="modal-foot"><button class="btn ghost" id="noteClose">${esc(t('close'))}</button><button class="btn primary" id="noteAdd">${esc(t('add_note'))}</button></div>`,{wide:true});
      const list=document.getElementById('notesList');
      list.querySelectorAll('[data-note-delete]').forEach(b=>b.onclick=async()=>{if(!(await UI.confirmBox(t('delete_note_confirm'))))return;try{await UI.api('/admin/files/'+f.id+'/notes/'+b.dataset.noteDelete,{method:'DELETE'});const nd=await UI.api('/admin/files/'+f.id+'/notes');list.innerHTML=render(nd.notes||[]);wireDeletes();if(after)after();}catch(e){UI.errToast(e);}});
      function wireDeletes(){list.querySelectorAll('[data-note-delete]').forEach(b=>b.onclick=async()=>{if(!(await UI.confirmBox(t('delete_note_confirm'))))return;try{await UI.api('/admin/files/'+f.id+'/notes/'+b.dataset.noteDelete,{method:'DELETE'});const nd=await UI.api('/admin/files/'+f.id+'/notes');list.innerHTML=render(nd.notes||[]);wireDeletes();if(after)after();}catch(e){UI.errToast(e);}});}
      document.getElementById('noteClose').onclick=()=>{UI.closeModal();if(after)after();};
      document.getElementById('noteAdd').onclick=async()=>{const input=document.getElementById('fileNoteInput');const note=input.value.trim();if(!note){UI.toast(t('empty_note'),'err');return;}try{await UI.api('/admin/files/'+f.id+'/notes',{method:'POST',body:{note}});input.value='';const nd=await UI.api('/admin/files/'+f.id+'/notes');list.innerHTML=render(nd.notes||[]);wireDeletes();if(after)after();UI.toast(t('note_added'),'ok');}catch(e){UI.errToast(e);}};
    } catch(e) { UI.errToast(e); }
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

  async function discardAllInbox(){ if(!has('delete_files')) return; if(!(await UI.confirmBox(`${t('discard')} — ${t('delete_file_confirm')}`)))return; try{const r=await UI.api('/admin/inbox/discard-all',{method:'POST',body:{}});UI.toast(`${r.count} inbox files discarded`,'ok');await Promise.all([loadStats(),loadClients()]);render();}catch(e){UI.errToast(e);} }

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
          <button class="iconbtn ${f.has_unread_note ? 'note-unread' : ''}" data-act="note" title="${esc(f.has_unread_note ? t('unread_note') : t('note_button'))}">📝</button>
          <button class="btn sm primary" data-act="save">${esc(t('save_to_folder'))}</button>
          <button class="btn sm danger" data-act="del">${UI.icon('trash')} ${esc(t('discard'))}</button>
        </div>
      </div>`).join('');

    list.querySelectorAll('[data-act]').forEach((b) => (b.onclick = async () => {
      const id = +b.closest('.inbox-item').dataset.id;
      const f = S.inbox.find((x) => x.id === id);
      if (!f) return;
      if (b.dataset.act === 'note') noteModal(f, renderInbox);
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
