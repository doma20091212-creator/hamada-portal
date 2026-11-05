/* Multi-company owner: choose which company to open, and switch between them. */
(function () {
  const t = window.__t, UI = window.UI, esc = UI.esc;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const Motion = window.Motion;
  const EASE = [0.16, 1, 0.3, 1];

  const label = (x) => (window.I18N.lang === 'ar' && x.name_ar) ? x.name_ar : x.name;
  const initials = (name) => String(name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

  function greeting() {
    const h = new Date().getHours();
    return t(h < 12 ? 'good_morning' : h < 18 ? 'good_afternoon' : 'good_evening');
  }

  let screen = null;

  async function open({ closable = false } = {}) {
    let data;
    try { data = await UI.api('/portfolio/companies', { csrf: false, busy: !closable }); }
    catch (e) { UI.errToast(e); return; }
    const owner = data.owner, companies = data.companies || [], active = data.active_company;

    close(true);
    screen = document.createElement('div');
    screen.className = 'pf-screen';
    screen.setAttribute('role', 'dialog');
    screen.setAttribute('aria-modal', 'true');
    screen.innerHTML = `
      <div class="pf-inner">
        <header class="pf-head">
          <img src="/assets/logo.png" alt="" class="pf-logo">
          <div class="pf-head-actions">
            <button class="btn ghost sm" data-pf="lang">${esc(window.I18N.lang === 'ar' ? 'English' : 'العربية')}</button>
            <button class="btn ghost sm" data-pf="pw">${esc(t('change_password'))}</button>
            <button class="btn ghost sm" data-pf="logout">${esc(t('logout'))}</button>
            ${closable ? `<button class="iconbtn pf-close" data-pf="close" aria-label="${esc(t('close'))}">&times;</button>` : ''}
          </div>
        </header>
        <div class="pf-title">
          <p class="pf-eyebrow">${esc(greeting())}</p>
          <h1>${esc(label(owner))}</h1>
          <span class="pf-rule" aria-hidden="true"></span>
          <p class="muted">${esc(companies.length ? t('choose_company') : t('no_companies_linked'))}</p>
        </div>
        ${companies.length > 6 ? `<div class="search pf-search"><svg viewBox="0 0 24 24" width="16" height="16"><path fill="currentColor" d="M10 2a8 8 0 1 0 4.9 14.3l5.4 5.4 1.4-1.4-5.4-5.4A8 8 0 0 0 10 2Zm0 2a6 6 0 1 1 0 12 6 6 0 0 1 0-12Z"/></svg><input class="input plain" id="pfFind" placeholder="${esc(t('search_companies'))}" autocomplete="off"></div>` : ''}
        <div class="pf-grid" id="pfGrid">
          ${companies.map((c) => `
            <button class="pf-card ${c.id === active ? 'current' : ''}" data-company="${c.id}" data-q="${esc([c.name, c.name_ar].join(' ').toLowerCase())}">
              <span class="pf-mono" aria-hidden="true">${esc(initials(c.name))}</span>
              <span class="pf-card-body">
                <span class="pf-name">${esc(label(c))}</span>
                <span class="pf-meta">${c.nfiles} ${esc(t('documents'))}${c.last_file_at ? ` · ${esc(t('updated'))} ${esc(window.I18N.fmtDate(c.last_file_at))}` : ''}</span>
              </span>
              ${c.id === active ? `<span class="pf-current">${esc(t('current_company'))}</span>` : `<span class="pf-arrow" aria-hidden="true">→</span>`}
            </button>`).join('')}
        </div>
      </div>`;
    document.body.appendChild(screen);
    document.body.classList.add('pf-open');

    screen.querySelector('[data-pf=lang]').onclick = () => { window.I18N.toggle ? window.I18N.toggle() : document.getElementById('langBtn')?.click(); open({ closable }); };
    screen.querySelector('[data-pf=pw]').onclick = () => UI.passwordModal();
    screen.querySelector('[data-pf=logout]').onclick = () => UI.logout();
    const closeBtn = screen.querySelector('[data-pf=close]'); if (closeBtn) closeBtn.onclick = () => close();
    if (closable) screen.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

    const find = screen.querySelector('#pfFind');
    if (find) find.addEventListener('input', () => {
      const q = find.value.trim().toLowerCase();
      screen.querySelectorAll('.pf-card').forEach((card) => { card.hidden = q && !card.dataset.q.includes(q); });
    });

    screen.querySelectorAll('[data-company]').forEach((card) => {
      card.onclick = () => choose(+card.dataset.company, card, active);
      if (!reduceMotion && !('ontouchstart' in window)) {
        // A soft light that follows the pointer across the card.
        card.addEventListener('pointermove', (e) => {
          const r = card.getBoundingClientRect();
          card.style.setProperty('--mx', `${e.clientX - r.left}px`);
          card.style.setProperty('--my', `${e.clientY - r.top}px`);
        });
      }
    });

    entrance();
    (screen.querySelector('.pf-card.current') || screen.querySelector('.pf-card'))?.focus({ preventScroll: true });
  }

  function entrance() {
    if (!Motion || reduceMotion) return;
    const { animate, stagger } = Motion;
    animate(screen, { opacity: [0, 1] }, { duration: 0.35, ease: 'easeOut' });
    animate(screen.querySelectorAll('.pf-title > *'), { opacity: [0, 1], y: [14, 0] }, { delay: stagger(0.07, { startDelay: 0.08 }), duration: 0.7, ease: EASE });
    const rule = screen.querySelector('.pf-rule');
    if (rule) animate(rule, { scaleX: [0, 1] }, { duration: 0.9, delay: 0.3, ease: EASE });
    animate(screen.querySelectorAll('.pf-card'), { opacity: [0, 1], y: [18, 0] }, { delay: stagger(0.05, { startDelay: 0.25 }), duration: 0.65, ease: EASE });
  }

  async function choose(id, card, active) {
    if (id === active) { close(); return; }
    try {
      await UI.api('/portfolio/select', { method: 'POST', body: { client_id: id }, busy: false });
    } catch (e) { UI.errToast(e); return; }
    if (Motion && !reduceMotion) {
      const { animate } = Motion;
      screen.querySelectorAll('.pf-card').forEach((c) => { if (c !== card) animate(c, { opacity: 0.25, scale: 0.985 }, { duration: 0.3, ease: EASE }); });
      card.classList.add('chosen');
      await animate(card, { scale: [1, 1.015, 1] }, { duration: 0.45, ease: EASE }).finished.catch(() => {});
      const veil = document.createElement('div'); veil.className = 'pf-veil'; document.body.appendChild(veil);
      await animate(veil, { opacity: [0, 1] }, { duration: 0.35, ease: 'easeIn' }).finished.catch(() => {});
    }
    location.reload();
  }

  function close(instant) {
    if (!screen) return;
    const el = screen; screen = null;
    const done = () => { el.remove(); document.body.classList.remove('pf-open'); };
    if (instant || !Motion || reduceMotion) return done();
    Motion.animate(el, { opacity: [1, 0] }, { duration: 0.25, ease: 'easeIn' }).finished.then(done, done);
  }

  window.Portfolio = { open, close };
})();
