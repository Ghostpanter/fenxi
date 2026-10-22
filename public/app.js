(function () {
  const gate = document.getElementById('gate');
  const gateForm = document.getElementById('gateForm');
  const gateError = document.getElementById('gateError');
  const gateHealth = document.getElementById('gateHealth');
  const nameInput = document.getElementById('name');
  const codeInput = document.getElementById('code');
  const enterBtn = document.getElementById('enter');
  const sheet = document.getElementById('sheet');
  const who = document.getElementById('who');
  const pillText = document.getElementById('pillText');
  const dot = document.getElementById('dot');
  const notice = document.getElementById('notice');
  const thread = document.getElementById('thread');
  const composer = document.getElementById('composer');
  const box = document.getElementById('box');
  const sendBtn = document.getElementById('send');
  const freshBtn = document.getElementById('fresh');
  const leaveBtn = document.getElementById('leave');

  const TOKEN_KEY = 'fenxi_token';
  let messages = [];
  let ws = null;
  let retry = 500;
  let left = false;
  let loggedIn = false;
  let sending = false;
  let name = '';

  function token() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }

  function authHeaders() {
    const headers = { 'content-type': 'application/json' };
    if (token()) headers.authorization = `Bearer ${token()}`;
    return headers;
  }

  function showGate() {
    document.body.classList.remove('in-chat');
    sheet.hidden = true;
    gate.hidden = false;
  }

  function showChat() {
    document.body.classList.add('in-chat');
    gate.hidden = true;
    sheet.hidden = false;
    who.textContent = name ? `你的页面 · ${name}` : '你的页面';
    box.focus();
  }

  function setNotice(text) {
    notice.textContent = text || '';
  }

  function setPill(text, ok) {
    pillText.textContent = text;
    dot.classList.toggle('ok', !!ok);
  }

  function drawMessage(m) {
    const li = document.createElement('li');
    li.className = `msg ${m.role === 'user' ? 'user' : 'assistant'}${m.pending ? ' streaming' : ''}`;
    li.dataset.id = m.id;
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (m.text) bubble.innerHTML = FenxiFormat.renderMessage(m.text);
    else if (m.pending) bubble.textContent = '正在写';
    li.appendChild(bubble);
    for (const src of m.images || []) {
      const safe = FenxiFormat.safeImageUrl(src);
      if (!safe) continue;
      const img = document.createElement('img');
      img.className = 'shot';
      img.alt = '';
      img.src = safe;
      li.appendChild(img);
    }
    return li;
  }

  function renderThread() {
    const nearBottom = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 90;
    thread.replaceChildren(...messages.map(drawMessage));
    if (nearBottom) thread.scrollTop = thread.scrollHeight;
  }

  function upsert(message) {
    const index = messages.findIndex((item) => item.id === message.id);
    if (index >= 0) messages[index] = message;
    else messages.push(message);
    sending = messages.some((item) => item.pending);
    sendBtn.textContent = sending ? '停止' : '发送';
    renderThread();
  }

  function applyLogin(next) {
    loggedIn = !!next;
    if (loggedIn) setPill('网页已登录', true);
    else setPill('网页还没登录', false);
    sendBtn.disabled = false;
  }

  function connect() {
    if (left || !token()) return;
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}/ws`);
    ws.addEventListener('open', () => {
      retry = 500;
      ws.send(JSON.stringify({ type: 'auth', token: token() }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === 'hello') {
        name = msg.name || name;
        who.textContent = name ? `你的页面 · ${name}` : '你的页面';
        messages = msg.messages || [];
        sending = messages.some((item) => item.pending);
        sendBtn.textContent = sending ? '停止' : '发送';
        applyLogin(msg.loggedIn);
        renderThread();
        return;
      }
      if (msg.type === 'message') {
        setNotice('');
        upsert(msg.message);
        return;
      }
      if (msg.type === 'drop') {
        messages = messages.filter((item) => item.id !== msg.id);
        sending = messages.some((item) => item.pending);
        sendBtn.textContent = sending ? '停止' : '发送';
        renderThread();
        return;
      }
      if (msg.type === 'clear') {
        messages = [];
        sending = false;
        sendBtn.textContent = '发送';
        freshBtn.textContent = '新的一页';
        freshBtn.classList.remove('armed');
        renderThread();
        return;
      }
      if (msg.type === 'status') {
        applyLogin(msg.loggedIn);
        return;
      }
      if (msg.type === 'notice' || msg.type === 'error') {
        setNotice(msg.message || '');
        sending = messages.some((item) => item.pending);
        sendBtn.textContent = sending ? '停止' : '发送';
        return;
      }
      if (msg.type === 'bye') {
        left = true;
        localStorage.removeItem(TOKEN_KEY);
        if (ws) ws.close();
        messages = [];
        showGate();
      }
    });
    ws.addEventListener('close', () => {
      if (left || !token()) return;
      setPill('正在接回你的这一页', false);
      setTimeout(connect, retry);
      retry = Math.min(5000, retry * 1.6);
    });
  }

  async function resume() {
    if (!token()) return;
    const res = await fetch('/api/me', { headers: authHeaders() });
    if (!res.ok) {
      localStorage.removeItem(TOKEN_KEY);
      return;
    }
    const data = await res.json();
    name = data.name || '';
    applyLogin(data.loggedIn);
    showChat();
    connect();
  }

  gateForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    gateError.textContent = '';
    enterBtn.disabled = true;
    try {
      const res = await fetch('/api/join', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: nameInput.value, code: codeInput.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        gateError.textContent = data.error || '进不去';
        return;
      }
      localStorage.setItem(TOKEN_KEY, data.token);
      name = data.name || nameInput.value.trim();
      left = false;
      messages = [];
      showChat();
      connect();
    } catch {
      gateError.textContent = '没连上。';
    } finally {
      enterBtn.disabled = false;
    }
  });

  function sendOrStop() {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      setNotice('还没接上你的那一页。');
      return;
    }
    if (sending) {
      ws.send(JSON.stringify({ type: 'stop' }));
      return;
    }
    const text = box.value.trim();
    if (!text) return;
    if (!loggedIn) {
      setNotice('网页还没登录。等主人在容器桌面里登录之后，这一页就能写。');
      return;
    }
    ws.send(JSON.stringify({ type: 'send', text }));
    box.value = '';
    box.style.height = 'auto';
    sending = true;
    sendBtn.textContent = '停止';
  }

  composer.addEventListener('submit', (event) => {
    event.preventDefault();
    sendOrStop();
  });

  box.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendOrStop();
    }
  });

  box.addEventListener('input', () => {
    box.style.height = 'auto';
    box.style.height = `${Math.min(160, box.scrollHeight)}px`;
  });

  freshBtn.addEventListener('click', () => {
    if (!freshBtn.classList.contains('armed')) {
      freshBtn.classList.add('armed');
      freshBtn.textContent = '确认换页';
      return;
    }
    freshBtn.classList.remove('armed');
    freshBtn.textContent = '新的一页';
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'new' }));
  });

  leaveBtn.addEventListener('click', async () => {
    if (!leaveBtn.classList.contains('armed')) {
      leaveBtn.classList.add('armed');
      leaveBtn.textContent = '确认离开';
      return;
    }
    left = true;
    try {
      await fetch('/api/leave', { method: 'POST', headers: authHeaders() });
    } catch { /* still drop local seat */ }
    localStorage.removeItem(TOKEN_KEY);
    if (ws) ws.close();
    messages = [];
    leaveBtn.classList.remove('armed');
    leaveBtn.textContent = '离开';
    showGate();
  });

  async function pollHealth() {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      const login = data.loggedIn ? '容器里的网页已登录' : '容器里的网页还没登录';
      const seats = typeof data.seats === 'number' ? ` · ${data.seats}/${data.maxSeats} 席` : '';
      gateHealth.textContent = login + seats;
      if (document.body.classList.contains('in-chat') && (!ws || ws.readyState === WebSocket.OPEN)) {
        applyLogin(data.loggedIn);
      }
    } catch {
      gateHealth.textContent = '还没连上分席。';
    }
  }

  pollHealth();
  setInterval(pollHealth, 5000);
  resume().catch(() => {});
})();
