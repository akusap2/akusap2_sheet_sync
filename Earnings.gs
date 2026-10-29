/* ============================================================================
 * Earnings.gs  —  the "Earnings" tab: which upcoming earnings are worth playing, and HOW
 * ----------------------------------------------------------------------------
 * Apps Script only (no Cloud Function redeploy). Separate from Quick / Leap / CSP / Flip / Long: own tab, own cache sheet
 * (EarnCache), own menu, own schedule. Shares only helpers from momentum.gs / ResearchEngine.gs and the Tasty / Finnhub / Yahoo
 * rate limits.
 *
 * WHAT IT DOES (every scan, rebuilt from scratch):
 *   1. Earnings calendar (Finnhub, next 7 days) filtered to YOUR universe (Research / CSP / Flip / Long lists + your tabs + extras).
 *   2. For each name: spot, the option chain, the first expiry that contains the reaction day, and the ATM straddle.
 *      IMPLIED MOVE % = ATM call mid + put mid, divided by spot  (the market's expected absolute move).
 *   3. The stock's own last ~12 earnings moves (reaction-day close-to-close) from price history.
 *   4. Every candidate structure is back-tested on those past moves, NET of bid/ask costs, and shrunk toward zero when the sample
 *      is small. A play is recommended only if the best one still shows a positive edge. Otherwise: PASS.
 *
 * STRUCTURES CONSIDERED (defined risk only unless EARN_CONFIG.allowUndefinedRisk is switched on):
 *   LONG STRADDLE   buy ATM call + put. Wins when the move is bigger than the options charge for.
 *   IRON CONDOR     sell a put spread and a call spread outside the implied move. Wins when the stock stays inside.
 *   PUT CREDIT SPREAD / CALL CREDIT SPREAD   one side of the condor (when only one side has an edge).
 *   CALENDAR        sell the front straddle, buy the next expiry's. Rule-based (front IV rich vs back IV); NOT back-tested.
 *
 * EVIDENCE USED (see the project doc earnings_tab_proposal for sources and caveats):
 *   - Gao / Xing / Zhang (JFQA): 1996-2010 ATM straddles earned positive returns around earnings; the best predictor was
 *     historical move larger than implied move. Costs matter: the effect shrinks with full quoted spreads.
 *   - Vendor data 2023-26 (EarningsWatcher, 28.9k reports): realized close move averaged ~69% of implied overall, but ~86% for
 *     large caps and ~98% for the AI group, and 25-36% of reports still closed beyond the implied move. Averages hide the tails.
 *   So: no structure is assumed to have an edge. Each name must show one in its own history, after costs, or the answer is PASS.
 *
 * NOT FINANCIAL ADVICE. Back-tests on ~12 events are thin; the tails are what hurt premium sellers.
 * ========================================================================== */

const EARN_SHEET_NAME = 'Earnings';
const EARN_CACHE_SHEET = 'EarnCache';
const EARN_TICK_FN = 'earnScheduledTick_';

const EARN_CONFIG = {
  lookaheadDays: 14,             // earnings within this many calendar days
  maxNames: 45,                  // per scan, nearest report first
  timeBudgetMs: 4.5 * 60 * 1000,
  sleepMs: 80,
  maxFrontDays: 14,              // the front expiry must be within this many days after the reaction day
  hist: { years: 3, max: 12, min: 6, cacheDays: 30, shrinkK: 6 },
  liq: { maxAtmSpreadPct: 10, minAtmOi: 300, assumedSpreadPct: 8 },
  roundTripCostFactor: 0.75,     // share of the summed quoted leg spreads paid over entry + exit
  condor: { shortMult: 1.15, minCreditToWidth: 0.15, maxBreach: 0.2, widthMoveFrac: 0.35 },
  minEdgePct: 8,                 // shrunk historical EV, % of capital at risk, needed to recommend
  calendar: { minSlope: 1.25, minRatio: 0.85, maxRatio: 1.25, minBackGapDays: 7 },
  allowUndefinedRisk: false,     // true would allow short straddle / strangle; off by default (a tail can cost many times the credit)
  schedule: { hhmm: '14:30' },   // once a day, ET: late enough that entry-day quotes are live, early enough to place the order before the close
  alertMaxPlays: 6
};

// Columns A-F match the Flip tab: Ticker | Price | Change | Entry Date | Entry (header = your total-cost formula) | Qty.
// You type Ticker / Entry Date / Entry / Qty for a play you took; the scan never overwrites them (see earnReadHeld_).
const EARN_FIXED_COLS = 6;
const EARN_ENTRY_FORMULA = '=sumproduct(E2:E92,F2:F92)*100';
const EARN_HEADERS = ['Ticker', 'Price', 'Change', 'Entry Date', 'Entry', 'Qty', 'Action', 'Strategy', 'Earnings', 'Timing', 'Days', 'Expiry', 'Legs', 'Net / share',
  'Max Loss $', 'Max Gain $', 'Breakevens', 'Implied Move %', 'Hist Avg Move %', 'Hist / Implied', 'Hist Win %', 'Hist EV %',
  'Events', 'IV Rank', 'Term Slope', 'Spread %', 'ATM OI', 'Score', 'Plan', 'Why', 'LastRun', 'History Src', 'SortKey'];

/* ============================================================================
 * PURE MATH (no Apps Script services: unit-tested offline)
 * ========================================================================== */

function earnClamp_(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function earnRound_(v, d) { if (v == null || isNaN(v)) return ''; const p = Math.pow(10, d == null ? 2 : d); return Math.round(v * p) / p; }
function earnMean_(a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }

// Signed reaction-day moves (%) from daily bars and event dates.
// bars: [{ ymd, close }] ascending. events: [{ ymd, hour }] hour 'bmo' | 'amc' | '' (unknown -> two-day window, slightly overstated).
function earnMovesFromBars_(bars, events) {
  const idx = {};
  bars.forEach(function (b, i) { idx[b.ymd] = i; });
  const out = [];
  events.forEach(function (e) {
    let i = idx[e.ymd];
    if (i == null) {
      // report date was a non-trading day in the data: take the next bar on or after it
      for (let k = 0; k < bars.length; k++) { if (bars[k].ymd >= e.ymd) { i = k; break; } }
      if (i == null) return;
    }
    let a, b;
    if (e.hour === 'bmo') { a = i - 1; b = i; }
    else if (e.hour === 'amc') { a = i; b = i + 1; }
    else { a = i - 1; b = i + 1; }
    if (a < 0 || b >= bars.length || !(bars[a].close > 0) || !(bars[b].close > 0)) return;
    const m = (bars[b].close / bars[a].close - 1) * 100;
    if (isFinite(m)) out.push({ ymd: e.ymd, move: m });
  });
  return out;
}

// Long ATM straddle held over the report. debitPct and costPct are % of spot. Value at exit = intrinsic only (conservative).
function earnStraddleStats_(moves, debitPct, costPct) {
  const risk = debitPct + costPct;
  if (!(risk > 0) || !moves.length) return null;
  const pl = moves.map(function (m) { return Math.abs(m) - risk; });        // % of spot
  const ev = earnMean_(pl) / risk * 100;                                    // % of capital at risk
  const win = pl.filter(function (x) { return x > 0; }).length / pl.length;
  return { ev: ev, win: win, riskPct: risk, n: moves.length };
}

// Short condor (both sides) or one side. dC, dP: short-strike distance % of spot. w: width % of spot. creditPct: NET credit after costs.
function earnCreditStats_(moves, side, dC, dP, w, creditPct) {
  const risk = w - creditPct;
  if (!(risk > 0) || !(creditPct > 0) || !moves.length) return null;
  const pl = moves.map(function (m) {
    const callLoss = side === 'put' ? 0 : earnClamp_(m - dC, 0, w);
    const putLoss = side === 'call' ? 0 : earnClamp_(-m - dP, 0, w);
    return creditPct - callLoss - putLoss;
  });
  const ev = earnMean_(pl) / risk * 100;
  const win = pl.filter(function (x) { return x > 0; }).length / pl.length;
  const breach = moves.filter(function (m) { return (side !== 'put' && m > dC) || (side !== 'call' && -m > dP); }).length / moves.length;
  return { ev: ev, win: win, breach: breach, riskPct: risk, n: moves.length };
}

function earnShrink_(ev, n, k) { return ev * n / (n + k); }

function earnNextTradingDay_(ymd, holidays) {
  const d = new Date(ymd + 'T12:00:00Z');
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    const s = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !(holidays && holidays[s])) return s;
  }
  return ymd;
}
function earnPrevTradingDay_(ymd, holidays) {
  const d = new Date(ymd + 'T12:00:00Z');
  for (let i = 0; i < 10; i++) {
    d.setUTCDate(d.getUTCDate() - 1);
    const dow = d.getUTCDay();
    const s = d.toISOString().slice(0, 10);
    if (dow !== 0 && dow !== 6 && !(holidays && holidays[s])) return s;
  }
  return ymd;
}
function earnDaysBetween_(a, b) { return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000); }

// Index-based strike helpers over an ascending strike list.
function earnNearestIdx_(strikes, x) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < strikes.length; i++) { const d = Math.abs(strikes[i] - x); if (d < bd) { bd = d; best = i; } }
  return best;
}
// Short strikes outside +/- dist, long strikes at least `width` further out. Returns null if the chain is too thin.
function earnPickWings_(strikes, spot, distDollar, widthDollar) {
  let sc = -1, sp = -1;
  for (let i = 0; i < strikes.length; i++) { if (strikes[i] >= spot + distDollar) { sc = i; break; } }
  for (let i = strikes.length - 1; i >= 0; i--) { if (strikes[i] <= spot - distDollar) { sp = i; break; } }
  if (sc < 0 || sp < 0) return null;
  let lc = -1, lp = -1;
  for (let i = sc + 1; i < strikes.length; i++) { if (strikes[i] - strikes[sc] >= widthDollar * 0.9) { lc = i; break; } }
  for (let i = sp - 1; i >= 0; i--) { if (strikes[sp] - strikes[i] >= widthDollar * 0.9) { lp = i; break; } }
  if (lc < 0 || lp < 0) return null;
  return { shortCall: strikes[sc], longCall: strikes[lc], shortPut: strikes[sp], longPut: strikes[lp] };
}

/* ============================================================================
 * STRATEGY CHOICE (pure): given measured inputs, return the recommendation or a PASS reason
 * m = { moves[], imPct, straddle: {debitPct, costPct}, condor: {...}|null, putSpread, callSpread, slope, ratio }
 * ========================================================================== */
function earnChooseStrategy_(m, cfg) {
  const n = m.moves.length;
  if (n < cfg.hist.min) return { pass: true, why: 'only ' + n + ' past earnings moves found (need ' + cfg.hist.min + '): cannot size an edge' };
  const cands = [];
  const add = function (name, st, extra) {
    if (!st) return;
    const sh = earnShrink_(st.ev, n, cfg.hist.shrinkK);
    cands.push({ name: name, ev: st.ev, sev: sh, win: st.win, breach: st.breach, extra: extra || {} });
  };
  if (m.straddle) add('LONG STRADDLE', earnStraddleStats_(m.moves, m.straddle.debitPct, m.straddle.costPct));
  if (m.condor) {
    const s = earnCreditStats_(m.moves, 'both', m.condor.dC, m.condor.dP, m.condor.w, m.condor.creditPct);
    if (s && s.breach <= cfg.condor.maxBreach) add('IRON CONDOR', s);
  }
  if (m.putSpread) {
    const s = earnCreditStats_(m.moves, 'put', m.putSpread.dC, m.putSpread.dP, m.putSpread.w, m.putSpread.creditPct);
    if (s && s.breach <= cfg.condor.maxBreach * 0.75) add('PUT CREDIT SPREAD', s);
  }
  if (m.callSpread) {
    const s = earnCreditStats_(m.moves, 'call', m.callSpread.dC, m.callSpread.dP, m.callSpread.w, m.callSpread.creditPct);
    if (s && s.breach <= cfg.condor.maxBreach * 0.75) add('CALL CREDIT SPREAD', s);
  }
  cands.sort(function (a, b) { return b.sev - a.sev; });
  if (cands.length && cands[0].sev >= cfg.minEdgePct) return { pass: false, best: cands[0], all: cands };
  // Calendar: rule-based, only when the event premium in the front month is rich versus the back month and the move is priced fairly.
  const c = cfg.calendar;
  if (m.calendar && m.slope != null && m.slope >= c.minSlope && m.ratio != null && m.ratio >= c.minRatio && m.ratio <= c.maxRatio) {
    return { pass: false, calendar: true, all: cands };
  }
  const top = cands.length ? cands[0] : null;
  return { pass: true, all: cands,
    why: 'no structure clears the edge bar after costs' + (top ? ' (best: ' + top.name + ' ' + earnRound_(top.sev, 0) + '% shrunk EV, needs ' + cfg.minEdgePct + '%)' : '') };
}

/* ============================================================================
 * SETUP / MENU / SCHEDULE
 * ========================================================================== */

function setupEarnings() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(EARN_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(EARN_SHEET_NAME);
  earnWriteHeaders_(sheet);
  const has = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'earnAddMenu_'; });
  if (!has) ScriptApp.newTrigger('earnAddMenu_').forSpreadsheet(ss).onOpen().create();
  try { earnAddMenu_(); } catch (e) { /* menu appears on next open */ }
  notify_(tryGetUi_(), 'Earnings set up',
    'Created the Earnings tab. Menu "📅 Earnings" appears after you reload the sheet.\n\nNext:\n' +
    '  1. 📅 Earnings > Debug One Ticker (try NVDA, AAPL or any name reporting soon): shows which history source works\n' +
    '  2. 📅 Earnings > Run Earnings Scan\n  3. 📅 Earnings > Start Schedule (once a day + phone alert)');
}

// Old installable on-open trigger target: the menu is built by onOpen -> mixedAddMenu_ now. Called by hand (setupEarnings) it rebuilds the Mixed menu.
function earnAddMenu_(e) {
  if (e && e.authMode) return;
  mixedAddMenu_();
}

function earnMenu_() {
  return SpreadsheetApp.getUi()
    .createMenu('📅 Earnings')
    .addItem('Run Earnings Scan', 'runEarningsScan')
    .addItem('Run Scan + Send Phone Alert', 'earnScanAndAlert_')
    .addItem('Add Extra Tickers…', 'earnAddExtraTickers_')
    .addSeparator()
    .addItem('▶ Start Schedule (daily + phone alert)', 'startEarnSchedule_')
    .addItem('■ Stop Schedule', 'stopEarnSchedule_')
    .addItem('Schedule Status', 'earnScheduleStatus_')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🔍 Earnings Debug')
      .addItem('One Ticker (full trail)', 'debugEarnOneTicker')
      .addItem('Clear History Cache', 'earnClearCache_'))
    ;
}

// Headers are written ONCE, on an empty sheet. After that your layout rules: delete a column, move columns, add your own, and the scan
// follows the header labels on row 1. It never re-adds a deleted column or puts one back in the old order.
function earnWriteHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  if (sheet.getRange(1, 1, 1, lastCol).getValues()[0].some(function (v) { return String(v || '').trim() !== ''; })) return;
  const n = EARN_HEADERS.length;
  const rng = sheet.getRange(1, 1, 1, n);
  EARN_HEADERS.forEach(function (h, i) { if (i !== 4) sheet.getRange(1, i + 1).setValue(h); });
  const e1 = sheet.getRange(1, 5);
  e1.setFormula(EARN_ENTRY_FORMULA);
  // Same look as Flip: tiny bold wrapped headers, orange = columns you type in, green = script-written, big green total over Entry.
  rng.setFontWeight('bold').setFontSize(6).setWrap(true).setBackground('#d9ead3');
  [1, 4, 6].forEach(function (c) { sheet.getRange(1, c).setBackground('#fff2cc'); });
  e1.setBackground('#00ff00').setFontSize(9).setHorizontalAlignment('center').setNumberFormat('0');
  sheet.getRange(1, 2, 1, 2).setHorizontalAlignment('center');
  sheet.getRange(1, 6).setHorizontalAlignment('center');
  [59, 51, 58, 55, 58, 38, 70].forEach(function (w, i) { sheet.setColumnWidth(i + 1, w); });
  sheet.setRowHeight(1, 29);
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
}

// label -> 1-based column, from row 1 as it is NOW. The header over Entry holds your formula, so it is found by =sumproduct(.
function earnHeaderMap_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const rng = sheet.getRange(1, 1, 1, lastCol);
  const vals = rng.getValues()[0], forms = rng.getFormulas()[0];
  const known = {};
  EARN_HEADERS.forEach(function (h) { known[h] = true; });
  const map = {};
  vals.forEach(function (v, i) {
    const k = String(v == null ? '' : v).trim();
    if (known[k] && k !== 'Entry' && !map[k]) map[k] = i + 1;
    if (!map.Entry && /^=\s*sumproduct\s*\(/i.test(forms[i] || '')) map.Entry = i + 1;
  });
  if (!map.Entry) vals.forEach(function (v, i) { if (!map.Entry && String(v).trim() === 'Entry') map.Entry = i + 1; });
  return map;
}

// Rows you hold (Qty typed) -> { TICKER: { entryDate, entry, qty } }. Read right before writing so a cell you just typed is not lost.
function earnReadHeld_(sheet, map) {
  const held = {};
  map = map || earnHeaderMap_(sheet);
  const n = sheet.getLastRow() - 1;
  if (n < 1 || !map.Ticker || !map.Qty) return held;
  const cols = [map.Ticker, map.Qty, map['Entry Date'], map.Entry];
  const top = Math.max.apply(null, cols.filter(Boolean));
  const data = sheet.getRange(2, 1, n, top).getValues();
  data.forEach(function (r) {
    const t = String(r[map.Ticker - 1] || '').trim().toUpperCase();
    const qty = Number(r[map.Qty - 1]);
    if (t && qty > 0 && !held[t]) held[t] = { entryDate: map['Entry Date'] ? r[map['Entry Date'] - 1] : '', entry: map.Entry ? r[map.Entry - 1] : '', qty: r[map.Qty - 1] };
  });
  return held;
}

function earnScanAndAlert_() { runEarningsScan(null, { alert: true }); }

function earnAddExtraTickers_() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const cur = props.getProperty('EARN_EXTRA') || '';
  const r = ui.prompt('Extra tickers for the Earnings scan', 'Comma-separated, added to the built-in universe (replaces the old extra list).\nCurrent: ' + (cur || '(none)'), ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const list = r.getResponseText().toUpperCase().split(/[\s,;]+/).filter(function (x) { return /^[A-Z.\-]{1,6}$/.test(x); });
  props.setProperty('EARN_EXTRA', list.join(','));
  notify_(ui, 'Earnings', 'Extra tickers saved: ' + (list.join(', ') || '(none)'));
}

function earnRemoveTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === EARN_TICK_FN) { ScriptApp.deleteTrigger(t); n++; } });
  return n;
}
function startEarnSchedule_() {
  earnRemoveTriggers_();
  ScriptApp.newTrigger(EARN_TICK_FN).timeBased().everyHours(1).create();
  notify_(tryGetUi_(), 'Earnings schedule started',
    'Hourly trigger; it scans ONCE per weekday (first tick after ' + EARN_CONFIG.schedule.hhmm + ' ET) and sends the result to your phone alert (Telegram) if phone alerts are set up and on.');
}
function stopEarnSchedule_() { notify_(tryGetUi_(), 'Earnings schedule', 'Stopped (' + earnRemoveTriggers_() + ' trigger(s) removed).'); }
function earnScheduleStatus_() {
  const props = PropertiesService.getScriptProperties();
  const n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === EARN_TICK_FN; }).length;
  notify_(tryGetUi_(), 'Earnings schedule status', 'Schedule: ' + (n ? 'ON' : 'OFF') + ' (daily after ' + EARN_CONFIG.schedule.hhmm + ' ET)\nLast daily scan: ' + (props.getProperty('EARN_LAST') || 'never') +
    '\nPhone alerts ready: ' + (getAlertConfig_().ready ? 'yes (' + getAlertConfig_().provider + ')' : 'NO (menu: Quick and Leap > Phone Alerts)'));
}
function earnScheduledTick_() {
  const now = new Date();
  const dow = Utilities.formatDate(now, 'America/New_York', 'u');
  if (dow === '6' || dow === '7') return;
  const ymd = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
  if (US_MARKET_HOLIDAYS[ymd]) return;
  const hm = Utilities.formatDate(now, 'America/New_York', 'HH:mm');
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('EARN_RUNNING') || '0', 10);
  if (running && Date.now() - running < 10 * 60000) return;
  if (hm < EARN_CONFIG.schedule.hhmm || hm >= '16:00' || props.getProperty('EARN_LAST') === ymd) return;
  const r = runEarningsScan(null, { quiet: true, alert: true });
  if (r && !r.timedOut) props.setProperty('EARN_LAST', ymd);
}

// One compact message: what to do today, what is coming, what to close. Returns a status string.
function earnSendAlert_(rows, todayYmd) {
  const cfg = getAlertConfig_();
  if (!cfg.ready) return 'phone alerts not set up or off (menu: Quick and Leap > Phone Alerts)';
  const by = function (a) { return rows.filter(function (r) { return r.Action === a; }); };
  const play = function (r) {
    return r.Ticker + ' ' + r.Strategy + ' ' + r.Legs + ' | ' + (r['Net / share'] ? 'net ' + r['Net / share'] : '') + ' | max loss $' + r['Max Loss $'] +
      ' | implied ' + r['Implied Move %'] + '% vs hist ' + r['Hist Avg Move %'] + '% | ' + r.Timing + ' ' + r.Earnings + ' | score ' + r.Score;
  };
  const today = by('ENTER TODAY').slice(0, EARN_CONFIG.alertMaxPlays), later = by('LATER'), close = by('CLOSE'), held = by('HELD');
  const lines = [];
  if (close.length) lines.push('CLOSE AT THE OPEN: ' + close.map(function (r) { return r.Ticker; }).join(', '));
  if (today.length) { lines.push('ENTER TODAY (last hour, limit near mid):'); today.forEach(function (r) { lines.push(play(r)); }); }
  else lines.push('No earnings play to enter today.');
  if (later.length) lines.push('Coming up: ' + later.slice(0, 8).map(function (r) { return r.Ticker + ' ' + r.Strategy.replace(' CREDIT SPREAD', ' CS').replace('IRON CONDOR', 'IC').replace('LONG STRADDLE', 'STRADDLE') + ' (' + r.Earnings + ')'; }).join(', '));
  if (held.length) lines.push('Holding through earnings: ' + held.map(function (r) { return r.Ticker; }).join(', '));
  lines.push(by('PASS').length + ' passed, ' + by('SKIP').length + ' skipped. Not advice: size small.');
  const res = sendPhoneAlert_(cfg, 'Earnings ' + todayYmd + ': ' + today.length + ' to enter' + (close.length ? ', ' + close.length + ' to close' : ''), lines.join('\n'), today.length + close.length > 0);
  if (!res.ok) { logToSheet_('Earnings alert failed: ' + res.detail); return 'send failed (' + res.detail + ')'; }
  return 'sent';
}

/* ============================================================================
 * DATA: universe, calendar, history, quotes
 * ========================================================================== */

function earnUniverse_() {
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
      let c = hdr.indexOf('Ticker');
      if (c < 0) c = 0;
      add(sh.getRange(2, c + 1, sh.getLastRow() - 1, 1).getValues().map(function (r) { return r[0]; }));
    } catch (e) { /* skip tab */ }
  });
  add((PropertiesService.getScriptProperties().getProperty('EARN_EXTRA') || '').split(','));
  return set;
}

// Finnhub calendar for the window -> [{ symbol, ymd, hour, epsEst }]
function earnFetchCalendar_(fromYmd, toYmd) {
  const key = getFinnhubApiKey_();
  if (!key) return null;
  const url = FINNHUB_BASE_URL + '/calendar/earnings?from=' + fromYmd + '&to=' + toYmd + '&token=' + encodeURIComponent(key);
  const resp = fetchWithRetry_(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } }, 2, 800);
  if (resp.getResponseCode() !== 200) { logToSheet_('Earnings: Finnhub calendar HTTP ' + resp.getResponseCode()); return null; }
  const arr = (JSON.parse(resp.getContentText()).earningsCalendar) || [];
  return arr.filter(function (e) { return e.symbol && e.date; }).map(function (e) {
    return { symbol: String(e.symbol).toUpperCase(), ymd: e.date, hour: e.hour === 'bmo' || e.hour === 'amc' ? e.hour : '', epsEst: e.epsEstimate };
  });
}

// Past report dates for one ticker. Tries Finnhub, then FMP, then Yahoo. Returns { events: [{ymd, hour}], src } (src '' if none).
function earnFetchPastEvents_(ticker, todayYmd, bars) {
  const H = EARN_CONFIG.hist;
  const from = Utilities.formatDate(new Date(Date.now() - (H.years * 366 + 10) * 86400000), 'America/New_York', 'yyyy-MM-dd');
  const out = { events: [], src: '' };
  const ok = function (ev, src) {
    ev = ev.filter(function (e) { return e.ymd && e.ymd < todayYmd; });
    if (ev.length >= H.min && ev.length > out.events.length) { out.events = ev; out.src = src; }
    return out.events.length >= H.min;
  };
  try {
    const fk = getFinnhubApiKey_();
    if (fk) {
      const resp = fetchWithRetry_(FINNHUB_BASE_URL + '/calendar/earnings?from=' + from + '&to=' + todayYmd + '&symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(fk),
        { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } }, 2, 800);
      if (resp.getResponseCode() === 200) {
        const arr = (JSON.parse(resp.getContentText()).earningsCalendar) || [];
        if (ok(arr.filter(function (e) { return String(e.symbol || ticker).toUpperCase() === ticker; })
          .map(function (e) { return { ymd: e.date, hour: e.hour === 'bmo' || e.hour === 'amc' ? e.hour : '' }; }), 'Finnhub')) return out;
      }
    }
  } catch (e) { Logger.log('earn hist finnhub ' + ticker + ': ' + e); }
  try {
    const mk = getFmpApiKey_();
    if (mk) {
      const resp = UrlFetchApp.fetch('https://financialmodelingprep.com/stable/earnings?symbol=' + encodeURIComponent(ticker) + '&limit=' + (H.years * 4 + 4) + '&apikey=' + encodeURIComponent(mk), { muteHttpExceptions: true });
      if (resp.getResponseCode() === 200) {
        const arr = JSON.parse(resp.getContentText());
        if (Array.isArray(arr) && ok(arr.filter(function (e) { return e.date && e.epsActual != null; }).map(function (e) { return { ymd: String(e.date).slice(0, 10), hour: '' }; }), 'FMP')) return out;
      }
    }
  } catch (e) { Logger.log('earn hist fmp ' + ticker + ': ' + e); }
  try {
    if (bars && bars.earnTs && bars.earnTs.length) {
      const ev = bars.earnTs.map(function (ts) { return { ymd: Utilities.formatDate(new Date(ts * 1000), 'America/New_York', 'yyyy-MM-dd'), hour: '' }; });
      if (ok(ev, 'Yahoo')) return out;
    }
  } catch (e) { Logger.log('earn hist yahoo ' + ticker + ': ' + e); }
  return out;
}

// Daily bars with dates from Yahoo (also returns Yahoo's own earnings event timestamps when it has them).
function earnFetchBars_(ticker, years) {
  const range = years >= 3 ? '3y' : (years >= 2 ? '2y' : '1y');
  const hosts = ['query1', 'query2'];
  for (let h = 0; h < hosts.length; h++) {
    try {
      const resp = UrlFetchApp.fetch('https://' + hosts[h] + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=' + range + '&interval=1d&events=div%7Csplit%7Cearn',
        { method: 'get', muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' } });
      if (resp.getResponseCode() !== 200) continue;
      const r = (JSON.parse(resp.getContentText()).chart || {}).result;
      const res = r && r[0];
      if (!res || !res.timestamp || !res.indicators || !res.indicators.quote || !res.indicators.quote[0]) continue;
      const q = res.indicators.quote[0];
      const bars = [];
      for (let i = 0; i < res.timestamp.length; i++) {
        const c = q.close ? q.close[i] : null;
        if (c != null && c > 0) bars.push({ ymd: Utilities.formatDate(new Date(res.timestamp[i] * 1000), 'America/New_York', 'yyyy-MM-dd'), close: c });
      }
      if (bars.length < 60) continue;
      const earn = res.events && res.events.earnings ? Object.keys(res.events.earnings).map(function (k) { return parseInt(k, 10); }).filter(function (x) { return x > 0; }) : [];
      return { bars: bars, earnTs: earn };
    } catch (e) { Logger.log('earn bars ' + ticker + ': ' + e); }
  }
  return null;
}

// Cached history: moves are recomputed at most every cacheDays per ticker (EarnCache sheet: Ticker | UpdatedMs | JSON).
function earnLoadCache_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EARN_CACHE_SHEET);
  if (!sh) { sh = ss.insertSheet(EARN_CACHE_SHEET); sh.getRange(1, 1, 1, 3).setValues([['Ticker', 'UpdatedMs', 'JSON']]); sh.hideSheet(); }
  const map = {};
  const n = sh.getLastRow() - 1;
  if (n > 0) sh.getRange(2, 1, n, 3).getValues().forEach(function (r) {
    if (!r[0]) return;
    try { map[String(r[0]).toUpperCase()] = { t: Number(r[1]) || 0, d: JSON.parse(r[2]) }; } catch (e) { /* skip bad row */ }
  });
  return { sheet: sh, map: map, dirty: {} };
}
function earnFlushCache_(cache) {
  const keys = Object.keys(cache.dirty);
  if (!keys.length) return;
  const all = Object.keys(cache.map).sort().map(function (t) { return [t, cache.map[t].t, JSON.stringify(cache.map[t].d)]; });
  const sh = cache.sheet;
  sh.getRange(2, 1, Math.max(sh.getLastRow() - 1, 1), 3).clearContent();
  if (all.length) sh.getRange(2, 1, all.length, 3).setValues(all);
}
function earnClearCache_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EARN_CACHE_SHEET);
  if (sh && sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 3).clearContent();
  notify_(tryGetUi_(), 'Earnings', 'History cache cleared.');
}

function earnHistory_(ticker, todayYmd, cache, force) {
  const H = EARN_CONFIG.hist;
  const hit = cache.map[ticker];
  if (!force && hit && Date.now() - hit.t < H.cacheDays * 86400000 && hit.d && hit.d.moves) return hit.d;
  const by = earnFetchBars_(ticker, H.years);
  let d = { moves: [], src: '', n: 0 };
  if (by) {
    const pe = earnFetchPastEvents_(ticker, todayYmd, by);
    const mv = earnMovesFromBars_(by.bars, pe.events).slice(-H.max);
    d = { moves: mv.map(function (x) { return earnRound_(x.move, 2); }), dates: mv.map(function (x) { return x.ymd; }), src: pe.src, n: mv.length };
  }
  // A failed lookup is cached only briefly, so a data-source hiccup does not hide a name for a month.
  cache.map[ticker] = { t: d.n >= H.min ? Date.now() : Date.now() - (H.cacheDays - 1) * 86400000, d: d };
  cache.dirty[ticker] = true;
  return d;
}

// Option quotes straight from TastyTrade (market-data/by-type). Returns { OCC: { bid, ask, mark, oi, volume, delta } }.
function earnQuotes_(syms, token) {
  const out = {};
  if (!token || !syms.length) return out;
  for (let i = 0; i < syms.length; i += 40) {
    const chunk = syms.slice(i, i + 40);
    try {
      const url = 'https://api.tastyworks.com/market-data/by-type?' + chunk.map(function (s) { return 'equity-option=' + encodeURIComponent(s); }).join('&');
      const resp = fetchTastyWithRetry_(url, token);
      if (resp.getResponseCode() !== 200) continue;
      const items = ((JSON.parse(resp.getContentText()).data) || {}).items || [];
      items.forEach(function (it) {
        if (!it.symbol) return;
        const f = function (v) { const x = v != null ? parseFloat(v) : NaN; return isNaN(x) ? null : x; };
        const oi = it['open-interest'] != null ? it['open-interest'] : it.openInterest;
        out[it.symbol] = { bid: f(it.bid), ask: f(it.ask), mark: f(it.mark), oi: f(oi), volume: f(it.volume != null ? it.volume : it['day-volume']), delta: f(it.delta) };
      });
    } catch (e) { Logger.log('earn quotes: ' + e); }
    Utilities.sleep(120);
  }
  return out;
}

// Mid and spread of one leg. live=false when only a mark exists (market closed): the spread is then assumed.
function earnLeg_(q, assumedSpreadPct) {
  if (!q) return null;
  if (q.bid > 0 && q.ask > 0 && q.ask >= q.bid) return { mid: (q.bid + q.ask) / 2, spread: q.ask - q.bid, live: true, oi: q.oi, bid: q.bid, ask: q.ask };
  if (q.mark > 0) return { mid: q.mark, spread: q.mark * assumedSpreadPct / 100, live: false, oi: q.oi, bid: null, ask: null };
  return null;
}

function earnIvRanks_(tickers, token) {
  const out = {};
  if (!token) return out;
  const num = function (v) { const x = v != null ? parseFloat(v) : NaN; return isNaN(x) ? null : x; };
  for (let i = 0; i < tickers.length; i += 20) {
    const chunk = tickers.slice(i, i + 20);
    try {
      const resp = fetchTastyWithRetry_('https://api.tastyworks.com/market-metrics?symbols=' + chunk.map(encodeURIComponent).join(','), token);
      if (resp.getResponseCode() !== 200) continue;
      (((JSON.parse(resp.getContentText()).data) || {}).items || []).forEach(function (it) {
        const raw = num(it['implied-volatility-rank']) != null ? num(it['implied-volatility-rank']) : (num(it['implied-volatility-index-rank']) != null ? num(it['implied-volatility-index-rank']) : num(it['implied-volatility-percentile']));
        if (raw == null || !it.symbol) return;
        out[String(it.symbol).toUpperCase()] = raw <= 1 ? raw * 100 : raw;
      });
    } catch (e) { Logger.log('earn ivrank: ' + e); }
  }
  return out;
}

/* ============================================================================
 * ONE NAME
 * ========================================================================== */

function earnFmtMoney_(v) { return v == null || isNaN(v) ? '' : (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2); }
function earnExpiryYmd_(d) { return Utilities.formatDate(d, 'America/New_York', 'yyyy-MM-dd'); }

// ev: { symbol, ymd, hour }. Returns a row object keyed by EARN_HEADERS (plus _debug).
function earnEvaluate_(ev, ctx) {
  const C = EARN_CONFIG, t = ev.symbol;
  const res = { Ticker: t, Earnings: ev.ymd, Timing: ev.hour ? ev.hour.toUpperCase() : 'UNK', LastRun: ctx.now };
  const dbg = {};
  res._debug = dbg;
  res.Days = earnDaysBetween_(ctx.todayYmd, ev.ymd);
  const reactYmd = ev.hour === 'bmo' ? ev.ymd : earnNextTradingDay_(ev.ymd, US_MARKET_HOLIDAYS);
  // Entry: the last session before the reaction. Unknown timing is treated as "could be before the open": enter the day before the report.
  // Entry: the last session before the reaction (after-close report: that same day; otherwise the prior session).
  const entryYmdFinal = ev.hour === 'amc' ? ev.ymd : earnPrevTradingDay_(ev.ymd, US_MARKET_HOLIDAYS);
  res._entry = entryYmdFinal; res._react = reactYmd;

  const fail = function (action, why) { res.Action = action; res.Why = why; res.SortKey = action === 'SKIP' ? 100 : 500; return res; };

  const q = fetchTastyEquityQuote_(t, ctx.token);
  const spot = q && q.price ? q.price : null;
  if (!spot) return fail('SKIP', 'no stock price');
  res.Price = earnRound_(spot, 2);
  if (q.change != null && !isNaN(q.change)) res.Change = earnRound_(q.change, 2);
  dbg.spot = spot;

  const hist = earnHistory_(t, ctx.todayYmd, ctx.cache, false);
  res['History Src'] = hist.src || 'none';
  res.Events = hist.n;
  const moves = hist.moves || [];
  if (moves.length) {
    res['Hist Avg Move %'] = earnRound_(earnMean_(moves.map(Math.abs)), 2);
  }

  const chain = fetchTastyOptionChainNested_(t, ctx.token);
  if (!chain) return fail('SKIP', 'no option chain from TastyTrade');
  const front = chain.filter(function (e) { const y = earnExpiryYmd_(e.date); return y >= reactYmd && earnDaysBetween_(reactYmd, y) <= C.maxFrontDays; })[0];
  if (!front) return fail('SKIP', 'no expiry within ' + C.maxFrontDays + ' days after the report (monthly-only options: not a clean earnings play)');
  const frontYmd = earnExpiryYmd_(front.date);
  res.Expiry = frontYmd;
  const fs = front.strikes.slice().sort(function (a, b) { return a.strike - b.strike; });
  const strikes = fs.map(function (s) { return s.strike; });
  const bySt = {}; fs.forEach(function (s) { bySt[s.strike] = s; });
  const ai = earnNearestIdx_(strikes, spot);
  const atm = fs[ai];
  if (!atm || !atm.callSymbol || !atm.putSymbol) return fail('SKIP', 'no ATM call/put symbols');

  // Back expiry for the calendar test.
  const back = chain.filter(function (e) { return earnDaysBetween_(frontYmd, earnExpiryYmd_(e.date)) >= C.calendar.minBackGapDays; })[0];
  let backAtm = null;
  if (back) {
    const bs = back.strikes.slice().sort(function (a, b) { return a.strike - b.strike; });
    const bi = earnNearestIdx_(bs.map(function (s) { return s.strike; }), atm.strike);
    if (bs[bi] && Math.abs(bs[bi].strike - atm.strike) < 1e-9) backAtm = bs[bi];
  }

  const need = [atm.callSymbol, atm.putSymbol];
  if (backAtm && backAtm.callSymbol && backAtm.putSymbol) need.push(backAtm.callSymbol, backAtm.putSymbol);
  const qm = earnQuotes_(need, ctx.token);
  const aS = C.liq.assumedSpreadPct;
  const lc = earnLeg_(qm[atm.callSymbol], aS), lp = earnLeg_(qm[atm.putSymbol], aS);
  if (!lc || !lp) return fail('SKIP', 'no quote on the ATM options');
  const live = lc.live && lp.live;
  const straddle = lc.mid + lp.mid;
  const imPct = straddle / spot * 100;
  res['Implied Move %'] = earnRound_(imPct, 2);
  const atmSpreadPct = (lc.spread + lp.spread) / straddle * 100;
  res['Spread %'] = earnRound_(atmSpreadPct, 1);
  const oi = Math.min(lc.oi == null ? 0 : lc.oi, lp.oi == null ? 0 : lp.oi);
  res['ATM OI'] = oi;
  res['IV Rank'] = ctx.ivr[t] != null ? earnRound_(ctx.ivr[t], 0) : '';
  const ratio = moves.length ? earnMean_(moves.map(Math.abs)) / imPct : null;
  if (ratio != null) res['Hist / Implied'] = earnRound_(ratio, 2);

  // Term slope: front IV vs back IV, from straddle prices (IV ~ straddle / (0.8 * S * sqrt(T))).
  let slope = null, calendar = null;
  if (backAtm) {
    const bc = earnLeg_(qm[backAtm.callSymbol], aS), bp = earnLeg_(qm[backAtm.putSymbol], aS);
    if (bc && bp) {
      const tF = Math.max(earnDaysBetween_(ctx.todayYmd, frontYmd), 1) / 365, tB = Math.max(earnDaysBetween_(ctx.todayYmd, earnExpiryYmd_(back.date)), 1) / 365;
      const ivF = (lc.mid + lp.mid) / (0.8 * spot * Math.sqrt(tF)), ivB = (bc.mid + bp.mid) / (0.8 * spot * Math.sqrt(tB));
      slope = ivB > 0 ? ivF / ivB : null;
      calendar = { debit: (bc.mid + bp.mid) - (lc.mid + lp.mid), spreads: bc.spread + bp.spread + lc.spread + lp.spread, backExp: earnExpiryYmd_(back.date) };
      if (slope != null) res['Term Slope'] = earnRound_(slope, 2);
    }
  }

  // Liquidity gate.
  if (live && atmSpreadPct > C.liq.maxAtmSpreadPct) return fail('SKIP', 'ATM options too wide (' + earnRound_(atmSpreadPct, 1) + '% > ' + C.liq.maxAtmSpreadPct + '%): costs would eat the edge');
  if (oi < C.liq.minAtmOi) return fail('SKIP', 'thin ATM open interest (' + oi + ' < ' + C.liq.minAtmOi + ')');

  // Structures.
  const cf = C.roundTripCostFactor;
  const strad = { debitPct: straddle / spot * 100, costPct: cf * (lc.spread + lp.spread) / spot * 100 };
  let condor = null, putSp = null, callSp = null, wingInfo = null;
  const dist = spot * imPct / 100 * C.condor.shortMult;
  const wDollar = Math.max(spot * imPct / 100 * C.condor.widthMoveFrac, strikes.length > 1 ? (strikes[Math.min(ai + 1, strikes.length - 1)] - strikes[Math.max(ai - 1, 0)]) / 2 : 1);
  const wing = earnPickWings_(strikes, spot, dist, wDollar);
  if (wing) {
    const syms = [bySt[wing.shortPut].putSymbol, bySt[wing.longPut].putSymbol, bySt[wing.shortCall].callSymbol, bySt[wing.longCall].callSymbol];
    const wq = earnQuotes_(syms, ctx.token);
    const sP = earnLeg_(wq[syms[0]], aS), lP = earnLeg_(wq[syms[1]], aS), sC = earnLeg_(wq[syms[2]], aS), lC = earnLeg_(wq[syms[3]], aS);
    if (sP && lP && sC && lC) {
      const pw = wing.shortPut - wing.longPut, cw = wing.longCall - wing.shortCall;
      const putCr = sP.mid - lP.mid - cf * (sP.spread + lP.spread);
      const callCr = sC.mid - lC.mid - cf * (sC.spread + lC.spread);
      const w = Math.min(pw, cw);
      const dC = (wing.shortCall - spot) / spot * 100, dP = (spot - wing.shortPut) / spot * 100;
      const okCr = function (cr, wd) { return cr > 0 && cr / wd >= C.condor.minCreditToWidth; };
      if (okCr(putCr + callCr, w)) condor = { dC: dC, dP: dP, w: w / spot * 100, creditPct: (putCr + callCr) / spot * 100, credit: putCr + callCr, wd: w };
      if (okCr(putCr, pw)) putSp = { dC: 999, dP: dP, w: pw / spot * 100, creditPct: putCr / spot * 100, credit: putCr, wd: pw };
      if (okCr(callCr, cw)) callSp = { dC: dC, dP: 999, w: cw / spot * 100, creditPct: callCr / spot * 100, credit: callCr, wd: cw };
      wingInfo = { wing: wing, pw: pw, cw: cw, putCr: putCr, callCr: callCr };
    }
  }
  dbg.wing = wingInfo; dbg.slope = slope; dbg.ratio = ratio; dbg.imPct = imPct; dbg.strad = strad;

  const choice = earnChooseStrategy_({ moves: moves, imPct: imPct, straddle: strad, condor: condor, putSpread: putSp, callSpread: callSp, slope: slope, ratio: ratio, calendar: calendar }, C);
  dbg.choice = choice;
  const prefix = live ? '' : 'indicative (market closed, marks only): ';
  const entryTxt = ctx.todayYmd === entryYmdFinal ? 'TODAY' : entryYmdFinal;
  const isToday = ctx.todayYmd === entryYmdFinal;

  if (choice.pass) {
    res.Action = 'PASS'; res.Strategy = '';
    res.Why = prefix + choice.why;
    res.SortKey = 400;
    return res;
  }

  let strat, legs, net, maxLoss, maxGain, be, plan, score, evShown, winShown;
  const exitTxt = 'Close at the open on ' + reactYmd + ' (first 30 minutes, after the IV crush). Do not hold to expiry.';
  if (choice.calendar) {
    strat = 'CALENDAR (straddle)';
    legs = 'SELL ' + atm.strike + 'C + ' + atm.strike + 'P ' + frontYmd + ' / BUY same strikes ' + calendar.backExp;
    net = -calendar.debit; maxLoss = calendar.debit * 100; maxGain = '';
    be = 'near $' + earnRound_(atm.strike, 2);
    plan = 'Enter ' + entryTxt + ' in the last hour before the close at a limit near mid. ' + exitTxt + ' Rule-based (front IV ' + earnRound_(slope, 2) + 'x back IV), not back-tested. A big move loses most of the debit.';
    evShown = ''; winShown = '';
    score = earnClamp_(30 + (slope - C.calendar.minSlope) * 40 + (oi >= 2000 ? 15 : 8), 0, 70);
  } else {
    const b = choice.best;
    strat = b.name;
    evShown = earnRound_(b.sev, 0); winShown = earnRound_(b.win * 100, 0);
    if (b.name === 'LONG STRADDLE') {
      legs = 'BUY ' + atm.strike + 'C + ' + atm.strike + 'P ' + frontYmd;
      net = -straddle; maxLoss = (straddle + cf * (lc.spread + lp.spread)) * 100; maxGain = 'unlimited';
      be = '$' + earnRound_(atm.strike - straddle, 2) + ' / $' + earnRound_(atm.strike + straddle, 2) + ' (needs a move outside)';
      plan = 'Enter ' + entryTxt + ' in the last hour before the close, limit near mid. ' + exitTxt + ' Expect to lose the whole debit more often than not; it pays when the move beats ' + earnRound_(imPct, 1) + '%.';
    } else {
      const w = wingInfo.wing;
      if (b.name === 'IRON CONDOR') {
        legs = 'SELL ' + w.shortPut + 'P / BUY ' + w.longPut + 'P + SELL ' + w.shortCall + 'C / BUY ' + w.longCall + 'C ' + frontYmd;
        net = condor.credit; maxLoss = (condor.wd - condor.credit) * 100; maxGain = condor.credit * 100;
        be = 'stay inside $' + earnRound_(w.shortPut - condor.credit, 2) + ' to $' + earnRound_(w.shortCall + condor.credit, 2);
      } else if (b.name === 'PUT CREDIT SPREAD') {
        legs = 'SELL ' + w.shortPut + 'P / BUY ' + w.longPut + 'P ' + frontYmd;
        net = putSp.credit; maxLoss = (putSp.wd - putSp.credit) * 100; maxGain = putSp.credit * 100;
        be = 'stay above $' + earnRound_(w.shortPut - putSp.credit, 2);
      } else {
        legs = 'SELL ' + w.shortCall + 'C / BUY ' + w.longCall + 'C ' + frontYmd;
        net = callSp.credit; maxLoss = (callSp.wd - callSp.credit) * 100; maxGain = callSp.credit * 100;
        be = 'stay below $' + earnRound_(w.shortCall + callSp.credit, 2);
      }
      plan = 'Enter ' + entryTxt + ' in the last hour before the close, limit at or just under mid (net credit shown is after estimated costs). ' + exitTxt +
        ' Historical breaches of the short strikes: ' + earnRound_(b.breach * 100, 0) + '% of past reports.';
    }
    score = earnClamp_(b.sev * 1.2 + (b.win * 20) + Math.min(moves.length / C.hist.max, 1) * 10 + (oi >= 2000 ? 10 : (oi >= 800 ? 6 : 2)) + (atmSpreadPct <= 4 ? 10 : (atmSpreadPct <= 7 ? 5 : 0)), 0, 100);
  }
  res.Strategy = strat; res.Legs = legs;
  res['Net / share'] = earnFmtMoney_(net);
  res['Max Loss $'] = earnRound_(maxLoss, 0); res['Max Gain $'] = typeof maxGain === 'number' ? earnRound_(maxGain, 0) : maxGain;
  res.Breakevens = be; res['Hist EV %'] = evShown; res['Hist Win %'] = winShown;
  res.Plan = plan; res.Score = earnRound_(score, 1);
  res.Action = isToday ? 'ENTER TODAY' : 'LATER';
  const whyBits = [];
  if (!choice.calendar) {
    whyBits.push('history says the options are ' + (ratio < 0.9 ? 'rich' : ratio > 1.1 ? 'cheap' : 'about fair') + ': past moves averaged ' + earnRound_(earnMean_(moves.map(Math.abs)), 1) + '% vs ' + earnRound_(imPct, 1) + '% implied (' + moves.length + ' events)');
    whyBits.push('after costs the ' + strat.toLowerCase() + ' back-tests at ' + evShown + '% of capital at risk (shrunk for the small sample), winning ' + winShown + '% of the time');
  } else {
    whyBits.push('front-month IV is ' + earnRound_(slope, 2) + 'x the next expiry and the move is priced about fairly (hist/implied ' + earnRound_(ratio, 2) + ')');
  }
  if (ctx.ivr[t] != null) whyBits.push('IV rank ' + earnRound_(ctx.ivr[t], 0));
  res.Why = prefix + whyBits.join('; ');
  res.SortKey = (isToday ? 3000 : 2000) + score;
  return res;
}

/* ============================================================================
 * THE SCAN
 * ========================================================================== */

function runEarningsScan(timeBudgetMsOverride, opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const startMs = Date.now();
  const C = EARN_CONFIG;
  const budget = (typeof timeBudgetMsOverride === 'number' && timeBudgetMsOverride > 0) ? timeBudgetMsOverride : C.timeBudgetMs;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(EARN_SHEET_NAME);
  if (!sheet) { notify_(ui, 'Earnings', 'No "' + EARN_SHEET_NAME + '" tab. Run setupEarnings once from the Apps Script editor.'); return null; }
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('EARN_RUNNING') || '0', 10);
  if (running && Date.now() - running < 10 * 60000) { notify_(ui, 'Earnings', 'A scan is already running (started ' + Math.round((Date.now() - running) / 1000) + 's ago).'); return null; }
  props.setProperty('EARN_RUNNING', String(Date.now()));
  try {
    earnWriteHeaders_(sheet);
    const now = new Date();
    const todayYmd = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
    const toYmd = Utilities.formatDate(new Date(now.getTime() + C.lookaheadDays * 86400000), 'America/New_York', 'yyyy-MM-dd');
    const cal = earnFetchCalendar_(todayYmd, toYmd);
    if (cal == null) { notify_(ui, 'Earnings', 'Could not read the earnings calendar (Finnhub key missing or request failed; see ScriptLog).'); return null; }
    const uni = earnUniverse_();
    Object.keys(earnReadHeld_(sheet)).forEach(function (t) { uni[t] = true; });
    // Reaction still ahead: future dates, or today's after-the-close reports. A before-the-open report dated today has already moved.
    const sess = marketSessionAt_(now);
    const events = cal.filter(function (e) {
      if (!uni[e.symbol]) return false;
      if (e.ymd < todayYmd) return false;
      if (e.ymd === todayYmd && e.hour === 'bmo') return false;
      return true;
    });
    const seen = {}, uniq = [];
    events.sort(function (a, b) { return a.ymd < b.ymd ? -1 : a.ymd > b.ymd ? 1 : 0; }).forEach(function (e) { if (!seen[e.symbol]) { seen[e.symbol] = 1; uniq.push(e); } });
    const work = uniq.slice(0, C.maxNames);

    const token = getTastyTradeAccessToken_();
    if (!token) { notify_(ui, 'Earnings', 'No TastyTrade token (see the "TastyTrade:" line in ScriptLog).'); return null; }
    const cache = earnLoadCache_();
    const ctx = { now: now, todayYmd: todayYmd, token: token, cache: cache, ivr: earnIvRanks_(work.map(function (e) { return e.symbol; }), token) };

    const rows = [];
    let timedOut = false;
    const counts = {};
    for (let i = 0; i < work.length; i++) {
      if (Date.now() - startMs > budget) { timedOut = true; break; }
      let r;
      try { r = earnEvaluate_(work[i], ctx); }
      catch (e) { r = { Ticker: work[i].symbol, Earnings: work[i].ymd, Action: 'SKIP', Why: 'error: ' + (e && e.message ? e.message : e), SortKey: 50, LastRun: now }; }
      rows.push(r);
      counts[r.Action] = (counts[r.Action] || 0) + 1;
      Utilities.sleep(C.sleepMs);
    }
    earnFlushCache_(cache);

    // Held plays (you typed Qty): read now, merged in, kept on top. A held name with no report in the window still gets a price row.
    const held = earnReadHeld_(sheet);
    const have = {};
    rows.forEach(function (r) { have[r.Ticker] = r; });
    Object.keys(held).forEach(function (t) {
      let r = have[t];
      if (!r) {
        r = { Ticker: t, Action: 'HELD', Why: 'no report in the next ' + C.lookaheadDays + ' days (or it already reported): decide on the P/L', LastRun: now };
        try { const q = fetchTastyEquityQuote_(t, token); if (q && q.price) { r.Price = earnRound_(q.price, 2); if (q.change != null) r.Change = earnRound_(q.change, 2); } } catch (e) { /* price stays blank */ }
        rows.push(r);
      } else if (r.Plan) {
        r.Action = (r._react && todayYmd >= r._react) ? 'CLOSE' : 'HELD';
        r.Why = 'You hold this. ' + (r.Why || '');
      } else if (r.Action !== 'SKIP') { r.Action = 'HELD'; }
      r.SortKey = 10000;
      r['Entry Date'] = held[t].entryDate; r.Entry = held[t].entry; r.Qty = held[t].qty;
    });

    rows.sort(function (a, b) { return (b.SortKey || 0) - (a.SortKey || 0); });
    // Write by header label, as the sheet is now. Only columns that exist are touched; columns of yours are left alone.
    const wmap = earnHeaderMap_(sheet);
    const labels = EARN_HEADERS.filter(function (h) { return wmap[h]; }).sort(function (a, b) { return wmap[a] - wmap[b]; });
    const last = sheet.getLastRow();
    const runs = [];
    labels.forEach(function (h) {
      const lastRun = runs[runs.length - 1];
      if (lastRun && wmap[h] === lastRun.start + lastRun.labels.length) lastRun.labels.push(h);
      else runs.push({ start: wmap[h], labels: [h] });
    });
    runs.forEach(function (run) {
      if (last > 1) sheet.getRange(2, run.start, last - 1, run.labels.length).clearContent().clearNote();
      if (!rows.length) return;
      const out = rows.map(function (r) { return run.labels.map(function (h) { return r[h] === undefined || r[h] === null ? '' : r[h]; }); });
      sheet.getRange(2, run.start, out.length, run.labels.length).setValues(out);
    });
    if (rows.length && labels.length) earnFormat_(sheet, rows.length, wmap);

    const alertNote = opts.alert ? '\nPhone alert: ' + earnSendAlert_(rows, todayYmd) : '';
    const msg = (timedOut ? '⏱️ Stopped at the time limit; rest next run.\n' : '') +
      'Reports in the next ' + C.lookaheadDays + ' days in your universe: ' + uniq.length + (uniq.length > work.length ? ' (scanned the nearest ' + work.length + ')' : '') + '\n' +
      Object.keys(counts).map(function (k) { return k + ': ' + counts[k]; }).join('   ') + '\n' +
      (sess.open ? '' : 'Market closed: quotes are indicative marks; re-run during market hours before entering.\n') +
      'Risk rule of thumb: 1% of the account per trade, 5% across all earnings trades.' + alertNote;
    logToSheet_('Earnings scan complete: ' + msg.replace(/\n/g, ' | '));
    notify_(ui, 'Earnings scan', msg);
    return { processed: rows.length, counts: counts, timedOut: timedOut };
  } finally {
    props.deleteProperty('EARN_RUNNING');
  }
}

function earnFormat_(sheet, n, map) {
  const fmt = function (h, f) { if (map[h]) sheet.getRange(2, map[h], n, 1).setNumberFormat(f); };
  const center = function (h) { if (map[h]) sheet.getRange(2, map[h], n, 1).setHorizontalAlignment('center'); };
  fmt('Price', '$#,##0'); fmt('Change', '$#,##0.00;-$#,##0.00;$0.00'); fmt('Entry Date', 'm"/"d'); fmt('Entry', '$#,##0.00'); fmt('Qty', 'General');
  ['Price', 'Change', 'Entry Date', 'Entry', 'Qty'].forEach(center);
  earnChangeColors_(sheet, map.Change);
  fmt('LastRun', 'yyyy-mm-dd hh:mm');
  ['Implied Move %', 'Hist Avg Move %', 'Spread %'].forEach(function (h) { fmt(h, '0.0'); });
  fmt('Hist / Implied', '0.00'); fmt('Term Slope', '0.00'); fmt('Score', '0.0');
  fmt('Max Loss $', '$#,##0'); fmt('Max Gain $', '$#,##0');
  if (map.Action) {
    const act = sheet.getRange(2, map.Action, n, 1).getValues();
    const colors = { 'ENTER TODAY': '#b7e1cd', 'LATER': '#d9ead3', 'PASS': '#eeeeee', 'SKIP': '#f4cccc', 'HELD': '#fff2cc', 'CLOSE': '#e06666' };
    sheet.getRange(2, map.Action, n, 1).setBackgrounds(act.map(function (v) { return [colors[v[0]] || null]; }));
  }
  if (map.Plan) sheet.getRange(2, map.Plan, n, 1).setWrap(false);
}

// Change column: green when up, red when down (same as Flip). Added once per column position.
function earnChangeColors_(sheet, c) {
  if (!c) return;
  const target = sheet.getRange(2, c, Math.max(sheet.getMaxRows() - 1, 1), 1);
  const rules = sheet.getConditionalFormatRules();
  if (rules.some(function (r) { const g = r.getRanges(); return g.length && g[0].getColumn() === c && g[0].getNumColumns() === 1; })) return;
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor('#cc0000').setRanges([target]).build());
  rules.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#1d7620').setRanges([target]).build());
  sheet.setConditionalFormatRules(rules);
}

/* ============================================================================
 * DEBUG: shows what each data source returns for one ticker (tell me which history source works)
 * ========================================================================== */
function debugEarnOneTicker() {
  const ui = SpreadsheetApp.getUi();
  const r = ui.prompt('Earnings debug', 'Ticker (a name that reports soon is best; any works for the history check):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = r.getResponseText().trim().toUpperCase();
  const now = new Date();
  const todayYmd = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd');
  const lines = [];
  const token = getTastyTradeAccessToken_();
  lines.push('TastyTrade token: ' + (token ? 'ok' : 'MISSING'));
  const by = earnFetchBars_(t, EARN_CONFIG.hist.years);
  lines.push('Yahoo daily bars: ' + (by ? by.bars.length + ' bars; Yahoo earnings events: ' + by.earnTs.length : 'FAILED'));
  const pe = earnFetchPastEvents_(t, todayYmd, by);
  lines.push('Past report dates: ' + pe.events.length + ' from ' + (pe.src || 'NO SOURCE') + (pe.events.length ? ' (latest ' + pe.events.slice(-3).map(function (e) { return e.ymd + (e.hour ? ' ' + e.hour : ''); }).join(', ') + ')' : ''));
  if (by && pe.events.length) {
    const mv = earnMovesFromBars_(by.bars, pe.events).slice(-EARN_CONFIG.hist.max);
    lines.push('Reaction moves (%): ' + mv.map(function (x) { return earnRound_(x.move, 1); }).join(', '));
  }
  const cal = earnFetchCalendar_(todayYmd, Utilities.formatDate(new Date(now.getTime() + 21 * 86400000), 'America/New_York', 'yyyy-MM-dd'));
  const mine = cal ? cal.filter(function (e) { return e.symbol === t; }) : [];
  lines.push('Upcoming report (next 21 days): ' + (cal == null ? 'calendar FAILED' : (mine.length ? mine[0].ymd + ' ' + (mine[0].hour || 'timing unknown') : 'none listed')));
  if (token && mine.length) {
    try {
      const ctx = { now: now, todayYmd: todayYmd, token: token, cache: earnLoadCache_(), ivr: earnIvRanks_([t], token) };
      const row = earnEvaluate_(mine[0], ctx);
      lines.push('Decision: ' + row.Action + (row.Strategy ? ' - ' + row.Strategy : '') + '\n' + (row.Legs ? 'Legs: ' + row.Legs + '\n' : '') + 'Implied move: ' + row['Implied Move %'] + '%  Hist avg: ' + row['Hist Avg Move %'] + '%\nWhy: ' + row.Why);
    } catch (e) { lines.push('Evaluate error: ' + e); }
  }
  ui.alert('Earnings debug: ' + t, lines.join('\n'), ui.ButtonSet.OK);
}