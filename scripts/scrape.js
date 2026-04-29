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

// ── Status constants ──────────────────────────────────────────────────────────
const STATUS = {
  PLANNED:     'planned',
  IN_PROGRESS: 'in_progress',
  FINISHED:    'finished',
  UNKNOWN:     'unknown',
};

// Human-readable labels for notifications
const STATUS_LABEL = {
  planned:     '📅 Planned',
  in_progress: '▶️ In Progress',
  finished:    '🏆 Finished',
  unknown:     '❓ Unknown',
};

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const changes = [];

  const browser = await chromium.launch({ headless: true });
  console.log('Browser launched');

  for (const tournament of data.tournaments) {
    console.log(`\n── Checking: ${tournament.label} (id ${tournament.id})`);
    try {
      const result = await scrapeTournament(browser, tournament.url);
      const prevStatus = tournament.status;

      tournament.status       = result.status;
      tournament.participants = result.participants;
      tournament.game_name    = result.game_name   || tournament.game_name;
      tournament.title        = result.title       || tournament.title;
      tournament.last_checked = new Date().toISOString();

      console.log(`  Status: ${result.status} | Players: ${result.participants.length}`);

      // Detect change (treat null → any status as a change on first run)
      if (prevStatus !== result.status) {
        tournament.last_status = prevStatus;
        changes.push({
          tournament,
          from: prevStatus,
          to:   result.status,
        });
        console.log(`  ⚡ Status changed: ${prevStatus} → ${result.status}`);
      }
    } catch (err) {
      console.error(`  ✗ Error scraping ${tournament.url}:`, err.message);
    }
  }

  await browser.close();

  // Persist updated state
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  console.log('\n✓ data/tournaments.json updated');

  // Send notifications for any changes
  if (changes.length > 0 && process.env.SMTP_HOST) {
    await sendNotifications(changes, data.config.notify_email);
  } else if (changes.length > 0) {
    console.log('\nℹ️  Changes detected but SMTP not configured – skipping email.');
  } else {
    console.log('\nNo status changes detected.');
  }
})();

// ── Scraper ───────────────────────────────────────────────────────────────────
async function scrapeTournament(browser, url) {
  const page = await browser.newPage();

  // Block images/fonts to speed things up
  await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,ttf}', r => r.abort());

  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  // BGA redirects to en.boardgamearena.com – wait for the JS app to boot
  // The main content div varies; we wait for the body to be stable.
  await page.waitForTimeout(3000);

  const result = await page.evaluate(() => {
    // ── Helpers ──────────────────────────────────────────────────────────────
    const text = el => (el ? el.textContent.trim() : '');
    const find = sel => document.querySelector(sel);
    const findAll = sel => [...document.querySelectorAll(sel)];

    // ── Tournament title ──────────────────────────────────────────────────────
    const titleEl =
      find('h1') ||
      find('#tournament_name') ||
      find('.tournament-name') ||
      find('[class*="tournament"][class*="name"]');
    const title = text(titleEl);

    // ── Game name ─────────────────────────────────────────────────────────────
    const gameEl =
      find('.game_name') ||
      find('#game_name') ||
      find('[class*="game-name"]') ||
      find('a[href*="/gamepanel"]');
    const game_name = text(gameEl);

    // ── Status detection ──────────────────────────────────────────────────────
    // Strategy 1: look for explicit status elements
    const statusEl =
      find('#tournament_status') ||
      find('.tournament_status') ||
      find('[class*="tournamentstatus"]') ||
      find('[id*="tournament_status"]') ||
      find('[class*="statuslabel"]');

    let rawStatus = text(statusEl).toLowerCase();

    // Strategy 2: scan the whole page text for status keywords
    if (!rawStatus) {
      const bodyText = document.body.innerText.toLowerCase();
      if (bodyText.includes('registration') || bodyText.includes('upcoming') ||
          bodyText.includes('not started') || bodyText.includes('open for')) {
        rawStatus = 'planned';
      } else if (bodyText.includes('in progress') || bodyText.includes('ongoing') ||
                 bodyText.includes('round ')) {
        rawStatus = 'in_progress';
      } else if (bodyText.includes('finished') || bodyText.includes('completed') ||
                 bodyText.includes('winner')) {
        rawStatus = 'finished';
      }
    }

    // Map to canonical values
    let status = 'unknown';
    if (/planned|upcoming|registration|open|not.?started/.test(rawStatus)) {
      status = 'planned';
    } else if (/progress|ongoing|active|started|running|round/.test(rawStatus)) {
      status = 'in_progress';
    } else if (/finish|complet|ended|over|done/.test(rawStatus)) {
      status = 'finished';
    }

    // ── Participants & rankings ───────────────────────────────────────────────
    const participants = [];

    // Strategy A: ranked table rows (finished tournaments)
    const rankRows = findAll(
      '#ranking_block tr, .ranking_table tr, ' +
      '[class*="ranking"] tr, table.ranking tr, ' +
      '[id*="ranking"] tr'
    ).filter(r => r.querySelector('td')); // skip header rows

    if (rankRows.length > 0) {
      rankRows.forEach((row, i) => {
        const cells = [...row.querySelectorAll('td')];
        if (cells.length < 2) return;

        // Try to detect rank cell (first cell is usually the rank number)
        const rankText = text(cells[0]).replace(/[^0-9]/g, '');
        const rank = rankText ? parseInt(rankText, 10) : i + 1;

        // Player name – look for a link or just second cell
        const nameEl = row.querySelector('a[href*="/player"], a[href*="="]') || cells[1];
        const name = text(nameEl);

        if (name) participants.push({ rank, name });
      });
    }

    // Strategy B: player list (in_progress / planned tournaments)
    if (participants.length === 0) {
      const playerLinks = findAll(
        '[class*="player"] a[href*="/player"], ' +
        '[id*="players"] a[href*="/player"], ' +
        'a[href*="/player?id="]'
      );
      playerLinks.forEach((a, i) => {
        const name = text(a);
        if (name && !participants.find(p => p.name === name)) {
          participants.push({ rank: null, name });
        }
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
    const url       = tournament.url;

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
        <p><a href="${url}">${url}</a></p>
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
        Sent by your <a href="https://github.com">BGA Tournament Tracker</a>.
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
