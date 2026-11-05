/* Premium interaction layer built on Motion (https://motion.dev). Purely additive:
   every effect degrades to the existing CSS-only look if Motion fails to load
   or the visitor has requested reduced motion. */
(function () {
  if (!window.Motion) return;
  const { animate, stagger, press } = window.Motion;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const EASE_OUT = [0.16, 1, 0.3, 1];

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }

  /* ---------------- auth page: entrance choreography + parallax ---------------- */
  function initAuth() {
    if (!document.body.classList.contains('auth-body')) return;
    if (reduceMotion) return;

    const sideItems = document.querySelectorAll('.auth-side-inner > *');
    if (sideItems.length) animate(sideItems, { opacity: [0, 1], y: [16, 0] }, { delay: stagger(0.09), duration: 0.6, ease: EASE_OUT });

    const rule = document.querySelector('.auth-rule');
    if (rule) animate(rule, { scaleX: [0, 1] }, { duration: 0.7, delay: 0.35, ease: EASE_OUT });

    const card = document.querySelector('.auth-form-wrap .auth-card');
    if (card) animate(card, { opacity: [0, 1], y: [18, 0] }, { duration: 0.6, delay: 0.2, ease: EASE_OUT });

    const side = document.querySelector('.auth-side');
    const mark = document.querySelector('.auth-side-mark');
    if (side && mark && !('ontouchstart' in window)) {
      side.addEventListener('mousemove', (e) => {
        const r = side.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        animate(mark, { x: x * 16, y: y * 16 }, { duration: 0.5, ease: 'easeOut' });
      });
      side.addEventListener('mouseleave', () => animate(mark, { x: 0, y: 0 }, { duration: 0.6, ease: EASE_OUT }));
    }
  }

  /* ---------------- global press feedback on interactive controls ---------------- */
  function initPress() {
    if (reduceMotion || !press) return;
    const targets = document.querySelectorAll('.btn, .iconbtn, .fchip, .navlink, .seg, .company-switch');
    targets.forEach((el) => {
      press(el, () => {
        animate(el, { scale: 0.965 }, { duration: 0.12, ease: EASE_OUT });
        return () => {
          const anim = animate(el, { scale: 1 }, { type: 'spring', stiffness: 480, damping: 26 });
          // Motion leaves an inline `transform` after finishing; clear it so the
          // element's own CSS :hover transform (translateY/translateX) still applies.
          (anim.finished || Promise.resolve()).then(() => { el.style.transform = ''; }).catch(() => {});
        };
      });
    });
  }

  /* ---------------- sidebar: sliding active-tab pill ---------------- */
  function initNavPill() {
    const nav = document.querySelector('.side-nav');
    if (!nav) return;
    const pill = document.createElement('div');
    pill.className = 'nav-pill';
    nav.prepend(pill);

    function place(link, animated) {
      if (!link) { pill.style.opacity = 0; return; }
      const top = link.offsetTop, height = link.offsetHeight;
      if (animated && !reduceMotion) {
        animate(pill, { top: top + 'px', height: height + 'px', opacity: 1 }, { type: 'spring', stiffness: 520, damping: 40 });
      } else {
        pill.style.top = top + 'px';
        pill.style.height = height + 'px';
        pill.style.opacity = 1;
      }
    }

    place(nav.querySelector('.navlink.active'), false);
    const mo = new MutationObserver(() => place(nav.querySelector('.navlink.active'), true));
    nav.querySelectorAll('.navlink').forEach((el) => mo.observe(el, { attributes: true, attributeFilter: ['class'] }));
    window.addEventListener('resize', () => place(nav.querySelector('.navlink.active'), false));
  }

  /* ---------------- lists/tables: stagger reveal when content actually changes ---------------- */
  function initListReveal() {
    if (reduceMotion) return;
    const targets = [
      { sel: '#clientsTbl', rows: 'tbody tr' },
      { sel: '#allFilesTbl', rows: 'tbody tr' },
      { sel: '#adminsTbl', rows: 'tbody tr' },
      { sel: '#portfoliosTbl', rows: 'tbody tr' },
      { sel: '#inboxList', rows: '.inbox-item' },
      { sel: '#myFiles', rows: '.frow' },
      { sel: '#sentList', rows: 'li' },
    ];
    targets.forEach(({ sel, rows }) => {
      const el = document.querySelector(sel);
      if (!el) return;
      // Fingerprint on row count + textContent length: stable across e.g. a checkbox
      // toggle (which only flips a `checked` attribute, not text), so we only replay
      // the reveal when the actual visible content changes.
      let lastKey = '';
      const mo = new MutationObserver(() => {
        const items = el.querySelectorAll(rows);
        if (!items.length) return;
        const key = items.length + ':' + el.textContent.length;
        if (key === lastKey) return;
        lastKey = key;
        animate(items, { opacity: [0, 1], y: [6, 0] }, { delay: stagger(0.015), duration: 0.16, ease: EASE_OUT });
      });
      mo.observe(el, { childList: true, subtree: true });
    });
  }

  /* ---------------- empty states: fade in when unhidden ---------------- */
  function initEmptyReveal() {
    if (reduceMotion) return;
    document.querySelectorAll('.empty').forEach((el) => {
      const mo = new MutationObserver(() => {
        if (!el.hidden) animate(el, { opacity: [0, 1], y: [6, 0] }, { duration: 0.3, ease: EASE_OUT });
      });
      mo.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  /* ---------------- mobile: hamburger-triggered sidebar drawer ---------------- */
  function initMobileDrawer() {
    const side = document.getElementById('side');
    const btn = document.getElementById('mobileMenuBtn');
    const backdrop = document.getElementById('sideBackdrop');
    const closeBtn = document.getElementById('sideClose');
    if (!side || !btn || !backdrop) return;

    const isRtl = () => document.documentElement.dir === 'rtl';

    function open() {
      side.classList.add('open');
      backdrop.classList.add('show');
      if (!reduceMotion) animate(side, { x: [isRtl() ? '100%' : '-100%', '0%'] }, { duration: 0.22, ease: EASE_OUT });
    }
    function close() {
      backdrop.classList.remove('show');
      if (!side.classList.contains('open')) return;
      if (reduceMotion) { side.classList.remove('open'); return; }
      const anim = animate(side, { x: ['0%', isRtl() ? '100%' : '-100%'] }, { duration: 0.22, ease: [0.4, 0, 1, 1] });
      (anim.finished || Promise.resolve()).then(() => { side.classList.remove('open'); side.style.transform = ''; }).catch(() => {});
    }
    btn.addEventListener('click', open);
    backdrop.addEventListener('click', close);
    if (closeBtn) closeBtn.addEventListener('click', close);
    side.querySelectorAll('.navlink').forEach((el) => el.addEventListener('click', close));
    window.addEventListener('resize', () => { if (window.innerWidth > 880) close(); });
  }

  /* ---------------- figures: count up to the new value instead of jumping ---------------- */
  function initCountUp() {
    if (reduceMotion) return;
    document.querySelectorAll('#stClients, #stFiles, #stUnread, #stCount').forEach((el) => {
      let shown = 0, busy = false;
      const mo = new MutationObserver(() => {
        if (busy) return;
        const target = parseInt(el.textContent.replace(/[^0-9]/g, ''), 10);
        if (!Number.isFinite(target) || target === shown) { shown = Number.isFinite(target) ? target : shown; return; }
        const from = shown; shown = target; busy = true;
        animate(from, target, {
          duration: Math.min(1.1, 0.5 + Math.abs(target - from) * 0.02), ease: EASE_OUT,
          onUpdate: (v) => { el.textContent = Math.round(v); },
        }).finished.then(() => { el.textContent = target; busy = false; }, () => { busy = false; });
      });
      mo.observe(el, { childList: true, characterData: true, subtree: true });
    });
  }

  /* ---------------- office panel: each page eases in when you switch to it ---------------- */
  function initTabTransitions() {
    if (reduceMotion) return;
    document.querySelectorAll('section.tab, #companiesPanel, #portfoliosPanel').forEach((el) => {
      new MutationObserver(() => {
        if (el.hidden) return;
        animate(el, { opacity: [0, 1], y: [10, 0] }, { duration: 0.45, ease: EASE_OUT })
          .finished.then(() => { el.style.transform = ''; }).catch(() => {});
      }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  /* ---------------- messages: new bubbles glide in, conversations settle in ---------------- */
  function initMessageMotion() {
    if (reduceMotion) return;
    const list = () => document.getElementById('msgList');
    const thread = document.getElementById('msgThread');
    if (thread) {
      let lastKey = '', lastCount = 0;
      new MutationObserver(() => {
        const l = list(); if (!l) return;
        const bubbles = l.querySelectorAll('.msg-bubble');
        const head = thread.querySelector('.cell-main');
        const key = head ? head.textContent : '';
        if (key !== lastKey) {
          lastKey = key; lastCount = bubbles.length;
          animate(thread.querySelectorAll('.msg-head, .msg-list, .msg-compose'), { opacity: [0, 1] }, { duration: 0.35, ease: EASE_OUT });
          return;
        }
        if (bubbles.length > lastCount) {
          const fresh = [...bubbles].slice(lastCount);
          animate(fresh, { opacity: [0, 1], y: [12, 0], scale: [0.98, 1] }, { delay: stagger(0.06), duration: 0.5, ease: EASE_OUT });
        }
        lastCount = bubbles.length;
      }).observe(thread, { childList: true, subtree: true });
    }
    const threads = document.getElementById('msgThreads');
    if (threads) {
      let lastKey = '';
      new MutationObserver(() => {
        const items = threads.querySelectorAll('.msg-ti');
        const key = [...items].map((x) => x.dataset.cid).join(',');
        if (!items.length || key === lastKey) return;
        lastKey = key;
        animate(items, { opacity: [0, 1], x: [document.documentElement.dir === 'rtl' ? 8 : -8, 0] }, { delay: stagger(0.03), duration: 0.4, ease: EASE_OUT });
      }).observe(threads, { childList: true });
    }
  }

  /* ---------------- client page: sections arrive one after another ---------------- */
  function initClientEntrance() {
    if (reduceMotion || !document.body.classList.contains('client-body')) return;
    const parts = document.querySelectorAll('.cli-hero, .cli-grid > .card, .cli-main > .card.sec');
    if (!parts.length) return;
    animate(parts, { opacity: [0, 1], y: [16, 0] }, { delay: stagger(0.09, { startDelay: 0.15 }), duration: 0.7, ease: EASE_OUT })
      .finished.then(() => parts.forEach((p) => { p.style.transform = ''; })).catch(() => {});
    const hero = document.querySelector('.cli-hero');
    if (hero) setTimeout(() => hero.classList.add('sheen'), 650);
  }

  ready(() => {
    initAuth();
    initPress();
    initNavPill();
    initListReveal();
    initEmptyReveal();
    initMobileDrawer();
    initCountUp();
    initTabTransitions();
    initMessageMotion();
    initClientEntrance();
  });
})();
