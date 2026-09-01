# HUD Rate Observatory

Generator for a daily rate-tracking dashboard covering the Treasury and
money-market benchmarks that drive pricing on **FHA 221(d)(4)** construction
loans and **HFA Risk Share 50/50** (Section 542(c)) execution.

## How it runs

Two scheduled pieces, because the Claude refresh sandbox can't reach FRED directly:

1. **`.github/workflows/refresh-rates.yml`** — GitHub Action, weekday mornings
   (10:00 UTC). GitHub runners have open internet, so this is where the FRED
   fetch happens. It writes `data/*.csv` and commits any changes.
2. **Claude Code "daily refresh" routine** — an hour later (11:00 UTC). Clones
   this repo, runs `build-dashboard.js` against the committed CSVs, and
   republishes the dashboard Artifact at its existing URL.

`build-dashboard.js` reads `data/*.csv` first and only falls back to a live
FRED fetch when a CSV is missing (handy for local development).

## Data

Nine series from FRED (no authentication / API key needed):

| Series | Meaning |
| --- | --- |
| `DGS2 DGS5 DGS7 DGS10 DGS30` | Treasury constant-maturity yields |
| `SOFR` | Secured Overnight Financing Rate |
| `DFF` | Effective Federal Funds Rate |
| `T10Y2Y` | 10-year minus 2-year spread |
| `MORTGAGE30US` | Freddie Mac 30-year PMMS (weekly) |

It then renders a self-contained, theme-aware HTML file (`dashboard.html`)
in a "futuristic multidimensional display" style and writes it to disk.

## HUD product rates are modeled

The 221(d)(4) and Risk Share "all-in note rate" figures are **indicative
estimates, not quotes**. They are built as:

```
10-year UST  +  execution spread  +  servicing  +  mortgage insurance premium
```

Spread assumptions live in the `MODEL` object at the top of
`build-dashboard.js` — edit them to match your desk's read of GNMA MBS
execution and FFB pricing.

## Run

```bash
node build-dashboard.js      # writes dashboard.html
```

Requires Node 18+ (uses the built-in `fetch`). With `data/*.csv` present it
runs fully offline.
