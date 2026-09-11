#!/usr/bin/env node
// Generate Star / Commit Top 10 charts (light + dark SVG) for the profile README.
// Data: GitHub API, last 42 days, day buckets in Asia/Shanghai.
// Usage: node scripts/generate-top10.mjs   (token from GITHUB_TOKEN / GH_TOKEN / `gh auth token`)

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OWNER = 'dddpeter';
const DAYS = 42; // window span
const TOP_N = 10;
const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function getToken() {
  // GITHUB_TOKEN (Actions 集成令牌) 无法访问 stargazers 端点,需要 PAT
  if (process.env.GH_PAT) return process.env.GH_PAT;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    throw new Error('No token: set GITHUB_TOKEN or authenticate `gh`');
  }
}
const TOKEN = getToken();

async function api(path, { accept = 'application/vnd.github+json' } = {}) {
  const out = [];
  let url = `https://api.github.com${path}${path.includes('?') ? '&' : '?'}per_page=100`;
  while (url) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new Error(`GitHub API ${res.status} for ${url}: ${await res.text()}`);
    const page = await res.json();
    out.push(...page);
    const link = res.headers.get('link') || '';
    const next = link.match(/<([^>]+)>;\s*rel="next"/);
    url = next ? next[1] : null;
  }
  return out;
}

// ---- time helpers (Asia/Shanghai day buckets) ----
const DAY_MS = 86400000;
function cstDayStart(date) {
  const shifted = new Date(date.getTime() + TZ_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()).valueOf() - TZ_OFFSET_MS);
}
function fmt(d, style) {
  const s = new Date(d.getTime() + TZ_OFFSET_MS);
  const y = s.getUTCFullYear(), m = s.getUTCMonth() + 1, dd = s.getUTCDate();
  if (style === 'iso') return `${y}-${String(m).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  return `${m}.${dd}`;
}
function fmtLong(d) {
  const s = new Date(d.getTime() + TZ_OFFSET_MS);
  return `${s.getUTCFullYear()}.${s.getUTCMonth() + 1}.${s.getUTCDate()}`;
}

const todayStart = cstDayStart(new Date()); // CST 00:00 today
const startDay = new Date(todayStart.getTime() - DAYS * DAY_MS);
const points = Array.from({ length: DAYS + 1 }, (_, i) => new Date(startDay.getTime() + i * DAY_MS));
const tomorrowStart = new Date(todayStart.getTime() + DAY_MS);

function cumulativeSeries(timestamps) {
  const inWindow = timestamps.map((t) => new Date(t).getTime()).filter((t) => t >= startDay.getTime() && t < tomorrowStart.getTime());
  return points.map((p) => inWindow.filter((t) => t < p.getTime() + DAY_MS).length);
}

// ---- data collection ----
async function collect() {
  const repos = (await api(`/users/${OWNER}/repos?type=owner&sort=pushed`)).filter((r) => !r.private);
  console.log(`${repos.length} public repos`);

  const starRows = [];
  const commitRows = [];
  for (const repo of repos) {
    let stars = [];
    if (repo.stargazers_count > 0) {
      stars = await api(`/repos/${OWNER}/${repo.name}/stargazers`, { accept: 'application/vnd.github.star+json' });
    }
    const starSeries = cumulativeSeries(stars.map((s) => s.starred_at));
    starRows.push({ name: repo.name, series: starSeries, total: starSeries[DAYS], tiebreak: repo.stargazers_count });

    const commits = await api(
      `/repos/${OWNER}/${repo.name}/commits?author=${OWNER}&since=${startDay.toISOString()}&until=${tomorrowStart.toISOString()}`
    );
    const commitSeries = cumulativeSeries(commits.map((c) => c.commit.author?.date || c.commit.committer?.date));
    commitRows.push({ name: repo.name, series: commitSeries, total: commitSeries[DAYS], tiebreak: 0 });
    console.log(`  ${repo.name}: +${starSeries[DAYS]} stars, +${commitSeries[DAYS]} commits`);
  }

  const pick = (rows) =>
    rows
      .filter((r) => r.total > 0)
      .sort((a, b) => b.total - a.total || b.tiebreak - a.tiebreak || a.name.localeCompare(b.name))
      .slice(0, TOP_N);
  return { stars: pick(starRows), commits: pick(commitRows) };
}

// ---- SVG rendering ----
const THEMES = {
  light: {
    bgFrom: '#ffffff', bgTo: '#f8fafc', border: '#e2e8f0', title: '#0f172a', text: '#1e293b', secondary: '#64748b',
    grid: '#eef2f7', axis: '#cbd5e1', divider: '#f1f5f9', accent: '#f59e0b', commitIcon: '#7c3aed',
    medals: ['#d97706', '#94a3b8', '#b45309'],
    palette: ['#e11d48', '#2563eb', '#059669', '#d97706', '#7c3aed', '#0891b2', '#db2777', '#ea580c', '#4f46e5', '#64748b'],
  },
  dark: {
    bgFrom: '#161b22', bgTo: '#0d1117', border: '#30363d', title: '#e6edf3', text: '#c9d1d9', secondary: '#8b949e',
    grid: '#1c2129', axis: '#3d444d', divider: '#21262d', accent: '#fbbf24', commitIcon: '#a78bfa',
    medals: ['#fbbf24', '#9aa7b4', '#d08a4e'],
    palette: ['#fb7185', '#60a5fa', '#34d399', '#fbbf24', '#a78bfa', '#22d3ee', '#f472b6', '#fb923c', '#818cf8', '#94a3b8'],
  },
};
const FONT = '-apple-system,BlinkMacSystemFont,&quot;Segoe UI&quot;,&quot;Noto Sans CJK SC&quot;,&quot;PingFang SC&quot;,&quot;Microsoft YaHei&quot;,Helvetica,Arial,sans-serif';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function niceMax(v) {
  const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000, 10000];
  const target = Math.max(4, (v * 1.15) / 4);
  const step = steps.find((s) => s >= target) || Math.ceil(target / 1000) * 1000;
  return step * 4;
}

// Fritsch–Carlson monotone cubic -> cubic bezier path.
// Monotone: flat runs (e.g. 0,0,0) stay exactly flat, no overshoot past data points.
function smoothPath(pts) {
  const n = pts.length;
  if (n < 2) return '';
  if (n === 2) return `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}L${pts[1].x.toFixed(1)},${pts[1].y.toFixed(1)}`;
  const d = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1].y - pts[i].y) / (pts[i + 1].x - pts[i].x));
  const m = new Array(n);
  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
      if (s > 9) {
        const tau = 3 / Math.sqrt(s);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }
  }
  let out = `M${pts[0].x.toFixed(1)},${pts[0].y.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x;
    const c1x = pts[i].x + dx / 3, c1y = pts[i].y + (m[i] * dx) / 3;
    const c2x = pts[i + 1].x - dx / 3, c2y = pts[i + 1].y - (m[i + 1] * dx) / 3;
    out += `C${c1x.toFixed(1)},${c1y.toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${pts[i + 1].x.toFixed(1)},${pts[i + 1].y.toFixed(1)}`;
  }
  return out;
}

function starIcon(x, y, r, fill) {
  const pts = [];
  for (let i = 0; i < 10; i++) {
    const ang = -Math.PI / 2 + (i * Math.PI) / 5;
    const rr = i % 2 === 0 ? r : r * 0.42;
    pts.push(`${(x + rr * Math.cos(ang)).toFixed(1)},${(y + rr * Math.sin(ang)).toFixed(1)}`);
  }
  return `<polygon points="${pts.join(' ')}" fill="${fill}"/>`;
}

function commitIcon(x, y, color) {
  return `<g stroke="${color}" stroke-width="4" fill="none"><line x1="${x - 16}" y1="${y}" x2="${x + 16}" y2="${y}"/><circle cx="${x - 16}" cy="${y}" r="7.5"/><circle cx="${x + 16}" cy="${y}" r="7.5"/></g>`;
}

function render(rows, themeName, opts) {
  const t = THEMES[themeName];
  const W = 1600, H = 900;
  const plot = { l: 100, r: 1016, t: 196, b: 776 };
  const maxV = niceMax(Math.max(1, ...rows.map((r) => r.total)));
  const step = maxV / 4;
  const x = (i) => plot.l + (i / DAYS) * (plot.r - plot.l);
  const y = (v) => plot.b - (v / maxV) * (plot.b - plot.t);

  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900" viewBox="0 0 1600 900" role="img" aria-label="${esc(opts.ariaLabel)}">`);

  // defs: card background gradient + per-series stroke/area gradients
  const defs = [`<linearGradient id="cardbg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${t.bgFrom}"/><stop offset="1" stop-color="${t.bgTo}"/></linearGradient>`];
  rows.forEach((row, ri) => {
    const color = t.palette[ri % t.palette.length];
    defs.push(`<linearGradient id="ls-${ri}" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="${color}" stop-opacity="0.25"/><stop offset="0.55" stop-color="${color}" stop-opacity="0.7"/><stop offset="1" stop-color="${color}"/></linearGradient>`);
    defs.push(`<linearGradient id="as-${ri}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="${themeName === 'dark' ? 0.14 : 0.1}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></linearGradient>`);
  });
  parts.push(`<defs>${defs.join('')}</defs>`);

  parts.push(`<rect width="${W}" height="${H}" rx="16" fill="url(#cardbg)"/>`);
  parts.push(`<rect x="0.75" y="0.75" width="${W - 1.5}" height="${H - 1.5}" rx="16" fill="none" stroke="${t.border}" stroke-width="1.5"/>`);

  // header
  if (opts.kind === 'stars') parts.push(starIcon(84, 76, 19, t.accent));
  else parts.push(commitIcon(84, 76, t.commitIcon));
  parts.push(`<text x="118" y="90" font-family="${FONT}" font-size="38" font-weight="700" fill="${t.title}">${esc(opts.title)}</text>`);
  parts.push(`<text x="118" y="128" font-family="${FONT}" font-size="21" fill="${t.secondary}">${fmtLong(startDay)} – ${fmtLong(todayStart)} · @${OWNER} · 最近 ${DAYS} 天</text>`);
  parts.push(`<text x="1536" y="90" font-family="${FONT}" font-size="18" fill="${t.secondary}" text-anchor="end">生成于 ${fmt(todayStart, 'iso')}</text>`);
  parts.push(`<line x1="64" y1="152" x2="1536" y2="152" stroke="${t.divider}" stroke-width="1.5"/>`);

  // grid + y labels
  for (let i = 0; i <= 4; i++) {
    const v = step * i, gy = y(v);
    parts.push(`<line x1="${plot.l}" y1="${gy}" x2="${plot.r}" y2="${gy}" stroke="${i ? t.grid : t.axis}" stroke-width="${i ? 1 : 1.6}"/>`);
    parts.push(`<text x="84" y="${gy + 6}" font-family="${FONT}" font-size="19" fill="${t.secondary}" text-anchor="end">${v}</text>`);
  }
  parts.push(`<text x="${plot.l}" y="180" font-family="${FONT}" font-size="18" fill="${t.secondary}">${esc(opts.unit)}</text>`);

  // x ticks
  for (let i = 0; i <= 6; i++) {
    const idx = Math.round((i * DAYS) / 6), tx = x(idx);
    parts.push(`<text x="${tx}" y="${plot.b + 32}" font-family="${FONT}" font-size="19" fill="${t.secondary}" text-anchor="middle">${fmt(points[idx])}</text>`);
  }

  // series: area fill first (bottom layer), then gradient line, then end dot with halo
  // draw in reverse rank order so the #1 series stays on top
  const drawOrder = rows.map((_, ri) => ri).reverse();
  drawOrder.forEach((ri) => {
    const row = rows[ri];
    const pts = row.series.map((v, i) => ({ x: x(i), y: y(v) }));
    const line = smoothPath(pts);
    parts.push(`<path d="${line}L${x(DAYS).toFixed(1)},${plot.b} L${x(0).toFixed(1)},${plot.b} Z" fill="url(#as-${ri})" stroke="none"/>`);
  });
  drawOrder.forEach((ri) => {
    const row = rows[ri];
    const color = t.palette[ri % t.palette.length];
    const pts = row.series.map((v, i) => ({ x: x(i), y: y(v) }));
    parts.push(`<path d="${smoothPath(pts)}" fill="none" stroke="url(#ls-${ri})" stroke-width="3.5" stroke-linecap="round"/>`);
    parts.push(`<circle cx="${x(DAYS)}" cy="${y(row.total)}" r="9" fill="${color}" fill-opacity="0.22"/>`);
    parts.push(`<circle cx="${x(DAYS)}" cy="${y(row.total)}" r="4.5" fill="${color}"/>`);
  });

  // ranking panel
  parts.push(`<text x="1088" y="180" font-family="${FONT}" font-size="20" font-weight="600" fill="${t.secondary}">排名</text>`);
  const rowH = 56, top0 = 200;
  rows.forEach((row, ri) => {
    const color = t.palette[ri % t.palette.length];
    const cy = top0 + ri * rowH;
    if (ri > 0) parts.push(`<line x1="1088" y1="${cy - 8}" x2="1528" y2="${cy - 8}" stroke="${t.divider}" stroke-width="1"/>`);
    const rankColor = ri < 3 ? t.medals[ri] : t.secondary;
    parts.push(`<text x="1112" y="${cy + 28}" font-family="${FONT}" font-size="20" font-weight="${ri < 3 ? 700 : 400}" fill="${rankColor}" text-anchor="end">${ri + 1}</text>`);
    parts.push(`<circle cx="1144" cy="${cy + 22}" r="7" fill="${color}"/>`);
    const name = row.name.length > 22 ? row.name.slice(0, 21) + '…' : row.name;
    parts.push(`<text x="1166" y="${cy + 29}" font-family="${FONT}" font-size="21" fill="${t.text}">${esc(name)}</text>`);
    parts.push(`<text x="1520" y="${cy + 30}" font-family="${FONT}" font-size="23" font-weight="700" fill="${color}" text-anchor="end">${row.total}</text>`);
  });

  parts.push(`<text x="800" y="866" font-family="${FONT}" font-size="16" fill="${t.secondary}" text-anchor="middle">数据来自 GitHub API · 仅统计公开仓库 · 每日自动更新</text>`);
  parts.push('</svg>');
  return parts.join('\n');
}

// ---- main ----
const data = await collect();
const meta = {
  stars: { kind: 'stars', title: 'Star Top 10', unit: 'Stars', ariaLabel: `Star Top 10, last ${DAYS} days` },
  commits: { kind: 'commits', title: 'Commit Top 10', unit: 'Commits', ariaLabel: `Commit Top 10, last ${DAYS} days` },
};
for (const kind of ['stars', 'commits']) {
  for (const theme of ['light', 'dark']) {
    const suffix = theme === 'dark' ? '-dark' : '';
    const file = join(root, 'assets', `${kind}-top10${suffix}.svg`);
    writeFileSync(file, render(data[kind], theme, meta[kind]));
    console.log(`wrote ${file}`);
  }
}
