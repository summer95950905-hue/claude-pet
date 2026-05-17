// State machine for the four meerkats.
// Scout = source of truth for CC session state.
// Knox  = WaitingConfirm guard.
// Pip   = Completed celebrant.
// Bubbles = local health timer (water reminder every 45 min by default).
//
// Each pet lives in its own BrowserWindow. The window URL carries ?pet=<id>;
// every renderer runs the same state machine but only the matching pet's DOM
// element is kept, so setState calls for other pets become silent no-ops.

const PET_ID = new URLSearchParams(location.search).get('pet');
if (PET_ID) {
  for (const el of document.querySelectorAll('.pet')) {
    if (el.dataset.id !== PET_ID) el.remove();
  }
  document.body.dataset.pet = PET_ID;
}

// Global scale comes from the loadFile URL query (set by main process every
// time it creates the window). CSS uses --scale-mul to scale #stage; window
// physical size is already scaled in main, so visual + window stay in sync.
const PET_SCALE = parseFloat(new URLSearchParams(location.search).get('scale')) || 1;
document.documentElement.style.setProperty('--scale-mul', String(PET_SCALE));

const pets = {
  scout: document.querySelector('.pet[data-id="scout"]'),
  knox: document.querySelector('.pet[data-id="knox"]'),
  bubbles: document.querySelector('.pet[data-id="bubbles"]'),
  pip: document.querySelector('.pet[data-id="pip"]'),
};
const statusEl = document.getElementById('status');

const DEFAULTS = {
  staleAfterMs: 60_000,
  waterIntervalMs: 45 * 60_000,
};

let sessionState = 'idle'; // idle | thinking | running | waiting | completed | failed | stale
let lastWaterAt = Date.now();

// Knox is decoupled from sessionState: it's a discrete "attention requested"
// signal driven by either Notification or the Pre→Post-gap heuristic, and
// auto-clears after a timeout or on Stop / SessionEnd / PostToolUse / click.
const KNOX_ALERT_TIMEOUT_MS = 30_000;
const KNOX_HEURISTIC_TIMEOUT_MS = 10_000;
// Escalation: if user hasn't acted on an alert within this window, Knox
// switches from alert (waving placard) to jumping (bouncing/tapping). Same
// 30s outer auto-clear still applies.
const KNOX_ESCALATE_MS = 10_000;
// Acknowledgement: how long the waving "盖章通过" plays after user click.
const KNOX_ACK_MS = 1500;
// Pre fires when CC decides to run a tool. If Post doesn't follow within this
// window, CC is most likely sitting on a terminal 1/2/3 permission prompt.
// (In v2.1.143 those prompts don't fire Notification, so we infer indirectly.)
const PRE_TO_POST_HEURISTIC_MS = 1500;
let knoxClearTimer = null;
let knoxEscalateTimer = null;
let knoxAckTimer = null;
let pendingPreTimer = null;

function showKnoxAlert(text = '需要你确认！', durationMs = KNOX_ALERT_TIMEOUT_MS) {
  if (!pets.knox) return;
  setState('knox', 'alert', text);
  clearTimeout(knoxClearTimer);
  clearTimeout(knoxEscalateTimer);
  knoxEscalateTimer = setTimeout(() => {
    knoxEscalateTimer = null;
    if (pets.knox && pets.knox.dataset.state === 'alert') {
      setState('knox', 'jumping', '快来确认！');
    }
  }, KNOX_ESCALATE_MS);
  knoxClearTimer = setTimeout(hideKnoxAlert, durationMs);
}

function hideKnoxAlert() {
  if (!pets.knox) return;
  clearTimeout(knoxClearTimer);
  clearTimeout(knoxEscalateTimer);
  knoxClearTimer = null;
  knoxEscalateTimer = null;
  const cur = pets.knox.dataset.state;
  if (cur === 'alert' || cur === 'jumping') setState('knox', 'idle');
}

// User clicked Knox while it was alerting (or escalated to jumping). Stamp
// "approved": play waving for KNOX_ACK_MS, then back to idle. Cancels all
// alert/escalate/heuristic timers so nothing fires on top of the waving.
function knoxAcknowledge() {
  if (!pets.knox) return;
  clearTimeout(knoxClearTimer);
  clearTimeout(knoxEscalateTimer);
  clearTimeout(knoxAckTimer);
  cancelPermissionHeuristic();
  knoxClearTimer = null;
  knoxEscalateTimer = null;
  setState('knox', 'waving');
  knoxAckTimer = setTimeout(() => {
    knoxAckTimer = null;
    if (pets.knox && pets.knox.dataset.state === 'waving') setState('knox', 'idle');
  }, KNOX_ACK_MS);
}

function armPermissionHeuristic() {
  clearTimeout(pendingPreTimer);
  pendingPreTimer = setTimeout(() => {
    pendingPreTimer = null;
    showKnoxAlert('可能在等你确认？', KNOX_HEURISTIC_TIMEOUT_MS);
  }, PRE_TO_POST_HEURISTIC_MS);
}

function cancelPermissionHeuristic() {
  clearTimeout(pendingPreTimer);
  pendingPreTimer = null;
}

function setState(petId, state, bubbleText) {
  const el = pets[petId];
  if (!el) return;
  el.dataset.state = state;
  if (bubbleText) showBubble(petId, bubbleText);
}

function showBubble(petId, text, ms = 4000) {
  const el = pets[petId];
  if (!el) return;
  const bubble = el.querySelector('.bubble');
  bubble.textContent = text;
  el.classList.add('show-bubble');
  clearTimeout(el._bubbleTimer);
  el._bubbleTimer = setTimeout(() => {
    el.classList.remove('show-bubble');
  }, ms);
}

function initStates() {
  setState('scout', 'idle');
  setState('knox', 'idle');
  setState('bubbles', 'sleep');
  setState('pip', 'idle');
}

// Scout has its own sprite sheet, so its dataset.state must mirror sessionState
// 1:1 (idle/thinking/running/waiting/completed/stale/failed). The PRD 4.1 table
// is materialised on Scout directly; Knox/Pip still react via their own paths.
const SCOUT_BUBBLES = {
  thinking: '在听……',
  running: '执行中',
  waiting: '需要你确认',
  completed: '完成啦！',
  stale: '太久没动静…',
  failed: '出错了',
};

// Status bubble shown when user clicks Knox (in any state other than alert /
// jumping, which already have their own "去终端确认 →" action prompt).
const KNOX_BUBBLES = {
  idle: '待命中',
  waving: '已通过',
  failed: '出错了',
  sleep: '睡着了',
  review: '翻翻记录',
  'running-right': '拖我去哪？',
  'running-left': '拖我去哪？',
};

// scoutDragDir: null when not dragging; 'running-right' | 'running-left' while
// the Scout window is being dragged. Drag visuals override sessionState until
// drag ends, then we re-apply via applyScoutForSession().
let scoutDragDir = null;

function applyScoutForSession() {
  if (scoutDragDir || scoutAfk) return; // drag + AFK both win over session state
  setState('scout', sessionState, SCOUT_BUBBLES[sessionState]);
}

function applySessionState(state) {
  sessionState = state;
  statusEl.textContent = `session: ${state}`;
  applyScoutForSession();
  // Pip + Knox side-effects driven by sessionState.
  switch (state) {
    case 'idle':
    case 'running':
      setState('pip', 'idle');
      // Knox snaps out of failed when the session resumes normally.
      if (pets.knox && pets.knox.dataset.state === 'failed') setState('knox', 'idle');
      break;
    case 'failed':
      setState('pip', 'idle');
      // Knox marks the incident. Cancel any pending alert/escalate timers so
      // failed isn't overwritten by a stale showKnoxAlert auto-clear.
      if (pets.knox) {
        clearTimeout(knoxClearTimer);
        clearTimeout(knoxEscalateTimer);
        knoxClearTimer = null;
        knoxEscalateTimer = null;
        setState('knox', 'failed', '出错了');
      }
      break;
    case 'completed':
      triggerCelebrate();
      break;
  }
}

function triggerCelebrate() {
  if (!pets.pip) return;
  setState('pip', 'celebrate', '完成啦！');
  // Fire 3–8 random confetti bursts during the celebrate window. Each burst
  // is the same one pet click triggers; 400ms spacing fits the max 8 bursts
  // inside the 3.5s celebrate (last launch ~2.8s, fade ends ~4.1s — the last
  // confetti drifts past Pip's return to idle, which looks natural).
  const bursts = 3 + Math.floor(Math.random() * 6);
  for (let i = 0; i < bursts; i++) {
    setTimeout(() => {
      if (pets.pip) spawnConfetti(pets.pip);
    }, i * 400);
  }
  setTimeout(() => {
    if (pets.pip && pets.pip.dataset.state === 'celebrate') setState('pip', 'idle');
  }, 3500);
}

function spawnConfetti(host) {
  const colors = ['#ff5e5e', '#ffd25e', '#5effa1', '#5ec8ff', '#c97aff'];
  for (let i = 0; i < 16; i++) {
    const c = document.createElement('span');
    c.className = 'confetti';
    c.style.background = colors[i % colors.length];
    const dx = (Math.random() - 0.5) * 160 + 'px';
    const dy = (Math.random() * -60 - 40) + 'px';
    c.style.setProperty('--dx', dx);
    c.style.setProperty('--dy', dy);
    host.appendChild(c);
    setTimeout(() => c.remove(), 1300);
  }
}

function triggerWater() {
  lastWaterAt = Date.now();
  if (!pets.bubbles) return;
  setState('bubbles', 'idle', '醒都醒了，喝口水吧。');
  setTimeout(() => setState('bubbles', 'sleep'), 8000);
}

// Map raw Claude Code hook events to session state.
function handleEvent(evt) {
  const t = evt.type;
  switch (t) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      applySessionState('running');
      break;
    case 'PreToolUse':
      applySessionState('running');
      armPermissionHeuristic();
      break;
    case 'PostToolUse':
      applySessionState('running');
      cancelPermissionHeuristic();
      hideKnoxAlert();
      break;
    case 'Notification':
      applySessionState('waiting');
      cancelPermissionHeuristic();
      showKnoxAlert();
      break;
    case 'Stop':
    case 'SubagentStop':
      applySessionState('completed');
      cancelPermissionHeuristic();
      hideKnoxAlert();
      // settle back to idle after a beat
      setTimeout(() => {
        if (sessionState === 'completed') applySessionState('idle');
      }, 6000);
      break;
    case 'SessionEnd':
      applySessionState('idle');
      cancelPermissionHeuristic();
      hideKnoxAlert();
      break;
    case 'Water':
      triggerWater();
      break;
    default:
      // Unknown hook — log to status line for debugging.
      statusEl.textContent = `event: ${t}`;
  }
}

// AFK = no CC hook events AND no pet clicks for AFK_THRESHOLD_MS.
// Scout drifts to thinking (still watching), Knox/Bubbles/Pip fall asleep.
// Attention-getting transient states (alert, celebrate) are never overridden,
// so a confirm or completion that fires while AFK still gets its visual.
const AFK_OTHER_PETS = ['knox', 'bubbles', 'pip'];
// Attention-getting / important states that AFK must never paper over with sleep.
const AFK_SKIP_STATES = new Set(['alert', 'jumping', 'celebrate', 'failed']);

let scoutAfk = false;

function applyAfk(afk) {
  // Scout: AFK overrides sessionState, but drag still wins.
  if (pets.scout && !scoutDragDir) {
    if (afk && !scoutAfk) {
      scoutAfk = true;
      setState('scout', 'thinking');
    } else if (!afk && scoutAfk) {
      scoutAfk = false;
      applyScoutForSession();
    }
  }
  // Knox / Bubbles / Pip.
  for (const id of AFK_OTHER_PETS) {
    const el = pets[id];
    if (!el) continue;
    const cur = el.dataset.state;
    if (afk) {
      if (cur === 'sleep' || AFK_SKIP_STATES.has(cur)) continue;
      setState(id, 'sleep');
    } else {
      // Wake to idle. Bubbles defaults back to sleep on its next own-timer pass.
      if (cur === 'sleep' && id !== 'bubbles') setState(id, 'idle');
    }
  }
}

function handleTick({ idleMs, afk }) {
  // Stale detection only meaningful when we're actively running.
  if ((sessionState === 'running' || sessionState === 'thinking') && idleMs > DEFAULTS.staleAfterMs) {
    applySessionState('stale');
  }
  // Bubbles water timer
  if (Date.now() - lastWaterAt > DEFAULTS.waterIntervalMs) {
    triggerWater();
  }
  applyAfk(!!afk);
}

// Drag-or-click. Moving > DRAG_THRESHOLD turns the gesture into a window drag
// (via IPC → BrowserWindow.setPosition with main-process snap); otherwise it's
// a click. The mousedown listener is on document so dragging works from
// anywhere in the window (the pet itself and the transparent margin around it).
const DRAG_THRESHOLD = 4;
// Drag is only initiated from the central 80% of the visible pet (.pet element).
// Sprite edges + transparent window margin are click-only, so brushing the
// pet's outline doesn't accidentally grab the window.
const DRAG_AREA_SCALE = 0.8;
let activeDrag = null;

function onDocMouseDown(e) {
  if (e.button !== 0) return;
  const petEl = document.querySelector('.pet');
  if (petEl) {
    const r = petEl.getBoundingClientRect();
    const halfW = (r.width * DRAG_AREA_SCALE) / 2;
    const halfH = (r.height * DRAG_AREA_SCALE) / 2;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (Math.abs(e.clientX - cx) > halfW || Math.abs(e.clientY - cy) > halfH) {
      return;
    }
  }
  activeDrag = {
    startX: e.screenX,
    startY: e.screenY,
    lastX: e.screenX,
    lastY: e.screenY,
    moved: false,
  };
}

function onMouseMove(e) {
  if (!activeDrag) return;
  if (!activeDrag.moved) {
    const d = Math.hypot(e.screenX - activeDrag.startX, e.screenY - activeDrag.startY);
    if (d < DRAG_THRESHOLD) return;
    activeDrag.moved = true;
    document.body.classList.add('dragging');
    window.deskpet.dragStart();
  }
  const dx = e.screenX - activeDrag.lastX;
  const dy = e.screenY - activeDrag.lastY;
  if (dx || dy) window.deskpet.moveBy(dx, dy);
  activeDrag.lastX = e.screenX;
  activeDrag.lastY = e.screenY;
}

function onMouseUp() {
  if (!activeDrag) return;
  const wasDrag = activeDrag.moved;
  activeDrag = null;
  if (wasDrag) {
    document.body.classList.remove('dragging');
    window.deskpet.dragEnd();
    // Swallow the click that follows the drag so we don't trigger pet actions.
    document.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
    }, { capture: true, once: true });
  }
}

document.addEventListener('mousedown', onDocMouseDown);
window.addEventListener('mousemove', onMouseMove);
window.addEventListener('mouseup', onMouseUp);

for (const [id, el] of Object.entries(pets)) {
  if (!el) continue;
  el.addEventListener('click', () => {
    // Wake the squad from AFK regardless of which pet was clicked.
    window.deskpet.petClick();
    el.classList.remove('show-bubble');
    if (id === 'knox') {
      const ks = el.dataset.state;
      if (ks === 'alert' || ks === 'jumping') {
        // TODO: focus the terminal window. macOS AppleScript hook would go here.
        showBubble('knox', '去终端确认 →');
        knoxAcknowledge();
      } else {
        showBubble('knox', KNOX_BUBBLES[ks] || ks);
      }
    }
    if (id === 'bubbles') {
      triggerWater();
    }
    if (id === 'pip') {
      spawnConfetti(pets.pip);
    }
    if (id === 'scout') {
      showBubble('scout', `状态：${sessionState}`);
    }
  });
}

initStates();

window.deskpet.onEvent(handleEvent);
window.deskpet.onTick(handleTick);
// Global zoom is handled in main via webContents.setZoomFactor — no renderer
// participation needed. (Previously used CSS `zoom` here but it produced
// white background bleed on Knox/Bubbles at <1x scale on macOS.)
window.deskpet.getPort().then((port) => {
  statusEl.textContent = `idle · listening on :${port}`;
});

// Knox's passive "翻记录" — every ~35s while Knox is in idle, flip to review
// for 6s then back. Currently paused per user request; flip the flag to revive.
const KNOX_REVIEW_ENABLED = false;
if (KNOX_REVIEW_ENABLED && PET_ID === 'knox') {
  setInterval(() => {
    if (pets.knox?.dataset.state !== 'idle') return;
    setState('knox', 'review');
    setTimeout(() => {
      if (pets.knox?.dataset.state === 'review') setState('knox', 'idle');
    }, 6000);
  }, 35_000);
}

// Drag-direction sprite for Knox (running-right / running-left rows). Same
// pattern as Scout, but Knox restores to whatever state it was in pre-drag
// (alert/jumping/sleep/idle) rather than driving from sessionState.
let knoxDragDir = null;
let knoxPreDragState = null;
if (PET_ID === 'knox') {
  window.deskpet.onDrag(({ dx }) => {
    if (!pets.knox || dx === 0) return;
    const next = dx > 0 ? 'running-right' : 'running-left';
    if (next === knoxDragDir) return;
    if (knoxDragDir === null) knoxPreDragState = pets.knox.dataset.state;
    knoxDragDir = next;
    setState('knox', next);
  });
  window.deskpet.onDragEnd(() => {
    if (knoxDragDir === null) return;
    knoxDragDir = null;
    if (pets.knox) setState('knox', knoxPreDragState || 'idle');
    knoxPreDragState = null;
  });
}

// Drag-direction sprite for Bubbles. Restores to pre-drag state (sleep / idle)
// rather than forcing to sleep — so dragging a Bubbles mid-water-reminder
// returns to the reminder pose.
let bubblesDragDir = null;
let bubblesPreDragState = null;
if (PET_ID === 'bubbles') {
  window.deskpet.onDrag(({ dx }) => {
    if (!pets.bubbles || dx === 0) return;
    const next = dx > 0 ? 'running-right' : 'running-left';
    if (next === bubblesDragDir) return;
    if (bubblesDragDir === null) bubblesPreDragState = pets.bubbles.dataset.state;
    bubblesDragDir = next;
    setState('bubbles', next);
  });
  window.deskpet.onDragEnd(() => {
    if (bubblesDragDir === null) return;
    bubblesDragDir = null;
    if (pets.bubbles) setState('bubbles', bubblesPreDragState || 'sleep');
    bubblesPreDragState = null;
  });
}

// Drag-direction sprite for Pip. Restores to pre-drag state (idle / celebrate /
// sleep) so a celebrate dragged mid-confetti returns to the celebration pose.
let pipDragDir = null;
let pipPreDragState = null;
if (PET_ID === 'pip') {
  window.deskpet.onDrag(({ dx }) => {
    if (!pets.pip || dx === 0) return;
    const next = dx > 0 ? 'running-right' : 'running-left';
    if (next === pipDragDir) return;
    if (pipDragDir === null) pipPreDragState = pets.pip.dataset.state;
    pipDragDir = next;
    setState('pip', next);
  });
  window.deskpet.onDragEnd(() => {
    if (pipDragDir === null) return;
    pipDragDir = null;
    if (pets.pip) setState('pip', pipPreDragState || 'idle');
    pipPreDragState = null;
  });
}

// Drag-direction sprite for Scout (running-right / running-left rows of the
// spritesheet). Main process emits cc-drag on every move delta; we coalesce so
// we only swap sprite when direction actually flips. cc-drag-end restores the
// session-state visual.
if (PET_ID === 'scout') {
  window.deskpet.onDrag(({ dx }) => {
    if (!pets.scout || dx === 0) return;
    const next = dx > 0 ? 'running-right' : 'running-left';
    if (next === scoutDragDir) return;
    scoutDragDir = next;
    setState('scout', next);
  });
  window.deskpet.onDragEnd(() => {
    if (!scoutDragDir) return;
    scoutDragDir = null;
    applyScoutForSession();
  });

  // Double-click Scout → rally: all 4 pets snap back to the initial formation.
  // Bound on .pet so dblclick in the transparent window margin is ignored.
  pets.scout?.addEventListener('dblclick', (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.deskpet.rally();
    showBubble('scout', '集合！');
  });
}
