/**
 * BGA Tournament Tracker – scrape.js
 */

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_FILE = path.join(__dirname, '../data/tournaments.json');
const SEEDS_FILE = path.join(__dirname, '../data/seeds.json');

// ── Status constants ──────────────────────────────────────────────────────────
const STATUS_LABEL = {
  planned:     '📅 Planned',
  in_progress: '▶️ In Progress',
  finished:    '🏆 Finished',
  unknown:     '❓ Unknown',
};

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  mergeSeedsIntoData(data);
  const changes = [];

  const browser = await chromium.launch({ headless: true });
  console.log('Browser launched');

  for (const tournament of data.tournaments) {
    const displayName = tournament.game_name || tournament.title || `Tournament ${tournament.id}`;
    console.log(`\n── Checking: ${displayName} (id ${tournament.id})`);
    try {
      const result = await scrapeTournament(browser, tournament.url);
      const prevStatus = tournament.status;

      tournament.status       = result.status;
      tournament.participants = result.participants;
      tournament.game_name    = result.game_name || tournament.game_name;
      tournament.title        = result.title     || tournament.title;
      tournament.last_checked = new Date().toISOString();

      console.log(`  Status: ${result.status} | Players: ${result.participants.length}`);

      if (prevStatus !== result.status) {
        tournament.last_status = prevStatus;
        changes.push({ tournament, from: prevStatus, to: result.status });
        console.log(`  ⚡ Status changed: ${prevStatus} → ${result.status}`);
      }
    } catch (err) {
      console.error(`  ✗ Error scraping ${tournament.url}:`, err.message);
    }
  }

  await browser.close();

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log('\n✓ data/tournaments.json updated');

  // Logic for changes (console logging instead of email)
  if (changes.length > 0) {
    console.log(`\n📢  Detected ${changes.length} status changes.`);
  } else {
    console.log('\nNo status changes detected.');
  }
})();

function mergeSeedsIntoData(data) {
  const seeds = loadSeeds();
  if (!seeds || seeds.length === 0) return;

  if (!data || typeof data !== 'object') throw new Error('Invalid tournaments.json');
  if (!Array.isArray(data.tournaments)) data.tournaments = [];

  const byId = new Map(data.tournaments.map(t => [String(t.id), t]));

  for (const seed of seeds) {
    const id = String(seed.id);
    const url = seed.url || `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}`;
    const existing = byId.get(id);

    if (!existing) {
      const t = { id, url, last_status: null, last_checked: null, status: null, participants: [] };
      data.tournaments.push(t);
      byId.set(id, t);
    } else if (!existing.url) {
      existing.url = url;
    }
  }
}

function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) return null;
  const raw = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw?.tournaments;
  if (!Array.isArray(list)) return null;

  const seeds = [];
  for (const item of list) {
    const str = typeof item === 'string' ? item : item.url || item.id;
    const parsed = parseIdOrUrl(str);
    if (parsed) seeds.push(parsed);
  }

  const byId = new Map();
  for (const s of seeds) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  return [...byId.values()];
}

function parseIdOrUrl(input) {
  const str = String(input || '').trim();
  if (!str) return null;
  if (/^\d+$/.test(str)) {
    return { id: str, url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(str)}` };
  }
  try {
    const u = new URL(str);
    const id = u.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return { id, url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}` };
  } catch {}
  const m = str.match(/(?:\?|&)id=(\d+)/);
  if (m) return { id: m[1], url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(m[1])}` };
  return null;
}

async function scrapeTournament(browser, url) {
  const page = await browser.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort());
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate((currentUrl) => {
    const text    = el => (el ? el.textContent.trim() : '');
    const find    = sel => document.querySelector(sel);
    const findAll = sel => [...document.querySelectorAll(sel)];

    const swapIds = ["554870", "554868", "538858", "538885", "538888"];
    const needsSwap = swapIds.some(id => currentUrl.includes(`id=${id}`));

    const smallText = text(find('span.text-sm.truncate') || find('span[class*="text-sm"]'));
    const largeText = text(find('span.text-xl.truncate') || find('span[class*="text-xl"]'));

    let title, game_name;
    if (needsSwap) {
      title = largeText; game_name = smallText;
    } else {
      title = smallText; game_name = largeText;
    }

    const bodyText = document.body.innerText.toLowerCase();
    let status = 'unknown';
    if (/\bopen\b/.test(bodyText) && /\bstarts\b/.test(bodyText)) status = 'planned';
    else if (/\bin progress\b|\bongoing\b|\bround \d/.test(bodyText)) status = 'in_progress';
    else if (/\bfinished\b|\bcompleted\b|\bfinal ranking\b|\bwinner\b/.test(bodyText)) status = 'finished';
    else if (/\bregistration\b|\bnot started\b|\bupcoming\b/.test(bodyText)) status = 'planned';

    const participants = [];
    const seen = new Set();
    const rankContainers = findAll('[data-rank-start]');
    if (rankContainers.length > 0) {
      rankContainers.forEach(container => {
        const rank = parseInt(container.getAttribute('data-rank-start'), 10);
        container.querySelectorAll('span.playername').forEach(el => {
          const name = el.textContent.trim();
          if (!name || seen.has(name)) return;
          seen.add(name);
          participants.push({ rank, name, active: !el.className.includes('line-through') });
        });
      });
    }
    if (participants.length === 0) {
      findAll('span.playername').forEach(el => {
        const name = el.textContent.trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        participants.push({ rank: null, name, active: !el.className.includes('line-through') });
      });
    }

    return { title, game_name, status, participants };
  }, url);

  await page.close();
  return result;
}