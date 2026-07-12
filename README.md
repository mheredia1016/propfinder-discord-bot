# PropFinder Discord Screenshot Bot

This Railway-ready Playwright service:

1. Logs into PropFinder with a regular email/password account.
2. Opens the MLB HR Matchups cheatsheet.
3. Keeps these fixed settings:
   - Season: `2026`
   - Range: `L15`
   - Type: `Games`
   - Saved highlight: `Sleepers`
4. Finds the games on the page.
5. Posts a screenshot for each game whose lineup is confirmed.
6. Saves posted-game history so the same game is not posted repeatedly.
7. Checks again on a schedule as more lineups are released.

## Before deploying

Create and save this highlight inside PropFinder:

- Name: `Sleepers`
- Priority: `2`
- Require: `Any 4`
- PullAir% higher than `18`
- PullBr% higher than `18`
- HH% higher than `48`
- EV higher than `90.5`
- Barrel% higher than `10`
- Air% higher than `55`

Leave that saved highlight available on:

`https://propfinder.app/mlb/cheatsheets/hr-matchups`

## GitHub upload

Upload every file in this folder to a new GitHub repository.

The final structure must be:

```text
propfinder-discord-bot/
├── .env.example
├── .gitignore
├── Dockerfile
├── README.md
├── package.json
├── railway.json
└── src/
    ├── browser.js
    ├── config.js
    ├── discord.js
    ├── index.js
    └── state.js
```

## Railway deployment

1. Create a new Railway project.
2. Deploy from the GitHub repository.
3. Add a Railway Volume.
4. Mount the volume at:

```text
/data
```

5. Add the variables below.
6. Deploy.

## Required Railway variables

```env
PROPFINDER_EMAIL=your-propfinder-email
PROPFINDER_PASSWORD=your-propfinder-password
DISCORD_WEBHOOK_URL=your-discord-webhook-url
PROPFINDER_URL=https://propfinder.app/mlb/cheatsheets/hr-matchups

TIMEZONE=America/Chicago
CHECK_INTERVAL_MINUTES=10
RUN_ON_START=true
RUN_ONCE=false

HIGHLIGHT_NAME=Sleepers
SEASON=2026
RANGE=L15
TYPE=Games

HEADLESS=true
VIEWPORT_WIDTH=2048
VIEWPORT_HEIGHT=1200
NAVIGATION_TIMEOUT_MS=60000
PAGE_SETTLE_MS=4000

DATA_DIR=/data
DEBUG_MODE=false
FORCE_REPOST=false
GAME_FILTER=
```

## Discord webhook

In Discord:

1. Open the target channel.
2. Edit Channel.
3. Integrations.
4. Webhooks.
5. New Webhook.
6. Copy Webhook URL.
7. Paste it into Railway as `DISCORD_WEBHOOK_URL`.

## First deployment

The service should log messages similar to:

```text
Health server listening on 8080
Starting PropFinder scan...
Posted: Astros @ Rangers
Scan complete. Confirmed: 1. Posted: 1.
Scheduled every 10 minute(s).
```

## Manual run

The service exposes:

```text
POST /run
```

Example:

```bash
curl -X POST https://YOUR-RAILWAY-DOMAIN.up.railway.app/run
```

The request immediately returns and the scan runs in the background.

## Duplicate prevention

Posted games are stored in:

```text
/data/state.json
```

A game is normally posted once per Central-time date.

To intentionally post every confirmed game again during every scan:

```env
FORCE_REPOST=true
```

Change it back to `false` after testing.

## Troubleshooting selectors

PropFinder is a private, frequently updated site. The project uses flexible text-based selectors, but the first deployment may expose a selector that needs adjustment.

Turn on:

```env
DEBUG_MODE=true
FORCE_REPOST=true
```

Run the service once. Debug page screenshots and HTML will be written under:

```text
/data/debug/
```

Railway volume files are not directly shown in normal deployment logs. For the easiest troubleshooting, temporarily run the project locally with `HEADLESS=false`, or add a Railway shell and inspect `/data/debug`.

The most useful deployment logs are:

- `No game selectors were discovered`
- `Could not find the PropFinder login button`
- `Login page detected, but email/password fields could not be found`

Send the exact log plus the debug screenshot when a selector needs adjustment.

## Local test

Install Node.js 20+, then:

```bash
npm install
cp .env.example .env
```

Load the `.env` variables in your shell and run:

```bash
npm run debug
```

For a visible browser:

```env
HEADLESS=false
```

## Security

Never commit your `.env` file or credentials to GitHub. Keep the login and webhook URL in Railway Variables.
