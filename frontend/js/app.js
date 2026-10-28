import { Game } from './game.js';

const API = '';
let token = localStorage.getItem('token');
let me = null;
let ws = null;
let game = null;
let currentRoom = null;
let friends = [];
let onlineIds = new Set();

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2500);
}

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

async function api(path, opts = {}) {
  const headers = opts.headers || {};
  const url = path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token || '');
  const res = await fetch(url, { ...opts, headers });
  if (!res.ok) {
    const e = await res.json().catch(() => ({}));
    throw new Error(e.detail || res.statusText);
  }
  return res.json();
}

$('#tab-login').onclick = () => {
  $('#tab-login').classList.add('active'); $('#tab-register').classList.remove('active');
  $('#form-login').classList.remove('hidden'); $('#form-register').classList.add('hidden');
};
$('#tab-register').onclick = () => {
  $('#tab-register').classList.add('active'); $('#tab-login').classList.remove('active');
  $('#form-register').classList.remove('hidden'); $('#form-login').classList.add('hidden');
};

$('#form-login').onsubmit = async (e) => {
  e.preventDefault();
  $('#login-err').textContent = '';
  try {
    const data = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#login-username').value, password: $('#login-password').value })
    }).then(r => r.json());
    if (data.detail) throw new Error(data.detail);
    token = data.token; me = { user_id: data.user_id, username: data.username };
    localStorage.setItem('token', token);
    await enterLobby();
  } catch (err) { $('#login-err').textContent = err.message; }
};

$('#form-register').onsubmit = async (e) => {
  e.preventDefault();
  $('#reg-err').textContent = '';
  try {
    const data = await fetch('/api/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: $('#reg-username').value, password: $('#reg-password').value })
    }).then(r => r.json());
    if (data.detail) throw new Error(data.detail);
    token = data.token; me = { user_id: data.user_id, username: data.username };
    localStorage.setItem('token', token);
    await enterLobby();
  } catch (err) { $('#reg-err').textContent = err.message; }
};

$('#btn-logout').onclick = () => {
  localStorage.removeItem('token');
  token = null; me = null;
  if (ws) ws.close();
  showScreen('screen-auth');
};

async function enterLobby() {
  const m = await api('/api/me');
  me = m;
  $('#me-uid').textContent = me.user_id;
  $('#me-name').textContent = me.username;
  showScreen('screen-lobby');
  connectWS();
  await refreshFriends();
  await refreshRequests();
}
function connectWS() {
  if (ws) ws.close();
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    handleWS(msg);
  };
  ws.onclose = () => { setTimeout(() => { if (token) connectWS(); }, 3000); };
}

function handleWS(msg) {
  switch (msg.type) {
    case 'presence':
      onlineIds = new Set(msg.online);
      renderFriends();
      break;
    case 'friend_request':
      toast(`Friend request from ${msg.from.username}`);
      refreshRequests();
      break;
    case 'friend_accepted':
      toast(`${msg.user.username} accepted your request`);
      refreshFriends();
      break;
    case 'invite':
      toast(`${msg.from.username} invited you to room ${msg.room_code}`);
      if (confirm(`Join ${msg.from.username}'s room ${msg.room_code}?`)) joinRoom(msg.room_code);
      break;
    case 'room_update':
      if (currentRoom && msg.room.code === currentRoom.code) { currentRoom = msg.room; renderRoom(); }
      break;
    case 'race_start':
      currentRoom = msg.room;
      renderRoom();
      startGame(msg.room, msg.countdown);
      break;
    case 'pos':
      if (game) game.onRemotePos(msg);
      break;
    case 'chat':
      appendChat(msg.username, msg.text, 'lobby-chat');
      if (game) game.appendChat(msg.username, msg.text);
      break;
    case 'race_finish':
      if (game) game.onRaceFinish(msg);
      break;
  }
}

async function refreshFriends() {
  friends = await api('/api/friends');
  renderFriends();
}
async function refreshRequests() {
  const reqs = await api('/api/friends/requests');
  const el = $('#friend-requests');
  el.innerHTML = '';
  reqs.forEach(r => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div><div class="name">${r.username}</div><div class="sub">${r.user_id}</div></div>
      <div class="actions">
        <button class="accent" data-uid="${r.user_id}" data-act="accept">Accept</button>
        <button class="ghost" data-uid="${r.user_id}" data-act="reject">Reject</button>
      </div>`;
    el.appendChild(div);
  });
  el.querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      const uid = b.dataset.uid;
      if (b.dataset.act === 'accept') await api('/api/friends/accept?user_id=' + encodeURIComponent(uid), { method: 'POST' });
      else await api('/api/friends/reject?user_id=' + encodeURIComponent(uid), { method: 'POST' });
      await refreshFriends(); await refreshRequests();
    };
  });
}

function renderFriends() {
  const el = $('#friends-list');
  el.innerHTML = '';
  friends.forEach(f => {
    const online = onlineIds.has(f.user_id);
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div><div class="name">${f.username}</div><div class="sub">${f.user_id}</div></div>
      <div class="actions"><span class="dot ${online ? 'online' : ''}"></span></div>`;
    el.appendChild(div);
  });
  const ip = $('#invite-friends-list');
  if (ip) {
    ip.innerHTML = '';
    friends.forEach(f => {
      const div = document.createElement('div');
      div.className = 'item';
      div.innerHTML = `<div><div class="name">${f.username}</div><div class="sub">${f.user_id}</div></div>
        <button data-uid="${f.user_id}">Invite</button>`;
      ip.appendChild(div);
    });
    ip.querySelectorAll('button').forEach(b => {
      b.onclick = async () => {
        if (!currentRoom) return;
        await api(`/api/invite?room_code=${currentRoom.code}&friend_user_id=${encodeURIComponent(b.dataset.uid)}`, { method: 'POST' });
        toast('Invite sent');
        $('#invite-picker').classList.add('hidden');
      };
    });
  }
}

$('#btn-search').onclick = async () => {
  const q = $('#friend-search').value.trim();
  if (!q) return;
  const res = await api('/api/users/search?q=' + encodeURIComponent(q));
  const el = $('#search-results');
  el.innerHTML = '';
  res.forEach(u => {
    const div = document.createElement('div');
    div.className = 'item';
    div.innerHTML = `<div><div class="name">${u.username}</div><div class="sub">${u.user_id}</div></div>
      <div class="actions">
        <span class="dot ${u.online ? 'online' : ''}"></span>
        <button data-uid="${u.user_id}">Add</button>
      </div>`;
    el.appendChild(div);
  });
  el.querySelectorAll('button').forEach(b => {
    b.onclick = async () => {
      try {
        await api('/api/friends/request?user_id=' + encodeURIComponent(b.dataset.uid), { method: 'POST' });
        toast('Request sent');
      } catch (e) { toast(e.message); }
    };
  });
};

async function createRoom() {
  const r = await api('/api/rooms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track: 'neon_circuit' }) });
  currentRoom = r; renderRoom();
}
async function joinRoom(code) {
  try {
    const r = await api('/api/rooms/' + code + '/join', { method: 'POST' });
    currentRoom = r; renderRoom();
  } catch (e) { toast(e.message); }
}
function renderRoom() {
  if (!currentRoom) { $('#room-view').classList.add('hidden'); return; }
  $('#room-view').classList.remove('hidden');
  $('#room-code').textContent = currentRoom.code;
  $('#room-track').textContent = currentRoom.track;
  $('#room-status').textContent = currentRoom.status;
  const el = $('#room-members');
  el.innerHTML = '';
  currentRoom.members.forEach(m => {
    const div = document.createElement('div');
    div.className = 'member' + (m.ready ? ' ready' : '');
    div.innerHTML = `<span>${m.user_id} ${m.user_id === me.user_id ? '(you)' : ''}</span>
      <span>${m.ready ? 'Ready' : 'Not ready'} ${m.online ? '🟢' : '⚪'}</span>`;
    el.appendChild(div);
  });
  const isHost = currentRoom.host_user_id === me.user_id;
  $('#btn-start').classList.toggle('hidden', !isHost || currentRoom.status !== 'waiting');
}
$('#btn-create-room').onclick = createRoom;
$('#btn-solo').onclick = () => startGame({ code: 'SOLO', members: [{ user_id: me.user_id }], track: 'neon_circuit', host_user_id: me.user_id, status: 'running' }, 3, true);
$('#btn-join-room').onclick = () => joinRoom($('#join-code').value.trim().toUpperCase());
$('#btn-ready').onclick = async () => {
  if (!currentRoom) return;
  const meMember = currentRoom.members.find(m => m.user_id === me.user_id);
  const newReady = !(meMember && meMember.ready);
  const r = await api(`/api/rooms/${currentRoom.code}/ready?ready=${newReady}`, { method: 'POST' });
  currentRoom = r; renderRoom();
};
$('#btn-leave').onclick = async () => {
  if (!currentRoom) return;
  await api('/api/rooms/' + currentRoom.code + '/leave', { method: 'POST' });
  currentRoom = null; renderRoom();
};
$('#btn-start').onclick = async () => {
  if (!currentRoom) return;
  try { await api('/api/rooms/' + currentRoom.code + '/start', { method: 'POST' }); }
  catch (e) { toast(e.message); }
};
$('#btn-invite').onclick = () => { $('#invite-picker').classList.toggle('hidden'); renderFriends(); };
$('#btn-cancel-invite').onclick = () => $('#invite-picker').classList.add('hidden');

function appendChat(who, text, containerId) {
  const el = $('#' + containerId);
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="who">${who}:</span> ${escapeHtml(text)}`;
  el.appendChild(div);
  el.scrollTop = el.scrollHeight;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

async function startGame(room, countdown, solo = false) {
  showScreen('screen-game');
  if (!game) {
    game = new Game({
      canvas: $('#game-canvas'), minimap: $('#minimap-canvas'),
      me, token, ws, solo,
      onExit: async () => {
        if (!solo) await api('/api/rooms/' + room.code + '/leave', { method: 'POST' }).catch(()=>{});
        if (!solo) currentRoom = null;
        showScreen('screen-lobby');
        game.dispose();
        game = null;
      }
    });
  }
  await game.init(room, countdown);
}
$('#btn-exit-game').onclick = async () => { if (game) game.exit(); };

if (token) {
  api('/api/me').then(m => { me = m; enterLobby(); }).catch(() => { localStorage.removeItem('token'); token = null; showScreen('screen-auth'); });
} else {
  showScreen('screen-auth');
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && document.activeElement && document.activeElement.id === 'game-chat-input') {
    const inp = $('#game-chat-input');
    const text = inp.value.trim();
    if (text && ws) { ws.send(JSON.stringify({ type: 'chat', text })); inp.value = ''; }
  }
});
window.addEventListener('beforeunload', () => { if (ws) ws.close(); });
export {};

