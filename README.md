# 🎲 BGA Tournament Tracker

Automatically checks your [Board Game Arena](https://boardgamearena.com) tournaments every 2 hours, detects status changes (**Planned → In Progress → Finished**), sends you email alerts, and displays everything on a GitHub Pages dashboard.

---

## What it does

| Feature | Detail |
|---|---|
| **Scheduled checks** | GitHub Actions runs every 2 hours |
| **Status tracking** | Planned → In Progress → Finished |
| **Email alerts** | Triggered when any tournament changes status |
| **Finished rankings** | Extracts player positions from completed tournaments |
| **Live dashboard** | GitHub Pages site auto-updates after each scrape |
| **Manual trigger** | Run from the Actions tab any time |

---

## Quick Setup (5 steps)

### 1. Fork / create the repo

Push this folder as a new GitHub repository.

### 2. Add your tournaments

Edit `data/seeds.json` and add tournament IDs or full BGA tournament URLs.
Find the ID in the BGA URL: `boardgamearena.com/tournament?id=`**`XXXXXX`**.
On each run, the scraper will merge seeds into `data/tournaments.json` and populate/update the other properties automatically.

```json
{
  "tournaments": [
    "123456",
    "https://boardgamearena.com/tournament?id=654321",
    { "id": "777777", "label": "My Sunday Catan League" }
  ]
}
```

### 3. Add GitHub Secrets

Go to **Settings → Secrets and variables → Actions → New repository secret** and add:

| Secret | Value |
|---|---|
| `NOTIFY_EMAIL` | The address to receive alerts (e.g. `you@gmail.com`) |
| `SMTP_HOST` | `smtp.gmail.com` |
| `SMTP_PORT` | `587` |
| `SMTP_USER` | Your Gmail address |
| `SMTP_PASS` | A [Gmail App Password](https://myaccount.google.com/apppasswords) *(not your regular password)* |

> **Gmail App Password**: Go to your Google Account → Security → 2-Step Verification → App passwords. Create one for "Mail" and paste that 16-character code as `SMTP_PASS`.

> **Other email providers**: Change `SMTP_HOST`/`SMTP_PORT` to match your provider (e.g. Outlook uses `smtp.office365.com:587`).

### 4. Enable GitHub Pages

Go to **Settings → Pages** and set:
- Source: **GitHub Actions**

### 5. Run it manually the first time

Go to **Actions → Check BGA Tournaments → Run workflow** to trigger an immediate run and verify everything works.

---

## Customise the schedule

The default is every 2 hours. Edit `.github/workflows/check-tournaments.yml`:

```yaml
schedule:
  - cron: '0 */2 * * *'   # every 2 hours
  # - cron: '0 * * * *'   # every hour
  # - cron: '*/30 * * * *' # every 30 minutes
```

---

## File structure

```
├── .github/
│   └── workflows/
│       └── check-tournaments.yml   # Scheduler + scraper + Pages deploy
├── data/
│   └── tournaments.json            # Your tournament list + cached state
├── scripts/
│   └── scrape.js                   # Playwright scraper + email sender
├── index.html                      # GitHub Pages dashboard
├── package.json
└── README.md
```

---

## Troubleshooting

**The scraper reports "unknown" status**

BGA occasionally changes their page structure. Open the Actions log and look for the raw page text that was found. You may need to adjust the selectors in `scripts/scrape.js` in the `scrapeTournament` function. The `rawStatus` variable shows what text the scraper found.

**No emails received**

- Check that you used a Gmail **App Password** (not your account password)
- Make sure all 5 secrets are set correctly in GitHub
- Try the manual workflow trigger and check the Actions log for errors

**Rankings are empty for finished tournaments**

BGA's ranking table HTML can vary by game. If you open the tournament page in your browser, right-click → Inspect the ranking table and look for a `class` or `id` containing `ranking`. Add that selector to the `rankRows` query in `scrape.js`.

---

## Tech stack

- [Playwright](https://playwright.dev/) – headless Chromium scraping
- [Nodemailer](https://nodemailer.com/) – email delivery
- [GitHub Actions](https://github.com/features/actions) – scheduling & CI
- [GitHub Pages](https://pages.github.com/) – static dashboard hosting
