/* ============================================================================
 * DayTrade.gs  —  the "Day" tab: open in the morning, flat by the close.
 * ----------------------------------------------------------------------------
 * Apps Script only (no Cloud Function redeploy). Own tab ("Day"), own hidden sheets (DayLog), own menu, own schedule. Shares only helpers from
 * momentum.gs / Earnings.gs and the Tasty / Yahoo / Finnhub rate limits.
 *
 * THE SETUP (all rules are code you can read below, nothing is hidden):
 *   1. STOCKS IN PLAY. Day traders only trade names that are unusually active today. Measured as relative volume (RVOL): volume in the first
 *      5 minutes vs the average of the same 5 minutes over the previous 14 sessions. Before the open, the same idea on pre-market volume plus the
 *      overnight gap and any earnings today. Price >= $5, ATR >= $0.50, average volume >= 1M, so fills are cheap.
 *   2. OPENING RANGE BREAKOUT (ORB), 5 minutes. After 9:35 the first 5-minute candle decides the side: green -> LONG above its high, red ->
 *      SHORT below its low. Stop = 10% of the 14-day ATR from the trigger. Nothing else is traded.
 *   3. FILTERS used for ranking: gap in the same direction, price on the right side of VWAP, SPY/QQQ pointing the same way, catalyst.
 *   4. RISK: 1% of the account per trade, positions capped at 1/5 of the account (times your leverage setting), no new entries after 11:30,
 *      everything closed by 15:50 ET. Same-day only: this tab never suggests holding overnight.
 *   5. LEARNING LOOP: every day at 16:05 the sheet replays what each shortlisted signal would have done (stop-first, with slippage) into the
 *      DayLog sheet, whether or not you took it. "Day Stats" in the menu shows win rate and average R by score bucket. If the numbers are
 *      not positive after ~30 days, do not trade it with real money.
 *
 * EVIDENCE (see the project doc day_tab_proposal for sources):
 *   - Zarattini, Barbon, Aziz (SSRN 4729284; 2016-2023, >7,000 US stocks): 5-minute ORB on the top-20 "stocks in play" by RVOL, Sharpe ~2.8,
 *     1,600%+ total. Costs and slippage assumptions are not stated on their summary page and the QuantConnect replication ignores them.
 *   - Day traders as a group lose: Brazil futures 2013-15, 97% of those trading 300+ days lost money (Chague et al.); Taiwan, >80% lose in a
 *     typical half-year and aggregate returns were negative every year (Barber et al.). A good backtest is not a good account.
 *   - PDT: SEC approved FINRA's replacement of the $25,000 day-trading minimum on 2026-04-14 (intraday margin standard), but brokers phase it in
 *     over up to 18 months. Check what your broker enforces today.
 *
 * NOT FINANCIAL ADVICE. Day trading loses money for most people. Start with paper results (DayLog), then tiny size.
 * ========================================================================== */

const DAY_SHEET_NAME = 'Day';
const DAY_LOG_SHEET = 'DayLog';
const DAY_TICK_FN = 'dayScheduledTick_';

const DAY_CONFIG = {
  orMinutes: 5,                 // opening range length
  minPrice: 5, minAtr: 0.5, minAvgVol: 1000000,
  minRvol: 1.0,                 // OR RVOL needed to be a tradable "stock in play" (higher ranks higher)
  minGapPct: 1.0,               // pre-market watch list: |gap| or a catalyst
  stopAtrFrac: 0.10,            // stop distance = this x 14-day ATR (the paper's value)
  targetR: 2,                   // 'TARGET' alert at this many R; the paper just holds to the close
  chaseR: 0.5,                  // a trigger more than this many R behind price is LATE, not BUY
  entryCutoff: '11:30',         // no new entries after this ET time
  closeBeforeMin: 10,           // CLOSE alert this many minutes before the close
  riskPct: 1,                   // % of account risked per trade
  maxPositions: 5,
  defaultAccount: 10000,        // overridden by menu "Set Account Size"
  slipPerShare: 0.02,           // replay slippage, each side
  minRtoSlip: 5,                // stop distance must be at least this many times the per-share slippage (ATR >= $1.00 at the default 10% stop)
  maxNames: 90, shortlist: 15, sleepMs: 60,
  timeBudgetMs: 4.5 * 60 * 1000,
  optionHints: true,            // BUY / SHORT (and the best WAIT) rows also get an option to buy: call for LONG, put for SHORT
  optionHintMax: 6,
  // Auto_Trade hand-off: BUY / SHORT rows that got an option plan are appended to the Auto_Trade tab for you to review.
  // Status is written as autoTrade.status so nothing fires until YOU change it to whatever your executor treats as "go".
  autoTrade: { enabled: true, sheet: 'Auto_Trade', status: 'Review', minQty: 1, includeWait: false, lots: 1 },   // includeWait: also add WAIT rows (not triggered yet)
  optMinDte: 2,                 // never the 0-1 day contract: theta and spreads are brutal; use the first expiry at least this many days out
  optTargetDelta: 0.60,         // slightly in the money: moves like the stock, less premium wasted on time value
  optMaxSpreadPct: 10,          // (ask-bid)/mid, unless the spread is 5 cents or less
  optMinOi: 100,
  optLimitSpreadFrac: 0.25,     // limit = mid + this fraction of the spread (never above the ask)
  alertTopN: 5,
  tickMinutes: 5,               // how often the cheap gate wakes up (it exits at once unless a slot is due)
  schedule: {
    firstScanHm: '09:36',       // first scan: the 9:30 opening range is complete at 9:35, so a 9:30 run could not see it
    endHm: '15:30',             // last scan slot (pulled earlier on half days: 30 minutes before the close)
    everyMin: 30,               // slots at 10:00, 10:30, ... after the first scan
    graceMin: 20,               // a slot missed by more than this (Google delayed the trigger) is skipped
    preMarket: false,           // true adds the 8:30-9:25 watch list + phone brief
    closeCheck: true,           // one extra run at close-15 minutes, only if you hold something: the CLOSE alert
    eodReplay: true             // 16:05 paper replay into DayLog (a few calls, no sheet scan)
  }
};

// Added to the Day tab in version 2. They are NOT written into your existing header row automatically: menu "Add Option Columns" appends
// the ones you don't have (once; delete any you don't want and they stay deleted).
const DAY_OPTION_HEADERS = ['Opt Action', 'Opt Expiry', 'Opt Strike', 'Opt Mid', 'Opt Limit', 'Opt Stop', 'Opt Target', 'Opt Qty', 'Opt Delta', 'Opt Spread %', 'Opt OI'];
const DAY_HEADERS = ['Ticker', 'Price', 'Change', 'Entry Date', 'Entry', 'Qty', 'Action', 'Side', 'Setup', 'Score', 'Trigger', 'Stop', 'Target', 'Size',
  'Gap %', 'RVOL', 'Pre RVOL', 'ATR %', 'VW %', 'OR High', 'OR Low', 'Prev Close', 'Pre High', 'Pre Low', 'Spread %', 'Catalyst', 'Tape',
  'P/L $', 'P/L %', 'R', 'Why', 'Option'].concat(DAY_OPTION_HEADERS).concat(['LastRun', 'SortKey']);
const DAY_ENTRY_COL = 5;
const DAY_ENTRY_FORMULA = '=sumproduct(E2:E92,F2:F92)';

/* ============================================================================
 * PURE TIME + BAR MATH (no Apps Script services: unit-tested offline)
 * ========================================================================== */

// US Eastern offset in hours (-4 EDT / -5 EST) for a UTC millisecond timestamp. DST: 2nd Sunday of March 02:00 local -> 1st Sunday of Nov 02:00 local.
function dayEtOffset_(ms) {
  const y = new Date(ms).getUTCFullYear();
  const nthSunday = function (month, n) {
    const d = new Date(Date.UTC(y, month, 1));
    const first = (7 - d.getUTCDay()) % 7;
    return 1 + first + (n - 1) * 7;
  };
  const start = Date.UTC(y, 2, nthSunday(2, 2), 7, 0, 0);    // 02:00 EST = 07:00 UTC
  const end = Date.UTC(y, 10, nthSunday(10, 1), 6, 0, 0);    // 02:00 EDT = 06:00 UTC
  return ms >= start && ms < end ? -4 : -5;
}

// Yahoo chart JSON result -> [{ms, ymd, m, o, h, l, c, v}] ascending, m = minute of day in New York.
function dayParseBars_(res) {
  if (!res || !res.timestamp || !res.indicators || !res.indicators.quote || !res.indicators.quote[0]) return [];
  const q = res.indicators.quote[0], out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    const c = q.close ? q.close[i] : null;
    if (c == null || !(c > 0)) continue;
    const ms = res.timestamp[i] * 1000;
    const d = new Date(ms + dayEtOffset_(ms) * 3600000);
    out.push({ ms: ms, ymd: d.toISOString().slice(0, 10), m: d.getUTCHours() * 60 + d.getUTCMinutes(),
      o: q.open && q.open[i] != null ? q.open[i] : c, h: q.high && q.high[i] != null ? q.high[i] : c, l: q.low && q.low[i] != null ? q.low[i] : c,
      c: c, v: q.volume && q.volume[i] != null ? q.volume[i] : 0 });
  }
  return out;
}

const DAY_OPEN_M = 570, DAY_CLOSE_M = 960;     // 09:30, 16:00
function dayHm_(m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function dayMinutes_(hm) { const p = String(hm).split(':'); return parseInt(p[0], 10) * 60 + parseInt(p[1], 10); }
function dayMean_(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function dayR2_(v) { return v == null || isNaN(v) ? '' : Math.round(v * 100) / 100; }

// Everything that comes from PRIOR sessions: needs the 1-month 5-minute history. Cached for the day so live ticks only fetch today.
function dayBaseline_(bars, todayYmd, orMin) {
  const by = {}, order = [];
  bars.forEach(function (b) {
    if (b.ymd >= todayYmd) return;
    if (!by[b.ymd]) { by[b.ymd] = []; order.push(b.ymd); }
    by[b.ymd].push(b);
  });
  const sess = [];
  order.forEach(function (ymd) {
    const reg = by[ymd].filter(function (b) { return b.m >= DAY_OPEN_M && b.m < DAY_CLOSE_M; });
    if (reg.length < 20) return;                 // holiday stub / bad data
    const pre = by[ymd].filter(function (b) { return b.m < DAY_OPEN_M; });
    sess.push({
      ymd: ymd, o: reg[0].o, h: Math.max.apply(null, reg.map(function (b) { return b.h; })), l: Math.min.apply(null, reg.map(function (b) { return b.l; })),
      c: reg[reg.length - 1].c, v: reg.reduce(function (s, b) { return s + b.v; }, 0),
      orV: reg.filter(function (b) { return b.m < DAY_OPEN_M + orMin; }).reduce(function (s, b) { return s + b.v; }, 0),
      pre: pre
    });
  });
  if (sess.length < 3) return null;
  const last = sess.slice(-14);
  let trSum = 0, trN = 0;
  for (let i = 1; i < sess.length; i++) {
    if (i < sess.length - 14) continue;
    const s = sess[i], pc = sess[i - 1].c;
    trSum += Math.max(s.h - s.l, Math.abs(s.h - pc), Math.abs(s.l - pc)); trN++;
  }
  const prev = sess[sess.length - 1];
  return { prevYmd: prev.ymd, prevClose: prev.c, prevHigh: prev.h, prevLow: prev.l,
    atr: trN ? trSum / trN : null, avgVol: dayMean_(last.map(function (s) { return s.v; })), baseOrVol: dayMean_(last.map(function (s) { return s.orV; })),
    prePast: last.map(function (s) { return s.pre; }), sessions: sess.length };
}

// Pre-market volume today (up to minute `cut`) vs the same window over prior sessions.
function dayPreRvol_(base, todayBars, cut) {
  if (!base || !base.prePast) return null;
  const sumTo = function (arr) { return arr.filter(function (b) { return b.m < cut; }).reduce(function (s, b) { return s + b.v; }, 0); };
  const today = sumTo(todayBars);
  const past = dayMean_(base.prePast.map(sumTo));
  return past > 0 ? today / past : null;
}

// Today's numbers from today's bars (pre-market + regular so far).
function dayToday_(bars, todayYmd, nowM, orMin, base) {
  const t = bars.filter(function (b) { return b.ymd === todayYmd; });
  const out = { n: t.length, last: t.length ? t[t.length - 1].c : null, orDone: false };
  if (!t.length) return out;
  const pre = t.filter(function (b) { return b.m < DAY_OPEN_M; });
  const reg = t.filter(function (b) { return b.m >= DAY_OPEN_M && b.m < DAY_CLOSE_M; });
  if (pre.length) {
    out.preHigh = Math.max.apply(null, pre.map(function (b) { return b.h; }));
    out.preLow = Math.min.apply(null, pre.map(function (b) { return b.l; }));
    out.preLast = pre[pre.length - 1].c; out.preVol = pre.reduce(function (s, b) { return s + b.v; }, 0);
    out.preRvol = dayPreRvol_(base, pre, Math.min(nowM, DAY_OPEN_M));
  }
  if (reg.length) {
    out.open = reg[0].o;
    let pv = 0, vv = 0;
    reg.forEach(function (b) { pv += (b.h + b.l + b.c) / 3 * b.v; vv += b.v; });
    out.vwap = vv > 0 ? pv / vv : null;
    out.dayHigh = Math.max.apply(null, reg.map(function (b) { return b.h; }));
    out.dayLow = Math.min.apply(null, reg.map(function (b) { return b.l; }));
    const orBars = reg.filter(function (b) { return b.m < DAY_OPEN_M + orMin; });
    // the range is final only once the window has fully passed
    if (orBars.length && nowM >= DAY_OPEN_M + orMin) {
      out.orDone = true;
      out.orO = orBars[0].o; out.orC = orBars[orBars.length - 1].c;
      out.orH = Math.max.apply(null, orBars.map(function (b) { return b.h; })); out.orL = Math.min.apply(null, orBars.map(function (b) { return b.l; }));
      out.orV = orBars.reduce(function (s, b) { return s + b.v; }, 0);
      out.rvol = base && base.baseOrVol > 0 ? out.orV / base.baseOrVol : null;
    }
  }
  if (base && base.prevClose > 0) {
    const ref = out.open != null ? out.open : out.preLast;
    out.gapPct = ref != null ? (ref / base.prevClose - 1) * 100 : null;
  }
  return out;
}

/* ============================================================================
 * SIGNAL, SIZE, HELD-POSITION ACTION, REPLAY (pure)
 * ========================================================================== */

// tape: 'UP' | 'DOWN' | 'FLAT'. cat: catalyst text or ''. Returns the full state for one name.
function daySignal_(base, td, price, nowM, cfg, tape, cat) {
  const s = { state: 'SKIP', side: '', score: 0, setup: '', why: '' };
  if (!base || !(base.prevClose > 0)) { s.why = 'not enough price history'; return s; }
  const atrPct = base.atr && price ? base.atr / price * 100 : null;
  s.atrPct = atrPct;
  if (!(price >= cfg.minPrice)) { s.why = 'price under $' + cfg.minPrice; return s; }
  if (!(base.atr >= cfg.minAtr)) { s.why = 'ATR $' + dayR2_(base.atr) + ' under $' + cfg.minAtr + ': not enough range to pay for costs'; return s; }
  const Rtest = cfg.stopAtrFrac * base.atr;
  if (Rtest < cfg.minRtoSlip * cfg.slipPerShare) { s.why = 'stop distance $' + dayR2_(Rtest) + ' is under ' + cfg.minRtoSlip + 'x the assumed slippage per share: costs would eat the edge'; return s; }
  if (!(base.avgVol >= cfg.minAvgVol)) { s.why = 'average volume ' + Math.round(base.avgVol / 1000) + 'k under ' + Math.round(cfg.minAvgVol / 1000) + 'k'; return s; }
  const gap = td.gapPct;
  const R = Math.max(cfg.stopAtrFrac * base.atr, 0.01);
  s.R = R;
  const pts = function (side) {
    let p = 0;
    const rv = td.orDone ? td.rvol : td.preRvol;
    if (rv != null) p += Math.min(rv, 5) / 5 * 35;
    if (gap != null) { const g = Math.abs(gap); p += (side === 'LONG' ? gap > 0 : gap < 0) ? Math.min(g, 5) / 5 * 15 : -Math.min(g, 5) / 5 * 8; }
    p += Math.min(atrPct == null ? 0 : atrPct, 3) / 3 * 10;
    if (td.vwap != null) p += (side === 'LONG' ? price > td.vwap : price < td.vwap) ? 10 : -5;
    if (tape === 'UP') p += side === 'LONG' ? 10 : -10; else if (tape === 'DOWN') p += side === 'SHORT' ? 10 : -10;
    if (cat) p += 10;
    p += base.avgVol >= 5000000 ? 5 : 2;
    return Math.max(0, Math.min(100, p));
  };
  if (nowM < DAY_OPEN_M) {                                      // PRE-MARKET: build the watch list
    if (gap == null) { s.why = 'no pre-market prints yet'; return s; }
    const pr = td.preRvol;
    const watch = Math.abs(gap) >= cfg.minGapPct || !!cat || (pr != null && pr >= 2);
    if (!watch) { s.state = 'SKIP'; s.why = 'gap ' + dayR2_(gap) + '% and no catalyst: not in play'; return s; }
    s.side = gap >= 0 ? 'LONG' : 'SHORT';
    s.state = 'WATCH'; s.setup = 'PRE-MKT ' + (gap >= 0 ? 'GAP UP' : 'GAP DOWN');
    s.score = pts(s.side);
    s.trigger = s.side === 'LONG' ? td.preHigh : td.preLow;       // provisional: replaced by the opening range after 9:35
    s.why = 'gap ' + dayR2_(gap) + '%' + (pr != null ? ', pre-mkt volume ' + dayR2_(pr) + 'x normal' : '') + (cat ? ', ' + cat : '') + '. Real trigger = 5-minute opening range, set at 9:35';
    return s;
  }
  if (!td.orDone) { s.state = 'FORMING'; s.why = 'opening range forms until ' + dayHm_(DAY_OPEN_M + cfg.orMinutes) + ' ET'; s.side = gap != null && gap < 0 ? 'SHORT' : 'LONG'; s.score = pts(s.side); return s; }
  if (td.orC === td.orO) { s.state = 'SKIP'; s.why = 'doji opening candle: no direction'; return s; }
  s.side = td.orC > td.orO ? 'LONG' : 'SHORT';
  const rv = td.rvol;
  if (rv == null) { s.why = 'no volume baseline'; return s; }
  if (rv < cfg.minRvol) { s.state = 'SKIP'; s.why = 'RVOL ' + dayR2_(rv) + ' under ' + cfg.minRvol + ': not a stock in play today'; s.score = pts(s.side); return s; }
  const sign = s.side === 'LONG' ? 1 : -1;
  s.trigger = s.side === 'LONG' ? td.orH : td.orL;
  s.stop = s.trigger - sign * R;
  s.target = s.trigger + sign * cfg.targetR * R;
  s.score = pts(s.side);
  s.setup = 'ORB ' + cfg.orMinutes + 'm ' + s.side;
  const beyond = (price - s.trigger) * sign;                     // R units past the trigger
  const beyondR = beyond / R;
  const lateM = dayMinutes_(cfg.entryCutoff);
  if ((sign === 1 && price < td.orL) || (sign === -1 && price > td.orH)) { s.state = 'FAILED'; s.why = 'price went through the other side of the opening range: the setup is dead'; return s; }
  if (beyond < 0) {
    s.state = nowM > lateM ? 'NO NEW' : 'WAIT';
    s.why = 'waiting for ' + (s.side === 'LONG' ? 'a break above ' : 'a break below ') + dayR2_(s.trigger) + ' (' + dayR2_(-beyond) + ' away); RVOL ' + dayR2_(rv) + '. Scans are 30 min apart: set a price alert or a ' + (s.side === 'LONG' ? 'buy' : 'sell') + '-stop at the trigger instead of waiting for BUY';
    return s;
  }
  if (nowM > lateM) { s.state = 'NO NEW'; s.why = 'past ' + cfg.entryCutoff + ' ET: no new entries'; return s; }
  if (beyondR > cfg.chaseR) { s.state = 'LATE'; s.why = 'already ' + dayR2_(beyondR) + 'R past the trigger: chasing'; return s; }
  s.state = s.side === 'LONG' ? 'BUY' : 'SHORT';
  s.why = 'broke the 5-minute range ' + (s.side === 'LONG' ? 'high' : 'low') + ' ' + dayR2_(s.trigger) + ' on RVOL ' + dayR2_(rv) + (gap != null ? ', gap ' + dayR2_(gap) + '%' : '');
  return s;
}

// Shares: risk-based, capped by buying power per position (account x leverage / maxPositions).
function daySize_(account, cfg, price, R, leverage) {
  if (!(account > 0) || !(price > 0) || !(R > 0)) return 0;
  const byRisk = Math.floor(account * cfg.riskPct / 100 / R);
  const byCap = Math.floor(account * (leverage || 1) / cfg.maxPositions / price);
  return Math.max(0, Math.min(byRisk, byCap));
}

// A position you hold (qty > 0 long, < 0 short). Stop = entry -/+ 1R, moves to break-even after +1R (and stays).
function dayHeldAction_(h, price, base, nowM, closeM, cfg, todayYmd) {
  const R = base && base.atr ? Math.max(cfg.stopAtrFrac * base.atr, 0.01) : null;
  const sign = h.qty >= 0 ? 1 : -1;
  const out = { R: R, sign: sign };
  if (!(h.entry > 0)) { out.action = 'HOLD'; out.why = 'no Entry price typed'; return out; }
  out.pl = (price - h.entry) * h.qty;
  out.plPct = (price - h.entry) / h.entry * 100 * sign;
  if (R == null) { out.action = nowM >= closeM - cfg.closeBeforeMin ? 'CLOSE' : 'HOLD'; out.why = 'no ATR: stop not computed'; return out; }
  out.r = (price - h.entry) * sign / R;
  out.stop = h.entry - sign * R;
  out.target = h.entry + sign * cfg.targetR * R;
  const carried = h.entryYmd && h.entryYmd < todayYmd;
  if (nowM >= closeM - cfg.closeBeforeMin) { out.action = 'CLOSE'; out.why = 'end of day: flat before the close' + (carried ? ' (carried from ' + h.entryYmd + ')' : ''); return out; }
  if (carried) { out.action = 'CLOSE'; out.why = 'opened ' + h.entryYmd + ': this tab is same-day only'; return out; }
  if (out.r >= 1) out.stop = h.entry;                              // break-even after +1R
  if ((out.stop - price) * sign >= 0) { out.action = 'STOP'; out.why = 'price ' + dayR2_(price) + ' hit the stop ' + dayR2_(out.stop) + (out.r >= 0 ? ' (break-even)' : ''); return out; }
  if (out.r >= cfg.targetR) { out.action = 'TARGET'; out.why = dayR2_(out.r) + 'R: take profit or trail the stop up to the last 5-minute low'; return out; }
  if (nowM >= closeM - 30) { out.action = 'CLOSE SOON'; out.why = 'within 30 minutes of the close'; return out; }
  out.action = 'HOLD'; out.why = dayR2_(out.r) + 'R, stop ' + dayR2_(out.stop);
  return out;
}

// What the signal would have done today. regBars: today's regular-session 5m bars ascending. Pessimistic: if a bar could have both triggered
// the entry and hit the stop, the stop wins; stop fills at the stop (or the open if it gapped through); exit at the close otherwise.
function dayReplay_(regBars, sig, cfg) {
  const sign = sig.side === 'LONG' ? 1 : -1, R = sig.R, lateM = dayMinutes_(cfg.entryCutoff), orEnd = DAY_OPEN_M + cfg.orMinutes;
  let entry = null, stop = null, exit = null, reason = '', mfe = 0;
  for (let i = 0; i < regBars.length; i++) {
    const b = regBars[i];
    if (b.m < orEnd) continue;
    if (entry == null) {
      if (b.m > lateM) break;
      const hit = sign === 1 ? b.h >= sig.trigger : b.l <= sig.trigger;
      if (!hit) continue;
      entry = sign === 1 ? Math.max(b.o, sig.trigger) : Math.min(b.o, sig.trigger);
      entry += sign * cfg.slipPerShare;
      stop = sig.trigger - sign * R;
      if ((sign === 1 && b.l <= stop) || (sign === -1 && b.h >= stop)) { exit = stop - sign * cfg.slipPerShare; reason = 'STOP'; break; }
      mfe = Math.max(mfe, ((sign === 1 ? b.h : -b.l) - (sign === 1 ? entry : -entry)) / R);
      continue;
    }
    if ((sign === 1 && b.l <= stop) || (sign === -1 && b.h >= stop)) {
      const gapped = (sign === 1 && b.o < stop) || (sign === -1 && b.o > stop);
      exit = (gapped ? b.o : stop) - sign * cfg.slipPerShare; reason = 'STOP'; break;
    }
    mfe = Math.max(mfe, sign === 1 ? (b.h - entry) / R : (entry - b.l) / R);
  }
  if (entry == null) return { taken: false };
  if (exit == null) { const last = regBars[regBars.length - 1]; exit = last.c - sign * cfg.slipPerShare; reason = 'CLOSE'; }
  return { taken: true, entry: entry, exit: exit, reason: reason, r: (exit - entry) * sign / R, pnlPct: (exit - entry) * sign / entry * 100, mfeR: mfe };
}

function dayStats_(rows) {
  const done = rows.filter(function (r) { return r.taken && isFinite(r.r); });
  if (!done.length) return { n: 0 };
  const wins = done.filter(function (r) { return r.r > 0; });
  const bucket = function (lo, hi) {
    const b = done.filter(function (r) { return r.score >= lo && r.score < hi; });
    return { n: b.length, avgR: b.length ? dayMean_(b.map(function (r) { return r.r; })) : null, win: b.length ? b.filter(function (r) { return r.r > 0; }).length / b.length : null };
  };
  return { n: done.length, win: wins.length / done.length, avgR: dayMean_(done.map(function (r) { return r.r; })),
    avgWinR: wins.length ? dayMean_(wins.map(function (r) { return r.r; })) : null,
    avgLossR: done.length - wins.length ? dayMean_(done.filter(function (r) { return r.r <= 0; }).map(function (r) { return r.r; })) : null,
    b0: bucket(0, 50), b50: bucket(50, 65), b65: bucket(65, 101) };
}

/* ============================================================================
 * SETUP / MENU / SCHEDULE
 * ========================================================================== */

function setupDay() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DAY_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(DAY_SHEET_NAME);
  dayWriteHeaders_(sheet);
  if (!ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'dayAddMenu_'; })) ScriptApp.newTrigger('dayAddMenu_').forSpreadsheet(ss).onOpen().create();
  try { dayAddMenu_(); } catch (e) { /* appears on next open */ }
  notify_(tryGetUi_(), 'Day tab set up',
    'Created the Day tab. Menu "⚡ Day" appears after you reload the sheet.\n\nNext:\n  1. ⚡ Day > Set Account Size\n  2. ⚡ Day > Debug One Ticker (try NVDA): confirms the intraday data source works\n' +
    '  3. ⚡ Day > Run Scan Now\n  4. ⚡ Day > Start Schedule (scans every 30 min, 9:36-15:30 ET, weekdays)\n\n' +
    'Type Ticker / Entry Date / Entry / Qty on a row for a trade you took (Qty negative for a short). The tab then manages it: STOP, TARGET, CLOSE.');
}

function dayAddMenu_() {
  SpreadsheetApp.getUi().createMenu('⚡ Day')
    .addItem('Run Scan + Send to Auto_Trade', 'dayScanNow_')
    .addItem('Set Account Size…', 'daySetAccount_')
    .addItem('Add Extra Tickers…', 'dayAddExtraTickers_')
    .addItem('Add Option Columns (once)', 'dayAddOptionColumns_')
    .addSeparator()
    .addItem('▶ Start Schedule', 'startDaySchedule_')
    .addItem('■ Stop Schedule', 'stopDaySchedule_')
    .addItem('Schedule Status', 'dayScheduleStatus_')
    .addSeparator()
    .addItem('Day Stats (paper results)', 'dayShowStats_')
    .addItem('Replay Today Now', 'dayEodNow_')
    .addItem('📒 Auto Log: Update Now', 'alogUpdateNow_')
    .addItem('📒 Auto Log: Stats', 'alogShowStats_')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🔍 Debug').addItem('One Ticker (full trail)', 'debugDayOneTicker'))
    .addToUi();
}

function dayHeaderMap_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const rng = sheet.getRange(1, 1, 1, lastCol);
  const vals = rng.getValues()[0], forms = rng.getFormulas()[0];
  const known = {}; DAY_HEADERS.forEach(function (h) { known[h] = true; });
  const map = {};
  vals.forEach(function (v, i) {
    const k = String(v == null ? '' : v).trim();
    if (known[k] && k !== 'Entry' && k !== 'P/L $' && !map[k]) map[k] = i + 1;
    // header cells that hold your formula: =sumproduct( is Entry, =sum( is P/L $
    if (!map.Entry && /^=\s*sumproduct\s*\(/i.test(forms[i] || '')) map.Entry = i + 1;
    else if (!map['P/L $'] && /^=\s*sum\s*\(/i.test(forms[i] || '')) map['P/L $'] = i + 1;
  });
  if (!map.Entry) vals.forEach(function (v, i) { if (!map.Entry && String(v).trim() === 'Entry') map.Entry = i + 1; });
  if (!map['P/L $']) vals.forEach(function (v, i) { if (!map['P/L $'] && String(v).trim() === 'P/L $') map['P/L $'] = i + 1; });
  return map;
}

function dayColLetter_(c) { let s = ''; while (c > 0) { const r = (c - 1) % 26; s = String.fromCharCode(65 + r) + s; c = Math.floor((c - 1) / 26); } return s; }

// Written once, on an empty sheet. After that your layout rules: the scan follows the labels in row 1.
function dayWriteHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  if (sheet.getRange(1, 1, 1, lastCol).getValues()[0].some(function (v) { return String(v || '').trim() !== ''; })) return;
  const n = DAY_HEADERS.length, plc = DAY_HEADERS.indexOf('P/L $') + 1;
  DAY_HEADERS.forEach(function (h, i) { if (i !== DAY_ENTRY_COL - 1 && i !== plc - 1) sheet.getRange(1, i + 1).setValue(h); });
  const e1 = sheet.getRange(1, DAY_ENTRY_COL); e1.setFormula(DAY_ENTRY_FORMULA);
  const p1 = sheet.getRange(1, plc); p1.setFormula('=sum(' + dayColLetter_(plc) + '2:' + dayColLetter_(plc) + '92)');
  const rng = sheet.getRange(1, 1, 1, n);
  rng.setFontWeight('bold').setFontSize(6).setWrap(true).setBackground('#d9ead3');           // same look as Flip: orange = you type, green = script
  [1, 4, 6].forEach(function (c) { sheet.getRange(1, c).setBackground('#fff2cc'); });
  [e1, p1].forEach(function (c) { c.setBackground('#00ff00').setFontSize(9).setHorizontalAlignment('center').setNumberFormat('0'); });
  sheet.getRange(1, 2, 1, 2).setHorizontalAlignment('center'); sheet.getRange(1, 6).setHorizontalAlignment('center');
  [59, 51, 58, 55, 58, 38, 72].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  sheet.setRowHeight(1, 29); sheet.setFrozenRows(1); sheet.setFrozenColumns(1);
}

// Appends the option columns you don't have yet to the END of row 1 (never moves or re-adds anything else). Run once after installing this version.
function dayAddOptionColumns_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DAY_SHEET_NAME);
  if (!sheet) { notify_(tryGetUi_(), 'Day', 'No Day tab. Run setupDay first.'); return; }
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const have = {}; sheet.getRange(1, 1, 1, lastCol).getValues()[0].forEach(function (v) { have[String(v).trim()] = true; });
  let next = lastCol; while (next > 0 && String(sheet.getRange(1, next).getValue()).trim() === '') next--;
  const add = DAY_OPTION_HEADERS.filter(function (h) { return !have[h]; });
  add.forEach(function (h) { next++; sheet.getRange(1, next).setValue(h).setFontWeight('bold').setFontSize(6).setWrap(true).setBackground('#d9ead3'); });
  notify_(tryGetUi_(), 'Day', add.length ? 'Added ' + add.length + ' option column(s) at the end: ' + add.join(', ') + '.\nMove or delete them as you like; the scan follows the header names.' : 'All option columns are already there.');
}

function daySetAccount_() {
  const ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  const r = ui.prompt('Account size for sizing', 'Dollars you trade with (used for the Size column: 1% risk per trade, max 1/5 of the account per position).\nCurrent: ' + (props.getProperty('DAY_ACCOUNT') || DAY_CONFIG.defaultAccount) +
    '\n\nLeverage: add " x2" or " x4" after the number only if your broker really gives that intraday buying power, e.g. "10000 x4".', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const m = r.getResponseText().replace(/[,$]/g, '').match(/^\s*([\d.]+)\s*(?:x\s*([\d.]+))?\s*$/i);
  if (!m || !(parseFloat(m[1]) > 0)) { notify_(ui, 'Day', 'Not understood. Example: 10000 or 10000 x4'); return; }
  props.setProperty('DAY_ACCOUNT', m[1]); props.setProperty('DAY_LEVERAGE', m[2] ? m[2] : '1');
  notify_(ui, 'Day', 'Account ' + m[1] + ', leverage x' + (m[2] || '1') + ' saved.');
}
function dayAccount_() {
  const p = PropertiesService.getScriptProperties();
  return { account: parseFloat(p.getProperty('DAY_ACCOUNT')) || DAY_CONFIG.defaultAccount, leverage: parseFloat(p.getProperty('DAY_LEVERAGE')) || 1 };
}
function dayAddExtraTickers_() {
  const ui = SpreadsheetApp.getUi(), props = PropertiesService.getScriptProperties();
  const r = ui.prompt('Extra tickers for the Day scan', 'Comma-separated, added to the built-in universe (replaces the old extra list).\nCurrent: ' + (props.getProperty('DAY_EXTRA') || '(none)'), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const list = r.getResponseText().toUpperCase().split(/[\s,;]+/).filter(function (x) { return /^[A-Z.\-]{1,6}$/.test(x); });
  props.setProperty('DAY_EXTRA', list.join(','));
  notify_(ui, 'Day', 'Extra tickers saved: ' + (list.join(', ') || '(none)'));
}

function dayRemoveTriggers_() { let n = 0; ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === DAY_TICK_FN) { ScriptApp.deleteTrigger(t); n++; } }); return n; }
function startDaySchedule_() {
  dayRemoveTriggers_();
  ScriptApp.newTrigger(DAY_TICK_FN).timeBased().everyMinutes(DAY_CONFIG.tickMinutes).create();
  const S = DAY_CONFIG.schedule;
  notify_(tryGetUi_(), 'Day schedule started', 'Scans on weekdays at ' + daySlots_(DAY_CLOSE_M, S).map(dayHm_).join(', ') + ' ET (first scan ' + S.firstScanHm + ', last ' + S.endHm + ').' +
    (S.closeCheck ? '\nPlus one CLOSE check at ' + dayHm_(DAY_CLOSE_M - DAY_CONFIG.closeBeforeMin - 5) + ' if you hold something.' : '') + (S.eodReplay ? '\nPlus the 16:05 paper replay.' : '') +
    '\n(A ' + DAY_CONFIG.tickMinutes + '-minute trigger wakes up and exits at once unless a slot is due.)');
}
function stopDaySchedule_() { notify_(tryGetUi_(), 'Day schedule', 'Stopped (' + dayRemoveTriggers_() + ' trigger(s) removed).'); }
function dayScheduleStatus_() {
  const p = PropertiesService.getScriptProperties();
  const on = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === DAY_TICK_FN; }).length;
  const a = dayAccount_();
  notify_(tryGetUi_(), 'Day schedule status', 'Schedule: ' + (on ? 'ON' : 'OFF') + '\nLast pre-market scan: ' + (p.getProperty('DAY_LAST_PRE') || 'never') + '\nLast full scan: ' + (p.getProperty('DAY_LAST_FULL') || 'never') +
    '\nLast paper replay: ' + (p.getProperty('DAY_LAST_EOD') || 'never') + '\nAccount: ' + a.account + ' x' + a.leverage + '\nPhone alerts: ' + (getAlertConfig_().ready ? 'ready' : 'NOT set up (menu: Quick and Leap > Phone Alerts)'));
}

/* ============================================================================
 * DATA
 * ========================================================================== */

function dayUniverse_() {
  const set = {};
  const add = function (arr) { (arr || []).forEach(function (t) { const s = String(t || '').trim().toUpperCase(); if (/^[A-Z.\-]{1,6}$/.test(s)) set[s] = true; }); };
  try { if (typeof RESEARCH_UNIVERSE !== 'undefined') add(RESEARCH_UNIVERSE); } catch (e) { /* optional */ }
  try { if (typeof CSP_STOCK_UNIVERSE !== 'undefined') add(CSP_STOCK_UNIVERSE); } catch (e) { /* optional */ }
  try { if (typeof FLIP_UNIVERSE !== 'undefined') add(FLIP_UNIVERSE); } catch (e) { /* optional */ }
  try { if (typeof LONG_STOCK_UNIVERSE !== 'undefined') add(LONG_STOCK_UNIVERSE); } catch (e) { /* optional */ }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ['Quick', 'Leap', 'Research', 'CSP', 'Flip', 'Long'].forEach(function (name) {
    try {
      const sh = ss.getSheetByName(name);
      if (!sh || sh.getLastRow() < 2) return;
      const hdr = sh.getRange(1, 1, 1, Math.min(sh.getLastColumn(), 6)).getValues()[0];
      let c = hdr.indexOf('Ticker'); if (c < 0) c = 0;
      add(sh.getRange(2, c + 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }));
    } catch (e) { /* skip */ }
  });
  add((PropertiesService.getScriptProperties().getProperty('DAY_EXTRA') || '').split(','));
  add(['SPY', 'QQQ']);
  return Object.keys(set);
}

// one Yahoo call: today's session only (live ticks) or the full month (baseline).
function dayFetchBars_(ticker, full) {
  const range = full ? '1mo' : '1d';
  const hosts = ['query1', 'query2'];
  for (let h = 0; h < hosts.length; h++) {
    try {
      const resp = UrlFetchApp.fetch('https://' + hosts[h] + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=' + range + '&interval=5m&includePrePost=true',
        { method: 'get', muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' } });
      if (resp.getResponseCode() !== 200) continue;
      const r = (JSON.parse(resp.getContentText()).chart || {}).result;
      const bars = dayParseBars_(r && r[0]);
      if (bars.length) return bars;
    } catch (e) { Logger.log('day bars ' + ticker + ': ' + e); }
  }
  return null;
}

// Baseline (prior sessions) cached for the day so live ticks only need today's small call.
function dayBaselineFor_(ticker, todayYmd, bars) {
  const cache = CacheService.getScriptCache(), key = 'DAYB2_' + todayYmd + '_' + ticker;
  if (!bars) { const hit = cache.get(key); if (hit) { try { return JSON.parse(hit); } catch (e) { /* refetch */ } } return null; }
  const b = dayBaseline_(bars, todayYmd, DAY_CONFIG.orMinutes);
  if (b) {
    const slim = {}; Object.keys(b).forEach(function (k) { if (k !== 'prePast') slim[k] = b[k]; });
    try { cache.put(key, JSON.stringify(slim), 6 * 3600); } catch (e) { /* too big: ignore */ }
  }
  return b;
}

// Live prices for many stocks at once. { SYM: { price, prevClose, bid, ask } }
function dayQuotes_(tickers, token) {
  const out = {};
  if (!token) return out;
  for (let i = 0; i < tickers.length; i += 40) {
    const chunk = tickers.slice(i, i + 40);
    try {
      const resp = fetchTastyWithRetry_('https://api.tastyworks.com/market-data/by-type?' + chunk.map(function (s) { return 'equity=' + encodeURIComponent(s); }).join('&'), token);
      if (resp.getResponseCode() !== 200) continue;
      (((JSON.parse(resp.getContentText()).data) || {}).items || []).forEach(function (it) {
        const f = function (v) { const x = v != null ? parseFloat(v) : NaN; return isNaN(x) ? null : x; };
        const bid = f(it.bid), ask = f(it.ask), last = f(it.last), mark = f(it.mark);
        const price = last > 0 ? last : (mark > 0 ? mark : (bid > 0 && ask > 0 ? (bid + ask) / 2 : null));
        const pc = f(it['prev-close'] != null ? it['prev-close'] : (it['previous-close'] != null ? it['previous-close'] : it['close-price']));
        if (it.symbol && price) out[String(it.symbol).toUpperCase()] = { price: price, prevClose: pc, bid: bid, ask: ask };
      });
    } catch (e) { Logger.log('day quotes: ' + e); }
  }
  return out;
}

function dayCatalysts_(todayYmd, fromYmd) {
  const out = {};
  try {
    const key = getFinnhubApiKey_();
    if (!key) return out;
    const resp = fetchWithRetry_(FINNHUB_BASE_URL + '/calendar/earnings?from=' + fromYmd + '&to=' + todayYmd + '&token=' + encodeURIComponent(key), { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } }, 2, 800);
    if (resp.getResponseCode() !== 200) return out;
    ((JSON.parse(resp.getContentText()).earningsCalendar) || []).forEach(function (e) {
      if (!e.symbol || !e.date) return;
      if (e.date === todayYmd && e.hour === 'bmo') out[String(e.symbol).toUpperCase()] = 'earnings today (before open)';
      else if (e.date < todayYmd && e.hour === 'amc') out[String(e.symbol).toUpperCase()] = 'earnings last evening';
    });
  } catch (e) { Logger.log('day catalysts: ' + e); }
  return out;
}

// ---- OPTION PROPOSAL --------------------------------------------------------------------------------------------------------------------
// LONG signal -> BUY a CALL; SHORT signal -> BUY a PUT (long options only: risk is the premium, no margin, no assignment).
// Expiry: first expiry at least optMinDte days out. Strike: closest to delta 0.60 among the 7 strikes around the stock price, liquid only.
// Pure picker (unit-tested): cands = [{strike, delta, bid, ask, oi}] for ONE expiry and ONE side.
function dayChooseContract_(cands, side, price, cfg) {
  const ok = cands.filter(function (c) {
    if (!(c.bid > 0) || !(c.ask > 0) || c.ask < c.bid) return false;
    const mid = (c.bid + c.ask) / 2, sp = c.ask - c.bid;
    if (sp > 0.05 && sp / mid * 100 > cfg.optMaxSpreadPct) return false;
    if (c.oi != null && c.oi < cfg.optMinOi) return false;
    return true;
  });
  if (!ok.length) return null;
  const sign = side === 'LONG' ? 1 : -1;
  const withDelta = ok.filter(function (c) { return c.delta != null; });
  const rank = function (c) {
    const mid = (c.bid + c.ask) / 2, spPct = (c.ask - c.bid) / mid;
    if (c.delta != null) return Math.abs(Math.abs(c.delta) - cfg.optTargetDelta) + spPct * 0.5;
    // no delta from the feed: one strike in the money is the stand-in for ~0.60 delta
    const itm = (price - c.strike) * sign;
    return Math.abs(itm - price * 0.01) / price + spPct * 0.5;
  };
  return (withDelta.length ? withDelta : ok).slice().sort(function (a, b) { return rank(a) - rank(b); })[0];
}

// Turns the picked contract into the sheet fields. R = the stock-side stop distance of the signal (dollars).
function dayOptionPlan_(c, side, R, cfg, acct) {
  const mid = (c.bid + c.ask) / 2, sp = c.ask - c.bid;
  const limit = Math.min(c.ask, Math.round((mid + cfg.optLimitSpreadFrac * sp) * 100) / 100);
  const d = c.delta != null ? Math.abs(c.delta) : cfg.optTargetDelta;
  const stop = Math.max(0.01, Math.round((limit - d * R) * 100) / 100);
  const target = Math.round((limit + d * cfg.targetR * R) * 100) / 100;
  const riskPer = (limit - stop) * 100;
  const byRisk = riskPer > 0 ? Math.floor(acct.account * cfg.riskPct / 100 / riskPer) : 0;
  const byCap = Math.floor(acct.account / cfg.maxPositions / (limit * 100));
  return { mid: Math.round(mid * 100) / 100, limit: limit, stop: stop, target: target, qty: Math.max(0, Math.min(byRisk, byCap)), delta: c.delta, spreadPct: sp / mid * 100, oi: c.oi };
}

// Live: chain + one batched quote for the 7 strikes around the money. Returns a row-field object or { why }.
function dayOptionProposal_(ticker, side, price, R, token, acct) {
  try {
    const C = DAY_CONFIG;
    const chain = fetchTastyOptionChainNested_(ticker, token);
    if (!chain) return { why: 'no option chain' };
    const now = new Date();
    const today = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
    const minYmd = Utilities.formatDate(new Date(now.getTime() + C.optMinDte * 86400000), 'America/New_York', 'yyyy-MM-dd');
    const exp = chain.filter(function (e) { return Utilities.formatDate(e.date, 'America/New_York', 'yyyy-MM-dd') >= minYmd; })[0];
    if (!exp) return { why: 'no expiry at least ' + C.optMinDte + ' days out' };
    const isCall = side === 'LONG';
    const st = exp.strikes.filter(function (s) { return isCall ? s.callSymbol : s.putSymbol; }).sort(function (a, b) { return a.strike - b.strike; });
    if (!st.length) return { why: 'no strikes' };
    let ai = 0; st.forEach(function (s, i) { if (Math.abs(s.strike - price) < Math.abs(st[ai].strike - price)) ai = i; });
    const near = st.slice(Math.max(0, ai - 3), ai + 4);
    const syms = near.map(function (s) { return isCall ? s.callSymbol : s.putSymbol; });
    const q = fetchTastyMarketDataBatch_(syms, token);
    const cands = near.map(function (s, i) { const m = q[syms[i]] || {}; return { strike: s.strike, delta: m.delta, bid: m.bid, ask: m.ask, oi: m.oi, sym: syms[i] }; });
    const best = dayChooseContract_(cands, side, price, C);
    const expYmd = Utilities.formatDate(exp.date, 'America/New_York', 'yyyy-MM-dd');
    if (!best) return { why: 'no liquid contract for ' + expYmd + ' (spread over ' + C.optMaxSpreadPct + '% or thin open interest, or quotes not live yet)' };
    const plan = dayOptionPlan_(best, side, R, C, acct);
    const dte = Math.round((new Date(expYmd + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / 86400000);
    return { action: isCall ? 'BUY CALL' : 'BUY PUT', expiry: expYmd, strike: best.strike, plan: plan, dte: dte,
      text: (isCall ? 'CALL ' : 'PUT ') + best.strike + ' ' + Utilities.formatDate(exp.date, 'America/New_York', 'MMMd') + ' (' + dte + 'd): limit ' + plan.limit.toFixed(2) + ', mid ' + plan.mid.toFixed(2) +
        ', stop ' + plan.stop.toFixed(2) + ', target ' + plan.target.toFixed(2) + ', qty ' + plan.qty };
  } catch (e) { return { why: 'option lookup failed: ' + (e && e.message ? e.message : e) }; }
}

/* ============================================================================
 * AUTO_TRADE HAND-OFF
 * ========================================================================== */

// Pure mapping (BUY / SHORT / WAIT rows; a WAIT row is an order for "only if it triggers"): a Day row with an option plan -> the cell values of one Auto_Trade order. Returns null if it is not an order.
function dayAutoTradeOrder_(r, minQty, includeWait, fixedLots) {
  if (!r || (r.Action !== 'BUY' && r.Action !== 'SHORT' && !(includeWait && r.Action === 'WAIT'))) return null;
  const oa = r['Opt Action'];
  if (oa !== 'BUY CALL' && oa !== 'BUY PUT') return null;
  const strike = Number(r['Opt Strike']), limit = Number(r['Opt Limit']);
  let qty = fixedLots >= 1 ? fixedLots : Number(r['Opt Qty']), oneLot = false;
  // a triggered signal whose plan says 0 contracts (one contract is bigger than the per-position share of the account) still goes over as 1 lot: you decide in review
  if (!(qty >= 1) && r.Action !== 'WAIT') { qty = 1; oneLot = true; }
  if (!(strike > 0) || !(qty >= (minQty || 1)) || !(limit > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(String(r['Opt Expiry']))) return null;
  const cp = oa === 'BUY CALL' ? 'C' : 'P';
  return { ticker: String(r.Ticker).toUpperCase(), cp: cp, expiry: String(r['Opt Expiry']), strike: strike,
    strikeText: (Math.round(strike * 100) / 100) + cp, orderType: 'BTO', lots: qty, oneLot: oneLot, action: r.Action, under: Number(r.Price) || '', score: r.Score === undefined ? '' : r.Score,
    limit: Math.round(limit * 100) / 100, stop: Math.round(Number(r['Opt Stop']) * 100) / 100, target: Math.round(Number(r['Opt Target']) * 100) / 100 };
}

function dayAtHeaderMap_(sheet) {
  const map = {};
  sheet.getRange(1, 1, 1, Math.max(1, sheet.getLastColumn())).getValues()[0].forEach(function (h, i) {
    const k = String(h || '').toLowerCase().replace(/[^a-z#]/g, '');
    if (k && !map[k]) map[k] = i + 1;
  });
  return { rank: map.rank, ticker: map.ticker, expiry: map.expiry, strike: map.strike, type: map.ordertype, lots: map['#lot'] || map.lot || map.lots,
    limit: map.limitprice || map.limit, stop: map.stoploss, profit: map.profitsell, status: map.status };
}

// Keeps the Auto_Trade tab in step with the Day tab, one pass per scan:
//  1. REMOVE rows this script added that are still at Status "Review" when their signal is gone (action back to WAIT / FORMING / LATE / FAILED / NO NEW,
//     or the direction flipped call <-> put) or that are left over from an earlier day.
//  2. ADD a row for every BUY / SHORT with an option plan that has none yet (a signal that came back after its row was removed gets a new row).
// Rows you moved past Review (Ready, Sent, Filled, ...) are never touched. A ticker this scan did not look at is left alone.
function dayPushToAutoTrade_(rows, ymd) {
  const A = DAY_CONFIG.autoTrade;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(A.sheet);
  if (!sh) return 'Auto_Trade: tab "' + A.sheet + '" not found';
  const m = dayAtHeaderMap_(sh);
  const need = ['ticker', 'strike', 'status'].filter(function (k) { return !m[k]; });
  if (need.length) return 'Auto_Trade: header(s) not found: ' + need.join(', ');
  const props = PropertiesService.getScriptProperties();
  let st = {}; try { st = JSON.parse(props.getProperty('DAY_AT_PUSHED') || '{}'); } catch (e) {}
  if (st.ymd !== ymd) st = { ymd: ymd, keys: [] };
  let owned = {}; try { owned = JSON.parse(props.getProperty('DAY_AT_OWNED') || '{}'); } catch (e) {}   // 'TICKER|C' -> day it was added
  st.keys.forEach(function (k) { if (!owned[k]) owned[k] = ymd; });                                       // rows added before ownership was tracked
  const orders = rows.map(function (r) { return dayAutoTradeOrder_(r, A.minQty, A.includeWait, A.lots); }).filter(Boolean);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) return 'Auto_Trade: busy, will retry next scan';
  const removed = [];
  try {
    // ---- 1. remove stale Review rows
    const byTicker = {}; rows.forEach(function (r) { byTicker[String(r.Ticker).toUpperCase()] = r; });
    const gone = ['WAIT', 'FORMING', 'LATE', 'FAILED', 'NO NEW'].filter(function (x) { return !(A.includeWait && x === 'WAIT'); });
    const last0 = sh.getLastRow();
    if (last0 > 1) {
      const n0 = last0 - 1;
      const tk = sh.getRange(2, m.ticker, n0, 1).getValues(), sk = sh.getRange(2, m.strike, n0, 1).getValues(), ss0 = sh.getRange(2, m.status, n0, 1).getValues();
      const live = {};   // keys that still have a Review row
      const kill = [];
      for (let i = 0; i < n0; i++) {
        const t = String(tk[i][0]).trim().toUpperCase(), cpm = String(sk[i][0]).trim().match(/([CP])$/i);
        if (!t || !cpm || String(ss0[i][0]).trim().toLowerCase() !== A.status.toLowerCase()) continue;
        const key = t + '|' + cpm[1].toUpperCase();
        if (!owned[key]) continue;                      // your own row: leave it
        live[key] = true;
        const r = byTicker[t];
        const stale = owned[key] < ymd;
        const dead = r && (gone.indexOf(r.Action) >= 0 || (r.Side && (r.Side === 'LONG' ? 'C' : 'P') !== key.split('|')[1]));
        if (stale || dead) kill.push({ row: i + 2, key: key, why: stale ? 'old' : (r.Action || 'flipped') });
      }
      kill.sort(function (a, b) { return b.row - a.row; }).forEach(function (k) {   // bottom up so row numbers stay valid
        sh.deleteRow(k.row); delete live[k.key]; delete owned[k.key];
        st.keys = st.keys.filter(function (x) { return x !== k.key; });
        removed.push(k.key.replace('|', ' ') + ' (' + k.why + ')');
      });
      Object.keys(owned).forEach(function (k) { if (!live[k]) delete owned[k]; });   // row moved past Review or deleted by you: not ours any more
    } else { owned = {}; }

    // ---- 2. add new signals
    const fresh = orders.filter(function (o) { return st.keys.indexOf(o.ticker + '|' + o.cp) < 0; });
    const needAdd = ['expiry', 'type', 'lots', 'limit'].filter(function (k) { return !m[k]; });
    if (fresh.length && needAdd.length) return 'Auto_Trade: header(s) not found: ' + needAdd.join(', ');
    // first empty row judged by the Ticker column (the tab has formulas / validation far below the data)
    const tcol = sh.getRange(1, m.ticker, Math.max(2, sh.getLastRow()), 1).getValues();
    let lastRow = 1; tcol.forEach(function (v, i) { if (String(v[0]).trim() !== '') lastRow = i + 1; });
    let rank = 0; if (m.rank && lastRow > 1) sh.getRange(2, m.rank, lastRow - 1, 1).getValues().forEach(function (v) { if (Number(v[0]) > rank) rank = Number(v[0]); });
    fresh.forEach(function (o) {
      // noon UTC is the same calendar day in every US zone and in GMT, so no time-zone argument is needed
      const ep = o.expiry.split('-');
      const expDate = new Date(Date.UTC(+ep[0], +ep[1] - 1, +ep[2], 12, 0, 0));
      const row = ++lastRow;
      if (lastRow > 2) sh.getRange(2, 1, 1, sh.getLastColumn()).copyTo(sh.getRange(row, 1, 1, sh.getLastColumn()), SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
      const put = function (c, v) { if (c) sh.getRange(row, c).setValue(v); };
      put(m.rank, ++rank); put(m.ticker, o.ticker);
      put(m.expiry, expDate); if (m.expiry) sh.getRange(row, m.expiry).setNumberFormat('m/d/yyyy');
      put(m.strike, o.strikeText); put(m.type, o.orderType); put(m.lots, o.lots);
      put(m.limit, o.limit); if (m.limit) sh.getRange(row, m.limit).setNumberFormat('$#,##0.00');
      // option-premium exit prices from the Day plan (the tab's own stop/profit formulas assume a call; this is right for a put too)
      if (m.stop && o.stop > 0) { put(m.stop, o.stop); sh.getRange(row, m.stop).setNumberFormat('$#,##0.00'); }
      if (m.profit && o.target > 0) { put(m.profit, o.target); sh.getRange(row, m.profit).setNumberFormat('$#,##0.00'); }
      put(m.status, A.status);
      st.keys.push(o.ticker + '|' + o.cp); owned[o.ticker + '|' + o.cp] = ymd;
    });
    props.setProperty('DAY_AT_PUSHED', JSON.stringify(st));
    props.setProperty('DAY_AT_OWNED', JSON.stringify(owned));
    if (fresh.length) { try { alogAdd_(fresh, ymd); } catch (e) { logToSheet_('AutoLog add failed: ' + (e && e.message ? e.message : e)); } }
    const parts = [];
    if (removed.length) parts.push('removed ' + removed.join(', '));
    if (fresh.length) parts.push('added ' + fresh.map(function (o) { return o.ticker + ' ' + o.strikeText + ' x' + o.lots; }).join(', '));
    return parts.length ? 'Auto_Trade: ' + parts.join('; ') + ' (Status "' + A.status + '")' : '';
  } finally { lock.releaseLock(); }
}

// Calendar day of a date cell without needing the sheet's time zone (midnight in a US zone or GMT, or noon UTC): +6h, read the UTC date
function dayDateYmd_(dt) {
  const u = new Date(dt.getTime() + 6 * 3600000), p = function (n) { return (n < 10 ? '0' : '') + n; };
  return u.getUTCFullYear() + '-' + p(u.getUTCMonth() + 1) + '-' + p(u.getUTCDate());
}

// Menu: push whatever BUY / SHORT option plans are on the Day tab right now
function dayPushNow_() {
  const ui = tryGetUi_();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DAY_SHEET_NAME);
  if (!sheet || sheet.getLastRow() < 2) { notify_(ui, 'Day', 'Nothing on the Day tab yet.'); return; }
  const map = dayHeaderMap_(sheet);
  const vals = sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).getValues();
  const rows = vals.map(function (v) { const o = {}; Object.keys(map).forEach(function (h) { o[h] = v[map[h] - 1]; });
    if (o['Opt Expiry'] instanceof Date) o['Opt Expiry'] = dayDateYmd_(o['Opt Expiry']); return o; });
  const ymd = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
  notify_(ui, 'Day → Auto_Trade', dayPushToAutoTrade_(rows, ymd) || 'No new BUY / SHORT option plans to add (already sent today, or none with an option plan).');
}

/* ============================================================================
 * AUTO LOG — "what if I had placed every Auto_Trade order and never touched it"
 * ----------------------------------------------------------------------------
 * Every order the Day tab adds to Auto_Trade is logged to the AutoLog tab and followed with live option quotes (every 5 minutes, from the
 * Day schedule's existing trigger):
 *   PENDING    buy limit resting (a Day order: it is dropped at the close if never filled -> NOT FILLED)
 *   OPEN       filled at your limit price (rule: the ask came down to the limit); the stop and profit orders now rest, GTC
 *   TARGET     bid reached the profit price: sold at the profit price
 *   STOPPED    bid fell to the stop: sold at the bid (a market stop fills at the bid, usually a little under the stop)
 *   EXPIRED    the contract expired while open (closed at the last mark)
 * P/L $ = (exit - entry) x 100 x lots - fees. Open positions show Open P/L at the bid until they settle; they carry over days.
 * Limits: quotes are sampled every 5 minutes, so a touch between two samples is missed; wide option spreads make real fills worse than this.
 * ========================================================================== */

const ALOG_CONFIG = { sheet: 'AutoLog', feePerLot: 1.00 };   // feePerLot: opening commission per contract (closing is free at TastyTrade; check your own fee schedule)
const ALOG_HEADERS = ['Date', 'Ticker', 'Action', 'Contract', 'Added', 'Limit', 'Stop', 'Target', 'Lots', 'Status', 'Filled At', 'Entry', 'Exit', 'Exit Time',
  'P/L $', 'P/L %', 'Mark', 'Open P/L $', 'Bid High', 'Bid Low', 'Underlying', 'Score', 'Symbol', 'Expiry'];
const ALOG_TEXT_COLS = ['Date', 'Added', 'Filled At', 'Exit Time', 'Symbol', 'Expiry'];

function alogOcc_(ticker, expiryYmd, cp, strike) {
  return String(ticker).toUpperCase().padEnd(6, ' ') + expiryYmd.slice(2, 4) + expiryYmd.slice(5, 7) + expiryYmd.slice(8, 10) + cp + String(Math.round(strike * 1000)).padStart(8, '0');
}

function alogSheet_(create) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(ALOG_CONFIG.sheet);
  if (sh || !create) return sh;
  sh = ss.insertSheet(ALOG_CONFIG.sheet);
  sh.getRange(1, 1, 1, ALOG_HEADERS.length).setValues([ALOG_HEADERS]).setFontWeight('bold').setHorizontalAlignment('center');
  sh.setFrozenRows(1); sh.setFrozenColumns(2);
  const col = function (h) { return ALOG_HEADERS.indexOf(h) + 1; };
  ALOG_TEXT_COLS.forEach(function (h) { sh.getRange(2, col(h), 2000, 1).setNumberFormat('@'); });
  ['Limit', 'Stop', 'Target', 'Entry', 'Exit', 'Mark', 'Bid High', 'Bid Low', 'Underlying'].forEach(function (h) { sh.getRange(2, col(h), 2000, 1).setNumberFormat('$#,##0.00'); });
  ['P/L $', 'Open P/L $'].forEach(function (h) { sh.getRange(2, col(h), 2000, 1).setNumberFormat('$#,##0.00;-$#,##0.00;$0.00'); });
  sh.getRange(2, col('P/L %'), 2000, 1).setNumberFormat('0.0');
  const rules = [];
  ['P/L $', 'Open P/L $'].forEach(function (h) {
    const rg = sh.getRange(2, col(h), 2000, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#0b8043').setRanges([rg]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor('#c5221f').setRanges([rg]).build());
  });
  sh.setConditionalFormatRules(rules);
  return sh;
}

function alogRead_(sh) {
  const width = sh.getLastColumn(), hdr = sh.getRange(1, 1, 1, width).getValues()[0].map(function (h) { return String(h || '').trim(); });
  const map = {}; hdr.forEach(function (h, i) { if (h && !map[h]) map[h] = i + 1; });
  const n = sh.getLastRow() - 1;
  const recs = [];
  if (n > 0) sh.getRange(2, 1, n, width).getValues().forEach(function (v, i) {
    const r = { _row: i + 2 };
    ALOG_HEADERS.forEach(function (h) {
      let x = map[h] ? v[map[h] - 1] : '';
      if (x instanceof Date) x = h === 'Date' || h === 'Expiry' ? dayDateYmd_(x) : Utilities.formatDate(x, 'America/New_York', 'HH:mm');
      r[h] = x;
    });
    if (r.Ticker) recs.push(r);
  });
  return { map: map, recs: recs };
}

function alogWriteRow_(sh, map, r) {
  ALOG_HEADERS.forEach(function (h) { if (map[h]) sh.getRange(r._row, map[h]).setValue(r[h] === undefined || r[h] === null ? '' : r[h]); });
}

// Called while the push holds the script lock: one log row per order added to Auto_Trade.
function alogAdd_(orders, ymd) {
  const sh = alogSheet_(true);
  const { map, recs } = alogRead_(sh);
  const hm = Utilities.formatDate(new Date(), 'America/New_York', 'HH:mm');
  let next = sh.getLastRow() + 1;
  orders.forEach(function (o) {
    const cpOf = function (r) { const m = String(r.Contract).match(/^[\d.]+([CP])/); return m ? m[1] : ''; };
    const live = recs.some(function (r) { return r.Date === ymd && r.Ticker === o.ticker && cpOf(r) === o.cp && (r.Status === 'PENDING' || r.Status === 'OPEN'); });
    if (live) return;   // the same ticker / side is still working today: not a new order
    const rec = { _row: next++, Date: ymd, Ticker: o.ticker, Action: o.action, Contract: o.strikeText + ' ' + Utilities.formatDate(new Date(o.expiry + 'T12:00:00Z'), 'UTC', 'MMMd'), Added: hm,
      Limit: o.limit, Stop: o.stop || '', Target: o.target || '', Lots: o.lots, Status: 'PENDING', Underlying: o.under, Score: o.score,
      Symbol: alogOcc_(o.ticker, o.expiry, o.cp, o.strike), Expiry: o.expiry };
    alogWriteRow_(sh, map, rec);
    recs.push(rec);
  });
}

// One quote sample applied to one log row. Pure (no sheet calls), so it can be tested. ctx: { ymd, hm, afterClose, fee }
function alogStep_(r, q, ctx) {
  const lots = Number(r.Lots) || 1, fee = ctx.fee * lots;
  const bid = q && q.bid > 0 ? q.bid : null, ask = q && q.ask > 0 ? q.ask : null;
  const r2 = function (x) { return Math.round(x * 100) / 100; };
  if (bid != null && ask != null) r.Mark = r2((bid + ask) / 2);
  if (r.Status === 'PENDING') {
    if (r.Date < ctx.ymd) { r.Status = 'NOT FILLED'; return r; }
    if (!ctx.afterClose && ask != null && ask <= Number(r.Limit)) {
      r.Status = 'OPEN'; r.Entry = Number(r.Limit); r['Filled At'] = ctx.hm;
      if (bid != null) { r['Bid High'] = bid; r['Bid Low'] = bid; }
      r['Open P/L $'] = bid != null ? r2((bid - r.Entry) * 100 * lots - fee) : -r2(fee);
    } else if (ctx.afterClose) r.Status = 'NOT FILLED';
    return r;
  }
  if (r.Status === 'OPEN') {
    const entry = Number(r.Entry), target = Number(r.Target) || null, stop = Number(r.Stop) || null;
    const close = function (status, exit) {
      r.Status = status; r.Exit = r2(exit); r['Exit Time'] = ctx.ymd + ' ' + ctx.hm;
      r['P/L $'] = r2((exit - entry) * 100 * lots - fee); r['P/L %'] = Math.round((exit - entry) / entry * 1000) / 10; r['Open P/L $'] = '';
    };
    if (ctx.ymd > r.Expiry) { close('EXPIRED', Number(r.Mark) > 0 ? Number(r.Mark) : 0); return r; }
    if (bid == null || ctx.afterClose) { return r; }
    r['Bid High'] = Math.max(Number(r['Bid High']) || bid, bid); r['Bid Low'] = Math.min(Number(r['Bid Low']) || bid, bid);
    if (target && bid >= target) close('TARGET', target);
    else if (stop && bid <= stop) close('STOPPED', bid);
    else r['Open P/L $'] = r2((bid - entry) * 100 * lots - fee);
  }
  return r;
}

// Totals for the dialog / the end-of-day alert. Pure.
function alogStats_(recs, ymd) {
  const settled = recs.filter(function (r) { return r.Status === 'TARGET' || r.Status === 'STOPPED' || r.Status === 'EXPIRED'; });
  const open = recs.filter(function (r) { return r.Status === 'OPEN'; });
  const pl = function (r) { return Number(r['P/L $']) || 0; };
  const sum = function (a, f) { return a.reduce(function (t, r) { return t + f(r); }, 0); };
  const wins = settled.filter(function (r) { return pl(r) > 0; }), losses = settled.filter(function (r) { return pl(r) <= 0; });
  const filledAll = recs.filter(function (r) { return r.Entry !== '' && r.Entry != null; });
  const byDay = {};
  recs.forEach(function (r) { const d = byDay[r.Date] = byDay[r.Date] || { n: 0, filled: 0, settled: 0, net: 0, open: 0 }; d.n++; if (r.Entry !== '' && r.Entry != null) d.filled++; });
  settled.forEach(function (r) { const d = byDay[(r['Exit Time'] || r.Date).slice(0, 10)] = byDay[(r['Exit Time'] || r.Date).slice(0, 10)] || { n: 0, filled: 0, settled: 0, net: 0, open: 0 }; d.settled++; d.net += pl(r); });
  const byAct = {};
  settled.forEach(function (r) { const a = byAct[r.Action] = byAct[r.Action] || { n: 0, net: 0, w: 0 }; a.n++; a.net += pl(r); if (pl(r) > 0) a.w++; });
  return { total: recs.length, filled: filledAll.length, notFilled: recs.filter(function (r) { return r.Status === 'NOT FILLED'; }).length, settled: settled.length, open: open.length,
    net: sum(settled, pl), openPL: sum(open, function (r) { return Number(r['Open P/L $']) || 0; }), winRate: settled.length ? wins.length / settled.length : null,
    avgWin: wins.length ? sum(wins, pl) / wins.length : null, avgLoss: losses.length ? sum(losses, pl) / losses.length : null,
    expectancy: settled.length ? sum(settled, pl) / settled.length : null, byDay: byDay, byAct: byAct };
}

function alogUpdateNow_() { alogTick_(true); const ui = tryGetUi_(); if (ui) notify_(ui, 'Auto Log', 'Updated. See the AutoLog tab.'); }

// Every 5 minutes (from the Day schedule's trigger) and after each Day scan. Does nothing unless an order is PENDING / OPEN.
function alogTick_(force) {
  const sh = alogSheet_(false);
  if (!sh || sh.getLastRow() < 2) return;
  const now = new Date(), np = dayNowParts_(now);
  if (!force && (np.dow === '6' || np.dow === '7' || US_MARKET_HOLIDAYS[np.ymd] || np.m < DAY_OPEN_M || np.m > np.closeM + 20)) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const { map, recs } = alogRead_(sh);
    const active = recs.filter(function (r) { return r.Status === 'PENDING' || r.Status === 'OPEN'; });
    const props = PropertiesService.getScriptProperties();
    const afterClose = np.m >= np.closeM;
    if (active.length) {
      const hm = Utilities.formatDate(now, 'America/New_York', 'HH:mm');
      let quotes = {};
      const token = getTastyTradeAccessToken_();
      if (token) {
        const raw = fetchTastyMarketDataBatch_(active.map(function (r) { return String(r.Symbol); }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }), token);
        Object.keys(raw).forEach(function (k) { quotes[k.replace(/\s+/g, '')] = raw[k]; });
      }
      active.forEach(function (r) {
        const before = JSON.stringify(r);
        alogStep_(r, quotes[String(r.Symbol).replace(/\s+/g, '')], { ymd: np.ymd, hm: hm, afterClose: afterClose, fee: ALOG_CONFIG.feePerLot });
        if (JSON.stringify(r) !== before) alogWriteRow_(sh, map, r);
      });
    }
    // once per day after the close: a short result line to the phone
    if (afterClose && props.getProperty('ALOG_LAST_EOD') !== np.ymd) {
      props.setProperty('ALOG_LAST_EOD', np.ymd);
      const all = alogRead_(sh).recs, t = alogStats_(all.filter(function (r) { return r.Date === np.ymd || (r['Exit Time'] || '').slice(0, 10) === np.ymd; }), np.ymd);
      const cfg = getAlertConfig_();
      if (t.total && cfg.ready) sendPhoneAlert_(cfg, 'Auto log ' + np.ymd + ': ' + (t.net >= 0 ? '+' : '-') + '$' + Math.abs(t.net).toFixed(0) + ' settled',
        t.filled + ' of ' + t.total + ' orders filled, ' + t.settled + ' settled (' + (t.winRate == null ? '-' : Math.round(t.winRate * 100) + '% wins') + '), ' + t.open + ' still open (' + (t.openPL >= 0 ? '+' : '-') + '$' + Math.abs(t.openPL).toFixed(0) + ' open).', false);
    }
  } finally { lock.releaseLock(); }
}

function alogShowStats_() {
  const ui = tryGetUi_();
  const sh = alogSheet_(false);
  if (!sh || sh.getLastRow() < 2) { notify_(ui, 'Auto Log', 'Nothing logged yet. Orders are logged when the Day scan adds them to Auto_Trade.'); return; }
  const t = alogStats_(alogRead_(sh).recs, '');
  const d = function (x) { return x == null ? '-' : (x < 0 ? '-$' : '$') + Math.abs(x).toFixed(2); };
  const lines = ['Orders logged: ' + t.total + '   filled: ' + t.filled + (t.total ? ' (' + Math.round(t.filled / t.total * 100) + '%)' : '') + '   not filled: ' + t.notFilled,
    'Settled: ' + t.settled + '   open: ' + t.open, 'NET settled P/L: ' + d(t.net) + '   open (at bid): ' + d(t.openPL),
    'Win rate: ' + (t.winRate == null ? '-' : Math.round(t.winRate * 100) + '%') + '   avg win ' + d(t.avgWin) + '   avg loss ' + d(t.avgLoss) + '   per trade ' + d(t.expectancy), '',
    'By day (settled that day):'].concat(Object.keys(t.byDay).sort().slice(-10).map(function (k) { const x = t.byDay[k]; return '  ' + k + ': ' + x.filled + '/' + x.n + ' filled, ' + x.settled + ' settled, ' + d(x.net); }),
    ['', 'By action:'], Object.keys(t.byAct).map(function (k) { const x = t.byAct[k]; return '  ' + k + ': ' + x.n + ' settled, ' + Math.round(x.w / x.n * 100) + '% wins, ' + d(x.net); }));
  notify_(ui, 'Auto Log', lines.join('\n'));
}

/* ============================================================================
 * THE SCAN
 * ========================================================================== */

function dayNowParts_(now) {
  const ymd = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
  return { ymd: ymd, m: dayMinutes_(Utilities.formatDate(now, 'America/New_York', 'HH:mm')), dow: Utilities.formatDate(now, 'America/New_York', 'u'),
    closeM: US_MARKET_EARLY_CLOSES[ymd] ? 780 : DAY_CLOSE_M };
}
function dayReadHeld_(sheet, map) {
  const held = {};
  const n = sheet.getLastRow() - 1;
  if (n < 1 || !map.Ticker || !map.Qty) return held;
  const top = Math.max.apply(null, [map.Ticker, map.Qty, map['Entry Date'] || 1, map.Entry || 1]);
  sheet.getRange(2, 1, n, top).getValues().forEach(function (r) {
    const t = String(r[map.Ticker - 1] || '').trim().toUpperCase(), qty = Number(r[map.Qty - 1]);
    if (!t || !qty || held[t]) return;
    const ed = map['Entry Date'] ? r[map['Entry Date'] - 1] : '';
    let ymd = '';
    if (ed instanceof Date) ymd = dayDateYmd_(ed);
    held[t] = { qty: qty, entry: map.Entry ? Number(r[map.Entry - 1]) : 0, entryDate: ed, entryYmd: ymd };
  });
  return held;
}

// mode: 'PRE' (watch list, full month of bars), 'FULL' (at the open: rank everything), 'LIVE' (shortlist + your positions)
function dayRun_(mode, opts) {
  opts = opts || {};
  const startMs = Date.now(), C = DAY_CONFIG;
  const ui = opts.quiet ? null : tryGetUi_();
  const ss = SpreadsheetApp.getActiveSpreadsheet(), sheet = ss.getSheetByName(DAY_SHEET_NAME);
  if (!sheet) { notify_(ui, 'Day', 'No "' + DAY_SHEET_NAME + '" tab. Run setupDay once from the Apps Script editor.'); return null; }
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('DAY_RUNNING') || '0', 10);
  if (running && Date.now() - running < 8 * 60000) { notify_(ui, 'Day', 'A scan is already running.'); return null; }
  props.setProperty('DAY_RUNNING', String(Date.now()));
  try {
    dayWriteHeaders_(sheet);
    const now = new Date(), np = dayNowParts_(now), acct = dayAccount_();
    const token = getTastyTradeAccessToken_();
    if (!token) { notify_(ui, 'Day', 'No TastyTrade token (see ScriptLog).'); return null; }
    const map0 = dayHeaderMap_(sheet);
    const held0 = dayReadHeld_(sheet, map0);
    let short = {};
    try { const s = JSON.parse(props.getProperty('DAY_SHORT') || '{}'); if (s.ymd === np.ymd) short = s; } catch (e) { short = {}; }

    // which names to look at
    let names;
    if (mode === 'LIVE') {
      names = Object.keys(held0).concat((short.list || []).map(function (x) { return x.t; })).concat(['SPY', 'QQQ']);
    } else {
      const uni = dayUniverse_();
      names = Object.keys(held0).concat(uni);
    }
    const seen = {}; names = names.filter(function (t) { if (seen[t]) return false; seen[t] = true; return true; }).slice(0, C.maxNames);
    const quotes = dayQuotes_(names, token);
    const prevTrading = Utilities.formatDate(new Date(now.getTime() - 4 * 86400000), 'America/New_York', 'yyyy-MM-dd');
    const cats = mode === 'LIVE' ? (short.cats || {}) : dayCatalysts_(np.ymd, prevTrading);

    const full = mode !== 'LIVE';
    const res = {}, counts = {};
    let timedOut = false;
    for (let i = 0; i < names.length; i++) {
      if (Date.now() - startMs > C.timeBudgetMs) { timedOut = true; break; }
      const t = names[i];
      // history call only when the day's baseline is not cached yet (or in PRE / FULL); live ticks fetch just today
      let base = full ? null : dayBaselineFor_(t, np.ymd, null);
      const needHistory = full || !base;
      let bars = dayFetchBars_(t, needHistory);
      if (bars && needHistory) base = dayBaselineFor_(t, np.ymd, bars);
      if (!bars) { res[t] = { t: t, state: 'SKIP', why: 'no intraday data from Yahoo' }; continue; }
      const td = dayToday_(bars, np.ymd, np.m, C.orMinutes, base);
      const q = quotes[t];
      const price = q && q.price ? q.price : td.last;
      res[t] = { t: t, base: base, td: td, price: price, q: q };
      Utilities.sleep(C.sleepMs);
    }

    // tape from SPY + QQQ: both above (below) VWAP and their opening candles agree
    const tapeOf = function (t) { const r = res[t]; if (!r || !r.td || r.td.vwap == null || !r.price) return 0; return r.price > r.td.vwap ? 1 : -1; };
    const tapeSum = tapeOf('SPY') + tapeOf('QQQ');
    const tape = np.m < DAY_OPEN_M ? ((res.SPY && res.SPY.td && res.SPY.td.gapPct != null && res.QQQ && res.QQQ.td) ? (res.SPY.td.gapPct + (res.QQQ.td.gapPct || 0) > 0.3 ? 'UP' : (res.SPY.td.gapPct + (res.QQQ.td.gapPct || 0) < -0.3 ? 'DOWN' : 'FLAT')) : 'FLAT') : (tapeSum >= 2 ? 'UP' : (tapeSum <= -2 ? 'DOWN' : 'FLAT'));

    const rows = [];
    names.forEach(function (t) {
      const r = res[t];
      if (!r) return;
      const row = { Ticker: t, LastRun: now, Tape: tape };
      const h = held0[t];
      if (!r.base) { row.Action = h ? 'HOLD' : 'SKIP'; row.Why = r.why || 'no history'; row.SortKey = h ? 9000 : 10; if (r.price) row.Price = dayR2_(r.price); rows.push(row); return; }
      const price = r.price, td = r.td;
      row.Price = dayR2_(price);
      const pc = (r.q && r.q.prevClose) || r.base.prevClose;
      if (pc) row.Change = dayR2_(price - pc);
      row['Prev Close'] = dayR2_(r.base.prevClose);
      row['ATR %'] = dayR2_(r.base.atr / price * 100);
      if (td.gapPct != null) row['Gap %'] = dayR2_(td.gapPct);
      if (td.rvol != null) row.RVOL = dayR2_(td.rvol);
      if (td.preRvol != null) row['Pre RVOL'] = dayR2_(td.preRvol);
      if (td.vwap) row['VW %'] = dayR2_((price / td.vwap - 1) * 100);
      if (td.orDone) { row['OR High'] = dayR2_(td.orH); row['OR Low'] = dayR2_(td.orL); }
      if (td.preHigh != null) { row['Pre High'] = dayR2_(td.preHigh); row['Pre Low'] = dayR2_(td.preLow); }
      if (r.q && r.q.bid > 0 && r.q.ask > 0) row['Spread %'] = dayR2_((r.q.ask - r.q.bid) / price * 100);
      if (cats[t]) row.Catalyst = cats[t];
      const sg = daySignal_(r.base, td, price, np.m, C, tape, cats[t] || '');
      r.sig = sg;
      if (t === 'SPY' || t === 'QQQ') { row.Action = 'TAPE'; row.Why = 'market gauge: ' + tape; row.SortKey = 5; rows.push(row); return; }
      row.Side = sg.side; row.Setup = sg.setup; row.Score = dayR2_(sg.score);
      if (sg.trigger != null) row.Trigger = dayR2_(sg.trigger);
      if (sg.stop != null) { row.Stop = dayR2_(sg.stop); row.Target = dayR2_(sg.target); }
      if (sg.R && sg.state !== 'SKIP') { const sz = daySize_(acct.account, C, price, sg.R, acct.leverage); row.Size = sz; }
      row.Action = sg.state; row.Why = sg.why;
      row.SortKey = ({ BUY: 5000, SHORT: 5000, WAIT: 3000, WATCH: 3000, FORMING: 2500, LATE: 1500, 'NO NEW': 1000, FAILED: 500, SKIP: 100 })[sg.state] + sg.score;
      if (h) {
        const ha = dayHeldAction_({ qty: h.qty, entry: h.entry, entryYmd: h.entryYmd }, price, r.base, np.m, np.closeM, C, np.ymd);
        row.Action = ha.action; row.Why = ha.why; row.Side = h.qty > 0 ? 'LONG' : 'SHORT';
        if (ha.stop != null) { row.Stop = dayR2_(ha.stop); row.Target = dayR2_(ha.target); }
        if (ha.pl != null) { row['P/L $'] = dayR2_(ha.pl); row['P/L %'] = dayR2_(ha.plPct); row.R = dayR2_(ha.r); }
        row.Size = ''; row.SortKey = 9000 + (({ CLOSE: 5, STOP: 4, TARGET: 3, 'CLOSE SOON': 2 })[ha.action] || 0);
        row._held = ha;
      }
      rows.push(row);
    });

    // shortlist: at the open (FULL) fix the day's list; keep the best candidates for the live ticks
    if (mode === 'FULL' && np.m >= DAY_OPEN_M + C.orMinutes) {
      const cand = rows.filter(function (r) { return r.Score != null && r.Score !== '' && ['BUY', 'SHORT', 'WAIT', 'LATE', 'NO NEW'].indexOf(r.Action) >= 0 && !held0[r.Ticker]; })
        .sort(function (a, b) { return b.Score - a.Score; }).slice(0, C.shortlist);
      short = { ymd: np.ymd, cats: cats, list: cand.map(function (r) {
        const x = res[r.Ticker], sg = x.sig;
        return { t: r.Ticker, side: sg.side, trigger: sg.trigger, R: sg.R, score: dayR2_(sg.score), rvol: r.RVOL, gap: r['Gap %'] };
      }) };
      props.setProperty('DAY_SHORT', JSON.stringify(short));
      props.setProperty('DAY_LAST_FULL', np.ymd + ' ' + Utilities.formatDate(now, 'America/New_York', 'HH:mm'));
    }
    if (mode === 'PRE') props.setProperty('DAY_LAST_PRE', np.ymd + ' ' + Utilities.formatDate(now, 'America/New_York', 'HH:mm'));

    // option proposal: BUY CALL for LONG, BUY PUT for SHORT, on the best live signals (BUY / SHORT first, then the best WAIT rows)
    if (C.optionHints && np.m >= DAY_OPEN_M) {
      const rank = { BUY: 2, SHORT: 2, WAIT: 1 };
      rows.filter(function (r) { return rank[r.Action] && !held0[r.Ticker] && r.Side; })
        .sort(function (a, b) { return rank[b.Action] - rank[a.Action] || b.Score - a.Score; }).slice(0, C.optionHintMax)
        .forEach(function (r) {
          const x = res[r.Ticker];
          if (!(x && x.sig && x.sig.R > 0)) return;
          const o = dayOptionProposal_(r.Ticker, r.Side, r.Price, x.sig.R, token, { account: acct.account });
          if (o.why) { r.Option = o.why; return; }
          r['Opt Action'] = o.action; r['Opt Expiry'] = o.expiry; r['Opt Strike'] = o.strike; r['Opt Mid'] = o.plan.mid; r['Opt Limit'] = o.plan.limit;
          r['Opt Stop'] = o.plan.stop; r['Opt Target'] = o.plan.target; r['Opt Qty'] = o.plan.qty;
          if (o.plan.delta != null) r['Opt Delta'] = dayR2_(o.plan.delta);
          r['Opt Spread %'] = dayR2_(o.plan.spreadPct); if (o.plan.oi != null) r['Opt OI'] = o.plan.oi;
          r.Option = o.text;
          if (r.Action === 'WAIT') r.Option += ' (only if it triggers)';
        });
    }

    // hand the live BUY / SHORT option plans to Auto_Trade (appends only; never touches your existing rows)
    let pushNote = '';
    if (C.optionHints && C.autoTrade && C.autoTrade.enabled && np.m >= DAY_OPEN_M && np.m < DAY_CLOSE_M) {
      try { pushNote = dayPushToAutoTrade_(rows.filter(function (r) { return !held0[r.Ticker]; }), np.ymd); } catch (e) { pushNote = 'Auto_Trade push failed: ' + (e && e.message ? e.message : e); }
    }

    try { alogTick_(false); } catch (e) { logToSheet_('AutoLog update failed: ' + (e && e.message ? e.message : e)); }

    // rows order: held first (9000+), then ranked; SPY/QQQ gauges last
    rows.sort(function (a, b) { return (b.SortKey || 0) - (a.SortKey || 0); });
    const shown = rows.filter(function (r) { return r.Action !== 'SKIP' || held0[r.Ticker]; });
    const skipped = rows.length - shown.length;

    // write by header label, as the sheet is now; re-read what you hold right before writing so a cell you just typed survives
    const wmap = dayHeaderMap_(sheet);
    const heldNow = dayReadHeld_(sheet, wmap);
    shown.forEach(function (r) { const h = heldNow[r.Ticker]; if (h) { r['Entry Date'] = h.entryDate; r.Entry = h.entry || ''; r.Qty = h.qty; } });
    // a name you hold that this run did not look at (timed out / not in names) still keeps its row
    Object.keys(heldNow).forEach(function (t) { if (!shown.some(function (r) { return r.Ticker === t; })) shown.unshift({ Ticker: t, 'Entry Date': heldNow[t].entryDate, Entry: heldNow[t].entry, Qty: heldNow[t].qty, Action: 'HOLD', Why: 'not scanned this time', LastRun: now }); });
    const labels = DAY_HEADERS.filter(function (h) { return wmap[h]; }).sort(function (a, b) { return wmap[a] - wmap[b]; });
    const runs = [];
    labels.forEach(function (h) { const lr = runs[runs.length - 1]; if (lr && wmap[h] === lr.start + lr.labels.length) lr.labels.push(h); else runs.push({ start: wmap[h], labels: [h] }); });
    const last = sheet.getLastRow();
    runs.forEach(function (run) {
      if (last > 1) sheet.getRange(2, run.start, last - 1, run.labels.length).clearContent().clearNote();
      if (!shown.length) return;
      sheet.getRange(2, run.start, shown.length, run.labels.length).setValues(shown.map(function (r) { return run.labels.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }); }));
    });
    if (shown.length) dayFormat_(sheet, shown.length, wmap);

    const alertNote = opts.alert === false ? '' : daySendAlerts_(mode, np, shown, held0, tape, short, opts);
    const c = {}; shown.forEach(function (r) { c[r.Action] = (c[r.Action] || 0) + 1; });
    const msg = (timedOut ? '⏱️ Stopped at the time limit.\n' : '') + mode + ' scan of ' + names.length + ' names, tape ' + tape + '\n' + Object.keys(c).map(function (k) { return k + ': ' + c[k]; }).join('   ') +
      (skipped ? '\n(' + skipped + ' skipped rows not shown)' : '') + (alertNote ? '\n' + alertNote : '') + (pushNote ? '\n' + pushNote : '');
    logToSheet_('Day scan ' + msg.replace(/\n/g, ' | '));
    notify_(ui, 'Day scan', msg);
    return { mode: mode, rows: shown.length, timedOut: timedOut };
  } finally {
    props.deleteProperty('DAY_RUNNING');
  }
}

function dayFormat_(sheet, n, map) {
  const fmt = function (h, f) { if (map[h]) sheet.getRange(2, map[h], n, 1).setNumberFormat(f); };
  const center = function (h) { if (map[h]) sheet.getRange(2, map[h], n, 1).setHorizontalAlignment('center'); };
  fmt('Price', '$#,##0.00'); fmt('Change', '$#,##0.00;-$#,##0.00;$0.00'); fmt('Entry Date', 'm"/"d'); fmt('Entry', '$#,##0.00'); fmt('Qty', 'General');
  ['Price', 'Change', 'Entry Date', 'Entry', 'Qty'].forEach(center);
  ['Trigger', 'Stop', 'Target', 'OR High', 'OR Low', 'Prev Close', 'Pre High', 'Pre Low'].forEach(function (h) { fmt(h, '$#,##0.00'); });
  ['Gap %', 'VW %', 'ATR %', 'Spread %', 'P/L %'].forEach(function (h) { fmt(h, '0.00'); });
  ['Opt Mid', 'Opt Limit', 'Opt Stop', 'Opt Target', 'Opt Strike'].forEach(function (h) { fmt(h, '$#,##0.00'); }); fmt('Opt Expiry', 'mmm d'); fmt('Opt Delta', '0.00'); fmt('Opt Spread %', '0.0'); fmt('Opt Qty', '0');
  fmt('RVOL', '0.0'); fmt('Pre RVOL', '0.0'); fmt('Score', '0'); fmt('R', '0.0'); fmt('P/L $', '$#,##0.00;-$#,##0.00;$0.00'); fmt('LastRun', 'hh:mm');
  if (map.Change) {
    const rules = sheet.getConditionalFormatRules();
    if (!rules.some(function (r) { const g = r.getRanges(); return g.length && g[0].getColumn() === map.Change && g[0].getNumColumns() === 1; })) {
      const target = sheet.getRange(2, map.Change, Math.max(sheet.getMaxRows() - 1, 1), 1);
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor('#cc0000').setRanges([target]).build());
      rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#1d7620').setRanges([target]).build());
      sheet.setConditionalFormatRules(rules);
    }
  }
  if (map.Action) {
    const act = sheet.getRange(2, map.Action, n, 1).getValues();
    const colors = { BUY: '#b7e1cd', SHORT: '#f4cccc', WATCH: '#fff2cc', WAIT: '#fff2cc', FORMING: '#fff2cc', LATE: '#eeeeee', 'NO NEW': '#eeeeee', FAILED: '#eeeeee', HOLD: '#cfe2f3',
      STOP: '#e06666', TARGET: '#93c47d', CLOSE: '#f6b26b', 'CLOSE SOON': '#fce5cd', TAPE: '#d9d9d9' };
    sheet.getRange(2, map.Action, n, 1).setBackgrounds(act.map(function (v) { return [colors[v[0]] || null]; }));
  }
}

/* ============================================================================
 * ALERTS (same phone setup as Quick / Flip / Earnings)
 * ========================================================================== */

function daySendAlerts_(mode, np, shown, held, tape, short, opts) {
  const cfg = getAlertConfig_();
  if (!cfg.ready) return 'phone alerts not set up';
  const props = PropertiesService.getScriptProperties();
  let st = {};
  try { st = JSON.parse(props.getProperty('DAY_ALERT_STATE') || '{}'); } catch (e) { st = {}; }
  if (st.ymd !== np.ymd) st = { ymd: np.ymd, keys: {} };
  const lines = [], titleBits = [];
  const once = function (k) { if (st.keys[k]) return false; st.keys[k] = 1; return true; };
  const fmtSig = function (r) { return r.Ticker + ' ' + r.Action + ' @' + r.Trigger + ' stop ' + r.Stop + ' tgt ' + r.Target + ' size ' + r.Size + ' | RVOL ' + r.RVOL + ' gap ' + (r['Gap %'] === undefined ? '' : r['Gap %']) + '% | score ' + r.Score + (r.Option ? ' | OPTION ' + r.Option : ''); };
  if (mode === 'PRE' && np.m >= 9 * 60 + 15 && once('brief')) {
    const w = shown.filter(function (r) { return r.Action === 'WATCH'; }).slice(0, DAY_CONFIG.alertTopN);
    titleBits.push('watch list');
    lines.push('Tape ' + tape + '. Pre-market movers (real trigger is the 9:35 range):');
    w.forEach(function (r) { lines.push(r.Ticker + ' ' + r.Side + ' gap ' + r['Gap %'] + '% preRVOL ' + r['Pre RVOL'] + (r.Catalyst ? ' [' + r.Catalyst + ']' : '') + ' score ' + r.Score); });
    if (!w.length) lines.push('none');
  }
  if (np.m >= DAY_OPEN_M + DAY_CONFIG.orMinutes) {
    shown.filter(function (r) { return (r.Action === 'BUY' || r.Action === 'SHORT') && !held[r.Ticker]; }).sort(function (a, b) { return b.Score - a.Score; }).slice(0, DAY_CONFIG.alertTopN).forEach(function (r) {
      if (once('sig|' + r.Ticker + '|' + r.Side)) { titleBits.push(r.Action + ' ' + r.Ticker); lines.push(fmtSig(r)); }
    });
    shown.filter(function (r) { return held[r.Ticker]; }).forEach(function (r) {
      if (['STOP', 'TARGET', 'CLOSE'].indexOf(r.Action) >= 0 && once('pos|' + r.Ticker + '|' + r.Action)) { titleBits.push(r.Action + ' ' + r.Ticker); lines.push(r.Ticker + ' ' + r.Action + ': ' + r.Why + ' | P/L $' + (r['P/L $'] === undefined ? '' : r['P/L $'])); }
    });
  }
  if (!lines.length) { props.setProperty('DAY_ALERT_STATE', JSON.stringify(st)); return ''; }
  const r = sendPhoneAlert_(cfg, 'Day: ' + titleBits.slice(0, 4).join(', '), lines.join('\n') + '\nNot advice. Flat by 15:50.', titleBits.some(function (b) { return /STOP|CLOSE|BUY|SHORT/.test(b); }));
  if (!r.ok) { logToSheet_('Day alert failed: ' + r.detail); return 'alert failed (' + r.detail + ')'; }
  props.setProperty('DAY_ALERT_STATE', JSON.stringify(st));
  return 'alert sent (' + lines.length + ' line(s))';
}

/* ============================================================================
 * SCHEDULE TICK
 * ========================================================================== */

// Scan slots for the day (minutes since midnight ET): first scan, then every `everyMin` on the grid up to the last slot.
function daySlots_(closeM, sch) {
  const first = dayMinutes_(sch.firstScanHm), end = Math.min(dayMinutes_(sch.endHm), closeM - 30);
  const out = [first];
  for (let t = Math.ceil((first + 1) / sch.everyMin) * sch.everyMin; t <= end; t += sch.everyMin) out.push(t);
  return out;
}
// The slot that is due now (latest slot <= m, not older than graceMin, newer than the last one done), or null.
function dayDueSlot_(m, slots, lastDoneM, graceMin) {
  let due = null;
  slots.forEach(function (s) { if (s <= m && m - s <= graceMin && s > lastDoneM) due = s; });
  return due;
}

function dayScheduledTick_() {
  const now = new Date(), np = dayNowParts_(now), S = DAY_CONFIG.schedule;
  if (np.dow === '6' || np.dow === '7' || US_MARKET_HOLIDAYS[np.ymd]) return;
  const m = np.m, props = PropertiesService.getScriptProperties();
  if (m < 8 * 60 + 30 || m > np.closeM + 15) return;
  try { alogTick_(false); } catch (e) { logToSheet_('AutoLog update failed: ' + (e && e.message ? e.message : e)); }
  const running = parseInt(props.getProperty('DAY_RUNNING') || '0', 10);
  if (running && Date.now() - running < 8 * 60000) return;
  const last = function (k) { return props.getProperty(k) || ''; };
  const hasHeld = function () {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DAY_SHEET_NAME);
    return sheet ? Object.keys(dayReadHeld_(sheet, dayHeaderMap_(sheet))).length > 0 : false;
  };
  // optional pre-market list (off by default: you asked for 9:30 onward)
  if (S.preMarket && m < DAY_OPEN_M - 5) {
    const lp = last('DAY_LAST_PRE_M');
    const due = !lp || lp.indexOf(np.ymd) !== 0 || (m - parseInt(lp.split(' ')[1], 10) >= 25) || (m >= 9 * 60 + 15 && lp.split(' ')[2] !== 'B');
    if (!due) return;
    dayRun_('PRE', { quiet: true });
    props.setProperty('DAY_LAST_PRE_M', np.ymd + ' ' + m + (m >= 9 * 60 + 15 ? ' B' : ''));
    return;
  }
  // scan slots
  const ls = last('DAY_LAST_SLOT'), lastDone = ls.indexOf(np.ymd) === 0 ? parseInt(ls.split(' ')[1], 10) : -1;
  const slot = dayDueSlot_(m, daySlots_(np.closeM, S), lastDone, S.graceMin);
  if (slot != null) {
    props.setProperty('DAY_LAST_SLOT', np.ymd + ' ' + slot);                // claimed first so an overlapping tick cannot run it twice
    if (last('DAY_LAST_FULL').indexOf(np.ymd) !== 0) { dayRun_('FULL', { quiet: true }); return; }
    let short = {}; try { short = JSON.parse(props.getProperty('DAY_SHORT') || '{}'); } catch (e) { short = {}; }
    const held = hasHeld();
    if (m > dayMinutes_(DAY_CONFIG.entryCutoff) && !held) return;          // past the entry cutoff with nothing open: nothing to do
    if (!held && (!short.list || !short.list.length)) return;
    dayRun_('LIVE', { quiet: true });
    return;
  }
  // one extra check before the close, only if you hold something: it carries the CLOSE alert
  const cc = np.closeM - DAY_CONFIG.closeBeforeMin - 5;
  if (S.closeCheck && m >= cc && m < np.closeM && last('DAY_LAST_CLOSECHK') !== np.ymd) {
    props.setProperty('DAY_LAST_CLOSECHK', np.ymd);
    if (hasHeld()) dayRun_('LIVE', { quiet: true });
    return;
  }
  if (S.eodReplay && m >= np.closeM + 5 && last('DAY_LAST_EOD') !== np.ymd) dayEod_({ quiet: true });
}

/* ============================================================================
 * END OF DAY: paper replay of the day's shortlist -> DayLog
 * ========================================================================== */

function dayEodNow_() { dayEod_({}); }
function dayEod_(opts) {
  const ui = opts && opts.quiet ? null : tryGetUi_();
  const props = PropertiesService.getScriptProperties(), np = dayNowParts_(new Date());
  let short = {}; try { short = JSON.parse(props.getProperty('DAY_SHORT') || '{}'); } catch (e) { short = {}; }
  if (short.ymd !== np.ymd || !short.list || !short.list.length) { notify_(ui, 'Day replay', 'No shortlist was saved today (the 9:36 scan did not run), so nothing to replay.'); props.setProperty('DAY_LAST_EOD', np.ymd); return; }
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let log = ss.getSheetByName(DAY_LOG_SHEET);
  if (!log) { log = ss.insertSheet(DAY_LOG_SHEET); log.getRange(1, 1, 1, 13).setValues([['Date', 'Ticker', 'Side', 'Score', 'RVOL', 'Gap %', 'Trigger', 'Entry', 'Exit', 'Reason', 'R', 'MFE R', 'PnL %']]).setFontWeight('bold'); log.setFrozenRows(1); }
  const existing = {}; if (log.getLastRow() > 1) log.getRange(2, 1, log.getLastRow() - 1, 2).getValues().forEach(function (r) { existing[String(r[0]).slice(0, 10) + '|' + r[1]] = 1; });
  const out = [], lines = [];
  short.list.forEach(function (s) {
    if (existing[np.ymd + '|' + s.t]) return;
    const bars = dayFetchBars_(s.t, false);
    if (!bars) return;
    const reg = bars.filter(function (b) { return b.ymd === np.ymd && b.m >= DAY_OPEN_M && b.m < DAY_CLOSE_M; });
    if (reg.length < 20) return;
    const rp = dayReplay_(reg, { side: s.side, trigger: s.trigger, R: s.R }, DAY_CONFIG);
    out.push([np.ymd, s.t, s.side, s.score, s.rvol, s.gap, s.trigger, rp.taken ? dayR2_(rp.entry) : '', rp.taken ? dayR2_(rp.exit) : '', rp.taken ? rp.reason : 'NO ENTRY', rp.taken ? dayR2_(rp.r) : '', rp.taken ? dayR2_(rp.mfeR) : '', rp.taken ? dayR2_(rp.pnlPct) : '']);
    if (rp.taken) lines.push(s.t + ' ' + s.side + ' ' + dayR2_(rp.r) + 'R (' + rp.reason + ')');
    Utilities.sleep(DAY_CONFIG.sleepMs);
  });
  if (out.length) log.getRange(log.getLastRow() + 1, 1, out.length, 13).setValues(out);
  props.setProperty('DAY_LAST_EOD', np.ymd);
  const taken = out.filter(function (r) { return r[9] !== 'NO ENTRY'; });
  const avgR = taken.length ? dayMean_(taken.map(function (r) { return Number(r[10]); })) : null;
  const msg = 'Paper replay: ' + taken.length + ' of ' + out.length + ' shortlisted signals triggered; average ' + (avgR == null ? 'n/a' : dayR2_(avgR) + 'R') + '.\n' + lines.slice(0, 12).join('\n');
  logToSheet_('Day replay ' + msg.replace(/\n/g, ' | '));
  notify_(ui, 'Day replay', msg);
  const cfg = getAlertConfig_();
  if (cfg.ready && out.length && opts && opts.quiet) sendPhoneAlert_(cfg, 'Day paper replay', msg, false);
}

function dayShowStats_() {
  const log = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(DAY_LOG_SHEET);
  if (!log || log.getLastRow() < 2) { notify_(tryGetUi_(), 'Day stats', 'No paper results yet. They appear after the first trading day with the schedule on (16:05 replay).'); return; }
  const rows = log.getRange(2, 1, log.getLastRow() - 1, 13).getValues().map(function (r) { return { taken: r[9] !== 'NO ENTRY' && r[10] !== '', score: Number(r[3]), r: Number(r[10]) }; });
  const s = dayStats_(rows);
  if (!s.n) { notify_(tryGetUi_(), 'Day stats', 'No triggered signals yet.'); return; }
  const p = function (v) { return v == null ? 'n/a' : Math.round(v * 100) + '%'; };
  const b = function (x) { return x.n + ' trades, avg ' + (x.avgR == null ? 'n/a' : dayR2_(x.avgR) + 'R') + ', win ' + p(x.win); };
  notify_(tryGetUi_(), 'Day stats (paper, after slippage)',
    s.n + ' triggered signals\nWin rate ' + p(s.win) + '   Avg R ' + dayR2_(s.avgR) + '   Avg win ' + dayR2_(s.avgWinR) + 'R   Avg loss ' + dayR2_(s.avgLossR) + 'R\n\nBy score:\n  under 50: ' + b(s.b0) + '\n  50-65: ' + b(s.b50) + '\n  65+: ' + b(s.b65) +
    '\n\nRule of thumb: do not risk real money until there are 30+ triggered signals and the average R is clearly above zero.');
}

/* ============================================================================
 * DEBUG
 * ========================================================================== */

function dayScanNow_() {
  const np = dayNowParts_(new Date());
  const mode = np.m < DAY_OPEN_M ? 'PRE' : (np.m < DAY_OPEN_M + DAY_CONFIG.orMinutes + 1 ? 'PRE' : 'FULL');
  dayRun_(mode, { alert: false });
}

function debugDayOneTicker() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Day debug', 'Ticker:', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = r.getResponseText().trim().toUpperCase(), now = new Date(), np = dayNowParts_(now), lines = [];
  const token = getTastyTradeAccessToken_();
  lines.push('TastyTrade token: ' + (token ? 'ok' : 'MISSING'));
  const bars = dayFetchBars_(t, true);
  lines.push('Yahoo 5-minute bars (1 month, with pre/post): ' + (bars ? bars.length + ' bars, latest ' + bars[bars.length - 1].ymd + ' ' + dayHm_(bars[bars.length - 1].m) + ' ET' : 'FAILED'));
  if (!bars) { ui.alert('Day debug: ' + t, lines.join('\n'), ui.ButtonSet.OK); return; }
  const base = dayBaseline_(bars, np.ymd, DAY_CONFIG.orMinutes);
  lines.push(base ? 'Baseline: prev close ' + dayR2_(base.prevClose) + ', ATR14 $' + dayR2_(base.atr) + ', avg volume ' + Math.round(base.avgVol) + ', avg opening-5-min volume ' + Math.round(base.baseOrVol) + ' (' + base.sessions + ' sessions)' : 'Baseline: not enough sessions');
  const td = dayToday_(bars, np.ymd, np.m, DAY_CONFIG.orMinutes, base);
  lines.push('Today: ' + td.n + ' bars; gap ' + dayR2_(td.gapPct) + '%; pre-mkt RVOL ' + dayR2_(td.preRvol) + '; opening range ' + (td.orDone ? dayR2_(td.orL) + ' - ' + dayR2_(td.orH) + ' RVOL ' + dayR2_(td.rvol) : 'not complete') + '; VWAP ' + dayR2_(td.vwap));
  const q = dayQuotes_([t], token)[t];
  lines.push('TastyTrade quote: ' + (q ? dayR2_(q.price) + ' (bid ' + q.bid + ' ask ' + q.ask + ')' : 'none (using last Yahoo bar)'));
  if (base) {
    const price = q ? q.price : td.last;
    const sg = daySignal_(base, td, price, np.m, DAY_CONFIG, 'FLAT', '');
    lines.push('Signal: ' + sg.state + (sg.side ? ' ' + sg.side : '') + ' score ' + dayR2_(sg.score) + (sg.trigger != null ? ' trigger ' + dayR2_(sg.trigger) : '') + (sg.stop != null ? ' stop ' + dayR2_(sg.stop) : '') + '\nWhy: ' + sg.why);
  }
  ui.alert('Day debug: ' + t, lines.join('\n'), ui.ButtonSet.OK);
}