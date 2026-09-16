/* Shared helpers: API client, toasts, modal stack, dropzone, session */
(function () {
  const t = (k, v) => window.I18N.t(k, v);
  window.__t = t;
  const Motion = window.Motion;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------------- animated scrollbar: dance while actively scrolling ------- */
  if (!reduceMotion) {
    let scrollDanceTimer;
    document.addEventListener('scroll', () => {
      document.documentElement.classList.add('is-scrolling');
      clearTimeout(scrollDanceTimer);
      scrollDanceTimer = setTimeout(() => document.documentElement.classList.remove('is-scrolling'), 650);
    }, { capture: true, passive: true });
  }

  /* ---------------- HTML escaping (filenames/names are user input) ---------- */
  function esc(s) {
    return String(s ?? '')
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }

  /* ------------------------------- session ---------------------------------- */
  const APP = { user: null, csrf: null };
  window.APP = APP;

  /* ---------------------------- global loading UI ---------------------------- */
  let busyCount = 0;
  let busyTimer = null;
  function setBusy(on, message) {
    const el = document.getElementById('processLoader');
    const text = document.getElementById('processLoaderText');
    if (!el) return;
    if (on) {
      busyCount++;
      if (message && text) text.textContent = message;
      if (busyCount === 1) {
        clearTimeout(busyTimer);
        busyTimer = setTimeout(() => { el.classList.add('show'); el.setAttribute('aria-hidden', 'false'); }, 160);
      }
    } else {
      busyCount = Math.max(0, busyCount - 1);
      if (busyCount === 0) {
        clearTimeout(busyTimer);
        el.classList.remove('show');
        el.setAttribute('aria-hidden', 'true');
      }
    }
  }
  function finishPageLoad() {
    const el = document.getElementById('pageLoader');
    if (el) el.classList.add('hide');
  }
  window.addEventListener('load', () => setTimeout(finishPageLoad, 120));
  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (window.I18N && window.I18N.t) el.textContent = window.I18N.t(key);
    });
  });

  async function api(path, opts = {}) {
    const showBusy = opts.busy !== false;
    if (showBusy) setBusy(true, opts.loadingMessage || t('processing'));
    const init = { method: opts.method || 'GET', headers: {}, credentials: 'same-origin' };
    if (opts.csrf !== false) init.headers['x-csrf-token'] = APP.csrf || '';
    if (opts.body !== undefined && !(opts.body instanceof FormData)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    } else if (opts.body instanceof FormData) {
      init.body = opts.body;
    }
    let res;
    try { res = await fetch('/api' + path, init); }
    catch { throw { code: 'net' }; }
    finally { if (showBusy) setBusy(false); }
    let data = {};
    try { data = await res.json(); } catch { data = {}; }
    if (res.status === 401 && !path.startsWith('/login')) { location.href = '/'; throw { code: data.error || 'auth' }; }
    if (!res.ok) throw { code: data.error || 'server_error', extra: data };
    return data;
  }

  /* -------------------------------- modal stack -------------------------------- */
  const stack = [];
  function openModal(html, { wide, onClose } = {}) {
    const wrap = document.createElement('div');
    wrap.className = 'modal-wrap';
    wrap.innerHTML = `<div class="modal${wide ? ' wide' : ''}"></div>`;
    document.body.appendChild(wrap);
    const box = wrap.firstElementChild;
    box.innerHTML = html;
    box.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    box.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.setAttribute('placeholder', t(el.getAttribute('data-i18n-ph'))); });
    const entry = { wrap, box, onClose };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap && !wrap.classList.contains('noclose')) closeModal(); });
    const escFn = (e) => {
      if (e.key === 'Escape' && stack[stack.length - 1] === entry && !wrap.classList.contains('noclose')) closeModal();
    };
    document.addEventListener('keydown', escFn);
    entry.detach = () => document.removeEventListener('keydown', escFn);
    stack.push(entry);
    const first = box.querySelector('input:not([type=hidden]),textarea,select,button.btn.primary');
    if (first) setTimeout(() => first.focus(), 50);
    if (Motion && !reduceMotion) {
      box.style.animation = 'none';
      Motion.animate(wrap, { opacity: [0, 1] }, { duration: 0.18, easing: 'ease-out' });
      Motion.animate(box, { opacity: [0, 1], y: [10, 0], scale: [0.97, 1] }, { type: 'spring', stiffness: 420, damping: 34 });
    }
    return entry;
  }
  function closeModal() {
    const e = stack.pop();
    if (!e) return;
    e.detach && e.detach();
    const finish = () => { e.wrap.remove(); if (e.onClose) e.onClose(); };
    if (Motion && !reduceMotion) {
      Motion.animate(e.box, { opacity: [1, 0], y: [0, 8], scale: [1, 0.97] }, { duration: 0.16, easing: [0.4, 0, 1, 1] });
      const backdrop = Motion.animate(e.wrap, { opacity: [1, 0] }, { duration: 0.16, easing: 'ease-in' });
      (backdrop.finished || Promise.resolve()).then(finish).catch(finish);
    } else {
      finish();
    }
  }

  function confirmBox(msg, danger = true) {
    return new Promise((resolve) => {
      let yes = false;
      openModal(`
        <h2>${esc(t('confirm'))}</h2>
        <p class="sub">${esc(msg)}</p>
        <div class="modal-foot">
          <button class="btn ghost" data-x="no">${esc(t('cancel'))}</button>
          <button class="btn ${danger ? 'danger' : 'primary'}" data-x="yes">${esc(t('confirm'))}</button>
        </div>`, { onClose: () => resolve(yes) });
      const top = stack[stack.length - 1].box;
      top.querySelector('[data-x=no]').onclick = () => closeModal();
      top.querySelector('[data-x=yes]').onclick = () => { yes = true; closeModal(); };
    });
  }

  /* -------------------------------- toasts ---------------------------------- */
  function toast(msg, kind) {
    let wrap = document.getElementById('toasts');
    if (!wrap) { wrap = document.createElement('div'); wrap.className = 'toasts'; wrap.id = 'toasts'; document.body.appendChild(wrap); }
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.textContent = msg;
    wrap.appendChild(el);
    if (Motion && !reduceMotion) {
      el.style.animation = 'none';
      Motion.animate(el, { opacity: [0, 1], y: [14, 0], scale: [0.95, 1] }, { type: 'spring', stiffness: 480, damping: 30 });
    }
    setTimeout(() => {
      if (Motion && !reduceMotion) {
        const a = Motion.animate(el, { opacity: [1, 0], y: [0, -8] }, { duration: 0.25, easing: 'ease-in' });
        (a.finished || Promise.resolve()).then(() => el.remove()).catch(() => el.remove());
      } else {
        el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320);
      }
    }, 3600);
  }
  function errToast(e) { toast(t('err_' + (e && e.code ? e.code : 'server_error')), 'err'); }

  /* --------------------------- password change UI ------------------------------ */
  function boot() { } // placeholder to keep order explicit; real boot below after helpers

  async function bootInto(requireRole) {
    const s = await api('/session', { csrf: false });
    if (!s.user) { location.href = '/'; throw 'no-session'; }
    if (requireRole && s.user.role !== requireRole) { location.href = s.user.role === 'admin' ? '/admin' : '/client'; throw 'wrong-role'; }
    APP.user = s.user;
    APP.csrf = s.csrf;
    if (s.user.must_change) forcePasswordModal();
    const who = document.getElementById('whoName'); if (who) who.textContent = s.user.name;
    const av = document.getElementById('whoAvatar'); if (av) av.textContent = (s.user.name || '?').trim()[0].toUpperCase();
    return s.user;
  }

  function passwordModal() {
    const entry = openModal(`
      <h2>${esc(t('change_password'))}</h2>
      <p class="sub">—</p>
      <form id="pwForm">
        <label class="field"><span>${esc(t('current_password'))}</span><input class="input" type="password" id="curPw" required autocomplete="current-password" maxlength="120"></label>
        <label class="field"><span>${esc(t('new_password'))}</span><input class="input" type="password" id="newPw" required minlength="8" autocomplete="new-password" maxlength="120"></label>
        <label class="field"><span>${esc(t('confirm_password'))}</span><input class="input" type="password" id="newPw2" required autocomplete="new-password" maxlength="120"></label>
        <div class="form-error" id="pwErr" hidden></div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" id="pwCancel">${esc(t('cancel'))}</button>
          <button type="submit" class="btn primary">${esc(t('save_password'))}</button>
        </div>
      </form>`);
    entry.box.querySelector('.sub').textContent = '';
    entry.box.querySelector('#pwCancel').onclick = () => closeModal();
    entry.box.querySelector('#pwForm').onsubmit = async (e) => {
      e.preventDefault();
      const err = entry.box.querySelector('#pwErr');
      err.hidden = true;
      const np = entry.box.querySelector('#newPw').value;
      if (np !== entry.box.querySelector('#newPw2').value) { err.textContent = t('passwords_match_needed'); err.hidden = false; return; }
      try {
        await api('/password', { method: 'POST', body: { current: entry.box.querySelector('#curPw').value, next: np } });
        APP.user.must_change = false;
        entry.onClose = null;
        closeModal();
        toast(t('saved'), 'ok');
      } catch (ex) {
        err.textContent = t('err_' + (ex.code || 'server_error'));
        err.hidden = false;
      }
    };
  }

  /* Forced, un-dismissable on first login */
  function forcePasswordModal() {
    const entry = openModal(`
      <h2>${esc(t('must_change_title'))}</h2>
      <p class="sub">${esc(t('change_required'))}</p>
      <form id="fPwForm">
        <label class="field"><span>${esc(t('current_password'))}</span><input class="input" type="password" id="fCur" required autocomplete="current-password"></label>
        <label class="field"><span>${esc(t('new_password'))}</span><input class="input" type="password" id="fNew" required minlength="8" autocomplete="new-password"></label>
        <label class="field"><span>${esc(t('confirm_password'))}</span><input class="input" type="password" id="fNew2" required autocomplete="new-password"></label>
        <div class="form-error" id="fErr" hidden></div>
        <button class="btn primary block" type="submit">${esc(t('save_password'))}</button>
      </form>`);
    entry.wrap.classList.add('noclose');
    entry.box.querySelector('#fPwForm').onsubmit = async (e) => {
      e.preventDefault();
      const err = entry.box.querySelector('#fErr');
      err.hidden = true;
      const np = entry.box.querySelector('#fNew').value;
      if (np !== entry.box.querySelector('#fNew2').value) { err.textContent = t('passwords_match_needed'); err.hidden = false; return; }
      try {
        await api('/password', { method: 'POST', body: { current: entry.box.querySelector('#fCur').value, next: np } });
        location.reload();
      } catch (ex) { err.textContent = t('err_' + (ex.code || 'server_error')); err.hidden = false; }
    };
  }

  /* -------------------------------- icons ------------------------------------ */
  const SVG = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="${d}"/></svg>`;
  const ICONS = {
    download: SVG('M11 3h2v9.2l3.1-3.1 1.4 1.4L12 16l-5.5-5.5 1.4-1.4L11 12.2V3ZM5 18v3h14v-3h-2v1H7v-1H5Z'),
    trash: SVG('M9 3h6l.5 2H20v2H4V5h4.5L9 3Zm-3 6h12l-1 12H7L6 9Zm3 2 .6 8h1.8L12 17l-.6-8H9Zm4.4 0 .6 8h1.8l.6-8h-3Z'),
    pencil: SVG('M4 20h4L20 8l-4-4L4 16v4Zm11.2-12.8 1.6-1.6 1.8 1.8-1.6 1.6-1.8-1.8Z'),
    move: SVG('M4 11h12.2l-3.1-3.1 1.4-1.4L21 12l-6.5 5.5-1.4-1.4 3.1-3.1H4v-2Z'),
    folder: SVG('M3 5h6l2 2h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Zm0 4v10h18V9H3Z'),
    inbox: SVG('M3 3h18a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm0 10 3.2 3.2H9l1-1h4l1 1h2.8L21 13V5H3v8Z'),
    key: SVG('M14 3a7 7 0 0 1 0 14c-1.3 0-2.6-.4-3.6-1.1L7 19H4v3H1v-3.2l3.6-3.6A7 7 0 1 1 14 3Zm3 4a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z'),
    x: SVG('m12 10.6 5.3-5.3 1.4 1.4-5.3 5.3 5.3 5.3-1.4 1.4-5.3-5.3-5.3 5.3-1.4-1.4 5.3-5.3-5.3-5.3 1.4-1.4 5.3 5.3Z'),
    upload: SVG('M12 3 6.5 8.5 7.9 9.9 11 6.8V16h2V6.8l3.1 3.1 1.4-1.4L12 3ZM5 18v3h14v-3h-2v1H7v-1H5Z'),
    file: SVG('M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2Zm7 1.5V7h3.5L13 3.5ZM7 12h10v1.6H7V12Zm0 3.4h10V17H7v-1.6Z'),
    eye: SVG('M12 5C6.8 5 2.5 8.3 1 12c1.5 3.7 5.8 7 11 7s9.5-3.3 11-7c-1.5-3.7-5.8-7-11-7Zm0 11.5A4.5 4.5 0 1 1 12 7.5a4.5 4.5 0 0 1 0 9Zm0-7.2a2.7 2.7 0 1 0 0 5.4 2.7 2.7 0 0 0 0-5.4Z'),
  };
  function icon(name) { return ICONS[name] || ICONS.file; }

  /* ------------------------------- file preview ------------------------------- */
  // Keep in sync with PREVIEWABLE_MIMES in server.js.
  const PREVIEWABLE_MIMES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'application/pdf']);
  function isPreviewable(mime) { return PREVIEWABLE_MIMES.has(String(mime || '').toLowerCase()); }

  function previewFile(file) {
    const previewUrl = `/api/file/${file.id}/download?disposition=inline`;
    const downloadUrl = `/api/file/${file.id}/download`;
    const isPdf = String(file.mime || '').toLowerCase() === 'application/pdf';
    const body = isPdf
      ? `<iframe src="${previewUrl}" style="width:100%;height:75vh;border:0;border-radius:10px;background:#fff" title="${esc(file.name)}"></iframe>`
      : `<div style="text-align:center"><img src="${previewUrl}" alt="${esc(file.name)}" style="max-width:100%;max-height:75vh;border-radius:10px"></div>`;
    const entry = openModal(`
      <div class="modal-head">
        <div><h2 style="word-break:break-word">${esc(file.name)}</h2></div>
        <div style="display:flex;gap:6px;flex:none">
          <a class="iconbtn" href="${downloadUrl}" download title="${esc(t('download'))}">${icon('download')}</a>
          <button class="iconbtn" id="previewCloseX" title="${esc(t('close'))}">${icon('x')}</button>
        </div>
      </div>
      ${body}
    `, { wide: true });
    entry.box.querySelector('#previewCloseX').onclick = () => closeModal();
  }

  /* ------------------------------- dropzone ----------------------------------- */
  function wireDropzone(zoneEl, inputEl, onFiles) {
    if (!zoneEl || !inputEl) return;
    const open = () => inputEl.click();
    zoneEl.addEventListener('click', open);
    zoneEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    ['dragenter', 'dragover'].forEach((ev) => zoneEl.addEventListener(ev, (e) => { e.preventDefault(); zoneEl.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach((ev) => zoneEl.addEventListener(ev, (e) => { e.preventDefault(); zoneEl.classList.remove('drag'); }));
    zoneEl.addEventListener('drop', (e) => { if (e.dataTransfer && e.dataTransfer.files.length) onFiles([...e.dataTransfer.files]); });
    inputEl.addEventListener('change', () => { if (inputEl.files.length) { onFiles([...inputEl.files]); inputEl.value = ''; } });
  }

  const ALLOW_EXT = /\.(pdf|doc|docx|xls|xlsx|xlsm|csv|txt|rtf|odt|ods|ppt|pptx|zip|rar|7z|jpe?g|png|webp|gif|heic|tiff?)$/i;
  function clientCheckFiles(list) {
    const maxMB = 25, maxN = 12;
    const out = [];
    for (const f of list) {
      if (f.size > maxMB * 1024 * 1024) { toast(`${f.name}: ${t('err_file_too_large')}`, 'err'); continue; }
      if (!ALLOW_EXT.test(f.name)) { toast(`${f.name}: ${t('err_file_type_not_allowed')}`, 'err'); continue; }
      out.push(f);
    }
    if (out.length > maxN) { toast(t('err_too_many_files'), 'err'); return out.slice(0, maxN); }
    return out;
  }

  function logout() {
    api('/logout', { method: 'POST' }).finally(() => (location.href = '/'));
  }

  function bindTopActions() {
    const lb = document.getElementById('langBtn');
    if (lb) lb.onclick = () => { window.I18N.toggle(); window.I18N.apply(); if (window.__onLangChange) window.__onLangChange(); };
    const pw = document.getElementById('pwBtn'); if (pw) pw.onclick = () => passwordModal();
    const lo = document.getElementById('logoutBtn'); if (lo) lo.onclick = logout;
  }

  /* ------------------------------- search --------------------------------- */
  // Multi-word "AND" substring matching: every word in the query must appear
  // somewhere in the combined fields, in any order and regardless of
  // separators (so "invoice march" matches "March_Invoice_2024.pdf").
  function searchMatch(fields, query) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return true;
    const words = q.split(/\s+/).filter(Boolean);
    const hay = (Array.isArray(fields) ? fields : [fields]).filter((v) => v != null && v !== '').join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  async function loadBrand() {
    try {
      const b = await api('/brand', { csrf: false });
      const ar = window.I18N.lang === 'ar';
      const n = document.getElementById('brandName'); if (n) n.textContent = ar ? (b.name_ar || b.name_en) : (b.name_en || '');
      const sn = document.getElementById('sideName'); if (sn) sn.textContent = ar ? (b.name_ar || '') : (b.name_en || '');
      const tg = document.getElementById('brandTag'); if (tg) tg.textContent = ar ? (b.tagline_ar || '') : (b.tagline_en || '');
    } catch {}
  }

  window.UI = { esc, api, setBusy, finishPageLoad, boot: bootInto, toast, errToast, openModal, closeModal, confirmBox, passwordModal, icon, wireDropzone, clientCheckFiles, logout, bindTopActions, loadBrand, searchMatch, isPreviewable, previewFile };
})();
