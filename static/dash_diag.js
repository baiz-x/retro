/* dash_diag.js — loaded BEFORE dashboard.js on purpose.
   A script that fails to parse can never report its own error, but this
   separate file can: a SyntaxError in dashboard.js fires a window "error"
   event that is caught here and shown as a red banner.
   ---- Boot diagnostics (phone-friendly: no dev tools needed) ----
   Any uncaught error, or startup never running, shows a red banner at
   the top of the screen with the message and file:line. Tap it to dismiss.
   Screenshot it and send it over. Uses CSSOM (el.style), not an inline
   style attribute, so a strict CSP can't block it. */
(function () {
    function banner(msg) {
        try {
            let el = document.getElementById('dash-error-banner');
            if (!el) {
                el = document.createElement('div');
                el.id = 'dash-error-banner';
                el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#b91c1c;color:#fff;font:12px/1.4 monospace;padding:8px 12px;max-height:40vh;overflow:auto;white-space:pre-wrap';
                (document.body || document.documentElement).appendChild(el);
                el.addEventListener('click', () => el.remove());
            }
            el.textContent += msg + '\n';
        } catch (e) { /* never let diagnostics throw */ }
    }
    window.__dashBanner = banner;
    window.__dashBooted = false;
    window.addEventListener('error', (e) => {
        banner(`JS error: ${e.message} (${String(e.filename || '').split('/').pop()}:${e.lineno})`);
    });
    window.addEventListener('unhandledrejection', (e) => {
        banner(`Unhandled promise error: ${e.reason && e.reason.message ? e.reason.message : e.reason}`);
    });
    setTimeout(() => {
        if (!window.__dashBooted) banner('Dashboard startup never ran (dashboard.js loaded but init did not execute).');
    }, 4000);
})();


