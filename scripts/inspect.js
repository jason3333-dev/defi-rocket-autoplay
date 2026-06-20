import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright-core';
import { asNumber, ensureDir, openBrowserPage, parseArgs, projectRoot, stamp } from './common.js';

const args = parseArgs();
const url = String(args.url ?? 'https://app.defi.app/rocket');
const browserName = String(args.browser ?? process.env.ROCKET_BROWSER ?? 'chrome').toLowerCase();
const waitMs = asNumber(args.wait, 15000);
const manual = Boolean(args.manual);
const clickToCapture = Boolean(args['click-to-capture']);
const dedicatedProfileDir = path.join(projectRoot, browserName.includes('edge') ? 'browser-profile-edge' : 'browser-profile-chrome');
const profileDir = path.resolve(String(args['profile-dir'] ?? dedicatedProfileDir));
const profileDirectory = args['profile-directory'] ? String(args['profile-directory']) : 'Default';
const capturesDir = path.join(projectRoot, 'captures');

ensureDir(profileDir);
ensureDir(capturesDir);

const { browser, page } = await openBrowserPage(chromium, {
  args,
  browserName,
  url,
  profileDir,
  profileDirectory
});

if (clickToCapture) {
  await waitForPageCaptureClick(page);
} else if (manual) {
  console.log('Log in/start the trial game in the opened browser, then press Enter here to capture.');
  const rl = readline.createInterface({ input, output });
  await rl.question('Press Enter to capture screenshot...');
  rl.close();
} else {
  console.log(`Waiting ${waitMs}ms. Log in/start the trial game in the opened browser if needed.`);
  await page.waitForTimeout(waitMs);
}

async function waitForPageCaptureClick(page) {
  let resolveCapture;
  const captured = new Promise((resolve) => {
    resolveCapture = resolve;
  });

  await page.exposeBinding('__rocketCaptureForBot', async () => {
    await page.evaluate(() => {
      document.getElementById('__rocket_capture_for_bot')?.remove();
    }).catch(() => {});
    resolveCapture();
  });

  const installButton = async () => {
    await page.evaluate(() => {
      if (document.getElementById('__rocket_capture_for_bot')) return;
      const panel = document.createElement('div');
      panel.id = '__rocket_capture_for_bot';
      panel.style.position = 'fixed';
      panel.style.left = '14px';
      panel.style.top = '72px';
      panel.style.zIndex = '2147483647';
      panel.style.display = 'flex';
      panel.style.alignItems = 'center';
      panel.style.gap = '8px';
      panel.style.padding = '8px';
      panel.style.border = '1px solid #7c3aed';
      panel.style.borderRadius = '8px';
      panel.style.background = 'rgba(16, 17, 20, 0.92)';
      panel.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.35)';
      panel.style.color = '#fff';
      panel.style.font = '600 13px Arial, sans-serif';

      const text = document.createElement('span');
      text.textContent = 'Game ready?';

      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Capture for bot';
      button.style.border = '0';
      button.style.borderRadius = '6px';
      button.style.padding = '8px 10px';
      button.style.background = '#7c3aed';
      button.style.color = '#fff';
      button.style.cursor = 'pointer';
      button.style.font = '700 13px Arial, sans-serif';
      button.onclick = () => {
        button.disabled = true;
        button.textContent = 'Capturing...';
        window.__rocketCaptureForBot?.();
      };

      panel.append(text, button);
      document.documentElement.appendChild(panel);
    });
  };

  console.log('Use the opened browser. When the game screen is ready, click "Capture for bot" on the page.');
  await installButton().catch(() => {});
  const timer = setInterval(() => {
    installButton().catch(() => {});
  }, 1000);
  await captured;
  clearInterval(timer);
}

const domInfo = await page.evaluate(() => {
  const shortSrc = (value) => {
    if (!value) return '';
    if (value.startsWith('data:')) return `${value.slice(0, 80)}... [${value.length} chars]`;
    return value.slice(0, 240);
  };

  const rect = (el) => {
    const r = el.getBoundingClientRect();
    return {
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height),
      visible: r.width > 0 && r.height > 0
    };
  };

  return {
    title: document.title,
    url: location.href,
    canvases: [...document.querySelectorAll('canvas')].map((el, index) => ({
      index,
      ...rect(el)
    })),
    images: [...document.querySelectorAll('img')].slice(0, 80).map((el, index) => ({
      index,
      alt: el.alt || '',
      src: shortSrc(el.currentSrc || el.src || ''),
      ...rect(el)
    })),
    buttons: [...document.querySelectorAll('button,[role="button"]')].slice(0, 80).map((el, index) => ({
      index,
      text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80),
      ...rect(el)
    }))
  };
});

const pngPath = path.join(capturesDir, `inspect-${stamp()}.png`);
const jsonPath = pngPath.replace(/\.png$/i, '.json');
await page.screenshot({ path: pngPath, fullPage: false });
fs.writeFileSync(jsonPath, JSON.stringify(domInfo, null, 2), 'utf8');

console.log(`Screenshot: ${pngPath}`);
console.log(`DOM info:   ${jsonPath}`);
console.log(JSON.stringify(domInfo, null, 2));

await browser.close();
