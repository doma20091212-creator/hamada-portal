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
    if (sideItems.length) animate(sideItems, { opacity: [0, 1], y: [16, 0] }, { delay: stagger(0.09), duration: 0.6, easing: EASE_OUT });

    const rule = document.querySelector('.auth-rule');
    if (rule) animate(rule, { scaleX: [0, 1] }, { duration: 0.7, delay: 0.35, easing: EASE_OUT });

    const card = document.querySelector('.auth-form-wrap .auth-card');
    if (card) animate(card, { opacity: [0, 1], y: [18, 0] }, { duration: 0.6, delay: 0.2, easing: EASE_OUT });

    const side = document.querySelector('.auth-side');
    const mark = document.querySelector('.auth-side-mark');
    if (side && mark && !('ontouchstart' in window)) {
      side.addEventListener('mousemove', (e) => {
        const r = side.getBoundingClientRect();
        const x = (e.clientX - r.left) / r.width - 0.5;
        const y = (e.clientY - r.top) / r.height - 0.5;
        animate(mark, { x: x * 16, y: y * 16 }, { duration: 0.5, easing: 'ease-out' });
      });
      side.addEventListener('mouseleave', () => animate(mark, { x: 0, y: 0 }, { duration: 0.6, easing: EASE_OUT }));
    }
  }

  /* ---------------- global press feedback on interactive controls ---------------- */
  function initPress() {
    if (reduceMotion || !press) return;
    const targets = document.querySelectorAll('.btn, .iconbtn, .fchip, .navlink');
    targets.forEach((el) => {
      press(el, () => {
        animate(el, { scale: 0.965 }, { duration: 0.12, easing: EASE_OUT });
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
        animate(items, { opacity: [0, 1], y: [8, 0] }, { delay: stagger(0.035), duration: 0.32, easing: EASE_OUT });
      });
      mo.observe(el, { childList: true, subtree: true });
    });
  }

  /* ---------------- empty states: fade in when unhidden ---------------- */
  function initEmptyReveal() {
    if (reduceMotion) return;
    document.querySelectorAll('.empty').forEach((el) => {
      const mo = new MutationObserver(() => {
        if (!el.hidden) animate(el, { opacity: [0, 1], y: [6, 0] }, { duration: 0.3, easing: EASE_OUT });
      });
      mo.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    });
  }

  ready(() => {
    initAuth();
    initPress();
    initNavPill();
    initListReveal();
    initEmptyReveal();
  });
})();
