const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

async function run() {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) throw new Error("DISCORD_BOT_TOKEN not set");

  const channelIdsRaw = process.env.CHANNEL_IDS;
  if (!channelIdsRaw) throw new Error("CHANNEL_IDS not set");
  const channelIds = channelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  if (channelIds.length === 0) throw new Error("No channel IDs provided");

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    extraHTTPHeaders: {
      Cookie: "birthtime=0; lastagecheckage=1-0-1990; mature_content=1",
    },
  });
  const page = await context.newPage();

  await page.goto("https://store.steampowered.com/", {
    waitUntil: "networkidle",
    timeout: 30000,
  });

  const cookieBtn = page.locator("#acceptAllButton");
  if (await cookieBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
    await cookieBtn.click();
    await page.waitForTimeout(500);
  }

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
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();

  const unixTs = Math.floor(Date.now() / 1000);
  const isoDate = new Date().toISOString();

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

  const imageBuffer = fs.readFileSync(screenshotPath);

  const CAPTURE_NOW_BUTTON = {
    type: 1,
    components: [{
      type: 2,
      style: 1,
      custom_id: "capture_now",
      emoji: { name: "📸" },
      label: "Capture Now",
    }],
  };

  for (const channelId of channelIds) {
    const formData = new FormData();
    formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "steam_homepage.png");
    formData.append(
      "payload_json",
      JSON.stringify({ content: `Steam homepage · ${isoDate}\n<t:${unixTs}:F>`, flags: 4 })
    );
    const imgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}` },
      body: formData,
    });
    if (!imgRes.ok) {
      console.error(`Image post failed for ${channelId}: ${imgRes.status} ${await imgRes.text()}`);
      continue;
    }

    const tabRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: codeBlock, flags: 4, components: [CAPTURE_NOW_BUTTON] }),
    });
    if (!tabRes.ok) {
      console.error(`Tab post failed for ${channelId}: ${tabRes.status} ${await tabRes.text()}`);
    }
  }

  fs.unlinkSync(screenshotPath);
  console.log("Done:", new Date().toISOString());
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
