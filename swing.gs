/* ============================================================================
 * SWING — multi-day option trades (hold about 3-15 trading days) with a paper log and a monthly scorecard
 * ----------------------------------------------------------------------------
 * Apps Script only — no Cloud Function redeploy. Needs a TastyTrade token for option quotes. Phone alerts use the same setup as Day / Flip.
 * Reuses from other files (called at run time): momentum.gs (getTastyTradeAccessToken_, fetchTastyOptionChainNested_, fetchTastyMarketDataBatch_,
 *   buildOccSymbol_, getAlertConfig_, sendPhoneAlert_, notify_, tryGetUi_, logToSheet_, getFinnhubApiKey_, fetchFinnhubNextEarnings_,
 *   fetchYahooNextEarnings_), Long.gs (longPrefetchQuotes_: stock quotes in batches of 20).
 *
 * WHAT IT DOES
 *   1. Daily bars (1 year, Yahoo, cached 6 h) -> trend, pullback / breakout setups, score 0-100.
 *   (rules: market filter on SPY, relative-strength leaders near the 52-week extreme, pullback or breakout trigger, breakeven + trailing stop; see SWING_CONFIG)
 *   2. For a BUY / SHORT: a call / put about 50 days out (window 40-65), delta about 0.65, limit near the mid.
 *   3. Gates: earnings inside the hold window, spread, stop width vs spread, delta, open-position and daily limits.
 *   4. Every signal is logged on SwingLog as a hypothetical one-contract trade (Approved YES = passed the gates; NO = shadow row, for comparison)
 *      and followed with the exit rules until it closes. SwingScore sums it up (month to date, last 30 days, by setup, by exit reason...).
 *   5. Phone alerts: approved signal, every exit, daily summary.
 *
 * NOTHING HERE IS BACKTESTED. The thresholds are starting values (SWING_CONFIG). Paper results are approximations: marks are taken only when the
 * script runs (3 times a day), exits are at the bid, and a stop touched between runs is closed at the next run's bid.
 * ========================================================================== */

const SWING_SHEET = 'Swing';
const SWING_LOG_SHEET = 'SwingLog';
const SWING_SCORE_SHEET = 'SwingScore';
const SWING_TICK_FN = 'swingTick_';

const SWING_CONFIG = {
  signal: {
    minPrice: 20, minAvgVol: 1500000, minAtrPct: 1.5, maxAtrPct: 7,
    minScore: 60, watchScore: 45,
    pullbackRsi: { long: [38, 58], short: [42, 62] },
    breakoutRvol: 1.5, maxExtendAtr: 2.5, lateR: 0.8,      // breakout volume 1.5x average (common rule); LATE = price already ran this many R past the close
    regime: { enabled: true },                              // longs only while SPY is above its 200-day; shorts only while SPY is below its 50-day
    leaderRs: 0,                                            // longs need to be beating SPY over 3-6 months (RS vs SPY above this); shorts the reverse
    maxFromHighPct: 25                                      // longs must be within this % of the 52-week high (shorts: of the 52-week low)
  },
  trade: {
    minStopAtr: 1.5, maxStopAtr: 3.5, stopBufferAtr: 0.5, targetR: 2.0,
    breakevenR: 1.0,          // once the stock has moved this many R your way, the stop moves to the entry price
    trailAtr: 2.0,            // ...and then trails this many ATR behind the best close
    maxHoldDays: 15,          // trading days: time exit
    noProgressDays: 8,        // after this many trading days, less than noProgressR of progress toward the target = exit
    noProgressR: 0.5,
    premiumStopPct: 50        // safety: option bid down this much from the entry = exit
  },
  option: {
    minDte: 40, targetDte: 50, maxDte: 65,      // buy about 2-3x longer than the expected hold, and stay out of the fast-decay zone (under about 30 days)
    exitDte: 21,                                 // close (or roll) when this many days are left
    targetDelta: 0.65, minDelta: 0.55, maxDelta: 0.80,
    maxSpreadPct: 8, minOi: 200,
    limitSpreadFrac: 0.25,
    strikesEachSide: 4
  },
  gates: {
    earnings: { enabled: true },                 // blocked when the company reports before the planned exit
    maxSpreadOfGain: 0.30,                       // spread in dollars at most this share of the planned option gain
    minStopSpreads: 3,                           // the option's move to the stock stop must be at least this many spreads wide (0 = off)
    maxIvRank: 70,                               // IV Rank above this: a single long option is expensive (IV falls back toward normal and eats gains)
    maxOpen: 5, maxNewPerDay: 3                  // 5 open x 1% risk = 5% total open risk (the usual 5-6% conservative cap)
  },
  risk: { riskUsd: 300 },                        // used only for the Qty Sug column (contracts so that a stop-out costs about this much)
  alertBlocked: false,                           // also message signals the gates held back
  lookupsPerScan: 8,
  shadowPerDay: 5,
  timeBudgetMs: 4.5 * 60 * 1000,
  schedule: { slots: ['09:50', '12:30', '15:30'], summaryHm: '16:10', graceMin: 25 }
};

const SWING_STARTER = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'AVGO', 'AMD', 'NFLX', 'CRM', 'ORCL', 'ADBE', 'NOW', 'PANW', 'CRWD', 'UBER', 'SHOP', 'PLTR', 'COIN',
  'JPM', 'GS', 'V', 'MA', 'BAC', 'LLY', 'UNH', 'ABBV', 'MRK', 'ISRG', 'COST', 'WMT', 'HD', 'LOW', 'NKE', 'SBUX', 'MCD', 'BKNG', 'DIS', 'CAT', 'DE', 'GE', 'BA', 'LMT', 'XOM', 'CVX',
  'QCOM', 'MU', 'AMAT', 'LRCX', 'ANET', 'ON', 'MRVL', 'SMCI', 'INTC', 'CSCO', 'IBM', 'TXN', 'SPY', 'QQQ', 'IWM'];

/* ---------------------------------------------------------------------------
 * COLUMNS
 * ------------------------------------------------------------------------- */
const SWING_INPUT_HEADERS = ['Ticker', 'Entry Date', 'Entry', 'Qty'];                       // yours
const SWING_USER_COLS = ['Side', 'Expiry', 'Strike', 'Stock Stop', 'Stock Target'];          // yours on a row where you filled Qty, Entry or Entry Date; the script's plan otherwise
const SWING_HEADERS = ['Ticker', 'Price', 'Change', 'Entry Date', 'Entry', 'Qty', 'Action', 'Side', 'Setup', 'Score', 'Expiry', 'Strike', 'DTE', 'Delta', 'Mid', 'Limit',
  'Spread %', 'OI', 'VOL', 'Stock Stop', 'Stock Target', 'R:R', 'Risk $/lot', 'Qty Sug', 'Trend', 'RSI', 'ATR %', 'RS vs SPY %', 'RVOL', 'Off High %', 'IV Rank', 'Earn Days',
  'Days', 'P/L %', 'P/L $', 'Gate', 'Why', 'LastRun'];
const SWING_OUTPUT_HEADERS = SWING_HEADERS.filter(function (h) { return SWING_INPUT_HEADERS.indexOf(h) === -1; });

const SWING_LOG_HEADERS = ['Date', 'Ticker', 'Side', 'Setup', 'Score', 'Approved', 'Status', 'Contract', 'Expiry', 'DTE', 'Delta', 'Entry Time', 'Stock Entry', 'Stock Stop',
  'Stock Target', 'Entry', 'Mark', 'Open P/L $', 'Exit', 'Exit Time', 'P/L $', 'P/L %', 'Days Held', 'Max Fav %', 'Max Adv %', 'Spread %', 'Symbol', 'Blocked By',
  'Why', 'Exit Why', 'Stock Exit', 'Stock Move %'];
const SWING_SETTLED = ['STOPPED', 'TARGET', 'PREMIUM STOP', 'DTE EXIT', 'TREND EXIT', 'TIME EXIT', 'NO PROGRESS'];

/* ---------------------------------------------------------------------------
 * SMALL HELPERS (pure)
 * ------------------------------------------------------------------------- */
function swingLin_(v, zero, full) {
  if (v == null || isNaN(v)) return 0;
  const t = (v - zero) / (full - zero);
  return t < 0 ? 0 : (t > 1 ? 1 : t);
}
function swingR2_(v) { return v == null || !isFinite(v) ? '' : Math.round(v * 100) / 100; }
function swingR1_(v) { return v == null || !isFinite(v) ? '' : Math.round(v * 10) / 10; }
function swingNum_(v) { if (v === '' || v == null) return null; const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[$,%\s]/g, '')); return isNaN(n) ? null : n; }
function swingPad2_(n) { return (n < 10 ? '0' : '') + n; }

// US Eastern date parts without any sheet or script time-zone dependence on the machine.
function swingEt_(now) {
  const f = Utilities.formatDate(now || new Date(), 'America/New_York', 'yyyy-MM-dd HH:mm u').split(/[\s]/);
  const hm = f[1].split(':');
  return { ymd: f[0], m: parseInt(hm[0], 10) * 60 + parseInt(hm[1], 10), dow: parseInt(f[2], 10) };   // dow 1 = Monday ... 7 = Sunday
}
function swingIsTradingDay_(ymd, dow) {
  if (dow === 6 || dow === 7) return false;
  return !(typeof US_MARKET_HOLIDAYS !== 'undefined' && US_MARKET_HOLIDAYS[ymd]);
}
function swingYmdAdd_(ymd, days) {
  const p = ymd.split('-'), d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2], 12));
  d.setUTCDate(d.getUTCDate() + days);
  return d.getUTCFullYear() + '-' + swingPad2_(d.getUTCMonth() + 1) + '-' + swingPad2_(d.getUTCDate());
}
function swingDaysBetween_(a, b) {   // calendar days from ymd a to ymd b
  const pa = a.split('-'), pb = b.split('-');
  return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
}
// Trading days after `from` up to and including `to` (weekdays minus the holidays the project knows about).
function swingTradingDaysBetween_(from, to) {
  let n = 0, cur = from, guard = 0;
  while (cur < to && guard++ < 400) {
    cur = swingYmdAdd_(cur, 1);
    const p = cur.split('-'), dow = ((new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay() + 6) % 7) + 1;
    if (swingIsTradingDay_(cur, dow)) n++;
  }
  return n;
}

// Calendar day {y,m,d} of a date cell or text, independent of time zones (same reading rules as the Flip tab).
function swingDayOfCell_(v) {
  if (v == null || v === '') return null;
  const ok = function (y, m, d) { return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? { y: y, m: m, d: d } : null; };
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return null;
    const u = new Date(v.getTime() + 6 * 3600000);   // midnight in GMT or a US zone, or a time up to 17:59 GMT, lands on the right day
    return ok(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
  }
  if (typeof v === 'number') {
    if (v < 20000 || v > 80000) return null;
    const u = new Date(Date.UTC(1899, 11, 30) + Math.floor(v) * 86400000);
    return ok(u.getUTCFullYear(), u.getUTCMonth() + 1, u.getUTCDate());
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(s);
  if (m) return ok(+m[1], +m[2], +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:[T\s].*)?$/.exec(s);
  if (m) return ok(+m[3] < 100 ? 2000 + +m[3] : +m[3], +m[1], +m[2]);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : ok(d.getFullYear(), d.getMonth() + 1, d.getDate());
}
function swingYmdOfCell_(v) { const d = swingDayOfCell_(v); return d ? d.y + '-' + swingPad2_(d.m) + '-' + swingPad2_(d.d) : ''; }

/* ---------------------------------------------------------------------------
 * INDICATORS + SIGNAL (pure). bars = [[ymd, high, low, close, volume], ...] oldest first, completed sessions only
 * ------------------------------------------------------------------------- */
function swingSma_(arr, n, endIdx) {
  if (endIdx - n + 1 < 0) return null;
  let s = 0; for (let i = endIdx - n + 1; i <= endIdx; i++) s += arr[i];
  return s / n;
}
function swingEmaLast_(arr, n) {
  if (arr.length < n) return null;
  const k = 2 / (n + 1); let e = swingSma_(arr, n, n - 1);
  for (let i = n; i < arr.length; i++) e = arr[i] * k + e * (1 - k);
  return e;
}
function swingRsi_(closes, n) {
  if (closes.length < n + 2) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i - 1]; if (d >= 0) g += d; else l -= d; }
  g /= n; l /= n;
  for (let i = n + 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g = (g * (n - 1) + (d > 0 ? d : 0)) / n; l = (l * (n - 1) + (d < 0 ? -d : 0)) / n; }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function swingAtr_(bars, n) {
  if (bars.length < n + 2) return null;
  const tr = function (i) { const pc = bars[i - 1][3]; return Math.max(bars[i][1] - bars[i][2], Math.abs(bars[i][1] - pc), Math.abs(bars[i][2] - pc)); };
  let a = 0; for (let i = 1; i <= n; i++) a += tr(i); a /= n;
  for (let i = n + 1; i < bars.length; i++) a = (a * (n - 1) + tr(i)) / n;
  return a;
}

// Features of the last completed session. Returns null with fewer than 210 sessions.
function swingFeatures_(bars) {
  const n = bars ? bars.length : 0;
  if (n < 210) return null;
  const H = bars.map(function (b) { return b[1]; }), L = bars.map(function (b) { return b[2]; }), C = bars.map(function (b) { return b[3]; }), V = bars.map(function (b) { return b[4]; });
  const i = n - 1, last = bars[i];
  const maxOf = function (a, from, to) { let m = -Infinity; for (let k = from; k <= to; k++) if (a[k] > m) m = a[k]; return m; };
  const minOf = function (a, from, to) { let m = Infinity; for (let k = from; k <= to; k++) if (a[k] < m) m = a[k]; return m; };
  const atr = swingAtr_(bars, 14), rsi = swingRsi_(C, 14), rsiPrev = swingRsi_(C.slice(0, -1), 14);
  const avgVol = swingSma_(V, 20, i - 1);
  const range = last[1] - last[2];
  return {
    n: n, date: last[0], close: C[i], high: H[i], low: L[i], prevClose: C[i - 1], prevHigh: H[i - 1], prevLow: L[i - 1], vol: V[i], volPrev: V[i - 1],
    pullVol: (V[i - 1] + V[i - 2] + V[i - 3] + V[i - 4]) / 4,
    sma20: swingSma_(C, 20, i), sma50: swingSma_(C, 50, i), sma200: swingSma_(C, 200, i), sma50prev: swingSma_(C, 50, i - 10),
    ema21: swingEmaLast_(C, 21), rsi: rsi, rsiPrev: rsiPrev, atr: atr, atrPct: atr / C[i] * 100,
    hh20: maxOf(H, i - 20, i - 1), ll20: minOf(L, i - 20, i - 1), hh52: maxOf(H, Math.max(0, i - 251), i), ll52: minOf(L, Math.max(0, i - 251), i),
    minLow5: minOf(L, i - 4, i), maxHigh5: maxOf(H, i - 4, i), swingLow8: minOf(L, i - 7, i), swingHigh8: maxOf(H, i - 7, i),
    avgVol: avgVol, rvol: avgVol > 0 ? V[i] / avgVol : null, closePos: range > 0 ? (C[i] - L[i]) / range : 0.5,
    ret63: C[i - 63] > 0 ? (C[i] / C[i - 63] - 1) * 100 : null, ret126: C[i - 126] > 0 ? (C[i] / C[i - 126] - 1) * 100 : null,
    offHigh: (1 - C[i] / maxOf(H, Math.max(0, i - 251), i)) * 100
  };
}

function swingTrendLabel_(f) {
  if (!f) return '';
  if (f.close > f.sma50 && f.sma50 > f.sma200) return f.sma50 > f.sma50prev ? 'Up' : 'Up (flat)';
  if (f.close < f.sma50 && f.sma50 < f.sma200) return f.sma50 < f.sma50prev ? 'Down' : 'Down (flat)';
  return 'Mixed';
}

// The decision for one stock. spy = SPY features (or null). Returns { action, side, setup, score, why[], stop, target, dist, stopAtr, rs, roomR }.
function swingSignal_(f, spy, cfg) {
  const S = cfg.signal, T = cfg.trade;
  if (!f) return { action: 'SKIP', why: ['no daily history (needs 210+ sessions)'], score: 0 };
  if (f.close < S.minPrice) return { action: 'SKIP', why: ['price under $' + S.minPrice], score: 0 };
  if (!(f.avgVol >= S.minAvgVol)) return { action: 'SKIP', why: ['average volume under ' + Math.round(S.minAvgVol / 1e5) / 10 + 'M shares'], score: 0 };
  if (f.atrPct < S.minAtrPct || f.atrPct > S.maxAtrPct) return { action: 'SKIP', why: ['ATR ' + swingR1_(f.atrPct) + '% outside ' + S.minAtrPct + '-' + S.maxAtrPct + '%'], score: 0 };
  const up = f.close > f.sma50 && f.sma50 > f.sma200 && f.sma50 > f.sma50prev;
  const dn = f.close < f.sma50 && f.sma50 < f.sma200 && f.sma50 < f.sma50prev;
  if (!up && !dn) return { action: 'WAIT', why: ['no clean trend (needs price > 50-day > 200-day with the 50-day rising, or the mirror image)'], score: 0 };
  const side = up ? 'LONG' : 'SHORT', sgn = up ? 1 : -1;
  const rsiBand = up ? S.pullbackRsi.long : S.pullbackRsi.short;

  const touched = up ? f.minLow5 <= f.ema21 * 1.01 : f.maxHigh5 >= f.ema21 * 0.99;
  const reclaimed = up ? f.close >= f.ema21 : f.close <= f.ema21;
  const turned = up ? f.close > f.prevHigh : f.close < f.prevLow;   // trigger: the first day closing above the prior day's high (below its low for shorts)
  const rsiOk = f.rsi != null && f.rsi >= rsiBand[0] && f.rsi <= rsiBand[1];
  const pullback = touched && reclaimed && turned && rsiOk;
  const extend = sgn * (f.close - f.sma20) / f.atr;
  const brk = up ? (f.close > f.hh20 && f.closePos >= 0.6) : (f.close < f.ll20 && f.closePos <= 0.4);
  const breakout = brk && f.rvol != null && f.rvol >= S.breakoutRvol && extend <= S.maxExtendAtr;

  const rs = (function () {
    const g = [];
    if (spy && f.ret63 != null && spy.ret63 != null) g.push(f.ret63 - spy.ret63);
    if (spy && f.ret126 != null && spy.ret126 != null) g.push(f.ret126 - spy.ret126);
    return g.length ? g.reduce(function (a, b) { return a + b; }, 0) / g.length : null;
  })();

  const near = up ? f.offHigh : (f.close / f.ll52 - 1) * 100;
  if (S.regime.enabled && spy) {
    if (up && !(spy.close > spy.sma200)) return { action: 'WAIT', side: side, why: ['market filter: SPY is under its 200-day average, no new longs'], score: 0, rs: rs };
    if (!up && !(spy.close < spy.sma50)) return { action: 'WAIT', side: side, why: ['market filter: SPY is above its 50-day average, no new shorts'], score: 0, rs: rs };
  }
  if (rs != null && sgn * (rs - S.leaderRs) < 0) return { action: 'WAIT', side: side, why: ['not a leader: ' + swingR1_(rs) + '% vs SPY over 3-6 months (' + (up ? 'longs need to beat' : 'shorts need to lag') + ' SPY)'], score: 0, rs: rs };
  if (near > S.maxFromHighPct) return { action: 'WAIT', side: side, why: [swingR1_(near) + '% from the 52-week ' + (up ? 'high' : 'low') + ' (max ' + S.maxFromHighPct + '%): stocks near the extreme tend to keep going'], score: 0, rs: rs };
  if (!pullback && !breakout) {
    const watching = touched && !(reclaimed && turned);
    const why = watching ? ['pullback in progress: waiting for a close back ' + (up ? 'above' : 'below') + ' the 21-day average (' + swingR2_(f.ema21) + ') and a ' + (up ? 'up' : 'down') + ' day'] :
      ['trend ' + side + ' but no setup (' + swingR1_(sgn * (f.close / f.ema21 - 1) * 100) + '% ' + (up ? 'above' : 'below') + ' the 21-day average, RSI ' + swingR1_(f.rsi) + ')'];
    return { action: watching ? 'WATCH' : 'WAIT', side: side, why: why, score: 0, rs: rs };
  }
  const setup = breakout ? (up ? 'BREAKOUT' : 'BREAKDOWN') : 'PULLBACK';
  // stock stop: beyond the swing low / high (pullback) or back inside the broken level (breakout), kept between minStopAtr and maxStopAtr
  let stop = breakout ? (up ? f.hh20 - 0.75 * f.atr : f.ll20 + 0.75 * f.atr) : (up ? f.swingLow8 - T.stopBufferAtr * f.atr : f.swingHigh8 + T.stopBufferAtr * f.atr);
  let dist = sgn * (f.close - stop);
  const lo = T.minStopAtr * f.atr, hi = T.maxStopAtr * f.atr;
  if (dist < lo) dist = lo; else if (dist > hi) dist = hi;
  stop = f.close - sgn * dist;
  const target = f.close + sgn * T.targetR * dist;
  const roomR = up ? (f.hh52 - f.close) / dist : (f.close - f.ll52) / dist;

  // score 0-100: trend 25, setup 25, volatility fit 15, nearness to the 52-week extreme 15, market 10, liquidity 10
  const trendS = 10 * swingLin_(sgn * (f.sma50 / f.sma200 - 1) * 100, 0, 8) + 8 * swingLin_(sgn * (f.sma50 / f.sma50prev - 1) * 100, 0, 3) + 7 * swingLin_(rs == null ? 0 : sgn * rs, -5, 12);
  const setupS = breakout ? 12 * swingLin_(f.rvol, S.breakoutRvol, 2.5) + 8 * swingLin_(up ? f.closePos : 1 - f.closePos, 0.6, 1) + 5 * swingLin_(S.maxExtendAtr - extend, 0, S.maxExtendAtr) :
    15 * (1 - Math.min(1, Math.abs(f.rsi - (up ? 46 : 54)) / 16)) + 5 * (touched ? 1 : 0.5) + 3 * (f.pullVol < f.avgVol ? 1 : 0) + 2 * (f.vol > f.volPrev ? 1 : 0);   // quiet pullback, busier turn day
  const volS = 15 * (1 - Math.min(1, Math.max(0, f.atrPct < 2 ? 2 - f.atrPct : (f.atrPct > 4.5 ? f.atrPct - 4.5 : 0)) / 2));
  const roomS = 15 * (1 - Math.min(1, Math.max(0, near) / S.maxFromHighPct));   // closer to the 52-week extreme = better
  let mkt = 5;
  if (spy) {
    const a = up ? (spy.close > spy.sma200 ? 1 : 0) + (spy.close > spy.sma50 ? 1 : 0) : (spy.close < spy.sma200 ? 1 : 0) + (spy.close < spy.sma50 ? 1 : 0);
    mkt = a === 2 ? 10 : (a === 1 ? 5 : 0);
  }
  const liqS = 10 * swingLin_(f.avgVol, S.minAvgVol, 8000000);
  const score = Math.round((trendS + setupS + volS + roomS + mkt + liqS) * 10) / 10;
  const why = [setup + ' (' + side + ')', 'RSI ' + swingR1_(f.rsi), breakout ? 'volume ' + swingR1_(f.rvol) + 'x average' : 'back above the 21-day average after touching it',
    'stop ' + swingR2_(stop) + ' (' + swingR1_(dist / f.atr) + ' ATR), target ' + swingR2_(target)];
  why.push(swingR1_(near) + '% from the 52-week ' + (up ? 'high' : 'low') + ', ' + swingR1_(rs) + '% vs SPY');
  const action = score >= S.minScore ? (up ? 'BUY' : 'SHORT') : (score >= S.watchScore ? 'WATCH' : 'WAIT');
  if (action === 'WATCH' || action === 'WAIT') why.push('Score ' + score + ' under ' + S.minScore);
  return { action: action, side: side, setup: setup, score: score, why: why, stop: stop, target: target, dist: dist, stopAtr: dist / f.atr, rs: rs, roomR: roomR };
}

/* ---------------------------------------------------------------------------
 * OPTION PLAN (pure pieces)
 * ------------------------------------------------------------------------- */
// dates = [{ ymd }] expiries; returns the ymd closest to targetDte inside [minDte, maxDte] (a standard monthly gets a small preference), or null.
function swingPickExpiry_(ymds, todayYmd, cfg) {
  const O = cfg.option;
  let best = null, bestRank = Infinity;
  ymds.forEach(function (y) {
    const dte = swingDaysBetween_(todayYmd, y);
    if (dte < O.minDte || dte > O.maxDte) return;
    const p = y.split('-'), dow = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).getUTCDay(), monthly = dow === 5 && +p[2] >= 15 && +p[2] <= 21;
    const rank = Math.abs(dte - O.targetDte) - (monthly ? 5 : 0);
    if (rank < bestRank) { bestRank = rank; best = y; }
  });
  return best;
}

// cands = [{ strike, delta, bid, ask, oi, volume, sym }] for one expiry and one side.
function swingChooseContract_(cands, side, price, cfg) {
  const O = cfg.option;
  const ok = cands.filter(function (c) {
    if (!(c.bid > 0) || !(c.ask > 0) || c.ask < c.bid) return false;
    const mid = (c.bid + c.ask) / 2, sp = c.ask - c.bid;
    if (sp > 0.10 && sp / mid * 100 > O.maxSpreadPct) return false;
    if (c.oi != null && c.oi < O.minOi) return false;
    if (c.delta != null) { const d = Math.abs(c.delta); if (d < O.minDelta || d > O.maxDelta) return false; }
    return true;
  });
  if (!ok.length) return null;
  const sign = side === 'LONG' ? 1 : -1;
  const rank = function (c) {
    const mid = (c.bid + c.ask) / 2, spPct = (c.ask - c.bid) / mid;
    if (c.delta != null) return Math.abs(Math.abs(c.delta) - O.targetDelta) + spPct * 0.5;
    return Math.abs((price - c.strike) * sign - price * 0.04) / price + spPct * 0.5 + 0.2;   // no delta: about 4% in the money, and a penalty
  };
  return ok.slice().sort(function (a, b) { return rank(a) - rank(b); })[0];
}

// First-order option plan from the stock plan. optStop / optTarget are estimates of the option price when the stock reaches the stop / target.
function swingPlan_(c, price, stopPx, targetPx, cfg, riskUsd) {
  const O = cfg.option, mid = (c.bid + c.ask) / 2, sp = c.ask - c.bid;
  const limit = Math.min(c.ask, Math.round((mid + O.limitSpreadFrac * sp) * 100) / 100);
  const d = c.delta != null ? Math.abs(c.delta) : O.targetDelta;
  const optStop = Math.max(0.01, Math.round((limit - d * Math.abs(price - stopPx)) * 100) / 100);
  const optTarget = Math.round((limit + d * Math.abs(targetPx - price)) * 100) / 100;
  const riskLot = (limit - optStop) * 100;
  return { mid: Math.round(mid * 100) / 100, limit: limit, optStop: optStop, optTarget: optTarget, spreadUsd: sp, spreadPct: sp / mid * 100, delta: c.delta, oi: c.oi, volume: c.volume,
    riskLot: Math.round(riskLot), rr: riskLot > 0 ? (optTarget - limit) * 100 / riskLot : null, qtySug: riskLot > 0 ? Math.max(1, Math.floor(riskUsd / riskLot)) : 1 };
}

/* ---------------------------------------------------------------------------
 * GATES (pure)
 * r = { plan, expiryYmd, earnYmd, todayYmd, hasPlan }, guard = { open, newToday, haveTicker }
 * ------------------------------------------------------------------------- */
function swingGate_(r, guard, cfg) {
  const G = cfg.gates, why = [];
  if (!r.plan) { why.push(r.noPlanWhy || 'no option plan'); return { ok: false, why: why }; }
  const p = r.plan;
  if (p.spreadPct > cfg.option.maxSpreadPct && p.spreadUsd > 0.10) why.push('spread ' + swingR1_(p.spreadPct) + '% over ' + cfg.option.maxSpreadPct + '%');
  const gain = p.optTarget - p.limit;
  if (gain > 0 && p.spreadUsd > G.maxSpreadOfGain * gain) why.push('spread costs ' + Math.round(p.spreadUsd / gain * 100) + '% of the planned gain');
  const move = p.limit - p.optStop;
  if (G.minStopSpreads > 0 && p.spreadUsd > 0 && move < G.minStopSpreads * p.spreadUsd) why.push('stop only ' + swingR1_(move / p.spreadUsd) + 'x the bid/ask spread (needs ' + G.minStopSpreads + 'x)');
  if (G.maxIvRank > 0 && r.ivRank != null && r.ivRank > G.maxIvRank) why.push('IV Rank ' + swingR1_(r.ivRank) + ' over ' + G.maxIvRank + ': options are expensive');
  if (G.earnings.enabled && r.earnYmd && r.todayYmd) {
    const exitBy = swingYmdAdd_(r.todayYmd, Math.ceil(cfg.trade.maxHoldDays * 1.5));
    if (r.earnYmd >= r.todayYmd && r.earnYmd <= exitBy) why.push('earnings ' + r.earnYmd + ' inside the hold window');
  }
  if (guard) {
    if (guard.haveTicker) why.push('already holding ' + r.ticker + ' (paper or yours)');
    if (guard.open >= G.maxOpen) why.push(guard.open + ' paper positions already open (max ' + G.maxOpen + ')');
    if (guard.newToday >= G.maxNewPerDay) why.push(guard.newToday + ' new entries today (max ' + G.maxNewPerDay + ')');
  }
  return { ok: !why.length, why: why };
}

/* ---------------------------------------------------------------------------
 * EXIT RULES (pure) — the same for paper trades and for a position you hold
 * p = { side, stockStop, stockTarget, stockEntry, entryYmd, entry (option premium paid) }
 * L = { price, bid, dte, daysHeld, bars (completed sessions), feat, nowYmd }
 * Order: stop > target > premium stop > DTE > trend > time > no progress. A stop and a target on the same session count as the stop.
 * Returns { status: 'HOLD' | one of SWING_SETTLED, why, late }.
 * ------------------------------------------------------------------------- */
function swingExit_(p, L, cfg) {
  const T = cfg.trade, O = cfg.option, up = p.side !== 'SHORT', sgn = up ? 1 : -1;
  const barsSince = (L.bars || []).filter(function (b) { return p.entryYmd && b[0] > p.entryYmd; });
  const dist = p.stockStop > 0 && p.stockEntry > 0 ? Math.abs(p.stockEntry - p.stockStop) : 0;
  const atr = L.feat && L.feat.atr > 0 ? L.feat.atr : 0;
  const hitTarget = function (px) { return p.stockTarget > 0 && (up ? px >= p.stockTarget : px <= p.stockTarget); };
  // Walk the sessions since entry in order. The stop starts at the plan; after the stock has moved breakevenR your way it moves to the entry price
  // and then trails trailAtr ATR behind the best close. Within one session the stop is checked before the target (worst case first).
  let stop = p.stockStop, best = p.stockEntry, locked = false, hit = null;
  for (let k = 0; k < barsSince.length && !hit; k++) {
    const b = barsSince[k], lowX = up ? b[2] : b[1], highX = up ? b[1] : b[2];
    if (stop > 0 && (up ? lowX <= stop : lowX >= stop)) { hit = { status: 'STOPPED', why: 'stock traded through the ' + (locked ? 'trailing ' : '') + 'stop ' + swingR2_(stop) + ' on ' + b[0] + ' (closed at the next run)', late: true }; break; }
    if (hitTarget(highX)) { hit = { status: 'TARGET', why: 'stock reached the target ' + swingR2_(p.stockTarget) + ' on ' + b[0] + ' (closed at the next run)', late: true }; break; }
    if (sgn * (b[3] - best) > 0) best = b[3];
    if (dist > 0 && !locked && sgn * (highX - p.stockEntry) >= T.breakevenR * dist) { locked = true; stop = up ? Math.max(stop, p.stockEntry) : Math.min(stop, p.stockEntry); }
    if (locked && atr > 0) { const tr = best - sgn * T.trailAtr * atr; stop = up ? Math.max(stop, tr) : Math.min(stop, tr); }
  }
  if (hit) return hit;
  if (stop > 0 && (up ? L.price <= stop : L.price >= stop)) return { status: 'STOPPED', why: 'stock ' + swingR2_(L.price) + ' through the ' + (locked ? 'trailing ' : '') + 'stop ' + swingR2_(stop) };
  if (hitTarget(L.price)) return { status: 'TARGET', why: 'stock ' + swingR2_(L.price) + ' reached the target ' + swingR2_(p.stockTarget) };
  if (L.bid != null && p.entry > 0 && L.bid <= p.entry * (1 - T.premiumStopPct / 100)) return { status: 'PREMIUM STOP', why: 'option down ' + Math.round((1 - L.bid / p.entry) * 100) + '% from the entry' };
  if (L.dte != null && L.dte <= O.exitDte) return { status: 'DTE EXIT', why: L.dte + ' days left (rule: out at ' + O.exitDte + '): close or roll' };
  if (L.feat && L.feat.sma50 && (up ? L.feat.close < L.feat.sma50 : L.feat.close > L.feat.sma50)) return { status: 'TREND EXIT', why: 'closed ' + (up ? 'under' : 'over') + ' the 50-day average (' + swingR2_(L.feat.sma50) + ')' };
  if (L.daysHeld >= T.maxHoldDays) return { status: 'TIME EXIT', why: L.daysHeld + ' trading days held (max ' + T.maxHoldDays + ')' };
  const prog = dist > 0 ? sgn * (L.price - p.stockEntry) / dist : null;
  if (L.daysHeld >= T.noProgressDays && prog != null && prog < T.noProgressR) return { status: 'NO PROGRESS', why: swingR1_(prog) + 'R after ' + L.daysHeld + ' trading days: time decay is working against it' };
  return { status: 'HOLD', why: L.daysHeld + ' trading days' + (prog != null ? ', stock ' + (prog >= 0 ? '+' : '') + swingR1_(prog) + 'R' : '') + (L.bid != null && p.entry > 0 ? ', option ' + (L.bid >= p.entry ? '+' : '') + swingR1_((L.bid / p.entry - 1) * 100) + '%' : '') };
}

/* ---------------------------------------------------------------------------
 * LOG RECORDS (pure)
 * ------------------------------------------------------------------------- */
// One paper step: marks an OPEN record with the live numbers, closes it when a rule says so. Returns the record (mutated copy).
function swingStepRecord_(rec, L, cfg, feeUsd) {
  const r = {}; Object.keys(rec).forEach(function (k) { r[k] = rec[k]; });
  if (r.Status !== 'OPEN') return r;
  const entry = Number(r.Entry), fee = feeUsd || 0;
  const p = { side: r.Side, stockStop: Number(r['Stock Stop']), stockTarget: Number(r['Stock Target']), stockEntry: Number(r['Stock Entry']), entryYmd: String(r.Date || '').slice(0, 10), entry: entry };
  if (L.bid == null) { r['Exit Why'] = r['Exit Why'] || ''; return r; }                                  // no quote: nothing to mark
  r.Mark = L.bid;
  r['Open P/L $'] = swingR2_((L.bid - entry) * 100 - fee);
  const pct = (L.bid / entry - 1) * 100;
  r['Max Fav %'] = Math.max(Number(r['Max Fav %']) || 0, pct); r['Max Adv %'] = Math.min(Number(r['Max Adv %']) || 0, pct);
  r['Days Held'] = L.daysHeld;
  const ex = swingExit_(p, L, cfg);
  r['Exit Why'] = ex.why;
  if (ex.status !== 'HOLD') {
    r.Status = ex.status; r.Exit = L.bid; r['Exit Time'] = L.nowText; r['Stock Exit'] = L.price;
    r['P/L $'] = swingR2_((L.bid - entry) * 100 - fee); r['P/L %'] = swingR1_(pct);
    r['Stock Move %'] = swingR2_((r.Side === 'SHORT' ? -1 : 1) * (L.price / p.stockEntry - 1) * 100);
    r['Open P/L $'] = '';
  }
  return r;
}

function swingStats_(recs) {
  const done = recs.filter(function (r) { return SWING_SETTLED.indexOf(r.Status) >= 0; });
  const pl = function (r) { return Number(r['P/L $']) || 0; };
  const wins = done.filter(function (r) { return pl(r) > 0; }), loss = done.filter(function (r) { return pl(r) <= 0; });
  const sum = function (a) { return a.reduce(function (t, r) { return t + pl(r); }, 0); };
  const gw = sum(wins), gl = -sum(loss);
  const ordered = done.slice().sort(function (a, b) { return String(a['Exit Time']).localeCompare(String(b['Exit Time'])); });
  let eq = 0, peak = 0, dd = 0, streak = 0, worst = 0;
  ordered.forEach(function (r) { eq += pl(r); if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; if (pl(r) <= 0) { streak++; if (streak > worst) worst = streak; } else streak = 0; });
  return { n: done.length, wins: wins.length, win: done.length ? wins.length / done.length : null, avgWin: wins.length ? gw / wins.length : null, avgLoss: loss.length ? -gl / loss.length : null,
    per: done.length ? sum(done) / done.length : null, net: sum(done), pf: gl > 0 ? gw / gl : (gw > 0 ? Infinity : null), dd: dd, worst: worst };
}

// Rows for the SwingScore tab. recs = all SwingLog records, nowYmd = today (ET). Pure.
function swingScoreRows_(recs, nowYmd, cfg) {
  const rows = [];
  const fmtRow = function (label, s) {
    const m = function (v) { return v == null ? '' : (v < 0 ? '-$' : '$') + Math.abs(Math.round(v * 100) / 100); };
    return [label, s.n, s.win == null ? '' : Math.round(s.win * 100) + '%', m(s.avgWin), m(s.avgLoss), m(s.per), m(s.net), s.pf == null ? '' : (s.pf === Infinity ? 'inf' : Math.round(s.pf * 100) / 100)];
  };
  const head = ['', 'Settled', 'Win rate', 'Avg win $', 'Avg loss $', 'Per trade $', 'Net $', 'Profit factor'];
  const appr = recs.filter(function (r) { return r.Approved !== 'NO'; }), shadow = recs.filter(function (r) { return r.Approved === 'NO'; });
  const monthStart = nowYmd.slice(0, 7) + '-01', d30 = swingYmdAdd_(nowYmd, -30);
  const exitedOn = function (r) { return String(r['Exit Time'] || '').slice(0, 10); };
  const open = appr.filter(function (r) { return r.Status === 'OPEN'; });
  const openPl = open.reduce(function (t, r) { return t + (Number(r['Open P/L $']) || 0); }, 0);
  rows.push(['SwingScore: hypothetical results of the Swing signals, ONE contract per trade, exits at the bid, fees included. Nothing here was traded. Updated ' + nowYmd]);
  rows.push([]);
  rows.push(['1. The hypothetical book (Approved = passed every gate)']); rows.push(head);
  const sAll = swingStats_(appr);
  rows.push(fmtRow('All settled', sAll));
  rows.push(fmtRow('This month (' + nowYmd.slice(0, 7) + ')', swingStats_(appr.filter(function (r) { return exitedOn(r) >= monthStart; }))));
  rows.push(fmtRow('Last 30 days', swingStats_(appr.filter(function (r) { return exitedOn(r) >= d30; }))));
  rows.push(['Open now', open.length, '', '', '', '', '$' + Math.round(openPl * 100) / 100 + ' (marked at the bid)']);
  rows.push(['Worst losing streak', sAll.worst, '', '', '', '', 'Max drawdown $' + Math.round(sAll.dd)]);
  rows.push([]);
  rows.push(['2. Did the gates help? Approved vs shadow (signals the gates held back, tracked anyway)']); rows.push(head);
  rows.push(fmtRow('Approved', sAll)); rows.push(fmtRow('Shadow (not approved)', swingStats_(shadow)));
  rows.push([]);
  const grouped = function (title, keyFn) {
    rows.push([title]); rows.push(head);
    const keys = {}; appr.forEach(function (r) { const k = keyFn(r); if (k) keys[k] = 1; });
    Object.keys(keys).sort().forEach(function (k) { rows.push(fmtRow(k, swingStats_(appr.filter(function (r) { return keyFn(r) === k; })))); });
    rows.push([]);
  };
  grouped('3. By setup (approved)', function (r) { return r.Setup; });
  grouped('4. By direction (approved)', function (r) { return r.Side; });
  grouped('5. How trades ended (approved)', function (r) { return SWING_SETTLED.indexOf(r.Status) >= 0 ? r.Status : ''; });
  grouped('6. By score at entry (approved)', function (r) { const s = Number(r.Score); return s >= 80 ? '80+' : (s >= 70 ? '70-79' : (s >= 60 ? '60-69' : 'under 60')); });
  grouped('7. By month (approved)', function (r) { return SWING_SETTLED.indexOf(r.Status) >= 0 ? String(r['Exit Time']).slice(0, 7) : ''; });
  rows.push(['8. Can you trust it yet?']);
  rows.push([sAll.n < 30 ? 'Not enough trades: ' + sAll.n + ' settled of the 30 needed. Keep it on paper.' :
    (sAll.net > 0 && sAll.per > 0 && (sAll.pf || 0) > 1.3 ? 'Positive after ' + sAll.n + ' trades (profit factor ' + (sAll.pf === Infinity ? 'inf' : Math.round(sAll.pf * 100) / 100) + '). Still only a sample: check it holds for 2 months and in a down market.' :
      'Not yet: after ' + sAll.n + ' trades the net is $' + Math.round(sAll.net) + ' (profit factor ' + (sAll.pf == null ? 'n/a' : Math.round(sAll.pf * 100) / 100) + '). Do not trade it with real money.')]);
  return rows;
}

/* ---------------------------------------------------------------------------
 * DATA: daily bars (Yahoo, cached 6 hours per day in CacheService), quotes, earnings
 * ------------------------------------------------------------------------- */
const SWING_YAHOO_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' };
function swingBarsUrl_(host, t) { return 'https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=1y&interval=1d'; }
function swingParseBars_(resp) {
  try {
    if (resp.getResponseCode() !== 200) return null;
    const r = JSON.parse(resp.getContentText()).chart.result[0], ts = r.timestamp || [], q = r.indicators.quote[0], out = [];
    for (let i = 0; i < ts.length; i++) {
      if (!(q.close[i] > 0) || !(q.high[i] > 0) || !(q.low[i] > 0)) continue;
      out.push([Utilities.formatDate(new Date(ts[i] * 1000), 'America/New_York', 'yyyy-MM-dd'), Math.round(q.high[i] * 100) / 100, Math.round(q.low[i] * 100) / 100, Math.round(q.close[i] * 100) / 100, Math.round(q.volume[i] || 0)]);
    }
    return out.length ? out : null;
  } catch (e) { return null; }
}
// Returns { TICKER: bars } for every ticker it could get. Today's bar is kept as the last element when present (the caller trims it).
function swingGetBars_(tickers, et) {
  const cache = CacheService.getScriptCache(), out = {}, key = function (t) { return 'SWB_' + et.ymd + '_' + t; };
  const hit = cache.getAll(tickers.map(key));
  const need = [];
  tickers.forEach(function (t) {
    let b = null; try { b = hit[key(t)] ? JSON.parse(hit[key(t)]) : null; } catch (e) { b = null; }
    if (b && b.length) out[t] = b; else need.push(t);
  });
  const put = {};
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    let resps = [];
    try { resps = UrlFetchApp.fetchAll(chunk.map(function (t) { return { url: swingBarsUrl_('query1', t), method: 'get', muteHttpExceptions: true, headers: SWING_YAHOO_HEADERS }; })); } catch (e) { resps = []; }
    chunk.forEach(function (t, k) {
      let b = resps[k] ? swingParseBars_(resps[k]) : null;
      if (!b) { try { b = swingParseBars_(UrlFetchApp.fetch(swingBarsUrl_('query2', t), { method: 'get', muteHttpExceptions: true, headers: SWING_YAHOO_HEADERS })); } catch (e) { b = null; } }
      if (b) { out[t] = b; put[key(t)] = JSON.stringify(b); }
    });
  }
  try { if (Object.keys(put).length) cache.putAll(put, 21600); } catch (e) { /* cache is an optimisation */ }
  return out;
}
// Completed sessions only: today's bar is dropped until 16:05 ET.
function swingCompleted_(bars, et) {
  if (!bars || !bars.length) return bars;
  const last = bars[bars.length - 1];
  return (last[0] >= et.ymd && et.m < 16 * 60 + 5) ? bars.slice(0, -1) : bars;
}

function swingEarningsYmd_(ticker, finnhubKey) {
  const cache = CacheService.getScriptCache(), k = 'SWE_' + ticker;
  try { const c = cache.get(k); if (c != null) return c === 'none' ? '' : c; } catch (e) { /* fetch */ }
  let ymd = null;
  try {
    let c = finnhubKey && typeof fetchFinnhubNextEarnings_ === 'function' ? fetchFinnhubNextEarnings_(ticker, finnhubKey) : null;
    if (!c && typeof fetchYahooNextEarnings_ === 'function') c = fetchYahooNextEarnings_(ticker);
    if (c && c.date) ymd = Utilities.formatDate(c.date, 'America/New_York', 'yyyy-MM-dd');
  } catch (e) { ymd = null; }
  try { cache.put(k, ymd || 'none', 43200); } catch (e) { /* ok */ }
  return ymd || '';
}

// Live option plan for a signal. Returns { plan, expiryYmd, strike, sym, why }.
function swingOptionProposal_(ticker, side, price, stopPx, targetPx, token, et, cfg) {
  try {
    const chain = fetchTastyOptionChainNested_(ticker, token);
    if (!chain) return { why: 'no option chain' };
    const ymds = chain.map(function (e) { return Utilities.formatDate(e.date, 'America/New_York', 'yyyy-MM-dd'); });
    const expYmd = swingPickExpiry_(ymds, et.ymd, cfg);
    if (!expYmd) return { why: 'no expiry between ' + cfg.option.minDte + ' and ' + cfg.option.maxDte + ' days out' };
    const exp = chain[ymds.indexOf(expYmd)], isCall = side === 'LONG';
    const st = exp.strikes.filter(function (s) { return isCall ? s.callSymbol : s.putSymbol; }).sort(function (a, b) { return a.strike - b.strike; });
    if (!st.length) return { why: 'no strikes' };
    let ai = 0; st.forEach(function (s, i) { if (Math.abs(s.strike - price) < Math.abs(st[ai].strike - price)) ai = i; });
    const E = cfg.option.strikesEachSide;
    // delta 0.65 sits in the money: calls below the price, puts above it
    const lo = isCall ? Math.max(0, ai - E - 2) : Math.max(0, ai - 1), hi = isCall ? ai + 2 : ai + E + 2;
    const near = st.slice(lo, hi + 1);
    const syms = near.map(function (s) { return isCall ? s.callSymbol : s.putSymbol; });
    const q = fetchTastyMarketDataBatch_(syms, token);
    const cands = near.map(function (s, i) { const m = q[syms[i]] || {}; return { strike: s.strike, delta: m.delta, bid: m.bid, ask: m.ask, oi: m.oi, volume: m.volume, sym: syms[i] }; });
    const best = swingChooseContract_(cands, side, price, cfg);
    if (!best) return { why: 'no liquid contract for ' + expYmd + ' (spread over ' + cfg.option.maxSpreadPct + '%, open interest under ' + cfg.option.minOi + ', delta outside ' + cfg.option.minDelta + '-' + cfg.option.maxDelta + ', or quotes not live)' };
    return { plan: swingPlan_(best, price, stopPx, targetPx, cfg, swingRiskUsd_()), expiryYmd: expYmd, strike: best.strike, sym: best.sym, dte: swingDaysBetween_(et.ymd, expYmd) };
  } catch (e) { return { why: 'option lookup failed: ' + (e && e.message ? e.message : e) }; }
}

function swingRiskUsd_() {
  const v = parseFloat(PropertiesService.getScriptProperties().getProperty('SWING_RISK_USD'));
  return v > 0 ? v : SWING_CONFIG.risk.riskUsd;
}
function swingSetRisk_() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Swing: risk per trade', 'Dollars you are willing to lose if a trade hits its stock stop (used only for the Qty Sug column). Current: $' + swingRiskUsd_(), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const v = parseFloat(String(r.getResponseText()).replace(/[$,\s]/g, ''));
  if (!(v > 0)) { notify_(ui, 'Swing', 'Not a number.'); return; }
  PropertiesService.getScriptProperties().setProperty('SWING_RISK_USD', String(v));
  notify_(ui, 'Swing', 'Risk per trade set to $' + v + '.');
}

/* ---------------------------------------------------------------------------
 * SHEETS
 * ------------------------------------------------------------------------- */
function swingHeaderMap_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1), row = sheet.getRange(1, 1, 1, lastCol).getValues()[0], map = {};
  row.forEach(function (h, i) { const k = String(h == null ? '' : h).trim(); if (k && map[k] == null) map[k] = i + 1; });
  return map;
}
function swingEnsureHeaders_(sheet, headers) {
  const lastCol = Math.max(sheet.getLastColumn(), 1), existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  if (!existing.some(function (h) { return h !== ''; })) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  else {
    let next = existing.length; while (next > 0 && existing[next - 1] === '') next--;
    headers.forEach(function (h) { if (existing.indexOf(h) === -1) { next++; sheet.getRange(1, next).setValue(h); existing[next - 1] = h; } });
  }
  sheet.setFrozenRows(1);
  return swingHeaderMap_(sheet);
}
function swingFormatSheet_(sheet) {
  const map = swingHeaderMap_(sheet), n = Math.max(sheet.getMaxRows() - 1, 1);
  const fmt = function (h, f) { if (map[h]) sheet.getRange(2, map[h], n, 1).setNumberFormat(f); };
  ['Price', 'Entry', 'Mid', 'Limit', 'Stock Stop', 'Stock Target', 'Strike'].forEach(function (h) { fmt(h, '$#,##0.00'); });
  fmt('Change', '$#,##0.00;-$#,##0.00;$0.00'); fmt('P/L $', '$#,##0;-$#,##0;$0'); fmt('Risk $/lot', '$#,##0'); fmt('Expiry', 'yyyy-mm-dd'); fmt('LastRun', 'yyyy-mm-dd hh:mm');
  ['Score', 'RSI', 'ATR %', 'RS vs SPY %', 'RVOL', 'Off High %', 'IV Rank', 'Spread %', 'P/L %', 'R:R', 'Delta'].forEach(function (h) { fmt(h, '0.0'); });
  SWING_INPUT_HEADERS.forEach(function (h) { if (map[h]) sheet.getRange(1, map[h]).setBackground('#fff2cc'); });
  SWING_OUTPUT_HEADERS.forEach(function (h) { if (map[h]) sheet.getRange(1, map[h]).setBackground(SWING_USER_COLS.indexOf(h) >= 0 ? '#fce5cd' : '#d9ead3'); });
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
  if (map['Change']) {
    const rules = sheet.getConditionalFormatRules().filter(function (r) { return !r.getRanges().some(function (x) { return x.getColumn() <= map['Change'] && x.getLastColumn() >= map['Change']; }); });
    const rng = sheet.getRange(2, map['Change'], n, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor('#cc0000').setRanges([rng]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#38761d').setRanges([rng]).build());
    sheet.setConditionalFormatRules(rules);
  }
}
const SWING_ACTION_COLORS = { BUY: '#b7e1cd', SHORT: '#f4cccc', WATCH: '#fff2cc', WAIT: '#eeeeee', SKIP: '#eeeeee', LATE: '#eeeeee', HOLD: '#cfe2f3', STOPPED: '#e06666', TARGET: '#93c47d',
  'PREMIUM STOP': '#e06666', 'DTE EXIT': '#f6b26b', 'TREND EXIT': '#f6b26b', 'TIME EXIT': '#f6b26b', 'NO PROGRESS': '#f6b26b', 'FILL IN': '#f4cccc' };
function swingColorRows_(sheet, map, n) {
  if (!map['Action'] || n < 1) return;
  const rng = sheet.getRange(2, map['Action'], n, 1);
  rng.setBackgrounds(rng.getValues().map(function (v) { return [SWING_ACTION_COLORS[v[0]] || null]; }));
}

function setupSwing() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SWING_SHEET);
  const fresh = !sheet;
  if (!sheet) sheet = ss.insertSheet(SWING_SHEET);
  const map = swingEnsureHeaders_(sheet, SWING_HEADERS);
  if (fresh || sheet.getLastRow() < 2) {
    sheet.getRange(2, map['Ticker'], SWING_STARTER.length, 1).setValues(SWING_STARTER.map(function (t) { return [t]; }));
  }
  swingFormatSheet_(sheet);
  swingLogSheet_(true);
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'swingAddMenu_'; })) ScriptApp.newTrigger('swingAddMenu_').forSpreadsheet(ss).onOpen().create();
  try { swingAddMenu_(); } catch (e) { /* appears on next open */ }
  notify_(tryGetUi_(), 'Swing set up',
    'Created the Swing and SwingLog tabs. Menu "📈 Swing" appears after you reload the sheet.\n\nNext:\n  1. 📈 Swing > Run Scan Now\n  2. 📈 Swing > Start Schedule (09:50, 12:30 and 15:30 ET on trading days, plus a 16:10 summary)\n' +
    '  3. Optional: 📈 Swing > Set Risk per Trade\n\nA position you really hold: type Ticker, Entry Date, Entry (premium paid), Qty, Side (LONG = call, SHORT = put), Expiry, Strike and, if you want a stock stop, Stock Stop / Stock Target. ' +
    'The tab then follows it with the same exit rules as the paper trades. Rows with those cells filled are never overwritten.');
}

function swingAddMenu_() {
  SpreadsheetApp.getUi().createMenu('📈 Swing')
    .addItem('Run Scan Now', 'swingScanNow_')
    .addItem('📒 Update Log Now', 'swingLogNow_')
    .addItem('📊 Update Scorecard (SwingScore tab)', 'swingScoreNow_')
    .addItem('Add Tickers…', 'swingAddTickers_')
    .addItem('Set Risk per Trade…', 'swingSetRisk_')
    .addSeparator()
    .addItem('▶ Start Schedule', 'startSwingSchedule_')
    .addItem('■ Stop Schedule', 'stopSwingSchedule_')
    .addItem('Schedule Status', 'swingScheduleStatus_')
    .addSeparator()
    .addItem('🔍 Debug One Ticker', 'swingDebugOne_')
    .addToUi();
}

function swingAddTickers_() {
  const ui = SpreadsheetApp.getUi(), sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SWING_SHEET);
  if (!sheet) { notify_(ui, 'Swing', 'Run setupSwing first.'); return; }
  const r = ui.prompt('Add tickers to Swing', 'Comma-separated.', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const list = r.getResponseText().toUpperCase().split(/[\s,;]+/).filter(function (x) { return /^[A-Z.\-]{1,6}$/.test(x); });
  const map = swingHeaderMap_(sheet), col = map['Ticker'];
  const have = {}; const last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, col, last - 1, 1).getValues().forEach(function (v) { have[String(v[0]).trim().toUpperCase()] = true; });
  const add = list.filter(function (t, i, a) { return !have[t] && a.indexOf(t) === i; });
  if (add.length) sheet.getRange(Math.max(last, 1) + 1, col, add.length, 1).setValues(add.map(function (t) { return [t]; }));
  notify_(ui, 'Swing', add.length ? 'Added: ' + add.join(', ') : 'Nothing new to add.');
}

/* ---------------------------------------------------------------------------
 * SWING LOG (paper positions)
 * ------------------------------------------------------------------------- */
function swingLogSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(SWING_LOG_SHEET);
  if (sh) { swingEnsureHeaders_(sh, SWING_LOG_HEADERS); return sh; }
  if (!create) return null;
  sh = ss.insertSheet(SWING_LOG_SHEET);
  sh.getRange(1, 1, 1, SWING_LOG_HEADERS.length).setValues([SWING_LOG_HEADERS]).setFontWeight('bold').setHorizontalAlignment('center');
  sh.setFrozenRows(1); sh.setFrozenColumns(2);
  const map = swingHeaderMap_(sh);
  ['Date', 'Entry Time', 'Exit Time', 'Expiry'].forEach(function (h) { sh.getRange(2, map[h], Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@'); });   // plain text: dates stay exactly as written
  ['Entry', 'Mark', 'Exit', 'Stock Entry', 'Stock Stop', 'Stock Target', 'Stock Exit'].forEach(function (h) { sh.getRange(2, map[h], Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('$#,##0.00'); });
  ['P/L $', 'Open P/L $'].forEach(function (h) { sh.getRange(2, map[h], Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('$#,##0;-$#,##0;$0'); });
  return sh;
}
function swingLogRead_(sh) {
  if (!sh || sh.getLastRow() < 2) return [];
  const map = swingHeaderMap_(sh), vals = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  return vals.map(function (v, i) { const o = { _row: i + 2 }; Object.keys(map).forEach(function (h) { o[h] = v[map[h] - 1]; }); return o; }).filter(function (o) { return o.Ticker !== ''; });
}
function swingLogWriteRows_(sh, recs) {
  if (!recs.length) return;
  const map = swingHeaderMap_(sh);
  recs.forEach(function (r) {
    const cols = Object.keys(map).filter(function (h) { return r[h] !== undefined; });
    cols.sort(function (a, b) { return map[a] - map[b]; });
    // contiguous groups of columns in one call each
    let k = 0;
    while (k < cols.length) {
      let j = k; while (j + 1 < cols.length && map[cols[j + 1]] === map[cols[j]] + 1) j++;
      sh.getRange(r._row, map[cols[k]], 1, j - k + 1).setValues([cols.slice(k, j + 1).map(function (h) { return r[h] === null ? '' : r[h]; })]);
      k = j + 1;
    }
  });
}
function swingLogAppend_(sh, recs) {
  if (!recs.length) return;
  const map = swingHeaderMap_(sh), width = sh.getLastColumn(), start = Math.max(sh.getLastRow(), 1) + 1;
  const rows = recs.map(function (r) { const a = new Array(width).fill(''); Object.keys(map).forEach(function (h) { if (r[h] !== undefined && r[h] !== null) a[map[h] - 1] = r[h]; }); return a; });
  sh.getRange(start, 1, rows.length, width).setValues(rows);
}

const SWING_FEE_USD = 1.3;   // round trip per contract (about 0.65 each way); change if your broker differs

// Follows every OPEN paper trade: marks it, applies the exit rules, writes the changes, sends one alert per exit. Cheap when nothing is open.
function swingLogTick_(quiet) {
  const sh = swingLogSheet_(false);
  if (!sh) return { updated: 0 };
  const recs = swingLogRead_(sh), open = recs.filter(function (r) { return r.Status === 'OPEN'; });
  if (!open.length) return { updated: 0 };
  const et = swingEt_(new Date()), now = new Date();
  const token = typeof getTastyTradeAccessToken_ === 'function' ? getTastyTradeAccessToken_() : null;
  const syms = open.map(function (r) { return String(r.Symbol).trim(); }).filter(function (s, i, a) { return s && a.indexOf(s) === i; });
  const q = token ? fetchTastyMarketDataBatch_(syms, token) : {};
  const tickers = open.map(function (r) { return String(r.Ticker).toUpperCase(); }).filter(function (s, i, a) { return a.indexOf(s) === i; });
  const eq = (typeof longPrefetchQuotes_ === 'function' && token) ? (function () { try { return longPrefetchQuotes_(tickers, token) || {}; } catch (e) { return {}; } })() : {};
  const bars = swingGetBars_(tickers, et);
  const changed = [], alerts = [];
  open.forEach(function (rec) {
    const t = String(rec.Ticker).toUpperCase(), raw = bars[t], done = swingCompleted_(raw, et), f = swingFeatures_(done);
    const price = eq[t] && eq[t].price > 0 ? eq[t].price : (raw && raw.length ? raw[raw.length - 1][3] : null);
    const m = q[String(rec.Symbol).trim()] || {};
    const entryYmd = swingYmdOfCell_(rec.Date);
    const L = { price: price, bid: m.bid > 0 ? m.bid : null, dte: swingDaysBetween_(et.ymd, swingYmdOfCell_(rec.Expiry)), daysHeld: swingTradingDaysBetween_(entryYmd, et.ymd),
      bars: done, feat: f, nowYmd: et.ymd, nowText: et.ymd + ' ' + swingPad2_(Math.floor(et.m / 60)) + ':' + swingPad2_(et.m % 60) };
    if (price == null) return;
    const next = swingStepRecord_(rec, L, SWING_CONFIG, SWING_FEE_USD);
    const differs = next.Status !== rec.Status || next.Mark !== rec.Mark || next['Exit Why'] !== rec['Exit Why'];
    if (differs) changed.push(next);
    if (rec.Status === 'OPEN' && next.Status !== 'OPEN' && rec.Approved !== 'NO') alerts.push(next);
  });
  if (changed.length) swingLogWriteRows_(sh, changed);
  alerts.forEach(function (r) {
    const sign = Number(r['P/L $']) >= 0 ? '+' : '-';
    swingAlertOnce_('exit|' + r.Ticker + '|' + r.Date, 'Swing ' + r.Status + ': ' + r.Ticker + ' ' + r.Contract, r['Exit Why'] + ' | paper P/L ' + sign + '$' + Math.abs(Number(r['P/L $']) || 0).toFixed(0) + ' (' + r['P/L %'] + '%)', r.Status === 'STOPPED' || r.Status === 'TARGET');
  });
  return { updated: changed.length, closed: alerts.length };
}
function swingLogNow_() { const r = swingLogTick_(false); swingScoreNow_(true); notify_(tryGetUi_(), 'Swing log', 'Updated ' + (r.updated || 0) + ' row(s), closed ' + (r.closed || 0) + '.'); }

function swingScoreNow_(quiet) {
  const ss = SpreadsheetApp.getActiveSpreadsheet(), log = swingLogSheet_(false);
  if (!log) { if (!quiet) notify_(tryGetUi_(), 'Swing', 'No SwingLog tab yet. Run setupSwing.'); return; }
  const rows = swingScoreRows_(swingLogRead_(log), swingEt_(new Date()).ymd, SWING_CONFIG);
  const sh = ss.getSheetByName(SWING_SCORE_SHEET) || ss.insertSheet(SWING_SCORE_SHEET);
  sh.clear();
  const w = rows.reduce(function (m, r) { return Math.max(m, r.length); }, 1);
  sh.getRange(1, 1, rows.length, w).setValues(rows.map(function (r) { const a = r.slice(); while (a.length < w) a.push(''); return a; }));
  sh.getRange(1, 1).setFontWeight('bold');
  rows.forEach(function (r, i) { if (/^\d+\. /.test(String(r[0] || '')) && r.length === 1) sh.getRange(i + 1, 1).setFontWeight('bold'); if (r[0] === '' && r[1] === 'Settled') sh.getRange(i + 1, 1, 1, w).setFontWeight('bold').setBackground('#eeeeee'); });
  sh.setColumnWidth(1, 330);
  if (!quiet) notify_(tryGetUi_(), 'Swing', 'Scorecard updated on the ' + SWING_SCORE_SHEET + ' tab.');
}

/* ---------------------------------------------------------------------------
 * ALERTS
 * ------------------------------------------------------------------------- */
function swingAlertOnce_(key, title, body, high) {
  try {
    const cfg = getAlertConfig_(); if (!cfg.ready) return false;
    const props = PropertiesService.getScriptProperties(), ymd = swingEt_(new Date()).ymd;
    let st = {}; try { st = JSON.parse(props.getProperty('SWING_ALERT_STATE') || '{}'); } catch (e) { st = {}; }
    if (st.ymd !== ymd) st = { ymd: ymd, keys: {} };
    if (st.keys[key]) return false;
    const r = sendPhoneAlert_(cfg, title, body + '\nNot advice. Paper trade.', !!high);
    if (r && r.ok) { st.keys[key] = 1; props.setProperty('SWING_ALERT_STATE', JSON.stringify(st)); return true; }
    logToSheet_('Swing alert failed: ' + (r && r.detail));
  } catch (e) { logToSheet_('Swing alert error: ' + (e && e.message ? e.message : e)); }
  return false;
}

function swingSummaryNow_() {
  const log = swingLogSheet_(false); if (!log) return;
  const recs = swingLogRead_(log), et = swingEt_(new Date()), appr = recs.filter(function (r) { return r.Approved !== 'NO'; });
  const open = appr.filter(function (r) { return r.Status === 'OPEN'; }), openPl = open.reduce(function (t, r) { return t + (Number(r['Open P/L $']) || 0); }, 0);
  const closedToday = appr.filter(function (r) { return SWING_SETTLED.indexOf(r.Status) >= 0 && String(r['Exit Time']).slice(0, 10) === et.ymd; });
  const mtd = swingStats_(appr.filter(function (r) { return SWING_SETTLED.indexOf(r.Status) >= 0 && String(r['Exit Time']).slice(0, 10) >= et.ymd.slice(0, 7) + '-01'; }));
  const m = function (v) { return (v < 0 ? '-$' : '+$') + Math.abs(Math.round(v)); };
  const lines = ['Open: ' + open.length + ' (marked ' + m(openPl) + ')'].concat(open.map(function (r) { return '  ' + r.Ticker + ' ' + r.Contract + ' ' + m(Number(r['Open P/L $']) || 0) + ' | ' + r['Exit Why']; }));
  lines.push('Closed today: ' + closedToday.length + (closedToday.length ? ' (' + m(closedToday.reduce(function (t, r) { return t + (Number(r['P/L $']) || 0); }, 0)) + ')' : ''));
  lines.push('Month to date: ' + mtd.n + ' settled, net ' + m(mtd.net) + (mtd.win != null ? ', win rate ' + Math.round(mtd.win * 100) + '%' : ''));
  swingAlertOnce_('summary', 'Swing summary ' + et.ymd, lines.join('\n'), false);
}

/* ---------------------------------------------------------------------------
 * SCAN
 * ------------------------------------------------------------------------- */
function swingScanNow_() { return swingScan_({}); }

function swingParseRows_(data, map) {
  const rows = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const g = function (h) { return map[h] ? r[map[h] - 1] : ''; };
    const qty = swingNum_(g('Qty')), entry = swingNum_(g('Entry')), entryYmd = swingYmdOfCell_(g('Entry Date'));
    const userRow = (qty != null && qty !== 0) || (entry != null && entry > 0) || entryYmd !== '';
    const sideTxt = String(g('Side') || '').trim().toUpperCase();
    rows.push({ idx: i, ticker: t, qty: qty, entry: entry, entryYmd: entryYmd, userRow: userRow, held: qty != null && qty > 0,
      side: /^(S|SHORT|P|PUT)/.test(sideTxt) ? 'SHORT' : 'LONG', strike: swingNum_(g('Strike')), expiryYmd: swingYmdOfCell_(g('Expiry')),
      stockStop: swingNum_(g('Stock Stop')), stockTarget: swingNum_(g('Stock Target')) });
  });
  return rows;
}

function swingScan_(opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_(), startMs = Date.now(), C = SWING_CONFIG;
  const ss = SpreadsheetApp.getActiveSpreadsheet(), sheet = ss.getSheetByName(SWING_SHEET);
  if (!sheet) { notify_(ui, 'Swing', 'No "' + SWING_SHEET + '" tab. Run setupSwing once from the Apps Script editor.'); return null; }
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('SWING_RUNNING') || '0', 10);
  if (running && Date.now() - running < 8 * 60000) { notify_(ui, 'Swing', 'A Swing run is still going. Try again in a minute.'); return null; }
  const map = swingEnsureHeaders_(sheet, SWING_HEADERS);
  const last = sheet.getLastRow();
  if (last < 2) { notify_(ui, 'Swing', 'No tickers on the tab.'); return null; }
  const width = sheet.getLastColumn(), data = sheet.getRange(2, 1, last - 1, width).getValues();
  const rows = swingParseRows_(data, map);
  if (!rows.length) { notify_(ui, 'Swing', 'No tickers found in column A.'); return null; }
  props.setProperty('SWING_RUNNING', String(Date.now()));
  const now = new Date(), et = swingEt_(now);
  const counts = {}, errors = [];
  try {
    const tickers = rows.map(function (r) { return r.ticker; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
    const withSpy = tickers.indexOf('SPY') === -1 ? tickers.concat(['SPY']) : tickers;
    const barsAll = swingGetBars_(withSpy, et);
    const token = typeof getTastyTradeAccessToken_ === 'function' ? getTastyTradeAccessToken_() : null;
    const eq = (typeof longPrefetchQuotes_ === 'function' && token) ? (function () { try { return longPrefetchQuotes_(tickers, token) || {}; } catch (e) { return {}; } })() : {};
    const feat = {}, done = {};
    withSpy.forEach(function (t) { done[t] = swingCompleted_(barsAll[t], et); feat[t] = swingFeatures_(done[t]); });
    const spy = feat['SPY'] || null;
    const finnhubKey = typeof getFinnhubApiKey_ === 'function' ? getFinnhubApiKey_() : null;

    // paper log state for the guards
    const logSh = swingLogSheet_(true), logRecs = swingLogRead_(logSh);
    const openByTicker = {}; logRecs.forEach(function (r) { if (r.Status === 'OPEN') openByTicker[String(r.Ticker).toUpperCase()] = true; });
    const apprOpen = logRecs.filter(function (r) { return r.Status === 'OPEN' && r.Approved !== 'NO'; }).length;
    const apprToday = logRecs.filter(function (r) { return r.Approved !== 'NO' && swingYmdOfCell_(r.Date) === et.ymd; }).length;
    const shadowToday = logRecs.filter(function (r) { return r.Approved === 'NO' && swingYmdOfCell_(r.Date) === et.ymd; }).length;
    const seen = {}; logRecs.forEach(function (r) { seen[String(r.Ticker).toUpperCase() + '|' + r.Side + '|' + (r.Why ? String(r.Why).split('|')[0] : '')] = 1; });

    // held contracts: one batched quote
    const heldRows = rows.filter(function (r) { return r.held && r.strike > 0 && r.expiryYmd && r.entry > 0; });
    const occOf = function (r) { const p = r.expiryYmd.split('-'); return buildOccSymbol_(r.ticker, new Date(+p[0], +p[1] - 1, +p[2], 12), r.strike, r.side === 'SHORT' ? 'P' : 'C'); };
    const hq = (token && heldRows.length) ? fetchTastyMarketDataBatch_(heldRows.map(occOf), token) : {};

    const results = {};          // idx -> { out fields }
    const actionable = [];
    rows.forEach(function (rw) {
      const t = rw.ticker, f = feat[t], raw = barsAll[t], out = { LastRun: now };
      results[rw.idx] = out;
      try {
        // price + change
        const e = eq[t];
        const rawLast = raw && raw.length ? raw[raw.length - 1] : null;
        const price = e && e.price > 0 ? e.price : (rawLast ? rawLast[3] : null);
        if (price != null) out.Price = swingR2_(price);
        if (e && typeof e.change === 'number' && isFinite(e.change)) out.Change = swingR2_(e.change);
        else if (price != null && done[t] && done[t].length) out.Change = swingR2_(price - (rawLast && done[t].length < raw.length ? done[t][done[t].length - 1][3] : (done[t].length > 1 ? done[t][done[t].length - 2][3] : price)));
        if (f) { out.Trend = swingTrendLabel_(f); out.RSI = swingR1_(f.rsi); out['ATR %'] = swingR2_(f.atrPct); out.RVOL = swingR2_(f.rvol); out['Off High %'] = swingR1_(f.offHigh); }
        const sg = swingSignal_(f, spy, C);
        if (sg.rs != null) out['RS vs SPY %'] = swingR1_(sg.rs);
        if (rw.held) { swingHeldRow_(rw, out, { f: f, done: done[t], price: price, hq: hq, occOf: occOf, et: et, finnhubKey: finnhubKey }); }
        else if (rw.userRow) { out.Action = 'FILL IN'; out.Why = 'You started a position here: also enter Qty, Side, Expiry, Strike and Entry (premium paid) so the sheet can follow it. This row is never overwritten.'; }
        else {
          out.Action = sg.action; out.Side = sg.side || ''; out.Setup = sg.setup || ''; if (sg.score) out.Score = sg.score;
          out.Why = sg.why.join(' | ');
          if (sg.stop) { out['Stock Stop'] = swingR2_(sg.stop); out['Stock Target'] = swingR2_(sg.target); }
          if (sg.action === 'BUY' || sg.action === 'SHORT') {
            // already ran too far past the close = chasing
            if (price != null && sg.dist > 0 && Math.abs(price - f.close) / sg.dist > C.signal.lateR && ((sg.side === 'LONG' && price > f.close) || (sg.side === 'SHORT' && price < f.close))) {
              out.Action = 'LATE'; out.Why = 'already ' + swingR1_(Math.abs(price - f.close) / sg.dist) + 'R past the signal close: chasing | ' + out.Why;
            } else if (price != null && ((sg.side === 'LONG' && price <= sg.stop) || (sg.side === 'SHORT' && price >= sg.stop))) {
              out.Action = 'WAIT'; out.Why = 'price is already through the stop ' + swingR2_(sg.stop) + ' | ' + out.Why;
            } else actionable.push({ rw: rw, sg: sg, out: out, price: price, f: f });
          }
        }
        counts[out.Action] = (counts[out.Action] || 0) + 1;
      } catch (err) { out.Action = 'WAIT'; out.Why = 'error: ' + (err && err.message ? err.message : err); errors.push(t + ': ' + (err && err.message ? err.message : err)); }
    });

    // option plans for the best signals only
    actionable.sort(function (a, b) { return b.sg.score - a.sg.score; });
    let ivr = {};
    if (token && typeof cspFetchIvRanks_ === 'function' && actionable.length) { try { ivr = cspFetchIvRanks_(actionable.slice(0, C.lookupsPerScan).map(function (a) { return a.rw.ticker; }), token) || {}; } catch (e) { ivr = {}; } }
    const newPaper = [], phone = [];
    let guardOpen = apprOpen, guardToday = apprToday, shadowN = shadowToday;
    actionable.forEach(function (a, i) {
      const out = a.out, sg = a.sg, t = a.rw.ticker;
      if (i >= C.lookupsPerScan || Date.now() - startMs > C.timeBudgetMs * 0.7) { out.Gate = 'not looked up this run (' + C.lookupsPerScan + ' best signals per run)'; return; }
      const prop = token ? swingOptionProposal_(t, sg.side, a.price, sg.stop, sg.target, token, et, C) : { why: 'no TastyTrade token' };
      const earnYmd = (token && !LONG_ETF_LIKE_[t]) ? swingEarningsYmd_(t, a.finnhubKey || (typeof getFinnhubApiKey_ === 'function' ? getFinnhubApiKey_() : null)) : '';
      const gate = swingGate_({ ticker: t, plan: prop.plan, noPlanWhy: prop.why, earnYmd: earnYmd, todayYmd: et.ymd, ivRank: ivr[t] }, { open: guardOpen, newToday: guardToday, haveTicker: !!openByTicker[t] }, C);
      if (ivr[t] != null) out['IV Rank'] = swingR1_(ivr[t]);
      if (earnYmd) out['Earn Days'] = swingDaysBetween_(et.ymd, earnYmd);
      out.Gate = gate.ok ? 'PASS' : 'BLOCKED: ' + gate.why.join('; ');
      if (prop.plan) {
        const p = prop.plan;
        out.Expiry = new Date(+prop.expiryYmd.slice(0, 4), +prop.expiryYmd.slice(5, 7) - 1, +prop.expiryYmd.slice(8, 10), 12); out.Strike = prop.strike; out.DTE = prop.dte;
        out.Delta = swingR2_(p.delta); out.Mid = p.mid; out.Limit = p.limit; out['Spread %'] = swingR1_(p.spreadPct); out.OI = p.oi == null ? '' : p.oi; out.VOL = p.volume == null ? '' : p.volume;
        out['R:R'] = swingR1_(p.rr); out['Risk $/lot'] = p.riskLot; out['Qty Sug'] = p.qtySug;
      }
      const dedupe = t + '|' + sg.side + '|' + sg.setup;
      const rec = prop.plan ? swingNewRecord_(t, sg, a.price, prop, et, gate) : null;
      if (rec) {
        const key = t + '|' + sg.side + '|' + (rec.Why ? String(rec.Why).split('|')[0] : '');
        // one paper entry per signal day: an approved row once per ticker per day; a shadow row once per ticker per day within the daily cap
        const dayKey = t + '|' + sg.side + '|' + et.ymd;
        const already = logRecs.some(function (r) { return String(r.Ticker).toUpperCase() === t && r.Side === sg.side && swingYmdOfCell_(r.Date) === et.ymd; });
        if (!already && !openByTicker[t]) {
          if (gate.ok) { newPaper.push(rec); guardOpen++; guardToday++; openByTicker[t] = true; phone.push({ rec: rec, sg: sg, prop: prop, t: t }); }
          else if (shadowN < C.shadowPerDay) { newPaper.push(rec); shadowN++; if (C.alertBlocked) phone.push({ rec: rec, sg: sg, prop: prop, t: t, blocked: gate.why.join('; ') }); }
        }
        void key; void dayKey; void dedupe;
      }
    });
    if (newPaper.length) swingLogAppend_(logSh, newPaper);

    // write the Swing tab (re-read first; abort if rows moved)
    if (!opts.dry) swingWriteOutputs_(sheet, map, width, data, rows, results);

    phone.forEach(function (p) {
      const r = p.rec, plan = p.prop.plan;
      swingAlertOnce_('sig|' + p.t + '|' + r.Side + '|' + et.ymd, (p.blocked ? 'Swing (not approved) ' : 'Swing ') + (r.Side === 'LONG' ? 'BUY ' : 'SHORT ') + p.t,
        (p.blocked ? 'NOT approved: ' + p.blocked + '\n' : 'Paper trade logged.\n') + r.Setup + ' | score ' + r.Score + '\n' + r.Contract + ' ' + r.Expiry + ' (' + r.DTE + 'd) delta ' + swingR2_(plan.delta) + ' limit ' + plan.limit +
        '\nstock ' + swingR2_(r['Stock Entry']) + ' stop ' + swingR2_(r['Stock Stop']) + ' target ' + swingR2_(r['Stock Target']) + ' | risk about $' + plan.riskLot + '/contract, qty ' + plan.qtySug + ' for $' + swingRiskUsd_() +
        '\nExit rules: stop, target, 50-day break, ' + C.trade.maxHoldDays + ' trading days, or ' + C.option.exitDte + ' DTE.', !p.blocked);
    });
    try { swingLogTick_(true); swingScoreNow_(true); } catch (e) { logToSheet_('Swing log update failed: ' + (e && e.message ? e.message : e)); }

    const order = ['BUY', 'SHORT', 'WATCH', 'HOLD', 'STOPPED', 'TARGET', 'TREND EXIT', 'TIME EXIT', 'DTE EXIT', 'NO PROGRESS', 'PREMIUM STOP', 'FILL IN', 'LATE', 'WAIT', 'SKIP'];
    const sec = Math.round((Date.now() - startMs) / 1000);
    const msg = (opts.dry ? '(DRY RUN: nothing written)\n' : '') + 'Swing scan of ' + rows.length + ' names in ' + sec + 's\n' +
      order.filter(function (k) { return counts[k]; }).map(function (k) { return k + ': ' + counts[k]; }).join('   ') + '\n' +
      'Paper entries logged: ' + newPaper.filter(function (r) { return r.Approved !== 'NO'; }).length + ' approved, ' + newPaper.filter(function (r) { return r.Approved === 'NO'; }).length + ' shadow' +
      (!token ? '\n⚠️ No TastyTrade token: option plans cannot be built.' : '') + (errors.length ? '\nErrors:\n' + errors.map(function (e) { return '  • ' + e; }).join('\n') : '');
    logToSheet_('Swing scan ' + msg.replace(/\n/g, ' | '));
    notify_(ui, 'Swing scan complete', msg);
    return { counts: counts, logged: newPaper.length };
  } finally {
    props.deleteProperty('SWING_RUNNING');
  }
}
// ETFs have no earnings: skip the lookup
const LONG_ETF_LIKE_ = { SPY: 1, QQQ: 1, IWM: 1, DIA: 1, XLK: 1, XLF: 1, XLE: 1, XLV: 1, SMH: 1, VOO: 1 };

function swingNewRecord_(t, sg, price, prop, et, gate) {
  const p = prop.plan, hm = swingPad2_(Math.floor(et.m / 60)) + ':' + swingPad2_(et.m % 60);
  return { Date: et.ymd, Ticker: t, Side: sg.side, Setup: sg.setup, Score: sg.score, Approved: gate.ok ? 'YES' : 'NO', Status: 'OPEN',
    Contract: (sg.side === 'LONG' ? 'C ' : 'P ') + prop.strike, Expiry: prop.expiryYmd, DTE: prop.dte, Delta: swingR2_(p.delta), 'Entry Time': et.ymd + ' ' + hm,
    'Stock Entry': swingR2_(price), 'Stock Stop': swingR2_(sg.stop), 'Stock Target': swingR2_(sg.target), Entry: p.limit, 'Spread %': swingR1_(p.spreadPct),
    Symbol: prop.sym, 'Blocked By': gate.ok ? '' : gate.why.join('; '), Why: sg.why.join(' | ') };
}

// A position you hold: the same exit rules as the paper trades, on the live option bid.
function swingHeldRow_(rw, out, X) {
  const q = X.hq[X.occOf(rw)] || {}, bid = q.bid > 0 ? q.bid : null;
  const p = { side: rw.side, stockStop: rw.stockStop || 0, stockTarget: rw.stockTarget || 0, stockEntry: 0, entryYmd: rw.entryYmd, entry: rw.entry };
  const complete = rw.strike > 0 && rw.expiryYmd && rw.entry > 0;
  if (!complete) { out.Action = 'FILL IN'; out.Why = 'Qty is filled: also enter Strike, Expiry and Entry (the premium you paid). Stock Stop / Stock Target are optional.'; return; }
  const L = { price: X.price, bid: bid, dte: swingDaysBetween_(X.et.ymd, rw.expiryYmd), daysHeld: rw.entryYmd ? swingTradingDaysBetween_(rw.entryYmd, X.et.ymd) : 0, bars: X.done, feat: X.f, nowYmd: X.et.ymd };
  const ex = swingExit_(p, L, SWING_CONFIG);
  out.Action = ex.status === 'DTE EXIT' ? 'ROLL' : ex.status; out.Why = 'HELD: ' + ex.why + (bid == null ? ' | no option quote yet (P/L waits)' : '');
  out.DTE = L.dte; out.Days = L.daysHeld;
  if (bid != null) { out.Mid = swingR2_((q.bid + (q.ask || q.bid)) / 2); out['P/L %'] = swingR1_((bid / rw.entry - 1) * 100); out['P/L $'] = Math.round((bid - rw.entry) * 100 * rw.qty); }
  if (q.delta != null) out.Delta = swingR2_(q.delta);
  if (q.oi != null) out.OI = q.oi;
  if (q.volume != null) out.VOL = q.volume;
  if (ex.status !== 'HOLD') swingAlertOnce_('held|' + rw.ticker + '|' + ex.status, 'Swing ' + (ex.status === 'DTE EXIT' ? 'ROLL' : ex.status) + ': ' + rw.ticker + ' ' + rw.strike + (rw.side === 'SHORT' ? 'P' : 'C'), ex.why, ex.status === 'STOPPED' || ex.status === 'TARGET');
}

// Writes the computed columns. Protected columns (Side, Expiry, Strike, Stock Stop, Stock Target) are written only on rows you have not started typing on.
function swingWriteOutputs_(sheet, map, width, data, rows, results) {
  const n = data.length;
  const fresh = sheet.getLastRow() - 1 >= n ? sheet.getRange(2, 1, n, width).getValues() : null;
  if (!fresh) { logToSheet_('Swing: the sheet shrank during the scan; nothing written.'); return; }
  const tc = map['Ticker'] - 1;
  for (let i = 0; i < n; i++) if (String(fresh[i][tc] || '').trim().toUpperCase() !== String(data[i][tc] || '').trim().toUpperCase()) { logToSheet_('Swing: rows moved during the scan; nothing written. Run it again.'); return; }
  const processed = {}; rows.forEach(function (r) { processed[r.idx] = r; });
  // current user-row status from the fresh read, so a row you started typing on mid-scan is protected too
  const isUser = function (i) {
    const q = swingNum_(fresh[i][map['Qty'] - 1]), e = swingNum_(fresh[i][map['Entry'] - 1]), d = swingYmdOfCell_(fresh[i][map['Entry Date'] - 1]);
    return (q != null && q !== 0) || (e != null && e > 0) || d !== '';
  };
  const free = SWING_OUTPUT_HEADERS.filter(function (h) { return map[h] && SWING_USER_COLS.indexOf(h) === -1; });
  const prot = SWING_USER_COLS.filter(function (h) { return map[h]; });
  const valueOf = function (i, h) { const r = results[i]; const v = r ? r[h] : undefined; return v === undefined || v === null ? '' : v; };
  // free columns: one block per run of adjacent columns, every processed row
  const cols = free.map(function (h) { return map[h]; }).sort(function (a, b) { return a - b; });
  const byCol = {}; free.forEach(function (h) { byCol[map[h]] = h; });
  let g = 0;
  while (g < cols.length) {
    let e = g; while (e + 1 < cols.length && cols[e + 1] === cols[e] + 1) e++;
    const block = [];
    for (let i = 0; i < n; i++) {
      const row = [];
      for (let c = g; c <= e; c++) row.push(processed[i] ? valueOf(i, byCol[cols[c]]) : fresh[i][cols[c] - 1]);
      block.push(row);
    }
    sheet.getRange(2, cols[g], n, e - g + 1).setValues(block);
    g = e + 1;
  }
  // protected columns: only rows that are not yours, in runs of consecutive rows
  prot.forEach(function (h) {
    let i = 0;
    while (i < n) {
      if (!processed[i] || isUser(i)) { i++; continue; }
      let j = i; while (j + 1 < n && processed[j + 1] && !isUser(j + 1)) j++;
      const vals = []; for (let k = i; k <= j; k++) vals.push([valueOf(k, h)]);
      sheet.getRange(i + 2, map[h], j - i + 1, 1).setValues(vals);
      i = j + 1;
    }
  });
  swingColorRows_(sheet, map, n);
  // order: your positions / exits first, then signals by score
  const rank = { STOPPED: 90, TARGET: 89, 'PREMIUM STOP': 88, ROLL: 87, 'TREND EXIT': 86, 'TIME EXIT': 85, 'NO PROGRESS': 84, 'FILL IN': 80, HOLD: 70, BUY: 60, SHORT: 60, WATCH: 40, LATE: 20, WAIT: 10, SKIP: 0 };
  const keys = [];
  for (let i = 0; i < n; i++) { const a = processed[i] && results[i] ? results[i].Action : ''; const sc = processed[i] && results[i] ? Number(results[i].Score) || 0 : 0; keys.push([(rank[a] || 0) * 1000 + sc]); }
  if (n > 1) {
    const lastC = sheet.getLastColumn();
    sheet.insertColumnAfter(lastC);
    try { sheet.getRange(2, lastC + 1, n, 1).setValues(keys); sheet.getRange(2, 1, n, lastC + 1).sort({ column: lastC + 1, ascending: false }); }
    finally { sheet.deleteColumn(lastC + 1); }
  }
}

/* ---------------------------------------------------------------------------
 * SCHEDULE
 * ------------------------------------------------------------------------- */
function swingRemoveTriggers_() { let n = 0; ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === SWING_TICK_FN) { ScriptApp.deleteTrigger(t); n++; } }); return n; }
function startSwingSchedule_() {
  swingRemoveTriggers_();
  ScriptApp.newTrigger(SWING_TICK_FN).timeBased().everyMinutes(10).create();
  const S = SWING_CONFIG.schedule;
  notify_(tryGetUi_(), 'Swing schedule started', 'Scan + log update on trading days at ' + S.slots.join(', ') + ' ET, and the summary at ' + S.summaryHm + '.\n(A 10-minute trigger wakes up and exits at once unless a slot is due. That is 144 short wake-ups a day, about 1 second each: well inside the 90 minutes/day trigger limit.)');
}
function stopSwingSchedule_() { notify_(tryGetUi_(), 'Swing schedule', 'Stopped (' + swingRemoveTriggers_() + ' trigger(s) removed).'); }
function swingScheduleStatus_() {
  const p = PropertiesService.getScriptProperties();
  const on = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === SWING_TICK_FN; }).length;
  notify_(tryGetUi_(), 'Swing schedule status', 'Schedule: ' + (on ? 'ON' : 'OFF') + '\nLast slot run: ' + (p.getProperty('SWING_LAST_SLOT') || 'never') + '\nLast summary: ' + (p.getProperty('SWING_LAST_SUMMARY') || 'never') +
    '\nRisk per trade: $' + swingRiskUsd_() + '\nPhone alerts: ' + (getAlertConfig_().ready ? 'ready' : 'NOT set up (menu: Quick and Leap > Phone Alerts)'));
}
function hmToMin_(hm) { const p = String(hm).split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
// Pure: which slot (minute of day) is due now, or null. lastDone = the last slot minute already run today (or -1).
function swingDueSlot_(m, slotsMin, lastDone, graceMin) {
  let due = null;
  slotsMin.forEach(function (s) { if (s > lastDone && m >= s && m - s <= graceMin) due = s; });
  return due;
}
function swingTick_() {
  const now = new Date(), et = swingEt_(now), S = SWING_CONFIG.schedule, props = PropertiesService.getScriptProperties();
  if (!swingIsTradingDay_(et.ymd, et.dow)) return;
  const ls = props.getProperty('SWING_LAST_SLOT') || '', lastDone = ls.indexOf(et.ymd) === 0 ? parseInt(ls.split(' ')[1], 10) : -1;
  const slot = swingDueSlot_(et.m, S.slots.map(hmToMin_), lastDone, S.graceMin);
  if (slot != null) {
    props.setProperty('SWING_LAST_SLOT', et.ymd + ' ' + slot);       // claimed first so an overlapping tick cannot run it twice
    try { swingScan_({ quiet: true }); } catch (e) { logToSheet_('Swing scan failed: ' + (e && e.message ? e.message : e)); swingAlertOnce_('scanfail', 'Swing scan failed', String(e && e.message ? e.message : e).slice(0, 200), false); }
    return;
  }
  if (et.m >= hmToMin_(S.summaryHm) && props.getProperty('SWING_LAST_SUMMARY') !== et.ymd) {
    props.setProperty('SWING_LAST_SUMMARY', et.ymd);
    try { swingLogTick_(true); swingScoreNow_(true); swingSummaryNow_(); } catch (e) { logToSheet_('Swing summary failed: ' + (e && e.message ? e.message : e)); }
  }
}

/* ---------------------------------------------------------------------------
 * DEBUG
 * ------------------------------------------------------------------------- */
function swingDebugOne_() {
  const ui = SpreadsheetApp.getUi(), r = ui.prompt('Swing: debug one ticker', 'Ticker (for example NVDA):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = String(r.getResponseText()).trim().toUpperCase(), et = swingEt_(new Date());
  const bars = swingGetBars_([t, 'SPY'], et), f = swingFeatures_(swingCompleted_(bars[t], et)), spy = swingFeatures_(swingCompleted_(bars['SPY'], et));
  const sg = swingSignal_(f, spy, SWING_CONFIG);
  notify_(ui, 'Swing debug ' + t, 'Sessions: ' + (bars[t] ? bars[t].length : 0) + '\nFeatures: ' + JSON.stringify(f, function (k, v) { return typeof v === 'number' ? Math.round(v * 100) / 100 : v; }) +
    '\n\nDecision: ' + sg.action + ' ' + (sg.setup || '') + ' score ' + sg.score + '\n' + sg.why.join('\n') + (sg.stop ? '\nstop ' + swingR2_(sg.stop) + ' target ' + swingR2_(sg.target) : ''));
}