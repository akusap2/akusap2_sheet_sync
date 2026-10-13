/* ============================================================================
 * LONG — deep in-the-money LEAP calls as a stock substitute on moat companies
 * (replaces the Leap tab; same objective)
 * ----------------------------------------------------------------------------
 * Objective: own a solid, moat business through a 1-2 year call (delta about 0.85) for far less capital than 100
 * shares, hold it for a long time, take profit when it is good, leave on a trend break, and if the premium is likely
 * to drop in the next month, wait for the dip.
 *
 * Apps Script only — no Cloud Function redeploy. Reuses from other files (called at run time, never at load time):
 *   momentum.gs: Tasty/Yahoo fetchers, getSlowCached_, computeLeapPremiumLoss_, sendPhoneAlert_, notify_, logToSheet_
 *   CSPEngine.gs: cspSma_/cspRsi_/cspHv_, cspFetchIvRanks_, quality scoring (cspQualityStock_ / cspQualityEtf_), cspLin_
 *
 * Nothing here is backtested. Thresholds are starting values (LONG_CONFIG). Needs a TastyTrade token for option
 * data (delta, bid/ask, open interest): without it every row says so and is SKIP.
 * ========================================================================== */

const LONG_SHEET_NAME = 'Long';
const LONG_CACHE_SHEET_NAME = 'LongCache';   // its own cache sheet, like CSPCache, so no other tab's runs get slower

function longLoadCache_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LONG_CACHE_SHEET_NAME);
  const cache = {};
  if (!sheet) return cache;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return cache;
  sheet.getRange(1, 1, lastRow, 2).getValues().forEach(function (row) {
    if (!row[0] || !row[1]) return;
    try { cache[row[0]] = JSON.parse(row[1]); } catch (e) { /* corrupt entry: refetched */ }
  });
  return cache;
}

function longFlushCache_(pending) {
  const keys = Object.keys(pending);
  if (!keys.length) return 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LONG_CACHE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LONG_CACHE_SHEET_NAME);
    try { sheet.hideSheet(); } catch (e) { /* ignore */ }
  }
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow >= 1) sheet.getRange(1, 1, lastRow, 2).getValues().forEach(function (row) { if (row[0]) existing[row[0]] = row[1]; });
  keys.forEach(function (k) { existing[k] = pending[k]; });
  // Contract picks and daily technicals older than 3 days are useless: drop them so the sheet does not grow forever.
  const cutoff = Date.now() - 3 * 86400000;
  const rows = [];
  Object.keys(existing).forEach(function (k) {
    if (/^SLOW_(LONGCON|LONGTECH)_/.test(k)) {
      try { const d = JSON.parse(existing[k]).date; if (new Date(d + 'T00:00:00').getTime() < cutoff) return; } catch (e) { return; }
    }
    rows.push([k, existing[k]]);
  });
  sheet.clearContents();
  if (rows.length) sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  return keys.length;
}

const LONG_CONFIG = {
  // --- contract ------------------------------------------------------------
  contract: {
    minDte: 400, maxDte: 730, targetDte: 540,
    minDelta: 0.80, maxDelta: 0.92, targetDelta: 0.85,
    maxSpreadPct: 2,         // bid-ask gap as % of mid
    minOi: 50,               // LEAP chains are thin
    minMid: 1,
    maxCarryPct: 8,          // extrinsic value per year as % of the stock price
    expiriesToTry: 2, strikesPerExpiry: 10
  },
  // --- entry ---------------------------------------------------------------
  entry: {
    strongMaxOffHigh: 15, strongMaxRsi: 45,
    lightMaxOffHigh: 25, lightMaxRsi: 55,
    maxIvr: 40,
    bounceMaxOffHigh: 35, bounceMinPct: 50, bounceMinFallPct: 8, bounceMinLowAgeDays: 40,   // READY only, never BUY
    skipOffHigh: 35,
    riskGate: 30,            // Risk = chance the premium is down 20%+ in 30 days (computeLeapPremiumLoss_)
    scoreBuy: 65, scoreReady: 50,
    qualityFloor: 65, qualityFloorEtf: 55
  },
  // --- exits (held positions) -------------------------------------------------
  exits: { trendBandPct: 3, takeProfitPct: 50, rollDte: 180, reviewCarryPct: 12 },
  // --- runtime ---------------------------------------------------------------
  timeBudgetMs: 4.5 * 60 * 1000,
  sleepMs: 100,
  // --- research promotion (universe quality screen) ------------------------------
  promote: {
    maxTotal: 30, maxEtfs: 5,     // the tab holds at most maxTotal rows (stocks + ETFs + pinned rows)
    
    minStockScore: 70, minEtfScore: 60,
    minCapB: 50,             // $50B market cap floor
    minHistoryYears: 4.7,
    minRoePct: 12, minOpmPct: 10,
    timeBudgetMs: 4 * 60 * 1000
  },
  // cspQualityStock_/Etf_ read these two; 100 switches their trend gates off (Long judges trend itself, per row)
  maxBelow200Pct: 100, maxDrawdownPct: 100,
  // --- alerts ----------------------------------------------------------------
  alerts: { exitRepeatHours: 12, rollRepeatHours: 24, tpRepeatHours: 24, reviewRepeatHours: 24, buyRepeatHours: 24 },
  // --- schedule (US/Eastern) -------------------------------------------------
  schedule: { startHHmm: '09:45', endHHmm: '15:55' }
};

// Starter list for a brand-new tab.
const LONG_STARTER_TICKERS = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'V', 'MA', 'COST', 'WMT', 'JPM', 'KO', 'PEP', 'PG', 'JNJ', 'HD', 'LIN', 'UNP', 'SPGI', 'ISRG', 'SPY', 'QQQ',
  'LLY', 'AVGO', 'MCO', 'ICE', 'ADP', 'SHW', 'ORLY', 'TJX', 'ITW', 'CB'];

// Research universe. Own literal lists (not shared constants) so file load order never matters. From general knowledge of large,
// long-record, wide-moat businesses — NOT a rating. The numeric screen (market cap >= $50B, returns, margins, 5-year record) decides who
// qualifies; this list only decides who gets looked at. Add or remove freely.
const LONG_STOCK_UNIVERSE = [
  // Technology
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'AVGO', 'ORCL', 'ADBE', 'CRM', 'CSCO', 'TXN', 'QCOM', 'INTU', 'NOW',
  'ACN', 'IBM', 'AMAT', 'LRCX', 'KLAC', 'SNPS', 'CDNS', 'ADI', 'TSM', 'ASML', 'FICO', 'ROP', 'ADSK',
  // Financials
  'JPM', 'V', 'MA', 'AXP', 'BLK', 'SPGI', 'MCO', 'ICE', 'CME', 'MS', 'GS', 'SCHW', 'CB', 'MMC', 'AON', 'PGR', 'TRV', 'MSCI', 'VRSK',
  // Healthcare
  'JNJ', 'UNH', 'LLY', 'ABBV', 'MRK', 'TMO', 'DHR', 'ABT', 'ISRG', 'SYK', 'BSX', 'MDT', 'ZTS', 'VRTX', 'REGN', 'AMGN', 'IDXX', 'ELV', 'CI',
  // Consumer
  'WMT', 'COST', 'PG', 'KO', 'PEP', 'MDLZ', 'CL', 'PM', 'HSY', 'HD', 'LOW', 'MCD', 'NKE', 'SBUX', 'TJX', 'BKNG', 'CMG', 'ORLY', 'AZO', 'ROST', 'MNST',
  // Industrials / Materials / Energy / Utilities / Comm
  'UNP', 'CAT', 'DE', 'HON', 'GE', 'RTX', 'LMT', 'ETN', 'ITW', 'WM', 'RSG', 'ADP', 'LIN', 'SHW', 'APD', 'ECL', 'NOC', 'GD', 'CTAS', 'CPRT',
  'XOM', 'CVX', 'NEE', 'DUK', 'SO', 'DIS', 'TMUS', 'NFLX', 'PLD', 'AMT', 'EQIX'
];

// Broad-market and large-sector ETFs with deep option markets (LEAP strikes exist and are reasonably liquid).
const LONG_ETF_UNIVERSE = ['SPY', 'VOO', 'IVV', 'QQQ', 'DIA', 'VTI', 'RSP', 'VUG', 'VIG', 'SCHD', 'XLK', 'XLV', 'XLF', 'XLI', 'XLY', 'XLP', 'SMH', 'VGT'];
const LONG_ETF_SET = (function () { const o = {}; LONG_ETF_UNIVERSE.forEach(function (t) { o[t] = true; }); return o; })();

// Never listed even if a source tab has them (shared with CSP when it is loaded).
function longNever_() {
  return (typeof CSP_NEVER !== 'undefined') ? CSP_NEVER : [];
}

/* ----------------------------------------------------------------------------
 * COLUMNS
 * ---------------------------------------------------------------------------- */

const LONG_INPUT_HEADERS = ['Ticker', 'Qty', 'Entry Date', 'Entry'];            // yours
const LONG_HELD_WHEN_OPEN = ['Strike', 'Expiry'];                                // your entries while Qty is filled: never overwritten
const LONG_EXTRA_HEADERS = ['Quality', 'Source', 'Type'];                        // written by Promote, not by the scan
const LONG_VISIBLE_HEADERS = ['Ticker', 'Qty', 'Entry Date', 'Entry', 'Action', 'Score', 'Risk', 'Price', 'Change', 'Trend', 'Off High %', 'Quality',
  'Earn Days', 'IV Rank', 'Expiry', 'Strike', 'Delta', 'Mid', 'Spread %', 'OI', 'Vol', 'Lev', 'Roll By',
  'Days', 'P/L $', 'Why', 'LastRun'];
const LONG_DETAIL_HEADERS = ['DTE', 'T200 %', 'X50 %', 'RSI', 'Bounce', '52w High', '52w Low', 'Analyst', 'Upside %', 'Next Earnings', 'HV20',
  'Bid', 'Ask', 'Extrinsic $', 'Risk 10%', 'Risk 30%', 'SortKey'];
// Still computed (used by Action, alerts and Why) but no longer a column: setup never re-adds them, and if they are still on the sheet they are hidden.
const LONG_NO_COLUMN = ['Carry %/yr', 'Breakeven %', 'P/L %', 'Stock Equiv $', 'Capital Saved $'];
const LONG_HEADERS = LONG_VISIBLE_HEADERS.concat(LONG_DETAIL_HEADERS).concat(LONG_EXTRA_HEADERS.filter(function (h) { return LONG_VISIBLE_HEADERS.indexOf(h) === -1; }));   // Quality is visible, Source / Type hidden
// Columns the scan writes (everything except your inputs and the promote-managed ones).
const LONG_OUTPUT_HEADERS = LONG_HEADERS.concat(LONG_NO_COLUMN).filter(function (h) { return LONG_INPUT_HEADERS.indexOf(h) === -1 && LONG_EXTRA_HEADERS.indexOf(h) === -1; });


/* ============================================================================
 * SETUP + MENU
 * ========================================================================== */

// Run ONCE from the Apps Script editor.
function setupLong() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LONG_SHEET_NAME);
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet(LONG_SHEET_NAME);
  const map = longEnsureHeaders_(sheet);
  if (isNew) {
    const rows = LONG_STARTER_TICKERS.map(function (t) {
      const row = new Array(LONG_HEADERS.length).fill('');
      row[map['Ticker'] - 1] = t;
      return row;
    });
    sheet.getRange(2, 1, rows.length, LONG_HEADERS.length).setValues(rows);
  }
  longFormatSheet_(sheet);
  longApplyVisibility_(sheet, false);

  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(function (t) { return t.getHandlerFunction() === 'longAddMenu_'; })) {
    ScriptApp.newTrigger('longAddMenu_').forSpreadsheet(ss).onOpen().create();
  }
  try { longAddMenu_(); } catch (e) { /* no UI in some contexts; menu appears on next open */ }

  notify_(tryGetUi_(), 'Long set up',
    (isNew ? 'Created the Long tab with ' + LONG_STARTER_TICKERS.length + ' starter tickers.\n' : 'Long tab already existed: headers checked, your data untouched.\n') +
    'Menu "📈 Long" appears after you reload the sheet.\n\n' +
    'Next:\n  1. 📈 Long > Promote Research Picks to Long (adds quality names and ETFs)\n  2. 📈 Long > Run Long Scan\n' +
    '  3. 📈 Long > Long Alerts & Schedule > Start Long Schedule (hourly checks + Telegram alerts)\n\n' +
    'Type your LEAP into Qty, Entry Date, Entry (premium paid per share), Strike, Expiry. The rest fills in.');
}

function longAddMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('📈 Long')
    .addItem('Run Long Scan', 'runLongScan')
    .addItem('Promote Research Picks to Long', 'runLongPromote')
    .addItem('Show / Hide Detail Columns', 'longToggleDetailColumns_')
    .addItem('🗂 Update Universe (Universe tab)', 'longUpdateUniverse')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('📱 Long Alerts & Schedule')
      .addItem('Send Test Long Alert', 'sendTestLongAlert_')
      .addItem('Turn Long Alerts On / Off', 'toggleLongAlerts_')
      .addSeparator()
      .addItem('▶ Start Long Schedule (hourly, market hours)', 'startLongSchedule_')
      .addItem('■ Stop Long Schedule', 'stopLongSchedule_')
      .addItem('Schedule Status', 'longScheduleStatus_'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🔍 Long Debug')
      .addItem('One Ticker (full decision trail)', 'debugLongOneTicker')
      .addItem('Scan Dry Run (no writes)', 'runLongScanDryRun')
      .addItem('Promote Dry Run (no writes)', 'runLongPromoteDryRun'))
    .addToUi();
}

function runLongScanDryRun() { return runLongScan(null, true); }
function runLongPromote() { return longPromoteFromResearch_({}); }
function runLongPromoteDryRun() { return longPromoteFromResearch_({ dryRun: true }); }


/* ============================================================================
 * SHEET HELPERS (plain headers: no formula-header handling — Entry is a normal input column here)
 * ========================================================================== */

function longHeaderMap_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const row = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  row.forEach(function (h, i) { const k = String(h || '').trim(); if (k && map[k] == null) map[k] = i + 1; });
  return map;
}

// Adds any missing header at the end. Existing columns, order and data stay.
function longEnsureHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  if (!existing.some(function (h) { return h !== ''; })) {
    sheet.getRange(1, 1, 1, LONG_HEADERS.length).setValues([LONG_HEADERS]);
  } else {
    let next = existing.length;
    while (next > 0 && existing[next - 1] === '') next--;
    LONG_HEADERS.forEach(function (h) {
      if (existing.indexOf(h) === -1) { next++; sheet.getRange(1, next).setValue(h); existing[next - 1] = h; }
    });
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  return longHeaderMap_(sheet);
}

function longApplyVisibility_(sheet, showAll) {
  const map = longHeaderMap_(sheet);
  const last = sheet.getLastColumn();
  if (last < 1) return;
  sheet.showColumns(1, last);
  if (showAll) return;
  const vis = {};
  LONG_VISIBLE_HEADERS.forEach(function (h) { vis[h] = true; });
  const hide = [];
  for (let c = 1; c <= last; c++) hide.push(false);
  Object.keys(map).forEach(function (h) { if (!vis[h]) hide[map[h] - 1] = true; });
  for (let c = 0; c < last; c++) {
    if (!hide[c]) continue;
    let e = c;
    while (e + 1 < last && hide[e + 1]) e++;
    sheet.hideColumns(c + 1, e - c + 1);
    c = e;
  }
}

function longToggleDetailColumns_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LONG_SHEET_NAME);
  if (!sheet) return;
  const map = longHeaderMap_(sheet);
  const hidden = map['DTE'] ? sheet.isColumnHiddenByUser(map['DTE']) : false;
  longApplyVisibility_(sheet, hidden);
}

// Change colours (conditional formatting, so they stay right): dark green positive, red negative.
function longApplyChangeRules_(sheet, map, onlyIfMissing) {
  try {
    const col = map['Change'];
    if (!col) return;
    const rules = sheet.getConditionalFormatRules();
    const mine = function (r) { return r.getRanges().some(function (x) { return x.getColumn() <= col && x.getLastColumn() >= col; }); };
    if (onlyIfMissing && rules.some(mine)) return;
    const rng = sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1);
    const neg = SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor('#cc0000').setRanges([rng]).build();
    const pos = SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#38761d').setRanges([rng]).build();
    sheet.setConditionalFormatRules(rules.filter(function (r) { return !mine(r); }).concat([neg, pos]));
  } catch (e) { logToSheet_('Long: could not apply Change colours: ' + (e && e.message ? e.message : e)); }
}

function longFormatSheet_(sheet) {
  const map = longHeaderMap_(sheet);
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  function fmt(h, f) { if (map[h]) sheet.getRange(2, map[h], maxRows, 1).setNumberFormat(f); }
  ['Entry', 'Price', 'Strike', 'Mid', 'Bid', 'Ask', '52w High', '52w Low', 'Analyst', 'Extrinsic $'].forEach(function (h) { fmt(h, '$#,##0.00'); });
  fmt('Change', '$#,##0.00;-$#,##0.00;$0.00');
  fmt('Stock Equiv $', '$#,##0'); fmt('Capital Saved $', '$#,##0'); fmt('P/L $', '$#,##0;-$#,##0;$0');
  ['Entry Date', 'Expiry', 'Roll By', 'Next Earnings'].forEach(function (h) { fmt(h, 'yyyy-mm-dd'); });
  fmt('LastRun', 'yyyy-mm-dd hh:mm');
  ['Off High %', 'T200 %', 'X50 %', 'Spread %', 'Carry %/yr', 'Breakeven %', 'P/L %', 'Upside %', 'IV Rank', 'HV20', 'RSI', 'Bounce', 'Risk', 'Risk 10%', 'Risk 30%', 'Quality']
    .forEach(function (h) { fmt(h, '0.0'); });
  ['Score', 'Delta', 'Lev'].forEach(function (h) { fmt(h, '0.00'); });
  LONG_INPUT_HEADERS.concat(LONG_HELD_WHEN_OPEN).forEach(function (h) { if (map[h]) sheet.getRange(1, map[h]).setBackground('#fff2cc'); });
  LONG_OUTPUT_HEADERS.forEach(function (h) { if (map[h] && LONG_HELD_WHEN_OPEN.indexOf(h) === -1) sheet.getRange(1, map[h]).setBackground('#d9ead3'); });
  LONG_EXTRA_HEADERS.forEach(function (h) { if (map[h]) sheet.getRange(1, map[h]).setBackground('#cfe2f3'); });
  longApplyChangeRules_(sheet, map, false);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
}


/* ============================================================================
 * PURE FUNCTIONS (no Apps Script services except Utilities.formatDate in text helpers — unit-testable)
 * ========================================================================== */

function longLin_(v, zero, full) {
  if (v == null || isNaN(v)) return 0.5;                 // missing input: half credit, never zero
  const x = (v - zero) / (full - zero);
  return x < 0 ? 0 : (x > 1 ? 1 : x);
}
function longRound_(v, d) { const p = Math.pow(10, d == null ? 1 : d); return Math.round(v * p) / p; }
function longFmtDate_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM-dd-yyyy'); }
function longYmd_(d) { return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd'); }
function longIsDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function longDaysBetween_(from, to) { return Math.round((to.getTime() - from.getTime()) / 86400000); }

// dates: 'yyyy-MM-dd' per bar (exchange date), closes: matching closes. todayYmd: a bar dated today is still forming and is dropped.
// Returns small JSON (cacheable) or null. Needs 201+ completed closes (200-day average and yesterday's 200-day average).
function longTechFromBars_(dates, closes, todayYmd) {
  if (!dates || !closes || dates.length !== closes.length) return null;
  let n = closes.length;
  if (n && dates[n - 1] === todayYmd) n--;
  const c = closes.slice(0, n);
  if (c.length < 201) return null;
  const last = c[c.length - 1];
  const prev = c.slice(0, -1);
  const yr = c.slice(-252);
  const hi52 = Math.max.apply(null, yr), lo52 = Math.min.apply(null, yr);
  // Bounce: lowest close of the last 120 sessions, how long ago, how much of the fall from the 52w high has been regained.
  const w = c.slice(-120);
  let lowV = w[0], lowI = 0;
  for (let i = 1; i < w.length; i++) if (w[i] <= lowV) { lowV = w[i]; lowI = i; }
  const fall = hi52 > 0 ? (hi52 - lowV) / hi52 * 100 : null;
  const bounce = (hi52 > lowV) ? (last - lowV) / (hi52 - lowV) * 100 : null;
  return {
    asOf: dates[n - 1], price: last, c2: prev[prev.length - 1],
    ma20: cspSma_(c, 20), ma50: cspSma_(c, 50), ma200: cspSma_(c, 200), prevMa200: cspSma_(prev, 200),
    hi52: hi52, lo52: lo52, rsi: cspRsi_(c, 14), hv20: cspHv_(c, 20),
    ret5: c.length > 5 ? (last / c[c.length - 6] - 1) * 100 : null,
    fall: fall, bounce: bounce, lowAge: w.length - 1 - lowI, n: c.length
  };
}

// Metrics of one call contract. c = { bid, ask, delta, oi, strike, dte }.
function longContractMetrics_(c, spot) {
  const two = c.bid != null && c.ask != null && c.bid > 0 && c.ask >= c.bid;
  const mid = two ? (c.bid + c.ask) / 2 : null;
  const spreadPct = (two && mid > 0) ? (c.ask - c.bid) / mid * 100 : null;
  const intrinsic = Math.max(0, spot - c.strike);
  const extrinsic = mid != null ? mid - intrinsic : null;
  const carry = (extrinsic != null && c.dte > 0) ? extrinsic / spot * 100 / (c.dte / 365) : null;
  const breakeven = extrinsic != null ? extrinsic / spot * 100 : null;
  const lev = (mid != null && mid > 0 && c.delta != null) ? c.delta * spot / mid : null;
  return { mid: mid, spreadPct: spreadPct, intrinsic: intrinsic, extrinsic: extrinsic, carry: carry, breakeven: breakeven, lev: lev };
}

// Picks the cheapest-to-hold contract that passes every gate. cands: [{expiry:Date, dte, strike, bid, ask, delta, oi}].
// Returns { ok:true, pick, m } or { ok:false, near, why } where near is the closest candidate (fewest failures, then tightest spread).
function longChooseContract_(cands, spot, cfg) {
  const K = cfg.contract;
  let best = null, nearest = null;
  cands.forEach(function (c) {
    const m = longContractMetrics_(c, spot);
    const f = [];
    if (m.mid == null) f.push('no two-sided quote');
    if (c.delta == null) f.push('no delta');
    else if (c.delta < K.minDelta || c.delta > K.maxDelta) f.push('delta ' + longRound_(c.delta, 2) + ' outside ' + K.minDelta + '-' + K.maxDelta);
    if (c.dte < K.minDte || c.dte > K.maxDte) f.push(c.dte + 'd outside ' + K.minDte + '-' + K.maxDte);
    if (m.spreadPct != null && m.spreadPct > K.maxSpreadPct) f.push('spread ' + longRound_(m.spreadPct, 1) + '% > ' + K.maxSpreadPct + '%');
    if (c.oi != null && c.oi < K.minOi) f.push('OI ' + c.oi + ' < ' + K.minOi);
    if (m.mid != null && m.mid < K.minMid) f.push('mid $' + longRound_(m.mid, 2) + ' < $' + K.minMid);
    if (m.extrinsic != null && m.extrinsic < 0) f.push('quote below intrinsic');
    if (m.carry != null && m.carry > K.maxCarryPct) f.push('carry ' + longRound_(m.carry, 1) + '%/yr > ' + K.maxCarryPct + '%');
    const score = f.length * 1000 + (m.spreadPct != null ? m.spreadPct : 50);
    if (!nearest || score < nearest.score) nearest = { score: score, c: c, m: m, fails: f };
    if (!f.length) {
      const cost = m.carry + (m.spreadPct || 0) / 2;
      if (!best || cost < best.cost) best = { cost: cost, c: c, m: m };
    }
  });
  if (best) return { ok: true, pick: best.c, m: best.m };
  if (!nearest) return { ok: false, near: null, why: 'no candidate contracts' };
  const n = nearest.c;
  return {
    ok: false,
    near: { strike: n.strike, expiry: n.expiry, oi: n.oi, volume: n.volume, mid: nearest.m.mid, spreadPct: nearest.m.spreadPct },
    why: 'no usable contract: none of ' + cands.length + ' passed; closest $' + n.strike + 'C ' + longFmtDate_(n.expiry) + ': ' + nearest.fails.join(', ')
  };
}

// Score 0-100: Quality 30 + Trend 20 + Entry timing 20 + Contract efficiency 20 + Upside 10. Missing inputs get half credit.
function longScore_(x) {
  const p = {};
  p.quality = 30 * longLin_(x.quality, 50, 90);
  p.trend = 12 * longLin_(x.vs200, 0, 15) + 8 * longLin_(x.x50, 0, 8);
  p.timing = 10 * longLin_(x.rsi, 60, 40) + 5 * longLin_(x.offHigh, 25, 10) + 5 * longLin_(x.ivr, 60, 20);
  p.contract = 10 * longLin_(x.carry, 8, 3) + 6 * longLin_(x.spreadPct, 2, 0.5) +
    4 * (x.delta == null ? 0.5 : 1 - Math.min(1, Math.abs(x.delta - 0.85) / 0.1));
  p.upside = 10 * longLin_(x.upside, -5, 20);
  let s = 0;
  Object.keys(p).forEach(function (k) { s += p[k]; });
  return { score: longRound_(s, 1), parts: p };
}

// Entry decision for a row you do NOT hold. x: vs200, x50, offHigh, rsi, ivr, bounce, fall, lowAge, quality (null ok), isEtf, risk (null ok),
// score, contractOk, contractWhy.
function longEvaluateEntry_(x, cfg) {
  const E = cfg.entry;
  const skip = [];
  if (!(x.vs200 > 0)) skip.push('price under the 200-day' + (x.vs200 != null ? ' (' + longRound_(x.vs200, 1) + '%)' : ''));
  if (!(x.x50 > 0)) skip.push('50-day under the 200-day');
  if (x.offHigh != null && x.offHigh > E.skipOffHigh) skip.push(longRound_(x.offHigh, 1) + '% under the 52-week high (limit ' + E.skipOffHigh + '%)');
  const qFloor = x.isEtf ? E.qualityFloorEtf : E.qualityFloor;
  if (x.quality != null && x.quality < qFloor) skip.push('Quality ' + longRound_(x.quality, 1) + ' < ' + qFloor);
  if (!x.contractOk) skip.push(x.contractWhy);
  if (skip.length) return { action: 'SKIP', why: skip };

  const strong = x.offHigh != null && x.rsi != null && x.offHigh <= E.strongMaxOffHigh && x.rsi <= E.strongMaxRsi;
  const light = x.offHigh != null && x.rsi != null && x.offHigh <= E.lightMaxOffHigh && x.rsi <= E.lightMaxRsi;
  const ivOk = x.ivr == null || x.ivr <= E.maxIvr;
  const timingOk = (strong || light) && ivOk;
  const bounceLane = x.offHigh != null && x.offHigh <= E.bounceMaxOffHigh && x.bounce != null && x.bounce >= E.bounceMinPct &&
    x.fall != null && x.fall >= E.bounceMinFallPct && x.lowAge != null && x.lowAge >= E.bounceMinLowAgeDays;

  const missing = [];
  if (!(strong || light)) missing.push('needs a pullback: Off High <= ' + E.lightMaxOffHigh + '% and RSI <= ' + E.lightMaxRsi + ' (now ' +
    (x.offHigh != null ? longRound_(x.offHigh, 1) + '%' : '?') + ' / RSI ' + (x.rsi != null ? Math.round(x.rsi) : '?') + ')');
  if (!ivOk) missing.push('IV Rank ' + Math.round(x.ivr) + ' > ' + E.maxIvr);
  if (x.score < E.scoreBuy) missing.push('Score ' + x.score + ' < ' + E.scoreBuy);

  if (x.risk == null) return { action: 'WAIT', why: ['Risk model could not price this contract'] };
  if (x.risk > E.riskGate) {
    return { action: 'WAIT', why: ['Risk ' + longRound_(x.risk, 1) + ' > ' + E.riskGate + ': premium likely to drop 20%+ within 30 days, wait for the dip'] };
  }
  if (timingOk && x.score >= E.scoreBuy) return { action: 'BUY', why: [(strong ? 'strong' : 'light') + ' pullback in an uptrend, Risk ' + longRound_(x.risk, 1) + ', Score ' + x.score] };
  if (x.score >= E.scoreReady) {
    if (!timingOk && bounceLane) return { action: 'READY', why: ['bounce lane (recovering ' + Math.round(x.bounce) + '% of the fall, low ' + x.lowAge + ' sessions ago), not a BUY', missing.join('; ')] };
    return { action: 'READY', why: missing };
  }
  return { action: 'WAIT', why: missing.length ? missing : ['Score ' + x.score + ' < ' + E.scoreReady] };
}

// Action for a position you hold. h: dte, pl (% or null), spot, tech {price,c2,ma200,prevMa200}, upside, quality, isEtf, carry.
// Precedence: TREND EXIT > ROLL > TAKE PROFIT > REVIEW > HOLD.
function longHeldAction_(h, cfg) {
  const X = cfg.exits, E = cfg.entry;
  const t = h.tech;
  if (h.dte != null && h.dte <= 0) return { action: 'ROLL', why: 'expired or expiring today' };
  if (t && t.ma200 && h.spot != null) {
    const twoCloses = t.price < t.ma200 && t.prevMa200 != null && t.c2 < t.prevMa200 && h.spot < t.ma200;
    const brokenBand = h.spot <= t.ma200 * (1 - X.trendBandPct / 100);
    if (twoCloses || brokenBand) {
      return { action: 'TREND EXIT', why: brokenBand ? 'price ' + longRound_((h.spot / t.ma200 - 1) * 100, 1) + '% vs the 200-day (exit band -' + X.trendBandPct + '%)'
        : '2 closes under the 200-day and price still under it' };
    }
  }
  if (h.dte != null && h.dte <= X.rollDte) return { action: 'ROLL', why: h.dte + ' days left (roll at ' + X.rollDte + ' or less): move to ' + cfg.contract.minDte + '+ days' };
  if (h.pl != null && h.pl >= X.takeProfitPct) return { action: 'TAKE PROFIT', why: 'option +' + longRound_(h.pl, 1) + '% vs Entry (target +' + X.takeProfitPct + '%)' };
  const rv = [];
  if (h.upside != null && h.upside < 0) rv.push('analyst target ' + longRound_(-h.upside, 1) + '% under the price');
  const qFloor = h.isEtf ? E.qualityFloorEtf : E.qualityFloor;
  if (h.quality != null && h.quality < qFloor) rv.push('Quality ' + longRound_(h.quality, 1) + ' < ' + qFloor);
  if (h.carry != null && h.carry > X.reviewCarryPct) rv.push('carry ' + longRound_(h.carry, 1) + '%/yr > ' + X.reviewCarryPct + '%');
  if (rv.length) return { action: 'REVIEW', why: rv.join('; ') };
  return { action: 'HOLD', why: 'trend intact' + (h.pl != null ? ', option ' + (h.pl >= 0 ? '+' : '') + longRound_(h.pl, 1) + '%' : '') };
}

function longSortKey_(action, score, pl) {
  const s = score != null && !isNaN(score) ? score : 0;
  switch (action) {
    case 'TREND EXIT': return 3200;
    case 'ROLL': return 3100;
    case 'TAKE PROFIT': return 3000 + (pl != null ? Math.min(99, Math.max(0, pl) / 10) : 0);
    case 'FILL IN': return 2900;
    case 'REVIEW': return 2800;
    case 'BUY': return 2000 + s;
    case 'HOLD': return 1500;
    case 'READY': return 1200 + s;
    case 'WAIT': return 1000 + s;
    default: return s;   // SKIP
  }
}

function longTrendLabel_(vs200, vs50, vs20) {
  if (vs200 == null) return '';
  if (vs200 > 0 && vs50 != null && vs50 > 0) return 'Up';
  if (vs200 > 0) return 'Pullback';
  if (vs50 != null && vs50 < 0) return 'Down';
  return 'Mixed';
}


/* ============================================================================
 * DATA FETCH
 * ========================================================================== */

// Daily bars WITH exchange dates (the shared fetcher drops the dates). Returns { dates, closes } or null.
function longFetchBars_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=1y&interval=1d',
    'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=1y&interval=1d'
  ];
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], { method: 'get', muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' } });
      if (resp.getResponseCode() !== 200) continue;
      const result = JSON.parse(resp.getContentText()).chart.result[0];
      const ts = result.timestamp, q = result.indicators.quote[0];
      if (!ts || !q || !q.close) continue;
      const off = (result.meta && typeof result.meta.gmtoffset === 'number') ? result.meta.gmtoffset : -4 * 3600;
      const dates = [], closes = [];
      for (let k = 0; k < ts.length; k++) {
        if (!isPlausible_(q.close[k], 0.01, null)) continue;
        dates.push(new Date((ts[k] + off) * 1000).toISOString().slice(0, 10));   // exchange-local calendar date
        closes.push(q.close[k]);
      }
      if (closes.length >= 201) return { dates: dates, closes: closes };
    } catch (e) { Logger.log('Long bars error for ' + ticker + ': ' + e); }
  }
  return null;
}

function longTodayYmdEt_() { return Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd'); }

function longFetchTech_(ticker, ctx) {
  const res = getSlowCached_(ctx.slowCache, ctx.pending, 'LONGTECH', ticker, SLOW_REFRESH_DAYS.DAILYBARS, function () {
    const b = longFetchBars_(ticker);
    return b ? longTechFromBars_(b.dates, b.closes, longTodayYmdEt_()) : null;
  });
  if (res.fetchAttempted) Utilities.sleep(LONG_CONFIG.sleepMs);
  return res.value || null;
}

function longFetchEarnings_(ticker, ctx) {
  const res = getSlowCached_(ctx.slowCache, ctx.pending, 'CATALYST', ticker, SLOW_REFRESH_DAYS.CATALYST, function () {
    let c = ctx.finnhubKey ? fetchFinnhubNextEarnings_(ticker, ctx.finnhubKey) : null;
    if (!c) c = fetchYahooNextEarnings_(ticker);
    if (!c) return null;
    return { date: c.date ? Utilities.formatDate(c.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null };
  }, isCatalystPast_);
  if (res.fetchAttempted) Utilities.sleep(LONG_CONFIG.sleepMs);
  return (res.value && res.value.date) ? new Date(res.value.date + 'T12:00:00') : null;
}

function longFetchAnalyst_(ticker, ctx) {
  const res = getSlowCached_(ctx.slowCache, ctx.pending, 'ANALYST', ticker, SLOW_REFRESH_DAYS.ANALYST, function () {
    const a = fetchYahooAnalystTarget_(ticker);
    return a ? { target: a.target } : null;
  });
  if (res.fetchAttempted) Utilities.sleep(LONG_CONFIG.sleepMs);
  return (res.value && res.value.target) ? res.value.target : null;
}

// Quote of ONE call contract -> candidate object (bid/ask/delta/oi/volume from Tasty; mark fallback elsewhere). Null if nothing usable.
function longQuoteContract_(ticker, expiry, strike, ctx, now) {
  const occ = buildOccSymbol_(ticker, expiry, strike, 'C');
  let md = null;
  try { const m = fetchTastyMarketDataBatch_([occ], ctx.token); md = m && m[occ]; } catch (e) { /* below */ }
  return { occ: occ, expiry: expiry, strike: strike, dte: longDaysBetween_(now, expiry),
    bid: md ? md.bid : null, ask: md ? md.ask : null, delta: md ? md.delta : null, oi: md ? md.oi : null, volume: md ? md.volume : null };
}

// Full pick from the Tasty chain: the expiries nearest the target DTE, the strikes nearest 84% of spot, one batched quote call.
function longPickContract_(ticker, spot, ctx) {
  const K = LONG_CONFIG.contract, now = ctx.now;
  if (!ctx.token) return { ok: false, near: null, why: 'no TastyTrade token: Long needs real delta, bid/ask and open interest' };
  const chain = fetchTastyOptionChainNested_(ticker, ctx.token);
  if (!chain) return { ok: false, near: null, why: 'no option chain from TastyTrade' };
  const exps = chain.map(function (e) { return { e: e, dte: longDaysBetween_(now, e.date) }; })
    .filter(function (x) { return x.dte >= K.minDte && x.dte <= K.maxDte; })
    .sort(function (a, b) { return Math.abs(a.dte - K.targetDte) - Math.abs(b.dte - K.targetDte); })
    .slice(0, K.expiriesToTry);
  if (!exps.length) {
    const longest = chain.reduce(function (m, e) { return Math.max(m, longDaysBetween_(now, e.date)); }, 0);
    return { ok: false, near: null, why: 'no expiry between ' + K.minDte + ' and ' + K.maxDte + ' days (longest listed: ' + longest + 'd)' };
  }
  const syms = [], meta = {};
  exps.forEach(function (x) {
    x.e.strikes.filter(function (s) { return s.callSymbol && s.strike >= spot * 0.65 && s.strike <= spot * 0.98; })
      .sort(function (a, b) { return Math.abs(a.strike - spot * 0.84) - Math.abs(b.strike - spot * 0.84); })
      .slice(0, K.strikesPerExpiry)
      .forEach(function (s) { syms.push(s.callSymbol); meta[s.callSymbol] = { expiry: x.e.date, dte: x.dte, strike: s.strike }; });
  });
  if (!syms.length) return { ok: false, near: null, why: 'no in-the-money call strikes listed in the LEAP expiries' };
  const md = fetchTastyMarketDataBatch_(syms, ctx.token) || {};
  const cands = syms.map(function (s) {
    const q = md[s] || {};
    return { occ: s, expiry: meta[s].expiry, dte: meta[s].dte, strike: meta[s].strike,
      bid: q.bid != null ? q.bid : null, ask: q.ask != null ? q.ask : null, delta: q.delta != null ? q.delta : null,
      oi: q.oi != null ? q.oi : null, volume: q.volume != null ? q.volume : null };
  });
  return longChooseContract_(cands, spot, LONG_CONFIG);
}

// Cached daily pick, re-quoted live on every run; re-picked when the live quote no longer passes. Failures are never cached.
function longGetContract_(ticker, spot, ctx) {
  const key = slowKey_('LONGCON', ticker);
  const cached = ctx.slowCache[key];
  if (cached && cached.date === todayKey_() && cached.value && cached.value.strike && cached.value.expiry) {
    const exp = new Date(cached.value.expiry + 'T12:00:00');
    const cand = longQuoteContract_(ticker, exp, cached.value.strike, ctx, ctx.now);
    const v = longChooseContract_([cand], spot, LONG_CONFIG);
    if (v.ok) return { ok: true, pick: cand, m: v.m };
  }
  const r = longPickContract_(ticker, spot, ctx);
  if (r.ok) {
    const rec = { date: todayKey_(), value: { expiry: longYmd_(r.pick.expiry), strike: r.pick.strike } };
    ctx.pending[key] = JSON.stringify(rec);
    ctx.slowCache[key] = rec;
  }
  Utilities.sleep(LONG_CONFIG.sleepMs);
  return r;
}


/* ============================================================================
 * ONE ROW
 * ========================================================================== */

function longMakeCtx_(tickers, now, slowCache, pending) {
  const token = getTastyTradeAccessToken_();
  return {
    now: now, token: token, slowCache: slowCache, pending: pending, finnhubKey: getFinnhubApiKey_(),
    ivRanks: cspFetchIvRanks_(tickers, token)
  };
}

function longProcessRow_(inp, ctx) {
  const now = ctx.now, cfg = LONG_CONFIG;
  const t = inp.ticker;
  const out = {};
  const incomplete = !!(inp.holdCells && !inp.isOpen);
  const missing = [];
  if (incomplete) {
    if (inp.pStrike == null) missing.push('Strike');
    if (!inp.pExpiry) missing.push('Expiry');
    if (!(inp.pEntry > 0)) missing.push('Entry (premium paid per share)');
  }
  const fillMsg = 'Qty is set but ' + (missing.length ? missing.join(', ') : 'part of the position') + ' is missing: enter it (Strike and Expiry are never overwritten while Qty is filled). Stock data on this row is live.';

  const tech = longFetchTech_(t, ctx);
  if (!tech) {
    if (incomplete) { out.Action = 'FILL IN'; out.Why = fillMsg + ' (no daily price history from Yahoo)'; out.SortKey = longSortKey_('FILL IN'); return out; }
    out.Action = 'SKIP'; out.Why = 'no daily price history from Yahoo (needs 201+ sessions)'; out.SortKey = 0; return out;
  }

  // Live spot: Tasty equity quote first, last completed close otherwise.
  let spot = null, dayChg = null;
  if (ctx.token) {
    try {
      const q = fetchTastyEquityQuote_(t, ctx.token);
      if (q && q.price != null) { spot = q.price; if (typeof q.change === 'number' && isFinite(q.change)) dayChg = q.change; }
    } catch (e) { /* fall back */ }
  }
  if (spot == null) spot = tech.price;

  const offHigh = tech.hi52 ? Math.max(0, (1 - spot / tech.hi52) * 100) : null;
  const vs200 = tech.ma200 ? (spot / tech.ma200 - 1) * 100 : null;
  const vs50 = tech.ma50 ? (spot / tech.ma50 - 1) * 100 : null;
  const vs20 = tech.ma20 ? (spot / tech.ma20 - 1) * 100 : null;
  const x50 = (tech.ma50 && tech.ma200) ? (tech.ma50 / tech.ma200 - 1) * 100 : null;
  out.Price = spot;
  if (dayChg != null) out.Change = round2_(dayChg);
  out.Trend = longTrendLabel_(vs200, x50, vs20);
  out['Off High %'] = offHigh; out['T200 %'] = vs200; out['X50 %'] = x50; out.RSI = tech.rsi; out.HV20 = tech.hv20;
  out['52w High'] = tech.hi52; out['52w Low'] = tech.lo52; out.Bounce = tech.bounce;

  const isEtf = !!inp.isEtf;
  const earnDate = isEtf ? null : longFetchEarnings_(t, ctx);
  const earnDays = earnDate ? longDaysBetween_(now, earnDate) : null;
  out['Next Earnings'] = isEtf ? 'ETF' : (earnDate || ''); out['Earn Days'] = earnDays == null ? '' : earnDays;
  const ivr = ctx.ivRanks[t] != null ? ctx.ivRanks[t] : null;
  out['IV Rank'] = ivr != null ? ivr : '';
  const target = isEtf ? null : longFetchAnalyst_(t, ctx);
  const upside = target ? (target / spot - 1) * 100 : null;
  if (target) { out.Analyst = target; out['Upside %'] = upside; }

  if (incomplete) {
    out.Action = 'FILL IN'; out.Why = fillMsg; out.SortKey = longSortKey_('FILL IN');
    if (inp.pStrike != null && inp.pExpiry) {
      try {
        const c0 = longQuoteContract_(t, inp.pExpiry, inp.pStrike, ctx, now);
        const m0 = longContractMetrics_(c0, spot);
        out.DTE = c0.dte;
        if (m0.mid != null) out.Mid = m0.mid;
        if (c0.delta != null) out.Delta = c0.delta;
      } catch (e) { /* optional */ }
    }
    return out;
  }

  // ----- a position you hold -----
  if (inp.isOpen) {
    const c = longQuoteContract_(t, inp.openExpiry, inp.openStrike, ctx, now);
    let m = longContractMetrics_(c, spot);
    let mark = m.mid;
    if (mark == null) {
      try {
        if (ctx.token) { const q = fetchTastyTradeQuote_(c.occ, ctx.token); if (q && q.mark != null) mark = q.mark; }
        if (mark == null) { const y = fetchYahooQuote_(t, inp.openExpiry, inp.openStrike, 'C'); if (y && y.mark != null) mark = y.mark; }
      } catch (e) { /* leave null */ }
      if (mark != null) m = longContractMetrics_({ bid: mark, ask: mark, delta: c.delta, strike: c.strike, dte: c.dte }, spot);
    }
    const pl = (mark != null && inp.openEntry > 0) ? (mark / inp.openEntry - 1) * 100 : null;
    const ha = longHeldAction_({ dte: c.dte, pl: pl, spot: spot, tech: tech, upside: upside, quality: inp.quality, isEtf: isEtf, carry: m.carry }, cfg);
    out.Action = ha.action; out.Why = 'HELD: ' + ha.why;
    out.Strike = inp.openStrike; out.Expiry = inp.openExpiry; out.DTE = c.dte;
    if (mark != null) out.Mid = mark;
    if (c.delta != null) out.Delta = c.delta;
    out['Spread %'] = m.spreadPct; out.OI = c.oi; out.Vol = c.volume; out.Bid = c.bid; out.Ask = c.ask;
    out['Carry %/yr'] = m.carry; out['Breakeven %'] = m.breakeven; out.Lev = m.lev; out['Extrinsic $'] = m.extrinsic;
    out['Roll By'] = new Date(inp.openExpiry.getTime() - cfg.exits.rollDte * 86400000);
    if (c.delta != null) {
      out['Stock Equiv $'] = c.delta * spot * 100 * inp.qty;
      if (mark != null) out['Capital Saved $'] = (c.delta * spot - mark) * 100 * inp.qty;
    }
    if (inp.entryDate) out.Days = longDaysBetween_(inp.entryDate, now);
    if (pl != null) { out['P/L %'] = pl; out['P/L $'] = (mark - inp.openEntry) * 100 * inp.qty; }
    if (mark != null && c.dte > 40) {
      const rk = computeLeapPremiumLoss_({ stockPrice: spot, strike: inp.openStrike, optionPrice: mark, daysToExpiry: c.dte, optionType: 'C',
        ivPercent: tech.hv20, bidAskSpreadPct: m.spreadPct, ivRank: ivr, daysToCatalyst: earnDays, momentumPercent: tech.ret5, trendPercent: vs20 });
      if (rk) { out.Risk = rk.risk; out['Risk 10%'] = rk.tierProbabilities[0] * 100; out['Risk 30%'] = rk.tierProbabilities[2] * 100; }
    }
    out.SortKey = longSortKey_(ha.action, null, pl);
    return out;
  }

  // ----- a candidate -----
  const pick = longGetContract_(t, spot, ctx);
  let contractOk = false, risk = null, score = null, m = null, c = null;
  if (pick.ok) {
    contractOk = true; c = pick.pick; m = pick.m;
    out.Expiry = c.expiry; out.Strike = c.strike; out.DTE = c.dte; out.Delta = c.delta; out.Mid = m.mid; out['Spread %'] = m.spreadPct;
    out.OI = c.oi; out.Vol = c.volume; out.Bid = c.bid; out.Ask = c.ask;
    out['Carry %/yr'] = m.carry; out['Breakeven %'] = m.breakeven; out.Lev = m.lev; out['Extrinsic $'] = m.extrinsic;
    out['Roll By'] = new Date(c.expiry.getTime() - cfg.exits.rollDte * 86400000);
    out['Stock Equiv $'] = c.delta * spot * 100; out['Capital Saved $'] = (c.delta * spot - m.mid) * 100;
    const rk = computeLeapPremiumLoss_({ stockPrice: spot, strike: c.strike, optionPrice: m.mid, daysToExpiry: c.dte, optionType: 'C',
      ivPercent: tech.hv20, bidAskSpreadPct: m.spreadPct, ivRank: ivr, daysToCatalyst: earnDays, momentumPercent: tech.ret5, trendPercent: vs20 });
    if (rk) { risk = rk.risk; out.Risk = rk.risk; out['Risk 10%'] = rk.tierProbabilities[0] * 100; out['Risk 30%'] = rk.tierProbabilities[2] * 100; }
  } else if (pick.near) {
    out.Strike = pick.near.strike; out.Expiry = pick.near.expiry;
    if (pick.near.oi != null) out.OI = pick.near.oi;
    if (pick.near.volume != null) out.Vol = pick.near.volume;
  }
  const x = { vs200: vs200, x50: x50, offHigh: offHigh, rsi: tech.rsi, ivr: ivr, bounce: tech.bounce, fall: tech.fall, lowAge: tech.lowAge,
    quality: inp.quality, isEtf: isEtf, risk: risk, contractOk: contractOk, contractWhy: pick.why, upside: upside,
    carry: m ? m.carry : null, spreadPct: m ? m.spreadPct : null, delta: c ? c.delta : null };
  if (contractOk) { score = longScore_(x).score; out.Score = score; }
  x.score = score;
  const ev = longEvaluateEntry_(x, cfg);
  out.Action = ev.action;
  const noteQ = inp.quality == null ? ' | Quality not scored yet (run Promote)' : '';
  out.Why = ev.why.filter(function (s) { return s; }).join(' | ') + noteQ + (earnDays != null && earnDays >= 0 && earnDays <= 7 ? ' | earnings in ' + earnDays + 'd (info)' : '');
  out.SortKey = longSortKey_(ev.action, score, null);
  return out;
}


/* ============================================================================
 * SCAN
 * ========================================================================== */

function runLongScan(timeBudgetMsOverride, dryRun, opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const startMs = Date.now();
  const budgetMs = (typeof timeBudgetMsOverride === 'number' && timeBudgetMsOverride > 0) ? timeBudgetMsOverride : LONG_CONFIG.timeBudgetMs;
  const now = new Date();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(LONG_SHEET_NAME);
  if (!sheet) { notify_(ui, 'Long', 'No "' + LONG_SHEET_NAME + '" tab. Run setupLong once from the Apps Script editor.'); return; }
  const map = longEnsureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { notify_(ui, 'Long', 'Add tickers in column A first.'); return; }
  const width = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  const rows = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const num = function (h) { const v = r[map[h] - 1]; const n = (v === '' || v == null) ? null : parseFloat(v); return isNaN(n) ? null : n; };
    const qty = num('Qty');
    const holdCells = qty != null && qty > 0;
    const oStrike = holdCells ? num('Strike') : null;
    const oExpiry = holdCells ? longParseDate_(r[map['Expiry'] - 1]) : null;
    const oEntry = holdCells ? num('Entry') : null;
    const complete = holdCells && oStrike != null && oExpiry && oEntry != null && oEntry > 0;
    const type = String(r[map['Type'] - 1] || '').trim().toUpperCase();
    rows.push({
      idx: i, ticker: t, isEtf: type === 'ETF' || !!LONG_ETF_SET[t], holdCells: holdCells, isOpen: !!complete, qty: qty || 1,
      openStrike: complete ? oStrike : null, openExpiry: complete ? oExpiry : null, openEntry: complete ? oEntry : null,
      pStrike: oStrike, pExpiry: oExpiry, pEntry: oEntry,
      entryDate: longParseDate_(r[map['Entry Date'] - 1]), quality: num('Quality'),
      lastRun: r[map['LastRun'] - 1] instanceof Date ? r[map['LastRun'] - 1].getTime() : 0
    });
  });
  if (!rows.length) { notify_(ui, 'Long', 'No tickers found in column A.'); return; }
  rows.sort(function (a, b) { return a.lastRun - b.lastRun; });   // stalest first, so partial runs cover everything over time
  const props = PropertiesService.getScriptProperties();
  props.setProperty('LONG_RUNNING', String(Date.now()));

  let processed = 0, timedOut = false, alertItems = [];
  const errors = [];
  const counts = {};
  try {
    const slowCache = longLoadCache_();
    // Contract picks of other tabs share nothing here; CSP's cache is not read (different keys).
    const pending = {};
    const ctx = longMakeCtx_(rows.map(function (r) { return r.ticker; }).filter(function (v, i, a) { return a.indexOf(v) === i; }), now, slowCache, pending);
    const outCols = LONG_OUTPUT_HEADERS.filter(function (h) { return map[h]; });
    const lastRunStamp = new Date();

    for (let i = 0; i < rows.length; i++) {
      if (Date.now() - startMs > budgetMs) { timedOut = true; break; }
      const rw = rows[i];
      let res;
      try {
        res = longProcessRow_(rw, ctx);
      } catch (e) {
        res = { Action: 'WAIT', Why: 'error: ' + (e && e.message ? e.message : e), SortKey: 1 };
        errors.push(rw.ticker + ': ' + (e && e.message ? e.message : e));
      }
      res.LastRun = lastRunStamp;
      try { alertItems = alertItems.concat(longBuildAlertItems_(rw, res)); } catch (e) { /* never let alert building break a scan */ }
      const row = data[rw.idx];
      const held = rw.holdCells ? LONG_HELD_WHEN_OPEN : [];
      outCols.forEach(function (h) { if (held.indexOf(h) === -1) row[map[h] - 1] = ''; });
      outCols.forEach(function (h) {
        if (held.indexOf(h) !== -1) return;
        if (res[h] !== undefined && res[h] !== null) row[map[h] - 1] = res[h];
      });
      counts[res.Action] = (counts[res.Action] || 0) + 1;
      processed++;
      Utilities.sleep(LONG_CONFIG.sleepMs);
    }

    if (!dryRun) {
      // Each contiguous group of output columns is written separately, so your input columns between them are never rewritten.
      const cols = outCols.map(function (h) { return map[h]; }).sort(function (a, b) { return a - b; });
      let g0 = 0;
      while (g0 < cols.length) {
        let g1 = g0;
        while (g1 + 1 < cols.length && cols[g1 + 1] === cols[g1] + 1) g1++;
        const c0 = cols[g0], c1 = cols[g1];
        sheet.getRange(2, c0, data.length, c1 - c0 + 1).setValues(data.map(function (r) { return r.slice(c0 - 1, c1); }));
        g0 = g1 + 1;
      }
      longColorRows_(sheet, map, data.length);
      longApplyChangeRules_(sheet, map, true);
      if (map['SortKey']) sheet.getRange(2, 1, data.length, width).sort({ column: map['SortKey'], ascending: false });
      longFlushCache_(pending);
    }
  } finally {
    props.deleteProperty('LONG_RUNNING');
  }

  let alertNote = '';
  if (!dryRun && !opts.noAlerts) {
    const ar = longDispatchAlerts_(alertItems, now);
    alertNote = ar.note ? 'Alerts: ' + ar.note + '\n' : '';
  }
  const sec = Math.round((Date.now() - startMs) / 1000);
  const order = ['TREND EXIT', 'ROLL', 'TAKE PROFIT', 'FILL IN', 'REVIEW', 'BUY', 'HOLD', 'READY', 'WAIT', 'SKIP'];
  const msg =
    (dryRun ? '(DRY RUN: nothing written)\n' : '') +
    (timedOut ? '⏱️ Stopped early at the time limit: ' + processed + ' of ' + rows.length + ' rows done. Run again to continue with the stalest rows.\n\n' : '') +
    'Rows processed: ' + processed + ' of ' + rows.length + ' in ' + sec + 's\n' + alertNote +
    order.filter(function (a) { return counts[a]; }).map(function (a) { return a + ': ' + counts[a]; }).join('   ') + '\n' +
    (errors.length ? '\nErrors:\n' + errors.map(function (e) { return '  • ' + e; }).join('\n') : '');
  notify_(ui, 'Long scan complete', msg);
  return { processed: processed, counts: counts, timedOut: timedOut };
}

function longParseDate_(v) {
  if (v == null || v === '') return null;
  if (longIsDate_(v)) return v;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function longColorRows_(sheet, map, n) {
  const colorFor = { 'BUY': '#b7e1cd', 'READY': '#d9ead3', 'WAIT': '#fff2cc', 'SKIP': '#eeeeee', 'HOLD': '#cfe2f3', 'TAKE PROFIT': '#b7e1cd',
    'TREND EXIT': '#ea9999', 'ROLL': '#fce5cd', 'REVIEW': '#f4cccc', 'FILL IN': '#f4cccc' };
  if (map['Action']) {
    const rng = sheet.getRange(2, map['Action'], n, 1);
    rng.setBackgrounds(rng.getValues().map(function (v) { return [colorFor[v[0]] || null]; }));
  }
  if (map['Risk']) {
    const rng = sheet.getRange(2, map['Risk'], n, 1);
    rng.setBackgrounds(rng.getValues().map(function (v) {
      const x = v[0]; if (x === '' || isNaN(x)) return [null];
      return [x <= 20 ? '#b7e1cd' : (x <= LONG_CONFIG.entry.riskGate ? '#fff2cc' : '#f4cccc')];
    }));
  }
  if (map['Score']) {
    const rng = sheet.getRange(2, map['Score'], n, 1);
    rng.setBackgrounds(rng.getValues().map(function (v) {
      const x = v[0]; if (x === '' || isNaN(x)) return [null];
      return [x >= LONG_CONFIG.entry.scoreBuy ? '#b7e1cd' : (x >= LONG_CONFIG.entry.scoreReady ? '#fff2cc' : null)];
    }));
  }
  ['P/L %', 'P/L $'].forEach(function (h) {
    if (!map[h]) return;
    const rng = sheet.getRange(2, map[h], n, 1);
    rng.setFontColors(rng.getValues().map(function (v) {
      const x = v[0]; if (x === '' || isNaN(x)) return [null];
      return [x > 0 ? '#38761d' : (x < 0 ? '#cc0000' : null)];
    }));
  });
}


/* ============================================================================
 * ALERTS — Telegram / Pushover / ntfy through the existing phone-alert setup (sendPhoneAlert_).
 * One batched message per run. State is saved only when the message actually went out, so a failed send retries next run.
 * ========================================================================== */

function longAlertsOn_() {
  return PropertiesService.getScriptProperties().getProperty('LONG_ALERTS') !== 'false';
}

function longBuildAlertItems_(rw, res) {
  const items = [];
  const t = rw.ticker;
  const r2 = function (v) { return (v === '' || v == null || isNaN(v)) ? '?' : (Math.round(v * 100) / 100).toFixed(2); };
  const a = res.Action;
  if (rw.isOpen && longIsDate_(rw.openExpiry)) {
    const label = t + ' $' + rw.openStrike + 'C ' + Utilities.formatDate(rw.openExpiry, Session.getScriptTimeZone(), 'MMM d yyyy');
    const key = a + '|' + t + '|' + rw.openStrike + '|' + longYmd_(rw.openExpiry);
    const why = String(res.Why || '').replace(/^HELD: /, '');
    const mk = ' Mid ' + r2(res.Mid) + ' vs entry ' + r2(rw.openEntry) + (res['P/L %'] !== '' && res['P/L %'] != null ? ' (' + r2(res['P/L %']) + '%)' : '') + '.';
    if (a === 'TREND EXIT') items.push({ kind: 'exit', key: key, text: 'TREND EXIT ' + label + ': ' + why + '.' + mk + ' Plan says leave on a trend break.' });
    else if (a === 'ROLL') items.push({ kind: 'roll', key: key, text: 'ROLL ' + label + ': ' + why + '.' + mk });
    else if (a === 'TAKE PROFIT') items.push({ kind: 'tp', key: key, text: 'TAKE PROFIT ' + label + ': ' + why + '.' + mk + ' You decide how much.' });
    else if (a === 'REVIEW') items.push({ kind: 'review', key: key, text: 'REVIEW ' + label + ': ' + why });
  } else if (a === 'BUY' && longIsDate_(res.Expiry)) {
    items.push({
      kind: 'buy', key: 'BUY|' + t + '|' + longYmd_(res.Expiry),
      text: 'BUY ' + t + ' ' + Utilities.formatDate(res.Expiry, Session.getScriptTimeZone(), 'MMM d yyyy') + ' $' + res.Strike + 'C @ ' + r2(res.Mid) +
        ' (' + res.DTE + 'd, delta ' + r2(res.Delta) + ', carry ' + r2(res['Carry %/yr']) + '%/yr, spread ' + r2(res['Spread %']) + '%, Risk ' + r2(res.Risk) +
        ', Score ' + r2(res.Score) + '). Stock equiv $' + Math.round(res['Stock Equiv $']) + ' for $' + Math.round(res.Mid * 100) + ' per contract.'
    });
  }
  return items;
}

// Returns { sent, note }. Never throws.
function longDispatchAlerts_(items, now) {
  try {
    if (!items || !items.length) return { sent: 0, note: '' };
    if (!longAlertsOn_()) return { sent: 0, note: 'Long alerts are switched off (menu: Long > Long Alerts & Schedule).' };
    const cfg = getAlertConfig_();
    if (!cfg.ready) return { sent: 0, note: 'phone alerts are not set up or are off (menu: Quick and Leap > Phone Alerts).' };
    const props = PropertiesService.getScriptProperties();
    let state = {};
    try { state = JSON.parse(props.getProperty('LONG_ALERT_STATE') || '{}'); } catch (e) { state = {}; }
    const A = LONG_CONFIG.alerts;
    const hoursFor = { exit: A.exitRepeatHours, roll: A.rollRepeatHours, tp: A.tpRepeatHours, review: A.reviewRepeatHours, buy: A.buyRepeatHours };
    const nowMs = now.getTime();
    const fresh = items.filter(function (it) { const prev = state[it.key]; return !prev || nowMs - prev >= hoursFor[it.kind] * 3600000; });
    if (!fresh.length) return { sent: 0, note: items.length + ' signal(s), all already alerted within their repeat window.' };
    const order = { exit: 0, roll: 1, tp: 2, review: 3, buy: 4 };
    fresh.sort(function (a, b) { return order[a.kind] - order[b.kind]; });
    const n = function (k) { return fresh.filter(function (it) { return it.kind === k; }).length; };
    const parts = [];
    if (n('exit')) parts.push(n('exit') + ' trend exit');
    if (n('roll')) parts.push(n('roll') + ' roll');
    if (n('tp')) parts.push(n('tp') + ' take-profit');
    if (n('review')) parts.push(n('review') + ' review');
    if (n('buy')) parts.push(n('buy') + ' BUY');
    const r = sendPhoneAlert_(cfg, 'Long: ' + parts.join(', '), fresh.map(function (it) { return it.text; }).join('\n\n'), n('exit') > 0 || n('tp') > 0);
    if (!r.ok) { logToSheet_('Long alert failed: ' + r.detail); return { sent: 0, note: 'send failed (' + r.detail + ')' }; }
    fresh.forEach(function (it) { state[it.key] = nowMs; });
    Object.keys(state).forEach(function (k) { if (nowMs - state[k] > 14 * 86400000) delete state[k]; });
    props.setProperty('LONG_ALERT_STATE', JSON.stringify(state));
    return { sent: fresh.length, note: 'sent ' + fresh.length + ' (' + parts.join(', ') + ')' };
  } catch (e) {
    logToSheet_('Long alert error: ' + e);
    return { sent: 0, note: 'error: ' + e };
  }
}

function sendTestLongAlert_() {
  const ui = tryGetUi_();
  const cfg = getAlertConfig_();
  if (!cfg.ready) { notify_(ui, 'Long alert test', 'Phone alerts are not set up or are off. Use Quick and Leap > Phone Alerts first (the same Telegram setup serves Long).'); return; }
  const r = sendPhoneAlert_(cfg, 'Long: test', 'Test alert from the Long tab. A real one looks like:\nBUY KO Dec 17 2027 $55C @ 14.20 (430d, delta 0.86, carry 4.1%/yr, spread 0.9%, Risk 18.5, Score 72.0). Stock equiv $6200 for $1420 per contract.', false);
  notify_(ui, 'Long alert test', r.ok ? 'Sent. ' + r.detail : 'Failed: ' + r.detail);
}

function toggleLongAlerts_() {
  const ui = tryGetUi_();
  const props = PropertiesService.getScriptProperties();
  const nowOn = longAlertsOn_();
  props.setProperty('LONG_ALERTS', nowOn ? 'false' : 'true');
  notify_(ui, 'Long alerts', 'Long alerts are now ' + (nowOn ? 'OFF' : 'ON') + '. (Other tabs\' alerts are unaffected.)');
}


/* ============================================================================
 * SCHEDULE — hourly trigger; the tick exits at once outside US market hours.
 *   market hours: one full scan per tick (cheap after the first of the day: contracts and daily bars are cached)
 *   pre-market (06:00 to open): research promotion, once a day
 * ========================================================================== */

const LONG_TICK_FN = 'longScheduledTick_';

function longEtParts_(now) {
  const tz = 'America/New_York';
  return { dow: parseInt(Utilities.formatDate(now, tz, 'u'), 10), hhmm: Utilities.formatDate(now, tz, 'HH:mm'), ymd: Utilities.formatDate(now, tz, 'yyyy-MM-dd') };
}

function longWithinMarketHours_(now) {
  const p = longEtParts_(now);
  return p.dow >= 1 && p.dow <= 5 && p.hhmm >= LONG_CONFIG.schedule.startHHmm && p.hhmm <= LONG_CONFIG.schedule.endHHmm;
}

function longRemoveTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === LONG_TICK_FN) { ScriptApp.deleteTrigger(t); n++; } });
  return n;
}

function startLongSchedule_() {
  const ui = tryGetUi_();
  longRemoveTriggers_();
  ScriptApp.newTrigger(LONG_TICK_FN).timeBased().everyHours(1).create();
  notify_(ui, 'Long schedule started',
    'Runs hourly. Outside Mon-Fri ' + LONG_CONFIG.schedule.startHHmm + '-' + LONG_CONFIG.schedule.endHHmm + ' ET it exits immediately.\n' +
    'Each in-hours tick scans every row (stalest first); the first tick of the day is the slow one (picks contracts), later ticks are quick.\n' +
    'Research promotion runs once a day before the open. Telegram alerts go through the existing phone-alert setup.');
}

function stopLongSchedule_() {
  notify_(tryGetUi_(), 'Long schedule', 'Stopped (' + longRemoveTriggers_() + ' trigger(s) removed).');
}

function longScheduleStatus_() {
  const props = PropertiesService.getScriptProperties();
  const n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === LONG_TICK_FN; }).length;
  const lastFull = parseInt(props.getProperty('LONG_LAST_FULL') || '0', 10);
  const cfg = getAlertConfig_();
  notify_(tryGetUi_(), 'Long schedule status',
    'Schedule: ' + (n ? 'ON (' + n + ' trigger)' : 'OFF') + '\n' +
    'Last complete scan: ' + (lastFull ? new Date(lastFull).toString() : 'never') + '\n' +
    'Last research promotion: ' + (props.getProperty('LONG_LAST_PROMOTE') || 'never') + '\n' +
    'Long alerts: ' + (longAlertsOn_() ? 'ON' : 'OFF') + '; phone provider ' + (cfg.ready ? 'ready (' + cfg.provider + ')' : 'NOT ready'));
}

function longScheduledTick_() {
  const now = new Date();
  const p = longEtParts_(now);
  if (p.dow < 1 || p.dow > 5) return;
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('LONG_RUNNING') || '0', 10);
  if (running && Date.now() - running < 10 * 60000) return;      // a run is already in progress

  const promoteDone = props.getProperty('LONG_LAST_PROMOTE') === p.ymd;
  const inMarket = longWithinMarketHours_(now);
  const runPromote = function (budgetMs) {
    props.setProperty('LONG_RUNNING', String(Date.now()));
    try {
      const pr = longPromoteFromResearch_({ quiet: true, timeBudgetMs: budgetMs });
      if (pr && pr.complete) props.setProperty('LONG_LAST_PROMOTE', p.ymd);
    } catch (e) { logToSheet_('Long promote error: ' + e); }
    props.deleteProperty('LONG_RUNNING');
  };

  if (!inMarket) {
    if (!promoteDone && p.hhmm >= '06:00' && p.hhmm < LONG_CONFIG.schedule.startHHmm) runPromote(250000);
    return;
  }
  const t0 = Date.now();
  if (!promoteDone) runPromote(100000);        // fallback: schedule started after the pre-market window
  const remaining = Math.max(60000, 280000 - (Date.now() - t0));
  const r = runLongScan(remaining, false, { quiet: true });
  if (r && !r.timedOut) props.setProperty('LONG_LAST_FULL', String(Date.now()));
}


/* ============================================================================
 * RESEARCH PROMOTION — which quality names deserve a row on this tab
 * ----------------------------------------------------------------------------
 * Moat cannot be read off a data feed. This reuses the CSP quality screen (return on equity, margins, free cash flow, leverage,
 * growth, 5-year record, size) and adds: market cap >= $50B, ROE >= 12%, operating margin >= 10% for stocks. It will miss
 * brand / network-effect judgment and can be fooled by buybacks (ROE) or one good year. It builds the shortlist, it does not replace your view.
 * "Hold comfortably if stuck" is approximated by the 5-year worst drawdown and leverage terms in the score.
 * Option liquidity is NOT checked here: a name with no usable LEAP shows SKIP on the scan.
 * ========================================================================== */

function longReadTickerColumn_(sheetName) {
  return (typeof cspReadTickerColumn_ === 'function') ? cspReadTickerColumn_(sheetName) : [];
}

function longEvaluateTicker_(t, isEtf, ctx) {
  const tech = longFetchTech_(t, ctx);
  const techForGates = tech ? { price: tech.price, ma50: tech.ma50, ma200: tech.ma200, hi52: tech.hi52 } : null;
  const wRes = getSlowCached_(ctx.slowCache, ctx.pending, 'CSPW5', t, 7, function () { return cspFetchWeekly5y_(t); });
  if (wRes.fetchAttempted) Utilities.sleep(LONG_CONFIG.sleepMs);
  let f = null;
  if (!isEtf) {
    const fRes = getSlowCached_(ctx.slowCache, ctx.pending, 'CSPFUND', t, 14, function () { return cspFetchFundamentals_(t); });
    if (fRes.fetchAttempted) Utilities.sleep(LONG_CONFIG.sleepMs);
    f = fRes.value;
  }
  const q = isEtf ? cspQualityEtf_(wRes.value, techForGates, LONG_CONFIG) : cspQualityStock_(f, wRes.value, techForGates, LONG_CONFIG);
  if (!isEtf && f) {
    if (f.roe != null && f.roe * 100 < LONG_CONFIG.promote.minRoePct) q.fails.push('ROE ' + longRound_(f.roe * 100, 1) + '% < ' + LONG_CONFIG.promote.minRoePct + '%');
    if (f.opm != null && f.opm * 100 < LONG_CONFIG.promote.minOpmPct) q.fails.push('operating margin ' + longRound_(f.opm * 100, 1) + '% < ' + LONG_CONFIG.promote.minOpmPct + '%');
  }
  q.ticker = t; q.isEtf = isEtf; q.price = tech ? tech.price : null;
  q.minScore = isEtf ? LONG_CONFIG.promote.minEtfScore : LONG_CONFIG.promote.minStockScore;
  q.qualifies = q.fails.length === 0 && q.score >= q.minScore;
  return q;
}

// Quality screens already cached by the CSP tab (weekly 5y, fundamentals) are reused read-only: the first Long promote is then fast.
function longPromoteCache_() {
  const merged = {};
  try { const c = (typeof cspLoadCache_ === 'function') ? cspLoadCache_() : {}; Object.keys(c).forEach(function (k) { if (/^SLOW_(CSPW5|CSPFUND)_/.test(k)) merged[k] = c[k]; }); } catch (e) { /* none */ }
  const own = longLoadCache_();
  Object.keys(own).forEach(function (k) { merged[k] = own[k]; });
  return merged;
}

function longUniverse_(sheetRows) {
  const never = {};
  longNever_().forEach(function (t) { never[t] = true; });
  const u = {};
  LONG_STOCK_UNIVERSE.forEach(function (t) { if (!never[t]) u[t] = { isEtf: false }; });
  LONG_ETF_UNIVERSE.forEach(function (t) { u[t] = { isEtf: true }; });
  // Only the Long lists above plus rows you pinned (Qty filled or Ticker cell colored). The Research / Quick / Leap tabs are NOT used: they hold
  // high-volatility names that do not fit "comfortable to hold for years".
  (sheetRows || []).forEach(function (rw) { if (!u[rw.ticker] && (rw.held || rw.colored)) u[rw.ticker] = { isEtf: rw.isEtf }; });
  return u;
}

// Rewrites the Long block of the Universe tab (sheet reads/writes only: no API calls). Sector / Industry / Cap tier you already filled are kept.
function longUpdateUniverse() {
  const ui = tryGetUi_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const uni = ss.getSheetByName('Universe') || ss.insertSheet('Universe');
  const HEAD = ['Long Ticker', 'Sector', 'Industry', 'Cap tier (hand classification)', 'Type', 'On Long tab now', 'Sector source'];
  const startCol = longUniverseStartCol_(uni, HEAD[0]);
  const old = {};
  if (uni.getLastRow() >= 2) uni.getRange(2, startCol, uni.getLastRow() - 1, HEAD.length).getValues().forEach(function (r) { const t = String(r[0] || '').trim().toUpperCase(); if (t) old[t] = r; });
  const left = {};
  if (uni.getLastRow() >= 2) uni.getRange(2, 1, uni.getLastRow() - 1, 4).getValues().forEach(function (r) { const t = String(r[0] || '').trim().toUpperCase(); if (t) left[t] = r; });
  const overrides = (typeof loadSectorOverrides_ === 'function') ? loadSectorOverrides_() : {};
  const onTab = {};
  const sheetRows = [];
  longReadTickerColumn_(LONG_SHEET_NAME).forEach(function (t) { onTab[t] = true; sheetRows.push({ ticker: t, isEtf: !!LONG_ETF_SET[t] }); });
  const uniMap = longUniverse_(sheetRows);
  const list = Object.keys(uniMap);
  let fresh = 0, unclassified = 0;
  const rows = list.map(function (t) {
    const isEtf = !!uniMap[t].isEtf;
    const o = old[t];
    if (o && String(o[1] || '').trim() !== '' && String(o[1]).trim() !== '?' && String(o[1]).trim() !== 'unclassified') return [t, o[1], o[2], o[3], isEtf ? 'ETF' : 'Stock', onTab[t] ? 'Yes' : '', o[6] || ''];
    let sec = '', ind = '', cap = '', src = '';
    const ov = overrides[t], st = (typeof STATIC_SECTOR_MAP !== 'undefined') ? STATIC_SECTOR_MAP[t] : null, lf = left[t];
    if (ov && ov.sector) { sec = ov.sector; ind = ov.industry || ''; src = 'Sector override'; }
    else if (st) { sec = st.sector; ind = st.industry; src = 'Project STATIC_SECTOR_MAP'; }
    else if (lf && String(lf[1] || '').trim() !== '') { sec = lf[1]; ind = lf[2]; cap = lf[3]; src = 'Quick/Leap block'; }
    else if (isEtf) { sec = 'ETF'; src = 'ETF'; }
    else { sec = 'unclassified'; src = 'unclassified'; unclassified++; }
    fresh++;
    return [t, sec, ind, cap || (isEtf ? 'ETF' : 'Large/mega (assumed)'), isEtf ? 'ETF' : 'Stock', onTab[t] ? 'Yes' : '', src];
  });
  if (uni.getMaxColumns() < startCol + HEAD.length - 1) uni.insertColumnsAfter(uni.getMaxColumns(), startCol + HEAD.length - 1 - uni.getMaxColumns());
  uni.getRange(2, startCol, Math.max(uni.getMaxRows() - 1, 1), HEAD.length).clearContent();
  uni.getRange(1, startCol, 1, HEAD.length).setValues([HEAD]);
  if (rows.length) {
    if (uni.getMaxRows() < rows.length + 1) uni.insertRowsAfter(uni.getMaxRows(), rows.length + 1 - uni.getMaxRows());
    uni.getRange(2, startCol, rows.length, HEAD.length).setValues(rows);
  }
  notify_(ui, 'Long universe updated',
    rows.length + ' tickers written to the Universe tab (columns from ' + startCol + ').\n' +
    'Sources: built-in stock + ETF lists, the Research / Quick / Leap tabs (large/mega only), and the Long tab.\n' +
    'New or re-classified: ' + fresh + (unclassified ? ' (' + unclassified + ' unclassified: type the sector in, it is kept next time)' : '') + '.\n\n' +
    'This lists who Long looks at. Who qualifies is decided by Promote Research Picks to Long.');
  return { count: rows.length, fresh: fresh };
}

// The Long block starts where its header already is (so moving the block is safe); first-time default is column AC (29), right of the Flip block (T:AA).
function longUniverseStartCol_(uni, header) {
  try {
    const row = uni.getRange(1, 1, 1, Math.max(uni.getLastColumn(), 1)).getValues()[0];
    for (let i = 0; i < row.length; i++) if (String(row[i]).trim() === header) return i + 1;
  } catch (e) { /* default below */ }
  return 29;
}

// Wrapper: logs STARTED / COMPLETE / NOT COMPLETE to ScriptLog (a fresh run first wipes old ScriptLog rows, as the CSP promotion does).
function longPromoteFromResearch_(opts) {
  opts = opts || {};
  const props = PropertiesService.getScriptProperties();
  const src = opts.quiet ? 'scheduled' : 'manual';
  const t0 = Date.now();
  let cont = false;
  if (opts.dryRun) {
    logToSheet_('Long research+promote (dry run, nothing will be written): started');
  } else {
    cont = props.getProperty('LONG_PROMO_OPEN') === '1';
    if (!cont && typeof cspClearScriptLog_ === 'function') cspClearScriptLog_();
    props.setProperty('LONG_PROMO_OPEN', '1');
    logToSheet_('Long research+promote ' + (cont ? 'CONTINUING after an unfinished run' : 'STARTED') + ' (' + src + ')');
  }
  let res;
  try {
    res = longPromoteCore_(opts);
  } catch (e) {
    logToSheet_('Long research+promote FAILED: ' + (e && e.message ? e.message : e) + ' (the next run continues from cached scores)');
    throw e;
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  if (res && res.complete) {
    if (!opts.dryRun) props.deleteProperty('LONG_PROMO_OPEN');
    logToSheet_('Long research+promote COMPLETE in ' + sec + 's: ' + res.chosen.length + ' names qualify; added ' +
      (res.added.length ? res.added.join(', ') : 'none') + '; removed ' + (res.removed.length ? res.removed.join(', ') : 'none'));
  } else {
    logToSheet_('Long research+promote NOT COMPLETE after ' + sec + 's' +
      (res && res.total ? ': ' + res.scored + ' of ' + res.total + ' tickers scored, sheet unchanged. ' : '. ') +
      'The next run continues from cached scores (scheduled runs retry automatically; or run Promote Research Picks again).');
  }
  return res;
}

function longPromoteCore_(opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const P = LONG_CONFIG.promote;
  const start = Date.now();
  const budgetMs = opts.timeBudgetMs || P.timeBudgetMs;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(LONG_SHEET_NAME);
  if (!sheet) { notify_(ui, 'Long promote', 'No Long tab. Run setupLong once from the Apps Script editor.'); return { complete: false }; }
  const map = longEnsureHeaders_(sheet);
  const width = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const data = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];
  const bgs = lastRow >= 2 ? sheet.getRange(2, map['Ticker'], lastRow - 1, 1).getBackgrounds() : [];

  const onSheet = {}, sheetRows = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const type = String(r[map['Type'] - 1] || '').trim().toUpperCase();
    const row = {
      idx: i, ticker: t, source: String(r[map['Source'] - 1] || '').trim(), type: type, isEtf: type === 'ETF' || !!LONG_ETF_SET[t],
      held: parseFloat(r[map['Qty'] - 1]) > 0,
      colored: !!(bgs[i] && bgs[i][0] && bgs[i][0] !== '#ffffff')
    };
    onSheet[t] = row; sheetRows.push(row);
  });
  const universe = longUniverse_(sheetRows);

  const slowCache = longPromoteCache_();
  const pending = {};
  const ctx = { slowCache: slowCache, pending: pending };
  const evals = {};
  const names = Object.keys(universe);
  let complete = true;
  for (let i = 0; i < names.length; i++) {
    if (Date.now() - start > budgetMs) { complete = false; break; }
    const t = names[i];
    try { evals[t] = longEvaluateTicker_(t, universe[t].isEtf, ctx); }
    catch (e) { evals[t] = { ticker: t, isEtf: universe[t].isEtf, score: 0, fails: ['error: ' + e], qualifies: false, parts: {} }; }
  }
  longFlushCache_(pending);
  if (!complete) {
    notify_(ui, 'Long promote', 'Stopped at the time limit after ' + Object.keys(evals).length + ' of ' + names.length + ' tickers. Nothing was changed on the sheet. Run again: finished tickers are cached, so the next pass is fast.');
    return { complete: false, scored: Object.keys(evals).length, total: names.length };
  }

  // Pinned rows (Qty filled = you hold it, or Ticker cell colored) always stay and use up slots. The rest of the 30 goes to the best-scoring
  // qualifying names (at most maxEtfs ETFs). Every other unpinned row is removed: this is what keeps the tab at 30.
  const pinned = {};
  sheetRows.forEach(function (rw) { if (rw.held || rw.colored) pinned[rw.ticker] = true; });
  const slots = Math.max(0, P.maxTotal - Object.keys(pinned).length);
  const ranked = Object.keys(evals).map(function (t) { return evals[t]; }).filter(function (q) { return q.qualifies && !pinned[q.ticker]; })
    .sort(function (a, b) { return b.score - a.score; });
  const chosen = {};
  let nEtf = 0, nStock = 0;
  ranked.forEach(function (q) {
    if (Object.keys(chosen).length >= slots) return;
    if (q.isEtf) { if (nEtf >= P.maxEtfs) return; nEtf++; } else nStock++;
    chosen[q.ticker] = q;
  });
  const rs = { length: nStock }, re = { length: nEtf };

  const props = PropertiesService.getScriptProperties();
  const toAdd = Object.keys(chosen).filter(function (t) { return !onSheet[t]; });
  const toRemove = [], keptHeld = [];
  sheetRows.forEach(function (rw) {
    if (chosen[rw.ticker]) return;
    if (pinned[rw.ticker]) { if (!(evals[rw.ticker] && evals[rw.ticker].qualifies)) keptHeld.push(rw.ticker); return; }
    const q = evals[rw.ticker];
    // A failed data fetch is not a verdict: keep the row until it can be scored.
    if (q && q.fails.some(function (f) { return /^error|no fundamentals|no 5-year|no daily/.test(f); })) return;
    toRemove.push(rw);
  });

  if (!opts.dryRun) {
    if (map['Quality'] && data.length) {
      const col = data.map(function (r) { return [r[map['Quality'] - 1]]; });
      sheetRows.forEach(function (rw) { const q = evals[rw.ticker]; if (q) col[rw.idx][0] = q.score; });
      sheet.getRange(2, map['Quality'], col.length, 1).setValues(col);
    }
    toRemove.sort(function (a, b) { return b.idx - a.idx; }).forEach(function (rw) { sheet.deleteRow(rw.idx + 2); });
    if (toAdd.length) {
      const tickCol = sheet.getRange(2, map['Ticker'], Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
      let lastTicker = 1;
      for (let i = tickCol.length - 1; i >= 0; i--) { if (String(tickCol[i][0]).trim() !== '') { lastTicker = i + 2; break; } }
      const w2 = sheet.getLastColumn();
      const out = toAdd.map(function (t) {
        const q = chosen[t];
        const row = new Array(w2).fill('');
        row[map['Ticker'] - 1] = t; row[map['Source'] - 1] = 'Research'; row[map['Type'] - 1] = q.isEtf ? 'ETF' : 'Stock'; row[map['Quality'] - 1] = q.score;
        return row;
      });
      const need = lastTicker + out.length - sheet.getMaxRows();
      if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
      sheet.getRange(lastTicker + 1, 1, out.length, w2).setValues(out);
      longFormatSheet_(sheet);
    }
  }

  const failCounts = {};
  Object.keys(evals).forEach(function (t) {
    const q = evals[t];
    if (q.qualifies) return;
    if (q.fails.length) q.fails.forEach(function (f) { const k = f.replace(/[0-9.]+/g, '#'); failCounts[k] = (failCounts[k] || 0) + 1; });
    else failCounts['score under the bar'] = (failCounts['score under the bar'] || 0) + 1;
  });
  const topFails = Object.keys(failCounts).sort(function (a, b) { return failCounts[b] - failCounts[a]; }).slice(0, 5).map(function (k) { return k + ' (' + failCounts[k] + ')'; }).join('; ');
  notify_(ui, 'Long research promotion',
    (opts.dryRun ? '(DRY RUN: nothing written)\n' : '') +
    'Scored ' + names.length + ' tickers in ' + Math.round((Date.now() - start) / 1000) + 's.\n' +
    'Kept on the tab: ' + rs.length + ' stocks + ' + re.length + ' ETFs (max ' + P.maxEtfs + ') + ' + Object.keys(pinned).length + ' pinned = at most ' + P.maxTotal + '.\n' +
    'Added: ' + (toAdd.length ? toAdd.join(', ') : 'none') + '\n' +
    'Removed (not in the top ' + P.maxTotal + '): ' + (toRemove.length ? toRemove.map(function (r) { return r.ticker; }).join(', ') : 'none') + '\n' +
    (keptHeld.length ? 'Kept despite dropping out (held position or colored cell): ' + keptHeld.join(', ') + '\n' : '') +
    (topFails ? 'Most common reasons for rejection: ' + topFails : ''));
  return { complete: true, added: toAdd, removed: toRemove.map(function (r) { return r.ticker; }), chosen: Object.keys(chosen) };
}


/* ============================================================================
 * DEBUG — one ticker, full decision trail, nothing written
 * ========================================================================== */

function debugLongOneTicker() {
  const ui = tryGetUi_();
  if (!ui) { logToSheet_('Long debug: run it from the sheet menu (it asks for a ticker).'); return; }
  const r = ui.prompt('Long: one ticker', 'Ticker (shown as a new candidate; nothing is written):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = String(r.getResponseText() || '').trim().toUpperCase();
  if (!t) return;
  const ctx = longMakeCtx_([t], new Date(), longLoadCache_(), {});
  const out = longProcessRow_({ ticker: t, isEtf: !!LONG_ETF_SET[t], holdCells: false, isOpen: false, qty: 1, quality: null }, ctx);
  const lines = Object.keys(out).map(function (k) { const v = out[k]; return k + ': ' + (longIsDate_(v) ? longYmd_(v) : (typeof v === 'number' ? longRound_(v, 3) : v)); });
  notify_(ui, 'Long: ' + t, lines.join('\n'));
}