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

async function takeUrlScreenshot(targetUrl, proxy, slug, knownIpLabel = null, options = {}) {
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
  await page.waitForTimeout(options.waitAfterScroll ?? 3000);
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

// Returns proxy country keys to capture in addition to 'default'
function parseCountries(countries) {
  if (!countries || countries === "all") return ["gb", "jp", "cn"];
  if (countries === "none") return [];
  return countries.split(",").map((c) => c.trim().toLowerCase()).filter((c) => ["gb", "jp", "cn"].includes(c));
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
  const cc = country.toUpperCase();
  const proxies = await getBrowserProxies(cc);
  for (const proxy of proxies) {
    console.log(`Trying ${proxy.server} for ${cc}...`);
    try {
      return await takeUrlScreenshot(targetUrl, proxy, slug, proxy.ipLabel, { waitAfterScroll: 20000 });
    } catch (e) {
      console.log(`${cc} failed with ${proxy.server}: ${e.message}`);
    }
  }
  throw new Error(`All verified ${cc} proxies failed`);
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
      "SELECT guild_id, channel_id, url, countries FROM tracked_screenshot_urls WHERE channel_id = ?",
      [channelIdFilter]
    );
  } else {
    rows = await d1("SELECT guild_id, channel_id, url, countries FROM tracked_screenshot_urls");
  }

  if (rows.length === 0) {
    console.log("No tracked URLs, skipping.");
    return;
  }

  const unixTs = Math.floor(Date.now() / 1000);

  // Retry mode: only one country
  if (countryFilter) {
    if (!COUNTRY_META[countryFilter]) throw new Error(`Unknown COUNTRY: ${countryFilter}`);
    const { emoji } = COUNTRY_META[countryFilter];
    console.log(`Retry mode: country=${countryFilter}`);

    for (const row of rows) {
      // Skip if this URL's config doesn't include the country being retried
      const rowCountries = ["default", ...parseCountries(row.countries || "all")];
      if (!rowCountries.includes(countryFilter)) {
        console.log(`Skipping ${row.url} (not in config: ${row.countries})`);
        continue;
      }
      console.log(`\nProcessing [${countryFilter}]: ${row.url}`);
      const result = await captureForCountry(row.url, countryFilter).catch((e) => ({ error: e }));

      if (result.error) {
        console.error(`${countryFilter} failed: ${result.error.message}`);
        await postError(row.channel_id, botToken, emoji, result.error.message, retryUrlButton(countryFilter));
      } else {
        const button = countryFilter === "cn" ? CAPTURE_URL_NOW_BUTTON : null;
        await postUrlScreenshot(row.channel_id, botToken, result.screenshotPath, result.htmlPath,
          `${emoji} \`${result.ipLabel}\``, row.url, unixTs, button);
        fs.unlinkSync(result.screenshotPath);
        fs.unlinkSync(result.htmlPath);
      }
    }

    console.log("Done:", new Date().toISOString());
    return;
  }

  // Normal mode: group by (url, countries) to avoid duplicate captures
  const groups = new Map();
  for (const row of rows) {
    const key = `${row.url}\x00${row.countries || "all"}`;
    if (!groups.has(key)) groups.set(key, { url: row.url, countries: row.countries || "all", channelIds: [] });
    const g = groups.get(key);
    if (!g.channelIds.includes(row.channel_id)) g.channelIds.push(row.channel_id);
  }

  for (const { url: targetUrl, countries: countriesConfig, channelIds } of groups.values()) {
    const countriesToCapture = ["default", ...parseCountries(countriesConfig)];
    console.log(`\nProcessing: ${targetUrl} [${countriesConfig}] (channels: ${channelIds.join(", ")})`);

    const outcomes = await Promise.all(
      countriesToCapture.map((c) => captureForCountry(targetUrl, c).catch((e) => ({ error: e })))
    );

    for (const channelId of channelIds) {
      let isFirst = true;
      for (let i = 0; i < countriesToCapture.length; i++) {
        const country = countriesToCapture[i];
        const outcome = outcomes[i];
        const { emoji } = COUNTRY_META[country];

        if (outcome.error) {
          console.error(`${country} failed: ${outcome.error.message}`);
          await postError(channelId, botToken, emoji, outcome.error.message, retryUrlButton(country));
        } else {
          const isLast = i === countriesToCapture.length - 1;
          const button = isLast ? CAPTURE_URL_NOW_BUTTON : null;
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
