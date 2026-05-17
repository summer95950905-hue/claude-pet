const { app, BrowserWindow, ipcMain, Menu, Tray, nativeImage, screen } = require('electron');
const http = require('http');
const path = require('path');

const HOOK_PORT = 8765;
const PET_ORDER = ['scout', 'knox', 'pip', 'bubbles'];
// AFK = no Claude Code hook events AND no pet clicks for this long →
// Scout drifts to thinking, Knox/Bubbles/Pip fall asleep. Click any pet to
// wake. Threshold checked on every cc-tick (5s).
const AFK_THRESHOLD_MS = 120_000;
// Per-pet window sizes. Each pet's sprite (or emoji) is centered inside; the
// window is just large enough for the rendered sprite + drag-target margin.
// Scout @ 0.75x → 144x156 visible; Knox @ 0.8x → 154x167 visible.
// Emoji placeholders share Scout's size for now.
const PET_SIZE = {
  scout:   [152, 168],
  knox:    [134, 148],
  bubbles: [116, 129],
  pip:     [134, 148],
};
const SNAP_THRESHOLD = 12;
// Gap inserted between adjacent pets in the initial / rally formation.
// Right edge of pet[i] → left edge of pet[i+1] = PET_GAPS[i].
// Indexed by left-pet position in PET_ORDER (scout↔knox, knox↔pip, pip↔bubbles).
// Negative values overlap; less-negative = more space.
const PET_GAPS = [-50, -30, -20];

const petWindows = {};
const dragIntent = new WeakMap(); // win → { x, y } cumulative intended position during a drag
let tray = null;
let lastEventAt = Date.now();
// lastWakeAt: bumped by CC hook events AND pet clicks. Distinct from lastEventAt
// (which only tracks CC events) so pet clicks don't accidentally suppress stale
// detection. AFK is computed from lastWakeAt.
let lastWakeAt = Date.now();

function createPetWindow(id, x, y, sizeOverride) {
  const [width, height] = sizeOverride || PET_SIZE[id];
  const w = new BrowserWindow({
    width,
    height,
    x,
    y,
    show: false,           // stay hidden until positioned; caller calls w.show()
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  w.setAlwaysOnTop(true, 'floating');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: false });
  // Re-affirm transparency. Belt-and-suspenders against macOS occasionally
  // reverting to a white backing layer when a transparent NSWindow is created
  // shortly after another was destroyed at the same screen location.
  w.setBackgroundColor('#00000000');
  w.setHasShadow(false);
  // Pass current scale so renderer can apply --scale-mul from first paint.
  // Cache-bust query so Chromium treats each scale change as a fresh document.
  w.loadFile(path.join(__dirname, 'renderer', 'index.html'), {
    query: { pet: id, scale: String(globalScale), _t: String(Date.now()) },
  });
  petWindows[id] = w;
}

function broadcast(channel, payload) {
  for (const id of PET_ORDER) {
    const w = petWindows[id];
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

function ts() {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}.${d.getMilliseconds().toString().padStart(3, '0')}`;
}

function startHookServer() {
  const server = http.createServer((req, res) => {
    // Log every request — even malformed/dropped ones — so we can see whether
    // CC is actually firing hooks (vs. silent curl failures or kills).
    console.log(`[deskpet ${ts()}] http ${req.method} ${req.url} hook=${req.headers['x-hook'] || '-'}`);
    if (req.method !== 'POST' || req.url !== '/event') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    let aborted = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) req.destroy();
    });
    req.on('aborted', () => {
      aborted = true;
      console.log(`[deskpet ${ts()}] req aborted hook=${req.headers['x-hook'] || '-'} (CC killed the hook process?)`);
    });
    req.on('end', () => {
      if (aborted) return;
      let payload = {};
      try {
        payload = body ? JSON.parse(body) : {};
      } catch {
        payload = { raw: body.slice(0, 200) };
      }
      const type = req.headers['x-hook'] || payload.hook || payload.type || 'Unknown';
      lastEventAt = Date.now();
      lastWakeAt = lastEventAt;
      const subtype = payload && payload.notification_type ? ` [${payload.notification_type}]` : '';
      const msg = payload && payload.message ? ` "${String(payload.message).slice(0, 80)}"` : '';
      console.log(`[deskpet ${ts()}] hook in: ${type}${subtype}${msg}`);
      broadcast('cc-event', { type, payload, at: lastEventAt });
      res.writeHead(204);
      res.end();
    });
  });
  server.on('connection', (sock) => {
    console.log(`[deskpet ${ts()}] tcp connect from ${sock.remoteAddress}:${sock.remotePort}`);
  });
  server.on('error', (err) => {
    console.error('[deskpet] hook server error:', err.message);
  });
  server.listen(HOOK_PORT, '127.0.0.1', () => {
    console.log(`[deskpet ${ts()}] hook server listening on 127.0.0.1:${HOOK_PORT}`);
  });
}

function startStaleTimer() {
  setInterval(() => {
    const idle = Date.now() - lastEventAt;
    const afk = Date.now() - lastWakeAt >= AFK_THRESHOLD_MS;
    broadcast('cc-tick', { idleMs: idle, afk });
  }, 5000);
}

function fakeEvent(type) {
  lastEventAt = Date.now();
  broadcast('cc-event', { type, payload: { simulated: true }, at: lastEventAt });
}

function toggleAll() {
  const anyVisible = PET_ORDER.some((id) => {
    const w = petWindows[id];
    return w && !w.isDestroyed() && w.isVisible();
  });
  for (const id of PET_ORDER) {
    const w = petWindows[id];
    if (!w || w.isDestroyed()) continue;
    if (anyVisible) w.hide();
    else w.show();
  }
}

// Three-step scale: minisize (0.5, default) / middlesize (1.0) / bigsize (1.5).
// PET_SIZE represents middlesize (1:1 reference).
// Scaling is done entirely via CSS `transform: scale()` on #stage in the
// renderer — NOT via Chromium's setZoomFactor. setZoomFactor on transparent
// macOS windows leaves white backing-layer artifacts; CSS transform doesn't
// touch the window's compositor layer so it stays cleanly transparent.
let globalScale = 0.5;

function zoomFor(userScale) {
  return userScale;
}

function setGlobalScale(userScale) {
  globalScale = userScale;
  if (tray) tray.setContextMenu(buildTrayMenu());
  for (const id of PET_ORDER) {
    const w = petWindows[id];
    if (w && !w.isDestroyed()) w.destroy();
    delete petWindows[id];
  }
  setImmediate(() => {
    const positions = computeInitialPositions();
    PET_ORDER.forEach((id, i) => {
      const [baseW, baseH] = PET_SIZE[id];
      const scaled = [Math.round(baseW * userScale), Math.round(baseH * userScale)];
      createPetWindow(id, positions[i][0], positions[i][1], scaled);
      petWindows[id].show(); // scale change is user-initiated; show immediately
    });
  });
}

// Built fresh each call so the radio `checked` flag reflects current globalScale.
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Show / Hide', click: toggleAll },
    { type: 'separator' },
    { label: 'minisize', type: 'radio', checked: globalScale === 0.5, click: () => setGlobalScale(0.5) },
    { label: 'bigsize',  type: 'radio', checked: globalScale === 1.0, click: () => setGlobalScale(1.0) },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() },
  ]);
}

function buildTray() {
  // Load a pre-generated 22×22 transparent PNG so macOS always has a valid
  // image slot for the menu-bar item. setTitle provides the visible '🦝' text.
  const iconPath = path.join(__dirname, 'tray-icon.png');
  const img = nativeImage.createFromPath(iconPath);
  tray = new Tray(img);
  tray.setTitle('🦝');
  tray.setToolTip('deskpet');
  tray.setContextMenu(buildTrayMenu());
  tray.on('click', () => tray.popUpContextMenu());
}

ipcMain.handle('get-port', () => HOOK_PORT);

// Right-click on any pet → pop up the same menu as the tray.
ipcMain.on('show-context-menu', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) buildTrayMenu().popup({ window: w });
});

function idOf(win) {
  for (const id of PET_ORDER) {
    if (petWindows[id] === win) return id;
  }
  return null;
}

// Returns [x, y] adjusted to snap onto the nearest workArea edge or sibling pet
// edge along each axis independently. Snap is per-axis so vertical/horizontal
// alignments are handled the same way.
function computeSnapped(intendedX, intendedY, ownerId) {
  const zoom = zoomFor(globalScale);
  const ownW = Math.round(PET_SIZE[ownerId][0] * zoom);
  const ownH = Math.round(PET_SIZE[ownerId][1] * zoom);
  const probe = { x: intendedX, y: intendedY, width: ownW, height: ownH };
  const { workArea } = screen.getDisplayMatching(probe);
  const xTargets = [
    workArea.x,
    workArea.x + workArea.width - ownW,
  ];
  const yTargets = [
    workArea.y,
    workArea.y + workArea.height - ownH,
  ];
  for (const id of PET_ORDER) {
    if (id === ownerId) continue;
    const w = petWindows[id];
    if (!w || w.isDestroyed() || !w.isVisible()) continue;
    const [ox, oy] = w.getPosition();
    const otherW = Math.round(PET_SIZE[id][0] * zoom);
    const otherH = Math.round(PET_SIZE[id][1] * zoom);
    // Align my left edge to: other's left, other's right, or (other's left - my width).
    xTargets.push(ox, ox + otherW, ox - ownW);
    yTargets.push(oy, oy + otherH, oy - ownH);
  }
  let sx = intendedX;
  let sy = intendedY;
  let bestDx = SNAP_THRESHOLD + 1;
  for (const t of xTargets) {
    const d = Math.abs(intendedX - t);
    if (d <= SNAP_THRESHOLD && d < bestDx) {
      bestDx = d;
      sx = t;
    }
  }
  let bestDy = SNAP_THRESHOLD + 1;
  for (const t of yTargets) {
    const d = Math.abs(intendedY - t);
    if (d <= SNAP_THRESHOLD && d < bestDy) {
      bestDy = d;
      sy = t;
    }
  }
  return [sx, sy];
}

// Rally slide animation. setPosition is instant, so we step the window every
// RALLY_FRAME_MS with an easeOut curve until it lands at the target. One
// animation per window; restarting cancels the previous tick.
// Duration scales with distance (RALLY_PX_PER_SEC ≈ average slide speed), so a
// pet dragged far away takes proportionally longer to slide back — short
// distances still respect RALLY_MIN_MS so the ease is visible.
const RALLY_PX_PER_SEC = 800;
const RALLY_MIN_MS = 150;
const RALLY_MAX_MS = 1200;
const RALLY_FRAME_MS = 16;
const rallyTimers = new WeakMap();

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function cancelRally(win) {
  const t = rallyTimers.get(win);
  if (t) {
    clearTimeout(t);
    rallyTimers.delete(win);
  }
}

function animateWinTo(win, targetX, targetY) {
  if (!win || win.isDestroyed()) return;
  cancelRally(win);
  const [startX, startY] = win.getPosition();
  if (startX === targetX && startY === targetY) return;
  const dist = Math.hypot(targetX - startX, targetY - startY);
  const duration = Math.max(
    RALLY_MIN_MS,
    Math.min(RALLY_MAX_MS, Math.round((dist / RALLY_PX_PER_SEC) * 1000)),
  );
  // Pick the running-sprite direction up front (sign of total dx). easeOut
  // makes per-step dx tiny near the end, which can flicker the sprite back to
  // the resting state — using one sign for the whole slide keeps it stable.
  const slideDir = targetX - startX;
  let prevX = startX;
  const t0 = Date.now();
  const step = () => {
    if (win.isDestroyed()) {
      rallyTimers.delete(win);
      return;
    }
    const k = Math.min(1, (Date.now() - t0) / duration);
    const e = easeOutCubic(k);
    const x = Math.round(startX + (targetX - startX) * e);
    const y = Math.round(startY + (targetY - startY) * e);
    win.setPosition(x, y);
    if (x !== prevX && slideDir !== 0) {
      // Send a fixed-sign dx so the renderer locks to running-right or
      // running-left for the duration of the slide.
      win.webContents.send('cc-drag', { dx: slideDir });
    }
    prevX = x;
    if (k < 1) {
      rallyTimers.set(win, setTimeout(step, RALLY_FRAME_MS));
    } else {
      win.setPosition(targetX, targetY);
      rallyTimers.delete(win);
      win.webContents.send('cc-drag-end');
    }
  };
  step();
}

ipcMain.on('win-drag-start', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  // A user drag overrides any in-flight rally slide for this window.
  cancelRally(w);
  const [x, y] = w.getPosition();
  dragIntent.set(w, { x, y });
});

ipcMain.on('win-drag-end', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  dragIntent.delete(w);
  // Tell the renderer that drag is over; it restores the sprite for sessionState.
  if (!w.isDestroyed()) w.webContents.send('cc-drag-end');
});

ipcMain.on('win-move-delta', (e, dx, dy) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || w.isDestroyed()) return;
  let cur = dragIntent.get(w);
  if (!cur) {
    // No drag-start was received (e.g. drag began mid-session). Seed from current
    // position so the first delta still works; snap will engage from here.
    const [x0, y0] = w.getPosition();
    cur = { x: x0, y: y0 };
    dragIntent.set(w, cur);
  }
  cur.x += dx;
  cur.y += dy;
  const [sx, sy] = computeSnapped(cur.x, cur.y, idOf(w));
  w.setPosition(Math.round(sx), Math.round(sy));
  // Forward horizontal direction so sprite-aware pets (Scout) can switch to
  // running-right / running-left. dy ignored — we only have left/right sprites.
  if (dx !== 0) w.webContents.send('cc-drag', { dx });
});

// Initial formation: bottom-right of the primary display, 4 pets in a row.
// Computed fresh on every call so rally adapts to display geometry changes
// (resolution change, monitor unplug, dock height shift).
function computeInitialPositions() {
  const zoom = zoomFor(globalScale);
  const { workArea } = screen.getPrimaryDisplay();
  const gaps = PET_GAPS.map((g) => Math.round(g * zoom));
  const totalW = PET_ORDER.reduce((s, id) => s + Math.round(PET_SIZE[id][0] * zoom), 0)
               + gaps.reduce((s, g) => s + g, 0);
  let x = workArea.x + workArea.width - totalW - 20;
  return PET_ORDER.map((id, i) => {
    const w = Math.round(PET_SIZE[id][0] * zoom);
    const h = Math.round(PET_SIZE[id][1] * zoom);
    const pos = [x, workArea.y + workArea.height - h - 20];
    x += w + (gaps[i] ?? 0);
    return pos;
  });
}

// Pet click → wake from AFK. Sender doesn't matter; one click wakes the whole
// squad. Bumps lastWakeAt and immediately broadcasts a tick so renderers don't
// have to wait up to 5s for the next tick to flip out of sleep state.
ipcMain.on('pet-click', () => {
  lastWakeAt = Date.now();
  broadcast('cc-tick', { idleMs: Date.now() - lastEventAt, afk: false });
});

// Rally — Scout stays where it is; the other three line up behind it (to the
// right) using PET_GAPS, all bottom-aligned with Scout. Triggered by Scout
// dblclick. (Previously snapped the whole squad back to the bottom-right
// initial formation; users wanted to keep Scout's chosen spot.)
ipcMain.on('rally', () => {
  const scout = petWindows.scout;
  if (!scout || scout.isDestroyed()) return;
  const zoom = zoomFor(globalScale);
  const gaps = PET_GAPS.map((g) => Math.round(g * zoom));
  const [scoutX, scoutY] = scout.getPosition();
  const scoutW = Math.round(PET_SIZE.scout[0] * zoom);
  const scoutH = Math.round(PET_SIZE.scout[1] * zoom);
  const scoutBottom = scoutY + scoutH;
  if (!scout.isVisible()) scout.show();
  let x = scoutX + scoutW + (gaps[0] ?? 0);
  for (let i = 1; i < PET_ORDER.length; i++) {
    const id = PET_ORDER[i];
    const w = petWindows[id];
    if (!w || w.isDestroyed()) continue;
    const wH = Math.round(PET_SIZE[id][1] * zoom);
    if (!w.isVisible()) w.show();
    animateWinTo(w, x, scoutBottom - wH);
    x += Math.round(PET_SIZE[id][0] * zoom) + (gaps[i] ?? 0);
  }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();
  // Create all windows hidden. macOS workArea (dock/menubar) may not be
  // fully settled at app.whenReady(), so we wait 600 ms for display metrics
  // to stabilise, apply the correct positions, then reveal — no visible jump.
  const roughPositions = computeInitialPositions();
  PET_ORDER.forEach((id, i) => {
    createPetWindow(id, roughPositions[i][0], roughPositions[i][1]);
  });
  setTimeout(() => {
    const positions = computeInitialPositions();
    PET_ORDER.forEach((id, i) => {
      const w = petWindows[id];
      if (!w || w.isDestroyed()) return;
      // show() first so macOS state-restoration fires, then override with our
      // computed position — otherwise macOS restores the previous-session coords.
      w.show();
      w.setPosition(positions[i][0], positions[i][1]);
    });
  }, 600);
  startHookServer();
  startStaleTimer();
  buildTray();
});

app.on('window-all-closed', (e) => {
  e.preventDefault();
});
