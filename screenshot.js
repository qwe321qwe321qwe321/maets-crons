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

  // scroll to bottom to trigger lazy-load, then wait for images
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      const distance = 300;
      const delay = 100;
      const timer = setInterval(() => {
        window.scrollBy(0, distance);
        if (window.scrollY + window.innerHeight >= document.body.scrollHeight) {
          clearInterval(timer);
          resolve();
        }
      }, delay);
    });
  });
  await page.waitForTimeout(10000);

  // scrape store tabs before scrolling back
  const tabData = await page.evaluate(() => {
    const result = {
      popularNewReleases: [],
      topSellers: [],
      popularUpcoming: [],
      specials: [],
      trendingFree: [],
    };
    const tabConfigs = [
      { key: "popularNewReleases", id: "tab_newreleases_content" },
      { key: "topSellers", id: "tab_topsellers_content" },
      { key: "popularUpcoming", id: "tab_upcoming_content" },
      { key: "specials", id: "tab_specials_content" },
      { key: "trendingFree", id: "tab_trendingfree_content" },
    ];
    tabConfigs.forEach((config) => {
      const container = document.getElementById(config.id);
      if (!container) return;
      container.querySelectorAll("a[data-ds-appid]").forEach((item) => {
        const appId = item.getAttribute("data-ds-appid");
        const titleElem =
          item.querySelector(".tab_item_name") ||
          item.querySelector(".title") ||
          item.querySelector('[class*="name"]');
        let name = titleElem
          ? (titleElem.innerText || titleElem.textContent || "").trim()
          : "";
        if (!name) {
          const img = item.querySelector("img");
          name = img
            ? (img.getAttribute("alt") || img.getAttribute("title") || "").trim()
            : "";
        }
        if (!name) {
          const textLines = (item.textContent || "")
            .split("\n")
            .map((t) => t.trim())
            .filter((t) => t.length > 0 && !/^\d+$/.test(t) && !t.includes("%"));
          name = textLines[0] || "";
        }
        if (appId && name && !result[config.key].some((t) => t.appId === appId)) {
          result[config.key].push({ appId, name });
        }
      });
    });
    return result;
  });

  await page.evaluate(() => window.scrollTo(0, 0));

  const screenshotPath = path.join(__dirname, "steam_homepage.png");
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });

  await browser.close();

  const unixTs = Math.floor(Date.now() / 1000);
  const isoDate = new Date().toISOString();

  // send screenshot
  const imageBuffer = fs.readFileSync(screenshotPath);
  const formData = new FormData();
  formData.append(
    "file",
    new Blob([imageBuffer], { type: "image/png" }),
    "steam_homepage.png"
  );
  formData.append(
    "payload_json",
    JSON.stringify({ content: `Steam homepage · ${isoDate}\n<t:${unixTs}:F>` })
  );
  const res = await fetch(webhookUrl, { method: "POST", body: formData });
  if (!res.ok) {
    throw new Error(`Discord webhook failed: ${res.status} ${await res.text()}`);
  }
  fs.unlinkSync(screenshotPath);

  // send store tabs as separate message
  const tabLabels = [
    { key: "popularNewReleases", label: "Popular New Releases" },
    { key: "topSellers", label: "Top Sellers" },
    { key: "popularUpcoming", label: "Popular Upcoming" },
    { key: "specials", label: "Specials" },
    { key: "trendingFree", label: "Trending Free" },
  ];
  const lines = [];
  for (const { key, label } of tabLabels) {
    lines.push(label);
    const items = tabData[key];
    if (items.length === 0) {
      lines.push("  (no data)");
    } else {
      items.forEach((item, i) => {
        lines.push(`  ${String(i + 1).padStart(2)}. ${item.name} (${item.appId})`);
      });
    }
    lines.push("");
  }
  const codeBlock = "```\n" + lines.join("\n").trimEnd() + "\n```";
  const tabRes = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content: codeBlock }),
  });
  if (!tabRes.ok) {
    throw new Error(`Discord tab message failed: ${tabRes.status} ${await tabRes.text()}`);
  }

  console.log("Done:", new Date().toISOString());
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
