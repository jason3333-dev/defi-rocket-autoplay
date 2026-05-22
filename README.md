# Defi Rocket Autoplay

A Windows-friendly helper for the `https://app.defi.app/rocket` trial game.

It watches the Rocket game page, clicks safe `Tap ...` objects, avoids hazard labels such as `Tap skull` and `Tap bomb`, and gives you manual hotkeys for starting and closing rounds.

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
npm run autoplay -- --max 200 --interval 25 --burst 12 --click-delay 0 --recent-ms 150
```

The browser opens with a dedicated local profile. Log in manually if needed, move to the Rocket screen, then use the hotkeys below.

## Controls

| Key | Action |
| --- | --- |
| `Z` | Start long / UP |
| `X` | Start short / DOWN |
| `C` | Close the current position |
| `Space` | Close the current position |

The hotkeys work on the start screen and on the end modal when `UP` / `DOWN` is visible.

## Overlay

The in-page overlay shows:

- `Clicks`: total safe objects clicked in the current play
- `Plays`: active-round count
- `Elapsed`: seconds since the current play started
- `Side`: `UP`, `DOWN`, or `-`
- `Status`: current bot state, such as `Active`, `Ready Z/X`, or `Modal Z/X ready`

When you close a round, clicks, elapsed time, status, and side reset. The play count stays.

## Default Behavior

- Manual mode is the default.
- The bot does not press `UP` / `DOWN` unless you use `Z` / `X`.
- The bot does not close the browser automatically.
- Safe objects are detected from page labels like `Tap ...`.
- Hazard labels are excluded: `Tap bomb`, `Tap skull`, `Tap avoid`, `Tap hazard`, `skull`, `bomb`.
- Manual mode keeps counting and clicking beyond `--max` unless `--manual-limit` is used.
- After 30 seconds, if the in-round profit reaches `+100%` or more, the bot clicks the large `CLOSE` button automatically.

## Useful Commands

Run the stable manual mode:

```powershell
npm run autoplay -- --max 200 --interval 25 --burst 12 --click-delay 0 --recent-ms 150
```

Stop manual mode at `--max`:

```powershell
npm run autoplay -- --max 200 --manual-limit
```

Change the profit-close rule:

```powershell
npm run autoplay -- --max 200 --auto-close-after 30 --auto-close-profit 100
```

Disable profit auto-close:

```powershell
npm run autoplay -- --max 200 --no-auto-close-profit
```

Dry run without actual clicks:

```powershell
npm run autoplay -- --max 200 --dry-run
```

Experimental fast DOM batch mode:

```powershell
npm run autoplay -- --max 200 --fast-dom --interval 12 --burst 40 --click-delay 0 --recent-ms 80
```

Use `--fast-dom` only if many objects appear at once and the stable mode misses too many. The stable mode keeps coordinate clicks so the click area behaves like the visible game object.

## Optional Image Fallback

The default mode uses DOM labels and usually does not need image calibration.

If the site stops exposing `Tap ...` labels, prepare image templates:

```powershell
run-prepare.cmd
npm run calibrate
```

Template folders:

- Rocks: `templates\rocks`
- Avoid/skulls: `templates\avoid`

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
