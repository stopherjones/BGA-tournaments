/**
 * BGA Tournament Tracker – scrape.js
 *
 * Scrapes each BGA tournament page, detects status changes, and sends
 * email notifications. Runs via GitHub Actions on a schedule.
 *
 * Required GitHub Secrets:
 *   NOTIFY_EMAIL     – address to receive alerts
 *   SMTP_HOST        – e.g. smtp.gmail.com
 *   SMTP_PORT        – e.g. 587
 *   SMTP_USER        – your Gmail address
 *   SMTP_PASS        – your Gmail App Password (not your login password!)
 *
 * To generate a Gmail App Password:
 *   https://myaccount.google.com/apppasswords
 */

const { chromium } = require('playwright');
const nodemailer   = require('nodemailer');
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

// ── Manual overrides ──────────────────────────────────────────────────────────
// With the seed list cleaned up (only "normal" tournaments), we use the default
// mapping from the BGA page:
// - `title`     = tournament/event name (large header)
// - `game_name` = game name  (smaller subheader)

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  mergeSeedsIntoData(data);
  const changes = [];

  const browser = await chromium.launch({ headless: true });
  console.log('Browser launched');

  for (const tournament of data.tournaments) {
    const displayName = tournament.game_name || tournament.title || tournament.label || `Tournament ${tournament.id}`;
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

  if (changes.length > 0 && process.env.SMTP_HOST) {
    await sendNotifications(changes, data.config.notify_email);
  } else if (changes.length > 0) {
    console.log('\nℹ️  Changes detected but SMTP not configured – skipping email.');
  } else {
    console.log('\nNo status changes detected.');
  }
})();

function mergeSeedsIntoData(data) {
  const seeds = loadSeeds();
  if (!seeds || seeds.length === 0) return;

  if (!data || typeof data !== 'object') throw new Error('Invalid tournaments.json');
  if (!Array.isArray(data.tournaments)) data.tournaments = [];

  // If seeds exist, treat them as the source of truth for what we track.
  // Remove any tournaments from tournaments.json that are not present in seeds.
  const seedIds = new Set(seeds.map(s => String(s.id)));
  data.tournaments = data.tournaments.filter(t => seedIds.has(String(t.id)));

  const byId = new Map(data.tournaments.map(t => [String(t.id), t]));

  for (const seed of seeds) {
    const id = String(seed.id);
    const url = seed.url || `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}`;
    const existing = byId.get(id);

    if (!existing) {
      const t = {
        id,
        url,
        last_status: null,
        last_checked: null,
        status: null,
        participants: [],
      };
      data.tournaments.push(t);
      byId.set(id, t);
      continue;
    }

    // Backfill / sync fields without clobbering cached scrape state
    if (!existing.url) existing.url = url;
  }
}

function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) return null;
  const raw = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw?.tournaments;
  if (!Array.isArray(list)) return null;

  const seeds = [];
  for (const item of list) {
    if (typeof item === 'string') {
      const parsed = parseIdOrUrl(item);
      if (parsed) seeds.push(parsed);
      continue;
    }
    if (item && typeof item === 'object') {
      const parsed = parseIdOrUrl(item.url || item.id);
      if (!parsed) continue;
      seeds.push({
        ...parsed,
      });
    }
  }

  // Dedupe by id (preserve first label encountered)
  const byId = new Map();
  for (const s of seeds) {
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  return [...byId.values()];
}

function parseIdOrUrl(input) {
  const str = String(input || '').trim();
  if (!str) return null;

  // ID only
  if (/^\d+$/.test(str)) {
    return { id: str, url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(str)}` };
  }

  // URL (try to extract ?id=123)
  try {
    const u = new URL(str);
    const id = u.searchParams.get('id');
    if (id && /^\d+$/.test(id)) {
      return { id, url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}` };
    }
  } catch {
    // ignore
  }

  // Fallback: look for id=123 anywhere
  const m = str.match(/(?:\?|&)id=(\d+)/);
  if (m) {
    const id = m[1];
    return { id, url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}` };
  }

  return null;
}

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrapeTournament(browser, url) {
  const page = await browser.newPage();

  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort());
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    const text    = el => (el ? el.textContent.trim() : '');
    const find    = sel => document.querySelector(sel);
    const findAll = sel => [...document.querySelectorAll(sel)];

    // ── Title ─────────────────────────────────────────────────────────────────
    // BGA uses a large span for the tournament name, e.g.:
    //   <span class="text-xl tablet:text-2xl leading-none truncate">TBA Around the World</span>
    const titleEl = find('span.text-xl') || find('span[class*="text-xl"]');
    const title   = text(titleEl);

    // ── Game name ─────────────────────────────────────────────────────────────
    // Sits in a smaller sibling span, e.g.:
    //   <span class="text-sm tablet:text-base leading-none truncate">Go Goa</span>
    const gameEl =
      find('span.text-sm[class*="truncate"]') ||
      find('span[class*="text-sm"][class*="truncate"]') ||
      find('.game_name') ||
      find('a[href*="/gamepanel"]');
    const game_name = text(gameEl);

    // ── Status ────────────────────────────────────────────────────────────────
    const bodyText = document.body.innerText.toLowerCase();
    let status = 'unknown';
    // "Open" with a registration window → planned
    if (/\bopen\b/.test(bodyText) && /\bstarts\b/.test(bodyText)) {
      status = 'planned';
    } else if (/\bin progress\b|\bongoing\b|\bround \d/.test(bodyText)) {
      status = 'in_progress';
    } else if (/\bfinished\b|\bcompleted\b|\bfinal ranking\b|\bwinner\b/.test(bodyText)) {
      status = 'finished';
    } else if (/\bregistration\b|\bnot started\b|\bupcoming\b/.test(bodyText)) {
      status = 'planned';
    }

    // ── Participants ──────────────────────────────────────────────────────────
    // BGA renders every player name as: <span class="... playername ...">username</span>
    // Consistent across planned, in-progress, and finished tournaments.
    //
    // For finished tournaments, rank is stored in data-rank-start on the
    // container div, e.g.: <div data-rank-start="1">...<span class="playername">VemRD</span>
    // Multiple players in the same container share that rank (tied places).
    const participants = [];
    const seen = new Set();

    // Strategy A: rank containers (finished tournaments)
    const rankContainers = findAll('[data-rank-start]');
    if (rankContainers.length > 0) {
      rankContainers.forEach(container => {
        const rank = parseInt(container.getAttribute('data-rank-start'), 10);
        container.querySelectorAll('span.playername').forEach(el => {
          const name = el.textContent.trim();
          if (!name || seen.has(name)) return;
          seen.add(name);
          const isEliminated = el.className.includes('line-through');
          participants.push({ rank, name, active: !isEliminated });
        });
      });
    }

    // Strategy B: no rank containers (planned / in-progress) — just list players
    if (participants.length === 0) {
      findAll('span.playername').forEach(el => {
        const name = el.textContent.trim();
        if (!name || seen.has(name)) return;
        seen.add(name);
        const isEliminated = el.className.includes('line-through');
        participants.push({ rank: null, name, active: !isEliminated });
      });
    }

    return { title, game_name, status, participants };
  });

  await page.close();
  return result;
}

// ── Email ─────────────────────────────────────────────────────────────────────
async function sendNotifications(changes, toEmail) {
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const subject =
    changes.length === 1
      ? `BGA Tournament Update: "${changes[0].tournament.label}" is now ${STATUS_LABEL[changes[0].to]}`
      : `BGA Tournament Updates: ${changes.length} tournaments changed status`;

  const htmlBody = changes.map(({ tournament, from, to }) => {
    const fromLabel = from ? STATUS_LABEL[from] : '(first check)';
    const toLabel   = STATUS_LABEL[to];

    let rankingHtml = '';
    if (to === 'finished' && tournament.participants.length > 0) {
      const rows = tournament.participants
        .slice(0, 20)
        .map(p => `<tr><td style="padding:4px 12px;">${p.rank ?? '–'}</td><td style="padding:4px 12px;">${p.name}</td></tr>`)
        .join('');
      rankingHtml = `
        <h3 style="margin-top:16px;">Final Rankings</h3>
        <table border="1" cellspacing="0" cellpadding="0" style="border-collapse:collapse;font-size:14px;">
          <tr style="background:#eee"><th style="padding:4px 12px;">#</th><th style="padding:4px 12px;">Player</th></tr>
          ${rows}
        </table>`;
    }

    return `
      <div style="margin-bottom:32px;padding:16px;border:1px solid #ddd;border-radius:8px;">
        <h2 style="margin:0 0 8px;">${tournament.label}</h2>
        ${tournament.game_name ? `<p style="margin:0 0 8px;color:#666;">${tournament.game_name}</p>` : ''}
        <p><strong>Status:</strong> ${fromLabel} → <strong>${toLabel}</strong></p>
        <p><a href="${tournament.url}">${tournament.url}</a></p>
        ${rankingHtml}
      </div>`;
  }).join('');

  const html = `
    <html><body style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:16px;">
      <h1 style="color:#2a5;border-bottom:2px solid #2a5;padding-bottom:8px;">
        🎲 BGA Tournament Tracker
      </h1>
      ${htmlBody}
      <p style="color:#999;font-size:12px;margin-top:32px;">
        Checked: ${new Date().toUTCString()}
      </p>
    </body></html>`;

  await transporter.sendMail({
    from:    `"BGA Tracker" <${process.env.SMTP_USER}>`,
    to:      toEmail || process.env.NOTIFY_EMAIL,
    subject,
    html,
  });

  console.log(`\n✉️  Email sent to ${toEmail || process.env.NOTIFY_EMAIL}`);
}