// UTRehome - Page-world script to extract YouTube config
// This runs in the page's JS context (not the content script sandbox)

(function () {
  function getSapisid() {
    // Read SAPISID or __Secure-3PAPISID cookie
    const cookies = document.cookie.split('; ');
    for (const cookie of cookies) {
      const [name, ...rest] = cookie.split('=');
      if (name === 'SAPISID' || name === '__Secure-3PAPISID') {
        return rest.join('=');
      }
    }
    return null;
  }

  async function generateSapisidHash(sapisid, origin) {
    const timestamp = Math.floor(Date.now() / 1000);
    const input = `${timestamp} ${sapisid} ${origin}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const hashBuffer = await crypto.subtle.digest('SHA-1', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return `SAPISIDHASH ${timestamp}_${hashHex}`;
  }

  function extractConfig() {
    if (typeof window.ytcfg === 'undefined' || !window.ytcfg.get) {
      return null;
    }
    return {
      apiKey: window.ytcfg.get('INNERTUBE_API_KEY'),
      context: window.ytcfg.get('INNERTUBE_CONTEXT'),
      loggedIn: window.ytcfg.get('LOGGED_IN'),
      delegatedSessionId: window.ytcfg.get('DELEGATED_SESSION_ID'),
      idToken: window.ytcfg.get('ID_TOKEN'),
      sessionIndex: window.ytcfg.get('SESSION_INDEX'),
      datasyncId: window.ytcfg.get('DATASYNC_ID'),
      sapisid: getSapisid(),
    };
  }

  async function sendConfig() {
    const config = extractConfig();
    if (config && config.context) {
      // Pre-generate the auth hash if possible
      if (config.sapisid) {
        try {
          config.authHeader = await generateSapisidHash(config.sapisid, window.location.origin);
        } catch (e) {
          console.warn('[UTRehome] Failed to generate SAPISIDHASH:', e);
        }
      }
      document.dispatchEvent(
        new CustomEvent('utrehome-config-response', {
          detail: JSON.stringify(config),
        })
      );
      return true;
    }
    return false;
  }

  // Also listen for on-demand config requests (for refreshing auth hash)
  document.addEventListener('utrehome-request-config', async () => {
    await sendConfig();
  });

  // Try immediately
  sendConfig().then(sent => {
    if (sent) return;

    // Poll briefly if ytcfg isn't ready yet
    let attempts = 0;
    const interval = setInterval(async () => {
      attempts++;
      if ((await sendConfig()) || attempts >= 50) {
        clearInterval(interval);
      }
    }, 100);
  });
})();
