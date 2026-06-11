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
    for (const line of lines) candidates.push({ server: `${protocol}://${line}` });
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

async function takeUrlScreenshot(targetUrl, proxy, slug, knownIpLabel = null) {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
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
  console.log(`[${slug}] ${ipLabel} → ${targetUrl}`);

  const page = await context.newPage();
  await page.goto(targetUrl, { waitUntil: "networkidle", timeout: 60000 });

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
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));

  const ts = Date.now();
  const screenshotPath = path.join(__dirname, `url_screenshot_${slug}_${ts}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const htmlContent = await page.content();
  const htmlPath = path.join(__dirname, `url_screenshot_${slug}_${ts}.html`);
  fs.writeFileSync(htmlPath, htmlContent, "utf8");

  await browser.close();

  return { screenshotPath, htmlPath, ipLabel };
}

// country -> { emoji, slug }
const COUNTRY_META = {
  default: { emoji: "🌐", slug: "default" },
  gb:      { emoji: "🇬🇧", slug: "gb" },
  jp:      { emoji: "🇯🇵", slug: "jp" },
  cn:      { emoji: "🇨🇳", slug: "cn" },
};

const CAPTURE_URL_NOW_BUTTON = {
  type: 1,
  components: [{ type: 2, style: 1, custom_id: "capture_url_now", emoji: { name: "📸" }, label: "Capture Now" }],
};

function retryUrlButton(country) {
  return {
    type: 1,
    components: [{ type: 2, style: 4, custom_id: `retry_url_${country}`, emoji: { name: COUNTRY_META[country].emoji }, label: "再試一次" }],
  };
}

async function captureForCountry(targetUrl, country) {
  const { slug } = COUNTRY_META[country];
  if (country === "default") {
    return takeUrlScreenshot(targetUrl, null, slug);
  }
  if (country === "gb" || country === "jp") {
    const p = await fetchProxyByCountry(country.toUpperCase());
    return takeUrlScreenshot(targetUrl, p, slug, p.ipLabel);
  }
  if (country === "cn") {
    const proxies = await findWorkingFreeProxy("CN");
    for (const proxy of proxies) {
      console.log(`Trying ${proxy.server} for CN...`);
      try { return await takeUrlScreenshot(targetUrl, proxy, slug, proxy.ipLabel); }
      catch (e) { console.log(`CN failed with ${proxy.server}: ${e.message}`); }
    }
    throw new Error("All verified CN proxies failed");
  }
  throw new Error(`Unknown country: ${country}`);
}

async function postUrlScreenshot(channelId, botToken, screenshotPath, htmlPath, label, targetUrl, unixTs, button) {
  const content = targetUrl
    ? `${label} · <t:${unixTs}:F>\n<${targetUrl}>`
    : `${label} · <t:${unixTs}:F>`;
  const formData = new FormData();
  formData.append("files[0]", new Blob([fs.readFileSync(screenshotPath)], { type: "image/png" }), "screenshot.png");
  formData.append("files[1]", new Blob([fs.readFileSync(htmlPath)], { type: "text/html" }), path.basename(htmlPath));
  formData.append("payload_json", JSON.stringify({
    content,
    ...(button ? { components: [button] } : {}),
  }));
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}` },
    body: formData,
  });
  if (!res.ok) {
    console.error(`Post failed for ${channelId}: ${res.status} ${await res.text()}`);
  }
}

async function postError(channelId, botToken, emoji, errorMsg, button) {
  await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      content: `${emoji} ⚠️ 截圖失敗: \`${errorMsg}\``,
      components: [button],
    }),
  });
}

async function run() {
  const botToken = process.env.DISCORD_TOKEN;
  if (!botToken) throw new Error("DISCORD_TOKEN not set");

  const channelIdFilter = process.env.CHANNEL_ID?.trim() || null;
  const countryFilter = process.env.COUNTRY?.trim().toLowerCase() || null;

  let rows;
  if (channelIdFilter) {
    rows = await d1(
      "SELECT guild_id, channel_id, url FROM tracked_screenshot_urls WHERE channel_id = ?",
      [channelIdFilter]
    );
  } else {
    rows = await d1("SELECT guild_id, channel_id, url FROM tracked_screenshot_urls");
  }

  if (rows.length === 0) {
    console.log("No tracked URLs, skipping.");
    return;
  }

  // Group: url -> [channelId, ...]
  const urlToChannels = {};
  for (const row of rows) {
    if (!urlToChannels[row.url]) urlToChannels[row.url] = [];
    if (!urlToChannels[row.url].includes(row.channel_id)) {
      urlToChannels[row.url].push(row.channel_id);
    }
  }

  const unixTs = Math.floor(Date.now() / 1000);

  // Retry mode: only one country
  if (countryFilter) {
    if (!COUNTRY_META[countryFilter]) throw new Error(`Unknown COUNTRY: ${countryFilter}`);
    const { emoji } = COUNTRY_META[countryFilter];
    console.log(`Retry mode: country=${countryFilter}`);

    for (const [targetUrl, channelIds] of Object.entries(urlToChannels)) {
      console.log(`\nProcessing [${countryFilter}]: ${targetUrl}`);
      const result = await captureForCountry(targetUrl, countryFilter).catch((e) => ({ error: e }));

      for (const channelId of channelIds) {
        if (result.error) {
          console.error(`${countryFilter} failed: ${result.error.message}`);
          await postError(channelId, botToken, emoji, result.error.message, retryUrlButton(countryFilter));
        } else {
          const button = countryFilter === "cn" ? CAPTURE_URL_NOW_BUTTON : null;
          // Show URL in retry messages so context is clear
          await postUrlScreenshot(channelId, botToken, result.screenshotPath, result.htmlPath,
            `${emoji} \`${result.ipLabel}\``, targetUrl, unixTs, button);
        }
      }

      if (!result.error) {
        fs.unlinkSync(result.screenshotPath);
        fs.unlinkSync(result.htmlPath);
      }
    }

    console.log("Done:", new Date().toISOString());
    return;
  }

  // Normal mode: all 4 countries in parallel
  const countries = ["default", "gb", "jp", "cn"];

  for (const [targetUrl, channelIds] of Object.entries(urlToChannels)) {
    console.log(`\nProcessing: ${targetUrl} (channels: ${channelIds.join(", ")})`);

    const outcomes = await Promise.all(
      countries.map((c) => captureForCountry(targetUrl, c).catch((e) => ({ error: e })))
    );

    for (const channelId of channelIds) {
      let isFirst = true;
      for (let i = 0; i < countries.length; i++) {
        const country = countries[i];
        const outcome = outcomes[i];
        const { emoji } = COUNTRY_META[country];

        if (outcome.error) {
          console.error(`${country} failed: ${outcome.error.message}`);
          await postError(channelId, botToken, emoji, outcome.error.message, retryUrlButton(country));
        } else {
          const button = country === "cn" ? CAPTURE_URL_NOW_BUTTON : null;
          const urlToShow = isFirst ? targetUrl : null;
          await postUrlScreenshot(channelId, botToken, outcome.screenshotPath, outcome.htmlPath,
            `${emoji} \`${outcome.ipLabel}\``, urlToShow, unixTs, button);
          isFirst = false;
        }
      }
    }

    for (const outcome of outcomes) {
      if (!outcome.error) {
        fs.unlinkSync(outcome.screenshotPath);
        fs.unlinkSync(outcome.htmlPath);
      }
    }
  }

  console.log("Done:", new Date().toISOString());
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
