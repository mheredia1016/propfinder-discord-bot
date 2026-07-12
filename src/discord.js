import fs from "node:fs/promises";
import path from "node:path";

export async function postScreenshot({
  webhookUrl,
  screenshotPath,
  game,
  pitcher,
  settings,
  capturedAt,
}) {
  const image = await fs.readFile(screenshotPath);
  const form = new FormData();

  const title = `⚾ ${game}`;
  const lines = [
    `**${title}**`,
    pitcher ? `Starting pitcher: **${pitcher}**` : null,
    `Settings: **${settings}**`,
    `Captured: <t:${Math.floor(capturedAt.getTime() / 1000)}:f>`,
  ].filter(Boolean);

  form.append(
    "payload_json",
    JSON.stringify({
      content: lines.join("\n"),
      allowed_mentions: { parse: [] },
    })
  );

  form.append(
    "files[0]",
    new Blob([image], { type: "image/png" }),
    path.basename(screenshotPath)
  );

  const response = await fetch(`${webhookUrl}?wait=true`, {
    method: "POST",
    body: form,
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return response.json().catch(() => ({}));
}
