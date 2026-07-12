function bool(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function int(name, fallback) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export const config = {
  email: required("PROPFINDER_EMAIL"),
  password: required("PROPFINDER_PASSWORD"),
  webhookUrl: required("DISCORD_WEBHOOK_URL"),
  propfinderUrl:
    process.env.PROPFINDER_URL ||
    "https://propfinder.app/mlb/cheatsheets/hr-matchups",

  timezone: process.env.TIMEZONE || "America/Chicago",
  checkIntervalMinutes: int("CHECK_INTERVAL_MINUTES", 10),
  runOnStart: bool("RUN_ON_START", true),
  runOnce: bool("RUN_ONCE", false),

  highlightName: process.env.HIGHLIGHT_NAME || "Sleepers",
  season: process.env.SEASON || "2026",
  range: process.env.RANGE || "L15",
  type: process.env.TYPE || "Games",

  headless: bool("HEADLESS", true),
  viewportWidth: int("VIEWPORT_WIDTH", 2048),
  viewportHeight: int("VIEWPORT_HEIGHT", 1200),
  navigationTimeoutMs: int("NAVIGATION_TIMEOUT_MS", 60000),
  pageSettleMs: int("PAGE_SETTLE_MS", 4000),

  dataDir: process.env.DATA_DIR || "./data",
  debugMode: bool("DEBUG_MODE", false),
  forceRepost: bool("FORCE_REPOST", false),
  gameFilter: (process.env.GAME_FILTER || "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean),
};
