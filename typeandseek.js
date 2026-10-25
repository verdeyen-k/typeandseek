// Type and Seek: one seeker, one hider, and everyone else is a fakie. The seeker types questions and everyone else
// types answers. The hider has to tell the truth; the fakies know who the hider is and can lie to cover for them.
// The seeker gets one guess. Right, and the seeker wins; wrong, and the hider and fakies win.
(() => {
  // Bump with the ?v= on the script in index.html whenever what goes in the room changes.
  const VERSION = 1;
  const OUTDATED = 'That room is using a different version of Type and Seek. Everyone needs to refresh the page.';
  const ROOMS = 'typeandseek/rooms';
  const MIN_PLAYERS = 3, MAX_PLAYERS = 10, MAX_TEXT = 200;

  const ROLES = {
    seeker: { icon: '🔎', name: 'Seeker', color: '#4dabf7' },
    hider:  { icon: '🙈', name: 'Hider',  color: '#ffb84d' },
    fakie:  { icon: '🎭', name: 'Fakie',  color: '#b47cf0' },
  };

  const db = window.firebase ? (firebase.initializeApp({
    apiKey:            'AIzaSyAsJboNGVuESMhkivllUD0o8MUB5LUCMRQ',
    authDomain:        'kvgames.firebaseapp.com',
    databaseURL:       'https://kvgames-default-rtdb.firebaseio.com',
    projectId:         'kvgames',
    storageBucket:     'kvgames.firebasestorage.app',
    messagingSenderId: '463308384695',
    appId:             '1:463308384695:web:5d57623ebd52101ad26032',
  }), firebase.database()) : null;

  const $ = id => document.getElementById(id);
  const show = id => {
    for (const s of document.querySelectorAll('.screen')) s.hidden = s.id !== id;
    if (id !== 'game') $('over').hidden = true;
  };
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} },
  };
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const myId = Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  let room = null;  // { code, ref, st, listener, joining }

  // Firebase hands arrays back as objects ({0: x, 1: y}) and drops empty ones.
  const toArr = v => !v ? [] : Array.isArray(v) ? v.filter(x => x != null) : Object.keys(v).sort((a, b) => a - b).map(k => v[k]);
  const playerList = st => Object.entries((st && st.players) || {}).filter(([, p]) => p && p.name)
    .map(([id, p]) => ({ id, ...p })).sort((a, b) => a.at - b.at);
  const nameOf = (st, id) => (st.players && st.players[id] && st.players[id].name) || (st.names && st.names[id]) || 'Someone';
  const roleOf = (st, id) => (st.roles || {})[id];
  const idWith = (st, role) => Object.keys(st.roles || {}).find(id => st.roles[id] === role);

  function genCode() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)];
    return s;
  }
  function busy(on) { for (const b of document.querySelectorAll('#menu button')) b.disabled = on; }
  function myName() {
    const name = $('name').value.trim().slice(0, 16);
    if (!name) { $('menu-error').textContent = 'Type your name first.'; $('name').focus(); return null; }
    store.set('typeandseek-name', name);
    return name;
  }
  const NO_SERVER = "Can't reach the game server. Check the internet connection.";
  const now = () => Date.now();

  // ── Rooms ────────────────────────────────────────────────────────────────
  async function createRoom(name) {
    if (!db) { $('menu-error').textContent = NO_SERVER; return; }
    busy(true);
    $('menu-error').textContent = '';
    try {
      let code, ref;
      for (let i = 0; i < 10; i++) {
        code = genCode();
        ref = db.ref(`${ROOMS}/${code}`);
        if (!(await ref.get()).exists()) break;
      }
      await ref.set({
        host: myId, v: VERSION, created: firebase.database.ServerValue.TIMESTAMP, phase: 'lobby',
        maxQ: Math.max(1, Math.min(50, Number(store.get('typeandseek-maxq')) || 15)),
        players: { [myId]: { name, at: now() } },
      });
      ref.onDisconnect().remove();
      await enterRoom(code, ref);
    } catch (e) {
      $('menu-error').textContent = "Couldn't create a room. Check the internet connection.";
    }
    busy(false);
  }

  async function joinRoom(code, name) {
    if (!db) { $('menu-error').textContent = NO_SERVER; return; }
    busy(true);
    $('menu-error').textContent = '';
    const ref = db.ref(`${ROOMS}/${code}`);
    try {
      const st = await enterRoom(code, ref, true);
      const problem = !st || !st.host ? `There's no room ${code}.` : st.v !== VERSION ? OUTDATED
        : st.phase !== 'lobby' ? 'That game has already started. Wait for it to finish, then join.'
        : playerList(st).length >= MAX_PLAYERS ? `That room is full (${MAX_PLAYERS} players).` : null;
      if (problem) throw new Error(problem);
      // A transaction, so two people joining at once can't go over the limit.
      const res = await ref.child('players').transaction(cur => {
        if (!cur) return;
        if (Object.values(cur).filter(p => p && p.name).length >= MAX_PLAYERS) return;
        cur[myId] = { name, at: now() };
        return cur;
      });
      if (!res.committed) throw new Error(`That room is full (${MAX_PLAYERS} players).`);
      ref.child(`players/${myId}`).onDisconnect().remove();
      room.joining = false;
      render();
    } catch (e) {
      leaveRoom();
      show('menu');
      $('menu-error').textContent = e.message && !/^FIREBASE|permission/i.test(e.message) ? e.message
        : "Couldn't join. Check the code and the internet connection.";
    }
    busy(false);
  }

  // Start listening to the room. Resolves with its first data, so a join can check it before taking a seat.
  function enterRoom(code, ref, joining = false) {
    leaveRoom();
    room = { code, ref, st: null, joining, shown: 0 };
    const r = room;
    return new Promise(resolve => {
      r.listener = ref.on('value', snap => {
        if (room !== r) return;
        r.st = snap.val();
        if (resolve) { const f = resolve; resolve = null; f(r.st); if (joining) return; }
        if (!r.joining) render();
      }, () => { if (resolve) { const f = resolve; resolve = null; f(null); } });
    });
  }
  function leaveRoom() {
    const r = room;
    if (!r) return;
    room = null;
    r.ref.off('value', r.listener);
    if (r.st && r.st.host === myId) { r.ref.onDisconnect().cancel(); r.ref.remove(); }
    else if (!r.joining) {
      const c = r.ref.child(`players/${myId}`);
      c.onDisconnect().cancel();
      c.remove();
    }
  }

  // ── Game actions ─────────────────────────────────────────────────────────
  function startGame() {
    const st = room && room.st;
    if (!st || st.host !== myId) return;
    const ids = playerList(st).map(p => p.id);
    if (ids.length < MIN_PLAYERS) return;
    // Shuffle, then the first is the seeker, the second the hider, and the rest are fakies.
    for (let i = ids.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ids[i], ids[j]] = [ids[j], ids[i]]; }
    const roles = {}, names = {};
    ids.forEach((id, k) => { roles[id] = k === 0 ? 'seeker' : k === 1 ? 'hider' : 'fakie'; names[id] = st.players[id].name; });
    room.ref.update({ phase: 'ask', roles, names, questions: null, guess: null, ended: null });
  }
  function playAgain() {
    if (room && room.st && room.st.host === myId) room.ref.update({ phase: 'lobby', roles: null, names: null, questions: null, guess: null, ended: null });
  }
  function ask() {
    const st = room && room.st, q = $('q-input').value.trim().slice(0, MAX_TEXT);
    if (!st || !q || st.phase !== 'ask' || roleOf(st, myId) !== 'seeker') return;
    const n = toArr(st.questions).length;
    if (n >= st.maxQ) return;
    room.ref.update({ [`questions/${n}`]: { q, at: now() }, phase: 'answer' });
    $('q-input').value = '';
  }
  function answer() {
    const st = room && room.st, a = $('a-input').value.trim().slice(0, MAX_TEXT);
    if (!st || !a || st.phase !== 'answer') return;
    const n = toArr(st.questions).length - 1;
    room.ref.child(`questions/${n}/answers/${myId}`).set(a);
    $('a-input').value = '';
  }
  function guess(id) {
    const st = room && room.st;
    if (!st || roleOf(st, myId) !== 'seeker' || st.phase === 'over') return;
    room.ref.update({ phase: 'over', guess: id });
  }

  // Everyone still in the game who has to answer: all the players except the seeker.
  const answerers = st => playerList(st).filter(p => roleOf(st, p.id) && roleOf(st, p.id) !== 'seeker');

  // ── Screens ──────────────────────────────────────────────────────────────
  let guessing = false;

  function render() {
    const st = room && room.st;
    if (!room) { show('menu'); return; }
    if (!st || !st.host) { leaveRoom(); show('menu'); $('menu-error').textContent = 'The host left, so the room closed.'; return; }
    if (!st.players || !st.players[myId]) { leaveRoom(); show('menu'); $('menu-error').textContent = 'You left the room.'; return; }
    const players = playerList(st), host = st.host === myId;

    if (st.phase === 'lobby') {
      guessing = false;
      room.shown = 0;
      show('lobby');
      $('code').textContent = room.code;
      $('lobby-players').innerHTML = players.map(p => `<li><span class="pname">${esc(p.name)}</span>
        <span class="muted">${p.id === st.host ? 'host' : ''}${p.id === myId ? (p.id === st.host ? ' · you' : 'you') : ''}</span></li>`).join('');
      const mq = $('maxq');
      mq.disabled = !host;
      if (document.activeElement !== mq) mq.value = st.maxQ;
      $('start').hidden = !host;
      $('start').disabled = players.length < MIN_PLAYERS;
      $('start').textContent = players.length < MIN_PLAYERS ? `Need ${MIN_PLAYERS - players.length} more player${MIN_PLAYERS - players.length === 1 ? '' : 's'}` : `Start (${players.length} players)`;
      $('lobby-wait').hidden = host;
      return;
    }

    // If the seeker or hider leaves, the game can't go on. The host ends it.
    const seekerId = idWith(st, 'seeker'), hiderId = idWith(st, 'hider');
    if (host && st.phase !== 'over' && (!st.players[seekerId] || !st.players[hiderId])) {
      room.ref.update({ phase: 'over', ended: !st.players[seekerId] ? 'seeker' : 'hider' });
      return;
    }

    show('game');
    const me = roleOf(st, myId), qs = toArr(st.questions), asked = qs.length;
    $('game-code').textContent = room.code;
    $('qcount').textContent = `Question ${Math.min(asked, st.maxQ)} of ${st.maxQ}`;

    // My role card.
    const R = ROLES[me] || ROLES.fakie;
    $('role').style.setProperty('--c', R.color);
    $('role-icon').textContent = R.icon;
    $('role-name').textContent = `You're the ${R.name}`;
    $('role-tip').innerHTML = me === 'seeker' ? `Ask questions to find the hider. You get ${st.maxQ}, and one guess.`
      : me === 'hider' ? 'You must answer <b>truthfully</b>. Don\'t get caught!'
      : `The hider is <b>${esc(nameOf(st, hiderId))}</b>. You can lie. Confuse the seeker!`;

    // The questions and answers so far. Answers to the newest question stay hidden until everyone has answered.
    const need = answerers(st);
    $('log').innerHTML = qs.map((item, k) => {
      const answers = item.answers || {};
      const open = k === asked - 1 && st.phase === 'answer';
      const ids = Object.keys(answers).sort((a, b) => nameOf(st, a).localeCompare(nameOf(st, b)));
      const body = open
        ? `<p class="muted">${answers[myId] ? `You answered: “${esc(answers[myId])}”. ` : ''}Waiting for ${esc(need.filter(p => !answers[p.id]).map(p => p.name).join(', ')) || 'everyone'}…</p>`
        : ids.map(id => `<div class="ans"><span class="who">${esc(nameOf(st, id))}</span><span>${esc(answers[id])}</span></div>`).join('') || '<p class="muted">No answers.</p>';
      return `<div class="qa"><div class="q"><span class="qn">Q${k + 1}</span>${esc(item.q)}</div>${body}</div>`;
    }).join('') || `<p class="muted center">${me === 'seeker' ? 'Type your first question below.' : `Waiting for ${esc(nameOf(st, seekerId))} to ask the first question…`}</p>`;
    if (asked !== room.shown || st.phase !== room.lastPhase) { $('log').scrollTop = $('log').scrollHeight; room.shown = asked; room.lastPhase = st.phase; }

    // What I can do right now.
    const panel = id => { for (const el of document.querySelectorAll('.act')) el.hidden = el.id !== id; };
    const outOfQs = asked >= st.maxQ;
    if (st.phase === 'over') panel(null);
    else if (me === 'seeker' && (guessing || (st.phase === 'ask' && outOfQs))) {
      panel('act-guess');
      $('guess-title').textContent = outOfQs ? "That's all your questions. Who is the hider?" : 'Who is the hider? You only get one guess!';
      $('guess-cancel').hidden = outOfQs;
      $('guess-list').innerHTML = need.map(p => `<button class="btn" type="button" data-id="${p.id}">${esc(p.name)}</button>`).join('');
      for (const b of $('guess-list').querySelectorAll('button')) b.onclick = () => { if (confirm(`Guess ${nameOf(st, b.dataset.id)}? You only get one guess.`)) guess(b.dataset.id); };
    } else if (me === 'seeker' && st.phase === 'ask') {
      panel('act-ask');
      $('ask-left').textContent = `${st.maxQ - asked} question${st.maxQ - asked === 1 ? '' : 's'} left`;
    } else if (me === 'seeker') {
      panel('act-wait');
      $('wait-text').textContent = 'Waiting for everyone to answer…';
    } else if (st.phase === 'answer' && !(qs[asked - 1].answers || {})[myId]) {
      panel('act-answer');
      $('answer-q').textContent = qs[asked - 1].q;
      $('answer-tip').innerHTML = me === 'hider' ? '🙈 Remember: tell the <b>truth</b>.' : '🎭 You can lie, or tell the truth. Help the hider!';
    } else {
      panel('act-wait');
      $('wait-text').textContent = st.phase === 'answer' ? 'Waiting for everyone else to answer…' : `Waiting for ${nameOf(st, seekerId)} to ask a question…`;
    }

    // Once everyone still here has answered, the host moves on to the next question.
    if (host && st.phase === 'answer' && asked && need.every(p => (qs[asked - 1].answers || {})[p.id])) room.ref.update({ phase: 'ask' });

    // Results.
    $('over').hidden = st.phase !== 'over';
    if (st.phase === 'over') {
      guessing = false;
      const right = st.guess && st.guess === hiderId;
      $('result-title').textContent = st.ended ? `The ${st.ended} left, so the game is over.`
        : right ? '🔎 The seeker wins!' : '🙈 The hider and fakies win!';
      $('result-text').innerHTML = st.ended ? '' : `${esc(nameOf(st, seekerId))} guessed <b>${esc(nameOf(st, st.guess))}</b>, who was ${right ? 'the hider!' : 'a fakie.'}`;
      $('result-roles').innerHTML = Object.keys(st.roles || {}).sort((a, b) => ['seeker', 'hider', 'fakie'].indexOf(st.roles[a]) - ['seeker', 'hider', 'fakie'].indexOf(st.roles[b]))
        .map(id => `<li><span class="tag" style="--c:${ROLES[st.roles[id]].color}">${ROLES[st.roles[id]].icon} ${ROLES[st.roles[id]].name}</span><span class="pname">${esc(nameOf(st, id))}</span></li>`).join('');
      $('again').hidden = !host;
      $('again-wait').hidden = host;
    }
  }

  // ── Buttons ──────────────────────────────────────────────────────────────
  $('name').value = store.get('typeandseek-name') || '';
  $('create').onclick = () => { const n = myName(); if (n) createRoom(n); };
  $('join').onclick = () => {
    const n = myName(); if (!n) return;
    const code = $('join-code').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}$/.test(code)) { $('menu-error').textContent = 'Room codes are 4 letters.'; return; }
    joinRoom(code, n);
  };
  $('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('join').click(); });
  $('maxq').onchange = () => {
    const n = Math.max(1, Math.min(50, Math.round(Number($('maxq').value)) || 15));
    $('maxq').value = n;
    store.set('typeandseek-maxq', n);
    if (room && room.st && room.st.host === myId) room.ref.update({ maxQ: n });
  };
  $('start').onclick = startGame;
  $('again').onclick = playAgain;
  $('ask').onclick = ask;
  $('answer').onclick = answer;
  // Enter sends; Shift+Enter makes a new line.
  for (const [input, btn] of [['q-input', 'ask'], ['a-input', 'answer']]) {
    $(input).maxLength = MAX_TEXT;
    $(input).addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $(btn).click(); } });
  }
  $('guess-open').onclick = () => { guessing = true; render(); };
  $('guess-cancel').onclick = () => { guessing = false; render(); };
  for (const id of ['lobby-leave', 'game-leave', 'over-leave']) $(id).onclick = () => { if (id !== 'game-leave' || confirm('Leave the game?')) { leaveRoom(); show('menu'); } };
  window.addEventListener('pagehide', leaveRoom);

  if (!db) $('menu-error').textContent = NO_SERVER;
  show('menu');
})();
