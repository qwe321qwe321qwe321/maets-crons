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

async function fetchFreeProxyWorldList(countryCode) {
  const candidates = [];
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    for (const type of ["socks5", "socks4"]) {
      const url = `https://www.freeproxy.world/?type=${type}&country=${countryCode.toLowerCase()}`;
      const page = await context.newPage();
      try {
        await page.goto(url, { waitUntil: "load", timeout: 30000 });
        await page.waitForSelector("table", { timeout: 10000 }).catch(() => {});
        const debug = await page.evaluate(() => ({
          title: document.title,
          allTrs: document.querySelectorAll("tr").length,
          bodySnippet: document.body?.innerHTML?.slice(0, 800),
        }));
        console.log(`freeproxy.world ${type}/${countryCode} debug:`, JSON.stringify(debug));
        const rows = await page.$$eval("table tbody tr", (trs) =>
          trs.flatMap((tr) => {
            const tds = tr.querySelectorAll("td");
            const ip = tds[0]?.textContent?.trim();
            const port = tds[1]?.textContent?.trim();
            return ip && port && /^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && /^\d+$/.test(port)
              ? [{ ip, port }]
              : [];
          })
        );
        for (const { ip, port } of rows) {
          candidates.push({ server: `${type}://${ip}:${port}` });
        }
        console.log(`freeproxy.world ${type}/${countryCode}: found ${rows.length} candidates`);
      } catch (e) {
        console.warn(`freeproxy.world scrape failed (${type}): ${e.message}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return candidates;
}

async function findWorkingFreeProxy(countryCode) {
  const candidates = await fetchFreeProxyWorldList(countryCode);
  if (candidates.length === 0) throw new Error(`No free proxies found for ${countryCode}`);
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
        console.log(`Working proxy: ${candidate.server} → ${ipLabel}`);
        return { server: candidate.server, ipLabel };
      }
      console.log(`Proxy ${candidate.server}: country=${data?.country ?? "?"}, skipping`);
    } catch (e) {
      console.log(`Proxy ${candidate.server} failed: ${e.message}`);
      await browser.close().catch(() => {});
    }
  }
  throw new Error(`No working ${countryCode} proxy found after trying up to 20 candidates`);
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

async function takeScreenshot(proxy, slug, cc, locale = "en-US", knownIpLabel = null, unixTs) {
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
  if (locale !== "en-US") params.set("l", locale.split("-")[0] === "ja" ? "japanese" : locale.split("-")[0]);
  const query = params.toString();
  const url = `https://store.steampowered.com/${query ? `?${query}` : ""}`;

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

  const htmlContent = await page.content();
  const htmlPath = path.join(__dirname, `${unixTs}_${slug}.html`);
  fs.writeFileSync(htmlPath, htmlContent, "utf8");

  await browser.close();

  return { screenshotPath, htmlPath, tabData, ipLabel };
}

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
  const htmlBuffer = fs.readFileSync(htmlPath);
  const htmlFilename = path.basename(htmlPath);
  const formData = new FormData();
  formData.append("files[0]", new Blob([imageBuffer], { type: "image/png" }), "steam_homepage.png");
  formData.append("files[1]", new Blob([htmlBuffer], { type: "text/html" }), htmlFilename);
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

  const freeProxyMode = process.env.FREE_PROXY_MODE === "true";
  const freeProxyCountry = (process.env.FREE_PROXY_COUNTRY || "CN").toUpperCase();

  if (freeProxyMode) {
    console.log(`Fetching free ${freeProxyCountry} proxy from freeproxy.world...`);
    const cnProxy = await findWorkingFreeProxy(freeProxyCountry);
    const slug = freeProxyCountry.toLowerCase();
    console.log(`Taking ${freeProxyCountry} screenshot...`);
    const result = await takeScreenshot(cnProxy, slug, freeProxyCountry.toLowerCase(), "en-US", cnProxy.ipLabel, unixTs);
    const cc = freeProxyCountry;
    const flag = cc.split("").map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
    for (const channelId of channelIds) {
      await postToChannel(channelId, botToken, result.screenshotPath, result.htmlPath, result.tabData,
        `${flag} Steam homepage · ${cc} (freeproxy.world) · \`${result.ipLabel}\``, unixTs, isoDate, true);
    }
    fs.unlinkSync(result.screenshotPath);
    fs.unlinkSync(result.htmlPath);
    console.log("Done:", new Date().toISOString());
    return;
  }

  console.log("Taking default screenshot...");
  const { screenshotPath: defaultPath, htmlPath: defaultHtml, tabData: defaultTabs, ipLabel: defaultIp } = await takeScreenshot(null, "default", null, "en-US", null, unixTs);

  console.log("Fetching GB proxy...");
  const gbProxy = await fetchProxyByCountry("GB");
  console.log("Taking GB screenshot...");
  const { screenshotPath: gbPath, htmlPath: gbHtml, tabData: gbTabs, ipLabel: gbIp } = await takeScreenshot(gbProxy, "gb", "gb", "en-GB", gbProxy.ipLabel, unixTs);

  console.log("Fetching JP proxy...");
  const jpProxy = await fetchProxyByCountry("JP");
  console.log("Taking JP screenshot...");
  const { screenshotPath: jpPath, htmlPath: jpHtml, tabData: jpTabs, ipLabel: jpIp } = await takeScreenshot(jpProxy, "japan", "jp", "ja-JP", jpProxy.ipLabel, unixTs);

  for (const channelId of channelIds) {
    await postToChannel(channelId, botToken, defaultPath, defaultHtml, defaultTabs, `🌐 Steam homepage · Default · \`${defaultIp}\``, unixTs, isoDate, false);
    await postToChannel(channelId, botToken, gbPath, gbHtml, gbTabs, `🇬🇧 Steam homepage · UK · \`${gbIp}\``, unixTs, isoDate, false);
    await postToChannel(channelId, botToken, jpPath, jpHtml, jpTabs, `🇯🇵 Steam homepage · Japan · \`${jpIp}\``, unixTs, isoDate, true);
  }

  fs.unlinkSync(defaultPath);
  fs.unlinkSync(defaultHtml);
  fs.unlinkSync(gbPath);
  fs.unlinkSync(gbHtml);
  fs.unlinkSync(jpPath);
  fs.unlinkSync(jpHtml);
  console.log("Done:", new Date().toISOString());
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
