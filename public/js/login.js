/* Login page (also hosts the forced first-time password change) */
(function () {
  const t = window.__t;
  const { esc } = window.UI;
  document.getElementById('langBtn').onclick = () => window.I18N.toggle();
  window.__onLangChange = () => window.UI.loadBrand();
  window.UI.loadBrand();

  async function showChange(password) {
    document.getElementById('loginCard').hidden = true;
    const card = document.getElementById('changeCard');
    card.hidden = false;
    document.getElementById('curPw').value = password || '';
    document.getElementById('newPw').focus();
  }

  document.getElementById('loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('loginError');
    const btn = document.getElementById('loginBtn');
    err.hidden = true;
    btn.disabled = true;
    window.UI.setBusy(true, t('signing_in'));
    const identifier = document.getElementById('identifier').value.trim();
    const password = document.getElementById('password').value;
    try {
      const r = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        err.textContent = t('err_' + (data.error || 'bad_credentials'));
        err.hidden = false;
        return;
      }
      window.APP.csrf = data.csrf;
      window.APP.user = data.user;
      if (data.user.must_change) { await showChange(password); return; }
      location.href = data.user.role === 'admin' ? '/admin' : '/client';
    } catch {
      err.textContent = t('err_net');
      err.hidden = false;
    } finally {
      btn.disabled = false;
      window.UI.setBusy(false);
    }
  };

  document.getElementById('changeForm').onsubmit = async (e) => {
    e.preventDefault();
    const err = document.getElementById('changeError');
    err.hidden = true;
    const cur = document.getElementById('curPw').value;
    const np = document.getElementById('newPw').value;
    const np2 = document.getElementById('newPw2').value;
    if (np !== np2) { err.textContent = t('passwords_match_needed'); err.hidden = false; return; }
    try {
      await window.UI.api('/password', { method: 'POST', body: { current: cur, next: np }, loadingMessage: t('saving') });
      window.UI.setBusy(true, t('redirecting'));
      location.href = window.APP.user.role === 'admin' ? '/admin' : '/client';
    } catch (ex) {
      err.textContent = t('err_' + (ex.code || 'server_error'));
      err.hidden = false;
    }
  };

  /* already signed in? go straight to the panel */
  fetch('/api/session', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((s) => {
      if (s && s.user && !s.user.must_change) location.href = s.user.role === 'admin' ? '/admin' : '/client';
      else if (s && s.user) { document.getElementById('loginCard').hidden = true; document.getElementById('changeCard').hidden = false; }
    })
    .catch(() => {});
})();
