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

const CAPTURE_URL_NOW_BUTTON = {
  type: 1,
  components: [{ type: 2, style: 1, custom_id: "capture_url_now", emoji: { name: "📸" }, label: "Capture Now" }],
};

async function postUrlScreenshot(channelId, botToken, screenshotPath, htmlPath, label, targetUrl, unixTs, showButton) {
  const content = targetUrl
    ? `${label} · <t:${unixTs}:F>\n<${targetUrl}>`
    : `${label} · <t:${unixTs}:F>`;
  const formData = new FormData();
  formData.append("files[0]", new Blob([fs.readFileSync(screenshotPath)], { type: "image/png" }), "screenshot.png");
  formData.append("files[1]", new Blob([fs.readFileSync(htmlPath)], { type: "text/html" }), path.basename(htmlPath));
  formData.append("payload_json", JSON.stringify({
    content,
    ...(showButton ? { components: [CAPTURE_URL_NOW_BUTTON] } : {}),
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

async function run() {
  const botToken = process.env.DISCORD_TOKEN;
  if (!botToken) throw new Error("DISCORD_TOKEN not set");

  const channelIdFilter = process.env.CHANNEL_ID?.trim() || null;

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

  for (const [targetUrl, channelIds] of Object.entries(urlToChannels)) {
    console.log(`\nProcessing: ${targetUrl} (channels: ${channelIds.join(", ")})`);

    const [defaultResult, gbResult, jpResult, cnOutcome] = await Promise.all([
      takeUrlScreenshot(targetUrl, null, "default"),
      fetchProxyByCountry("GB").then((p) => takeUrlScreenshot(targetUrl, p, "gb", p.ipLabel)),
      fetchProxyByCountry("JP").then((p) => takeUrlScreenshot(targetUrl, p, "jp", p.ipLabel)),
      findWorkingFreeProxy("CN")
        .then(async (proxies) => {
          for (const proxy of proxies) {
            console.log(`Trying ${proxy.server} for CN...`);
            try { return await takeUrlScreenshot(targetUrl, proxy, "cn", proxy.ipLabel); }
            catch (e) { console.log(`CN failed with ${proxy.server}: ${e.message}`); }
          }
          throw new Error("All verified CN proxies failed");
        })
        .catch((e) => ({ error: e })),
    ]);

    const cnResult = cnOutcome?.error ? null : cnOutcome;
    const cnError = cnOutcome?.error ?? null;
    if (cnError) console.error(`CN failed: ${cnError.message}`);

    for (const channelId of channelIds) {
      // Only the first message includes the URL (no embed via <url>)
      await postUrlScreenshot(channelId, botToken, defaultResult.screenshotPath, defaultResult.htmlPath, `🌐 \`${defaultResult.ipLabel}\``, targetUrl, unixTs, false);
      await postUrlScreenshot(channelId, botToken, gbResult.screenshotPath, gbResult.htmlPath, `🇬🇧 \`${gbResult.ipLabel}\``, null, unixTs, false);
      await postUrlScreenshot(channelId, botToken, jpResult.screenshotPath, jpResult.htmlPath, `🇯🇵 \`${jpResult.ipLabel}\``, null, unixTs, false);
      if (cnResult) {
        await postUrlScreenshot(channelId, botToken, cnResult.screenshotPath, cnResult.htmlPath, `🇨🇳 \`${cnResult.ipLabel}\``, null, unixTs, true);
      } else {
        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `🇨🇳 CN · ⚠️ 截圖失敗: \`${cnError.message}\``,
            components: [CAPTURE_URL_NOW_BUTTON],
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
  }

  console.log("Done:", new Date().toISOString());
}

run().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
