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

### 5. Configure Email Notifications (Optional)

To receive email alerts when tournaments change status:

#### Option A: Local Development (.env file)
1. Copy `.env.example` to `.env` and fill in your SMTP details:
   ```bash
   cp .env.example .env
   ```

2. For Gmail:
   - Enable 2FA on your Google account
   - Generate an App Password: https://support.google.com/accounts/answer/185833
   - Use your Gmail address as SMTP_USER and the app password as SMTP_PASS

3. Update `data/tournaments.json` with your email address:
   ```json
   {
     "config": {
       "notify_email": "your@email.com"
     }
   }
   ```

#### Option B: GitHub Actions (Recommended for Automation)
Set these secrets in your repository settings (Settings → Secrets and variables → Actions):

- `NOTIFY_EMAIL`: Email address(es) to receive notifications. For multiple recipients, use a comma-separated list: `email1@example.com,email2@example.com,email3@example.com`
- `SMTP_HOST`: Your SMTP server (e.g., `smtp.gmail.com`)
- `SMTP_PORT`: SMTP port (usually `587`)
- `SMTP_USER`: Your email address
- `SMTP_PASS`: Your email password or app password

The automated daily runs will use these secrets securely.

**Multiple Recipients Example:**
```
NOTIFY_EMAIL = user1@gmail.com,user2@gmail.com,user3@example.com
```
Each user will receive their own copy of the notification email.

---

## Customise the schedule

The default is every day. Edit `.github/workflows/check-tournaments.yml`:

```yaml
schedule:
  - cron: '0 1 * * *
```


