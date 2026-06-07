const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function run() {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl) throw new Error("DISCORD_WEBHOOK_URL not set");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    extraHTTPHeaders: {
      // bypass Steam age gate cookie
      Cookie: "birthtime=0; lastagecheckage=1-0-1990; mature_content=1",
    },
  });
  const page = await context.newPage();

  await page.goto("https://store.steampowered.com/", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  // dismiss cookie banner if present
  const cookieBtn = page.locator("#acceptAllButton");
  if (await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cookieBtn.click();
    await page.waitForTimeout(500);
  }

  const screenshotPath = path.join(__dirname, "steam_homepage.png");
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  await browser.close();

  const imageBuffer = fs.readFileSync(screenshotPath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([imageBuffer], { type: "image/png" }),
    "steam_homepage.png"
  );
  const unixTs = Math.floor(Date.now() / 1000);
  formData.append(
    "payload_json",
    JSON.stringify({ content: `Steam homepage · <t:${unixTs}:F>` })
  );

  const res = await fetch(webhookUrl, { method: "POST", body: formData });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }

  fs.unlinkSync(screenshotPath);
  console.log("Done:", today);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
