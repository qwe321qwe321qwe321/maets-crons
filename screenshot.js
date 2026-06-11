const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { getBrowserProxies } = require("./proxy-lib");

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


async function takeScreenshot(proxy, slug, cc, locale = "en-US", knownIpLabel = null, unixTs, pageLoadOptions = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale,
    extraHTTPHeaders: {
      Cookie: "birthtime=0; lastagecheckage=1-0-1990; mature_content=1",
    },
    ...(proxy ? { proxy } : {}),
  });

  let ipLabel = knownIpLabel;
  if (!ipLabel) {
    const checkPage = await context.newPage();
    const ipRes = await checkPage.goto("https://ipinfo.io/json", { timeout: 15000 });
    const ipData = await ipRes.json().catch(() => ({}));
    ipLabel = ipData.ip
      ? `${ipData.ip}${ipData.city ? ` (${ipData.city}, ${ipData.country})` : ""}`
      : "unknown";
    await checkPage.close();
  }
  console.log(`[${slug}] ${ipLabel}`);

  const page = await context.newPage();
  const params = new URLSearchParams();
  if (cc) params.set("cc", cc);
  const localeToSteamLang = { "ja-JP": "japanese", "zh-CN": "schinese", "zh-TW": "tchinese" };
  if (locale !== "en-US") params.set("l", localeToSteamLang[locale] ?? locale.split("-")[0]);
  const query = params.toString();
  const url = `https://store.steampowered.com/${query ? `?${query}` : ""}`;

  await page.goto(url, {
    waitUntil: pageLoadOptions.waitUntil ?? "networkidle",
    timeout: pageLoadOptions.timeout ?? 30000,
  });

  if (pageLoadOptions.waitForContent) {
    await page.waitForSelector("[data-ds-appid]", { timeout: pageLoadOptions.timeout ?? 30000 }).catch(() => {});
  }

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
  await page.waitForTimeout(pageLoadOptions.waitAfterScroll ?? 10000);

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

  const htmlContent = await page.content();
  const htmlPath = path.join(__dirname, `${unixTs}_${slug}.html`);
  fs.writeFileSync(htmlPath, htmlContent, "utf8");

  await browser.close();

  return { screenshotPath, htmlPath, tabData, ipLabel };
}

const CAPTURE_NOW_BUTTON = {
  type: 1,
  components: [{ type: 2, style: 1, custom_id: "capture_now", emoji: { name: "📸" }, label: "Capture Now" }],
};

const RETRY_GB_BUTTON = {
  type: 1,
  components: [{ type: 2, style: 4, custom_id: "retry_gb", emoji: { name: "🔁" }, label: "再試一次" }],
};

const RETRY_JP_BUTTON = {
  type: 1,
  components: [{ type: 2, style: 4, custom_id: "retry_jp", emoji: { name: "🔁" }, label: "再試一次" }],
};

const RETRY_CN_BUTTON = {
  type: 1,
  components: [{ type: 2, style: 4, custom_id: "retry_cn", emoji: { name: "🔁" }, label: "再試一次" }],
};

async function postToChannel(channelId, botToken, screenshotPath, htmlPath, tabData, label, unixTs, isoDate, showButton) {
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
      items.forEach((item, i) => lines.push(`  ${String(i + 1).padStart(2)}. ${item.name} (${item.appId})`));
    }
    lines.push("");
  }
  const codeBlock = "```\n" + lines.join("\n").trimEnd() + "\n```";

  const formData = new FormData();
  formData.append("files[0]", new Blob([fs.readFileSync(screenshotPath)], { type: "image/png" }), "steam_homepage.png");
  formData.append("files[1]", new Blob([fs.readFileSync(htmlPath)], { type: "text/html" }), path.basename(htmlPath));
  formData.append("payload_json", JSON.stringify({ content: `${label} · ${isoDate}\n<t:${unixTs}:F>`, flags: 4 }));

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
    body: JSON.stringify({ content: codeBlock, flags: 4, ...(showButton ? { components: [CAPTURE_NOW_BUTTON] } : {}) }),
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

  if (process.env.CN_ONLY === "true") {
    console.log("CN-only mode: retrying CN screenshot...");
    let cnResult = null;
    let cnError = null;
    try {
      const cnProxies = await getBrowserProxies("CN");
      for (const proxy of cnProxies) {
        console.log(`Trying ${proxy.server} for CN screenshot...`);
        try {
          cnResult = await takeScreenshot(proxy, "cn", "cn", "zh-CN", proxy.ipLabel, unixTs, { waitUntil: "domcontentloaded", waitForContent: true, timeout: 90000, waitAfterScroll: 20000 });
          break;
        } catch (e) {
          console.log(`CN screenshot failed with ${proxy.server}: ${e.message}`);
        }
      }
      if (!cnResult) cnError = new Error("All verified CN proxies failed to load Steam");
    } catch (e) {
      cnError = e;
    }
    for (const channelId of channelIds) {
      if (cnResult) {
        await postToChannel(channelId, botToken, cnResult.screenshotPath, cnResult.htmlPath, cnResult.tabData,
          `🇨🇳 Steam homepage · CN · \`${cnResult.ipLabel}\``, unixTs, isoDate, true);
      } else {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🇨🇳 Steam homepage · CN · ⚠️ 截圖失敗: \`${cnError.message}\``,
            components: [RETRY_CN_BUTTON],
          }),
        });
      }
    }
    if (cnResult) {
      fs.unlinkSync(cnResult.screenshotPath);
      fs.unlinkSync(cnResult.htmlPath);
    }
    console.log("Done:", new Date().toISOString());
    return;
  }

  async function runSingleCountry(cc, slug, locale, pageLoadOptions, retryButton, label) {
    let result = null;
    let error = null;
    try {
      const proxies = await getBrowserProxies(cc);
      for (const proxy of proxies) {
        console.log(`Trying ${proxy.server} for ${cc} screenshot...`);
        try {
          result = await takeScreenshot(proxy, slug, cc.toLowerCase(), locale, proxy.ipLabel, unixTs, pageLoadOptions);
          break;
        } catch (e) {
          console.log(`${cc} screenshot failed with ${proxy.server}: ${e.message}`);
        }
      }
      if (!result) error = new Error(`All verified ${cc} proxies failed to load Steam`);
    } catch (e) {
      error = e;
    }
    for (const channelId of channelIds) {
      if (result) {
        await postToChannel(channelId, botToken, result.screenshotPath, result.htmlPath, result.tabData,
          `${label} · \`${result.ipLabel}\``, unixTs, isoDate, false);
      } else {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ content: `${label} · ⚠️ 截圖失敗: \`${error.message}\``, components: [retryButton] }),
        });
      }
    }
    if (result) { fs.unlinkSync(result.screenshotPath); fs.unlinkSync(result.htmlPath); }
    console.log("Done:", new Date().toISOString());
  }

  if (process.env.GB_ONLY === "true") {
    console.log("GB-only mode: retrying GB screenshot...");
    await runSingleCountry("GB", "gb", "en-GB", { waitAfterScroll: 15000 }, RETRY_GB_BUTTON, "🇬🇧 Steam homepage · UK");
    return;
  }

  if (process.env.JP_ONLY === "true") {
    console.log("JP-only mode: retrying JP screenshot...");
    await runSingleCountry("JP", "japan", "ja-JP", { waitAfterScroll: 15000 }, RETRY_JP_BUTTON, "🇯🇵 Steam homepage · Japan");
    return;
  }

  console.log("Taking all screenshots in parallel...");

  async function captureWithFreeProxy(cc, slug, locale, pageLoadOptions = {}) {
    const proxies = await getBrowserProxies(cc);
    for (const proxy of proxies) {
      console.log(`Trying ${proxy.server} for ${cc} screenshot...`);
      try {
        return await takeScreenshot(proxy, slug, cc.toLowerCase(), locale, proxy.ipLabel, unixTs, pageLoadOptions);
      } catch (e) {
        console.log(`${cc} screenshot failed with ${proxy.server}: ${e.message}`);
      }
    }
    throw new Error(`All verified ${cc} proxies failed to load Steam`);
  }

  const [defaultResult, gbOutcome, jpOutcome, cnOutcome] = await Promise.all([
    takeScreenshot(null, "default", null, "en-US", null, unixTs),
    captureWithFreeProxy("GB", "gb", "en-GB", { waitAfterScroll: 15000 }).catch((e) => ({ error: e })),
    captureWithFreeProxy("JP", "japan", "ja-JP", { waitAfterScroll: 15000 }).catch((e) => ({ error: e })),
    captureWithFreeProxy("CN", "cn", "zh-CN", { waitUntil: "domcontentloaded", waitForContent: true, timeout: 90000, waitAfterScroll: 20000 }).catch((e) => ({ error: e })),
  ]);

  const gbResult = gbOutcome?.error ? null : gbOutcome;
  const gbError = gbOutcome?.error ?? null;
  const jpResult = jpOutcome?.error ? null : jpOutcome;
  const jpError = jpOutcome?.error ?? null;
  const cnResult = cnOutcome?.error ? null : cnOutcome;
  const cnError = cnOutcome?.error ?? null;
  if (gbError) console.error(`GB failed: ${gbError.message}`);
  if (jpError) console.error(`JP failed: ${jpError.message}`);
  if (cnError) console.error(`CN failed: ${cnError.message}`);

  for (const channelId of channelIds) {
    await postToChannel(channelId, botToken, defaultResult.screenshotPath, defaultResult.htmlPath, defaultResult.tabData, `🌐 Steam homepage · Default · \`${defaultResult.ipLabel}\``, unixTs, isoDate, false);
    if (gbResult) {
      await postToChannel(channelId, botToken, gbResult.screenshotPath, gbResult.htmlPath, gbResult.tabData, `🇬🇧 Steam homepage · UK · \`${gbResult.ipLabel}\``, unixTs, isoDate, false);
    } else {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🇬🇧 Steam homepage · UK · ⚠️ 截圖失敗: \`${gbError.message}\``, components: [RETRY_GB_BUTTON] }),
      });
    }
    if (jpResult) {
      await postToChannel(channelId, botToken, jpResult.screenshotPath, jpResult.htmlPath, jpResult.tabData, `🇯🇵 Steam homepage · Japan · \`${jpResult.ipLabel}\``, unixTs, isoDate, false);
    } else {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🇯🇵 Steam homepage · Japan · ⚠️ 截圖失敗: \`${jpError.message}\``, components: [RETRY_JP_BUTTON] }),
      });
    }
    if (cnResult) {
      await postToChannel(channelId, botToken, cnResult.screenshotPath, cnResult.htmlPath, cnResult.tabData, `🇨🇳 Steam homepage · CN · \`${cnResult.ipLabel}\``, unixTs, isoDate, true);
    } else {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🇨🇳 Steam homepage · CN · ⚠️ 截圖失敗: \`${cnError.message}\``,
          components: [RETRY_CN_BUTTON],
        }),
      });
    }
  }

  fs.unlinkSync(defaultResult.screenshotPath);
  fs.unlinkSync(defaultResult.htmlPath);
  if (gbResult) { fs.unlinkSync(gbResult.screenshotPath); fs.unlinkSync(gbResult.htmlPath); }
  if (jpResult) { fs.unlinkSync(jpResult.screenshotPath); fs.unlinkSync(jpResult.htmlPath); }
  if (cnResult) {
    fs.unlinkSync(cnResult.screenshotPath);
    fs.unlinkSync(cnResult.htmlPath);
  }
  console.log("Done:", new Date().toISOString());
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
