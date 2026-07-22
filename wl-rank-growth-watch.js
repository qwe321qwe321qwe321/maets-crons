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

async function fetchTopGrowth(limit = 10) {
	const res = await fetch('https://raw.githubusercontent.com/qwe321qwe321qwe321/maets-rank-cron/refs/heads/main/wishlist_rank_growth.csv');
	if (!res.ok) throw new Error(`Failed to fetch wishlist_rank_growth.csv: ${res.status}`);
	const text = await res.text();
	const rows = [];
	for (const line of text.split('\n').slice(1)) {
		const [appid, rank, prevRank, rankChange] = line.trim().split(',');
		if (!appid || !rank || !rankChange) continue;
		rows.push({
			appid,
			rank: parseInt(rank, 10),
			prevRank: prevRank === 'N/A' ? null : parseInt(prevRank, 10),
			rankChange: parseInt(rankChange, 10),
		});
	}
	return rows.slice(0, limit);
}

async function fetchSteamAppInfo(appid) {
	const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
	if (!res.ok) return { name: null, releaseDate: null };
	const json = await res.json();
	const data = json[appid]?.success ? json[appid].data : null;
	return {
		name: data?.name ?? null,
		releaseDate: data?.release_date?.date || null,
	};
}

async function fetchSteamAppTags(appid, limit = 5) {
	const res = await fetch(`https://store.steampowered.com/app/${appid}/`, {
		headers: { 'Cookie': 'birthtime=0; mature_content=1' },
	});
	if (!res.ok) return [];
	const html = await res.text();
	const tags = [];
	for (const m of html.matchAll(/class="app_tag"[^>]*>\s*([^<]+?)\s*<\/a>/g)) {
		tags.push(m[1]);
		if (tags.length >= limit) break;
	}
	return tags;
}

function fmt(n) {
	return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function relativeReleaseDate(dateStr) {
	const isDayMonthYear = /^\d{1,2}\s+[A-Za-z]{3,},?\s+\d{4}$/.test(dateStr);
	const isMonthDayYear = /^[A-Za-z]{3,}\s+\d{1,2},?\s+\d{4}$/.test(dateStr);
	const isMonthYear = /^[A-Za-z]{3,}\s+\d{4}$/.test(dateStr);
	if (!isDayMonthYear && !isMonthDayYear && !isMonthYear) return null;
	const date = new Date(dateStr);
	if (isNaN(date)) return null;

	const startOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const diffDays = Math.round((startOfDay(date) - startOfDay(new Date())) / 86400000);
	if (diffDays === 0) return 'today';

	const abs = Math.abs(diffDays);
	const dir = diffDays > 0 ? 'in ' : '';
	const suffix = diffDays < 0 ? ' ago' : '';
	if (abs < 30) return `${dir}${abs}d${suffix}`;
	if (abs < 365) return `${dir}${Math.round(abs / 30)}mo${suffix}`;
	return `${dir}${Math.round(abs / 365)}y${suffix}`;
}

async function sendMessage(channelId, content) {
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: 'POST',
		headers: {
			'Authorization': `Bot ${DISCORD_TOKEN}`,
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({ content, flags: 4 }),
	});
	if (!res.ok) {
		const text = await res.text();
		console.error(`Message post failed for ${channelId}: ${res.status} ${text}`);
	}
}

async function main() {
	const filterChannelId = process.env.FILTER_CHANNEL_ID ?? '';

	const channelIds = filterChannelId
		? [filterChannelId]
		: (await d1('SELECT channel_id FROM wl_rank_growth_channels')).map(r => r.channel_id);
	if (channelIds.length === 0) {
		console.log('No channels subscribed, skipping.');
		return;
	}

	const topGrowth = await fetchTopGrowth(10);
	if (topGrowth.length === 0) {
		console.log('No growth data available, skipping.');
		return;
	}

	const infos = new Map();
	const tags = new Map();
	for (const { appid } of topGrowth) {
		const [info, appTags] = await Promise.all([fetchSteamAppInfo(appid), fetchSteamAppTags(appid)]);
		infos.set(appid, info);
		tags.set(appid, appTags);
	}

	const unixTs = Math.floor(Date.now() / 1000);
	const isoDate = new Date().toISOString();
	const header = `**📈 Steam WL Growth Rank Watch · ${isoDate}**\n<t:${unixTs}:F>`;

	const lines = topGrowth.map(({ appid, rank, prevRank, rankChange }, i) => {
		const { name, releaseDate } = infos.get(appid) ?? {};
		const rankStr = prevRank != null
			? `#${fmt(prevRank)} → #${fmt(rank)} (▲${fmt(rankChange)})`
			: `## → #${fmt(rank)} (▲${fmt(rankChange)})`;
		const appTags = tags.get(appid);
		let msg = `**${i + 1}. [${name ?? appid}](https://store.steampowered.com/app/${appid}/)** 🎯 ${rankStr}`;
		if (appTags?.length) msg += `\n-# ${appTags.join(' · ')}`;
		if (releaseDate) {
			const rel = relativeReleaseDate(releaseDate);
			msg += `\n-# 🗓️ ${releaseDate}${rel ? ` (${rel})` : ''}`;
		}
		return msg;
	});

	const messages = [];
	let current = header;
	for (const line of lines) {
		const candidate = `${current}\n\n${line}`;
		if (candidate.length > 1900) {
			messages.push(current);
			current = line;
		} else {
			current = candidate;
		}
	}
	messages.push(current);

	for (const channelId of channelIds) {
		for (const message of messages) {
			await sendMessage(channelId, message);
		}
	}
	console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
