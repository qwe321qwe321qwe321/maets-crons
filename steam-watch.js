const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const WEBSHARE_API_KEY = process.env.WEBSHARE_API_KEY;

const { ProxyAgent, fetch: proxyFetch } = require('undici');

let webshareProxies = null;

async function loadWebshareProxies() {
	if (webshareProxies !== null) return webshareProxies;
	if (!WEBSHARE_API_KEY) { webshareProxies = []; return []; }
	try {
		const res = await fetch('https://proxy.webshare.io/api/v2/proxy/list/?mode=direct&page=1&page_size=25', {
			headers: { 'Authorization': `Token ${WEBSHARE_API_KEY}` },
		});
		if (!res.ok) { webshareProxies = []; return []; }
		const json = await res.json();
		webshareProxies = (json.results ?? []).map(p =>
			`http://${p.username}:${p.password}@${p.proxy_address}:${p.port}`
		);
		console.log(`[webshare] loaded ${webshareProxies.length} proxies`);
	} catch (e) {
		console.error(`[webshare] failed to load proxies: ${e}`);
		webshareProxies = [];
	}
	return webshareProxies;
}

const D1_URL = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${CF_D1_DATABASE_ID}/query`;

async function d1(sql, params = []) {
	const res = await fetch(D1_URL, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${CF_API_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ sql, params }),
	});
	const json = await res.json();
	if (!json.success) throw new Error(`D1 error: ${JSON.stringify(json.errors)}`);
	return json.result[0].results;
}

async function fetchSteamAppInfo(appid) {
	const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
	if (!res.ok) return null;
	const json = await res.json();
	const data = json[appid]?.success ? json[appid].data : null;
	if (!data) return null;
	return {
		name: data.name,
		comingSoon: data.release_date?.coming_soon ?? false,
		releaseDate: data.release_date?.date ?? null,
	};
}

async function fetchSteamReviews(appid) {
	const res = await fetch(
		`https://store.steampowered.com/appreviews/${appid}?json=1&num_per_page=0&language=all&purchase_type=all&filter_offtopic_activity=0`
	);
	if (!res.ok) return null;
	const json = await res.json();
	if (json.success !== 1 || !json.query_summary) return null;
	return {
		total: json.query_summary.total_reviews,
		positive: json.query_summary.total_positive,
		scoreDesc: json.query_summary.review_score_desc,
	};
}

function generateSessionId() {
	const bytes = new Uint8Array(12);
	crypto.getRandomValues(bytes);
	return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

const FOLLOWER_BACKOFF_DELAYS = [15000, 30000, 60000];

async function fetchSteamFollowers(appid, attempt = 0) {
	const sessionid = generateSessionId();
	const url = `https://steamcommunity.com/search/SearchCommunityAjax?text=${appid}&filter=groups&sessionid=${sessionid}&steamid_user=false`;
	const headers = {
		'Cookie': `sessionid=${sessionid}`,
		'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
		'Referer': 'https://steamcommunity.com/search/groups',
	};

	const proxies = await loadWebshareProxies();
	let res;
	if (attempt > 0 && proxies.length > 0) {
		const proxyUrl = proxies[(attempt - 1) % proxies.length];
		console.log(`[followers][${appid}] attempt ${attempt} via proxy ${proxyUrl.split('@')[1]}`);
		res = await proxyFetch(url, { headers, dispatcher: new ProxyAgent(proxyUrl) });
	} else {
		res = await fetch(url, { headers });
	}

	if (res.status === 429) {
		if (proxies.length > 0) {
			// rotate to next proxy immediately, no wait needed
			const nextProxy = attempt < proxies.length
				? proxies[attempt % proxies.length]
				: null;
			if (nextProxy) {
				console.warn(`[followers][${appid}] 429, rotating proxy (attempt ${attempt + 1})`);
				return fetchSteamFollowers(appid, attempt + 1);
			}
		}
		// no proxy available (or exhausted) — progressive backoff
		const delay = FOLLOWER_BACKOFF_DELAYS[attempt - proxies.length] ?? null;
		if (delay == null) {
			console.error(`[followers][${appid}] 429, giving up`);
			return null;
		}
		console.warn(`[followers][${appid}] 429, waiting ${delay / 1000}s (attempt ${attempt + 1})`);
		await new Promise(r => setTimeout(r, delay));
		return fetchSteamFollowers(appid, attempt + 1);
	}
	if (!res.ok) {
		console.error(`[followers][${appid}] HTTP ${res.status}`);
		return null;
	}
	const json = await res.json();
	if (json.success !== 1 || !json.html) {
		console.error(`[followers][${appid}] success=${json.success} html=${json.html ? json.html.slice(0, 200) : '(empty)'}`);
		return null;
	}
	if (!json.html.includes(`/app/${appid}`)) {
		console.error(`[followers][${appid}] /app/${appid} not found — first 300 chars: ${json.html.slice(0, 300)}`);
		return null;
	}
	const match = json.html.match(/<span[^>]*>([\d,]+)<\/span>\s*members in this group/);
	if (!match) {
		console.error(`[followers][${appid}] regex no match — snippet: ${json.html.slice(0, 300)}`);
		return null;
	}
	return parseInt(match[1].replace(/,/g, ''), 10);
}

async function fetchWishlistRanks() {
	const res = await fetch(
		'https://raw.githubusercontent.com/qwe321qwe321qwe321/maets-wishlist-rank-cron/main/wishlist_rank.csv'
	);
	if (!res.ok) return new Map();
	const text = await res.text();
	const map = new Map();
	for (const line of text.split('\n').slice(1)) {
		const [rank, appid] = line.trim().split(',');
		if (rank && appid) map.set(appid, parseInt(rank, 10));
	}
	return map;
}

function fmt(n) {
	return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function fmtDelta(current, prev) {
	if (prev == null) return fmt(current);
	const delta = current - prev;
	const sign = delta >= 0 ? '+' : '';
	return `${fmt(current)} (${sign}${fmt(delta)})`;
}

function isFollowerGrowthPeak(current, history) {
	if (current == null || history.length === 0) return false;
	const todayDelta = current - history[0];
	if (todayDelta < 10) return false;
	for (let i = 0; i < history.length - 1; i++) {
		if (history[i] - history[i + 1] >= todayDelta) return false;
	}
	return true;
}

function fmtGrowthRate(current, prev7d) {
	if (prev7d == null || prev7d === 0) return null;
	const delta = current - prev7d;
	const rate = (delta / prev7d) * 100;
	const sign = delta >= 0 ? '+' : '';
	return `${sign}${fmt(delta)} (${sign}${rate.toFixed(1)}%)`;
}

const REFRESH_BUTTON = {
	type: 1,
	components: [{
		type: 2,
		style: 2,
		custom_id: 'refresh',
		emoji: { name: '🔄' },
		label: 'Refresh',
	}],
};

async function sendMessage(channelId, content, withButton = false) {
	await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: 'POST',
		headers: {
			'Authorization': `Bot ${DISCORD_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			content,
			flags: 4,
			...(withButton ? { components: [REFRESH_BUTTON] } : {}),
		}),
	});
}

async function runAppInfoRefresh() {
	const rows = await d1('SELECT DISTINCT appid FROM tracked_apps WHERE enabled = 1');
	for (const { appid } of rows) {
		const appInfo = await fetchSteamAppInfo(appid);
		if (!appInfo) continue;
		await d1(
			'UPDATE tracked_apps SET app_name = ?, coming_soon = ?, release_date = ? WHERE appid = ?',
			[appInfo.name, appInfo.comingSoon ? 1 : 0, appInfo.releaseDate, appid]
		);
		console.log(`Refreshed ${appInfo.name} (${appid}): comingSoon=${appInfo.comingSoon}`);
	}
}

async function runDailyReport(filterChannelId = '') {
	const tracked = filterChannelId
		? await d1(
			'SELECT id, guild_id, channel_id, appid, app_name, coming_soon, release_date FROM tracked_apps WHERE channel_id = ? AND enabled = 1',
			[filterChannelId]
		)
		: await d1(
			'SELECT id, guild_id, channel_id, appid, app_name, coming_soon, release_date FROM tracked_apps WHERE enabled = 1'
		);
	if (tracked.length === 0) return;

	const uniqueAppIds = [...new Set(tracked.map(r => r.appid))];
	const wishlistRanks = await fetchWishlistRanks();

	const dataMap = new Map();

	// Phase 1 (parallel): reviews + DB reads
	const baseData = await Promise.all(uniqueAppIds.map(async appid => {
		const cachedEntry = tracked.find(r => r.appid === appid);
		const comingSoon = Boolean(cachedEntry?.coming_soon);
		const releaseDate = cachedEntry?.release_date ?? null;
		const [reviews, prev, prev7d, followerHistoryRows] = await Promise.all([
			fetchSteamReviews(appid),
			d1(
				"SELECT followers, reviews_total, review_score, wishlist_rank FROM snapshots WHERE appid = ? AND strftime('%Y-%m-%d', checked_at) < strftime('%Y-%m-%d', 'now') ORDER BY checked_at DESC LIMIT 1",
				[appid]
			).then(r => r[0] ?? null),
			d1(
				"SELECT followers, reviews_total, review_score, wishlist_rank FROM snapshots WHERE appid = ? AND strftime('%Y-%m-%d', checked_at) <= strftime('%Y-%m-%d', datetime('now', '-7 days')) ORDER BY checked_at DESC LIMIT 1",
				[appid]
			).then(r => r[0] ?? null),
			comingSoon
				? d1(
					"SELECT followers FROM snapshots WHERE appid = ? AND strftime('%Y-%m-%d', checked_at) < strftime('%Y-%m-%d', 'now') ORDER BY checked_at DESC LIMIT 7",
					[appid]
				)
				: Promise.resolve([]),
		]);
		return { appid, comingSoon, releaseDate, reviews, prev, prev7d, followerHistoryRows };
	}));

	// Phase 2 (sequential with delay): follower fetches one at a time to avoid Steam rate limiting
	const followerMap = new Map();
	let firstFollower = true;
	for (const { appid, comingSoon } of baseData) {
		if (comingSoon) {
			if (!firstFollower) await new Promise(r => setTimeout(r, 3000));
			firstFollower = false;
			followerMap.set(appid, await fetchSteamFollowers(appid));
		} else {
			followerMap.set(appid, null);
		}
	}

	// Phase 3: write snapshots + populate dataMap
	for (const { appid, comingSoon, releaseDate, reviews, prev, prev7d, followerHistoryRows } of baseData) {
		const followers = followerMap.get(appid) ?? null;
		const reviewScore = reviews && reviews.total > 0
			? Math.round((reviews.positive / reviews.total) * 100)
			: null;

		await d1(
			"DELETE FROM snapshots WHERE appid = ? AND strftime('%Y-%m-%d', checked_at) = strftime('%Y-%m-%d', 'now')",
			[appid]
		);

		const wishlistRank = wishlistRanks.get(appid) ?? null;

		await d1(
			'INSERT INTO snapshots (appid, checked_at, followers, reviews_total, review_score, wishlist_rank) VALUES (?, ?, ?, ?, ?, ?)',
			[appid, new Date().toISOString(), followers, reviews?.total ?? null, reviewScore, wishlistRank]
		);

		const followerHistory = followerHistoryRows
			.map(r => r.followers)
			.filter(f => f != null);

		dataMap.set(appid, { comingSoon, releaseDate, reviews, followers, prev, prev7d, followerHistory, reviewScore, wishlistRank });
	}

	const byChannel = new Map();
	for (const app of tracked) {
		const list = byChannel.get(app.channel_id) ?? [];
		list.push(app);
		byChannel.set(app.channel_id, list);
	}

	const unixTs = Math.floor(Date.now() / 1000);
	const isoDate = new Date().toISOString();

	for (const [channelId, apps] of byChannel) {
		const header = `**Steam Watch · ${isoDate}**\n<t:${unixTs}:F>`;
		const blocks = [];

		const sortedApps = [...apps].sort((a, b) => {
			const da = dataMap.get(a.appid);
			const db = dataMap.get(b.appid);
			// group 0: coming soon with wishlist rank, 1: coming soon unranked, 2: released
			const groupA = !da?.comingSoon ? 2 : (da.wishlistRank != null ? 0 : 1);
			const groupB = !db?.comingSoon ? 2 : (db.wishlistRank != null ? 0 : 1);
			if (groupA !== groupB) return groupA - groupB;
			if (groupA === 0) return da.wishlistRank - db.wishlistRank;
			if (groupA === 1) return (db.followers ?? -1) - (da.followers ?? -1);
			return (db.reviews?.total ?? -1) - (da.reviews?.total ?? -1);
		});

		for (const app of sortedApps) {
			const d = dataMap.get(app.appid);
			if (!d) continue;

			const titleLine = `**[${app.app_name ?? app.appid}](https://store.steampowered.com/app/${app.appid}/)** \`${app.appid}\``;

			let statsLine;
			if (d.comingSoon) {
				const prevRank = d.prev?.wishlist_rank ?? null;
				let wishlistStr = 'N/A';
				if (d.wishlistRank != null) {
					wishlistStr = `#${fmt(d.wishlistRank)}`;
					if (prevRank != null) {
						const delta = prevRank - d.wishlistRank;
						const sign = delta > 0 ? '▲' : delta < 0 ? '▼' : '–';
						wishlistStr += delta !== 0 ? ` (${sign}${fmt(Math.abs(delta))})` : ' (–)';
					}
				}
				const followersStr = d.followers != null ? fmtDelta(d.followers, d.prev?.followers ?? null) : 'N/A';
				const isPeak = isFollowerGrowthPeak(d.followers, d.followerHistory);
				const growth7d = d.followers != null ? fmtGrowthRate(d.followers, d.prev7d?.followers ?? null) : null;
				statsLine = `👥 ${followersStr}${isPeak ? ' 🔥' : ''}${growth7d ? ` | 📈 7d: ${growth7d}` : ''} | 🎯 ${wishlistStr}\n-# 📅 ${d.releaseDate ?? 'TBA'}`;
			} else {
				const reviewsStr = d.reviews ? fmtDelta(d.reviews.total, d.prev?.reviews_total ?? null) : 'N/A';
				const growth7d = d.reviews ? fmtGrowthRate(d.reviews.total, d.prev7d?.reviews_total ?? null) : null;
				const scoreStr = d.reviewScore != null ? `${d.reviewScore}%` : 'N/A';
				statsLine = `📝 ${reviewsStr}${growth7d ? ` | 📈 7d: ${growth7d}` : ''} | ⭐ ${scoreStr}`;
			}

			blocks.push(`${titleLine}\n${statsLine}`);
		}

		const messages = [];
		let current = header;
		for (const block of blocks) {
			const candidate = `${current}\n\n${block}`;
			if (candidate.length > 1900) {
				messages.push(current);
				current = block;
			} else {
				current = candidate;
			}
		}
		messages.push(current);

		for (let i = 0; i < messages.length; i++) {
			await sendMessage(channelId, messages[i], i === messages.length - 1);
		}
	}
}

const filterChannelId = process.env.FILTER_CHANNEL_ID ?? '';

async function main() {
	if (!filterChannelId) {
		console.log('Refreshing app info...');
		await runAppInfoRefresh();
	}
	console.log(`Running daily report${filterChannelId ? ` for channel ${filterChannelId}` : ''}...`);
	await runDailyReport(filterChannelId);
	console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
