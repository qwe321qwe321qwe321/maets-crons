const sharp = require('sharp');

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

async function fetchGrowth() {
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
	return rows;
}

async function fetchSteamAppInfo(appid) {
	const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}`);
	if (!res.ok) return { name: null, releaseDate: null };
	const json = await res.json();
	const data = json[appid]?.success ? json[appid].data : null;
	return {
		name: data?.name ?? null,
		releaseDate: data?.release_date?.date || null,
		headerImage: data?.header_image ?? null,
	};
}

const TILE_W = 400;
const TILE_H = 187;
const TILE_COLS = 3;

const escapeXml = s => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function fetchCapsule(appid, headerImage) {
	const urls = [
		headerImage,
		`https://shared.fastly.steamstatic.com/store_item_assets/steam/apps/${appid}/header.jpg`,
	].filter(Boolean);
	for (const url of urls) {
		try {
			const res = await fetch(url);
			if (res.ok) return Buffer.from(await res.arrayBuffer());
		} catch { /* try next */ }
	}
	return null;
}

async function renderTile(label, { appid, rank, prevRank, rankChange }, capsule) {
	const base = capsule
		? sharp(capsule).resize(TILE_W, TILE_H, { fit: 'cover' })
		: sharp({ create: { width: TILE_W, height: TILE_H, channels: 3, background: '#2a2f3a' } });
	const rankStr = `${prevRank != null ? `#${fmt(prevRank)}` : '##'} → #${fmt(rank)}  ▲${fmt(rankChange)}`;
	const overlay = Buffer.from(`<svg width="${TILE_W}" height="${TILE_H}" xmlns="http://www.w3.org/2000/svg">
		<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
			<stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/>
		</linearGradient></defs>
		<rect x="0" y="${TILE_H - 56}" width="${TILE_W}" height="56" fill="url(#g)"/>
		<rect x="0" y="0" width="${label.length * 12 + 20}" height="28" fill="#000" fill-opacity="0.75"/>
		<text x="10" y="20" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#fff">${escapeXml(label)}</text>
		<text x="10" y="${TILE_H - 10}" font-family="DejaVu Sans, sans-serif" font-size="16" font-weight="bold" fill="#7CFC9A">${escapeXml(rankStr)}</text>
	</svg>`);
	return base.composite([{ input: overlay }]).jpeg({ quality: 85 }).toBuffer();
}

// Each group starts on a fresh row.
async function buildCollage(groups) {
	const placed = [];
	let rows = 0;
	for (const group of groups) {
		group.forEach((entry, i) => placed.push({ entry, col: i % TILE_COLS, gridRow: rows + Math.floor(i / TILE_COLS) }));
		rows += Math.ceil(group.length / TILE_COLS);
	}
	const tiles = await Promise.all(placed.map(async ({ entry: { label, row, headerImage }, col, gridRow }) => ({
		input: await renderTile(label, row, await fetchCapsule(row.appid, headerImage)),
		left: col * TILE_W,
		top: gridRow * TILE_H,
	})));
	return sharp({ create: { width: TILE_W * TILE_COLS, height: TILE_H * rows, channels: 3, background: '#171a21' } })
		.composite(tiles)
		.jpeg({ quality: 85 })
		.toBuffer();
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
	if (isMonthYear) date.setMonth(date.getMonth() + 1, 0);

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

async function sendMessage(channelId, content, image = null) {
	const headers = { 'Authorization': `Bot ${DISCORD_TOKEN}` };
	let body;
	if (image) {
		body = new FormData();
		body.append('payload_json', JSON.stringify({ content, flags: 4 }));
		body.append('files[0]', new Blob([image], { type: 'image/jpeg' }), 'wl_growth_capsules.jpg');
	} else {
		headers['Content-Type'] = 'application/json';
		body = JSON.stringify({ content, flags: 4 });
	}
	const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
		method: 'POST',
		headers,
		body,
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

	const allGrowth = await fetchGrowth();
	if (allGrowth.length === 0) {
		console.log('No growth data available, skipping.');
		return;
	}

	const TOP_RANK_LIMIT = 3000;
	const CATCH_RANK_LIMIT = 1500;
	const CATCH_MIN_GROWTH = 100;

	const topGrowth = allGrowth.slice(0, 10);
	const topAppids = new Set(topGrowth.map(r => r.appid));
	const filteredPool = allGrowth.filter(r => r.rank <= TOP_RANK_LIMIT).slice(0, 10);
	const windowExGrowth = filteredPool.filter(r => !topAppids.has(r.appid));

	const listedAppids = new Set([...topAppids, ...windowExGrowth.map(r => r.appid)]);
	const caughtUp = allGrowth.filter(r => r.rank <= CATCH_RANK_LIMIT && r.rankChange > CATCH_MIN_GROWTH && !listedAppids.has(r.appid));

	const exGrowth = [...windowExGrowth, ...caughtUp].sort((a, b) => b.rankChange - a.rankChange);
	const highlightAppids = new Set(filteredPool.filter(r => topAppids.has(r.appid)).map(r => r.appid));

	const infos = new Map();
	const tags = new Map();
	for (const { appid } of [...topGrowth, ...exGrowth]) {
		const [info, appTags] = await Promise.all([fetchSteamAppInfo(appid), fetchSteamAppTags(appid)]);
		infos.set(appid, info);
		tags.set(appid, appTags);
	}

	const unixTs = Math.floor(Date.now() / 1000);
	const isoDate = new Date().toISOString();
	const header = `**📈 Steam WL Growth Rank Watch · ${isoDate}**\n<t:${unixTs}:F>`;

	const renderEntry = (label, { appid, rank, prevRank, rankChange }, highlight) => {
		const { name, releaseDate } = infos.get(appid) ?? {};
		const rankStr = prevRank != null
			? `#${fmt(prevRank)} → #${fmt(rank)} (▲${fmt(rankChange)})`
			: `## → #${fmt(rank)} (▲${fmt(rankChange)})`;
		const appTags = tags.get(appid);
		const marker = highlight ? ' 💎' : '';
		let msg = `**${label}. [${name ?? appid}](https://store.steampowered.com/app/${appid}/)**${marker} 🎯 ${rankStr}`;
		if (appTags?.length) msg += `\n-# ${appTags.join(' · ')}`;
		if (releaseDate) {
			const rel = relativeReleaseDate(releaseDate);
			msg += `\n-# 🗓️ ${releaseDate}${rel ? ` (${rel})` : ''}`;
		}
		return msg;
	};

	const lines = [
		...topGrowth.map((row, i) => renderEntry(`${i + 1}`, row, highlightAppids.has(row.appid))),
		...exGrowth.map((row, i) => renderEntry(`Ex.${i + 1}`, row, false)),
	];

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

	let collage = null;
	try {
		const toEntry = prefix => (row, i) => ({ label: `${prefix}${i + 1}`, row, headerImage: infos.get(row.appid)?.headerImage });
		collage = await buildCollage([
			topGrowth.map(toEntry('')),
			exGrowth.map(toEntry('Ex.')),
		]);
	} catch (err) {
		console.error('Collage build failed, sending text only:', err);
	}

	for (const channelId of channelIds) {
		for (const [i, message] of messages.entries()) {
			await sendMessage(channelId, message, i === messages.length - 1 ? collage : null);
		}
	}
	console.log('Done.');
}

main().catch(err => { console.error(err); process.exit(1); });
