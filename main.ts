// GTA VI trophy rarity forecast (gta6-trophy-rarity-forecast-01).
//
// For each trophy, forecast five quantiles of its Exophase earn rate at the
// case's target, as percentages. The program reads every <id>.in in the
// input directory and writes <id>.out to the output directory.
//
// Method (per trophy):
//   1. Take the trophy's earn-rate reads from the case history, convert each
//      rate to a logit (clamped to [0.01, 99.99] first, as the scorer does).
//   2. Fit a straight line to logit(rate) against ln(1 + hours since the
//      first read), by least squares, over the last 48 hours of reads when
//      the history is longer than that (recent reads carry the current
//      regime; launch-night reads are a different regime). Trophy adoption
//      follows an S-curve: rates rise fast just after launch and then
//      flatten, which a line in log-time captures better than a line in raw
//      time.
//   3. Read the line at the target time for the median logit. When the
//      history is flat (every read the same rate), there is no trend to fit;
//      the median is then the last rate, hedged down by a factor (a flat
//      history means Exophase has not refreshed yet, and a refresh dilutes
//      rates as the tracked-player base jumps).
//   4. The spread widens with the horizon like a random walk on the logit
//      scale, plus the fit's residual scatter, plus a wide band when the
//      history is flat (an unseen refresh can move every rate a long way).
//   5. Quantiles are the median logit plus z_tau * spread, mapped back to
//      percent and rounded to 4 decimals, then forced non-decreasing and
//      clamped to [0, 100].
//
// A trophy at 100% stays at 100%: every tracked player already holds it,
// and the median is pinned there with a tight band.
//
// Runs offline, standard library only, deterministic: the same input always
// writes the same bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Random-walk spread, logit units per square-root day (the house baseline's). */
const SIGMA_RW = 0.5;
/** Spread used when the history is flat (no read differs from the last). */
const SIGMA_FLAT = 1.2;
/** Median hedge for a flat history: multiply the last rate by this. */
const FLAT_MEDIAN_FACTOR = 0.4;
/** Extra spread for the fit's residual scatter, at least this much. */
const SIGMA_FLOOR = 0.15;
/** Fit window: use only reads from the last this many hours, when more exist. */
const FIT_WINDOW_HOURS = 48;

interface CaseFile {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  trophies: Array<{ id: number }>;
  history: Array<{ at: string; rates: Array<number | null> }>;
}

const clampPct = (x: number): number => Math.min(99.99, Math.max(0.01, x));
const logit = (pct: number): number => {
  const c = clampPct(pct);
  return Math.log(c / (100 - c));
};
const invLogit = (l: number): number => 100 / (1 + Math.exp(-l));
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Least-squares line y = a + b*x; returns [a, b, residualStd]. */
function fitLine(xs: number[], ys: number[]): [number, number, number] {
  const n = xs.length;
  if (n === 0) return [0, 0, 0];
  if (n === 1) return [ys[0], 0, 0];
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) {
    sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
  }
  const denom = n * sxx - sx * sx;
  let b = 0;
  if (Math.abs(denom) > 1e-12) b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (a + b * xs[i]);
    ss += r * r;
  }
  const resid = n > 2 ? Math.sqrt(ss / (n - 2)) : 0;
  return [a, b, resid];
}

function forecastTrophy(
  rates: Array<number | null>,
  timesHours: number[],
  horizonMinutes: number,
  targetHours: number,
): number[] {
  // Collect the trophy's reads (skip nulls).
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < rates.length; i++) {
    const r = rates[i];
    if (r === null || r === undefined) continue;
    pts.push([timesHours[i], logit(r)]);
  }
  const lastRate = rates[rates.length - 1];
  // A trophy everyone holds stays held.
  if (lastRate !== null && lastRate !== undefined && lastRate >= 99.99) {
    return [99.9, 99.95, 99.99, 99.99, 99.99];
  }
  if (pts.length === 0) {
    // No reads at all: fall back to a flat 0 with a wide band.
    return Z.map((z) => round4(invLogit(z * SIGMA_FLAT)));
  }
  const lastLogit = pts[pts.length - 1][1];
  // Is the history flat (every read the same rate)?
  let flat = true;
  for (let i = 1; i < pts.length; i++) {
    if (Math.abs(pts[i][1] - pts[0][1]) > 1e-9) { flat = false; break; }
  }
  // Trend fit in log-time: x = ln(1 + hours since first read). When the
  // history spans more than the fit window, keep only the recent reads.
  const lastT = pts[pts.length - 1][0];
  const windowed = pts.filter(([t]) => t >= lastT - FIT_WINDOW_HOURS);
  const use = windowed.length >= 2 ? windowed : pts;
  const xs = use.map(([t]) => Math.log(1 + t));
  const ys = use.map(([, y]) => y);
  const [a, b, resid] = fitLine(xs, ys);
  const xTarget = Math.log(1 + targetHours);
  let medianLogit = a + b * xTarget;
  // Do not let a wild extrapolation run away: keep the median within a
  // sane band around the last rate (at most ~3 logit units either way).
  medianLogit = Math.min(lastLogit + 3, Math.max(lastLogit - 3, medianLogit));
  const horizonDays = horizonMinutes / 1440;
  const rw = SIGMA_RW * Math.sqrt(horizonDays);
  let spread: number;
  if (flat) {
    // No trend to trust and a refresh may be coming: hedge the median down
    // and use a wide band.
    const base = lastRate === null || lastRate === undefined ? 0.01 : lastRate;
    medianLogit = logit(clampPct(base) * FLAT_MEDIAN_FACTOR);
    // Keep the hedged median inside the same sane band.
    medianLogit = Math.min(lastLogit + 3, Math.max(lastLogit - 3, medianLogit));
    spread = SIGMA_FLAT;
  } else {
    spread = Math.sqrt(rw * rw + resid * resid + SIGMA_FLOOR * SIGMA_FLOOR);
  }
  const qs = Z.map((z) => round4(invLogit(medianLogit + z * spread)));
  // Force non-decreasing and inside [0, 100].
  let prev = -1;
  return qs.map((q) => {
    const v = Math.min(100, Math.max(0, q));
    const out = Math.max(v, prev);
    prev = out;
    return out;
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  if (c.history.length === 0) throw new Error(`${file} has no history`);
  const t0 = Date.parse(c.history[0].at);
  const targetHours = (Date.parse(c.target) - t0) / 3_600_000;
  const timesHours = c.history.map((h) => (Date.parse(h.at) - t0) / 3_600_000);
  const trophies = c.trophies.map((t, i) => {
    const rates = c.history.map((h) => h.rates[i]);
    return { id: t.id, q: forecastTrophy(rates, timesHours, c.horizon_minutes, targetHours) };
  });
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
