import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import { asNumber, ensureDir, openBrowserPage, parseArgs, projectRoot, stamp } from './common.js';

const args = parseArgs();
const url = String(args.url ?? 'https://app.defi.app/rocket');
const browserName = String(args.browser ?? process.env.ROCKET_BROWSER ?? 'chrome').toLowerCase();
const port = asNumber(args.port, 8792);
const dedicatedProfileDir = path.join(projectRoot, browserName.includes('edge') ? 'browser-profile-edge' : 'browser-profile-chrome');
const profileDir = path.resolve(String(args['profile-dir'] ?? dedicatedProfileDir));
const profileDirectory = args['profile-directory'] ? String(args['profile-directory']) : 'Default';
const capturesDir = path.join(projectRoot, 'captures');
const resourcesRoot = path.join(projectRoot, 'resources');
const rockDir = path.join(projectRoot, 'templates', 'rocks');
const avoidDir = path.join(projectRoot, 'templates', 'avoid');

ensureDir(profileDir);
ensureDir(capturesDir);
ensureDir(resourcesRoot);
ensureDir(rockDir);
ensureDir(avoidDir);

const { context, page } = await openBrowserPage(chromium, {
  args,
  browserName,
  url,
  profileDir,
  profileDirectory
});

console.log('Move to the game screen, then click "Capture for bot" in the browser.');

await waitForPageCaptureClick(page);

const runId = stamp();
const pngPath = path.join(capturesDir, `inspect-${runId}.png`);
const jsonPath = pngPath.replace(/\.png$/i, '.json');
const resourceRunDir = path.join(resourcesRoot, runId);
const domInfo = await inspectDom(page);
await page.screenshot({ path: pngPath, fullPage: false });
fs.writeFileSync(jsonPath, JSON.stringify(domInfo, null, 2), 'utf8');
console.log(`Screenshot: ${pngPath}`);
console.log(`DOM info:   ${jsonPath}`);

const resources = await extractImageResources(page, resourceRunDir);
console.log(`Resources:  ${resources.length} image(s) extracted to ${resourceRunDir}`);

const server = createCalibrationServer(pngPath, resources, resourceRunDir);
const calibrationUrl = `http://127.0.0.1:${port}/`;
await new Promise((resolve) => {
  server.listen(port, '127.0.0.1', resolve);
});

console.log(`Calibration: ${calibrationUrl}`);
await page.goto(calibrationUrl, { waitUntil: 'domcontentloaded' });
console.log('Calibration is open in the same browser. Close that browser window when done.');

context.on('close', () => {
  server.close(() => process.exit(0));
});

await new Promise(() => {});

async function waitForPageCaptureClick(targetPage) {
  let resolveCapture;
  const captured = new Promise((resolve) => {
    resolveCapture = resolve;
  });

  await targetPage.exposeBinding('__rocketCaptureForBot', async () => {
    await targetPage.evaluate(() => {
      document.getElementById('__rocket_capture_for_bot')?.remove();
    }).catch(() => {});
    resolveCapture();
  });

  const installButton = async () => {
    await targetPage.evaluate(() => {
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

  await installButton().catch(() => {});
  const timer = setInterval(() => {
    installButton().catch(() => {});
  }, 1000);
  await captured;
  clearInterval(timer);
}

async function inspectDom(targetPage) {
  return targetPage.evaluate(() => {
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
}

async function extractImageResources(targetPage, resourceRunDir) {
  ensureDir(resourceRunDir);
  const extracted = await targetPage.evaluate(async () => {
    const candidates = [];
    const seen = new Set();

    function addCandidate(src, label, source) {
      if (!src || seen.has(src)) return;
      if (src.startsWith('blob:')) return;
      seen.add(src);
      candidates.push({ src, label, source });
    }

    for (const [index, img] of [...document.querySelectorAll('img')].entries()) {
      addCandidate(
        img.currentSrc || img.src,
        img.alt || img.getAttribute('aria-label') || `img ${index}`,
        'img'
      );
    }

    for (const [index, el] of [...document.querySelectorAll('*')].entries()) {
      const bg = window.getComputedStyle(el).backgroundImage || '';
      const matches = [...bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)];
      for (const match of matches) {
        addCandidate(match[1], el.getAttribute('aria-label') || el.textContent?.trim()?.slice(0, 40) || `bg ${index}`, 'background');
      }
    }

    async function renderCandidate(candidate, index) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        const done = (value) => {
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => done(null), 2500);
        img.onerror = () => done(null);
        img.onload = () => {
          try {
            const width = img.naturalWidth;
            const height = img.naturalHeight;
            if (width < 6 || height < 6 || width > 768 || height > 768) {
              done(null);
              return;
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0);
            const data = ctx.getImageData(0, 0, width, height);

            let minX = width;
            let minY = height;
            let maxX = -1;
            let maxY = -1;
            for (let y = 0; y < height; y += 1) {
              for (let x = 0; x < width; x += 1) {
                const alpha = data.data[(y * width + x) * 4 + 3];
                if (alpha <= 8) continue;
                minX = Math.min(minX, x);
                minY = Math.min(minY, y);
                maxX = Math.max(maxX, x);
                maxY = Math.max(maxY, y);
              }
            }

            if (maxX < minX || maxY < minY) {
              done(null);
              return;
            }

            const pad = 1;
            minX = Math.max(0, minX - pad);
            minY = Math.max(0, minY - pad);
            maxX = Math.min(width - 1, maxX + pad);
            maxY = Math.min(height - 1, maxY + pad);

            const cropWidth = maxX - minX + 1;
            const cropHeight = maxY - minY + 1;
            if (cropWidth < 6 || cropHeight < 6) {
              done(null);
              return;
            }

            const crop = document.createElement('canvas');
            crop.width = cropWidth;
            crop.height = cropHeight;
            crop.getContext('2d').drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

            done({
              index,
              width: cropWidth,
              height: cropHeight,
              originalWidth: width,
              originalHeight: height,
              label: candidate.label,
              source: candidate.source,
              dataUrl: crop.toDataURL('image/png')
            });
          } catch {
            done(null);
          }
        };
        img.src = candidate.src;
      });
    }

    const rendered = await Promise.all(candidates.map(renderCandidate));
    return rendered.filter(Boolean);
  });

  const unique = new Map();
  for (const item of extracted) {
    if (!unique.has(item.dataUrl)) unique.set(item.dataUrl, item);
  }

  return [...unique.values()].map((item, index) => {
    const file = `resource-${String(index + 1).padStart(3, '0')}-${item.width}x${item.height}.png`;
    const fullPath = path.join(resourceRunDir, file);
    const base64 = item.dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(fullPath, Buffer.from(base64, 'base64'));
    return {
      file,
      width: item.width,
      height: item.height,
      originalWidth: item.originalWidth,
      originalHeight: item.originalHeight,
      label: item.label,
      source: item.source
    };
  });
}

function createCalibrationServer(sourcePath, resources, resourceRunDir) {
  const screenshot = PNG.sync.read(fs.readFileSync(sourcePath));

  function cropPng({ x, y, width, height }) {
    const sx = Math.max(0, Math.floor(x));
    const sy = Math.max(0, Math.floor(y));
    const sw = Math.min(screenshot.width - sx, Math.max(1, Math.floor(width)));
    const sh = Math.min(screenshot.height - sy, Math.max(1, Math.floor(height)));
    const out = new PNG({ width: sw, height: sh });
    for (let row = 0; row < sh; row += 1) {
      for (let col = 0; col < sw; col += 1) {
        const src = ((sy + row) * screenshot.width + (sx + col)) << 2;
        const dst = (row * sw + col) << 2;
        screenshot.data.copy(out.data, dst, src, src + 4);
      }
    }
    return out;
  }

  return http.createServer((req, res) => {
    if (req.url === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(calibrationHtml(resources));
      return;
    }
    if (req.url?.startsWith('/resource/')) {
      const file = path.basename(decodeURIComponent(req.url.slice('/resource/'.length)));
      const fullPath = path.join(resourceRunDir, file);
      if (!fs.existsSync(fullPath)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': 'image/png' });
      fs.createReadStream(fullPath).pipe(res);
      return;
    }
    if (req.url === '/screenshot.png') {
      res.writeHead(200, { 'content-type': 'image/png' });
      fs.createReadStream(sourcePath).pipe(res);
      return;
    }
    if (req.url === '/choose' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10000) req.destroy();
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const mode = payload.mode === 'avoid' ? 'avoid' : 'rock';
          const file = path.basename(String(payload.file || ''));
          const src = path.join(resourceRunDir, file);
          if (!fs.existsSync(src)) {
            throw new Error('Resource file not found.');
          }
          const dir = mode === 'avoid' ? avoidDir : rockDir;
          const dst = path.join(dir, `${mode}-${stamp()}-${file}`);
          fs.copyFileSync(src, dst);
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, path: dst, mode }));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(error.message ?? error) }));
        }
      });
      return;
    }
    if (req.url === '/crop' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > 10000) req.destroy();
      });
      req.on('end', () => {
        try {
          const payload = JSON.parse(body);
          const out = cropPng(payload);
          const dir = payload.mode === 'avoid' ? avoidDir : rockDir;
          const file = `${payload.mode}-${stamp()}.png`;
          const fullPath = path.join(dir, file);
          fs.writeFileSync(fullPath, PNG.sync.write(out));
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: true, path: fullPath }));
        } catch (error) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, error: String(error.message ?? error) }));
        }
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
}

function calibrationHtml(resources) {
  const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const resourceCards = resources.length > 0
    ? resources.map((resource) => `<article class="resource" data-file="${escapeHtml(resource.file)}">
        <div class="thumb"><img src="/resource/${encodeURIComponent(resource.file)}" alt=""></div>
        <div class="meta">${escapeHtml(resource.file)}<br>${resource.width}x${resource.height} / ${escapeHtml(resource.source)}</div>
        <div class="actions">
          <button data-mode="rock" data-file="${escapeHtml(resource.file)}">Rock</button>
          <button data-mode="avoid" data-file="${escapeHtml(resource.file)}">Avoid</button>
        </div>
      </article>`).join('')
    : '<p class="empty">No image resources were extracted. Go back to the game screen and run prepare again after the objects are visible.</p>';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rocket Template Calibration</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #101114; color: #f5f5f5; }
    header { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: #1b1d22; border-bottom: 1px solid #343842; }
    button { border: 1px solid #4d5563; background: #272b33; color: #fff; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button:hover { background: #343a46; }
    button.active, button[data-mode="rock"] { background: #1f7a3a; border-color: #35e06f; }
    button[data-mode="avoid"] { background: #8a2730; border-color: #ff6873; }
    main { padding: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 10px; align-items: stretch; }
    .resource { border: 1px solid #2f3540; background: #181b20; border-radius: 8px; padding: 8px; }
    .resource[data-saved="rock"] { border-color: #35e06f; box-shadow: 0 0 0 1px #35e06f inset; }
    .resource[data-saved="avoid"] { border-color: #ff6873; box-shadow: 0 0 0 1px #ff6873 inset; }
    .thumb { height: 96px; display: grid; place-items: center; background: #0c0d10; border-radius: 6px; overflow: hidden; }
    .thumb img { max-width: 100%; max-height: 88px; image-rendering: pixelated; }
    .meta { min-height: 36px; margin: 8px 0; color: #b9c0ce; font-size: 11px; line-height: 1.35; overflow-wrap: anywhere; }
    .actions { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    #status { margin-left: 8px; color: #b9c0ce; }
    .empty { color: #ffcf70; }
    details { margin-top: 18px; }
    summary { cursor: pointer; color: #b9c0ce; }
    #wrap { position: relative; width: fit-content; margin-top: 10px; }
    #shot { display: block; image-rendering: auto; }
    #box { position: absolute; display: none; border: 2px solid #35e06f; background: rgb(53 224 111 / 18%); pointer-events: none; }
  </style>
</head>
<body>
  <header>
    <strong>Choose Loaded Resources</strong>
    <span>Use Rock for stones. Use Avoid for skulls.</span>
    <span id="status"></span>
  </header>
  <main>
    <section class="grid">
      ${resourceCards}
    </section>
    <details>
      <summary>Manual crop fallback</summary>
      <div style="margin: 10px 0; display: flex; gap: 8px; align-items: center;">
        <button id="rock" class="active">Save Rock</button>
        <button id="avoid">Save Avoid</button>
        <span>Drag only if the resource list misses the object.</span>
      </div>
      <div id="wrap">
        <img id="shot" src="/screenshot.png" />
        <div id="box"></div>
      </div>
    </details>
  </main>
  <script>
    const statusEl = document.getElementById('status');
    document.addEventListener('click', async (evt) => {
      const button = evt.target.closest('button[data-file][data-mode]');
      if (!button) return;
      button.disabled = true;
      const payload = { file: button.dataset.file, mode: button.dataset.mode };
      const res = await fetch('/choose', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      button.disabled = false;
      statusEl.textContent = json.ok ? 'Saved ' + json.mode + ': ' + json.path : json.error;
      if (json.ok) {
        document.querySelector('.resource[data-file="' + CSS.escape(payload.file) + '"]')?.setAttribute('data-saved', json.mode);
      }
    });

    const shot = document.getElementById('shot');
    const box = document.getElementById('box');
    const rock = document.getElementById('rock');
    const avoid = document.getElementById('avoid');
    let mode = 'rock';
    let start = null;

    function setMode(next) {
      mode = next;
      rock.classList.toggle('active', mode === 'rock');
      avoid.classList.toggle('active', mode === 'avoid');
      box.style.borderColor = mode === 'rock' ? '#35e06f' : '#ff4d57';
    }
    rock.onclick = () => setMode('rock');
    avoid.onclick = () => setMode('avoid');

    function point(evt) {
      const r = shot.getBoundingClientRect();
      return {
        x: (evt.clientX - r.left) * (shot.naturalWidth / r.width),
        y: (evt.clientY - r.top) * (shot.naturalHeight / r.height),
        cssX: evt.clientX - r.left,
        cssY: evt.clientY - r.top
      };
    }

    shot.addEventListener('pointerdown', (evt) => {
      start = point(evt);
      box.style.display = 'block';
      box.style.left = start.cssX + 'px';
      box.style.top = start.cssY + 'px';
      box.style.width = '1px';
      box.style.height = '1px';
    });

    shot.addEventListener('pointermove', (evt) => {
      if (!start) return;
      const p = point(evt);
      const left = Math.min(start.cssX, p.cssX);
      const top = Math.min(start.cssY, p.cssY);
      box.style.left = left + 'px';
      box.style.top = top + 'px';
      box.style.width = Math.abs(p.cssX - start.cssX) + 'px';
      box.style.height = Math.abs(p.cssY - start.cssY) + 'px';
    });

    shot.addEventListener('pointerup', async (evt) => {
      if (!start) return;
      const end = point(evt);
      const payload = {
        mode,
        x: Math.min(start.x, end.x),
        y: Math.min(start.y, end.y),
        width: Math.abs(end.x - start.x),
        height: Math.abs(end.y - start.y)
      };
      start = null;
      if (payload.width < 8 || payload.height < 8) {
        statusEl.textContent = 'Selection too small.';
        return;
      }
      const res = await fetch('/crop', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json();
      statusEl.textContent = json.ok ? 'Saved: ' + json.path : json.error;
    });
  </script>
</body>
</html>`;
}
