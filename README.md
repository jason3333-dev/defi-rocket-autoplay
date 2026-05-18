# Defi Rocket Autoplay

`https://app.defi.app/rocket` trial/test play helper.

This tool does not read wallet keys, API keys, secrets, or browser storage files directly. It opens a dedicated Chrome profile and clicks only image templates that you calibrate yourself.

## Setup

```powershell
cd C:\TOYS\defi-rocket-autoplay
npm install
```

## 1. Inspect and capture

```powershell
npm run inspect
```

Chrome opens with a dedicated profile in `browser-profile`. Log in manually if needed, start the trial game, and return to the terminal. The script saves a screenshot under `captures`.

Double-click alternative: `run-inspect.cmd`

The double-click launcher adds a small **Capture for bot** button inside the opened browser page. Move to the game screen and click that page button; no terminal input is needed.

Useful options:

```powershell
npm run inspect -- --click-to-capture
npm run inspect -- --manual
npm run inspect -- --wait 30000
npm run inspect -- --url https://app.defi.app/rocket
```

One-click prep:

```powershell
run-prepare.cmd
```

This opens the game capture flow first. After you click **Capture for bot**, the same browser tab moves to a resource picker. Choose **Rock** for stone images and **Avoid** for skull images. Use the manual crop fallback only if the object is missing from the resource list.

## 2. Calibrate rock and skull templates

```powershell
npm run calibrate
```

Open the printed local URL. The default screen lets you choose from extracted image resources. Click **Rock** for stone images and **Avoid** for skull images. Add 2-3 examples if the game uses different sizes or angles.

Double-click alternative: `run-calibrate.cmd`

The calibration page now opens automatically in your browser.

Templates are saved here:

- Rocks: `templates\rocks`
- Avoid/skulls: `templates\avoid`

## 3. Autoplay

```powershell
npm run autoplay -- --max 200
```

The script opens the same dedicated Chrome profile and runs in manual-watch mode by default. You manually press **UP** or **DOWN** to start, manually press **CLOSE** to end, and the bot only clicks safe `Tap ...` targets until it reaches `--max`.

An overlay is shown in the browser with `0/200` style click counting, elapsed seconds, and a play counter. A new play is counted when a new active round is detected. When you press **CLOSE**, the overlay resets clicks/time/status while keeping the play count. The browser is not closed automatically.

Profit close rule: after 30 seconds have elapsed, if the current in-round profit reaches `+100%` or more, the bot clicks the large **CLOSE** button automatically.

Current default click mode is DOM-only: the game exposes clickable objects as labels like `Tap ...`. The bot clicks every safe `Tap ...` target and excludes bad labels like `Tap bomb`, `Tap skull`, `Tap avoid`, and `Tap hazard`. This keeps unique shapes from being skipped when the object rotates, scales, or changes shape.

Double-click alternative: `run-autoplay-200.cmd`

Useful options:

```powershell
npm run autoplay -- --max 200 --threshold 0.86 --interval 120
npm run autoplay -- --max 200 --dry-run
npm run autoplay -- --max 200 --interval 25 --burst 12 --click-delay 0 --recent-ms 150
npm run autoplay -- --max 200 --auto-close-after 30 --auto-close-profit 100
npm run autoplay -- --repeat --max 200 --target-text "tap coin" --avoid-text "tap bomb"
npm run autoplay -- --repeat --max 200 --interval 40 --burst 6 --click-delay 10
npm run autoplay -- --repeat --max 200 --image-fallback
```

Use `--image-fallback` only if the site stops exposing `Tap ...` labels. Image matching is less reliable for rotating or resizing objects.

If objects pass by too quickly, lower `--interval`, raise `--burst`, or lower `--click-delay`.

In manual-watch mode, leave the bot running and start/end each play yourself with **UP/DOWN** and **CLOSE**. The bot resets the click counter to `0/200` and starts elapsed seconds whenever a new active round appears.

Automatic mode is still available if needed:

```powershell
npm run autoplay -- --auto --auto-start --close-on-max --rounds 5 --max 200
```

Between rounds, the script tries to click visible controls whose text includes `Play again`, `Retry`, `Restart`, `Start`, `Continue`, `Next`, `OK`, or `Close`.

If the restart button is graphical or not detected, pass its screen coordinate:

```powershell
npm run autoplay -- --rounds 5 --max 200 --restart-x 640 --restart-y 760
```

You can also add custom button text:

```powershell
npm run autoplay -- --rounds 5 --restart-text "Play Now"
```

Double-click continuous mode: `run-autoplay-repeat.cmd`

If it clicks too loosely, raise `--threshold` to `0.90`. If it misses rocks, lower it to `0.82` or add more templates.

## Safety Notes

- Use only on trial/test flows you are allowed to automate.
- The script does not bypass captchas, wallet prompts, rate limits, or access controls.
- Keep `templates`, `captures`, and `browser-profile` local. Do not publish them.
