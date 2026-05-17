# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install electron
npm start                # launch the Electron desktop pet app
npm run install-hooks    # inject deskpet hooks into ~/.claude/settings.json (auto-backup)
npm run uninstall-hooks  # remove deskpet hooks, leaving other hooks intact
```

There is no test suite, linter, or build step. `npm start` runs `electron .` directly against the source files.

Manual smoke tests:
- Send a synthetic event: `curl -X POST -H 'X-Hook: Stop' http://127.0.0.1:8765/event` (Notification / PreToolUse / Stop / SubagentStop / SessionEnd are the interesting ones).
- Verify hooks are installed: `grep deskpet-hook ~/.claude/settings.json`.
- The tray menu only exposes Show/Hide, scale (minisize/bigsize), Quit — there is no Simulate submenu; use curl for state transitions.

## Architecture

The whole app is a one-way pipeline from Claude Code into four on-screen meerkats. There is no persistent store and no outbound network beyond the localhost hook receiver.

```
Claude Code  ──hooks──>  curl POST 127.0.0.1:8765/event  (X-Hook: <event>)
                                    │
                              main.js (HTTP + Electron main)
                                    │  IPC: cc-event / cc-tick (broadcast to all 4)
                                    ▼
                       4 BrowserWindows, one per pet (?pet=<id>)
                                    │
                                    ▼
                              renderer/app.js (state machine)
                                    │
                                    ▼
                              Scout / Knox / Bubbles / Pip
```

**Boundaries that matter:**

1. **Hook installer ↔ user's `~/.claude/settings.json`** (`hooks/install-hooks.js`)
   - Every injected command is tagged with the literal `deskpet-hook` marker so uninstall can prune deskpet entries without disturbing other hooks the user has installed.
   - Always backs up to `~/.claude/settings.json.deskpet-backup` before the first write.
   - On install: prunes any existing deskpet entries first, then re-adds — safe to run repeatedly.
   - Hook commands `curl ... || true` and time out at 1s so a missing pet app never blocks a Claude Code session.

2. **HTTP receiver ↔ four renderers** (`main.js` → `preload.js` → `renderer/app.js`)
   - `main.js` listens on `127.0.0.1:8765` only. Event type comes from the `X-Hook` header (set by the install script), falling back to `payload.hook` / `payload.type`.
   - Each pet is its own transparent, frameless, always-on-top `BrowserWindow`, loaded with `?pet=<id>&scale=<n>`. The same `app.js` runs in all four processes; on boot each renderer deletes the DOM nodes for the other three pets, so `setState('knox', …)` is a silent no-op in Scout's window. `broadcast()` in main.js sends every `cc-event` / `cc-tick` to all four — the renderers self-filter.
   - `preload.js` is the only IPC bridge; renderers have `contextIsolation: true` and no node integration.
   - A 5s `cc-tick` from main carries `{idleMs, afk}`. The renderer owns all timing (stale / water / Knox timers); main only tracks `lastEventAt` (CC hooks only) and `lastWakeAt` (CC hooks + pet clicks) to compute the AFK flag.

3. **Raw Claude Code events ↔ session state** (`renderer/app.js`)
   - The renderer maps ~8 raw hook event types onto a small state enum: `idle | thinking | running | waiting | completed | failed | stale`.
   - Each meerkat reacts to that state, **not** to raw events. New behavior → first decide whether it's a new session state or a new reaction to an existing one.
   - **Permission heuristic** (`PRE_TO_POST_HEURISTIC_MS`): Claude Code's terminal permission prompts don't fire `Notification` in v2.1.143. If `PostToolUse` doesn't follow `PreToolUse` within 1.5s, the renderer infers a pending prompt and shows a Knox alert. Any later `PostToolUse` / `Stop` / `SessionEnd` cancels the heuristic.

## Four-meerkat invariant

The product premise is that **four characters separate four cognitive concerns** — do not collapse them or add a fifth without consulting `PRD_v2.md`:

| Meerkat | Concern               | Driven by                                              |
| ------- | --------------------- | ------------------------------------------------------ |
| Scout   | session state monitor | all Claude Code hook events; dataset.state mirrors sessionState 1:1 |
| Knox    | confirmation guard    | `Notification` hook + Pre→Post permission heuristic    |
| Bubbles | health/break timer    | local timer (`waterIntervalMs`, default 45 min)        |
| Pip     | completion celebrant  | `Stop` / `SubagentStop` hooks (30s cooldown)           |

Knox is decoupled from `sessionState` — it has its own mini state machine: `alert` (waving placard) → escalates to `jumping` after `KNOX_ESCALATE_MS` (10s) → click ack flips to `waving` for `KNOX_ACK_MS` (1.5s) → `idle`. `failed` is set on session failure and cleared when the session resumes. Auto-clears at `KNOX_ALERT_TIMEOUT_MS` (30s).

Defaults live in `renderer/app.js` (`DEFAULTS` and the `KNOX_*` constants): `staleAfterMs`, `waterIntervalMs`, `celebrateCooldownMs`, the Knox timeouts, and `PRE_TO_POST_HEURISTIC_MS`. There is no settings UI — they are constants.

## Visual layer

Each pet ships its own `spritesheet.webp` + `pet.json` under its own directory (`scout/`, `knox/`, `Bubbles-2/`, `Pip-2/`). The renderer is emoji-by-default in `renderer/index.html`, and `renderer/style.css` overrides with high-specificity rules keyed off `body[data-pet="<id>"] .pet[data-state="<state>"]` that paint the spritesheet via `background-image` + `steps()` keyframes. When `app.js` sets `el.dataset.state = 'running-left'`, CSS picks the matching sprite row — `app.js` only touches `dataset.state` and bubble text.

**Drag / snap / rally** (`main.js` + drag handlers in `app.js`):
- Window drag is JS-driven (not `-webkit-app-region`) so main can apply per-axis snap to workArea edges and to other pets' edges (`SNAP_THRESHOLD = 12`px).
- Main emits `cc-drag {dx}` on every move; sprite-aware pets switch to `running-right` / `running-left` and restore on `cc-drag-end`.
- Scout dblclick → `rally` IPC → all four pets snap back to the initial bottom-right formation, recomputed from current display geometry.

**macOS transparent-window scaling constraint** (`main.js:160-188`): the tray scale (minisize 0.5 / bigsize 1.0) is applied as `transform: scale()` on `#stage` plus a window-size change in main. Do **not** switch to `webContents.setZoomFactor` — it leaves a white backing-layer artifact on transparent macOS windows. The `--scale-mul` CSS var and the per-window resize are the supported path.

## AGENTS.md

`AGENTS.md` is a Codex-targeted clone of this file (s/Claude/Codex/g). When you change architecture-relevant sections here, mirror the change there.
