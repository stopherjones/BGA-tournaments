/**
 * BGA Tournament Tracker – scrape.js
 */

require('dotenv').config();
const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');
const nodemailer   = require('nodemailer');

// ── Paths ─────────────────────────────────────────────────────────────────────
const DATA_FILE  = path.join(__dirname, '../data/tournaments.json');
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
  const changes    = [];
  const notifyEmail = process.env.NOTIFY_EMAIL || data.config.notify_email;

  // Track newly added tournaments (those without a last_checked timestamp)
  const newTournaments = data.tournaments
    .filter(t => !t.last_checked)
    .map(t => t.id);

  // Setup email transporter (configure SMTP settings via environment variables)
  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'smtp.example.com',
    port:   parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  const browser = await chromium.launch({ headless: true });
  console.log('Browser launched');

  for (const tournament of data.tournaments) {
    const displayName = tournament.game_name || tournament.title || `Tournament ${tournament.id}`;
    console.log(`\n── Checking: ${displayName} (id ${tournament.id})`);
    try {
      const result     = await scrapeTournament(browser, tournament.url);
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

      // Check if this is a newly added tournament
      if (newTournaments.includes(tournament.id)) {
        changes.push({ tournament, isNew: true, status: result.status });
        console.log(`  ✨ New tournament added: ${result.status}`);
      }
    } catch (err) {
      console.error(`  ✗ Error scraping ${tournament.url}:`, err.message);
    }
  }

  await browser.close();

  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log('\n✓ data/tournaments.json updated');

  if (changes.length > 0) {
    console.log(`\n📢  Detected ${changes.length} updates (status changes + new tournaments).`);
    await sendStatusChangeEmails(changes, notifyEmail, transporter);
  } else {
    console.log('\nNo status changes or new tournaments detected.');
  }
})();

// ── Email helpers ─────────────────────────────────────────────────────────────

async function sendStatusChangeEmails(changes, notifyEmail, transporter) {
  for (const change of changes) {
    const { tournament, from, to, isNew, status } = change;
    const title = tournament.title || tournament.game_name || `Tournament ${tournament.id}`;

    if (isNew) {
      const gameInfo    = tournament.game_name ? `Game: ${tournament.game_name}\n` : '';
      const statusInfo  = `Status: ${status}\n`;
      const playerCount = tournament.participants.length > 0
        ? `Participants: ${tournament.participants.length}\n` : '';
      const subject = `New Tournament Added: ${title}`;
      const text    = `A new tournament has been added to your tracking list!\n\n${gameInfo}${statusInfo}${playerCount}\nURL: ${tournament.url}`;
      await sendEmail(transporter, notifyEmail, subject, text);

    } else if (from === 'planned' && to === 'in_progress') {
      const subject = `Tournament Started: ${title}`;
      const text    = `The tournament "${title}" has started (changed from ${from} to ${to}).\n\nURL: ${tournament.url}`;
      await sendEmail(transporter, notifyEmail, subject, text);

    } else if (from === 'in_progress' && to === 'finished') {
      const subject          = `Tournament Finished: ${title}`;
      const participantsText = tournament.participants
        .filter(p => p.rank !== null)
        .sort((a, b) => a.rank - b.rank)
        .map(p => `${p.rank}: ${p.name}`)
        .join('\n');
      const text = `The tournament "${title}" has finished (changed from ${from} to ${to}).\n\nFinal Rankings:\n${participantsText}\n\nURL: ${tournament.url}`;
      await sendEmail(transporter, notifyEmail, subject, text);
    }
  }
}

async function sendEmail(transporter, to, subject, text) {
  try {
    await transporter.sendMail({
      from: transporter.options.auth.user,
      to,
      subject,
      text,
    });
    console.log(`📧 Email sent: ${subject}`);
  } catch (error) {
    console.error(`❌ Failed to send email: ${error.message}`);
  }
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

function mergeSeedsIntoData(data) {
  const seeds = loadSeeds();
  if (!seeds || seeds.length === 0) return;

  if (!data || typeof data !== 'object') throw new Error('Invalid tournaments.json');
  if (!Array.isArray(data.tournaments)) data.tournaments = [];

  const byId = new Map(data.tournaments.map(t => [String(t.id), t]));

  for (const seed of seeds) {
    const id  = String(seed.id);
    const url = seed.url || `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}`;
    const existing = byId.get(id);

    if (!existing) {
      const t = { id, url, last_status: null, status: null, participants: [] };
      data.tournaments.push(t);
      byId.set(id, t);
    } else if (!existing.url) {
      existing.url = url;
    }
  }
}

function loadSeeds() {
  if (!fs.existsSync(SEEDS_FILE)) return null;
  const raw  = JSON.parse(fs.readFileSync(SEEDS_FILE, 'utf8'));
  const list = Array.isArray(raw) ? raw : raw?.tournaments;
  if (!Array.isArray(list)) return null;

  const seeds = [];
  for (const item of list) {
    const str    = typeof item === 'string' ? item : item.url || item.id;
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
    const u  = new URL(str);
    const id = u.searchParams.get('id');
    if (id && /^\d+$/.test(id))
      return { id, url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(id)}` };
  } catch {}
  const m = str.match(/(?:\?|&)id=(\d+)/);
  if (m) return { id: m[1], url: `https://boardgamearena.com/tournament?id=${encodeURIComponent(m[1])}` };
  return null;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

async function scrapeTournament(browser, url) {
  const page = await browser.newPage();
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort());
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(3000);

  const result = await page.evaluate((currentUrl) => {
    const text    = el => (el ? el.textContent.trim() : '');
    const find    = sel => document.querySelector(sel);
    const findAll = sel => [...document.querySelectorAll(sel)];

    // ── Title / game name ────────────────────────────────────────────────────
    const swapIds   = ['545598', '554870', '554868', '538858', '538885', '538888'];
    const needsSwap = swapIds.some(id => currentUrl.includes(`id=${id}`));

    const smallText = text(find('span.text-sm.truncate') || find('span[class*="text-sm"]'));
    const largeText = text(find('span.text-xl.truncate') || find('span[class*="text-xl"]'));

    let title, game_name;
    if (needsSwap) {
      title = largeText; game_name = smallText;
    } else {
      title = smallText; game_name = largeText;
    }

    // ── Status ───────────────────────────────────────────────────────────────
    let status = 'unknown';

    const finishedSpan = find('span.text-xl.text-center.leading-tight.line-clamp-2') || find('span.line-clamp-2');
    const finishedText = text(finishedSpan).toLowerCase();

    const progressDiv  = find('div.text-xl.svelte-1yitbuo') || find('div.text-xl');
    const progressText = text(progressDiv).toLowerCase();

    if (finishedText.includes('finished')) {
      status = 'finished';
    } else if (progressText.includes('started')) {
      status = 'in_progress';
    } else if (progressText.includes('starts')) {
      status = 'planned';
    }

    // ── Participants ─────────────────────────────────────────────────────────
    //
    // Normalize a player name: replaces invisible/non-standard Unicode
    // whitespace that a plain .trim() would leave behind, then collapses any
    // remaining whitespace runs to a single space.
    const normalizeName = str =>
      str
        .replace(/[\u00A0\u200B\u200C\u200D\uFEFF]/g, ' ') // common invisible chars
        .replace(/\s+/g, ' ')
        .trim();

    const participants = [];
    const seen         = new Set();

    // ── Pass 1: ranked containers ────────────────────────────────────────────
    // Players inside [data-rank-start] elements carry explicit position info.
    const rankContainers = findAll('[data-rank-start]');
    if (rankContainers.length > 0) {
      let lastAssignedRank = 0;
      let lastGroupSize    = 0;

      rankContainers.forEach(container => {
        let rawRank = parseInt(container.getAttribute('data-rank-start'), 10);
        if (isNaN(rawRank)) rawRank = 0;

        const scopedPlayers = [...container.querySelectorAll('span.playername')]
          .map(el => ({ el, name: normalizeName(el.textContent) }))
          .filter(p => p.name && !seen.has(p.name));

        const groupSize = scopedPlayers.length;

        let effectiveRank;
        if (rawRank > 0) {
          effectiveRank = rawRank;
        } else {
          effectiveRank = lastAssignedRank === 0 ? 1 : lastAssignedRank + lastGroupSize;
        }

        scopedPlayers.forEach(({ el, name }) => {
          seen.add(name);
          participants.push({
            rank:   effectiveRank,
            name,
            active: !el.className.includes('line-through'),
          });
        });

        if (groupSize > 0) {
          lastAssignedRank = effectiveRank;
          lastGroupSize    = groupSize;
        }
      });
    }

    // ── Pass 2: global sweep ─────────────────────────────────────────────────
    // Runs UNCONDITIONALLY — not just when Pass 1 found nothing.
    //
    // The original code only ran the fallback when participants.length === 0,
    // meaning any player whose <span class="playername"> sat outside every
    // [data-rank-start] container (e.g. Cheery Dog) was silently dropped the
    // moment at least one ranked player was found.
    //
    // Running both passes and deduplicating via `seen` ensures every
    // span.playername on the page is captured regardless of DOM position.
    findAll('span.playername').forEach(el => {
      const name = normalizeName(el.textContent);
      if (!name || seen.has(name)) return;
      seen.add(name);
      // rank is null because we have no container-level rank data for them
      participants.push({
        rank:   null,
        name,
        active: !el.className.includes('line-through'),
      });
    });

    return { title, game_name, status, participants };
  }, url);

  await page.close();
  return result;
}