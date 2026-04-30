# 🎲 BGA Tournament Tracker

Automatically checks your [Board Game Arena](https://boardgamearena.com) tournaments every day, detects status changes (**Planned → In Progress → Finished**) and displays everything on a GitHub Pages dashboard.

---

## What it does

| Feature | Detail |
|---|---|
| **Scheduled checks** | GitHub Actions runs every day |
| **Status tracking** | Planned → In Progress → Finished |
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

### 3. Enable GitHub Pages

Go to **Settings → Pages** and set:
- Source: **GitHub Actions**

### 4. Run it manually the first time

Go to **Actions → Check BGA Tournaments → Run workflow** to trigger an immediate run and verify everything works.

---

## Customise the schedule

The default is every day. Edit `.github/workflows/check-tournaments.yml`:

```yaml
schedule:
  - cron: '0 1 * * *
```


