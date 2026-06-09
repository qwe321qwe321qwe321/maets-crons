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

async function fetchProxyScrapeList(countryCode) {
  const candidates = [];
  for (const protocol of ["socks5", "socks4"]) {
    const url = `https://api.proxyscrape.com/v2/?request=getproxies&protocol=${protocol}&country=${countryCode}&timeout=10000&simplified=true`;
    const res = await fetch(url);
    if (!res.ok) { console.warn(`proxyscrape fetch failed (${protocol}): ${res.status}`); continue; }
    const text = await res.text();
    const lines = text.trim().split("\n").map((l) => l.trim()).filter((l) => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
    for (const line of lines) {
      candidates.push({ server: `${protocol}://${line}` });
    }
    console.log(`proxyscrape ${protocol}/${countryCode}: found ${lines.length} candidates`);
  }
  return candidates;
}

async function findWorkingFreeProxy(countryCode) {
  const candidates = await fetchProxyScrapeList(countryCode);
  if (candidates.length === 0) throw new Error(`No free proxies found for ${countryCode}`);
  const verified = [];
  console.log(`Testing up to ${Math.min(candidates.length, 20)} proxies for ${countryCode}...`);
  for (const candidate of candidates.slice(0, 20)) {
    const browser = await chromium.launch();
    try {
      const ctx = await browser.newContext({ proxy: { server: candidate.server } });
      const page = await ctx.newPage();
      const res = await page.goto("https://ipinfo.io/json", { timeout: 15000 });
      const data = await res.json().catch(() => null);
      await browser.close();
      if (data?.country === countryCode) {
        const ipLabel = `${data.ip}${data.city ? ` (${data.city}, ${data.country})` : ""}`;
        console.log(`Verified proxy: ${candidate.server} → ${ipLabel}`);
        verified.push({ server: candidate.server, ipLabel });
        if (verified.length >= 3) break;
      } else {
        console.log(`Proxy ${candidate.server}: country=${data?.country ?? "?"}, skipping`);
      }
    } catch (e) {
      console.log(`Proxy ${candidate.server} failed: ${e.message}`);
      await browser.close().catch(() => {});
    }
  }
  if (verified.length === 0) throw new Error(`No working ${countryCode} proxy found after trying up to 20 candidates`);
  return verified;
}

async function fetchProxyByCountry(countryCode) {
  const res = await fetch(
    "https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page_size=100",
    { headers: { Authorization: `Token ${process.env.WEBSHARE_API_KEY}` } }
  );
  if (!res.ok) throw new Error(`Webshare API failed: ${res.status}`);
  const json = await res.json();
  const p = json.results?.find((r) => r.country_code === countryCode && r.valid);
  if (!p) throw new Error(`No ${countryCode} proxy available`);
  const ipLabel = `${p.proxy_address} (${p.city_name}, ${p.country_code})`;
  console.log(`Using ${countryCode} proxy: ${ipLabel}`);
  return { server: `http://${p.proxy_address}:${p.port}`, username: p.username, password: p.password, ipLabel };
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

  console.log("Taking all screenshots in parallel...");
  const [defaultResult, gbResult, jpResult, cnOutcome] = await Promise.all([
    takeScreenshot(null, "default", null, "en-US", null, unixTs),
    fetchProxyByCountry("GB").then((p) => takeScreenshot(p, "gb", "gb", "en-GB", p.ipLabel, unixTs)),
    fetchProxyByCountry("JP").then((p) => takeScreenshot(p, "japan", "jp", "ja-JP", p.ipLabel, unixTs)),
    findWorkingFreeProxy("CN")
      .then(async (proxies) => {
        for (const proxy of proxies) {
          console.log(`Trying ${proxy.server} for CN screenshot...`);
          try {
            return await takeScreenshot(proxy, "cn", "cn", "zh-CN", proxy.ipLabel, unixTs, { waitUntil: "domcontentloaded", waitForContent: true, timeout: 90000 });
          } catch (e) {
            console.log(`CN screenshot failed with ${proxy.server}: ${e.message}`);
          }
        }
        throw new Error("All verified CN proxies failed to load Steam");
      })
      .catch((e) => ({ error: e })),
  ]);

  const cnResult = cnOutcome?.error ? null : cnOutcome;
  const cnError = cnOutcome?.error ?? null;
  if (cnError) console.error(`CN failed: ${cnError.message}`);

  for (const channelId of channelIds) {
    await postToChannel(channelId, botToken, defaultResult.screenshotPath, defaultResult.htmlPath, defaultResult.tabData, `🌐 Steam homepage · Default · \`${defaultResult.ipLabel}\``, unixTs, isoDate, false);
    await postToChannel(channelId, botToken, gbResult.screenshotPath, gbResult.htmlPath, gbResult.tabData, `🇬🇧 Steam homepage · UK · \`${gbResult.ipLabel}\``, unixTs, isoDate, false);
    await postToChannel(channelId, botToken, jpResult.screenshotPath, jpResult.htmlPath, jpResult.tabData, `🇯🇵 Steam homepage · Japan · \`${jpResult.ipLabel}\``, unixTs, isoDate, false);
    if (cnResult) {
      await postToChannel(channelId, botToken, cnResult.screenshotPath, cnResult.htmlPath, cnResult.tabData, `🇨🇳 Steam homepage · CN · \`${cnResult.ipLabel}\``, unixTs, isoDate, true);
    } else {
      await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          content: `🇨🇳 Steam homepage · CN · ⚠️ 截圖失敗: \`${cnError.message}\``,
          components: [CAPTURE_NOW_BUTTON],
        }),
      });
    }
  }

  fs.unlinkSync(defaultResult.screenshotPath);
  fs.unlinkSync(defaultResult.htmlPath);
  fs.unlinkSync(gbResult.screenshotPath);
  fs.unlinkSync(gbResult.htmlPath);
  fs.unlinkSync(jpResult.screenshotPath);
  fs.unlinkSync(jpResult.htmlPath);
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
