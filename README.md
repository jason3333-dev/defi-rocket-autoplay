# Defi Rocket Autoplay

A Windows-friendly helper for the `https://app.defi.app/rocket` trial game.

The Rocket game is now a directional bet ("Rocket Perps"): you pick `Up` or `Down`, a position opens, and you `CLOSE` to settle. The helper watches the page, gives you manual hotkeys for opening (`Z`/`X`) and closing (`C`/`Space`) a round, and auto-taps the coins/asteroids that float through the play area for bonus XP/score while a round is active. Tapping objects is a separate XP/score mechanic and does not affect the position's profit and loss. The bot never closes the position for you — closing is always manual.

Use the in-game **Demo** mode (top-left `Live` / `Demo` toggle) for testing — it uses a play-money balance, no real funds.

This project is intended for trial/test flows you are allowed to automate. It does not read wallet keys, API keys, secrets, or browser storage files directly.

## Requirements

- Windows 10/11
- Node.js 18 or newer
- Chrome or Edge installed
- A normal browser session where you can manually log in if the site requires it

## Install

```powershell
cd C:\TOYS\defi-rocket-autoplay
npm install
npm run check
```

## Quick Start

Double-click:

```text
run-autoplay-200.cmd
```

Or run from PowerShell:

```powershell
npm run autoplay -- --max 200 --fast-dom --interval 12 --burst 40 --click-delay 0 --recent-ms 80
```

The browser opens with a dedicated local profile. Log in manually if needed, move to the Rocket screen, then use the hotkeys below.

## Controls

| Key | Action |
| --- | --- |
| `Z` | Open `Up` (long) |
| `X` | Open `Down` (short) |
| `C` | Close the current position |
| `Space` | Close the current position |

`Z` / `X` work whenever the `Up` / `Down` buttons are showing (before a round). `C` / `Space` work while a round is active and the `CLOSE` button is showing.

## Overlay

The in-page overlay shows:

- `Clicks`: total coins/asteroids tapped in the current play
- `Plays`: active-round count
- `Elapsed`: seconds since the current play started
- `Side`: `UP`, `DOWN`, or `-`
- `Status`: current bot state, such as `Active`, `Ready Z/X`, or `Modal Z/X ready`

When you close a round, clicks, elapsed time, status, and side reset. The play count stays.

## Default Behavior

- Manual mode is the default.
- You choose the direction: the bot does not press `Up` / `Down` unless you use `Z` / `X`.
- The bot does not close the browser automatically.
- While a round is active, the bot auto-taps coins/asteroids. They are detected by their element class (`coinTap...`), not by text, since the new coins have no label. Override with `--coin-class <substring>`; disable tapping with `--coin-class ""`.
- Only the central play area is tapped, so nav, the `CLOSE` button, the amount controls, and the side panels are never clicked.
- Manual mode keeps counting and tapping beyond `--max` unless `--manual-limit` is used.
- The bot never closes the position automatically. Press `C` or `Space` to close.

## Useful Commands

Default fast mode (what `run-autoplay-200.cmd` runs). Coins drift across the screen, so `--fast-dom` clicks the element in-page instead of by coordinate and lands more taps when several coins appear at once:

```powershell
npm run autoplay -- --max 200 --fast-dom --interval 12 --burst 40 --click-delay 0 --recent-ms 80
```

Slower, coordinate-click mode (if fast mode ever misbehaves):

```powershell
npm run autoplay -- --max 200 --interval 25 --burst 12 --click-delay 0 --recent-ms 150
```

Stop manual mode at `--max`:

```powershell
npm run autoplay -- --max 200 --manual-limit
```

Dry run without actual clicks:

```powershell
npm run autoplay -- --max 200 --dry-run
```

Point the bot at a different coin element class if the site renames it:

```powershell
npm run autoplay -- --max 200 --coin-class cointap
```

## Optional Image Fallback

The default mode finds coins by their DOM element class and usually does not need image calibration.

If the site stops exposing coin elements in the DOM (for example, if it moves to a `<canvas>`), prepare image templates:

```powershell
run-prepare.cmd
npm run calibrate
```

Template folders:

- Coins/rocks: `templates\rocks`
- Avoid/hazards: `templates\avoid`

Then run:

```powershell
npm run autoplay -- --max 200 --image-fallback
```

Image matching is less reliable for rotating, scaling, or shape-changing objects. Prefer the default DOM mode when available.

## Inspect Tools

Capture the current game page:

```powershell
npm run inspect
```

Double-click alternatives:

```text
run-inspect.cmd
run-inspect-edge.cmd
run-calibrate.cmd
```

## Local Files

These folders are intentionally ignored by Git:

- `node_modules`
- `browser-profile*`
- `captures`
- `resources`
- `templates`
- `.env*`
- `*.key`, `*.pem`, `*.session`
- `local_config*`

Do not publish browser profiles, screenshots, templates, session files, API keys, or local config files.

## Troubleshooting

If hotkeys do not work:

- Click once inside the game page, then press the key again.
- Restart `run-autoplay-200.cmd` after code updates.
- Refresh the game tab if an older injected hotkey script is still active.

If objects are missed:

- Try lowering `--interval`.
- Try raising `--burst`.
- Keep `--click-delay 0`.
- Use `--fast-dom` only as an experiment.

If close does not work:

- Try both `C` and `Space`.
- Make sure the large `CLOSE` button is visible.
- Restart the bot if the page was open before the latest hotkey changes.

If the browser profile behaves strangely:

- Stop the bot.
- Close the browser it opened.
- Start `run-autoplay-200.cmd` again.

## Safety Notes

- Use only on trial/test game flows where automation is allowed.
- The script does not bypass captchas, wallet prompts, rate limits, or access controls.
- Review the code before running it with any account that has real funds.
- Keep sensitive local files out of Git. The `.gitignore` is set up for that, but you are still responsible for what you add.
