const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const CF_D1_DATABASE_ID = process.env.CF_D1_DATABASE_ID;
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

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

async function fetchSteamFollowers(appid, sessionid) {
	const res = await fetch(
		`https://steamcommunity.com/search/SearchCommunityAjax?text=${appid}&filter=groups&sessionid=${sessionid}&steamid_user=false`,
		{
			headers: {
				'Cookie': `sessionid=${sessionid}`,
				'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				'Referer': 'https://steamcommunity.com/search/groups',
			},
		}
	);
	if (!res.ok) return null;
	const json = await res.json();
	if (json.success !== 1 || !json.html) return null;
	if (!json.html.includes(`/app/${appid}`)) return null;
	const match = json.html.match(/<span[^>]*>([\d,]+)<\/span>\s*members in this group/);
	if (!match) return null;
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
	const sessionid = generateSessionId();
	const wishlistRanks = await fetchWishlistRanks();

	const dataMap = new Map();

	for (const appid of uniqueAppIds) {
		const cachedEntry = tracked.find(r => r.appid === appid);
		const comingSoon = Boolean(cachedEntry?.coming_soon);
		const releaseDate = cachedEntry?.release_date ?? null;

		const [reviews, followers, prev, prev7d, followerHistoryRows] = await Promise.all([
			fetchSteamReviews(appid),
			comingSoon ? fetchSteamFollowers(appid, sessionid) : Promise.resolve(null),
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

		for (const app of apps) {
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
