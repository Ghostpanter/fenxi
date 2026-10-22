(function () {
  const hostInput = document.getElementById('host');
  const portInput = document.getElementById('port');
  const whereInput = document.getElementById('where');
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
        path: 'websockify',
        encrypt: secure,
      });
      location.assign(`/novnc/vnc.html?${q}`);
      return;
    }
    const q = new URLSearchParams({ autoconnect: '1', resize: 'scale' });
    location.assign(`${location.protocol}//${hostForUrl(host)}:${port}/vnc.html?${q}`);
  });
})();
