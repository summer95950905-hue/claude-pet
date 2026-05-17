#!/usr/bin/env node
// Install / uninstall deskpet hooks into ~/.claude/settings.json.
// Backs up the original to settings.json.deskpet-backup before any write.

const fs = require('fs');
const path = require('path');
const os = require('os');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const BACKUP = SETTINGS + '.deskpet-backup';
const PORT = 8765;
const MARKER = 'deskpet-hook';

const EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Notification',
  'Stop',
  'SubagentStop',
];

function buildCommand(event) {
  // Stdin from Claude Code is the hook payload JSON. We forward it as-is and put
  // the event name in an X-Hook header. Failures are silenced so the hook never
  // blocks a CC session if the desktop pet isn't running.
  return `curl -s -m 1 -X POST -H 'X-Hook: ${event}' -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${PORT}/event >/dev/null 2>&1 || true # ${MARKER}`;
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

function writeSettings(obj) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(obj, null, 2) + '\n');
}

function backup() {
  if (fs.existsSync(SETTINGS) && !fs.existsSync(BACKUP)) {
    fs.copyFileSync(SETTINGS, BACKUP);
    console.log(`[deskpet] backed up settings -> ${BACKUP}`);
  }
}

function pruneDeskpet(settings) {
  if (!settings.hooks) return;
  for (const evt of Object.keys(settings.hooks)) {
    const groups = settings.hooks[evt];
    if (!Array.isArray(groups)) continue;
    const cleaned = groups
      .map((g) => {
        if (!g || !Array.isArray(g.hooks)) return g;
        return { ...g, hooks: g.hooks.filter((h) => !(h.command || '').includes(MARKER)) };
      })
      .filter((g) => g && Array.isArray(g.hooks) && g.hooks.length > 0);
    if (cleaned.length === 0) delete settings.hooks[evt];
    else settings.hooks[evt] = cleaned;
  }
  if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
}

function install() {
  backup();
  const settings = readSettings();
  pruneDeskpet(settings);
  settings.hooks = settings.hooks || {};
  for (const evt of EVENTS) {
    settings.hooks[evt] = settings.hooks[evt] || [];
    settings.hooks[evt].push({
      hooks: [{ type: 'command', command: buildCommand(evt) }],
    });
  }
  writeSettings(settings);
  console.log(`[deskpet] installed hooks for: ${EVENTS.join(', ')}`);
  console.log('[deskpet] start the desktop app with: npm start');
}

function uninstall() {
  if (!fs.existsSync(SETTINGS)) {
    console.log('[deskpet] no settings.json to clean.');
    return;
  }
  const settings = readSettings();
  pruneDeskpet(settings);
  writeSettings(settings);
  console.log('[deskpet] removed deskpet hooks.');
}

const cmd = process.argv.includes('--uninstall') ? 'uninstall' : 'install';
if (cmd === 'install') install();
else uninstall();
