import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const MATCHUP_RE = /\b[A-Za-z]{2,15}\s*@\s*[A-Za-z]{2,15}\b/;

function clean(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

async function firstVisible(locator) {
  const count = await locator.count();
  for (let i = 0; i < count; i += 1) {
    const item = locator.nth(i);
    if (await item.isVisible().catch(() => false)) return item;
  }
  return null;
}

async function clickByText(page, text, options = {}) {
  const exact = options.exact ?? true;
  const candidates = [
    page.getByRole("button", { name: text, exact }),
    page.getByRole("tab", { name: text, exact }),
    page.getByText(text, { exact }),
  ];

  for (const locator of candidates) {
    const item = await firstVisible(locator);
    if (item) {
      await item.click({ timeout: 5000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function selectFromDropdown(page, labelText, valueText) {
  const label = page.getByText(labelText, { exact: true });
  const visibleLabel = await firstVisible(label);
  if (!visibleLabel) return false;

  const container = visibleLabel.locator("xpath=..");
  const select = container.locator("select");
  if (await select.count()) {
    await select.first().selectOption({ label: valueText }).catch(async () => {
      await select.first().selectOption(valueText);
    });
    return true;
  }

  const buttons = container.getByRole("button");
  const button = await firstVisible(buttons);
  if (!button) return false;

  await button.click();
  const chosen =
    (await firstVisible(page.getByRole("option", { name: valueText, exact: true }))) ||
    (await firstVisible(page.getByText(valueText, { exact: true })));

  if (chosen) {
    await chosen.click();
    return true;
  }

  await page.keyboard.press("Escape").catch(() => {});
  return false;
}

async function loginIfNeeded(page, config) {
  const passwordField = page.locator('input[type="password"]');
  const needsLogin = (await passwordField.count()) > 0;

  if (!needsLogin) return false;

  const emailField =
    (await firstVisible(page.locator('input[type="email"]'))) ||
    (await firstVisible(page.locator('input[name*="email" i]'))) ||
    (await firstVisible(page.locator('input[autocomplete="username"]')));

  const passField = await firstVisible(passwordField);

  if (!emailField || !passField) {
    throw new Error("Login page detected, but email/password fields could not be found.");
  }

  await emailField.fill(config.email);
  await passField.fill(config.password);

  const submit =
    (await firstVisible(page.getByRole("button", { name: /log in|sign in/i }))) ||
    (await firstVisible(page.locator('button[type="submit"]')));

  if (!submit) throw new Error("Could not find the PropFinder login button.");

  await Promise.all([
    page.waitForLoadState("domcontentloaded").catch(() => {}),
    submit.click(),
  ]);

  await page.waitForTimeout(config.pageSettleMs);

  if ((await page.locator('input[type="password"]').count()) > 0) {
    throw new Error("PropFinder login still appears visible. Check the email/password.");
  }

  return true;
}

async function applySavedSettings(page, config) {
  // Season
  await clickByText(page, config.season, { exact: true });

  // Range and Type
  await selectFromDropdown(page, "Range", config.range);
  await selectFromDropdown(page, "Type", config.type);

  // Saved highlight button/chip
  await clickByText(page, config.highlightName, { exact: true });

  // Some versions use a filter panel. If the highlight chip is hidden, open filters and retry.
  const hasHighlight = await page.getByText(config.highlightName, { exact: true }).count();
  if (!hasHighlight) {
    const filterButton =
      (await firstVisible(page.getByRole("button", { name: /filter|highlight/i }))) ||
      (await firstVisible(page.locator('button[aria-label*="filter" i]')));
    if (filterButton) {
      await filterButton.click().catch(() => {});
      await clickByText(page, config.highlightName, { exact: true });
    }
  }

  await page.waitForTimeout(config.pageSettleMs);
}

async function discoverGameTargets(page) {
  const raw = await page.locator("button, [role=tab], a, [data-game-id]").evaluateAll((nodes) =>
    nodes.map((node, index) => ({
      index,
      text: (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim(),
      tag: node.tagName,
      href: node.getAttribute("href"),
      aria: node.getAttribute("aria-label"),
      gameId: node.getAttribute("data-game-id"),
    }))
  );

  const seen = new Set();
  const games = [];

  for (const item of raw) {
    const text = clean(item.text || item.aria);
    const match = text.match(MATCHUP_RE);
    if (!match) continue;

    const name = clean(match[0]);
    if (seen.has(name)) continue;
    seen.add(name);

    games.push({
      name,
      text,
      href: item.href,
      gameId: item.gameId,
    });
  }

  return games;
}

async function clickGame(page, game) {
  if (game.href) {
    const link = page.locator(`a[href="${game.href.replaceAll('"', '\\"')}"]`).first();
    if (await link.isVisible().catch(() => false)) {
      await link.click();
      return true;
    }
  }

  if (game.gameId) {
    const target = page.locator(`[data-game-id="${game.gameId.replaceAll('"', '\\"')}"]`).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click();
      return true;
    }
  }

  const exactText = page.getByText(game.name, { exact: false });
  const target = await firstVisible(exactText);
  if (target) {
    await target.click();
    return true;
  }

  return false;
}

async function isConfirmedLineup(page) {
  const body = clean(await page.locator("body").innerText());
  return /Confirmed Lineup/i.test(body) &&
    (
      /Confirmed Lineup\s*[✅✓✔]/i.test(body) ||
      /Confirmed Lineup/i.test(body)
    );
}

async function getPitcher(page) {
  const labels = [
    page.getByText(/Select Pitcher/i),
    page.locator("text=/Starting Pitcher/i"),
  ];

  for (const label of labels) {
    const visible = await firstVisible(label);
    if (!visible) continue;
    const parentText = clean(await visible.locator("xpath=..").innerText().catch(() => ""));
    const cleaned = parentText
      .replace(/Select Pitcher/i, "")
      .replace(/Starting Pitcher/i, "")
      .trim();
    if (cleaned) return cleaned.slice(0, 100);
  }

  return "";
}

async function getScreenshotTarget(page) {
  const confirmed = await firstVisible(page.getByText(/Confirmed Lineup/i));
  if (confirmed) {
    const candidates = [
      confirmed.locator("xpath=ancestor::section[1]"),
      confirmed.locator("xpath=ancestor::main[1]"),
      confirmed.locator("xpath=ancestor::div[4]"),
    ];

    for (const candidate of candidates) {
      if (
        (await candidate.count()) &&
        (await candidate.isVisible().catch(() => false))
      ) {
        const box = await candidate.boundingBox();
        if (box && box.width > 600 && box.height > 250) return candidate;
      }
    }
  }

  const table = await firstVisible(page.locator("table"));
  if (table) {
    const parent = table.locator("xpath=..");
    const box = await parent.boundingBox().catch(() => null);
    if (box && box.width > 600) return parent;
  }

  return null;
}

async function debugDump(page, config, name) {
  if (!config.debugMode) return;
  const dir = path.join(config.dataDir, "debug");
  await fs.mkdir(dir, { recursive: true });
  const safe = name.replace(/[^a-z0-9_-]+/gi, "_");
  await fs.writeFile(path.join(dir, `${safe}.html`), await page.content());
  await page.screenshot({
    path: path.join(dir, `${safe}.png`),
    fullPage: true,
  });
}

export async function launchBrowser(config) {
  await fs.mkdir(config.dataDir, { recursive: true });

  const browser = await chromium.launch({
    headless: config.headless,
    args: ["--disable-dev-shm-usage", "--no-sandbox"],
  });

  const context = await browser.newContext({
    viewport: {
      width: config.viewportWidth,
      height: config.viewportHeight,
    },
    storageState: await fs
      .access(path.join(config.dataDir, "storage-state.json"))
      .then(() => path.join(config.dataDir, "storage-state.json"))
      .catch(() => undefined),
  });

  const page = await context.newPage();
  page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
  page.setDefaultTimeout(15000);

  return { browser, context, page };
}

export async function collectConfirmedGames({ page, context, config }) {
  await page.goto(config.propfinderUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(config.pageSettleMs);

  const loggedIn = await loginIfNeeded(page, config);
  if (loggedIn) {
    await context.storageState({
      path: path.join(config.dataDir, "storage-state.json"),
    });
    await page.goto(config.propfinderUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(config.pageSettleMs);
  }

  await applySavedSettings(page, config);
  await debugDump(page, config, "page-after-settings");

  let games = await discoverGameTargets(page);

  if (config.gameFilter.length) {
    games = games.filter((game) =>
      config.gameFilter.some((needle) =>
        game.name.toLowerCase().includes(needle.toLowerCase())
      )
    );
  }

  if (!games.length) {
    throw new Error(
      "No game selectors were discovered. Run once with DEBUG_MODE=true and inspect /data/debug."
    );
  }

  const results = [];

  for (const game of games) {
    const clicked = await clickGame(page, game);
    if (!clicked) continue;

    await page.waitForTimeout(config.pageSettleMs);

    if (!(await isConfirmedLineup(page))) continue;

    // Re-apply settings after a game change in case the site resets them.
    await applySavedSettings(page, config);

    const pitcher = await getPitcher(page);
    const target = await getScreenshotTarget(page);

    const safeName = game.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const screenshotPath = path.join(
      config.dataDir,
      `${new Date().toISOString().slice(0, 10)}-${safeName}.png`
    );

    if (target) {
      await target.screenshot({
        path: screenshotPath,
        animations: "disabled",
      });
    } else {
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
        animations: "disabled",
      });
    }

    await debugDump(page, config, `game-${safeName}`);

    results.push({
      game: game.name,
      pitcher,
      screenshotPath,
    });
  }

  return results;
}
