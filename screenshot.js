const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { ProxyAgent, fetch: proxyFetch } = require("undici");
const { getBrowserProxies, getHttpProxies } = require("./proxy-lib");

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


async function fetchRankMap(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return new Map();
    const text = await res.text();
    const map = new Map();
    for (const line of text.split("\n").slice(1)) {
      const [rank, appid] = line.trim().split(",");
      if (rank && appid) map.set(appid.trim(), parseInt(rank, 10));
    }
    return map;
  } catch {
    return new Map();
  }
}

function fmt(n) {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function generateSessionId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function fetchSteamFollowers(appid, proxies = [], attempt = 0) {
  const sessionid = generateSessionId();
  const url = `https://steamcommunity.com/search/SearchCommunityAjax?text=${appid}&filter=groups&sessionid=${sessionid}&steamid_user=false`;
  const headers = {
    Cookie: `sessionid=${sessionid}`,
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: "https://steamcommunity.com/search/groups",
  };

  let res;
  if (attempt > 0 && proxies.length > 0) {
    const proxyUrl = proxies[(attempt - 1) % proxies.length];
    console.log(`[followers][${appid}] attempt ${attempt} via proxy ${proxyUrl.split("@")[1] ?? proxyUrl}`);
    res = await proxyFetch(url, { headers, dispatcher: new ProxyAgent(proxyUrl) });
  } else {
    res = await fetch(url, { headers });
  }

  if (res.status === 429) {
    if (proxies.length > 0 && attempt < proxies.length) {
      console.warn(`[followers][${appid}] 429, rotating proxy (attempt ${attempt + 1})`);
      return fetchSteamFollowers(appid, proxies, attempt + 1);
    }
    console.warn(`[followers][${appid}] 429, giving up`);
    return null;
  }
  if (!res.ok) { console.error(`[followers][${appid}] HTTP ${res.status}`); return null; }
  const json = await res.json();
  if (json.success !== 1 || !json.html) return null;
  if (!json.html.includes(`/app/${appid}`)) return null;
  const match = json.html.match(/<span[^>]*>([\d,]+)<\/span>\s*members in this group/);
  if (!match) return null;
  return parseInt(match[1].replace(/,/g, ""), 10);
}

async function fetchReleaseDates(appIds) {
  const map = new Map();
  await Promise.all(appIds.map(async (appId) => {
    try {
      const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&filters=release_date`);
      if (!res.ok) return;
      const json = await res.json();
      const dateStr = json[appId]?.data?.release_date?.date ?? null;
      if (dateStr) map.set(appId, dateStr);
    } catch {
      // ignore
    }
  }));
  return map;
}

function relativeTime(dateStr) {
  if (!dateStr) return null;
  const date = new Date(dateStr);
  if (isNaN(date.getTime())) return null;
  const diffMs = Date.now() - date.getTime();
  const diffHours = diffMs / (1000 * 60 * 60);
  const diffDays = diffHours / 24;
  if (diffHours < 1) return "just now";
  if (diffHours < 24) return `${Math.floor(diffHours)}h ago`;
  if (diffDays < 30) return `${Math.floor(diffDays)}d ago`;
  return `${Math.floor(diffDays / 30)}mo ago`;
}

async function buildEnrichments(results) {
  const newReleasesAppIds = [...new Set(
    results.flatMap((r) => (r?.tabData?.popularNewReleases ?? []).map((i) => i.appId))
  )];

  const [topSellerRanks, wishlistRanks, releaseDateMap] = await Promise.all([
    fetchRankMap("https://raw.githubusercontent.com/qwe321qwe321qwe321/maets-rank-cron/main/top_seller_rank.csv"),
    fetchRankMap("https://raw.githubusercontent.com/qwe321qwe321qwe321/maets-rank-cron/main/wishlist_rank.csv"),
    fetchReleaseDates(newReleasesAppIds),
  ]);

  const upcomingAppIds = [...new Set(
    results.flatMap((r) => (r?.tabData?.popularUpcoming ?? []).map((i) => i.appId))
  )];

  const followerMap = new Map();
  if (upcomingAppIds.length > 0) {
    const httpProxies = await getHttpProxies({ webshareApiKey: process.env.WEBSHARE_API_KEY }).catch(() => []);
    let first = true;
    for (const appId of upcomingAppIds) {
      if (!first) await new Promise((r) => setTimeout(r, 3000));
      first = false;
      const count = await fetchSteamFollowers(appId, httpProxies);
      followerMap.set(appId, count);
      console.log(`[followers] ${appId}: ${count}`);
    }
  }

  return { topSellerRanks, wishlistRanks, followerMap, releaseDateMap };
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
        let discount = null;
        if (config.key === "specials") {
          const discountElem = item.querySelector(".discount_pct");
          if (discountElem) discount = (discountElem.innerText || discountElem.textContent || "").trim();
        }
        if (appId && name && !result[config.key].some((t) => t.appId === appId)) {
          result[config.key].push(discount ? { appId, name, discount } : { appId, name });
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

async function postToChannel(channelId, botToken, screenshotPath, htmlPath, tabData, label, unixTs, isoDate, showButton, enrichments = null) {
  const { topSellerRanks, wishlistRanks, followerMap, releaseDateMap } = enrichments ?? {};
  const tabLabels = [
    { key: "popularNewReleases", label: "Popular New Releases" },
    { key: "topSellers", label: "Top Sellers" },
    { key: "popularUpcoming", label: "Popular Upcoming" },
    { key: "specials", label: "Specials" },
    { key: "trendingFree", label: "Trending Free" },
  ];
  const sections = [];
  for (const { key, label: tabLabel } of tabLabels) {
    const itemLines = [];
    const items = tabData[key];
    if (items.length === 0) {
      itemLines.push("-# (no data)");
    } else {
      items.forEach((item, i) => {
        let suffix = "";
        if (enrichments) {
          if (key === "popularNewReleases") {
            const rank = topSellerRanks?.get(item.appId);
            if (rank != null) {
              const emoji = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank <= 10 ? "🔥" : "📊";
              suffix = ` ${emoji} #${rank}`;
            }
            const dateStr = releaseDateMap?.get(item.appId);
            if (dateStr) {
              const rel = relativeTime(dateStr);
              suffix += ` | 📅 ${dateStr}${rel ? ` (${rel})` : ""}`;
            }
          } else if (key === "popularUpcoming") {
            const followers = followerMap?.get(item.appId);
            const wRank = wishlistRanks?.get(item.appId);
            const parts = [];
            if (followers != null) parts.push(`👥 ${fmt(followers)}`);
            if (wRank != null) parts.push(`🎯 #${wRank}`);
            if (parts.length > 0) suffix = " | " + parts.join(" | ");
          } else if (key === "specials" && item.discount) {
            suffix = ` 🏷️ ${item.discount}`;
          }
        }
        itemLines.push(`${i + 1}. ${item.name} \`${item.appId}\`${suffix}`);
      });
    }
    sections.push(`**${tabLabel}**\n${itemLines.join("\n")}`);
  }

  // Split into multiple messages if content exceeds Discord's 2000-char limit
  const messages = [];
  let current = "";
  for (const section of sections) {
    const candidate = current ? current + "\n\n" + section : section;
    if (current && candidate.length > 1900) {
      messages.push(current);
      current = section;
    } else {
      current = candidate;
    }
  }
  if (current) messages.push(current);
  const codeBlocks = messages;

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

  for (let i = 0; i < codeBlocks.length; i++) {
    const isLast = i === codeBlocks.length - 1;
    const tabRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ content: codeBlocks[i], flags: 4, ...(isLast && showButton ? { components: [CAPTURE_NOW_BUTTON] } : {}) }),
    });
    if (!tabRes.ok) {
      console.error(`Tab post failed for ${channelId} (block ${i + 1}/${codeBlocks.length}): ${tabRes.status} ${await tabRes.text()}`);
    }
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
    const cnEnrichments = cnResult ? await buildEnrichments([cnResult]) : null;
    for (const channelId of channelIds) {
      if (cnResult) {
        await postToChannel(channelId, botToken, cnResult.screenshotPath, cnResult.htmlPath, cnResult.tabData,
          `🇨🇳 Steam homepage · CN · \`${cnResult.ipLabel}\``, unixTs, isoDate, true, cnEnrichments);
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
    const enrichments = result ? await buildEnrichments([result]) : null;
    for (const channelId of channelIds) {
      if (result) {
        await postToChannel(channelId, botToken, result.screenshotPath, result.htmlPath, result.tabData,
          `${label} · \`${result.ipLabel}\``, unixTs, isoDate, false, enrichments);
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

  const enrichments = await buildEnrichments([defaultResult, gbResult, jpResult, cnResult]);

  for (const channelId of channelIds) {
    await postToChannel(channelId, botToken, defaultResult.screenshotPath, defaultResult.htmlPath, defaultResult.tabData, `🌐 Steam homepage · Default · \`${defaultResult.ipLabel}\``, unixTs, isoDate, false, enrichments);
    if (gbResult) {
      await postToChannel(channelId, botToken, gbResult.screenshotPath, gbResult.htmlPath, gbResult.tabData, `🇬🇧 Steam homepage · UK · \`${gbResult.ipLabel}\``, unixTs, isoDate, false, enrichments);
    } else {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🇬🇧 Steam homepage · UK · ⚠️ 截圖失敗: \`${gbError.message}\``, components: [RETRY_GB_BUTTON] }),
      });
    }
    if (jpResult) {
      await postToChannel(channelId, botToken, jpResult.screenshotPath, jpResult.htmlPath, jpResult.tabData, `🇯🇵 Steam homepage · Japan · \`${jpResult.ipLabel}\``, unixTs, isoDate, false, enrichments);
    } else {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ content: `🇯🇵 Steam homepage · Japan · ⚠️ 截圖失敗: \`${jpError.message}\``, components: [RETRY_JP_BUTTON] }),
      });
    }
    if (cnResult) {
      await postToChannel(channelId, botToken, cnResult.screenshotPath, cnResult.htmlPath, cnResult.tabData, `🇨🇳 Steam homepage · CN · \`${cnResult.ipLabel}\``, unixTs, isoDate, true, enrichments);
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
