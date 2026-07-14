"use strict";

// Module-level state (persists within a process run)
let _webshareUnavailable = false;
let _cachedHttpProxies = null;

async function _fetchWebshareList(apiKey, pageSize) {
  if (_webshareUnavailable) return null;
  try {
    const res = await fetch(
      `https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page_size=${pageSize}`,
      { headers: { Authorization: `Token ${apiKey}` } }
    );
    if (!res.ok) {
      console.warn(`[proxy-lib] Webshare ${res.status}, switching to free proxies`);
      _webshareUnavailable = true;
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`[proxy-lib] Webshare error: ${e.message}, switching to free proxies`);
    _webshareUnavailable = true;
    return null;
  }
}

async function _fetchProxyScrapeList(cc, protocols) {
  const candidates = [];
  for (const protocol of protocols) {
    const ccParam = cc ? `&country=${cc}` : "";
    const url = `https://api.proxyscrape.com/v2/?request=getproxies&protocol=${protocol}${ccParam}&timeout=10000&simplified=true`;
    try {
      const res = await fetch(url);
      if (!res.ok) { console.warn(`[proxy-lib] proxyscrape ${protocol} ${res.status}`); continue; }
      const text = await res.text();
      const lines = text.trim().split("\n").map(l => l.trim()).filter(l => /^\d+\.\d+\.\d+\.\d+:\d+$/.test(l));
      for (const line of lines) candidates.push({ server: `${protocol}://${line}` });
      console.log(`[proxy-lib] proxyscrape ${protocol}${cc ? `/${cc}` : ""}: ${lines.length}`);
    } catch (e) {
      console.warn(`[proxy-lib] proxyscrape ${protocol} error: ${e.message}`);
    }
  }
  return candidates;
}

function _forceClose(browser) {
  return Promise.race([
    browser.close().catch(() => {}),
    new Promise(resolve => setTimeout(resolve, 5000)),
  ]);
}

async function _verifyBrowserProxy(proxyServer, expectedCountry) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ proxy: { server: proxyServer } });
    const page = await ctx.newPage();
    const res = await page.goto("https://ipinfo.io/json", { timeout: 12000 });
    const data = await res.json().catch(() => null);
    await _forceClose(browser);
    if (data?.country === expectedCountry) {
      return `${data.ip}${data.city ? ` (${data.city}, ${data.country})` : ""}`;
    }
    console.log(`[proxy-lib] ${proxyServer}: country=${data?.country ?? "?"}, skipping`);
    return null;
  } catch (e) {
    console.log(`[proxy-lib] ${proxyServer} failed: ${e.message}`);
    await _forceClose(browser);
    return null;
  }
}

/**
 * Get verified browser proxies for a country (for Playwright).
 *
 * If webshareApiKey is provided, tries Webshare first; automatically falls back
 * to free proxyscrape proxies when Webshare is unavailable or has no matching proxy.
 * The Webshare unavailability state is cached for the remainder of the process run.
 *
 * Returns [{ server, username?, password?, ipLabel }]
 */
async function getBrowserProxies(cc, { webshareApiKey = null, maxVerified = 3, maxCandidates = 20 } = {}) {
  if (webshareApiKey && !_webshareUnavailable) {
    const json = await _fetchWebshareList(webshareApiKey, 100);
    if (json) {
      const matches = (json.results ?? []).filter(p => p.country_code === cc && p.valid);
      if (matches.length > 0) {
        console.log(`[proxy-lib] Using ${Math.min(matches.length, maxVerified)} Webshare proxy(s) for ${cc}`);
        return matches.slice(0, maxVerified).map(p => ({
          server: `http://${p.proxy_address}:${p.port}`,
          username: p.username,
          password: p.password,
          ipLabel: `${p.proxy_address} (${[p.city_name, p.country_code].filter(Boolean).join(", ")})`,
        }));
      }
      console.warn(`[proxy-lib] No Webshare proxy for ${cc}, trying free proxies`);
    }
  }

  const candidates = await _fetchProxyScrapeList(cc, ["socks5", "socks4"]);
  if (candidates.length === 0) throw new Error(`No free proxy candidates for ${cc}`);

  const verified = [];
  const limit = Math.min(candidates.length, maxCandidates);
  console.log(`[proxy-lib] Testing up to ${limit} free proxies for ${cc}...`);
  for (const c of candidates.slice(0, limit)) {
    const ipLabel = await _verifyBrowserProxy(c.server, cc);
    if (ipLabel) {
      console.log(`[proxy-lib] Verified ${c.server} → ${ipLabel}`);
      verified.push({ server: c.server, ipLabel });
      if (verified.length >= maxVerified) break;
    }
  }
  if (verified.length === 0) throw new Error(`No working free proxy for ${cc} after testing ${limit} candidates`);
  return verified;
}

/**
 * Get HTTP proxy strings for undici ProxyAgent rotation.
 *
 * If webshareApiKey is provided, tries Webshare first; falls back to free HTTP
 * proxies when Webshare is unavailable. Result is cached for the process run.
 *
 * Returns ["http://user:pass@host:port" | "http://host:port", ...]
 */
async function getHttpProxies({ webshareApiKey = null, pageSize = 25 } = {}) {
  if (_cachedHttpProxies) return _cachedHttpProxies;

  if (webshareApiKey && !_webshareUnavailable) {
    const json = await _fetchWebshareList(webshareApiKey, pageSize);
    if (json) {
      const proxies = (json.results ?? [])
        .filter(p => p.valid)
        .map(p => `http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`);
      if (proxies.length > 0) {
        console.log(`[proxy-lib] Loaded ${proxies.length} Webshare HTTP proxies`);
        _cachedHttpProxies = proxies;
        return proxies;
      }
    }
  }

  console.log(`[proxy-lib] Falling back to free HTTP proxies`);
  const candidates = await _fetchProxyScrapeList(null, ["http"]);
  _cachedHttpProxies = candidates.slice(0, pageSize).map(c => c.server);
  console.log(`[proxy-lib] Loaded ${_cachedHttpProxies.length} free HTTP proxies`);
  return _cachedHttpProxies;
}

/**
 * Block image/media/font requests on a Playwright page to save proxy bandwidth.
 * Intended for proxied navigations where a visually perfect screenshot matters
 * less than the HTML content and extracted data.
 */
async function blockHeavyResources(page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font") {
      return route.abort();
    }
    return route.continue();
  });
}

/**
 * Sanitize untrusted text (scraped DOM text, API names, etc.) for safe use as
 * the label of a Discord Markdown link `[label](url)`. Collapses embedded
 * newlines/whitespace (which otherwise break link parsing entirely) and
 * backslash-escapes Markdown special characters (which otherwise corrupt
 * formatting for the rest of the message).
 */
function sanitizeMdLinkText(text) {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_~|[\]]/g, "\\$&");
}

module.exports = { getBrowserProxies, getHttpProxies, blockHeavyResources, sanitizeMdLinkText };
