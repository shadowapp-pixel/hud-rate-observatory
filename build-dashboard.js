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

  const generated = new Date();
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

  const html = render({ metrics, products, curve, spread, generated, asOf, MODEL,
    tenYear: data.DGS10.slice(-90) });
  fs.writeFileSync(OUT, html);
  process.stderr.write(`wrote ${OUT} (${html.length} bytes)\n`);
})();

// ===========================================================================
function render(ctx) {
  const { metrics, products, curve, spread, generated, asOf } = ctx;
  const genStr = generated.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const chgSpan = c => {
    const s = c > 0.001 ? 'up' : c < -0.001 ? 'down' : 'flat';
    const arrow = s === 'up' ? '▲' : s === 'down' ? '▼' : '±';
    return `<span class="chg ${s}">${arrow} ${(Math.abs(c) * 100).toFixed(1)} bp vs prior</span>`;
  };

  const metricCards = metrics.map(m => {
    const w = 220, h = 46;
    return `
    <article class="tile">
      <header>
        <span class="tile-label">${m.label}</span>
        <span class="tile-src">${m.id}</span>
      </header>
      <div class="tile-value"><span class="num">${fmt(m.value)}</span><span class="pct">%</span></div>
      ${chgSpan(m.chg)}
      <svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <path d="${areaPath(m.series, w, h)}" class="spark-fill"/>
        <path d="${sparkPath(m.series, w, h)}" class="spark-line"/>
      </svg>
      <span class="tile-date">as of ${m.date}</span>
    </article>`;
  }).join('');

  const productCards = products.map(p => {
    const w = 520, h = 120;
    const chg = p.allIn - p.allInPrev;
    const maxStack = Math.max(...p.stack.map(s => s.v));
    const bars = p.stack.map(s => `
      <div class="stack-row">
        <span class="stack-label">${s.label}</span>
        <span class="stack-bar-wrap"><span class="stack-bar" style="width:${(s.v / p.allIn * 100).toFixed(1)}%"></span></span>
        <span class="stack-val">${fmt(s.v)}%</span>
      </div>`).join('');
    return `
    <article class="product" id="prod-${p.key}">
      <div class="product-glow"></div>
      <header class="product-head">
        <div>
          <h3>${p.name}</h3>
          <p class="product-tag">${p.tag}</p>
        </div>
        <div class="product-rate">
          <span class="product-rate-num">${fmt(p.allIn)}<span class="pct">%</span></span>
          <span class="product-rate-label">modeled all-in note rate</span>
          ${chgSpan(chg)}
        </div>
      </header>
      <svg class="product-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">
        <path d="${areaPath(p.hist, w, h)}" class="spark-fill"/>
        <path d="${sparkPath(p.hist, w, h)}" class="spark-line"/>
      </svg>
      <div class="stack">${bars}</div>
      <ul class="product-notes">${p.notes.map(n => `<li>${n}</li>`).join('')}</ul>
    </article>`;
  }).join('');

  // yield curve svg
  const cw = 620, ch = 240, cpad = 40;
  const cvals = curve.map(c => c.v);
  const cmin = Math.floor(Math.min(...cvals) * 2) / 2 - 0.5;
  const cmax = Math.ceil(Math.max(...cvals) * 2) / 2 + 0.5;
  const cx = i => cpad + (i / (curve.length - 1)) * (cw - cpad * 2);
  const cy = v => cpad + (1 - (v - cmin) / (cmax - cmin)) * (ch - cpad * 2);
  const curveLine = curve.map((c, i) => `${i ? 'L' : 'M'}${cx(i).toFixed(1)} ${cy(c.v).toFixed(1)}`).join(' ');
  const curveDots = curve.map((c, i) => {
    const anchor = i === 0 ? 'start' : i === curve.length - 1 ? 'end' : 'middle';
    const tx = i === 0 ? cx(i) + 6 : i === curve.length - 1 ? cx(i) - 6 : cx(i);
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

  return `<title>HUD Rate Observatory</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
<style>
  :root {
    --void: #f4f6fb;
    --panel: rgba(255,255,255,0.72);
    --panel-solid: #ffffff;
    --grid: rgba(20,40,90,0.09);
    --ink: #0d1b3e;
    --ink-soft: #43507a;
    --ink-faint: #7a86ad;
    --cyan: #0a7ea1;
    --cyan-glow: rgba(10,126,161,0.28);
    --violet: #6a3df0;
    --amber: #c26a12;
    --good: #0f8a5f;
    --bad: #d5453b;
    --hair: rgba(20,40,90,0.14);
    --halo: radial-gradient(circle at 50% 40%, rgba(120,180,255,0.30), transparent 70%);
  }
  :root:not([data-theme="light"]) {
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --void: #05070f;
      --panel: rgba(14,22,46,0.60);
      --panel-solid: #0b1226;
      --grid: rgba(90,140,230,0.10);
      --ink: #e8eeff;
      --ink-soft: #9fb0e0;
      --ink-faint: #5e6e9c;
      --cyan: #38e6ff;
      --cyan-glow: rgba(56,230,255,0.30);
      --violet: #9b6bff;
      --amber: #ffb057;
      --good: #34e0a1;
      --bad: #ff6b6b;
      --hair: rgba(90,140,230,0.20);
      --halo: radial-gradient(circle at 50% 38%, rgba(70,120,255,0.28), transparent 68%);
    }
  }
  :root[data-theme="dark"] {
    color-scheme: dark;
    --void: #05070f;
    --panel: rgba(14,22,46,0.60);
    --panel-solid: #0b1226;
    --grid: rgba(90,140,230,0.10);
    --ink: #e8eeff;
    --ink-soft: #9fb0e0;
    --ink-faint: #5e6e9c;
    --cyan: #38e6ff;
    --cyan-glow: rgba(56,230,255,0.30);
    --violet: #9b6bff;
    --amber: #ffb057;
    --good: #34e0a1;
    --bad: #ff6b6b;
    --hair: rgba(90,140,230,0.20);
    --halo: radial-gradient(circle at 50% 38%, rgba(70,120,255,0.28), transparent 68%);
  }

  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--void);
    color: var(--ink);
    font-family: 'Space Grotesk', system-ui, -apple-system, sans-serif;
    line-height: 1.5;
    -webkit-font-smoothing: antialiased;
    overflow-x: hidden;
  }
  .stage {
    position: relative;
    max-width: 1180px;
    margin: 0 auto;
    padding: clamp(1rem, 3vw, 2.5rem);
  }
  .bg-grid {
    position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background-image:
      linear-gradient(var(--grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--grid) 1px, transparent 1px);
    background-size: 46px 46px;
    mask-image: radial-gradient(ellipse 80% 60% at 50% 30%, #000 40%, transparent 100%);
  }
  .bg-halo { position: fixed; inset: 0; z-index: 0; pointer-events: none; background: var(--halo); }
  .stage > * { position: relative; z-index: 1; }

  /* ---------- hero ---------- */
  .hero {
    display: grid;
    grid-template-columns: 1.1fr 0.9fr;
    gap: 2rem;
    align-items: center;
    padding: 1rem 0 2.5rem;
  }
  .eyebrow {
    font-family: 'IBM Plex Mono', monospace;
    font-size: 0.72rem;
    letter-spacing: 0.32em;
    text-transform: uppercase;
    color: var(--cyan);
    margin: 0 0 1rem;
  }
  .hero h1 {
    font-family: 'Chakra Petch', 'Space Grotesk', sans-serif;
    font-weight: 700;
    font-size: clamp(2.1rem, 5vw, 3.4rem);
    line-height: 1.02;
    letter-spacing: -0.01em;
    margin: 0 0 1rem;
    text-wrap: balance;
  }
  .hero h1 em { font-style: normal; color: var(--cyan); }
  .hero p.lede { color: var(--ink-soft); font-size: 1.02rem; max-width: 46ch; margin: 0 0 1.5rem; }
  .stamp {
    display: inline-flex; flex-wrap: wrap; gap: 0.5rem 1.25rem;
    font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem;
    color: var(--ink-faint);
  }
  .stamp b { color: var(--ink); font-weight: 600; }
  .pulse { color: var(--good); }
  .pulse::before {
    content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%;
    background: var(--good); margin-right: 0.4rem; vertical-align: middle;
    box-shadow: 0 0 0 0 var(--good); animation: pulse 2.4s infinite;
  }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--good) 60%, transparent); }
    70% { box-shadow: 0 0 0 9px transparent; }
    100% { box-shadow: 0 0 0 0 transparent; }
  }

  /* ---------- globe ---------- */
  .globe-wrap { position: relative; aspect-ratio: 1; width: 100%; max-width: 360px; margin: 0 auto; }
  .globe-wrap svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
  .ring { fill: none; stroke: var(--cyan); stroke-width: 1; opacity: 0.5; transform-origin: 50% 50%; }
  .ring.r2 { stroke: var(--violet); opacity: 0.4; }
  .ring.r3 { stroke: var(--cyan); opacity: 0.25; }
  .spin-a { animation: spin 26s linear infinite; transform-origin: 50% 50%; }
  .spin-b { animation: spin 40s linear infinite reverse; transform-origin: 50% 50%; }
  .spin-c { animation: spin 60s linear infinite; transform-origin: 50% 50%; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .globe-core { fill: url(#core); stroke: var(--cyan); stroke-width: 1.2; }
  .meridian { fill: none; stroke: var(--cyan); stroke-width: 0.8; opacity: 0.35; }
  .node { fill: var(--cyan); }
  .node.v { fill: var(--violet); }
  .globe-label {
    font-family: 'IBM Plex Mono', monospace; font-size: 9px; fill: var(--ink-faint);
    letter-spacing: 0.15em;
  }
  @media (prefers-reduced-motion: reduce) {
    .spin-a, .spin-b, .spin-c, .pulse::before { animation: none; }
  }

  /* ---------- section frame ---------- */
  .section { margin: 3rem 0; }
  .section-head {
    display: flex; align-items: baseline; gap: 1rem;
    margin-bottom: 1.25rem; padding-bottom: 0.6rem;
    border-bottom: 1px solid var(--hair);
  }
  .section-head h2 {
    font-family: 'Chakra Petch', sans-serif; font-weight: 600;
    font-size: 1.15rem; letter-spacing: 0.02em; margin: 0;
  }
  .section-head .idx {
    font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem;
    color: var(--cyan); letter-spacing: 0.2em;
  }
  .section-head .hint { margin-left: auto; font-size: 0.78rem; color: var(--ink-faint); font-family: 'IBM Plex Mono', monospace; }

  /* ---------- tiles ---------- */
  .tiles { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.9rem; }
  .tile {
    position: relative; padding: 1rem; border-radius: 12px;
    background: var(--panel); border: 1px solid var(--hair);
    backdrop-filter: blur(8px);
    overflow: hidden;
  }
  .tile header { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; }
  .tile-label { font-size: 0.8rem; color: var(--ink-soft); font-weight: 500; }
  .tile-src { font-family: 'IBM Plex Mono', monospace; font-size: 0.62rem; color: var(--ink-faint); letter-spacing: 0.08em; }
  .tile-value { font-family: 'Chakra Petch', sans-serif; font-weight: 700; margin: 0.4rem 0 0.15rem; line-height: 1; }
  .tile-value .num { font-size: 2rem; font-variant-numeric: tabular-nums; }
  .tile-value .pct { font-size: 0.95rem; color: var(--ink-faint); margin-left: 2px; }
  .chg { font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; display: inline-block; }
  .chg.up { color: var(--bad); }
  .chg.down { color: var(--good); }
  .chg.flat { color: var(--ink-faint); }
  .spark { width: 100%; height: 46px; display: block; margin: 0.55rem 0 0.35rem; }
  .spark-line { fill: none; stroke: var(--cyan); stroke-width: 1.6; vector-effect: non-scaling-stroke; }
  .spark-fill { fill: var(--cyan-glow); opacity: 0.5; stroke: none; }
  .tile-date { font-family: 'IBM Plex Mono', monospace; font-size: 0.6rem; color: var(--ink-faint); }

  /* ---------- products ---------- */
  .products { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  .product {
    position: relative; padding: 1.5rem; border-radius: 16px;
    background: var(--panel); border: 1px solid var(--hair);
    backdrop-filter: blur(10px); overflow: hidden;
  }
  .product-glow {
    position: absolute; inset: -40% 40% 60% -40%; pointer-events: none;
    background: radial-gradient(circle, var(--cyan-glow), transparent 70%);
  }
  #prod-rs .product-glow { background: radial-gradient(circle, color-mix(in srgb, var(--violet) 30%, transparent), transparent 70%); }
  .product-head { display: flex; justify-content: space-between; gap: 1rem; align-items: flex-start; }
  .product h3 { font-family: 'Chakra Petch', sans-serif; font-size: 1.3rem; margin: 0 0 0.3rem; }
  .product-tag { font-size: 0.76rem; color: var(--ink-soft); margin: 0; max-width: 32ch; }
  .product-rate { text-align: right; flex-shrink: 0; }
  .product-rate-num { display: block; font-family: 'Chakra Petch', sans-serif; font-weight: 700; font-size: 2.3rem; line-height: 1; font-variant-numeric: tabular-nums; }
  .product-rate-num .pct { font-size: 1rem; color: var(--ink-faint); }
  .product-rate-label { display: block; font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.12em; color: var(--ink-faint); margin: 0.2rem 0 0.3rem; }
  .product-spark { width: 100%; height: 90px; display: block; margin: 1rem 0; opacity: 0.9; }
  .stack { display: flex; flex-direction: column; gap: 0.4rem; margin-top: 0.5rem; }
  .stack-row { display: grid; grid-template-columns: 12ch 1fr 5ch; align-items: center; gap: 0.6rem; font-size: 0.74rem; }
  .stack-label { color: var(--ink-soft); }
  .stack-bar-wrap { height: 8px; background: var(--hair); border-radius: 4px; overflow: hidden; }
  .stack-bar { display: block; height: 100%; background: linear-gradient(90deg, var(--cyan), var(--violet)); border-radius: 4px; }
  .stack-val { font-family: 'IBM Plex Mono', monospace; text-align: right; color: var(--ink); }
  .product-notes { margin: 1rem 0 0; padding-left: 1.1rem; font-size: 0.74rem; color: var(--ink-soft); }
  .product-notes li { margin: 0.25rem 0; }

  /* ---------- curve ---------- */
  .curve-grid { display: grid; grid-template-columns: 1.4fr 1fr; gap: 1.25rem; align-items: stretch; }
  .panel {
    padding: 1.5rem; border-radius: 16px; background: var(--panel);
    border: 1px solid var(--hair); backdrop-filter: blur(10px);
  }
  .panel h3 { font-family: 'Chakra Petch', sans-serif; font-size: 1rem; margin: 0 0 1rem; }
  .curve-svg { width: 100%; height: auto; }
  .cv-grid line { stroke: var(--hair); stroke-width: 1; }
  .cv-axis { font-family: 'IBM Plex Mono', monospace; font-size: 9px; fill: var(--ink-faint); }
  .cv-line { fill: none; stroke: var(--cyan); stroke-width: 2; }
  .cv-node circle { fill: var(--void); stroke: var(--cyan); stroke-width: 2; }
  .cv-node text { font-family: 'IBM Plex Mono', monospace; font-size: 10px; fill: var(--ink); paint-order: stroke; stroke: var(--void); stroke-width: 3px; stroke-linejoin: round; }
  .cv-node .cv-tenor { fill: var(--ink-faint); }
  .spread-big {
    font-family: 'Chakra Petch', sans-serif; font-weight: 700; font-size: 2.6rem;
    font-variant-numeric: tabular-nums; line-height: 1; margin: 0.5rem 0 0.2rem;
  }
  .spread-state { font-family: 'IBM Plex Mono', monospace; font-size: 0.75rem; letter-spacing: 0.15em; text-transform: uppercase; }
  .spread-state.normal { color: var(--good); }
  .spread-state.inverted { color: var(--bad); }
  .spread-copy { font-size: 0.78rem; color: var(--ink-soft); margin-top: 0.75rem; }

  /* ---------- footer ---------- */
  .foot {
    margin: 3.5rem 0 1rem; padding-top: 1.25rem; border-top: 1px solid var(--hair);
    font-family: 'IBM Plex Mono', monospace; font-size: 0.72rem; color: var(--ink-faint);
    display: grid; gap: 0.5rem;
  }
  .foot b { color: var(--ink-soft); }
  .disclaimer {
    margin-top: 1rem; padding: 1rem; border-radius: 10px;
    border: 1px solid var(--hair); background: var(--panel);
    font-family: 'Space Grotesk', sans-serif; font-size: 0.76rem; color: var(--ink-soft); line-height: 1.55;
  }

  @media (max-width: 900px) {
    .hero { grid-template-columns: 1fr; }
    .globe-wrap { order: -1; max-width: 260px; }
    .tiles { grid-template-columns: repeat(2, 1fr); }
    .products { grid-template-columns: 1fr; }
    .curve-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 480px) {
    .tiles { grid-template-columns: 1fr 1fr; }
    .product-rate-num { font-size: 1.8rem; }
  }
</style>

<div class="bg-grid"></div>
<div class="bg-halo"></div>

<main class="stage">
  <section class="hero">
    <div>
      <p class="eyebrow">Multifamily Capital Markets · Daily</p>
      <h1>HUD Rate <em>Observatory</em></h1>
      <p class="lede">A daily read on the Treasury and money-market rates that set pricing for
        FHA <strong>221(d)(4)</strong> construction loans and <strong>HFA Risk&nbsp;Share 50/50</strong> execution.</p>
      <div class="stamp">
        <span class="pulse">LIVE FEED</span>
        <span>Generated <b>${genStr}</b></span>
        <span>Rate data as of <b>${asOf}</b></span>
        <span>Source <b>FRED / U.S. Treasury</b></span>
      </div>
    </div>
    <div class="globe-wrap">
      <svg viewBox="0 0 200 200" role="img" aria-label="Holographic globe visualization">
        <defs>
          <radialGradient id="core" cx="50%" cy="42%" r="60%">
            <stop offset="0%" stop-color="var(--cyan)" stop-opacity="0.35"/>
            <stop offset="55%" stop-color="var(--violet)" stop-opacity="0.12"/>
            <stop offset="100%" stop-color="var(--void)" stop-opacity="0"/>
          </radialGradient>
        </defs>
        <g class="spin-c"><ellipse class="ring r3" cx="100" cy="100" rx="94" ry="34"/></g>
        <g class="spin-b"><ellipse class="ring r2" cx="100" cy="100" rx="88" ry="20"/></g>
        <circle class="globe-core" cx="100" cy="100" r="58"/>
        <g class="spin-a">
          <ellipse class="meridian" cx="100" cy="100" rx="58" ry="22"/>
          <ellipse class="meridian" cx="100" cy="100" rx="40" ry="58"/>
          <ellipse class="meridian" cx="100" cy="100" rx="20" ry="58"/>
          <line class="meridian" x1="100" y1="42" x2="100" y2="158"/>
          <line class="meridian" x1="42" y1="100" x2="158" y2="100"/>
          <circle class="node" cx="128" cy="78" r="2.4"/>
          <circle class="node v" cx="74" cy="122" r="2.4"/>
          <circle class="node" cx="112" cy="130" r="1.8"/>
          <circle class="node v" cx="82" cy="70" r="1.8"/>
        </g>
        <g class="spin-a"><ellipse class="ring" cx="100" cy="100" rx="72" ry="72"/></g>
        <text class="globe-label" x="100" y="184" text-anchor="middle">UST · SOFR · GNMA · FFB</text>
      </svg>
    </div>
  </section>

  <section class="section">
    <div class="section-head">
      <span class="idx">01</span>
      <h2>Benchmark Rates</h2>
      <span class="hint">daily · change vs. prior obs.</span>
    </div>
    <div class="tiles">${metricCards}</div>
  </section>

  <section class="section">
    <div class="section-head">
      <span class="idx">02</span>
      <h2>HUD Product Pricing — Modeled</h2>
      <span class="hint">indicative · not a quote</span>
    </div>
    <div class="products">${productCards}</div>
  </section>

  <section class="section">
    <div class="section-head">
      <span class="idx">03</span>
      <h2>Treasury Curve &amp; Slope</h2>
      <span class="hint">constant maturity</span>
    </div>
    <div class="curve-grid">
      <div class="panel">
        <h3>Yield curve — 2Y to 30Y</h3>
        <svg class="curve-svg" viewBox="0 0 ${cw} ${ch}" role="img" aria-label="Treasury yield curve">
          <g class="cv-grid">${gridY.join('')}</g>
          <path class="cv-line" d="${curveLine}"/>
          ${curveDots}
        </svg>
      </div>
      <div class="panel">
        <h3>10Y &minus; 2Y spread</h3>
        <p class="spread-big">${spread.v > 0 ? '+' : ''}${fmt(spread.v)}<span class="pct" style="font-size:1rem;color:var(--ink-faint)">%</span></p>
        <p class="spread-state ${spreadState}">${spreadState === 'normal' ? 'Positively sloped' : 'Inverted'}</p>
        <p class="spread-copy">The 10Y&minus;2Y spread is a standard read on where the curve is
          pricing growth and Fed policy. A steeper curve generally lifts the 10Y base that
          221(d)(4) and Risk Share both build on. As of ${spread.date}.</p>
      </div>
    </div>
  </section>

  <div class="disclaimer">
    <b>Modeling note.</b> HUD product rates shown here are indicative estimates, not rate locks or
    commitments. They are built as: 10-Year Treasury constant-maturity yield
    &plus; a fixed GNMA&nbsp;MBS or FFB execution spread &plus; servicing &plus; mortgage insurance premium.
    Actual pricing depends on GNMA MBS execution the day of rate lock, deal-specific MIP tier
    (market-rate 0.65%, broadly affordable 0.25%, green 0.35%), HFA structure, and third-party
    reports. Confirm all pricing with your FHA lender or HFA.
  </div>

  <footer class="foot">
    <span><b>Data source:</b> Federal Reserve Bank of St. Louis (FRED) — no-auth CSV endpoint. Series:
      DGS2, DGS5, DGS7, DGS10, DGS30, SOFR, DFF, T10Y2Y, MORTGAGE30US.</span>
    <span><b>Refresh:</b> regenerated each U.S. business day; FRED posts Treasury yields with a one-day lag.</span>
    <span><b>Model spreads:</b> 221(d)(4) = 10Y + ${fmt(ctx.MODEL.d4.gnmaSpread)} GNMA + ${fmt(ctx.MODEL.d4.servicing)} svc + ${fmt(ctx.MODEL.d4.mip)} MIP.
      Risk Share = 10Y + ${fmt(ctx.MODEL.rs.ffbSpread)} FFB + ${fmt(ctx.MODEL.rs.servicing)} svc + ${fmt(ctx.MODEL.rs.mip)} premium.</span>
    <span><b>Generated:</b> ${genStr} · not affiliated with HUD, FHA, Ginnie Mae, or the U.S. Treasury.</span>
  </footer>
</main>
`;
}
