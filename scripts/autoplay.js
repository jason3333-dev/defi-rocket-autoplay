import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { asNumber, ensureDir, openBrowserPage, parseArgs, projectRoot } from './common.js';

const args = parseArgs();
const url = String(args.url ?? 'https://app.defi.app/rocket');
const browserName = String(args.browser ?? process.env.ROCKET_BROWSER ?? 'chrome').toLowerCase();
const maxClicks = asNumber(args.max, 200);
const repeat = Boolean(args.repeat);
const rounds = repeat ? Infinity : Math.max(1, Math.floor(asNumber(args.rounds, 1)));
const threshold = asNumber(args.threshold, 0.86);
const intervalMs = asNumber(args.interval, 35);
const clickDelayMs = asNumber(args['click-delay'], 0);
const clickBurst = Math.max(1, Math.floor(asNumber(args.burst, 10)));
const recentMs = asNumber(args['recent-ms'], 180);
const waitMs = asNumber(args.wait, 8000);
const scanStep = asNumber(args.step, 5);
const manualMode = !Boolean(args['auto']);
const manualUnlimited = !Boolean(args['manual-limit']);
const fastDomClick = Boolean(args['fast-dom']);
const autoStart = Boolean(args['auto-start']);
const startSide = String(args['start-side'] ?? 'up').trim().toLowerCase();
const startRetryMs = asNumber(args['start-retry-ms'], 3000);
const idleRoundMs = asNumber(args['idle-round-ms'], 10000);
const startTimeoutMs = asNumber(args['start-timeout-ms'], 60000);
const restartPollMs = asNumber(args['restart-poll-ms'], 1000);
const restartAttempts = Math.max(1, Math.floor(asNumber(args['restart-attempts'], 20)));
const restartDelayMs = asNumber(args['restart-delay-ms'], 2500);
const closeOnMax = Boolean(args['close-on-max']);
const closeWaitMs = asNumber(args['close-wait-ms'], 1200);
const restartX = Number(args['restart-x']);
const restartY = Number(args['restart-y']);
const hasRestartPoint = Number.isFinite(restartX) && Number.isFinite(restartY);
const dryRun = Boolean(args['dry-run']);
const imageFallback = Boolean(args['image-fallback']);
const targetTextArg = args['target-text'];
const targetTexts = String(targetTextArg ?? '')
  .split(',')
  .map((text) => text.trim().toLowerCase())
  .filter(Boolean);
const avoidTexts = String(args['avoid-text'] ?? 'tap bomb,tap skull,tap avoid,tap hazard,skull,bomb')
  .split(',')
  .map((text) => text.trim().toLowerCase())
  .filter(Boolean);
// The updated Rocket game renders tappable coins/asteroids as <button> wrappers
// around an <img> whose (CSS-module) class contains "coinTap". We match on that
// class substring instead of the old "Tap ..." button text, which no longer exists.
const coinClassNeedles = String(args['coin-class'] ?? 'cointap')
  .split(',')
  .map((text) => text.trim().toLowerCase())
  .filter(Boolean);
const avoidClassNeedles = String(args['avoid-class'] ?? '')
  .split(',')
  .map((text) => text.trim().toLowerCase())
  .filter(Boolean);
const restartTexts = String(args['restart-text'] ?? '')
  .split(',')
  .map((text) => text.trim().toLowerCase())
  .filter(Boolean);

const dedicatedProfileDir = path.join(projectRoot, browserName.includes('edge') ? 'browser-profile-edge' : 'browser-profile-chrome');
const profileDir = path.resolve(String(args['profile-dir'] ?? dedicatedProfileDir));
const profileDirectory = args['profile-directory'] ? String(args['profile-directory']) : 'Default';
const rockDir = path.join(projectRoot, 'templates', 'rocks');
const avoidDir = path.join(projectRoot, 'templates', 'avoid');

ensureDir(profileDir);

function readTemplates(dir, kind) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .map((file) => {
      const fullPath = path.join(dir, file);
      const png = PNG.sync.read(fs.readFileSync(fullPath));
      return {
        kind,
        name: file,
        width: png.width,
        height: png.height,
        data: png.data,
        points: sampleTemplate(png)
      };
    });
}

function sampleTemplate(png) {
  const points = [];
  const cols = Math.min(14, png.width);
  const rows = Math.min(14, png.height);
  for (let gy = 0; gy < rows; gy += 1) {
    for (let gx = 0; gx < cols; gx += 1) {
      const x = Math.floor((gx + 0.5) * png.width / cols);
      const y = Math.floor((gy + 0.5) * png.height / rows);
      const i = (y * png.width + x) << 2;
      const alpha = png.data[i + 3];
      if (alpha < 32) continue;
      points.push({
        x,
        y,
        r: png.data[i],
        g: png.data[i + 1],
        b: png.data[i + 2]
      });
    }
  }
  return points;
}

function scoreAt(screen, template, x, y) {
  let diff = 0;
  let count = 0;
  for (const p of template.points) {
    const sx = x + p.x;
    const sy = y + p.y;
    const i = (sy * screen.width + sx) << 2;
    diff += Math.abs(screen.data[i] - p.r);
    diff += Math.abs(screen.data[i + 1] - p.g);
    diff += Math.abs(screen.data[i + 2] - p.b);
    count += 3;
  }
  if (!count) return 0;
  return 1 - (diff / (count * 255));
}

function overlaps(a, b, radius) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy) <= radius;
}

function findMatches(screen, template, minScore) {
  const matches = [];
  const maxX = screen.width - template.width;
  const maxY = screen.height - template.height;
  const radius = Math.max(template.width, template.height) * 0.7;

  for (let y = 0; y <= maxY; y += scanStep) {
    for (let x = 0; x <= maxX; x += scanStep) {
      const score = scoreAt(screen, template, x, y);
      if (score < minScore) continue;

      const center = {
        x: Math.round(x + template.width / 2),
        y: Math.round(y + template.height / 2),
        score,
        template: template.name,
        width: template.width,
        height: template.height
      };

      const existing = matches.find((m) => overlaps(m, center, radius));
      if (!existing) {
        matches.push(center);
      } else if (center.score > existing.score) {
        Object.assign(existing, center);
      }
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

async function clickRestartControl(page) {
  if (hasRestartPoint) {
    console.log(`Restart: clicking fixed point x=${restartX} y=${restartY}`);
    if (!dryRun) {
      await page.mouse.click(restartX, restartY);
    }
    return true;
  }

  const labels = [
    ...restartTexts,
    'play again',
    'retry',
    'try again',
    'restart',
    'start',
    'continue',
    'next',
    'ok',
    'close'
  ];

  const result = await page.evaluate((texts) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width > 8 &&
        rect.height > 8;
    };

    const controls = [...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')];
    for (const el of controls) {
      if (!visible(el)) continue;
      const text = normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
      if (!text) continue;
      if (texts.some((candidate) => text.includes(candidate))) {
        el.click();
        return { ok: true, text };
      }
    }
    return { ok: false };
  }, labels);

  if (result.ok) {
    console.log(`Restart: clicked "${result.text}"`);
    return true;
  }
  return false;
}

function formatManualClicks(clicks) {
  return manualUnlimited ? String(clicks) : `${clicks}/${maxClicks}`;
}

function normalizeSideLabel(side) {
  if (side === 'long' || side === 'up' || side === 'UP') return 'UP';
  if (side === 'short' || side === 'down' || side === 'DOWN') return 'DOWN';
  return '-';
}

async function installOverlay(page) {
  await page.evaluate(({ maxClicks, manualUnlimited }) => {
    const existing = document.getElementById('__rocket_bot_overlay');
    if (existing) {
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = '__rocket_bot_overlay';
    overlay.style.position = 'fixed';
    overlay.style.right = '18px';
    overlay.style.top = '82px';
    overlay.style.zIndex = '2147483647';
    overlay.style.minWidth = '164px';
    overlay.style.padding = '10px 12px';
    overlay.style.border = '1px solid #35e06f';
    overlay.style.borderRadius = '8px';
    overlay.style.background = 'rgba(10, 12, 16, 0.88)';
    overlay.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.35)';
    overlay.style.color = '#fff';
    overlay.style.font = '700 13px Arial, sans-serif';
    overlay.style.pointerEvents = 'none';

    overlay.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:12px;align-items:center;">
        <span>Clicks</span>
        <span id="__rocket_bot_clicks" style="font-size:20px;color:#35e06f;">${manualUnlimited ? '0' : `0/${maxClicks}`}</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px;color:#b9c0ce;">
        <span>Plays</span>
        <span id="__rocket_bot_plays">0</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px;color:#b9c0ce;">
        <span>Elapsed</span>
        <span id="__rocket_bot_elapsed">0s</span>
      </div>
      <div style="display:flex;justify-content:space-between;gap:12px;margin-top:6px;color:#b9c0ce;">
        <span>Side</span>
        <span id="__rocket_bot_side">-</span>
      </div>
      <div id="__rocket_bot_status" style="margin-top:6px;color:#b9c0ce;font-weight:600;">Manual UP/DOWN</div>
    `;

    document.documentElement.appendChild(overlay);
  }, { maxClicks, manualUnlimited });
}

async function updateOverlay(page, { clicks, plays, status, elapsedSec = 0, side }) {
  await page.evaluate(({ clicks, maxClicks, manualUnlimited, plays, status, elapsedSec, side }) => {
    const clickEl = document.getElementById('__rocket_bot_clicks');
    const playsEl = document.getElementById('__rocket_bot_plays');
    const elapsedEl = document.getElementById('__rocket_bot_elapsed');
    const sideEl = document.getElementById('__rocket_bot_side');
    const statusEl = document.getElementById('__rocket_bot_status');
    if (clickEl) {
      clickEl.textContent = manualUnlimited ? String(clicks) : `${clicks}/${maxClicks}`;
      clickEl.style.color = !manualUnlimited && clicks >= maxClicks ? '#ffcf70' : '#35e06f';
    }
    if (playsEl) playsEl.textContent = String(plays);
    if (elapsedEl) elapsedEl.textContent = `${Math.max(0, Math.floor(elapsedSec))}s`;
    if (sideEl && side !== undefined) {
      sideEl.textContent = side || '-';
      sideEl.style.color = side === 'UP' ? '#35e06f' : side === 'DOWN' ? '#ff6b7a' : '#b9c0ce';
    }
    if (statusEl) statusEl.textContent = status;
  }, { clicks, maxClicks, manualUnlimited, plays, status, elapsedSec, side }).catch(() => {});
}

async function installManualHotkeys(page) {
  const payload = { restartTexts, hotkeyVersion: 'single-start-v4' };
  await Promise.all(page.frames().map((frame) => frame.evaluate(({ restartTexts: customRestartTexts, hotkeyVersion }) => {
    if (window.__rocket_bot_manual_hotkeys_version === hotkeyVersion) {
      return;
    }
    if (window.__rocket_bot_manual_hotkeys_abort) {
      window.__rocket_bot_manual_hotkeys_abort.abort();
    }
    window.__rocket_bot_manual_hotkeys_version = hotkeyVersion;
    window.__rocket_bot_manual_hotkeys_abort = new AbortController();
    window.__rocket_bot_start_requested = null;
    window.__rocket_bot_start_request_until = 0;

    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const readText = (el) => normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
    const wholeWord = (value, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };
    const getControls = () => {
      const selector = 'button,[role="button"],a,input[type="button"],input[type="submit"],[tabindex],[onclick]';
      const seen = new Set();
      const controls = [];
      const add = (el, sourceText = '') => {
        const clickEl = el.closest(selector) || el;
        if (seen.has(clickEl) || !visible(clickEl)) return;
        const rect = clickEl.getBoundingClientRect();
        const text = [readText(clickEl), sourceText].filter(Boolean).join(' ').trim();
        if (!text) return;
        seen.add(clickEl);
        controls.push({
          el: clickEl,
          text,
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      };

      for (const el of [...document.querySelectorAll(selector)]) {
        add(el);
      }
      for (const el of [...document.querySelectorAll('body *')]) {
        if (!visible(el)) continue;
        const text = readText(el);
        if (!text || text.length > 100) continue;
        if (wholeWord(text, 'close') || wholeWord(text, 'up') || wholeWord(text, 'down') || wholeWord(text, 'long') || wholeWord(text, 'short')) {
          add(el, text);
        }
      }
      return controls;
    };
    const isCloseText = (text) =>
      text === 'close' ||
      wholeWord(text, 'close') ||
      text.includes('close position') ||
      text.includes('close trade');
    const findCloseButton = () => {
      return getControls()
        .filter((control) =>
          isCloseText(control.text) &&
          !control.text.includes('sign') &&
          !control.text.includes('login') &&
          control.width >= 40 &&
          control.height >= 24 &&
          control.y >= window.innerHeight * 0.18
        )
        .map((control) => ({
          ...control,
          score:
            (control.text === 'close' ? 10 : 0) +
            (wholeWord(control.text, 'close') ? 6 : 0) +
            (control.width >= 100 && control.height >= 40 ? 2 : 0) -
            Math.min(control.text.length / 80, 2)
        }))
        .sort((a, b) => b.score - a.score)[0] || null;
    };
    const clickControl = (control) => {
      const rect = control.el.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y) || control.el;
      const eventOptions = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
      try {
        target.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        target.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
        target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        target.dispatchEvent(new MouseEvent('click', eventOptions));
      } catch {
        target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
        target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
        target.dispatchEvent(new MouseEvent('click', eventOptions));
      }
      control.el.click();
    };
    const clickOnce = (control) => {
      const rect = control.el.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y) || control.el;
      target.click();
    };
    const directionWords = (side) => side === 'long'
      ? ['long', 'up']
      : ['short', 'down'];
    const blockedDirectionText = (text) =>
      text.includes('sign') ||
      text.includes('login') ||
      text.includes('connect') ||
      text.includes('close') ||
      text.includes('tap ');
    const findDirectionButton = (side) => {
      const words = directionWords(side);
      const candidates = getControls()
        .filter((control) =>
          !blockedDirectionText(control.text) &&
          control.y >= window.innerHeight * 0.20 &&
          control.width >= 60 &&
          control.height >= 32
        )
        .map((control) => {
          let score = 0;
          for (const word of words) {
            if (control.text === word) score += 6;
            if (wholeWord(control.text, word)) score += 4;
          }
          return { ...control, score };
        })
        .filter((control) => control.score > 0)
        .sort((a, b) => b.score - a.score);
      return candidates[0] || null;
    };
    const restartLabels = [
      ...customRestartTexts,
      'play again',
      'retry',
      'try again',
      'restart',
      'start',
      'continue',
      'next',
      'ok',
      'close'
    ];
    const hasTapTarget = () => getControls().some((control) =>
      control.text === 'tap' ||
      control.text.startsWith('tap ') ||
      control.text.includes(' tap ')
    );
    const findRestartButton = () => {
      const tapTargetVisible = hasTapTarget();
      return getControls().find((control) => {
        if (!restartLabels.some((candidate) => control.text.includes(candidate))) return false;
        if (control.text.includes('sign') || control.text.includes('login') || control.text.includes('connect')) return false;
        if (control.text === 'close' && tapTargetVisible) return false;
        return control.width >= 50 && control.height >= 28;
      });
    };
    const setStatus = (text) => {
      const statusEl = document.getElementById('__rocket_bot_status');
      if (statusEl) {
        statusEl.textContent = text;
      }
    };
    const setSide = (side) => {
      const sideLabel = side === 'short' ? 'DOWN' : 'UP';
      window.__rocket_bot_current_side = sideLabel;
      const sideEl = document.getElementById('__rocket_bot_side');
      if (sideEl) {
        sideEl.textContent = sideLabel;
        sideEl.style.color = sideLabel === 'UP' ? '#35e06f' : '#ff6b7a';
      }
    };
    const requestDirection = (side, label) => {
      const now = Date.now();
      if (window.__rocket_bot_start_request_until && now < window.__rocket_bot_start_request_until) {
        return;
      }
      window.__rocket_bot_start_request_until = now + 1400;
      window.__rocket_bot_start_requested = { side, at: now };
      setSide(side);
      setStatus(`${label} queued`);
    };

    window.addEventListener('keydown', (event) => {
      const tag = (event.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || event.target?.isContentEditable) {
        return;
      }
      const handledKey =
        event.code === 'KeyZ' || event.key?.toLowerCase() === 'z' ||
        event.code === 'KeyX' || event.key?.toLowerCase() === 'x' ||
        event.code === 'KeyC' || event.key?.toLowerCase() === 'c' ||
        event.code === 'Space' || event.key === ' ';
      if (event.repeat && handledKey) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        return;
      }

      if (event.code === 'KeyZ' || event.key?.toLowerCase() === 'z') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        requestDirection('long', 'Z LONG');
        return;
      }

      if (event.code === 'KeyX' || event.key?.toLowerCase() === 'x') {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        requestDirection('short', 'X SHORT');
        return;
      }

      const closeKey = event.code === 'Space' || event.key === ' ' || event.code === 'KeyC' || event.key?.toLowerCase() === 'c';
      if (!closeKey) {
        return;
      }
      window.__rocket_bot_close_requested = Date.now();
      const closeButton = findCloseButton();
      if (!closeButton) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setStatus('CLOSE requested');
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      clickControl(closeButton);
      setStatus(event.code === 'KeyC' || event.key?.toLowerCase() === 'c' ? 'C CLOSE' : 'Space CLOSE');
    }, { capture: true, signal: window.__rocket_bot_manual_hotkeys_abort.signal });
  }, payload).catch(() => false)));
}

async function takeManualCloseRequest(page) {
  for (const frame of page.frames()) {
    const requestedAt = await frame.evaluate(() => {
      if (!window.__rocket_bot_close_requested) {
        return false;
      }
      const value = window.__rocket_bot_close_requested;
      window.__rocket_bot_close_requested = 0;
      return value;
    }).catch(() => false);
    if (requestedAt) return requestedAt;
  }
  return false;
}

async function takeManualStartRequest(page) {
  for (const frame of page.frames()) {
    const request = await frame.evaluate(() => {
      const value = window.__rocket_bot_start_requested;
      if (!value?.side) {
        return null;
      }
      window.__rocket_bot_start_requested = null;
      return {
        side: value.side,
        at: value.at || Date.now()
      };
    }).catch(() => null);
    if (request?.side) return request;
  }
  return null;
}

async function directionClickRecentlyStarted(page) {
  return page.evaluate(() => Date.now() < (window.__rocket_bot_direction_click_until || 0)).catch(() => false);
}

async function markDirectionClickStarted(page, side) {
  const sideLabel = normalizeSideLabel(side);
  await page.evaluate(({ sideLabel }) => {
    window.__rocket_bot_direction_click_until = Date.now() + 1800;
    window.__rocket_bot_current_side = sideLabel;
    const sideEl = document.getElementById('__rocket_bot_side');
    if (sideEl) {
      sideEl.textContent = sideLabel;
      sideEl.style.color = sideLabel === 'UP' ? '#35e06f' : '#ff6b7a';
    }
  }, { sideLabel }).catch(() => {});
}

async function getManualScreenState(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const readText = (el) => normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
    const wholeWord = (value, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };

    // Only interactive controls are scanned (no full `body *` walk) so this stays
    // cheap even after a long session grows the page's DOM (history rows, etc.).
    const selector = 'button,[role="button"],a,input[type="button"],input[type="submit"]';
    const controls = [...document.querySelectorAll(selector)]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: readText(el),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2)
        };
      });

    const sideFromText = (text) => {
      const up = wholeWord(text, 'up') || wholeWord(text, 'long');
      const down = wholeWord(text, 'down') || wholeWord(text, 'short');
      if (up === down) return null;
      return up ? 'UP' : 'DOWN';
    };
    const isDirection = (text) => Boolean(sideFromText(text));
    const goodControl = (control) =>
      !control.text.includes('sign') &&
      !control.text.includes('login') &&
      !control.text.includes('connect') &&
      control.width >= 40 &&
      control.height >= 24;
    // The Up/Down buttons are real controls, so the side comes from them directly.
    const sideCandidate = controls
      .map((control) => ({ ...control, side: sideFromText(control.text) }))
      .filter((item) =>
        item.side &&
        !item.text.includes('sign') &&
        !item.text.includes('login') &&
        !item.text.includes('connect') &&
        !item.text.includes('tap ') &&
        !item.text.includes('close') &&
        item.width >= 20 &&
        item.height >= 12
      )
      .map((item) => ({
        ...item,
        score:
          (item.text === 'up' || item.text === 'down' || item.text === 'long' || item.text === 'short' ? 10 : 0) +
          4 +
          (item.y >= window.innerHeight * 0.35 ? 1 : 0) -
          Math.min(item.text.length / 80, 2)
      }))
      .sort((a, b) => b.score - a.score)[0];
    const rememberedSide = window.__rocket_bot_current_side || null;
    let side = sideCandidate?.side || null;

    const hasDirection = controls.some((control) => isDirection(control.text) && goodControl(control));
    const active = !hasDirection && controls.some((control) =>
      (control.text === 'close' || wholeWord(control.text, 'close') || control.text.includes('close position') || control.text.includes('close trade')) &&
      goodControl(control) &&
      control.y >= window.innerHeight * 0.18
    );

    const modalLike = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog')]
      .some(visible) ||
      controls.some((control) => isDirection(control.text) && control.y >= window.innerHeight * 0.35);

    if (active) {
      side = side || rememberedSide;
      return { mode: 'active', active: true, hasDirection, modalLike, side };
    }
    if (hasDirection && modalLike) return { mode: 'modal-ready', active: false, hasDirection, modalLike, side };
    if (hasDirection) return { mode: 'start-ready', active: false, hasDirection, modalLike, side };
    return { mode: 'idle', active: false, hasDirection, modalLike, side };
  }).catch(() => ({ mode: 'unknown', active: false, hasDirection: false, modalLike: false, side: null }));
}

async function isRoundActive(page) {
  return page.evaluate(() => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const readText = (el) => normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
    const wholeWord = (value, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };

    const controls = [...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"],[tabindex],[onclick]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: readText(el),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          y: Math.round(rect.y + rect.height / 2)
        };
      });

    const hasDirectionStart = controls.some((control) =>
      (wholeWord(control.text, 'up') || wholeWord(control.text, 'down') || wholeWord(control.text, 'long') || wholeWord(control.text, 'short')) &&
      !control.text.includes('sign') &&
      !control.text.includes('login') &&
      !control.text.includes('connect') &&
      control.width >= 60 &&
      control.height >= 32
    );
    if (hasDirectionStart) return false;

    return controls.some((control) =>
      (control.text === 'close' || wholeWord(control.text, 'close') || control.text.includes('close position') || control.text.includes('close trade')) &&
      !control.text.includes('sign') &&
      !control.text.includes('login') &&
      control.width >= 40 &&
      control.height >= 24 &&
      control.y >= window.innerHeight * 0.18
    );
  });
}

async function clickClosePosition(page) {
  for (const frame of page.frames()) {
    const result = await frame.evaluate((shouldClick) => {
      const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
      const readText = (el) => normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
      const wholeWord = (value, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value);
      const visible = (el) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) !== 0 &&
          rect.width >= 8 &&
          rect.height >= 8;
      };
      const clickControl = (control) => {
        const rect = control.el.getBoundingClientRect();
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        const target = document.elementFromPoint(x, y) || control.el;
        const eventOptions = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        try {
          target.dispatchEvent(new PointerEvent('pointerdown', { ...eventOptions, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
          target.dispatchEvent(new PointerEvent('pointerup', { ...eventOptions, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
          target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
          target.dispatchEvent(new MouseEvent('click', eventOptions));
        } catch {
          target.dispatchEvent(new MouseEvent('mousedown', eventOptions));
          target.dispatchEvent(new MouseEvent('mouseup', eventOptions));
          target.dispatchEvent(new MouseEvent('click', eventOptions));
        }
        control.el.click();
      };

      const selector = 'button,[role="button"],a,input[type="button"],input[type="submit"],[tabindex],[onclick]';
      const seen = new Set();
      const controls = [];
      const add = (el, sourceText = '') => {
        const clickEl = el.closest(selector) || el;
        if (seen.has(clickEl) || !visible(clickEl)) return;
        const rect = clickEl.getBoundingClientRect();
        const text = [readText(clickEl), sourceText].filter(Boolean).join(' ').trim();
        if (!text) return;
        seen.add(clickEl);
        controls.push({
          el: clickEl,
          text,
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        });
      };

      for (const el of [...document.querySelectorAll(selector)]) {
        add(el);
      }
      for (const el of [...document.querySelectorAll('body *')]) {
        if (!visible(el)) continue;
        const text = readText(el);
        if (!text || text.length > 100) continue;
        if (wholeWord(text, 'close') || text.includes('close position') || text.includes('close trade')) {
          add(el, text);
        }
      }

      const closeButton = controls
        .filter((control) =>
          (control.text === 'close' || wholeWord(control.text, 'close') || control.text.includes('close position') || control.text.includes('close trade')) &&
          !control.text.includes('sign') &&
          !control.text.includes('login') &&
          control.width >= 40 &&
          control.height >= 24 &&
          control.y >= window.innerHeight * 0.12
        )
        .map((control) => ({
          ...control,
          score:
            (control.text === 'close' ? 10 : 0) +
            (wholeWord(control.text, 'close') ? 6 : 0) +
            (control.width >= 100 && control.height >= 40 ? 2 : 0) -
            Math.min(control.text.length / 80, 2)
        }))
        .sort((a, b) => b.score - a.score)[0];

      if (!closeButton) return { ok: false };
      if (shouldClick) {
        clickControl(closeButton);
      }
      return {
        ok: true,
        text: closeButton.text,
        x: closeButton.x,
        y: closeButton.y,
        width: closeButton.width,
        height: closeButton.height
      };
    }, !dryRun).catch(() => ({ ok: false }));

    if (result.ok) {
      console.log(`Close: clicked "${result.text}" at x=${result.x} y=${result.y}`);
      await page.waitForTimeout(closeWaitMs);
      return true;
    }
  }

  console.log('Close: CLOSE button not found.');
  return false;
}

async function clickDirectionPosition(page, side) {
  const desired = side === 'short' || side === 'down' ? 'short' : 'long';
  const result = await page.evaluate((wanted) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const readText = (el) => normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title'));
    const wholeWord = (value, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };

    const selector = 'button,[role="button"],a,input[type="button"],input[type="submit"],[tabindex],[onclick]';
    const seen = new Set();
    const controls = [];
    const add = (el, sourceText = '') => {
      const clickEl = el.closest(selector) || el;
      if (seen.has(clickEl) || !visible(clickEl)) return;
      const rect = clickEl.getBoundingClientRect();
      const text = [readText(clickEl), sourceText].filter(Boolean).join(' ').trim();
      if (!text) return;
      seen.add(clickEl);
      controls.push({
        text,
        x: Math.round(rect.x + rect.width / 2),
        y: Math.round(rect.y + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      });
    };

    for (const el of [...document.querySelectorAll(selector)]) {
      add(el);
    }
    for (const el of [...document.querySelectorAll('body *')]) {
      if (!visible(el)) continue;
      const text = readText(el);
      if (!text || text.length > 100) continue;
      if (wholeWord(text, 'up') || wholeWord(text, 'down') || wholeWord(text, 'long') || wholeWord(text, 'short')) {
        add(el, text);
      }
    }

    const words = wanted === 'short' ? ['short', 'down'] : ['long', 'up'];
    const candidates = controls
      .filter((control) =>
        !control.text.includes('sign') &&
        !control.text.includes('login') &&
        !control.text.includes('connect') &&
        !control.text.includes('close') &&
        !control.text.includes('tap ') &&
        control.width >= 40 &&
        control.height >= 24 &&
        control.y >= window.innerHeight * 0.18
      )
      .map((control) => {
        let score = 0;
        for (const word of words) {
          if (control.text === word) score += 10;
          if (wholeWord(control.text, word)) score += 6;
        }
        return { ...control, score };
      })
      .filter((control) => control.score > 0)
      .sort((a, b) => b.score - a.score);

    return candidates[0] ? { ok: true, ...candidates[0] } : { ok: false };
  }, desired);

  if (result.ok) {
    console.log(`Direction: clicked ${desired.toUpperCase()} via "${result.text}" at x=${result.x} y=${result.y}`);
    if (!dryRun) {
      await page.mouse.click(result.x, result.y);
    }
    return true;
  }

  console.log(`Direction: ${desired.toUpperCase()} button not found.`);
  return false;
}

async function scan(page, recent) {
  const { targets: domTargets, avoid: domAvoid } = await findDomTargets(page);
  const freshDomTargets = domTargets.filter((target) => {
    if (recent.some((seen) => overlaps(target, seen, Math.max(24, Math.max(target.width, target.height) * 0.6)))) return false;
    return true;
  });
  if (freshDomTargets.length > 0) {
    return {
      targets: freshDomTargets,
      rockMatches: [],
      avoidMatches: domAvoid,
      source: 'dom'
    };
  }

  if (!imageFallback) {
    return {
      targets: [],
      rockMatches: [],
      avoidMatches: domAvoid,
      source: 'dom'
    };
  }

  const png = PNG.sync.read(await page.screenshot({ fullPage: false }));
  const avoidMatches = avoidTemplates.flatMap((template) => findMatches(png, template, Math.max(0.78, threshold - 0.04)));
  const avoidRadius = Math.max(28, ...avoidMatches.map((m) => Math.max(m.width, m.height) * 1.3));
  const rockMatches = rockTemplates.flatMap((template) => findMatches(png, template, threshold));

  const targets = rockMatches.filter((rock) => {
    if (avoidMatches.some((avoid) => overlaps(rock, avoid, avoidRadius))) return false;
    if (recent.some((seen) => overlaps(rock, seen, Math.max(24, Math.max(rock.width, rock.height) * 0.6)))) return false;
    return true;
  });

  return { targets, rockMatches, avoidMatches, source: 'image' };
}

async function ensureRoundStarted(page) {
  if (!autoStart) return { status: 'disabled' };

  const state = await page.evaluate((side) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const wholeWord = (value, word) => new RegExp(`(^|[^a-z])${word}([^a-z]|$)`).test(value);
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };

    const controls = [...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')]
      .filter(visible)
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: normalize(el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title')),
          x: Math.round(rect.x + rect.width / 2),
          y: Math.round(rect.y + rect.height / 2),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      });

    const activeClose = controls.find((control) =>
      control.text === 'close' &&
      control.width >= 100 &&
      control.height >= 40
    );
    if (activeClose) return { status: 'already-active' };

    const desired = side === 'down' ? 'down' : 'up';
    const startButton = controls.find((control) =>
      wholeWord(control.text, desired) &&
      !control.text.includes('sign') &&
      !control.text.includes('login') &&
      control.y >= window.innerHeight * 0.28 &&
      control.width >= 80 &&
      control.height >= 40
    );

    if (!startButton) {
      return {
        status: 'not-found',
        controls: controls.map((control) => control.text).filter(Boolean).slice(0, 20)
      };
    }

    return { status: 'click', button: startButton };
  }, startSide);

  if (state.status === 'click') {
    console.log(`Auto-start: clicking ${startSide.toUpperCase()} at x=${state.button.x} y=${state.button.y}`);
    if (!dryRun) {
      await page.mouse.click(state.button.x, state.button.y);
    }
    return { status: 'clicked' };
  }

  if (state.status === 'not-found') {
    console.log(`Auto-start: ${startSide.toUpperCase()} button not found. Visible controls: ${state.controls?.join(' | ') ?? ''}`);
  }

  return state;
}

async function findDomTargets(page) {
  return page.evaluate(({ coinNeedles, avoidClassNeedles, targetTexts: targetNeedles, avoidTexts: avoidNeedles }) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };

    const W = window.innerWidth, H = window.innerHeight;
    // Tappable coins only spawn inside the central play area; restrict to it so we
    // never click chrome (nav, CLOSE button, amount controls, side panels).
    const inPlay = (cx, cy) => cx > W * 0.24 && cx < W * 0.82 && cy > H * 0.10 && cy < H * 0.76;
    const targets = [];
    const avoid = [];
    const seen = new Set();
    const push = (el, kind, label) => {
      const clickEl = el.closest('button,[role="button"],a') || el;
      if (seen.has(clickEl) || !visible(clickEl)) return;
      const rect = clickEl.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (rect.width < 12 || rect.height < 12 || rect.width > 220 || rect.height > 220) return;
      if (!inPlay(cx, cy)) return;
      seen.add(clickEl);
      const item = {
        x: Math.round(cx),
        y: Math.round(cy),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        score: 1,
        template: label,
        source: 'dom'
      };
      (kind === 'avoid' ? avoid : targets).push(item);
    };

    // Class-based coin/asteroid tap targets (and optional hazard class). Selecting
    // by class attribute lets the browser return only matching nodes, so the cost
    // is proportional to the handful of on-screen coins, not the whole DOM.
    const classSelector = (needles) => needles.map((needle) => `[class*="${needle}" i]`).join(',');
    const avoidSelector = avoidClassNeedles.length ? classSelector(avoidClassNeedles) : '';
    const coinSelector = coinNeedles.length ? classSelector(coinNeedles) : '';
    if (avoidSelector) {
      for (const el of document.querySelectorAll(avoidSelector)) push(el, 'avoid', 'coin-hazard');
    }
    if (coinSelector) {
      for (const el of document.querySelectorAll(coinSelector)) push(el, 'target', 'coin');
    }

    // Optional legacy text-based targets (only when --target-text is supplied).
    if (targetNeedles.length) {
      for (const el of document.querySelectorAll('button,[role="button"],a')) {
        if (!visible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        if (!text) continue;
        if (avoidNeedles.some((needle) => text.includes(needle))) {
          push(el, 'avoid', text);
          continue;
        }
        if (targetNeedles.some((needle) => text.includes(needle))) {
          push(el, 'target', text);
        }
      }
    }

    return { targets, avoid };
  }, { coinNeedles: coinClassNeedles, avoidClassNeedles, targetTexts, avoidTexts });
}

async function clickDomTargetsFast(page, recent, limit) {
  if (limit <= 0) {
    return { targets: [], avoid: [], source: 'dom-fast' };
  }

  return page.evaluate(({ coinNeedles, avoidClassNeedles, targetTexts: targetNeedles, avoidTexts: avoidNeedles, recentTargets, limit, dryRun }) => {
    const normalize = (value) => (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const visible = (el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        Number(style.opacity) !== 0 &&
        rect.width >= 8 &&
        rect.height >= 8;
    };
    const overlapsRecent = (item) => recentTargets.some((seen) => {
      const dx = item.x - seen.x;
      const dy = item.y - seen.y;
      const radius = Math.max(18, Math.min(60, Math.max(item.width, item.height) * 0.45));
      return Math.sqrt(dx * dx + dy * dy) <= radius;
    });

    const W = window.innerWidth, H = window.innerHeight;
    const inPlay = (cx, cy) => cx > W * 0.24 && cx < W * 0.82 && cy > H * 0.10 && cy < H * 0.76;
    const targets = [];
    const avoid = [];
    const seen = new Set();
    const consider = (el, kind, label) => {
      const clickEl = el.closest('button,[role="button"],a') || el;
      if (seen.has(clickEl) || !visible(clickEl)) return;
      const rect = clickEl.getBoundingClientRect();
      const cx = rect.x + rect.width / 2;
      const cy = rect.y + rect.height / 2;
      if (rect.width < 12 || rect.height < 12 || rect.width > 220 || rect.height > 220) return;
      if (!inPlay(cx, cy)) return;
      seen.add(clickEl);
      const item = {
        x: Math.round(cx),
        y: Math.round(cy),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        score: 1,
        template: label,
        source: 'dom-fast'
      };
      if (kind === 'avoid') {
        avoid.push(item);
        return;
      }
      if (!overlapsRecent(item)) {
        targets.push({ el: clickEl, item });
      }
    };

    const classSelector = (needles) => needles.map((needle) => `[class*="${needle}" i]`).join(',');
    const avoidSelector = avoidClassNeedles.length ? classSelector(avoidClassNeedles) : '';
    const coinSelector = coinNeedles.length ? classSelector(coinNeedles) : '';
    if (avoidSelector) {
      for (const el of document.querySelectorAll(avoidSelector)) consider(el, 'avoid', 'coin-hazard');
    }
    if (coinSelector) {
      for (const el of document.querySelectorAll(coinSelector)) consider(el, 'target', 'coin');
    }

    if (targetNeedles.length) {
      for (const el of document.querySelectorAll('button,[role="button"],a')) {
        if (!visible(el)) continue;
        const text = normalize(el.innerText || el.textContent || el.getAttribute('aria-label') || el.getAttribute('title'));
        if (!text) continue;
        if (avoidNeedles.some((needle) => text.includes(needle))) {
          consider(el, 'avoid', text);
          continue;
        }
        if (targetNeedles.some((needle) => text.includes(needle))) {
          consider(el, 'target', text);
        }
      }
    }

    // The coins react to pointer/mouse-down, not a bare click(), so dispatch the
    // full pointer+mouse sequence at the element's live centre (it keeps moving).
    const fireTap = (el) => {
      const rect = el.getBoundingClientRect();
      const x = rect.x + rect.width / 2;
      const y = rect.y + rect.height / 2;
      const target = document.elementFromPoint(x, y) || el;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
      const ptr = { ...opts, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      try {
        target.dispatchEvent(new PointerEvent('pointerover', ptr));
        target.dispatchEvent(new PointerEvent('pointerenter', ptr));
        target.dispatchEvent(new PointerEvent('pointerdown', ptr));
        target.dispatchEvent(new MouseEvent('mousedown', opts));
        target.dispatchEvent(new PointerEvent('pointerup', ptr));
        target.dispatchEvent(new MouseEvent('mouseup', opts));
        target.dispatchEvent(new MouseEvent('click', opts));
      } catch {
        try { el.click(); } catch {}
      }
    };

    const clicked = [];
    for (const { el, item } of targets.slice(0, limit)) {
      clicked.push(item);
      if (!dryRun) {
        fireTap(el);
      }
    }

    return { targets: clicked, avoid, source: 'dom-fast' };
  }, {
    coinNeedles: coinClassNeedles,
    avoidClassNeedles,
    targetTexts,
    avoidTexts,
    recentTargets: recent.map((target) => ({ x: target.x, y: target.y, width: target.width || 24, height: target.height || 24 })),
    limit,
    dryRun
  });
}

async function playRound(page, roundNumber) {
  let clicks = 0;
  const recent = [];
  let lastLog = 0;
  let lastClickAt = Date.now();
  let lastSeenTargetAt = Date.now();
  let lastStartAttemptAt = 0;
  const startedAt = Date.now();
  const roundLabel = Number.isFinite(rounds) ? `${roundNumber}/${rounds}` : `${roundNumber}/repeat`;
  console.log(`Round ${roundLabel}: started. Max clicks=${maxClicks}`);

  while (clicks < maxClicks) {
    const now = Date.now();
    if (clicks === 0 && now - lastStartAttemptAt >= startRetryMs) {
      lastStartAttemptAt = now;
      const started = await ensureRoundStarted(page);
      if (started.status === 'clicked') {
        await page.waitForTimeout(700);
      }
    }

    const { targets, rockMatches, avoidMatches, source } = await scan(page, recent);

    if (targets.length > 0) {
      lastSeenTargetAt = now;
      const batch = targets.slice(0, Math.min(clickBurst, maxClicks - clicks));
      for (const target of batch) {
        const clickAt = Date.now();
        recent.push({ ...target, at: clickAt });
        while (recent.length && clickAt - recent[0].at > recentMs) recent.shift();

        clicks += 1;
        lastClickAt = clickAt;
        const msg = `Round ${roundLabel} [${clicks}/${maxClicks}] ${dryRun ? 'would click' : 'click'} source=${source} x=${target.x} y=${target.y} score=${target.score.toFixed(3)} target=${target.template}`;
        console.log(msg);
        if (!dryRun) {
          await page.mouse.click(target.x, target.y);
        }
        if (clickDelayMs > 0) {
          await page.waitForTimeout(clickDelayMs);
        }
      }
      continue;
    }

    const noFirstClickTooLong = clicks === 0 && now - startedAt >= startTimeoutMs;
    const quietAfterClicks = clicks > 0 && now - Math.max(lastClickAt, lastSeenTargetAt) >= idleRoundMs;
    if (noFirstClickTooLong || quietAfterClicks) {
      const reason = noFirstClickTooLong ? 'start-timeout' : 'idle';
      console.log(`Round ${roundLabel}: ended by ${reason}. Clicks=${clicks}`);
      await saveDebugSnapshot(page, `autoplay-${reason}`);
      return { clicks, reason };
    }

    if (now - lastLog > 2000) {
      const mode = imageFallback ? 'dom+image' : 'dom-only';
      console.log(`Round ${roundLabel}: scanning... mode=${mode}, clicks=${clicks}, candidates=${rockMatches.length}, avoid=${avoidMatches.length}`);
      lastLog = now;
    }
    await page.waitForTimeout(intervalMs);
  }

  console.log(`Round ${roundLabel}: ended by max-clicks. Clicks=${clicks}`);
  if (closeOnMax) {
    await clickClosePosition(page);
  }
  return { clicks, reason: 'max-clicks' };
}

async function watchManualRounds(page) {
  let clicks = 0;
  let plays = 0;
  let wasActive = false;
  let capped = false;
  let lastLog = 0;
  let lastScreenMode = '';
  let currentSide = '-';
  let activeStartedAt = null;
  let lastInstallAt = 0;
  const recent = [];

  await installOverlay(page);
  await installManualHotkeys(page);
  await updateOverlay(page, { clicks, plays, elapsedSec: 0, status: 'Manual UP/DOWN', side: currentSide });
  console.log(`Manual mode: press Z/X to open UP/DOWN yourself. The bot will keep tapping coins/asteroids ${manualUnlimited ? 'without a tap limit' : `up to ${maxClicks}`} during the active round. It never closes the position automatically; press C or Space to close.`);

  while (true) {
    // The overlay and hotkeys persist once installed, so re-assert them only
    // about once a second (enough to recover after a page refresh) instead of on
    // every iteration.
    if (Date.now() - lastInstallAt >= 1000) {
      lastInstallAt = Date.now();
      await installOverlay(page).catch(() => {});
      await installManualHotkeys(page).catch(() => {});
    }
    const screenState = await getManualScreenState(page);
    const active = screenState.active;
    const readyStatus = screenState.mode === 'modal-ready'
      ? 'Modal Z/X ready'
      : screenState.mode === 'start-ready'
        ? 'Ready Z/X'
        : 'Manual UP/DOWN';

    if (active && !wasActive) {
      plays += 1;
      clicks = 0;
      capped = false;
      currentSide = screenState.side || currentSide;
      activeStartedAt = Date.now();
      recent.length = 0;
      console.log(`Manual play ${plays}: detected active ${currentSide} round. Counter reset to ${formatManualClicks(0)}.`);
      await updateOverlay(page, { clicks, plays, elapsedSec: 0, status: 'Active', side: currentSide });
    } else if (!active && wasActive) {
      console.log(`Manual play ${plays}: round no longer active. Final clicks=${formatManualClicks(clicks)}.`);
      clicks = 0;
      capped = false;
      currentSide = '-';
      activeStartedAt = null;
      recent.length = 0;
      await updateOverlay(page, { clicks, plays, elapsedSec: 0, status: readyStatus, side: currentSide });
    } else if (!active && screenState.mode !== lastScreenMode) {
      await updateOverlay(page, { clicks, plays, elapsedSec: 0, status: readyStatus, side: currentSide });
    } else if (active && screenState.side && screenState.side !== currentSide) {
      currentSide = screenState.side;
      await updateOverlay(page, { clicks, plays, elapsedSec: activeStartedAt ? (Date.now() - activeStartedAt) / 1000 : 0, status: 'Active', side: currentSide });
    }

    wasActive = active;
    lastScreenMode = screenState.mode;
    const elapsedSec = activeStartedAt ? (Date.now() - activeStartedAt) / 1000 : 0;
    const manualCloseRequested = await takeManualCloseRequest(page);
    if (manualCloseRequested) {
      console.log(`Manual play ${plays}: CLOSE hotkey requested.`);
      await updateOverlay(page, { clicks, plays, elapsedSec, status: 'Hotkey CLOSE', side: currentSide });
      if (!dryRun) {
        await clickClosePosition(page);
      }
      await page.waitForTimeout(150);
      continue;
    }

    const manualStartRequested = await takeManualStartRequest(page);
    if (manualStartRequested) {
      const side = manualStartRequested.side === 'short' || manualStartRequested.side === 'down' ? 'short' : 'long';
      console.log(`Manual play ${plays}: ${side.toUpperCase()} hotkey requested from ${screenState.mode}.`);
      if (!active) {
        currentSide = normalizeSideLabel(side);
        await updateOverlay(page, { clicks, plays, elapsedSec: 0, status: `Hotkey ${side.toUpperCase()}`, side: currentSide });
        await page.waitForTimeout(350);
        const alreadyClicked = await directionClickRecentlyStarted(page);
        const refreshedState = await getManualScreenState(page);
        if (alreadyClicked || refreshedState.active) {
          await updateOverlay(page, {
            clicks,
            plays,
            elapsedSec: 0,
            status: alreadyClicked ? `Hotkey ${side.toUpperCase()} sent` : 'Active',
            side: currentSide
          });
          continue;
        }
        if (!dryRun) {
          await markDirectionClickStarted(page, side);
          await clickDirectionPosition(page, side);
        }
        await page.waitForTimeout(150);
        continue;
      }
    }

    if (!active) {
      await page.waitForTimeout(150);
      continue;
    }

    const now = Date.now();

    if (!manualUnlimited && clicks >= maxClicks) {
      if (!capped) {
        capped = true;
        console.log(`Manual play ${plays}: reached ${maxClicks}/${maxClicks}. CLOSE is manual.`);
      }
      await updateOverlay(page, { clicks, plays, elapsedSec, status: 'Limit reached. CLOSE manually', side: currentSide });
      await page.waitForTimeout(150);
      continue;
    }

    const batchLimit = manualUnlimited ? clickBurst : Math.min(clickBurst, maxClicks - clicks);
    if (fastDomClick) {
      const fastDom = await clickDomTargetsFast(page, recent, batchLimit);
      if (fastDom.targets.length > 0) {
        const clickAt = Date.now();
        for (const target of fastDom.targets) {
          recent.push({ ...target, at: clickAt });
          while (recent.length && clickAt - recent[0].at > recentMs) recent.shift();
        }
        clicks += fastDom.targets.length;
        console.log(`Manual play ${plays} [${formatManualClicks(clicks)}] ${dryRun ? 'would fast-click' : 'fast-click'} ${fastDom.targets.length} targets, avoid=${fastDom.avoid.length}`);
        await updateOverlay(page, {
          clicks,
          plays,
          elapsedSec: activeStartedAt ? (Date.now() - activeStartedAt) / 1000 : 0,
          status: `Active +${fastDom.targets.length}`,
          side: currentSide
        });
        continue;
      }
    }

    const { targets, avoidMatches, source } = await scan(page, recent);
    if (targets.length > 0) {
      const batch = targets.slice(0, batchLimit);
      for (const target of batch) {
        const clickAt = Date.now();
        recent.push({ ...target, at: clickAt });
        while (recent.length && clickAt - recent[0].at > recentMs) recent.shift();

        clicks += 1;
        console.log(`Manual play ${plays} [${formatManualClicks(clicks)}] ${dryRun ? 'would click' : 'click'} source=${source} x=${target.x} y=${target.y} target=${target.template}`);
        await updateOverlay(page, {
          clicks,
          plays,
          elapsedSec: activeStartedAt ? (Date.now() - activeStartedAt) / 1000 : 0,
          status: 'Active',
          side: currentSide
        });
        if (!dryRun) {
          await page.mouse.click(target.x, target.y);
        }
        if (clickDelayMs > 0) {
          await page.waitForTimeout(clickDelayMs);
        }
      }
      continue;
    }

    if (now - lastLog > 2500) {
      console.log(`Manual play ${plays}: scanning... clicks=${formatManualClicks(clicks)}, avoid=${avoidMatches.length}`);
      lastLog = now;
    }

    await updateOverlay(page, { clicks, plays, elapsedSec, status: `Active ${Math.floor(elapsedSec)}s`, side: currentSide });
    await page.waitForTimeout(intervalMs);
  }
}

async function saveDebugSnapshot(page, prefix) {
  try {
    const capturesDir = path.join(projectRoot, 'captures');
    ensureDir(capturesDir);
    const safeStamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pngPath = path.join(capturesDir, `${prefix}-${safeStamp}.png`);
    const jsonPath = pngPath.replace(/\.png$/i, '.json');
    await page.screenshot({ path: pngPath, fullPage: false });
    const controls = await page.evaluate(() => [...document.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')]
      .map((el) => {
        const rect = el.getBoundingClientRect();
        return {
          text: (el.innerText || el.textContent || el.value || el.getAttribute('aria-label') || el.getAttribute('title') || '').trim(),
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        };
      })
      .filter((item) => item.width > 0 && item.height > 0));
    fs.writeFileSync(jsonPath, JSON.stringify({ url: page.url(), controls }, null, 2), 'utf8');
    console.log(`Debug snapshot: ${pngPath}`);
  } catch (error) {
    console.log(`Debug snapshot failed: ${error.message}`);
  }
}

async function prepareNextRound(page, previousResult) {
  console.log(`Preparing next round. Previous reason=${previousResult.reason}`);
  for (let attempt = 1; attempt <= restartAttempts; attempt += 1) {
    const started = await ensureRoundStarted(page);
    if (started.status === 'clicked' || started.status === 'already-active') {
      await page.waitForTimeout(restartDelayMs);
      return true;
    }
    if (await clickRestartControl(page)) {
      await page.waitForTimeout(restartDelayMs);
      return true;
    }
    if (attempt === 1 || attempt === restartAttempts || attempt % 5 === 0) {
      console.log(`Restart control not found yet (${attempt}/${restartAttempts}).`);
    }
    await page.waitForTimeout(restartPollMs);
  }

  if (previousResult.reason === 'max-clicks') {
    console.log('No restart control found after max-clicks. Stopping to avoid carrying clicks into the same round.');
    console.log('Tip: pass --restart-x and --restart-y for the play-again button, or add --restart-text "exact button text".');
    return false;
  }

  console.log('No restart control found. Start the next round manually in the browser; scanning will resume.');
  return true;
}

const rockTemplates = readTemplates(rockDir, 'rock');
const avoidTemplates = readTemplates(avoidDir, 'avoid');

if (rockTemplates.length === 0) {
  console.warn('No rock templates found. DOM target mode is still enabled.');
}
if (avoidTemplates.length === 0) {
  console.warn('No avoid/skull templates found. DOM avoid labels are still enabled.');
}

const { browser, page } = await openBrowserPage(chromium, {
  args,
  browserName,
  url,
  profileDir,
  profileDirectory
});

console.log(`Waiting ${waitMs}ms. Put the trial game into the playable state.`);
await page.waitForTimeout(waitMs);

if (manualMode) {
  await watchManualRounds(page);
}

let totalClicks = 0;
for (let round = 1; round <= rounds; round += 1) {
  const result = await playRound(page, round);
  totalClicks += result.clicks;

  const hasMoreRounds = round + 1 <= rounds;
  if (!hasMoreRounds) break;

  const ready = await prepareNextRound(page, result);
  if (!ready) break;
}

console.log(`Done. Total clicks=${totalClicks}.`);
if (Boolean(args['close-browser'])) {
  await browser.close();
} else {
  console.log('Browser left open. Close it manually when finished.');
  await new Promise(() => {});
}
