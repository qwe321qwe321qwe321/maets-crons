const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/d1/database/${process.env.CF_D1_DATABASE_ID}/query`;

async function d1(sql, params = []) {
  const res = await fetch(D1_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.CF_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sql, params }),
  });
  const json = await res.json();
  if (!json.success) throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
  return json.result[0].results;
}

async function fetchJapanProxy() {
  const res = await fetch(
    "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&country_code=JP&page_size=1",
    { headers: { Authorization: `Token ${process.env.WEBSHARE_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Webshare API failed: ${res.status}`);
  const json = await res.json();
  const p = json.results?.[0];
  if (!p) throw new Error("No JP proxy available");
  return { server: `http://${p.proxy_address}:${p.port}`, username: p.username, password: p.password };
}

async function takeScreenshot(proxy, slug, cc) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    extraHTTPHeaders: {
      Cookie: "birthtime=0; lastagecheckage=1-0-1990; mature_content=1",
    },
    ...(proxy ? { proxy } : {}),
  });

  // verify outbound IP / country before screenshotting
  const checkPage = await context.newPage();
  const ipRes = await checkPage.goto("https://api.ipify.org", { timeout: 15000 });
  const ip = await ipRes.text();
  console.log(`[${slug}] outbound ip: ${ip.trim()}`);
  await checkPage.close();

  const page = await context.newPage();
  const url = cc
    ? `https://store.steampowered.com/?cc=${cc}`
    : "https://store.steampowered.com/";

  await page.goto(url, {
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

  const screenshotPath = path.join(__dirname, `steam_homepage_${slug}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await browser.close();

  return { screenshotPath, tabData };
}

async function postToChannel(channelId, botToken, screenshotPath, tabData, label, unixTs, isoDate, showButton) {
  const tabLabels = [
    { key: "popularNewReleases", label: "Popular New Releases" },
    { key: "topSellers", label: "Top Sellers" },
    { key: "popularUpcoming", label: "Popular Upcoming" },
    { key: "specials", label: "Specials" },
    { key: "trendingFree", label: "Trending Free" },
  ];
  const lines = [];
  for (const { key, label: tabLabel } of tabLabels) {
    lines.push(tabLabel);
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

  const imageBuffer = fs.readFileSync(screenshotPath);
  const formData = new FormData();
  formData.append("file", new Blob([imageBuffer], { type: "image/png" }), "steam_homepage.png");
  formData.append(
    "payload_json",
    JSON.stringify({ content: `${label} · ${isoDate}\n<t:${unixTs}:F>`, flags: 4 })
  );
  const imgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}` },
    body: formData,
  });
  if (!imgRes.ok) {
    console.error(`Image post failed for ${channelId}: ${imgRes.status} ${await imgRes.text()}`);
    return;
  }

  const tabRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: codeBlock,
      flags: 4,
      ...(showButton ? { components: [CAPTURE_NOW_BUTTON] } : {}),
    }),
  });
  if (!tabRes.ok) {
    console.error(`Tab post failed for ${channelId}: ${tabRes.status} ${await tabRes.text()}`);
  }
}

async function run() {
  const botToken = process.env.DISCORD_TOKEN;
  if (!botToken) throw new Error("DISCORD_TOKEN not set");

  let channelIds;
  const channelIdsRaw = process.env.CHANNEL_IDS;
  if (channelIdsRaw) {
    channelIds = channelIdsRaw.split(",").map((s) => s.trim()).filter(Boolean);
  } else {
    const rows = await d1("SELECT channel_id FROM screenshot_channels");
    channelIds = rows.map((r) => r.channel_id);
  }
  if (channelIds.length === 0) {
    console.log("No channels subscribed, skipping.");
    return;
  }

  const unixTs = Math.floor(Date.now() / 1000);
  const isoDate = new Date().toISOString();

  console.log("Taking default screenshot...");
  const { screenshotPath: defaultPath, tabData: defaultTabs } = await takeScreenshot(null, "default", null);

  console.log("Fetching JP proxy...");
  const jpProxy = await fetchJapanProxy();
  console.log("Taking JP screenshot...");
  const { screenshotPath: jpPath, tabData: jpTabs } = await takeScreenshot(jpProxy, "japan", "jp");

  for (const channelId of channelIds) {
    await postToChannel(channelId, botToken, defaultPath, defaultTabs, "🌐 Steam homepage · Default", unixTs, isoDate, false);
    await postToChannel(channelId, botToken, jpPath, jpTabs, "🇯🇵 Steam homepage · Japan", unixTs, isoDate, true);
  }

  fs.unlinkSync(defaultPath);
  fs.unlinkSync(jpPath);
  console.log("Done:", new Date().toISOString());
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
