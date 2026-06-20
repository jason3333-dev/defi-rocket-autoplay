import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

export function asNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export function browserPath(prefer = 'chrome') {
  const normalized = String(prefer || 'chrome').toLowerCase();
  const chromeCandidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
  ].filter(Boolean);
  const edgeCandidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  const candidates = normalized.includes('edge')
    ? [...edgeCandidates, ...chromeCandidates]
    : [...chromeCandidates, ...edgeCandidates];

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error('Chrome/Edge executable not found. Set CHROME_PATH or EDGE_PATH to the browser executable.');
  }
  return found;
}

export function browserLaunchOptions({ disableExtensions = false, profileDirectory = '' } = {}) {
  const launchOptions = {
    args: ['--disable-blink-features=AutomationControlled']
  };
  if (profileDirectory) {
    launchOptions.args.push(`--profile-directory=${profileDirectory}`);
  }
  if (disableExtensions) {
    launchOptions.args.push('--disable-extensions');
  } else {
    launchOptions.ignoreDefaultArgs = [
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages'
    ];
  }
  return launchOptions;
}

export async function openBrowserPage(chromium, {
  args,
  browserName,
  url,
  profileDir,
  profileDirectory = 'Default',
  viewport = { width: 1280, height: 900 },
  deviceScaleFactor = 1
}) {
  if (!Boolean(args['persistent-context'])) {
    return openDebuggerBrowserPage(chromium, {
      args,
      browserName,
      url,
      profileDir,
      profileDirectory,
      viewport,
      deviceScaleFactor
    });
  }

  console.log(`Launching ${browserName} with profile ${profileDir} (${profileDirectory}).`);
  const context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath(browserName),
    headless: false,
    viewport,
    deviceScaleFactor,
    ...browserLaunchOptions({
      disableExtensions: Boolean(args['disable-extensions']),
      profileDirectory
    })
  });

  console.log('Browser context ready. Opening Rocket tab.');
  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
  console.log(`Opened ${url}`);
  return { browser: context, context, page, mode: 'persistent' };
}

async function openDebuggerBrowserPage(chromium, {
  args,
  browserName,
  url,
  profileDir,
  profileDirectory,
  viewport,
  deviceScaleFactor
}) {
  const cdpPort = asNumber(args['cdp-port'], 9222);
  const endpoint = `http://127.0.0.1:${cdpPort}`;
  let browser = await connectOverCdpIfReady(chromium, endpoint);
  let launched = false;

  if (browser) {
    console.log(`Connected to existing ${browserName} on CDP port ${cdpPort}.`);
  } else {
    console.log(`Launching debugger ${browserName} on CDP port ${cdpPort}.`);
    launchExternalBrowser({
      browserName,
      url,
      profileDir,
      cdpPort,
      profileDirectory,
      disableExtensions: Boolean(args['disable-extensions']),
      extensionDirs: extensionDirsForLaunch(args, browserName)
    });
    launched = true;
    await waitForCdp(endpoint, 30000);
    browser = await chromium.connectOverCDP(endpoint);
    console.log(`Connected to ${browserName} on CDP port ${cdpPort}.`);
  }

  const context = browser.contexts()[0] ?? await browser.newContext({ viewport, deviceScaleFactor });
  const page = pickBrowserPage(context, url) ?? (launched ? context.pages()[0] : null) ?? await context.newPage();
  if (page.url() !== url) {
    await page.goto(url, { waitUntil: 'commit', timeout: 45000 });
  }
  await page.bringToFront().catch(() => {});
  console.log(`Opened ${url}`);
  return { browser, context, page, mode: 'cdp' };
}

function launchExternalBrowser({ browserName, url, profileDir, cdpPort, profileDirectory, disableExtensions, extensionDirs }) {
  const launchArgs = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    `--profile-directory=${profileDirectory}`,
    '--no-first-run',
    '--new-window'
  ];
  if (disableExtensions) {
    launchArgs.push('--disable-extensions');
  } else if (extensionDirs.length > 0) {
    console.log(`Loading extension(s): ${extensionDirs.map((dir) => path.basename(path.dirname(dir))).join(', ')}`);
    launchArgs.push(`--load-extension=${extensionDirs.join(',')}`);
  }
  launchArgs.push(url);

  const child = spawn(browserPath(browserName), launchArgs, {
    detached: true,
    stdio: 'ignore'
  });
  child.unref();
}

function extensionDirsForLaunch(args, browserName) {
  if (Boolean(args['disable-extensions'])) return [];
  if (args['load-extension']) {
    return String(args['load-extension'])
      .split(/[;,]/)
      .map((item) => path.resolve(item.trim()))
      .filter(Boolean);
  }
  return [];
}

async function connectOverCdpIfReady(chromium, endpoint) {
  if (!(await cdpEndpointReady(endpoint))) return null;
  try {
    return await chromium.connectOverCDP(endpoint);
  } catch {
    return null;
  }
}

async function waitForCdp(endpoint, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await cdpEndpointReady(endpoint)) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Chrome remote debugging did not start. Stop Chrome using the same debugger profile, or rerun with a different --cdp-port.');
}

function pickBrowserPage(context, url) {
  return context.pages().find((page) => page.url() === url)
    ?? context.pages().find((page) => page.url().startsWith(url))
    ?? context.pages().find((page) => page.url() === 'about:blank')
    ?? null;
}

async function cdpEndpointReady(endpoint) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 750);
    const response = await fetch(`${endpoint}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

export function chromePath() {
  return browserPath('chrome');
}

export function latestPng(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.png'))
    .map((file) => path.join(dir, file))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] ?? null;
}
