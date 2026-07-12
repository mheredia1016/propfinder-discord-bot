import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";

const MATCHUP_RE = /\b[A-Z]{2,4}\s*@\s*[A-Z]{2,4}\b/;

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

async function closeOpenPanels(page) {
  const done =
    (await firstVisible(page.getByRole("button", { name: /^done$/i }))) ||
    (await firstVisible(page.getByText(/^done$/i)));

  if (done) {
    await done.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }

  const dialogs = page.locator('[role="dialog"], [aria-modal="true"]');
  const count = await dialogs.count();

  for (let i = 0; i < count; i += 1) {
    const dialog = dialogs.nth(i);
    if (!(await dialog.isVisible().catch(() => false))) continue;

    const closeButton =
      (await firstVisible(dialog.getByRole("button", { name: /close/i }))) ||
      (await firstVisible(dialog.locator('button').filter({ hasText: "×" }))) ||
      (await firstVisible(dialog.locator('button').filter({ hasText: "✕" })));

    if (closeButton) {
      await closeButton.click({ force: true }).catch(() => {});
      await page.waitForTimeout(300);
    } else {
      await page.keyboard.press("Escape").catch(() => {});
    }
  }
}

async function ensureHighlightEnabled(page, config) {
  // Open the highlights panel if the main button exists.
  const highlightsButton =
    (await firstVisible(page.getByRole("button", { name: /highlights/i }))) ||
    (await firstVisible(page.getByText(/^highlights$/i)));

  if (highlightsButton) {
    await highlightsButton.click({ force: true }).catch(() => {});
    await page.waitForTimeout(700);
  }

  const sleeperText = await firstVisible(
    page.getByText(config.highlightName, { exact: true })
  );

  if (sleeperText) {
    const row = sleeperText.locator("xpath=ancestor::*[self::div or self::li][1]");
    const checkbox = row.locator('input[type="checkbox"]');

    if (await checkbox.count()) {
      const checked = await checkbox.first().isChecked().catch(() => true);
      if (!checked) {
        await checkbox.first().check({ force: true }).catch(() => {});
      }
    } else {
      // Many versions use a colored toggle instead of a checkbox.
      const toggle =
        (await firstVisible(row.getByRole("switch"))) ||
        (await firstVisible(row.locator('button[aria-pressed]')));

      if (toggle) {
        const pressed = await toggle.getAttribute("aria-pressed");
        if (pressed === "false") {
          await toggle.click({ force: true }).catch(() => {});
        }
      }
    }
  }

  await closeOpenPanels(page);
}

async function applySavedSettings(page, config) {
  // Season
  await clickByText(page, config.season, { exact: true });

  // Range and Type
  await selectFromDropdown(page, "Range", config.range);
  await selectFromDropdown(page, "Type", config.type);

  // Ensure the saved highlight is enabled, then close the panel before screenshots.
  await ensureHighlightEnabled(page, config);

  await page.waitForTimeout(config.pageSettleMs);
}

async function discoverGameTargets(page) {
  const raw = await page.evaluate(() => {
    const matchup = /\b[A-Z]{2,4}\s*@\s*[A-Z]{2,4}\b/;
    const results = [];
    const seen = new Set();

    const elements = Array.from(document.querySelectorAll("body *"));

    for (const element of elements) {
      const text = (element.innerText || element.textContent || "")
        .replace(/\s+/g, " ")
        .trim();

      if (!text || text.length > 220) continue;

      const match = text.match(matchup);
      if (!match) continue;

      const name = match[0].replace(/\s+/g, " ").trim();
      if (seen.has(name)) continue;

      // Prefer the smallest node containing the exact abbreviated matchup.
      const childHasMatch = Array.from(element.children || []).some((child) => {
        const childText = (child.innerText || child.textContent || "")
          .replace(/\s+/g, " ")
          .trim();
        return matchup.test(childText);
      });

      if (childHasMatch) continue;

      let target = element;
      let cursor = element;

      for (let i = 0; i < 8 && cursor; i += 1, cursor = cursor.parentElement) {
        const rect = cursor.getBoundingClientRect();
        const style = window.getComputedStyle(cursor);
        const cursorText = (cursor.innerText || cursor.textContent || "")
          .replace(/\s+/g, " ")
          .trim();

        const looksLikeCard =
          rect.width >= 180 &&
          rect.width <= 700 &&
          rect.height >= 45 &&
          rect.height <= 220 &&
          cursorText.length <= 260 &&
          matchup.test(cursorText);

        const clickable =
          cursor.tagName === "BUTTON" ||
          cursor.tagName === "A" ||
          cursor.getAttribute("role") === "button" ||
          cursor.getAttribute("role") === "tab" ||
          cursor.hasAttribute("data-game-id") ||
          typeof cursor.onclick === "function" ||
          style.cursor === "pointer";

        if (clickable || looksLikeCard) {
          target = cursor;
          if (clickable) break;
        }
      }

      const id = `pf-game-${results.length}`;
      target.setAttribute("data-pf-bot-target", id);

      results.push({
        name,
        targetId: id,
        text: (target.innerText || target.textContent || "")
          .replace(/\s+/g, " ")
          .trim(),
      });

      seen.add(name);
    }

    return results;
  });

  return raw;
}

async function clickGame(page, game) {
  const selector = `[data-pf-bot-target="${game.targetId.replaceAll('"', '\\"')}"]`;
  const target = page.locator(selector).first();

  if (!(await target.isVisible().catch(() => false))) {
    return false;
  }

  await page.evaluate(() => window.scrollTo(0, 0));
  await target.scrollIntoViewIfNeeded().catch(() => {});

  const box = await target.boundingBox();
  if (!box) return false;

  // Use a real mouse click in the center of the game card.
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1800);

  // A second JS click helps with cards whose click handler is on an ancestor.
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return;
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }, selector);

  await page.waitForTimeout(1800);
  return true;
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

async function captureGameSection(page, screenshotPath) {
  await closeOpenPanels(page);

  const confirmed = await firstVisible(page.getByText(/Confirmed Lineup/i));

  if (!confirmed) {
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: "disabled",
    });
    return;
  }

  await confirmed.scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(500);

  const clip = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("body *"));
    const confirmedNode = all.find((node) =>
      /Confirmed Lineup/i.test(
        (node.innerText || node.textContent || "").replace(/\s+/g, " ").trim()
      )
    );

    if (!confirmedNode) return null;

    const startRect = confirmedNode.getBoundingClientRect();
    const startY = Math.max(0, startRect.top + window.scrollY - 20);

    const candidates = Array.from(
      document.querySelectorAll("table, [role='table'], .table, [class*='table']")
    )
      .map((node) => {
        const rect = node.getBoundingClientRect();
        return {
          top: rect.top + window.scrollY,
          bottom: rect.bottom + window.scrollY,
          width: rect.width,
          height: rect.height,
        };
      })
      .filter(
        (rect) =>
          rect.top >= startY - 50 &&
          rect.width > 700 &&
          rect.height > 120
      );

    const endY = candidates.length
      ? Math.max(...candidates.map((rect) => rect.bottom))
      : startY + 900;

    const pageWidth = Math.min(
      Math.max(document.documentElement.scrollWidth, window.innerWidth),
      4096
    );

    return {
      x: 0,
      y: startY,
      width: pageWidth,
      height: Math.min(Math.max(endY - startY + 25, 350), 2200),
    };
  });

  if (clip) {
    await page.screenshot({
      path: screenshotPath,
      clip,
      animations: "disabled",
    });
  } else {
    await page.screenshot({
      path: screenshotPath,
      fullPage: true,
      animations: "disabled",
    });
  }
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

  for (const originalGame of games) {
    console.log(`Opening ${originalGame.name}...`);

    // PropFinder can re-render the carousel after each click, so refresh targets.
    const refreshedGames = await discoverGameTargets(page);
    const game =
      refreshedGames.find((item) => item.name === originalGame.name) ||
      originalGame;

    const clicked = await clickGame(page, game);

    if (!clicked) {
      console.log(`Could not click ${game.name}; skipping.`);
      continue;
    }

    await page.waitForTimeout(config.pageSettleMs);

    if (!(await isConfirmedLineup(page))) {
      console.log(`${game.name} does not have a confirmed lineup; skipping.`);
      continue;
    }

    // Re-apply settings after a game change in case the site resets them.
    await applySavedSettings(page, config);
    await closeOpenPanels(page);

    const pitcher = await getPitcher(page);
    const safeName = game.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const screenshotPath = path.join(
      config.dataDir,
      `${new Date().toISOString().slice(0, 10)}-${safeName}.png`
    );

    console.log(`Capturing ${game.name}...`);
    await captureGameSection(page, screenshotPath);

    await debugDump(page, config, `game-${safeName}`);

    results.push({
      game: game.name,
      pitcher,
      screenshotPath,
    });
  }

  return results;
}
