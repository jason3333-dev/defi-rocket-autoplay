import fs from 'node:fs';
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { PNG } from 'pngjs';
import { ensureDir, latestPng, parseArgs, projectRoot, stamp } from './common.js';

const args = parseArgs();
const capturesDir = path.join(projectRoot, 'captures');
const sourcePath = path.resolve(String(args.from ?? latestPng(capturesDir) ?? ''));
if (!sourcePath || !fs.existsSync(sourcePath)) {
  throw new Error('No screenshot found. Run `npm run inspect` first, or pass `--from path\\to\\screenshot.png`.');
}

const rockDir = path.join(projectRoot, 'templates', 'rocks');
const avoidDir = path.join(projectRoot, 'templates', 'avoid');
ensureDir(rockDir);
ensureDir(avoidDir);

const screenshot = PNG.sync.read(fs.readFileSync(sourcePath));
const port = Number(args.port ?? 8792);
const shouldOpen = args.open !== false;

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

function html() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rocket Template Calibration</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; background: #101114; color: #f5f5f5; }
    header { position: sticky; top: 0; z-index: 2; display: flex; gap: 8px; align-items: center; padding: 10px 12px; background: #1b1d22; border-bottom: 1px solid #343842; }
    button { border: 1px solid #4d5563; background: #272b33; color: #fff; border-radius: 6px; padding: 8px 10px; cursor: pointer; }
    button.active { background: #3563ff; border-color: #7893ff; }
    #status { margin-left: 8px; color: #b9c0ce; }
    #wrap { position: relative; width: fit-content; }
    #shot { display: block; image-rendering: auto; }
    #box { position: absolute; display: none; border: 2px solid #35e06f; background: rgb(53 224 111 / 18%); pointer-events: none; }
  </style>
</head>
<body>
  <header>
    <button id="rock" class="active">Save Rock</button>
    <button id="avoid">Save Avoid</button>
    <span>Drag tightly around one object, then release.</span>
    <span id="status"></span>
  </header>
  <div id="wrap">
    <img id="shot" src="/screenshot.png" />
    <div id="box"></div>
  </div>
  <script>
    const shot = document.getElementById('shot');
    const box = document.getElementById('box');
    const statusEl = document.getElementById('status');
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

const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html());
    return;
  }
  if (req.url === '/screenshot.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    fs.createReadStream(sourcePath).pipe(res);
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

server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`;
  console.log(`Screenshot: ${sourcePath}`);
  console.log(`Calibration: ${url}`);
  if (shouldOpen) {
    openUrl(url);
  }
});

function openUrl(url) {
  try {
    const child = spawn('cmd.exe', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore'
    });
    child.unref();
  } catch (error) {
    console.log(`Could not open browser automatically: ${error.message}`);
  }
}
