(function () {
  const hostInput = document.getElementById('host');
  const portInput = document.getElementById('port');
  const whereInput = document.getElementById('where');
  const tenantInput = document.getElementById('tenantId');
  const error = document.getElementById('deskError');
  const params = new URLSearchParams(location.search);
  const pagePort = location.port || (location.protocol === 'https:' ? '443' : '80');

  hostInput.value = params.get('host') || location.hostname;
  portInput.value = params.get('port') || pagePort;
  if (params.get('port') === '6080') whereInput.value = 'direct';

  whereInput.addEventListener('change', () => {
    if (whereInput.value === 'direct') portInput.value = '6080';
    else portInput.value = pagePort;
  });

  function tenantId() {
    return (tenantInput && tenantInput.value.trim()) || '';
  }

  function cleanHost(value) {
    const host = value.trim();
    if (!/^[A-Za-z0-9.:[\]-]+$/.test(host)) return null;
    return host;
  }

  function cleanPort(value) {
    if (!/^\d+$/.test(value.trim())) return null;
    const port = Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    return String(port);
  }

  function hostForUrl(host) {
    if (host.includes(':') && !host.startsWith('[')) return `[${host}]`;
    return host;
  }

  document.getElementById('desk').addEventListener('submit', (event) => {
    event.preventDefault();
    error.textContent = '';
    const host = cleanHost(hostInput.value);
    const port = cleanPort(portInput.value);
    const tenant = tenantId();
    if (!tenant) {
      error.textContent = '请填写租户编号。';
      return;
    }
    if (!/^[a-z][a-z0-9-]{0,31}$/.test(tenant)) {
      error.textContent = '租户编号不对。';
      return;
    }
    if (!host || !port) {
      error.textContent = '地址或端口不对。';
      return;
    }
    const sameHost = host.replace(/^\[|\]$/g, '') === location.hostname.replace(/^\[|\]$/g, '');
    const samePort = port === pagePort;
    const secure = location.protocol === 'https:' ? '1' : '0';
    if (sameHost && samePort) {
      const q = new URLSearchParams({
        autoconnect: '1',
        resize: 'scale',
        path: `websockify/${tenant}`,
        encrypt: secure,
      });
      location.assign(`/novnc/${encodeURIComponent(tenant)}/vnc.html?${q}`);
      return;
    }
    if (whereInput.value === 'direct' && tenant !== 'default') {
      error.textContent = '6080 只接 default 租户的桌面。其他租户请选「跟分席同一个地址」。';
      return;
    }
    const q = new URLSearchParams({ autoconnect: '1', resize: 'scale' });
    location.assign(`${location.protocol}//${hostForUrl(host)}:${port}/vnc.html?${q}`);
  });
})();
