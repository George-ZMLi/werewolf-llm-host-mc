/**
 * Minimal werewolf UI (plan task 15).
 *
 * The pure string renderers (renderPhaseBanner, renderSeatList,
 * renderDraftOverlay) are unit-testable in Node without a DOM; boot() wires
 * a WerewolfClient-like client (see createBrowserClient) to the page DOM.
 * Served as-is - no build step.
 */

const PHASE_NAMES = {
  lobby: 'Lobby',
  night: 'Night',
  dawn: 'Dawn',
  day_discussion: 'Day Discussion',
  voting: 'Voting',
  finished: 'Finished',
};

const PHASE_BUDGETS_MS = {
  lobby: 300000,
  night: 120000,
  dawn: 30000,
  day_discussion: 180000,
  voting: 90000,
  finished: 0,
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

/** Current phase name plus a countdown of whole remaining seconds. */
export function renderPhaseBanner(phase, remainingMs) {
  const name = PHASE_NAMES[phase] || phase;
  const secs = Math.max(0, Math.ceil(Number(remainingMs || 0) / 1000));
  return (
    '<div class="phase-banner"><span class="phase">' + esc(name) + '</span>' +
    '<span class="remaining">' + secs + 's</span></div>'
  );
}

/** Seat chips; offline seats are dimmed, the acting seat is highlighted. */
export function renderSeatList(seats, actingSeatId) {
  const items = (seats || []).map((s) => {
    const cls =
      'seat' + (s.offline ? ' offline' : '') + (s.seatId === actingSeatId ? ' acting' : '');
    const off = s.offline ? ' (offline)' : '';
    return '<li class="' + cls + '">' + esc(s.name || s.seatId) + off + '</li>';
  });
  return '<ul class="seat-list">' + items.join('') + '</ul>';
}

/** Draft-confirm overlay (spec section 7): editable action + confirm. */
export function renderDraftOverlay(draft) {
  return (
    '<div class="draft-overlay"><div class="draft-box">' +
    '<h2>Draft action for seat ' + esc(draft.seatId) + '</h2>' +
    '<p class="draft-countdown">20s</p>' +
    '<textarea class="draft-text" rows="6" spellcheck="false">' +
    esc(JSON.stringify(draft.action, null, 2)) + '</textarea>' +
    '<div class="row"><button class="draft-confirm">Confirm</button>' +
    '<button class="draft-reject">Reject</button></div>' +
    '</div></div>'
  );
}

/**
 * Browser transport implementing the minimal client surface boot() needs:
 * join / send(action, seatId) / on(type, cb) / close.
 */
export function createBrowserClient(wsUrl) {
  const listeners = {};
  const sock = new WebSocket(wsUrl);
  const client = {
    on(type, cb) {
      (listeners[type] || (listeners[type] = [])).push(cb);
      return client;
    },
    send(action, seatId) {
      if (sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify({ type: 'seat_action', payload: { seatId, action } }));
      }
      return client;
    },
    join(roomId, name, seatId) {
      const payload = { roomId, name };
      if (seatId !== undefined) payload.seatId = seatId;
      sock.send(JSON.stringify({ type: 'join', payload }));
      return client;
    },
    close() {
      sock.close();
      return client;
    },
  };
  sock.addEventListener('message', (e) => {
    let m;
    try {
      m = JSON.parse(e.data);
    } catch {
      return;
    }
    (listeners[m.type] || []).forEach((cb) => cb(m));
  });
  return client;
}

/**
 * Wire the client to the page DOM. `root` is document-like (injectable for
 * tests); boot is a no-op without a browser DOM.
 */
export function boot(deps) {
  const { client, root, roomId, name } = deps;
  if (!root || !root.getElementById) return; // non-DOM environment
  const bannerEl = root.getElementById('banner');
  const seatsEl = root.getElementById('seats');
  const logEl = root.getElementById('log');
  const speechEl = root.getElementById('speech');
  const sendEl = root.getElementById('send');
  const draftEl = root.getElementById('draft-root');

  let mySeatId = null;
  let phase = 'lobby';
  let phaseStartedAt = 0;

  function remainingMs() {
    if (phase === 'finished') return 0;
    return Math.max(0, phaseStartedAt + (PHASE_BUDGETS_MS[phase] || 0) - Date.now());
  }
  function refreshBanner() {
    bannerEl.innerHTML = renderPhaseBanner(phase, remainingMs());
  }
  function appendLog(line) {
    logEl.appendChild(root.createTextNode(line + '\n'));
    logEl.scrollTop = logEl.scrollHeight;
  }

  client.on('lobby_update', (m) => {
    if (m.seatId) mySeatId = m.seatId;
    const room = m.room || {};
    const lastPhase = (room.log || []).filter((e) => e.type === 'phase_change').pop();
    if (lastPhase) {
      phase = (lastPhase.payload || {}).phase || phase;
      phaseStartedAt = lastPhase.ts || 0;
    } else if (room.status === 'lobby') {
      phase = 'lobby';
    }
    refreshBanner();
    seatsEl.innerHTML = renderSeatList(room.seats || [], null);
  });

  client.on('phase_event', (m) => {
    const e = m.event || {};
    if (e.type === 'phase_change') {
      phase = (e.payload || {}).phase || phase;
      phaseStartedAt = e.ts || 0;
      refreshBanner();
    }
    appendLog('[' + e.phase + '] ' + e.type + ' ' + JSON.stringify(e.payload || {}));
  });

  client.on('chat', (m) => {
    const e = m.event || {};
    appendLog('chat: ' + JSON.stringify(e.payload || {}));
  });

  client.on('llm_draft', (m) => showDraft(m.draft));

  client.on('error', (m) => appendLog('error: ' + (m.message || '')));

  function hideDraft() {
    draftEl.innerHTML = '';
  }
  function showDraft(draft) {
    if (!draft || mySeatId === null || draft.seatId !== mySeatId) return;
    draftEl.innerHTML = renderDraftOverlay(draft);
    const box = draftEl.firstElementChild;
    const cd = box.querySelector('.draft-countdown');
    const ta = box.querySelector('.draft-text');
    let left = 20;
    const timer = setInterval(() => {
      left -= 1;
      cd.textContent = left + 's';
      if (left <= 0) {
        clearInterval(timer);
        hideDraft();
      }
    }, 1000);
    function submit() {
      clearInterval(timer);
      hideDraft();
      let action = ta.value;
      try {
        action = JSON.parse(ta.value);
      } catch {
        // keep as a string speech
      }
      client.send(action, mySeatId);
    }
    box.querySelector('.draft-confirm').addEventListener('click', submit);
    box.querySelector('.draft-reject').addEventListener('click', () => {
      clearInterval(timer);
      hideDraft();
      client.send({ action: 'pass', targets: [] }, mySeatId);
    });
  }

  sendEl.addEventListener('click', () => {
    if (mySeatId === null) return;
    client.send(speechEl.value || '', mySeatId);
    speechEl.value = '';
  });

  if (roomId !== undefined) client.join(roomId, name || 'Player');
  refreshBanner();
}