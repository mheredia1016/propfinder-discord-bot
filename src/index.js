import http from "node:http";
import { config } from "./config.js";
import { StateStore } from "./state.js";
import { postScreenshot } from "./discord.js";
import { collectConfirmedGames, launchBrowser } from "./browser.js";

const state = new StateStore(config.dataDir);
await state.load();

let running = false;

let lastResult = {
  status: "starting",
  lastRunAt: null,
  foundConfirmedGames: 0,
  posted: 0,
  error: null,
};

function localDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: config.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

async function run() {
  if (running) {
    console.log("A run is already in progress; skipping this interval.");
    return;
  }

  running = true;
  const startedAt = new Date();

  console.log(`[${startedAt.toISOString()}] Starting PropFinder scan...`);

  let browser;

  try {
    const launched = await launchBrowser(config);
    browser = launched.browser;

    const games = await collectConfirmedGames({
      page: launched.page,
      context: launched.context,
      config,
    });

    let posted = 0;

    for (const item of games) {
      const key = `${localDateKey(startedAt)}|${item.game}`;

      if (!config.forceRepost && state.hasPosted(key)) {
        console.log(`Already posted: ${item.game}`);
        continue;
      }

      await postScreenshot({
        webhookUrl: config.webhookUrl,
        screenshotPath: item.screenshotPath,
        game: item.game,
        pitcher: item.pitcher,
        settings: `${config.season} • ${config.range} • ${config.type} • ${config.highlightName}`,
        capturedAt: new Date(),
      });

      await state.markPosted(key, {
        game: item.game,
        pitcher: item.pitcher,
      });

      posted += 1;
      console.log(`Posted: ${item.game}`);
    }

    await state.markRun();

    lastResult = {
      status: "ok",
      lastRunAt: new Date().toISOString(),
      foundConfirmedGames: games.length,
      posted,
      error: null,
    };

    console.log(
      `[${lastResult.lastRunAt}] Scan complete. Confirmed: ${games.length}. Posted: ${posted}.`
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    console.error("Run failed:", error);

    lastResult = {
      status: "error",
      lastRunAt: new Date().toISOString(),
      foundConfirmedGames: 0,
      posted: 0,
      error: message,
    };
  } finally {
    await browser?.close().catch(() => {});
    running = false;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    // Always return 200 so Railway knows the service is alive.
    res.writeHead(200, {
      "content-type": "application/json",
      "cache-control": "no-store",
    });

    res.end(
      JSON.stringify({
        service: "propfinder-discord-bot",
        alive: true,
        running,
        ...lastResult,
      })
    );

    return;
  }

  if (req.url === "/run" && req.method === "POST") {
    run().catch(console.error);

    res.writeHead(202, {
      "content-type": "application/json",
    });

    res.end(
      JSON.stringify({
        accepted: true,
        message: running
          ? "A scan is already running."
          : "PropFinder scan accepted.",
      })
    );

    return;
  }

  res.writeHead(200, {
    "content-type": "text/plain",
  });

  res.end("PropFinder Discord Bot is running.\n");
});

const port = Number(process.env.PORT || 8080);

server.listen(port, "0.0.0.0", () => {
  console.log(`Health server listening on ${port}`);
});

if (config.runOnStart) {
  // Start the scan after the server is already listening.
  setTimeout(() => {
    run().catch(console.error);
  }, 1000);
}

if (config.runOnce) {
  const stopWhenDone = setInterval(() => {
    if (!running && lastResult.lastRunAt) {
      clearInterval(stopWhenDone);
      server.close(() => {
        process.exit(lastResult.status === "error" ? 1 : 0);
      });
    }
  }, 500);
} else {
  const intervalMs = Math.max(1, config.checkIntervalMinutes) * 60_000;

  setInterval(() => {
    run().catch(console.error);
  }, intervalMs);

  console.log(`Scheduled every ${config.checkIntervalMinutes} minute(s).`);
}
