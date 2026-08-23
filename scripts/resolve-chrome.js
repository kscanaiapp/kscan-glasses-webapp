// Resolve a Chromium / headless-shell executable for playwright-core.
// Order: KSCAN_CHROME_PATH → known local path → ms-playwright cache probe.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const WIN_LOCAL =
  'C:/Users/jsmit/AppData/Local/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-win64/chrome-headless-shell.exe';

function walk(dir, depth = 0) {
  if (depth > 4 || !existsSync(dir)) return [];
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...walk(full, depth + 1));
    else out.push(full);
  }
  return out;
}

export function resolveChromePath() {
  const fromEnv = process.env.KSCAN_CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (existsSync(WIN_LOCAL)) return WIN_LOCAL;

  const bases = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'AppData', 'Local', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright'),
    '/ms-playwright',
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
  ].filter(Boolean);

  const names = [
    'chrome-headless-shell.exe',
    'chrome-headless-shell',
    'chrome.exe',
    'chrome',
    'chromium',
  ];

  for (const base of bases) {
    const files = walk(base);
    for (const name of names) {
      const hit = files.find((f) => f.replace(/\\/g, '/').endsWith(`/${name}`)
        || f.endsWith(`\\${name}`));
      if (hit) return hit;
    }
  }
  return null;
}
