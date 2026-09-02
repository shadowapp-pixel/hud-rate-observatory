#!/usr/bin/env node
/*
 * HUD Rate Observatory — dashboard generator
 * ------------------------------------------------------------
 * Pulls U.S. Treasury / money-market rate series from FRED's
 * no-auth CSV endpoint (no API key required) and renders a
 * self-contained futuristic HTML dashboard for publishing as
 * a Claude Artifact.
 *
 * Series used:
 *   DGS2 DGS5 DGS7 DGS10 DGS30  – Treasury constant maturity yields
 *   SOFR                        – Secured Overnight Financing Rate
 *   DFF                         – Effective Federal Funds Rate
 *   T10Y2Y                      – 10Y minus 2Y spread
 *   MORTGAGE30US                – Freddie Mac 30Y PMMS (weekly)
 *
 * HUD product rates are MODELED, indicative estimates — not quotes.
 *
 * Usage:  node build-dashboard.js  ->  writes dashboard.html
 */

const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'dashboard.html');
const SERIES = ['DGS2', 'DGS5', 'DGS7', 'DGS10', 'DGS30', 'SOFR', 'DFF', 'T10Y2Y', 'MORTGAGE30US'];
const FRED = id =>
  `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${id}&cosd=2026-01-01`;

// ---- HUD product spread assumptions (basis points unless noted) -------------
// These are transparent, editable modeling assumptions. Adjust to your desk's
// current read of GNMA MBS execution and FFB pricing.
const MODEL = {
  d4: {
    label: 'FHA 221(d)(4)',
    base: 'DGS10',
    gnmaSpread: 1.15,   // GNMA permanent MBS spread over 10Y UST
    servicing: 0.10,    // lender servicing fee
    mip: 0.65,          // annual FHA MIP (market-rate); 0.25 affordable / 0.35 green
  },
  rs: {
    label: 'HFA Risk Share 50/50',
    base: 'DGS10',
    ffbSpread: 0.45,    // FFB Risk-Share execution spread over comparable UST
    servicing: 0.05,
    mip: 0.50,          // risk-share premium
  },
};

async function fetchSeries(id) {
  const res = await fetch(FRED(id), { headers: { 'User-Agent': 'hud-rate-observatory/1.0' } });
  if (!res.ok) throw new Error(`${id}: HTTP ${res.status}`);
  return parseCsv(await res.text());
}

const DATA_DIR = path.join(__dirname, 'data');

function parseCsv(text) {
  const rows = text.trim().split(/\r?\n/).slice(1);
  const out = [];
  for (const line of rows) {
    const [date, raw] = line.split(',');
    const v = parseFloat(raw);
    if (!isNaN(v)) out.push({ date, v });
  }
  return out;
}

// Read a series from a committed CSV. The GitHub Action `refresh-rates.yml`
// keeps `data/*.csv` current on U.S. business mornings; the cloud refresh
// routine's sandbox cannot reach FRED directly, so these files are the
// primary source there.
function loadLocal(id) {
  const candidates = [
    path.join(DATA_DIR, `${id}.csv`),
    path.join(DATA_DIR, `${id.toLowerCase()}.csv`),
    path.join(__dirname, `${id}.csv`),
    path.join(__dirname, `${id.toLowerCase()}.csv`),
  ];
  const file = candidates.find(f => fs.existsSync(f));
  return file ? parseCsv(fs.readFileSync(file, 'utf8')) : null;
}

const last = a => a[a.length - 1];
const prev = a => a[a.length - 2];
const fmt = (n, d = 2) => n.toFixed(d);

function sparkPath(series, w, h, pad = 2) {
  const vals = series.map(p => p.v);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const n = series.length;
  return series
    .map((p, i) => {
      const x = pad + (i / (n - 1)) * (w - pad * 2);
      const y = pad + (1 - (p.v - min) / span) * (h - pad * 2);
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
}

function areaPath(series, w, h, pad = 2) {
  const line = sparkPath(series, w, h, pad);
  return `${line} L${(w - pad).toFixed(1)} ${(h - pad).toFixed(1)} L${pad.toFixed(1)} ${(h - pad).toFixed(1)} Z`;
}

// Build a modeled HUD rate history from a base UST series + fixed spreads.
function modelHistory(base, addBps) {
  return base.map(p => ({ date: p.date, v: p.v + addBps }));
}

(async () => {
  const data = {};
  const sources = {};
  // Prefer committed CSVs (kept fresh by the refresh-rates GitHub Action);
  // fall back to a live FRED fetch for local development.
  for (const id of SERIES) {
    const localFirst = loadLocal(id);
    if (localFirst && localFirst.length) {
      data[id] = localFirst;
      sources[id] = 'csv';
      continue;
    }
    try {
      data[id] = await fetchSeries(id);
      sources[id] = 'fred';
    } catch (e) {
      throw new Error(`no data for ${id}: no committed data/${id}.csv and FRED fetch failed (${e.message})`);
    }
  }
  for (const id of SERIES) {
    process.stderr.write(`${id}: ${data[id].length} pts via ${sources[id]}, latest ${last(data[id]).date}\n`);
  }

  const asOf = last(data.DGS10).date;

  // ---- headline metrics ----------------------------------------------------
  const metric = (id, label, unit = '%') => {
    const s = data[id];
    const cur = last(s), pr = prev(s);
    return {
      id, label, unit,
      value: cur.v,
      date: cur.date,
      chg: cur.v - pr.v,
      series: s.slice(-60),
    };
  };

  const metrics = [
    metric('DGS10', '10-Year Treasury'),
    metric('DGS30', '30-Year Treasury'),
    metric('DGS7', '7-Year Treasury'),
    metric('DGS5', '5-Year Treasury'),
    metric('DGS2', '2-Year Treasury'),
    metric('SOFR', 'SOFR'),
    metric('DFF', 'Fed Funds (Eff.)'),
    metric('MORTGAGE30US', 'Freddie Mac 30Y'),
  ];

  // ---- HUD modeled product rates -----------------------------------------
  const d4Add = MODEL.d4.gnmaSpread + MODEL.d4.servicing + MODEL.d4.mip;
  const rsAdd = MODEL.rs.ffbSpread + MODEL.rs.servicing + MODEL.rs.mip;
  const d4Hist = modelHistory(data.DGS10, d4Add).slice(-90);
  const rsHist = modelHistory(data.DGS10, rsAdd).slice(-90);
  const d4Base = last(data.DGS10).v;
  const rsBase = last(data.DGS10).v;

  const products = [
    {
      key: 'd4',
      name: 'FHA 221(d)(4)',
      tag: 'New construction / substantial rehab · up to 40-yr fixed · non-recourse',
      allIn: d4Base + d4Add,
      allInPrev: prev(data.DGS10).v + d4Add,
      hist: d4Hist,
      stack: [
        { label: '10-Year UST base', v: d4Base },
        { label: 'GNMA MBS spread', v: MODEL.d4.gnmaSpread },
        { label: 'Servicing fee', v: MODEL.d4.servicing },
        { label: 'FHA MIP (market rate)', v: MODEL.d4.mip },
      ],
      notes: [
        'MIP drops to 0.25% for broadly affordable or 0.35% for green/energy-efficient deals.',
        'Rate locks at GNMA MBS pricing; 40-year amortization begins after construction.',
      ],
    },
    {
      key: 'rs',
      name: 'HFA Risk Share 50/50',
      tag: 'Section 542(c) · FHA/HFA split loss 50/50 · up to 40-yr · FFB or bond execution',
      allIn: rsBase + rsAdd,
      allInPrev: prev(data.DGS10).v + rsAdd,
      hist: rsHist,
      stack: [
        { label: '10-Year UST base', v: rsBase },
        { label: 'FFB execution spread', v: MODEL.rs.ffbSpread },
        { label: 'Servicing fee', v: MODEL.rs.servicing },
        { label: 'Risk-share premium', v: MODEL.rs.mip },
      ],
      notes: [
        'Federal Financing Bank execution prices at a tight spread to comparable Treasuries.',
        '50/50 loss share keeps the HFA underwriting to its own standards under a QAP.',
      ],
    },
  ];

  // ---- yield curve --------------------------------------------------------
  const curve = [
    { t: '2Y', v: last(data.DGS2).v },
    { t: '5Y', v: last(data.DGS5).v },
    { t: '7Y', v: last(data.DGS7).v },
    { t: '10Y', v: last(data.DGS10).v },
    { t: '30Y', v: last(data.DGS30).v },
  ];
  const spread = last(data.T10Y2Y);

  const html = render({ metrics, products, curve, spread, asOf, MODEL,
    tenYear: data.DGS10.slice(-90) });
  fs.writeFileSync(OUT, html);
  process.stderr.write(`wrote ${OUT} (${html.length} bytes)\n`);
})();

// ===========================================================================
function render(ctx) {
  const { metrics, products, curve, spread, asOf } = ctx;
  const bp = c => (Math.abs(c) * 100).toFixed(1);
  const dir = c => (c > 0.001 ? 'up' : c < -0.001 ? 'down' : 'flat');
  const arrow = d => (d === 'up' ? '▲' : d === 'down' ? '▼' : '◆');

  // ---- floating rate panels that orbit the globe -------------------------
  // 8 benchmarks -> 4 down the left, 4 down the right. Coordinates are in
  // percent of the .nexus stage so the leader lines (an SVG overlay in the
  // same coordinate space) can point back to the globe at 50% / 50%.
  const rowsTop = [2, 25.5, 49, 72.5];
  const PANEL_W = 21;                       // panel width, % of stage
  const leftX = 1.5;
  const rightX = 100 - PANEL_W - 1.5;
  const seats = metrics.map((m, i) => {
    const side = i < 4 ? 'l' : 'r';
    const x = side === 'l' ? leftX : rightX;
    const y = rowsTop[i % 4];
    // anchor point where the leader line meets the panel
    const ax = side === 'l' ? x + PANEL_W : x;
    const ay = y + 8.5;
    return { m, side, x, y, ax, ay };
  });

  const leaders = seats.map(s => `
    <line x1="${s.ax.toFixed(2)}" y1="${s.ay.toFixed(2)}" x2="50" y2="54" class="leader"/>
    <circle cx="${s.ax.toFixed(2)}" cy="${s.ay.toFixed(2)}" r="0.45" class="leader-node"/>`).join('');

  const ratePanels = seats.map((s, i) => {
    const m = s.m, d = dir(m.chg), w = 200, h = 34;
    return `
    <article class="rpanel rpanel-${s.side}" style="left:${s.x}%;top:${s.y}%;--i:${i}">
      <span class="cnr tl"></span><span class="cnr tr"></span><span class="cnr bl"></span><span class="cnr br"></span>
      <div class="rp-top"><span class="rp-name">${m.label}</span><span class="rp-id">${m.id}</span></div>
      <div class="rp-read">
        <span class="rp-val">${fmt(m.value)}<span class="rp-pct">%</span></span>
        <span class="rp-chg ${d}">${arrow(d)}&#8202;${bp(m.chg)}<span class="rp-bp">bp</span></span>
      </div>
      <svg class="rp-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <path d="${areaPath(m.series, w, h)}" class="rp-fill"/>
        <path d="${sparkPath(m.series, w, h)}" class="rp-line"/>
      </svg>
    </article>`;
  }).join('');

  // ---- product consoles -------------------------------------------------
  const consoles = products.map(p => {
    const w = 560, h = 110;
    const chg = p.allIn - p.allInPrev;
    const d = dir(chg);
    const bars = p.stack.map(s => `
      <div class="wf-row">
        <span class="wf-label">${s.label}</span>
        <span class="wf-track"><span class="wf-bar" style="width:${(s.v / p.allIn * 100).toFixed(1)}%"></span></span>
        <span class="wf-val">${fmt(s.v)}</span>
      </div>`).join('');
    return `
    <article class="console console-${p.key}">
      <span class="cnr tl"></span><span class="cnr tr"></span><span class="cnr bl"></span><span class="cnr br"></span>
      <header class="con-bar"><span class="con-tag">${p.key === 'd4' ? 'CH-01' : 'CH-02'}</span><span class="con-title">${p.name}</span><span class="con-dots"></span></header>
      <div class="con-body">
        <div class="con-lead">
          <div class="con-big">${fmt(p.allIn)}<span class="rp-pct">%</span></div>
          <div class="con-sub">modeled all-in note rate</div>
          <div class="rp-chg ${d}">${arrow(d)}&#8202;${bp(chg)} bp vs prior</div>
          <p class="con-note">${p.tag}</p>
        </div>
        <svg class="con-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
          <path d="${areaPath(p.hist, w, h)}" class="rp-fill"/>
          <path d="${sparkPath(p.hist, w, h)}" class="rp-line"/>
        </svg>
      </div>
      <div class="waterfall">${bars}</div>
      <ul class="con-foot">${p.notes.map(n => `<li>${n}</li>`).join('')}</ul>
    </article>`;
  }).join('');

  // ---- yield curve svg ------------------------------------------------
  const cw = 640, ch = 250, cpad = 42;
  const cvals = curve.map(c => c.v);
  const cmin = Math.floor(Math.min(...cvals) * 2) / 2 - 0.5;
  const cmax = Math.ceil(Math.max(...cvals) * 2) / 2 + 0.5;
  const cx = i => cpad + (i / (curve.length - 1)) * (cw - cpad * 2);
  const cy = v => cpad + (1 - (v - cmin) / (cmax - cmin)) * (ch - cpad * 2);
  const curveLine = curve.map((c, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)} ${cy(c.v).toFixed(1)}`).join(' ');
  const curveArea = `${curveLine} L${cx(curve.length - 1).toFixed(1)} ${ch - cpad} L${cx(0).toFixed(1)} ${ch - cpad} Z`;
  const curveDots = curve.map((c, i) => {
    const anchor = i === 0 ? 'start' : i === curve.length - 1 ? 'end' : 'middle';
    const tx = i === 0 ? cx(i) + 7 : i === curve.length - 1 ? cx(i) - 7 : cx(i);
    return `
    <g class="cv-node">
      <circle cx="${cx(i).toFixed(1)}" cy="${cy(c.v).toFixed(1)}" r="4"/>
      <text x="${tx.toFixed(1)}" y="${(cy(c.v) - 15).toFixed(1)}" text-anchor="${anchor}">${fmt(c.v)}</text>
      <text x="${cx(i).toFixed(1)}" y="${ch - 14}" text-anchor="middle" class="cv-tenor">${c.t}</text>
    </g>`;
  }).join('');
  const gridY = [];
  for (let g = Math.ceil(cmin * 2) / 2; g <= cmax; g += 0.5) {
    gridY.push(`<line x1="${cpad}" x2="${cw - cpad}" y1="${cy(g).toFixed(1)}" y2="${cy(g).toFixed(1)}"/><text x="${cpad - 8}" y="${(cy(g) + 3).toFixed(1)}" text-anchor="end" class="cv-axis">${g.toFixed(1)}</text>`);
  }
  const spreadState = spread.v >= 0 ? 'normal' : 'inverted';

  // ---- globe: static wireframe sphere (deterministic) -----------------
  const G = 200;                                   // centre of 400-unit viewBox
  const latOffsets = [-82, -44, 0, 44, 82];
  const lats = latOffsets.map(o => {
    const rx = Math.sqrt(Math.max(0, 112 * 112 - o * o));
    return `<ellipse cx="${G}" cy="${G + o}" rx="${rx.toFixed(1)}" ry="${(rx * 0.16 + 3).toFixed(1)}" class="wire"/>`;
  }).join('');
  const lonRx = [112, 92, 62, 26];
  const lons = lonRx.map(rx => `<ellipse cx="${G}" cy="${G}" rx="${rx}" ry="112" class="wire"/>`).join('');
  const surfaceNodes = [
    [262, 150, 3.2, 'c'], [150, 250, 3.0, 'v'], [232, 268, 2.2, 'c'],
    [166, 138, 2.2, 'v'], [206, 118, 2.6, 'c'], [128, 196, 2.4, 'c'],
    [276, 214, 2.0, 'v'], [190, 300, 2.0, 'c'],
  ].map(([x, y, r, k], i) => `<circle cx="${x}" cy="${y}" r="${r}" class="gnode ${k}${i % 3 === 0 ? ' pulse' : ''}"/>`).join('');

  return `<title>HUD Rate Observatory</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root {
    --void: #eef2fa;
    --void-2: #e0e8f6;
    --panel: rgba(255,255,255,0.82);
    --panel-brd: rgba(20,55,120,0.20);
    --ink: #14213f;
    --ink-soft: #4a5a83;
    --ink-faint: #7c88ab;
    --cyan: #0b7fa6;
    --cyan-bright: #0a95bf;
    --cyan-glow: rgba(11,127,166,0.22);
    --violet: #6b45e0;
    --amber: #b96f14;
    --good: #12855c;
    --bad: #d6443b;
    --edge: rgba(20,60,120,0.16);
    --starfield: transparent;
  }
  :root:not([data-theme="light"]) { color-scheme: dark; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --void: #04060e;
      --void-2: #070c1a;
      --panel: rgba(12,20,42,0.55);
      --panel-brd: rgba(90,170,255,0.22);
      --ink: #e4ecff;
      --ink-soft: #9fb1dd;
      --ink-faint: #5f719f;
      --cyan: #3fd8ff;
      --cyan-bright: #7fe9ff;
      --cyan-glow: rgba(63,216,255,0.30);
      --violet: #a98bff;
      --amber: #ffc06a;
      --good: #3fe0a2;
      --bad: #ff6f6f;
      --edge: rgba(90,180,255,0.30);
      --starfield: rgba(150,190,255,0.75);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --void: #04060e; --void-2: #070c1a;
    --panel: rgba(12,20,42,0.55); --panel-brd: rgba(90,170,255,0.22);
    --ink: #e4ecff; --ink-soft: #9fb1dd; --ink-faint: #5f719f;
    --cyan: #3fd8ff; --cyan-bright: #7fe9ff; --cyan-glow: rgba(63,216,255,0.30);
    --violet: #a98bff; --amber: #ffc06a; --good: #3fe0a2; --bad: #ff6f6f;
    --edge: rgba(90,180,255,0.30); --starfield: rgba(150,190,255,0.75);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background:
      radial-gradient(ellipse 90% 60% at 50% 0%, var(--void-2), transparent 60%),
      radial-gradient(ellipse 70% 50% at 50% 100%, rgba(60,40,120,0.16), transparent 60%),
      var(--void);
    color: var(--ink);
    font-family: 'Space Grotesk', system-ui, -apple-system, sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  .field {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background-image:
      linear-gradient(var(--edge) 1px, transparent 1px),
      linear-gradient(90deg, var(--edge) 1px, transparent 1px);
    background-size: 52px 52px;
    opacity: 0.5;
    mask-image: radial-gradient(ellipse 75% 70% at 50% 34%, #000 30%, transparent 100%);
  }
  .stars {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background-image:
      radial-gradient(1.4px 1.4px at 12% 22%, var(--starfield), transparent),
      radial-gradient(1.2px 1.2px at 78% 14%, var(--starfield), transparent),
      radial-gradient(1px 1px at 33% 68%, var(--starfield), transparent),
      radial-gradient(1.6px 1.6px at 62% 82%, var(--starfield), transparent),
      radial-gradient(1px 1px at 88% 54%, var(--starfield), transparent),
      radial-gradient(1.2px 1.2px at 22% 48%, var(--starfield), transparent),
      radial-gradient(1px 1px at 50% 8%, var(--starfield), transparent);
    opacity: 0.5;
  }
  .wrap { position: relative; z-index: 1; max-width: 1280px; margin: 0 auto; padding: clamp(1rem, 3vw, 2rem); }

  /* ===================== NEXUS (globe + orbiting panels) ===================== */
  .nexus {
    position: relative;
    min-height: 880px;
    margin-top: 0.5rem;
  }
  .orbit-lines { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; z-index: 1; }
  .leader { stroke: var(--cyan); stroke-width: 0.12; opacity: 0.35; stroke-dasharray: 1.2 1.2; }
  .leader-node { fill: var(--cyan); opacity: 0.8; }

  .hud-title {
    position: absolute; top: 0; left: 50%; transform: translateX(-50%);
    z-index: 4; width: min(42%, 560px); text-align: center;
  }
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.66rem;
    letter-spacing: 0.34em; text-transform: uppercase; color: var(--cyan);
    margin: 0 0 0.7rem;
  }
  .hud-title h1 {
    font-family: 'Chakra Petch', 'Space Grotesk', sans-serif; font-weight: 700;
    font-size: clamp(1.7rem, 3vw, 2.6rem); line-height: 1.0; letter-spacing: -0.01em;
    margin: 0 0 0.8rem; text-wrap: balance;
  }
  .hud-title h1 em { font-style: normal; color: var(--cyan); text-shadow: 0 0 18px var(--cyan-glow); }
  .hud-title p { color: var(--ink-soft); font-size: 0.8rem; margin: 0 auto 1rem; max-width: 40ch; }
  .readout {
    display: grid; gap: 0.35rem; font-family: 'IBM Plex Mono', monospace;
    font-size: 0.66rem; color: var(--ink-faint); justify-items: center;
  }
  .readout b { color: var(--ink); font-weight: 600; }
  .live { color: var(--good); }
  .live::before {
    content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%;
    background: var(--good); margin-right: 0.4rem; vertical-align: middle;
    box-shadow: 0 0 6px var(--good); animation: blip 2.6s infinite;
  }
  @keyframes blip { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } }

  /* --- the globe --- */
  .globe {
    position: absolute; top: 53%; left: 50%; transform: translate(-50%, -50%);
    width: min(45vw, 480px); aspect-ratio: 1; z-index: 2;
  }
  .globe svg { width: 100%; height: 100%; overflow: visible; }
  .atmo { fill: url(#atmo); }
  .ring-o { fill: none; stroke: var(--cyan); stroke-width: 0.8; opacity: 0.45; transform-origin: 200px 200px; }
  .ring-o.v { stroke: var(--violet); opacity: 0.4; }
  .ring-o.f { stroke: var(--amber); opacity: 0.3; }
  .spin-1 { animation: spin 34s linear infinite; transform-origin: 200px 200px; }
  .spin-2 { animation: spin 52s linear infinite reverse; transform-origin: 200px 200px; }
  .spin-3 { animation: spin 78s linear infinite; transform-origin: 200px 200px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .sphere { fill: url(#core); stroke: var(--cyan); stroke-width: 1; }
  .wire { fill: none; stroke: var(--cyan); stroke-width: 0.7; opacity: 0.4; }
  .equator { fill: none; stroke: var(--cyan-bright); stroke-width: 1.1; opacity: 0.7; }
  .gnode { fill: var(--cyan); }
  .gnode.v { fill: var(--violet); }
  .gnode.pulse { animation: gpulse 3.2s ease-in-out infinite; }
  @keyframes gpulse { 0%,100% { opacity: 0.35; } 50% { opacity: 1; } }
  .scan { fill: none; stroke: var(--cyan-bright); stroke-width: 1.4; opacity: 0.5; animation: scan 5.5s ease-in-out infinite; }
  @keyframes scan { 0%,100% { transform: translateY(-92px); opacity: 0; } 45%,55% { opacity: 0.55; } 50% { transform: translateY(92px); } }
  .g-tick { font-family: 'IBM Plex Mono', monospace; font-size: 11px; fill: var(--ink-faint); letter-spacing: 0.16em; }

  /* --- rate panels orbiting the globe --- */
  .rate-field { position: absolute; inset: 0; z-index: 3; }
  .rpanel {
    position: absolute; width: 21%;
    padding: 0.7rem 0.8rem 0.5rem;
    background: var(--panel);
    border: 1px solid var(--panel-brd);
    backdrop-filter: blur(9px);
    box-shadow: 0 0 0 1px rgba(0,0,0,0.15) inset, 0 12px 34px rgba(0,0,0,0.35), 0 0 24px var(--cyan-glow);
    animation: drift 7s ease-in-out infinite;
    animation-delay: calc(var(--i) * -0.9s);
  }
  .rpanel-l { transform: perspective(1200px) rotateY(7deg); }
  .rpanel-r { transform: perspective(1200px) rotateY(-7deg); }
  @keyframes drift { 0%,100% { translate: 0 0; } 50% { translate: 0 -7px; } }
  .cnr { position: absolute; width: 9px; height: 9px; border: 1px solid var(--cyan); opacity: 0.85; }
  .cnr.tl { top: -1px; left: -1px; border-right: 0; border-bottom: 0; }
  .cnr.tr { top: -1px; right: -1px; border-left: 0; border-bottom: 0; }
  .cnr.bl { bottom: -1px; left: -1px; border-right: 0; border-top: 0; }
  .cnr.br { bottom: -1px; right: -1px; border-left: 0; border-top: 0; }
  .rp-top { display: flex; justify-content: space-between; align-items: baseline; gap: 0.4rem; }
  .rp-name { font-size: 0.72rem; color: var(--ink-soft); font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rp-id { font-family: 'IBM Plex Mono', monospace; font-size: 0.56rem; color: var(--ink-faint); letter-spacing: 0.06em; flex-shrink: 0; }
  .rp-read { display: flex; align-items: baseline; justify-content: space-between; gap: 0.4rem; margin: 0.15rem 0 0.1rem; }
  .rp-val { font-family: 'Chakra Petch', sans-serif; font-weight: 700; font-size: 1.75rem; line-height: 1; font-variant-numeric: tabular-nums; text-shadow: 0 0 16px var(--cyan-glow); }
  .rp-pct { font-size: 0.55em; color: var(--ink-faint); margin-left: 1px; }
  .rp-chg { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; white-space: nowrap; }
  .rp-bp { margin-left: 2px; opacity: 0.7; }
  .rp-chg.up { color: var(--bad); }
  .rp-chg.down { color: var(--good); }
  .rp-chg.flat { color: var(--ink-faint); }
  .rp-spark { width: 100%; height: 30px; display: block; margin-top: 0.25rem; }
  .rp-line { fill: none; stroke: var(--cyan); stroke-width: 1.4; vector-effect: non-scaling-stroke; }
  .rp-fill { fill: var(--cyan-glow); opacity: 0.4; stroke: none; }

  /* ===================== DECK (console panels) ===================== */
  .deck-head {
    display: flex; align-items: baseline; gap: 1rem; margin: 3.5rem 0 1.25rem;
    padding-bottom: 0.55rem; border-bottom: 1px solid var(--edge);
  }
  .deck-head .idx { font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; letter-spacing: 0.24em; color: var(--cyan); }
  .deck-head h2 { font-family: 'Chakra Petch', sans-serif; font-weight: 600; font-size: 1.1rem; margin: 0; letter-spacing: 0.02em; }
  .deck-head .hint { margin-left: auto; font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--ink-faint); }

  .deck { display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem; }
  .deck.curve { grid-template-columns: 1.5fr 1fr; }
  .console {
    position: relative; padding: 0; overflow: hidden;
    background: var(--panel); border: 1px solid var(--panel-brd);
    backdrop-filter: blur(10px);
    box-shadow: 0 18px 50px rgba(0,0,0,0.4), 0 0 30px var(--cyan-glow);
    transform: perspective(1800px) rotateX(1.4deg);
  }
  .con-bar {
    display: flex; align-items: center; gap: 0.6rem;
    padding: 0.5rem 0.9rem; border-bottom: 1px solid var(--edge);
    background: linear-gradient(90deg, var(--cyan-glow), transparent 60%);
    font-family: 'IBM Plex Mono', monospace;
  }
  .con-tag { font-size: 0.6rem; letter-spacing: 0.14em; color: var(--cyan); border: 1px solid var(--edge); padding: 1px 5px; }
  .con-title { font-family: 'Chakra Petch', sans-serif; font-weight: 600; font-size: 1rem; letter-spacing: 0.02em; }
  .con-dots { margin-left: auto; width: 46px; height: 6px; background-image: repeating-linear-gradient(90deg, var(--cyan) 0 3px, transparent 3px 7px); opacity: 0.6; }
  .con-body { display: grid; grid-template-columns: minmax(0,0.9fr) minmax(0,1.1fr); gap: 1rem; padding: 1.1rem 1.1rem 0.6rem; align-items: center; }
  .con-big { font-family: 'Chakra Petch', sans-serif; font-weight: 700; font-size: 2.7rem; line-height: 1; font-variant-numeric: tabular-nums; text-shadow: 0 0 22px var(--cyan-glow); }
  .con-sub { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.13em; color: var(--ink-faint); margin: 0.25rem 0 0.35rem; }
  .con-note { font-size: 0.73rem; color: var(--ink-soft); margin: 0.6rem 0 0; max-width: 34ch; }
  .con-spark { width: 100%; height: 96px; display: block; }
  .waterfall { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.4rem 1.1rem 0.9rem; }
  .wf-row { display: grid; grid-template-columns: 13ch 1fr 4.5ch; align-items: center; gap: 0.6rem; font-size: 0.72rem; }
  .wf-label { color: var(--ink-soft); }
  .wf-track { height: 7px; background: var(--edge); border-radius: 4px; overflow: hidden; }
  .wf-bar { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--violet)); }
  .wf-val { font-family: 'IBM Plex Mono', monospace; text-align: right; color: var(--ink); }
  .con-foot { margin: 0; padding: 0.6rem 1.1rem 1rem 2.2rem; font-size: 0.72rem; color: var(--ink-soft); border-top: 1px solid var(--edge); }
  .con-foot li { margin: 0.25rem 0; }

  /* curve + spread */
  .cv-svg { width: 100%; height: auto; display: block; padding: 1.1rem; }
  .cv-grid line { stroke: var(--edge); stroke-width: 1; }
  .cv-axis { font-family: 'IBM Plex Mono', monospace; font-size: 9px; fill: var(--ink-faint); }
  .cv-line { fill: none; stroke: var(--cyan); stroke-width: 2.2; filter: drop-shadow(0 0 6px var(--cyan-glow)); }
  .cv-area { fill: var(--cyan-glow); opacity: 0.25; }
  .cv-node circle { fill: var(--void); stroke: var(--cyan); stroke-width: 2; }
  .cv-node text { font-family: 'IBM Plex Mono', monospace; font-size: 10px; fill: var(--ink); paint-order: stroke; stroke: var(--void); stroke-width: 3px; stroke-linejoin: round; }
  .cv-node .cv-tenor { fill: var(--ink-faint); stroke: none; }
  .spread-wrap { padding: 1.3rem; }
  .spread-big { font-family: 'Chakra Petch', sans-serif; font-weight: 700; font-size: 2.9rem; line-height: 1; font-variant-numeric: tabular-nums; margin: 0.4rem 0 0.2rem; text-shadow: 0 0 22px var(--cyan-glow); }
  .spread-state { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; letter-spacing: 0.14em; text-transform: uppercase; }
  .spread-state.normal { color: var(--good); }
  .spread-state.inverted { color: var(--bad); }
  .spread-copy { font-size: 0.76rem; color: var(--ink-soft); margin-top: 0.8rem; }

  /* ===================== footer strip ===================== */
  .strip {
    margin: 3.5rem 0 1rem; padding: 1rem 1.1rem;
    border: 1px solid var(--panel-brd); background: var(--panel);
    backdrop-filter: blur(8px);
    font-family: 'IBM Plex Mono', monospace; font-size: 0.68rem; color: var(--ink-faint);
    display: grid; gap: 0.45rem;
  }
  .strip b { color: var(--ink-soft); }
  .disclaimer {
    margin-top: 1rem; padding: 1rem 1.1rem; border: 1px solid var(--panel-brd); background: var(--panel);
    backdrop-filter: blur(8px);
    font-family: 'Space Grotesk', sans-serif; font-size: 0.76rem; color: var(--ink-soft); line-height: 1.55;
  }
  .disclaimer b { color: var(--ink); }

  @media (prefers-reduced-motion: reduce) {
    .spin-1, .spin-2, .spin-3, .rpanel, .scan, .gnode.pulse, .live::before { animation: none; }
  }

  /* ===================== responsive ===================== */
  @media (max-width: 1180px) {
    .nexus { min-height: 0; display: flex; flex-direction: column; align-items: center; gap: 1.5rem; }
    .orbit-lines { display: none; }
    .hud-title { position: static; max-width: 640px; text-align: center; }
    .hud-title h1 { font-size: clamp(1.9rem, 6vw, 2.6rem); }
    .readout { border-left: 0; padding-left: 0; justify-items: center; }
    .globe { position: static; transform: none; width: min(70vw, 360px); }
    .rate-field { position: static; display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 0.9rem; width: 100%; }
    .rpanel { position: static !important; width: 100%; left: auto; top: auto; transform: none; animation: none; }
  }
  @media (max-width: 860px) {
    .deck, .deck.curve { grid-template-columns: 1fr; }
    .con-body { grid-template-columns: 1fr; }
  }
  @media (max-width: 520px) {
    .rate-field { grid-template-columns: 1fr; }
    .con-big { font-size: 2.2rem; }
  }
</style>

<div class="field"></div>
<div class="stars"></div>

<main class="wrap">
  <section class="nexus">
    <svg class="orbit-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">${leaders}</svg>

    <div class="hud-title">
      <p class="eyebrow">Multifamily Capital Markets</p>
      <h1>HUD Rate <em>Observatory</em></h1>
      <p>The Treasury and money-market rates that set pricing on FHA 221(d)(4) and HFA Risk&nbsp;Share 50/50 execution &mdash; one live display.</p>
      <div class="readout">
        <span class="live">TRACKING</span>
        <span>RATE DATA <b>${asOf}</b></span>
        <span>REFRESH <b>U.S. business mornings</b></span>
        <span>SOURCE <b>FRED / Treasury H.15</b></span>
      </div>
    </div>

    <div class="globe">
      <svg viewBox="0 0 400 400" role="img" aria-label="Holographic globe of benchmark rates">
        <defs>
          <radialGradient id="core" cx="50%" cy="42%" r="62%">
            <stop offset="0%" stop-color="var(--amber)" stop-opacity="0.30"/>
            <stop offset="45%" stop-color="var(--cyan)" stop-opacity="0.10"/>
            <stop offset="100%" stop-color="var(--void)" stop-opacity="0"/>
          </radialGradient>
          <radialGradient id="atmo" cx="50%" cy="50%" r="50%">
            <stop offset="60%" stop-color="var(--cyan)" stop-opacity="0"/>
            <stop offset="88%" stop-color="var(--cyan)" stop-opacity="0.14"/>
            <stop offset="100%" stop-color="var(--cyan)" stop-opacity="0"/>
          </radialGradient>
        </defs>

        <circle class="atmo" cx="200" cy="200" r="188"/>
        <g class="spin-3"><ellipse class="ring-o f" cx="200" cy="200" rx="188" ry="60" transform="rotate(-16 200 200)"/></g>
        <g class="spin-2"><ellipse class="ring-o v" cx="200" cy="200" rx="172" ry="44" transform="rotate(22 200 200)"/></g>
        <g class="spin-1"><ellipse class="ring-o" cx="200" cy="200" rx="158" ry="78" transform="rotate(64 200 200)"/></g>

        <circle class="sphere" cx="200" cy="200" r="112"/>
        <g class="spin-1" style="animation-duration:120s">
          ${lats}
          ${lons}
        </g>
        <ellipse class="equator" cx="200" cy="200" rx="112" ry="17"/>
        <line class="wire" x1="200" y1="88" x2="200" y2="312"/>
        ${surfaceNodes}
        <ellipse class="scan" cx="200" cy="200" rx="110" ry="15"/>

        <text class="g-tick" x="200" y="66" text-anchor="middle">UST</text>
        <text class="g-tick" x="330" y="205" text-anchor="middle">SOFR</text>
        <text class="g-tick" x="200" y="344" text-anchor="middle">GNMA MBS</text>
        <text class="g-tick" x="70" y="205" text-anchor="middle">FFB</text>
      </svg>
    </div>

    <div class="rate-field">${ratePanels}</div>
  </section>

  <div class="deck-head">
    <span class="idx">02</span>
    <h2>HUD Product Pricing — Modeled</h2>
    <span class="hint">indicative · not a quote</span>
  </div>
  <section class="deck">${consoles}</section>

  <div class="deck-head">
    <span class="idx">03</span>
    <h2>Treasury Curve &amp; Slope</h2>
    <span class="hint">constant maturity</span>
  </div>
  <section class="deck curve">
    <article class="console">
      <span class="cnr tl"></span><span class="cnr tr"></span><span class="cnr bl"></span><span class="cnr br"></span>
      <header class="con-bar"><span class="con-tag">CRV</span><span class="con-title">Yield curve · 2Y → 30Y</span><span class="con-dots"></span></header>
      <svg class="cv-svg" viewBox="0 0 ${cw} ${ch}" role="img" aria-label="Treasury yield curve">
        <g class="cv-grid">${gridY.join('')}</g>
        <path class="cv-area" d="${curveArea}"/>
        <path class="cv-line" d="${curveLine}"/>
        ${curveDots}
      </svg>
    </article>
    <article class="console">
      <span class="cnr tl"></span><span class="cnr tr"></span><span class="cnr bl"></span><span class="cnr br"></span>
      <header class="con-bar"><span class="con-tag">SPR</span><span class="con-title">10Y &minus; 2Y spread</span><span class="con-dots"></span></header>
      <div class="spread-wrap">
        <p class="spread-big">${spread.v > 0 ? '+' : ''}${fmt(spread.v)}<span class="rp-pct">%</span></p>
        <p class="spread-state ${spreadState}">${spreadState === 'normal' ? 'Positively sloped' : 'Inverted'}</p>
        <p class="spread-copy">A standard read on where the curve prices growth and Fed policy. A
          steeper curve generally lifts the 10-Year base that both 221(d)(4) and Risk Share build on.
          As of ${spread.date}.</p>
      </div>
    </article>
  </section>

  <div class="disclaimer">
    <b>Modeling note.</b> HUD product rates shown here are indicative estimates, not rate locks or
    commitments. They are built as: 10-Year Treasury constant-maturity yield &plus; a fixed
    GNMA&nbsp;MBS or FFB execution spread &plus; servicing &plus; mortgage insurance premium. Actual
    pricing depends on GNMA MBS execution the day of rate lock, deal-specific MIP tier (market-rate
    0.65%, broadly affordable 0.25%, green 0.35%), HFA structure, and third-party reports. Confirm all
    pricing with your FHA lender or HFA.
  </div>

  <footer class="strip">
    <span><b>DATA SOURCE</b> Federal Reserve Bank of St. Louis (FRED), no-auth CSV. Series: DGS2 DGS5 DGS7 DGS10 DGS30 SOFR DFF T10Y2Y MORTGAGE30US.</span>
    <span><b>REFRESH</b> regenerated each U.S. business day; FRED posts Treasury yields with a one-day lag.</span>
    <span><b>MODEL SPREADS</b> 221(d)(4) = 10Y + ${fmt(ctx.MODEL.d4.gnmaSpread)} GNMA + ${fmt(ctx.MODEL.d4.servicing)} svc + ${fmt(ctx.MODEL.d4.mip)} MIP &nbsp;·&nbsp; Risk Share = 10Y + ${fmt(ctx.MODEL.rs.ffbSpread)} FFB + ${fmt(ctx.MODEL.rs.servicing)} svc + ${fmt(ctx.MODEL.rs.mip)} premium.</span>
    <span><b>RATE DATA AS OF</b> ${asOf} &nbsp;·&nbsp; not affiliated with HUD, FHA, Ginnie Mae, or the U.S. Treasury.</span>
  </footer>
</main>
`;
}
