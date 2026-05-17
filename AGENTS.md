# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install electron
npm start                # launch the Electron desktop pet app
npm run install-hooks    # inject deskpet hooks into ~/.Codex/settings.json (auto-backup)
npm run uninstall-hooks  # remove deskpet hooks, leaving other hooks intact
```

There is no test suite, linter, or build step. `npm start` runs `electron .` directly against the source files.

Manual smoke tests:
- Tray menu → **Simulate: WaitingConfirm / Completed / Running** drives state transitions without needing a live Codex session.
- Send a synthetic event: `curl -X POST -H 'X-Hook: Stop' http://127.0.0.1:8765/event`.
- Verify hooks are installed: `grep deskpet-hook ~/.Codex/settings.json`.

## Architecture

The whole app is a one-way pipeline from Codex into four on-screen meerkats. There is no persistent store and no outbound network beyond the localhost hook receiver.

```
Codex  ──hooks──>  curl POST 127.0.0.1:8765/event  (X-Hook: <event>)
                                    │
                              main.js (HTTP + Electron main)
                                    │  IPC: cc-event / cc-tick
                                    ▼
                              renderer/app.js (state machine)
                                    │
                                    ▼
                              4 meerkats (Scout / Knox / Bubbles / Pip)
```

**Three boundaries that matter:**

1. **Hook installer ↔ user's `~/.Codex/settings.json`** (`hooks/install-hooks.js`)
   - Every injected command is tagged with the literal `deskpet-hook` marker so uninstall can prune deskpet entries without disturbing other hooks the user has installed.
   - Always backs up to `~/.Codex/settings.json.deskpet-backup` before the first write.
   - On install: prunes any existing deskpet entries first, then re-adds — safe to run repeatedly.
   - Hook commands `curl ... || true` and time out at 1s so a missing pet app never blocks a Codex session.

2. **HTTP receiver ↔ renderer** (`main.js` → `preload.js` → `renderer/app.js`)
   - `main.js` listens on `127.0.0.1:8765` only. The event type comes from the `X-Hook` header (set by the install script), falling back to `payload.hook` / `payload.type`.
   - `preload.js` is the only IPC bridge; renderer has `contextIsolation: true` and no node integration.
   - A 5s `cc-tick` runs idle/stale detection in the renderer rather than the main process (state machine owns all timing).

3. **Raw Codex events ↔ session state** (`renderer/app.js`)
   - The renderer maps ~8 raw hook event types onto a small state enum: `idle | thinking | running | waiting | completed | failed | stale`.
   - Each meerkat has a separate role and reacts to that state, **not** to raw events. If you add a new behavior, decide whether it's a new session state or just a new reaction to an existing one.

## Four-meerkat invariant

The product premise is that **four characters separate four cognitive concerns** — do not collapse them or add a fifth without consulting `PRD_v2.md`:

| Meerkat | Concern               | Driven by                                              |
| ------- | --------------------- | ------------------------------------------------------ |
| Scout   | session state monitor | all Codex hook events                            |
| Knox    | confirmation guard    | `Notification` hook (waiting for user input)           |
| Bubbles | health/break timer    | local timer (`waterIntervalMs`, default 45 min)        |
| Pip     | completion celebrant  | `Stop` / `SubagentStop` hooks (with 30s cooldown)      |

The defaults live in `renderer/app.js` (`DEFAULTS` object): `staleAfterMs`, `waterIntervalMs`, `celebrateCooldownMs`. There is no settings UI yet — they are constants.

## Visual layer

Characters are emoji placeholders rendered as DOM elements (`renderer/index.html`), animated via CSS keyframes keyed off `data-state` attributes (`renderer/style.css`). The window itself is transparent, frameless, always-on-top, drag-enabled (with `-webkit-app-region: no-drag` on the pets so they remain clickable). When swapping in real sprites later, keep the `data-state` contract — `app.js` only touches `el.dataset.state` and the bubble text.
