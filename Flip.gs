/* ============================================================================
 * FlipEngine.gs — "Flip" tab: short-hold trades in deep in-the-money calls (stock proxies)
 * ----------------------------------------------------------------------------
 * OBJECTIVE (same as Quick): take a small profit on the option premium fast.
 *   +3% within about 5 trading days (+1.5% if it is the same day), then get out. If it has
 *   not worked by day 7 cut it loose; no position is carried past day 10.
 *
 * WHAT IS DIFFERENT FROM QUICK (built from the Results log, see claude/flip_tab_proposal):
 *   1. EXPECTANCY, NOT WIN RATE. Every row shows what the trade costs you in skill:
 *      Need % (stock move for the target after the spread), P Hit % (chance the target is hit
 *      before the stop on a random walk) and Edge Needed (points of win rate above random you
 *      must deliver to break even). A small target with a wide stop wins often and loses big;
 *      on a random walk that nets to about zero before the spread.
 *   2. EVERY ROW HAS A STOP. Stop = 1 daily ATR of the stock, converted to option %, clamped
 *      to 6-14%. Plus a time-stop at day 7 and a hard cut at day 10.
 *   3. PORTFOLIO GUARDS. BLOCKED when: too many open positions, too many in one theme, too many
 *      entries today, or the open book is already down more than the limit.
 *   4. STOCK-PROXY CONTRACT RULE. Delta >= 0.75, spread <= 1.5%, time value capped. Among the
 *      contracts that pass, the one with the lowest friction (spread + decay) per unit of
 *      leverage wins.
 *   5. FALLING-KNIFE FILTER. Stocks more than 40% under their 52-week high are SKIP.
 *   6. SELF-GRADING. Every BUY / READY signal is logged (FlipLog) and graded 1-10 days later
 *      against daily highs/lows, independent of what you did. FlipStats compares the
 *      hit rate with the P Hit % the sheet predicted, counts open positions in the win
 *      rate, and shows concentration, hold times and per-ticker results.
 *
 * ENTRY TRIGGER stays your method: 5-minute Aroon up/down trend + 1-minute RSI dip near 30 and
 * turning up (reuses evaluateEntryLevel_ / evaluateQuickExit_ from Momentum.gs). Exits reuse
 * your RSI 65+ rule.
 *
 * SEPARATE FROM QUICK/LEAP/CSP: own tab, own universe + promotion (Fit), own cache sheet
 * (FlipCache), own log (FlipLog), own stats (FlipStats), own trigger, own alert state.
 * Quick is untouched. Shares only Yahoo/Tasty/Cloud Function rate limits and the Telegram setup.
 *
 * SETUP (once): run  setupFlip  from the Apps Script editor (creates the tab + "🔁 Flip" menu).
 * Apps Script only — NO Cloud Function redeploy (uses the existing intraday, daily and option
 * quote endpoints).
 *
 * RE-USES (from the other files): getTastyTradeAccessToken_, fetchTastyOptionChainNested_,
 * fetchTastyMarketDataBatch_, fetchIntradayMap_, fetchOptionQuotesMap_, evaluateEntryLevel_,
 * evaluateQuickExit_, INTRADAY_SIGNAL, marketSessionAt_, sendPhoneAlert_, getAlertConfig_,
 * getCloudFunctionUrl_, getCloudFunctionSharedSecret_, fetchFinnhubNextEarnings_,
 * fetchYahooNextEarnings_, getFinnhubApiKey_, impliedVolatilityBisection_,
 * blackScholesDelta_, blackScholesPrice_, buildOccSymbol_, normCdf_, logToSheet_, notify_,
 * tryGetUi_, round2_, isPlausible_.
 * ========================================================================== */

const FLIP_SHEET_NAME = 'Flip';
const FLIP_CACHE_SHEET = 'FlipCache';
const FLIP_LOG_SHEET = 'FlipLog';
const FLIP_STATS_SHEET = 'FlipStats';
const FLIP_RESULTS_SHEET = 'Results';
const FLIP_QUICK_SHEET = 'Quick';

const FLIP_CONFIG = {
  // --- contract: a stock proxy, not a lottery ticket ------------------------------------------
  minDte: 150, maxDte: 520, targetDte: 300,
  minDelta: 0.75,
  maxSpreadPct: 1.5,          // option bid/ask gap as % of mid (the same cap your Quick signals use)
  minOi: 100,
  minMid: 5,
  maxTimeValuePct: 30,        // time value as % of the option price
  decayDays: 2,               // expected hold used when pricing decay into friction
  // --- exits ----------------------------------------------------------------------------------
  targetPct: 3,               // net of the selling spread
  sameDayTargetPct: 1.5,
  horizonDays: 5,             // "within about 5 trading days"
  stopAtrMult: 1.0,           // stop distance = this x daily ATR% of the stock (in stock terms)
  stopMinPct: 6, stopMaxPct: 14,   // option % bounds on the stop
  timeStopDays: 7, hardStaleDays: 10, timeStopMinGainPct: 1.5,
  // --- entry gates ----------------------------------------------------------------------------
  maxOffHighPct: 40,          // falling-knife filter: more than this % under the 52-week high -> SKIP
  minAtrPct: 1.8, maxAtrPct: 9,
  minPrice: 20,
  earnBlockDays: 3,           // earnings inside this many days -> SKIP (gap risk, IV crush)
  maxEdgeNeeded: 10,          // points of win rate above random needed; above this -> WAIT
  scoreBuy: 60, scoreReady: 45,
  // --- portfolio guards -----------------------------------------------------------------------
  maxOpen: 6, maxPerTheme: 2, maxNewPerDay: 3,
  maxOpenLossPct: 10,         // open book down more than this % of invested -> no new entries
  riskPerTradeUsd: 500,       // size column: contracts so that the stop costs about this much
  // --- promotion ------------------------------------------------------------------------------
  promote: { maxKeep: 30, minFit: 60, minDollarVolM: 1000, removeAfterMisses: 5, timeBudgetMs: 4 * 60 * 1000, probeMaxAgeDays: 4 },
  // --- runtime --------------------------------------------------------------------------------
  timeBudgetMs: 4.5 * 60 * 1000, sleepMs: 60,
  // --- schedule (US/Eastern) ------------------------------------------------------------------
  schedule: { startHHmm: '09:35', endHHmm: '15:55', fullScanEveryMin: 30, gradeAfterHHmm: '16:10' },
  alerts: { buyRepeatMin: 120, exitRepeatMin: 60, readyRepeatMin: 240, alertReady: false },
  logCooldownMin: 60
};

// Your entry trigger and exit rules come from INTRADAY_SIGNAL (Momentum.gs); Flip overrides only what it must.
const FLIP_SIGNAL = Object.assign({}, INTRADAY_SIGNAL, { exitMinProfitPct: 1.5, bounceLane: true });

// Looked at by the promotion; the numbers decide who is kept. Liquid, large names with enough daily range to flip.
const FLIP_UNIVERSE = [
  'NVDA', 'AMD', 'AVGO', 'MRVL', 'MU', 'ARM', 'TSM', 'ANET', 'CRDO', 'SMCI', 'AMAT', 'LRCX', 'KLAC', 'QCOM', 'INTC', 'DELL',
  'VRT', 'CEG', 'VST', 'GEV', 'PWR', 'ETN', 'NRG',
  'MSFT', 'ORCL', 'CRM', 'NOW', 'SNOW', 'DDOG', 'CRWD', 'PANW', 'ZS', 'NET', 'MDB', 'ADBE', 'INTU', 'APP', 'PLTR', 'TEAM', 'OKTA', 'SHOP', 'SNPS', 'CDNS',
  'META', 'GOOGL', 'AMZN', 'AAPL', 'NFLX', 'UBER', 'DASH', 'ABNB', 'SPOT', 'BKNG', 'RDDT',
  'TSLA', 'COIN', 'HOOD', 'MSTR', 'MARA', 'IREN', 'HUT',
  'ASTS', 'RKLB', 'IONQ', 'QBTS', 'RGTI', 'TEM', 'CBRS',
  'LLY', 'ISRG', 'DHR', 'REGN', 'VRTX', 'UNH', 'ABBV', 'TMO', 'MRNA', 'HUM',
  'JPM', 'GS', 'MS', 'V', 'MA', 'SCHW', 'SOFI',
  'BA', 'GE', 'CAT', 'DE', 'FDX', 'LULU', 'NKE', 'SBUX', 'CMG', 'HD', 'WMT', 'COST', 'MCD',
  'XOM', 'CVX', 'FCX', 'MP', 'FN', 'KLAC', 'ACN', 'IBM', 'CSCO'
].filter(function (t, i, a) { return a.indexOf(t) === i; });

// Theme = what moves together. Used by the guard that limits positions per theme.
const FLIP_THEME_GROUPS = {
  'AI chips': ['NVDA', 'AMD', 'AVGO', 'MRVL', 'MU', 'ARM', 'TSM', 'ANET', 'CRDO', 'SMCI', 'AMAT', 'LRCX', 'KLAC', 'QCOM', 'INTC', 'DELL', 'FN', 'CBRS'],
  'AI power': ['VRT', 'CEG', 'VST', 'GEV', 'PWR', 'ETN', 'NRG'],
  'Software': ['MSFT', 'ORCL', 'CRM', 'NOW', 'SNOW', 'DDOG', 'CRWD', 'PANW', 'ZS', 'NET', 'MDB', 'ADBE', 'INTU', 'APP', 'PLTR', 'TEAM', 'OKTA', 'SHOP', 'SNPS', 'CDNS', 'ACN', 'IBM', 'CSCO'],
  'Internet': ['META', 'GOOGL', 'AMZN', 'AAPL', 'NFLX', 'UBER', 'DASH', 'ABNB', 'SPOT', 'BKNG', 'RDDT'],
  'EV / autos': ['TSLA'],
  'Crypto-linked': ['COIN', 'HOOD', 'MSTR', 'MARA', 'IREN', 'HUT', 'RIOT', 'CLSK', 'BITO'],
  'Space / quantum / spec': ['ASTS', 'RKLB', 'IONQ', 'QBTS', 'RGTI', 'TEM', 'JOBY', 'LUNR'],
  'Healthcare': ['LLY', 'ISRG', 'DHR', 'REGN', 'VRTX', 'UNH', 'ABBV', 'TMO', 'MRNA', 'HUM'],
  'Financials': ['JPM', 'GS', 'MS', 'V', 'MA', 'SCHW', 'SOFI'],
  'Industrial / consumer': ['BA', 'GE', 'CAT', 'DE', 'FDX', 'LULU', 'NKE', 'SBUX', 'CMG', 'HD', 'WMT', 'COST', 'MCD'],
  'Energy / materials': ['XOM', 'CVX', 'FCX', 'MP']
};
const FLIP_THEME_OF = (function () {
  const o = {};
  Object.keys(FLIP_THEME_GROUPS).forEach(function (g) { FLIP_THEME_GROUPS[g].forEach(function (t) { o[t] = g; }); });
  return o;
})();

// ---- columns ----------------------------------------------------------------------------------
// What you SEE, in this order. Everything else stays on the sheet, hidden, and is still computed.
const FLIP_VISIBLE_HEADERS = ['Ticker', 'Entry Date', 'Entry', 'Qty', 'Strike', 'Expiry', 'Action', 'Score', 'Fit', 'P Hit %', 'Edge Needed',
  'Price', 'Change', 'Trend', 'Off High %', 'Earn Days', 'Mid', 'Spread %', 'Lev', 'Time Val %', 'Need %', 'Target', 'Stop', 'Size',
  'Days', 'P/L %', 'P/L $', 'Why', 'AUP', 'ADN', 'RSI', 'VW %', 'RVOL', 'OI', 'VOL', 'LastRun'];   // fresh sheets only; see FLIP_FIXED_COLUMNS
// Typed by you. With Qty filled, Strike / Expiry are YOUR contract and runs never overwrite them.
const FLIP_INPUT_HEADERS = ['Ticker', 'Qty', 'Entry Date', 'Entry'];
const FLIP_HELD_WHEN_OPEN = ['Strike', 'Expiry'];
// Two columns hold YOUR formula in the header cell (a sum of Entry, a sum of P/L $), so they cannot be found by header text.
// They are found by COLUMN NUMBER instead, only when no header with that exact name exists. Current layout: Entry = E (5), P/L $ = W (23).
// If you move either column, change the number here. The script refuses to write into a column whose header is one of its own
// managed names (and says so in the Log), so a moved column can never overwrite other data.
//   Entry : the price you paid for the option (input)       P/L $ : total dollars on the position (written by the script)
const FLIP_FIXED_COLUMNS = { 'Entry': 5, 'P/L $': 24 };
// Change = Price now minus Price at the previous fetch (green up, red down). Previous prices live in a script property.
const FLIP_CHANGE_FORMAT = '[Green]$#,##0.00;[Red]-$#,##0.00;$0.00';
function flipPnlCol_(map) { return (map && map['P/L $']) || 0; }
const FLIP_OUTPUT_HEADERS = [
  'Action', 'Score', 'Why', 'Strike', 'Expiry', 'Price', 'Change', 'Trend', 'Off High %', 'Earn Days', 'Mid', 'Spread %', 'Lev', 'Time Val %',
  'AUP', 'ADN', 'RSI', 'VW %', 'RVOL', 'OI', 'VOL', 'Need %', 'P Hit %', 'Edge Needed', 'Target', 'Stop', 'Size', 'Days', 'P/L %', 'LastRun'
];
// Only the columns above are on the sheet. Values such as Day %, ATR %, Delta, Bid/Ask, OI, Theme are still computed for the decision
// and the alert text, they just are not written anywhere, and the script never adds a column that is not listed here.
const FLIP_EXTRA_HEADERS = ['Fit'];
const FLIP_HEADERS = (function () {
  const all = FLIP_INPUT_HEADERS.concat(FLIP_OUTPUT_HEADERS).concat(FLIP_EXTRA_HEADERS);
  const seen = {};
  return FLIP_VISIBLE_HEADERS.concat(all).filter(function (h) { if (seen[h]) return false; seen[h] = true; return true; });
})();
const FLIP_HEADER_SET = (function () { const o = {}; FLIP_HEADERS.forEach(function (h) { o[h] = true; }); return o; })();
const FLIP_LOG_HEADERS = ['Time', 'Ticker', 'Signal', 'Stock', 'Strike', 'Expiry', 'Option', 'Delta', 'Lev', 'Spread %', 'Need %', 'Stop Dist %',
  'P Hit %', 'Edge Needed', 'Score', 'AUP', 'ADN', 'RSI', 'VW %', 'RVOL', 'Off High %', 'Trend', 'Earn Days',
  'Outcome', 'Days', 'MFE %', 'MAE %', 'Graded', 'Note'];


/* ============================================================================
 * SETUP + MENU
 * ========================================================================== */

// Run ONCE from the Apps Script editor.
function setupFlip() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(FLIP_SHEET_NAME);
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet(FLIP_SHEET_NAME);
  const map = flipEnsureHeaders_(sheet);
  if (isNew) {
    // Seed with the names you already trade; the promotion adds and retires others.
    const seed = ['TSLA', 'APP', 'ARM', 'ORCL', 'VRT', 'CEG', 'MRVL', 'ANET', 'NVDA', 'AMD', 'AVGO', 'META'];
    const rows = seed.map(function (t) {
      const row = new Array(FLIP_HEADERS.length).fill('');
      row[map['Ticker'] - 1] = t;
      return row;
    });
    sheet.getRange(2, 1, rows.length, FLIP_HEADERS.length).setValues(rows);
  }
  flipEnsureSheet_(FLIP_LOG_SHEET, FLIP_LOG_HEADERS);
  flipFormatSheet_(sheet);
  flipApplyVisibility_(sheet, false);

  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(function (t) { return t.getHandlerFunction() === 'flipAddMenu_'; })) ScriptApp.newTrigger('flipAddMenu_').forSpreadsheet(ss).onOpen().create();
  try { flipAddMenu_(); } catch (e) { /* no UI in some contexts */ }

  notify_(tryGetUi_(), 'Flip set up',
    (isNew ? 'Created the Flip tab with a starter list.\n' : 'Flip tab already existed: headers checked, your data untouched.\n') +
    'Menu "🔁 Flip" appears after you reload the sheet.\n\n' +
    'Next:\n  1. 🔁 Flip > Promote Research Picks\n  2. 🔁 Flip > Run Flip Scan (during market hours the first scan also picks each ticker\'s contract)\n' +
    '  3. 🔁 Flip > Alerts & Schedule > Start Flip Schedule\n\n' +
    'When you buy: type Qty, Entry Date, Entry (price paid), Strike and Expiry. When you sell: log it in Results as usual and clear Qty.');
}

function flipAddMenu_() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('🔁 Flip')
    .addItem('Run Flip Scan', 'runFlipScan')
    .addItem('Promote Research Picks to Flip', 'runFlipPromote')
    .addSeparator()
    .addItem('Build Stats (FlipStats tab)', 'flipBuildStats')
    .addItem('Grade Past Signals', 'flipGradeSignals')
    .addSeparator()
    .addSubMenu(ui.createMenu('📱 Alerts & Schedule')
      .addItem('Send Test Flip Alert', 'sendTestFlipAlert_')
      .addItem('Turn Flip Alerts On / Off', 'toggleFlipAlerts_')
      .addSeparator()
      .addItem('▶ Start Flip Schedule (every 5 min, market hours)', 'startFlipSchedule_')
      .addItem('■ Stop Flip Schedule', 'stopFlipSchedule_')
      .addItem('Schedule Status', 'flipScheduleStatus_'))
    .addSubMenu(ui.createMenu('🔍 Flip Debug')
      .addItem('One Ticker (full decision trail)', 'debugFlipOneTicker')
      .addItem('Scan Dry Run (no writes)', 'runFlipScanDryRun')
      .addItem('Promote Dry Run (no writes)', 'runFlipPromoteDryRun'))
    .addToUi();
}

function runFlipScanDryRun() { return runFlipScan(null, true); }
function runFlipPromoteDryRun() { return flipPromote_({ dryRun: true }); }


/* ============================================================================
 * SHEET HELPERS
 * ========================================================================== */

function flipEnsureSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() < 1) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold');
  }
  return sh;
}

// Adds any missing header at the end. Existing columns, order and data stay.
function flipEnsureHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  const hasAny = existing.some(function (h) { return h !== ''; });
  if (!hasAny) {
    sheet.getRange(1, 1, 1, FLIP_HEADERS.length).setValues([FLIP_HEADERS]);
  } else {
    let next = existing.length;
    while (next > 0 && existing[next - 1] === '') next--;
    FLIP_HEADERS.forEach(function (h) {
      // Entry / P/L $ live in fixed columns whose header is your own formula: never add a second copy of them.
      if (FLIP_FIXED_COLUMNS[h]) return;   // (flipHeaderMap_ maps them by column number, or logs why it cannot)
      if (existing.indexOf(h) === -1) { next++; sheet.getRange(1, next).setValue(h); existing[next - 1] = h; }
    });
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  return flipHeaderMap_(sheet);
}

function flipHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const row = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  row.forEach(function (h, i) { const k = String(h || '').trim(); if (k && map[k] == null) map[k] = i + 1; });
  // Your formula headers are found by what they contain, so moving columns never matters: a header formula starting with SUMPRODUCT is
  // Entry, one starting with SUM( is P/L $ (Sheets rewrites the cell references itself when you move a column).
  let entryF = 0, sumF = 0;
  try {
    sheet.getRange(1, 1, 1, lastCol).getFormulas()[0].forEach(function (f, i) {
      if (!entryF && /^=\s*sumproduct\s*\(/i.test(f)) entryF = i + 1;
      else if (!sumF && /^=\s*sum\s*\(/i.test(f)) sumF = i + 1;
    });
  } catch (e) { /* fall back to the positions below */ }
  // Fixed-position columns (header cell holds your own formula): used only when that name is not on the sheet.
  Object.keys(FLIP_FIXED_COLUMNS).forEach(function (name) {
    if (map[name]) return;
    let c = FLIP_FIXED_COLUMNS[name];
    if (name === 'Entry' && entryF) c = entryF;
    if (name === 'P/L $' && sumF) c = sumF;
    if (name === 'P/L $' && !sumF && map['Why'] > 1) {   // follows your formula column when it sits right before Why, so moving columns does not break it
      const lt = String(row[map['Why'] - 2] == null ? '' : row[map['Why'] - 2]).trim();
      if (lt !== '' && !FLIP_HEADER_SET[lt]) c = map['Why'] - 1;
    }
    const t = c <= lastCol ? String(row[c - 1] == null ? '' : row[c - 1]).trim() : '';
    if (t !== '' && !FLIP_HEADER_SET[t]) map[name] = c;
    else logFlipFixedOnce_(name, c, t);
  });
  return map;
}
function logFlipFixedOnce_(name, c, t) {
  try {
    const k = 'FLIP_FIXED_WARN_' + name;
    const p = PropertiesService.getScriptProperties();
    if (p.getProperty(k) === String(c) + t) return;
    p.setProperty(k, String(c) + t);
    logToSheet_('Flip: column ' + c + ' should hold the "' + name + '" column (FLIP_FIXED_COLUMNS) but its header is ' + (t === '' ? 'empty' : '"' + t + '"') + '. Nothing is written there; fix the number in FLIP_FIXED_COLUMNS.');
  } catch (e) { /* diagnostics only */ }
}

function flipApplyVisibility_(sheet, showAll) {
  const map = flipHeaderMap_(sheet);
  const last = sheet.getLastColumn();
  if (last < 1) return;
  sheet.showColumns(1, last);
  if (showAll) return;
  const vis = {};
  FLIP_VISIBLE_HEADERS.forEach(function (h) { vis[h] = true; });
  const hide = [];
  for (let c = 0; c < last; c++) hide.push(false);
  Object.keys(map).forEach(function (h) { if (!vis[h]) hide[map[h] - 1] = true; });
  Object.keys(FLIP_FIXED_COLUMNS).forEach(function (h) { if (map[h] && map[h] <= last) hide[map[h] - 1] = false; });   // Entry and P/L $ stay visible
  for (let c = 0; c < last; c++) {
    if (!hide[c]) continue;
    let e = c;
    while (e + 1 < last && hide[e + 1]) e++;
    sheet.hideColumns(c + 1, e - c + 1);
    c = e;
  }
}

function flipToggleDetailColumns_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIP_SHEET_NAME);
  if (!sheet) return;
  const map = flipHeaderMap_(sheet);
  const hidden = map['Bid'] ? sheet.isColumnHiddenByUser(map['Bid']) : false;
  flipApplyVisibility_(sheet, hidden);
}

// Colours that stay right as values change (conditional formatting): Earn Days red 0-3 (blocked), orange 4-10;
// Edge Needed green <= 5, orange <= 10, red above; P/L % red when negative.
function flipApplyRules_(sheet, map, onlyIfMissing) {
  try {
    const rules = sheet.getConditionalFormatRules();
    const rows = Math.max(sheet.getMaxRows() - 1, 1);
    const mineCols = ['Earn Days', 'Edge Needed', 'P/L %', 'Days'].filter(function (h) { return map[h]; }).map(function (h) { return map[h]; }).concat(flipPnlCol_(map) ? [flipPnlCol_(map)] : []);
    const mine = function (r) { return r.getRanges().some(function (x) { return mineCols.some(function (c) { return x.getColumn() <= c && x.getLastColumn() >= c; }); }); };
    if (onlyIfMissing && rules.some(mine)) return;
    const R = function (h) { return sheet.getRange(2, map[h], rows, 1); };
    const add = [];
    if (map['Earn Days']) {
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0, FLIP_CONFIG.earnBlockDays).setBackground('#f4cccc').setFontColor('#990000').setBold(true).setRanges([R('Earn Days')]).build());
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(FLIP_CONFIG.earnBlockDays + 1, 10).setBackground('#fce5cd').setRanges([R('Earn Days')]).build());
    }
    if (map['Edge Needed']) {
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThanOrEqualTo(5).setBackground('#d9ead3').setRanges([R('Edge Needed')]).build());
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(5.01, FLIP_CONFIG.maxEdgeNeeded).setBackground('#fff2cc').setRanges([R('Edge Needed')]).build());
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(FLIP_CONFIG.maxEdgeNeeded).setBackground('#f4cccc').setRanges([R('Edge Needed')]).build());
    }
    [map['P/L %'], flipPnlCol_(map)].forEach(function (c) {
      if (!c) return;
      const rg = sheet.getRange(2, c, rows, 1);
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberLessThan(0).setFontColor('#cc0000').setRanges([rg]).build());
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThan(0).setFontColor('#38761d').setRanges([rg]).build());
    });
    if (map['Days']) {
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberGreaterThanOrEqualTo(FLIP_CONFIG.hardStaleDays).setBackground('#f4cccc').setBold(true).setRanges([R('Days')]).build());
      add.push(SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(FLIP_CONFIG.timeStopDays, FLIP_CONFIG.hardStaleDays - 1).setBackground('#fce5cd').setRanges([R('Days')]).build());
    }
    sheet.setConditionalFormatRules(rules.filter(function (r) { return !mine(r); }).concat(add));
  } catch (e) { logToSheet_('Flip: could not apply colour rules: ' + (e && e.message ? e.message : e)); }
}

function flipFormatSheet_(sheet) {
  const map = flipHeaderMap_(sheet);
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  function fmt(h, f) { if (map[h]) sheet.getRange(2, map[h], maxRows, 1).setNumberFormat(f); }
  ['Entry', 'Strike', 'Price', 'Bid', 'Ask', 'Mid', 'Target', 'Stop', 'Open Mark'].forEach(function (h) { fmt(h, '$#,##0.00'); });
  ['Risk $'].forEach(function (h) { fmt(h, '$#,##0'); });
  if (flipPnlCol_(map)) sheet.getRange(2, flipPnlCol_(map), maxRows, 1).setNumberFormat('$#,##0;-$#,##0;$0');
  fmt('Change', FLIP_CHANGE_FORMAT);
  ['Entry Date', 'Expiry', 'Next Earnings'].forEach(function (h) { fmt(h, 'yyyy-mm-dd'); });
  fmt('LastRun', 'yyyy-mm-dd hh:mm');
  ['Off High %', 'T200 %', 'SMA20 %', 'RS5 %', 'ATR %', 'Sigma Day %', 'Spread %', 'Time Val %', 'Decay %/d', 'IV', 'VW %', 'Need %', 'P Hit %', 'BE Win %',
    'Edge Needed', 'Stop %', 'P/L %', 'Day %', 'Fit', 'Lev', 'Score', 'RVOL', 'Delta', 'AUP', 'ADN', 'RSI'].forEach(function (h) { fmt(h, '0.0'); });
  FLIP_INPUT_HEADERS.concat(FLIP_HELD_WHEN_OPEN).forEach(function (h) { if (map[h]) sheet.getRange(1, map[h]).setBackground('#fff2cc'); });
  FLIP_OUTPUT_HEADERS.forEach(function (h) { if (map[h] && FLIP_HELD_WHEN_OPEN.indexOf(h) === -1) sheet.getRange(1, map[h]).setBackground('#d9ead3'); });
  FLIP_EXTRA_HEADERS.forEach(function (h) { if (map[h]) sheet.getRange(1, map[h]).setBackground('#cfe2f3'); });
  flipApplyRules_(sheet, map, false);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
}


/* ============================================================================
 * PURE FUNCTIONS (no Apps Script services — unit-testable)
 * ========================================================================== */

function flipClamp_(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
// 0 at `zero`, 1 at `full`, linear between (works for either direction).
function flipLin_(v, zero, full) {
  if (v == null || !isFinite(v)) return 0;
  return flipClamp_((v - zero) / (full - zero), 0, 1);
}
function flipNum_(v) { if (v === '' || v == null) return null; const n = parseFloat(v); return isNaN(n) ? null : n; }
function flipR1_(v) { return v == null || !isFinite(v) ? '' : Math.round(v * 10) / 10; }
function flipR2_(v) { return v == null || !isFinite(v) ? '' : Math.round(v * 100) / 100; }

function flipSma_(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

// Wilder 14-day ATR as % of the last close. bars: [{h,l,c}]
function flipAtrPct_(bars, period) {
  period = period || 14;
  if (!bars || bars.length < period + 1) return null;
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i - 1].c;
    tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - pc), Math.abs(bars[i].l - pc)));
  }
  let atr = 0;
  for (let i = 0; i < period; i++) atr += tr[i];
  atr /= period;
  for (let i = period; i < tr.length; i++) atr = (atr * (period - 1) + tr[i]) / period;
  const last = bars[bars.length - 1].c;
  return last > 0 ? atr / last * 100 : null;
}

// Standard deviation of daily log returns (percent) over the last n closes.
function flipSigmaDay_(closes, n) {
  n = n || 20;
  if (!closes || closes.length < n + 1) return null;
  const r = [];
  for (let i = closes.length - n; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]));
  if (r.length < 8) return null;
  const m = r.reduce(function (a, b) { return a + b; }, 0) / r.length;
  const v = r.reduce(function (a, b) { return a + (b - m) * (b - m); }, 0) / (r.length - 1);
  return Math.sqrt(v) * 100;
}

function flipRetPct_(closes, days) {
  if (!closes || closes.length <= days) return null;
  const a = closes[closes.length - 1 - days], b = closes[closes.length - 1];
  return a > 0 ? (b / a - 1) * 100 : null;
}

// Daily-bar features. bars: [{h,l,c}] oldest first; spyBars same shape (for relative strength) or null.
function flipFeatures_(bars, spyBars) {
  if (!bars || bars.length < 22) return null;
  const closes = bars.map(function (b) { return b.c; });
  const price = closes[closes.length - 1];
  const sma20 = flipSma_(closes, 20);
  const sma20Prev = closes.length >= 25 ? flipSma_(closes.slice(0, closes.length - 5), 20) : null;
  const ret5 = flipRetPct_(closes, 5);
  const spyRet5 = spyBars && spyBars.length > 6 ? flipRetPct_(spyBars.map(function (b) { return b.c; }), 5) : null;
  const slopeUp = sma20Prev != null ? sma20 > sma20Prev : null;
  const above = sma20 != null ? price > sma20 : null;
  let trend = 'Mixed';
  if (above && slopeUp) trend = 'Up';
  else if (!above && slopeUp === false) trend = 'Down';
  else if (!above && slopeUp) trend = 'Pullback';
  const prev = closes[closes.length - 2];
  return {
    price: price, sma20: sma20, sma20Pct: sma20 ? (price / sma20 - 1) * 100 : null, slopeUp: slopeUp, trend: trend,
    atrPct: flipAtrPct_(bars), sigmaDay: flipSigmaDay_(closes, 20), ret5: ret5, rs5: (ret5 != null && spyRet5 != null) ? ret5 - spyRet5 : null,
    dayPct: prev > 0 ? (price / prev - 1) * 100 : null, high3m: Math.max.apply(null, bars.map(function (b) { return b.h; }))
  };
}

// Probability a driftless random walk (daily sigma, percent) exits a corridor through the top / bottom within `days`.
// Start at 0, top barrier +a, bottom barrier -b (percent of the stock price). Exact Fourier series for Brownian motion;
// as days -> infinity top = b/(a+b). Ignores gaps, drift, and IV changes.
function flipHitProb_(a, b, sigma, days) {
  if (!(a > 0) || !(b > 0) || !(sigma > 0) || !(days > 0)) return null;
  const w = a + b;
  const top = b / w, bot = a / w;
  let sumTop = 0, sumBot = 0;
  for (let n = 1; n <= 80; n++) {
    const e = Math.exp(-n * n * Math.PI * Math.PI * sigma * sigma * days / (2 * w * w));
    if (e < 1e-9 && n > 3) break;
    const sgn = (n % 2 === 0) ? 1 : -1;   // (-1)^n
    sumTop += (2 * sgn / (n * Math.PI)) * Math.sin(n * Math.PI * b / w) * e;
    sumBot += (2 * sgn / (n * Math.PI)) * Math.sin(n * Math.PI * a / w) * e;
  }
  const pTop = flipClamp_(top + sumTop, 0, 1), pBot = flipClamp_(bot + sumBot, 0, 1);
  return { pTop: pTop, pBot: pBot, pNeither: Math.max(0, 1 - pTop - pBot) };
}

// Everything the row shows about the trade geometry, for one contract.
//   lev = delta x stock / option price (option % move per 1% stock move)
//   need = stock move that earns the target after the spread
//   stop = clamp(1 ATR in option terms); stopDist = that in stock terms
function flipTradeGeometry_(c, stock, atrPct, sigmaDay, cfg) {
  cfg = cfg || FLIP_CONFIG;
  if (!c || !(c.mid > 0) || !(c.delta > 0) || !(stock > 0) || !(atrPct > 0)) return null;
  const lev = c.delta * stock / c.mid;
  const spread = c.spreadPct != null ? c.spreadPct : 0;
  const need = (cfg.targetPct + spread) / lev;
  const stopOpt = flipClamp_(lev * atrPct * cfg.stopAtrMult, cfg.stopMinPct, cfg.stopMaxPct);
  const stopDist = stopOpt / lev;
  const sig = sigmaDay > 0 ? sigmaDay : atrPct / 1.25;
  const hp = flipHitProb_(need, stopDist, sig, cfg.horizonDays);
  if (!hp) return null;
  const lossPct = stopOpt + spread;
  const be = lossPct / (cfg.targetPct + lossPct);
  const decided = hp.pTop + hp.pBot;
  const condWin = decided > 0 ? hp.pTop / decided : 0;
  return {
    lev: lev, need: need, stopOpt: stopOpt, stopDist: stopDist, pHit: hp.pTop, pStop: hp.pBot, pNeither: hp.pNeither,
    be: be, condWin: condWin, edgeNeeded: (be - condWin) * 100,
    targetPrice: c.mid * (1 + (cfg.targetPct + spread) / 100), stopPrice: c.mid * (1 - stopOpt / 100)
  };
}

// Contracts so that the stop costs about riskUsd (1 contract minimum).
function flipSize_(mid, stopOptPct, riskUsd) {
  if (!(mid > 0) || !(stopOptPct > 0)) return null;
  return Math.max(1, Math.floor(riskUsd / (mid * 100 * stopOptPct / 100)));
}

// Weekdays between two dates (entry day = 0). Exchange holidays are ignored.
function flipTradingDays_(from, to) {
  if (!from || !to) return null;
  const a = new Date(from.getFullYear(), from.getMonth(), from.getDate()), b = new Date(to.getFullYear(), to.getMonth(), to.getDate());
  if (b < a) return 0;
  let n = 0;
  const d = new Date(a.getTime());
  while (d < b) { d.setDate(d.getDate() + 1); const w = d.getDay(); if (w !== 0 && w !== 6) n++; }
  return n;
}

function flipThemeOf_(ticker) { return FLIP_THEME_OF[ticker] || 'Other'; }

// Chooses the cheapest-to-hold contract among those that pass the stock-proxy rule.
// cands: [{strike, bid, ask, delta, oi, volume, dte, symbol, expiry}]; returns { ok, c } or { ok:false, why }.
function flipChooseContract_(cands, spot, cfg) {
  cfg = cfg || FLIP_CONFIG;
  let best = null, why = '';
  const rejects = {};
  cands.forEach(function (x) {
    if (!(x.bid > 0) || !(x.ask > 0) || x.ask < x.bid) { rejects['no two-sided quote'] = (rejects['no two-sided quote'] || 0) + 1; return; }
    const mid = (x.bid + x.ask) / 2;
    const spreadPct = (x.ask - x.bid) / mid * 100;
    const intrinsic = Math.max(spot - x.strike, 0);
    const extPct = (mid - intrinsic) / mid * 100;
    const fails = [];
    if (!(x.delta >= cfg.minDelta)) fails.push('delta ' + (x.delta != null ? x.delta.toFixed(2) : '?') + ' < ' + cfg.minDelta);
    if (spreadPct > cfg.maxSpreadPct) fails.push('spread ' + spreadPct.toFixed(1) + '% > ' + cfg.maxSpreadPct + '%');
    if (x.oi != null && x.oi < cfg.minOi) fails.push('OI ' + x.oi + ' < ' + cfg.minOi);
    if (mid < cfg.minMid) fails.push('price under $' + cfg.minMid);
    if (extPct > cfg.maxTimeValuePct) fails.push('time value ' + extPct.toFixed(0) + '% > ' + cfg.maxTimeValuePct + '%');
    if (fails.length) { fails.forEach(function (f) { const k = f.replace(/[0-9.]+/g, '#'); rejects[k] = (rejects[k] || 0) + 1; }); if (!why) why = fails[0]; return; }
    const lev = x.delta * spot / mid;
    let decay = null;
    if (x.iv != null && typeof blackScholesOneDayTheta_ === 'function') {
      const th = blackScholesOneDayTheta_(spot, x.strike, x.dte, x.iv, 'C');
      if (th != null) decay = Math.abs(th) / mid * 100;
    }
    if (decay == null) decay = extPct / Math.max(x.dte, 30) * 1.3;   // rough fallback: time value fades roughly linearly, a bit faster near expiry
    const friction = (spreadPct + cfg.decayDays * decay) / lev;
    const row = {
      strike: x.strike, expiry: x.expiry, dte: x.dte, symbol: x.symbol, bid: x.bid, ask: x.ask, mid: mid, delta: x.delta, oi: x.oi, volume: x.volume,
      iv: x.iv, spreadPct: spreadPct, extPct: extPct, lev: lev, decayPct: decay, friction: friction
    };
    if (!best || friction < best.friction || (friction === best.friction && (row.oi || 0) > (best.oi || 0))) best = row;
  });
  if (best) return { ok: true, c: best };
  const top = Object.keys(rejects).sort(function (a, b) { return rejects[b] - rejects[a]; }).slice(0, 2).join('; ');
  return { ok: false, why: top || 'no candidates' };
}

// Entry score (0-100) = how good this moment is for a new position. Hard gates are applied by the caller.
//   trigger 35, daily structure 25, contract 20, cost geometry 15, earnings 5.
function flipScore_(m) {
  const trig = m.level === 'strong' ? 35 : (m.level === 'light' ? (m.bounce ? 18 : 20) : (m.trendOk ? 8 : 0));
  const struct = (m.priceAbove20 ? 8 : 0) + (m.slopeUp ? 5 : 0) + (m.rs5 != null && m.rs5 >= 0 ? 4 : 0) + 8 * flipLin_(m.offHigh, 40, 10);
  const contract = 8 * flipLin_(m.spreadPct, 1.5, 0.4) + 4 * flipLin_(m.delta, 0.75, 0.9) + 4 * flipLin_(m.extPct, 30, 8) + 4 * flipLin_(m.oi, 100, 1000);
  const geom = 15 * flipLin_(m.edgeNeeded, 10, 2);
  const earn = m.earnDays == null ? 2.5 : 5 * flipLin_(m.earnDays, 4, 10);
  return Math.round(trig + struct + contract + geom + earn);
}

// Action for a row you HOLD. pl = % vs your Entry at the bid. Returns { action, why }.
function flipHeldAction_(h, cfg) {
  cfg = cfg || FLIP_CONFIG;
  const money = h.plPct != null ? (h.plPct >= 0 ? '+' : '') + h.plPct.toFixed(1) + '%' : 'no quote';
  const base = money + ', day ' + h.days;
  if (h.plPct == null) return { action: 'REVIEW', why: 'no option quote (check Strike / Expiry): ' + base };
  if (h.stopPct != null && h.plPct <= -h.stopPct) return { action: 'STOP', why: 'down ' + money + ', past the stop (-' + h.stopPct.toFixed(1) + '%): get out, ' + base };
  if (h.days >= cfg.hardStaleDays && h.plPct < cfg.targetPct) return { action: 'TIME-STOP', why: 'day ' + h.days + ' (max ' + cfg.hardStaleDays + '): close it, ' + money };
  if (h.plPct >= cfg.targetPct) return { action: 'SELL', why: 'target reached ' + money + ' (net of the selling spread)' };
  if (h.exit && h.exit.exit) return { action: 'SELL', why: 'up ' + money + ' and RSI ' + h.rsi + (h.exit.fading ? ' with momentum fading' : ' is high') + ': your exit rule' };
  if (h.days >= cfg.timeStopDays && h.plPct < cfg.timeStopMinGainPct) return { action: 'TIME-STOP', why: 'day ' + h.days + ' and never reached +' + cfg.timeStopMinGainPct + '%: cut it loose, ' + money };
  if (h.earnDays != null && h.earnDays <= cfg.earnBlockDays) return { action: 'REVIEW', why: 'earnings in ' + h.earnDays + ' day(s): gap risk, ' + base };
  return { action: 'HOLD', why: base + (h.stopPrice ? ', stop $' + h.stopPrice.toFixed(2) : '') };
}

// Portfolio guard. open: [{ticker, theme, plUsd, cost, entryDate}], returns { blocked, why }.
function flipPortfolioGuard_(open, theme, todayYmd, cfg) {
  cfg = cfg || FLIP_CONFIG;
  if (open.length >= cfg.maxOpen) return { blocked: true, why: open.length + ' open positions (limit ' + cfg.maxOpen + ')' };
  if (theme && theme !== 'Other') {
    const same = open.filter(function (o) { return o.theme === theme; }).length;
    if (same >= cfg.maxPerTheme) return { blocked: true, why: same + ' open in ' + theme + ' (limit ' + cfg.maxPerTheme + ')' };
  }
  const today = open.filter(function (o) { return o.entryYmd === todayYmd; }).length;
  if (today >= cfg.maxNewPerDay) return { blocked: true, why: today + ' entries today (limit ' + cfg.maxNewPerDay + ')' };
  let cost = 0, pl = 0;
  open.forEach(function (o) { cost += o.cost || 0; pl += o.plUsd || 0; });
  if (cost > 0 && pl / cost * 100 <= -cfg.maxOpenLossPct) return { blocked: true, why: 'open book is ' + (pl / cost * 100).toFixed(1) + '% (limit -' + cfg.maxOpenLossPct + '%)' };
  return { blocked: false, why: '' };
}

function flipSortKey_(action, score, plPct) {
  const base = { 'STOP': 9000, 'TIME-STOP': 8900, 'SELL': 8800, 'REVIEW': 8700, 'FILL IN': 8600, 'HOLD': 8000, 'BUY': 7000, 'READY': 6000, 'BLOCKED': 5000, 'WAIT': 4000, 'SKIP': 1000 }[action] || 0;
  return base + (score || 0) + (action === 'STOP' || action === 'TIME-STOP' ? Math.max(0, -(plPct || 0)) : 0);
}


/* ============================================================================
 * CACHE SHEET (own sheet so Quick/Leap runs never read Flip data)
 * ========================================================================== */

function flipCacheLoad_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIP_CACHE_SHEET);
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

function flipCacheFlush_(pending) {
  const keys = Object.keys(pending);
  if (!keys.length) return 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(FLIP_CACHE_SHEET);
  if (!sheet) { sheet = ss.insertSheet(FLIP_CACHE_SHEET); try { sheet.hideSheet(); } catch (e) { /* ignore */ } }
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow >= 1) sheet.getRange(1, 1, lastRow, 2).getValues().forEach(function (row) { if (row[0]) existing[row[0]] = row[1]; });
  keys.forEach(function (k) { existing[k] = pending[k]; });
  // drop entries older than 14 days so the sheet cannot grow without bound
  const cutoff = Date.now() - 14 * 86400000;
  const rows = [];
  Object.keys(existing).forEach(function (k) {
    let keep = true;
    try { const o = JSON.parse(existing[k]); if (o && o.d && Date.parse(o.d + 'T12:00:00Z') < cutoff) keep = false; } catch (e) { keep = false; }
    if (keep) rows.push([k, existing[k]]);
  });
  sheet.clearContents();
  if (rows.length) sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  return keys.length;
}

function flipTodayYmd_(now) { return Utilities.formatDate(now || new Date(), 'America/New_York', 'yyyy-MM-dd'); }

// Cached value if it is at most maxAgeDays old (0 = today only), else null.
function flipCacheGet_(cache, key, maxAgeDays, now) {
  const e = cache[key];
  if (!e || !e.d) return null;
  const age = Math.floor((Date.parse(flipTodayYmd_(now) + 'T12:00:00Z') - Date.parse(e.d + 'T12:00:00Z')) / 86400000);
  return age <= maxAgeDays ? e.v : null;
}
function flipCachePut_(cache, pending, key, value, now) {
  const rec = { d: flipTodayYmd_(now), v: value };
  cache[key] = rec;
  pending[key] = JSON.stringify(rec);
}


/* ============================================================================
 * DATA FETCHERS (all batched: one request per chunk, not per ticker)
 * ========================================================================== */

function flipParseChart_(text) {
  try {
    const json = JSON.parse(text);
    const r = json.chart && json.chart.result && json.chart.result[0];
    if (!r || !r.timestamp || !r.indicators || !r.indicators.quote || !r.indicators.quote[0]) return null;
    const q = r.indicators.quote[0], ts = r.timestamp, bars = [];
    for (let i = 0; i < ts.length; i++) {
      const h = q.high ? q.high[i] : null, l = q.low ? q.low[i] : null, c = q.close ? q.close[i] : null;
      if (h == null || l == null || c == null) continue;
      const v = q.volume && q.volume[i] != null ? q.volume[i] : 0;
      bars.push([Utilities.formatDate(new Date(ts[i] * 1000), 'America/New_York', 'yyyy-MM-dd'), Math.round(h * 100) / 100, Math.round(l * 100) / 100, Math.round(c * 100) / 100, v]);
    }
    return bars.length ? bars : null;
  } catch (e) { return null; }
}

// Daily bars for many tickers in parallel (UrlFetchApp.fetchAll, chunks of 20). Returns { T: [[date,h,l,c,v], ...] }.
function flipFetchBars_(tickers, range) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 20) {
    const chunk = tickers.slice(i, i + 20);
    const reqs = chunk.map(function (t) {
      return { url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(t) + '?range=' + range + '&interval=1d', method: 'get', muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' } };
    });
    let resps = [];
    try { resps = UrlFetchApp.fetchAll(reqs); } catch (e) { logToSheet_('Flip: daily bars batch failed: ' + e); continue; }
    resps.forEach(function (r, k) {
      if (r.getResponseCode() !== 200) return;
      const bars = flipParseChart_(r.getContentText());
      if (bars) out[chunk[k]] = bars;
    });
    if (i + 20 < tickers.length) Utilities.sleep(200);
  }
  return out;
}

function flipBarsToObjects_(arr) { return (arr || []).map(function (b) { return { d: b[0], h: b[1], l: b[2], c: b[3], v: b[4] }; }); }

// Bars for these tickers: today's cache first, one parallel fetch for the rest.
function flipGetBars_(tickers, ctx, range, keyPrefix) {
  const out = {}, need = [];
  tickers.forEach(function (t) {
    const hit = flipCacheGet_(ctx.cache, keyPrefix + '|' + t, 0, ctx.now);
    if (hit) out[t] = hit; else need.push(t);
  });
  if (need.length) {
    const got = flipFetchBars_(need, range);
    Object.keys(got).forEach(function (t) { out[t] = got[t]; flipCachePut_(ctx.cache, ctx.pending, keyPrefix + '|' + t, got[t], ctx.now); });
  }
  return out;
}

// Cloud Function "daily": 52-week position and 200/50-day trend. One request for all tickers. Cached for the day.
function flipGetDaily_(tickers, ctx) {
  const out = {}, need = [];
  tickers.forEach(function (t) {
    const hit = flipCacheGet_(ctx.cache, 'FDAILY|' + t, 0, ctx.now);
    if (hit) out[t] = hit; else need.push(t);
  });
  if (!need.length) return out;
  const url = getCloudFunctionUrl_(), secret = getCloudFunctionSharedSecret_();
  if (!url || !secret) return out;
  try {
    const resp = UrlFetchApp.fetch(url, { method: 'post', contentType: 'application/json', muteHttpExceptions: true, payload: JSON.stringify({ apiKey: secret, daily: { tickers: need } }) });
    if (resp.getResponseCode() !== 200) { logToSheet_('Flip: Cloud Function daily HTTP ' + resp.getResponseCode()); return out; }
    const res = JSON.parse(resp.getContentText()).dailyResults || {};
    Object.keys(res).forEach(function (t) {
      const d = res[t];
      const slim = { t200: d.t200, x50: d.x50, offHigh: d.offHigh, high52: d.high52, low52: d.low52, price: d.price, sma200: d.sma200 };
      out[t] = slim; flipCachePut_(ctx.cache, ctx.pending, 'FDAILY|' + t, slim, ctx.now);
    });
  } catch (e) { logToSheet_('Flip: Cloud Function daily failed: ' + e); }
  return out;
}

// Next earnings date (or null). Cached 2 days; Finnhub first, Yahoo second.
function flipEarnings_(ticker, ctx) {
  const key = 'EARN|' + ticker;
  const hit = flipCacheGet_(ctx.cache, key, 2, ctx.now);
  if (hit) return hit.date ? new Date(hit.date + 'T12:00:00') : null;
  let c = null;
  try { c = ctx.finnhubKey ? fetchFinnhubNextEarnings_(ticker, ctx.finnhubKey) : null; } catch (e) { c = null; }
  if (!c) { try { c = fetchYahooNextEarnings_(ticker); } catch (e) { c = null; } }
  const date = c && c.date ? Utilities.formatDate(c.date, 'America/New_York', 'yyyy-MM-dd') : null;
  flipCachePut_(ctx.cache, ctx.pending, key, { date: date }, ctx.now);
  ctx.earnFetched = (ctx.earnFetched || 0) + 1;
  return date ? new Date(date + 'T12:00:00') : null;
}

// Picks the stock-proxy contract for one ticker (cached for the day). Needs live two-sided quotes, so it only succeeds
// while the market is open; outside hours it returns the last good pick (up to probeMaxAgeDays old) marked stale.
function flipPickContract_(ticker, spot, sigmaDay, ctx) {
  const key = 'CON|' + ticker;
  const today = flipCacheGet_(ctx.cache, key, 0, ctx.now);
  if (today) return today;
  const C = FLIP_CONFIG;
  let res = { ok: false, why: 'no TastyTrade chain' };
  if (ctx.token && spot > 0) {
    let chain = ctx.chains[ticker];
    if (chain === undefined) {
      try { chain = fetchTastyOptionChainNested_(ticker, ctx.token) || null; } catch (e) { chain = null; }
      ctx.chains[ticker] = chain;
    }
    if (chain) {
      const exps = chain.map(function (e) { return { e: e, dte: Math.round((e.date.getTime() - ctx.now.getTime()) / 86400000) }; })
        .filter(function (x) { return x.dte >= C.minDte && x.dte <= C.maxDte; })
        .sort(function (a, b) { return Math.abs(a.dte - C.targetDte) - Math.abs(b.dte - C.targetDte); }).slice(0, 2);
      const ivGuess = flipClamp_((sigmaDay || 2.5) * Math.sqrt(252) * 1.1, 25, 120);
      const list = [];
      exps.forEach(function (x) {
        x.e.strikes.filter(function (s) { return s.callSymbol && s.strike >= spot * 0.5 && s.strike <= spot * 0.99; })
          .map(function (s) { const d = blackScholesDelta_(spot, s.strike, x.dte, ivGuess, 'C'); return { s: s, est: d }; })
          .filter(function (z) { return z.est != null && z.est >= 0.70 && z.est <= 0.97; })
          .sort(function (a, b) { return Math.abs(a.est - 0.85) - Math.abs(b.est - 0.85); }).slice(0, 9)
          .forEach(function (z) { list.push({ sym: z.s.callSymbol, strike: z.s.strike, est: z.est, dte: x.dte, expiry: x.e.date }); });
      });
      if (list.length) {
        const md = fetchTastyMarketDataBatch_(list.map(function (z) { return z.sym; }), ctx.token);
        const cands = list.map(function (z) {
          const q = md[z.sym];
          if (!q) return null;
          const mid = (q.bid > 0 && q.ask > 0) ? (q.bid + q.ask) / 2 : null;
          const iv = mid ? impliedVolatilityBisection_(mid, spot, z.strike, z.dte, 'C') : null;
          return { strike: z.strike, bid: q.bid, ask: q.ask, delta: q.delta != null ? q.delta : z.est, oi: q.oi, volume: q.volume, dte: z.dte, symbol: z.sym, expiry: z.expiry, iv: iv };
        }).filter(Boolean);
        res = flipChooseContract_(cands, spot, C);
      } else res = { ok: false, why: 'no strike near delta 0.85' };
    }
  }
  if (res.ok) {
    const c = res.c;
    const rec = { ok: true, c: Object.assign({}, c, { expiry: Utilities.formatDate(c.expiry, 'America/New_York', 'yyyy-MM-dd') }) };
    flipCachePut_(ctx.cache, ctx.pending, key, rec, ctx.now);
    return rec;
  }
  const old = flipCacheGet_(ctx.cache, key, C.promote.probeMaxAgeDays, ctx.now);
  if (old && old.ok) return Object.assign({}, old, { stale: true });
  return res;
}

// Expiry text -> Date (cache stores yyyy-MM-dd).
function flipDate_(v) {
  if (v == null || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? v + 'T12:00:00' : String(v));
  return isNaN(d.getTime()) ? null : d;
}



/* ============================================================================
 * ROW LOGIC
 * ========================================================================== */

function flipIsDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }
function flipStaleMin_() { return typeof INTRADAY_STALE_MIN !== 'undefined' ? INTRADAY_STALE_MIN : 15; }
function flipContractText_(expiry, strike) {
  const d = flipDate_(expiry);
  return d ? Utilities.formatDate(d, 'America/New_York', 'MMM yyyy') + ' $' + strike + 'C' : '';
}

// Intraday values that are fresh enough to act on, else null.
function flipFreshIv_(iv, env) {
  if (!iv || iv.aroonUp == null || iv.aroonDown == null || iv.rsi1m == null) return null;
  if (!env.sess.open) return null;
  const ageMin = iv.lastBarEpoch != null ? Math.round((env.now.getTime() - iv.lastBarEpoch * 1000) / 60000) : null;
  if (env.sess.minutesSinceOpen > flipStaleMin_() && ageMin != null && ageMin > flipStaleMin_()) return null;
  return iv;
}

// Earnings from cache only (no network). Returns Date or null.
function flipEarningsCached_(ticker, ctx) {
  const hit = flipCacheGet_(ctx.cache, 'EARN|' + ticker, 2, ctx.now);
  return hit && hit.date ? new Date(hit.date + 'T12:00:00') : null;
}

function flipEarnDays_(date, now) {
  if (!date) return null;
  const d = Math.ceil((date.getTime() - now.getTime()) / 86400000);
  return d < 0 ? null : d;
}

// Columns shared by every kind of row (stock-level facts).
function flipStockCols_(res, t, env, price) {
  const f = env.feat[t], d = env.daily[t] || {}, iv = env.ivFresh[t];
  const C = FLIP_CONFIG;
  res['Theme'] = flipThemeOf_(t);
  if (price != null) res['Price'] = flipR2_(price);
  if (f) {
    const prev = env.prevClose[t];
    if (price != null && prev > 0) res['Day %'] = flipR2_((price / prev - 1) * 100);
    res['Trend'] = f.trend; res['SMA20 %'] = f.sma20 && price ? flipR1_((price / f.sma20 - 1) * 100) : flipR1_(f.sma20Pct);
    res['RS5 %'] = flipR1_(f.rs5); res['ATR %'] = flipR2_(f.atrPct); res['Sigma Day %'] = flipR2_(f.sigmaDay);
  }
  if (d.offHigh != null) res['Off High %'] = flipR1_(d.offHigh);
  else if (f && price) res['Off High %'] = flipR1_((1 - price / f.high3m) * 100);
  if (d.t200 != null) res['T200 %'] = flipR1_(d.t200);
  if (iv) {
    res['AUP'] = iv.aroonUp; res['ADN'] = iv.aroonDown; res['RSI'] = iv.rsi1m;
    if (iv.vwapPct != null) res['VW %'] = iv.vwapPct;
    if (iv.rvol != null) res['RVOL'] = iv.rvol;
  }
}

// Live view of a contract from a Cloud Function quote, falling back to the picked values.
function flipLiveContract_(base, q) {
  let bid = base.bid, ask = base.ask, delta = base.delta;
  if (q) {
    if (q.bid > 0 && q.ask > 0 && q.ask >= q.bid) { bid = q.bid; ask = q.ask; }
    if (q.delta != null && q.delta > 0 && q.delta <= 1) delta = q.delta;
  }
  const mid = (bid > 0 && ask > 0) ? (bid + ask) / 2 : base.mid;
  const spreadPct = (bid > 0 && ask > 0) ? (ask - bid) / mid * 100 : base.spreadPct;
  return { bid: bid, ask: ask, mid: mid, delta: delta, spreadPct: spreadPct, oi: (q && q.openInterest != null) ? q.openInterest : base.oi,
    volume: (q && q.volume != null) ? q.volume : base.volume };
}

// ---- a row you HOLD ------------------------------------------------------------------------------
function flipProcessHeld_(rw, env) {
  const C = FLIP_CONFIG, t = rw.ticker, res = {};
  const f = env.feat[t], iv = env.ivFresh[t];
  const price = iv && iv.lastPrice > 0 ? iv.lastPrice : (f ? f.price : null);
  flipStockCols_(res, t, env, price);
  const earnDate = env.full ? flipEarnings_(t, env.ctx) : flipEarningsCached_(t, env.ctx);
  const earnDays = flipEarnDays_(earnDate, env.now);
  if (earnDate) res['Next Earnings'] = earnDate;
  if (earnDays != null) res['Earn Days'] = earnDays;
  if (!rw.complete) {
    res['Action'] = 'FILL IN'; res['Why'] = 'Qty is filled: also enter Strike, Expiry and Entry (the price you paid) so the sheet can follow this position.';
    return res;
  }
  const occ = buildOccSymbol_(t, rw.expiry, rw.strike, 'C');
  const q = env.quotes[occ];
  const bid = q && q.bid > 0 ? q.bid : null;
  const ask = q && q.ask > 0 ? q.ask : null;
  const mid = bid && ask ? (bid + ask) / 2 : (q && q.mark > 0 ? q.mark : null);
  const plPct = bid ? (bid / rw.entry - 1) * 100 : null;
  const days = rw.entryDate ? flipTradingDays_(rw.entryDate, env.now) : 0;
  res['Contract'] = flipContractText_(rw.expiry, rw.strike);
  res['DTE'] = Math.round((rw.expiry.getTime() - env.now.getTime()) / 86400000);
  if (q) {
    res['Bid'] = bid != null ? bid : ''; res['Ask'] = ask != null ? ask : ''; res['Mid'] = mid != null ? flipR2_(mid) : '';
    if (bid && ask && mid) res['Spread %'] = flipR2_((ask - bid) / mid * 100);
    if (q.delta != null) res['Delta'] = flipR2_(q.delta);
    if (q.openInterest != null) res['OI'] = q.openInterest;
    if (q.volume != null) res['VOL'] = q.volume;
  }
  let geo = null;
  if (f && mid && q && q.delta > 0 && price) {
    geo = flipTradeGeometry_({ mid: mid, delta: q.delta, spreadPct: res['Spread %'] || 0 }, price, f.atrPct, f.sigmaDay, C);
    if (geo) { res['Lev'] = flipR1_(geo.lev); res['Stop %'] = flipR1_(geo.stopOpt); }
  }
  const stopPct = geo ? geo.stopOpt : (C.stopMinPct + C.stopMaxPct) / 2;
  res['Target'] = flipR2_(rw.entry * (1 + C.targetPct / 100));
  res['Stop'] = flipR2_(rw.entry * (1 - stopPct / 100));
  res['Days'] = days;
  if (plPct != null) { res['P/L %'] = flipR1_(plPct); res['P/L $'] = Math.round((bid - rw.entry) * 100 * rw.qty); res['Open Mark'] = flipR2_(bid); }
  const exit = (iv && plPct != null) ? evaluateQuickExit_(iv, plPct, env.S) : { exit: false, fading: false };
  const act = flipHeldAction_({ plPct: plPct, days: days, stopPct: stopPct, stopPrice: rw.entry * (1 - stopPct / 100), exit: exit, rsi: iv ? iv.rsi1m : null, earnDays: earnDays }, C);
  res['Action'] = act.action; res['Why'] = act.why; res._held = true; res._plPct = plPct;
  return res;
}

// ---- a candidate row (no position) ---------------------------------------------------------------
function flipProcessCandidate_(rw, env) {
  const C = FLIP_CONFIG, S = env.S, t = rw.ticker, res = {};
  const f = env.feat[t], d = env.daily[t] || {}, iv = env.ivFresh[t];
  const price = iv && iv.lastPrice > 0 ? iv.lastPrice : (f ? f.price : null);
  flipStockCols_(res, t, env, price);
  const done = function (action, why) { res['Action'] = action; res['Why'] = why; return res; };
  if (!f || !price) return done('SKIP', 'no daily price history');
  const offHigh = res['Off High %'] !== undefined && res['Off High %'] !== '' ? res['Off High %'] : null;

  const earnDate = env.full ? flipEarnings_(t, env.ctx) : flipEarningsCached_(t, env.ctx);
  const earnDays = flipEarnDays_(earnDate, env.now);
  if (earnDate) res['Next Earnings'] = earnDate;
  if (earnDays != null) res['Earn Days'] = earnDays;

  if (price < C.minPrice) return done('SKIP', 'price $' + price.toFixed(2) + ' under $' + C.minPrice);
  if (f.atrPct < C.minAtrPct) return done('SKIP', 'ATR ' + f.atrPct.toFixed(1) + '% is too quiet to reach +' + C.targetPct + '% in a few days');
  if (f.atrPct > C.maxAtrPct) return done('SKIP', 'ATR ' + f.atrPct.toFixed(1) + '% is too wild: the stop would be hit by noise');
  if (offHigh != null && offHigh > C.maxOffHighPct) return done('SKIP', offHigh + '% under the 52-week high: falling-knife filter');
  if (earnDays != null && earnDays <= C.earnBlockDays) return done('SKIP', 'earnings in ' + earnDays + ' day(s): gap and IV-crush risk');

  const pick = env.picks[t];
  if (!pick || !pick.ok) return done('SKIP', pick && pick.why ? 'no usable contract: ' + pick.why : 'no contract picked yet (run a full scan during market hours)');
  const base = pick.c;
  const q = env.quotes[base.symbol];
  const live = flipLiveContract_(base, q);
  const expiry = flipDate_(base.expiry);
  const intrinsic = Math.max(price - base.strike, 0);
  const extPct = live.mid > 0 ? (live.mid - intrinsic) / live.mid * 100 : null;
  const geo = flipTradeGeometry_(live, price, f.atrPct, f.sigmaDay, C);

  res['Strike'] = base.strike; res['Expiry'] = expiry; res['Contract'] = flipContractText_(expiry, base.strike);
  res['DTE'] = expiry ? Math.round((expiry.getTime() - env.now.getTime()) / 86400000) : '';
  res['Delta'] = flipR2_(live.delta); res['Bid'] = live.bid; res['Ask'] = live.ask; res['Mid'] = flipR2_(live.mid);
  res['Spread %'] = flipR2_(live.spreadPct); res['Time Val %'] = flipR1_(extPct); res['Decay %/d'] = flipR2_(base.decayPct);
  res['OI'] = live.oi != null ? live.oi : ''; res['VOL'] = live.volume != null ? live.volume : '';
  if (!geo) return done('SKIP', 'cannot compute trade geometry for this contract');
  res['Lev'] = flipR1_(geo.lev); res['Need %'] = flipR2_(geo.need); res['P Hit %'] = flipR1_(geo.pHit * 100);
  res['BE Win %'] = flipR1_(geo.be * 100); res['Edge Needed'] = flipR1_(geo.edgeNeeded);
  res['Target'] = flipR2_(geo.targetPrice); res['Stop'] = flipR2_(geo.stopPrice); res['Stop %'] = flipR1_(geo.stopOpt);
  res['Size'] = flipSize_(live.mid, geo.stopOpt, C.riskPerTradeUsd);
  res['Risk $'] = res['Size'] ? Math.round(res['Size'] * live.mid * 100 * geo.stopOpt / 100) : '';
  if (pick.stale) res._stalePick = true;
  if (live.spreadPct > C.maxSpreadPct) return done('WAIT', 'option spread ' + live.spreadPct.toFixed(1) + '% (max ' + C.maxSpreadPct + '%): it would eat the target');
  if (geo.edgeNeeded > C.maxEdgeNeeded) return done('WAIT', 'costs too high: you would need to beat a coin-flip walk by ' + geo.edgeNeeded.toFixed(1) + ' points (limit ' + C.maxEdgeNeeded + ')');

  // trigger
  const trendOk = !!(iv && iv.aroonUp >= S.trendAupMin && iv.aroonDown <= S.trendAdnMax);
  let ev = { level: null, dip: false, missing: [], bounce: null };
  let blackout = '';
  if (iv) {
    const closeMin = env.closeMin, m = env.sess.minutesSinceOpen;
    if (m < S.noEntryFirstMin) blackout = 'first ' + S.noEntryFirstMin + ' minutes after the open';
    else if (closeMin - m < S.noEntryLastMin) blackout = 'last ' + S.noEntryLastMin + ' minutes before the close';
    if (!blackout) ev = evaluateEntryLevel_(iv, S, env.spyHead, geo.need);
    res['Signal'] = ev.level === 'strong' ? 'ENTRY' : (ev.level === 'light' ? 'GET READY' : '');
    if (ev.bounce) res['Bounce'] = 'Y';
  }
  const score = flipScore_({ level: ev.level, bounce: !!ev.bounce, trendOk: trendOk, priceAbove20: price > f.sma20, slopeUp: f.slopeUp, rs5: f.rs5,
    offHigh: offHigh, spreadPct: live.spreadPct, delta: live.delta, extPct: extPct, oi: live.oi, edgeNeeded: geo.edgeNeeded, earnDays: earnDays });
  res['Score'] = score;
  res._geo = geo; res._ev = ev; res._price = price; res._live = live; res._base = base;

  if (!iv) return done('WAIT', env.sess.open ? 'no fresh intraday data for the entry trigger' : 'market closed: trigger is evaluated only while the market is open');
  if (blackout) return done('WAIT', 'entry blackout (' + blackout + ')');
  if (!ev.level) {
    return done('WAIT', trendOk ? 'trend up, no RSI dip yet (RSI ' + iv.rsi1m + ')' : 'no 5-minute uptrend (Aroon up ' + iv.aroonUp + ', down ' + iv.aroonDown + ')');
  }
  const why = ev.level === 'strong'
    ? 'dip bought: RSI was ' + iv.rsiMin5 + ' and is turning up, trend up, ' + (iv.vwapPct != null ? 'VWAP ' + iv.vwapPct + '%' : '') + ', needs +' + geo.need.toFixed(2) + '% in the stock'
    : (ev.bounce ? bounceWhy_(ev.bounce) : (ev.dip && ev.missing.length ? 'waiting: ' + ev.missing.join('; ') : 'RSI low, no dip/turn yet'));
  let action = null;
  if (ev.level === 'strong' && score >= C.scoreBuy) action = 'BUY';
  else if (score >= C.scoreReady) action = 'READY';
  if (!action) return done('WAIT', 'signal is there but score ' + score + ' is under ' + C.scoreReady + ': ' + why);
  if (action === 'BUY' && f.trend === 'Down') { action = 'READY'; res['Why'] = ''; return done('READY', 'would be a BUY, but the daily trend is down (price under a falling 20-day average): ' + why); }
  if (action === 'BUY' || action === 'READY') {
    const gd = flipPortfolioGuard_(env.open, flipThemeOf_(t), env.todayYmd, C);
    if (gd.blocked) return done('BLOCKED', gd.why + ' | ' + action + ' otherwise: ' + why);
  }
  return done(action, why);
}


/* ============================================================================
 * THE SCAN
 * ========================================================================== */

function flipParseInputs_(data, map, now) {
  const rows = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const num = function (h) { return map[h] ? flipNum_(r[map[h] - 1]) : null; };
    const qty = num('Qty');
    const held = qty != null && qty > 0;
    const strike = num('Strike'), entry = num('Entry');
    const expiry = flipDate_(map['Expiry'] ? r[map['Expiry'] - 1] : null);
    const entryDate = flipDate_(map['Entry Date'] ? r[map['Entry Date'] - 1] : null);
    rows.push({
      idx: i, ticker: t, held: held, qty: qty || 0, strike: strike, expiry: expiry, entry: entry, entryDate: entryDate,
      complete: !!(held && strike > 0 && expiry && entry > 0),
      lastRun: map['LastRun'] && r[map['LastRun'] - 1] instanceof Date ? r[map['LastRun'] - 1].getTime() : 0
    });
  });
  return rows;
}

// opts: { full (default true), quiet, noAlerts }. Returns { processed, counts, timedOut }.
function runFlipScan(timeBudgetMsOverride, dryRun, opts) {
  opts = opts || {};
  const full = opts.full !== false;
  const ui = opts.quiet ? null : tryGetUi_();
  const startMs = Date.now();
  const C = FLIP_CONFIG;
  const budgetMs = (typeof timeBudgetMsOverride === 'number' && timeBudgetMsOverride > 0) ? timeBudgetMsOverride : C.timeBudgetMs;
  const now = new Date();
  const sess = marketSessionAt_(now);
  const todayYmd = flipTodayYmd_(now);
  const closeMin = US_MARKET_EARLY_CLOSES[todayYmd] ? 210 : 390;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(FLIP_SHEET_NAME);
  if (!sheet) { notify_(ui, 'Flip', 'No "' + FLIP_SHEET_NAME + '" tab. Run setupFlip once from the Apps Script editor.'); return null; }
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('FLIP_RUNNING') || '0', 10);
  if (running && Date.now() - running < 10 * 60000) { notify_(ui, 'Flip', 'A Flip run is already in progress. Try again in a minute.'); return null; }

  const map = flipEnsureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { notify_(ui, 'Flip', 'No tickers yet. Run 🔁 Flip > Promote Research Picks, or type tickers in column A.'); return null; }
  const width = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, width).getValues();
  const rows = flipParseInputs_(data, map, now);
  if (!rows.length) { notify_(ui, 'Flip', 'No tickers found in column A.'); return null; }

  props.setProperty('FLIP_RUNNING', String(Date.now()));
  try {
    const cache = flipCacheLoad_();
    const pending = {};
    const ctx = { cache: cache, pending: pending, now: now, token: null, chains: {}, finnhubKey: null };
    if (full) { ctx.token = getTastyTradeAccessToken_(); ctx.finnhubKey = getFinnhubApiKey_(); }

    // Which rows this run covers. A tick (full=false) covers held rows plus candidates whose contract was already picked today.
    const heldRows = rows.filter(function (r) { return r.held; });
    let cands = rows.filter(function (r) { return !r.held; });
    if (!full) cands = cands.filter(function (r) { return !!flipCacheGet_(cache, 'CON|' + r.ticker, 0, now); });
    cands.sort(function (a, b) { return a.lastRun - b.lastRun; });
    const work = heldRows.concat(cands);
    if (!work.length) { notify_(ui, 'Flip', 'Nothing to check.'); return { processed: 0, counts: {}, timedOut: false }; }

    const tickers = work.map(function (r) { return r.ticker; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
    const withSpy = tickers.indexOf('SPY') === -1 ? tickers.concat(['SPY']) : tickers;

    // Daily data (cached per day) -> features, minus today's still-forming bar.
    const rawBars = flipGetBars_(withSpy, ctx, '6mo', 'FB');
    const barsOf = function (t) {
      const o = flipBarsToObjects_(rawBars[t]);
      return o.length && o[o.length - 1].d === todayYmd ? o.slice(0, -1) : o;
    };
    const spyObj = barsOf('SPY');
    const feat = {}, prevClose = {};
    tickers.forEach(function (t) {
      const b = barsOf(t);
      feat[t] = flipFeatures_(b, spyObj);
      prevClose[t] = b.length ? b[b.length - 1].c : null;
    });
    const daily = flipGetDaily_(tickers, ctx);

    // Intraday (one Cloud call) and live option quotes (one Cloud call).
    const ivMap = sess.open ? fetchIntradayMap_(withSpy) : {};
    const spy = ivMap['SPY'] || null;
    const spyHead = !!(spy && spy.vwapPct != null && spy.aroonUp != null && spy.aroonDown != null && spy.vwapPct < 0 && spy.aroonDown > spy.aroonUp);
    const env = { now: now, sess: sess, closeMin: closeMin, S: FLIP_SIGNAL, spyHead: spyHead, feat: feat, prevClose: prevClose, daily: daily, ivFresh: {},
      picks: {}, quotes: {}, ctx: ctx, full: full, open: [], todayYmd: todayYmd };
    tickers.forEach(function (t) { env.ivFresh[t] = flipFreshIv_(ivMap[t], env); });

    // Contracts for candidates (cached for the day; only a full scan may hit the chain endpoint).
    let timedOut = false;
    const gateOk = function (t) {
      const f = feat[t]; if (!f) return false;
      const d = daily[t] || {};
      return f.price >= C.minPrice && f.atrPct >= C.minAtrPct && f.atrPct <= C.maxAtrPct && !(d.offHigh != null && d.offHigh > C.maxOffHighPct);
    };
    cands.forEach(function (r) {
      const t = r.ticker;
      if (!gateOk(t)) return;
      const cached = flipCacheGet_(cache, 'CON|' + t, 0, now);
      if (cached) { env.picks[t] = cached; return; }
      if (!full) return;
      if (Date.now() - startMs > budgetMs * 0.6) { timedOut = true; return; }
      const f = feat[t], spot = env.ivFresh[t] && env.ivFresh[t].lastPrice > 0 ? env.ivFresh[t].lastPrice : f.price;
      env.picks[t] = flipPickContract_(t, spot, f.sigmaDay, ctx);
    });

    const occ = [];
    heldRows.forEach(function (r) { if (r.complete) occ.push(buildOccSymbol_(r.ticker, r.expiry, r.strike, 'C')); });
    Object.keys(env.picks).forEach(function (t) { const p = env.picks[t]; if (p && p.ok && p.c.symbol && occ.indexOf(p.c.symbol) === -1) occ.push(p.c.symbol); });
    env.quotes = sess.open || heldRows.length ? fetchOptionQuotesMap_(occ) : {};

    // Open book -> portfolio guard.
    heldRows.forEach(function (r) {
      if (!r.complete) return;
      const q = env.quotes[buildOccSymbol_(r.ticker, r.expiry, r.strike, 'C')];
      const bid = q && q.bid > 0 ? q.bid : null;
      env.open.push({ ticker: r.ticker, theme: flipThemeOf_(r.ticker), cost: r.entry * 100 * r.qty, plUsd: bid ? (bid - r.entry) * 100 * r.qty : 0,
        entryYmd: r.entryDate ? Utilities.formatDate(r.entryDate, 'America/New_York', 'yyyy-MM-dd') : '' });
    });

    // Rows.
    const outCols = FLIP_OUTPUT_HEADERS.filter(function (h) { return map[h]; });
    const counts = {};
    const errors = [];
    const stamp = new Date();
    let processed = 0;
    const alertItems = [], logItems = [], pnlByIdx = {}, sortKeyByIdx = {};
    let prevPx = {}; const newPx = {};
    try { prevPx = JSON.parse(props.getProperty('FLIP_PREV_PRICE') || '{}') || {}; } catch (e) { prevPx = {}; }
    for (let i = 0; i < work.length; i++) {
      if (Date.now() - startMs > budgetMs) { timedOut = true; break; }
      const rw = work[i];
      let res;
      try { res = rw.held ? flipProcessHeld_(rw, env) : flipProcessCandidate_(rw, env); }
      catch (e) { res = { Action: 'WAIT', Why: 'error: ' + (e && e.message ? e.message : e) }; errors.push(rw.ticker + ': ' + (e && e.message ? e.message : e)); }
      res['LastRun'] = stamp;
      if (typeof res['Price'] === 'number' && res['Price'] > 0) {
        if (prevPx[rw.ticker] > 0) res['Change'] = flipR2_(res['Price'] - prevPx[rw.ticker]);
        newPx[rw.ticker] = res['Price'];
      }
      sortKeyByIdx[rw.idx] = flipSortKey_(res['Action'], res['Score'], res._plPct);
      try { flipBuildAlertItems_(rw, res, alertItems); flipBuildLogItems_(rw, res, env, logItems); } catch (e) { /* alerts and logging never break a scan */ }
      const row = data[rw.idx];
      const keep = rw.held ? FLIP_HELD_WHEN_OPEN : [];
      outCols.forEach(function (h) { if (keep.indexOf(h) === -1) row[map[h] - 1] = ''; });
      outCols.forEach(function (h) { if (keep.indexOf(h) === -1 && res[h] !== undefined && res[h] !== null) row[map[h] - 1] = res[h]; });
      pnlByIdx[rw.idx] = (res['P/L $'] === undefined || res['P/L $'] === null) ? '' : res['P/L $'];
      counts[res['Action']] = (counts[res['Action']] || 0) + 1;
      processed++;
    }

    if (!dryRun) {
      const cols = outCols.map(function (h) { return map[h]; }).sort(function (a, b) { return a - b; });
      let g0 = 0;
      while (g0 < cols.length) {
        let g1 = g0;
        while (g1 + 1 < cols.length && cols[g1 + 1] === cols[g1] + 1) g1++;
        const c0 = cols[g0], c1 = cols[g1];
        sheet.getRange(2, c0, data.length, c1 - c0 + 1).setValues(data.map(function (r) { return r.slice(c0 - 1, c1); }));
        g0 = g1 + 1;
      }
      // P/L $ column: rows processed this run get the dollar P/L (or blank); other rows keep what is there (formula or value).
      try {
        if (!flipPnlCol_(map)) throw new Error('P/L $ column not found (see FLIP_FIXED_COLUMNS)');
        const rngP = sheet.getRange(2, flipPnlCol_(map), data.length, 1);
        const fx = rngP.getFormulas(), vx = rngP.getValues();
        rngP.setValues(data.map(function (r, i) {
          if (pnlByIdx[i] !== undefined) return [pnlByIdx[i]];
          return [fx[i][0] !== '' ? fx[i][0] : vx[i][0]];
        }));
      } catch (e) { logToSheet_('Flip: could not write the P/L $ column: ' + (e && e.message ? e.message : e)); }
      if (map['Change']) sheet.getRange(2, map['Change'], data.length, 1).setNumberFormat(FLIP_CHANGE_FORMAT);
      try { Object.keys(newPx).forEach(function (k) { prevPx[k] = newPx[k]; }); props.setProperty('FLIP_PREV_PRICE', JSON.stringify(prevPx)); } catch (e) { /* too big: skip */ }
      flipColorRows_(sheet, map, data.length);
      flipApplyRules_(sheet, map, true);
      if (full) flipSortRows_(sheet, map, data, sortKeyByIdx);
      flipCacheFlush_(pending);
      if (logItems.length) flipAppendLog_(logItems, now);
    }

    let alertNote = '';
    if (!dryRun && !opts.noAlerts) { const ar = flipDispatchAlerts_(alertItems, now); alertNote = ar.note ? 'Alerts: ' + ar.note + '\n' : ''; }

    const sec = Math.round((Date.now() - startMs) / 1000);
    const order = ['STOP', 'TIME-STOP', 'SELL', 'REVIEW', 'FILL IN', 'HOLD', 'BUY', 'READY', 'BLOCKED', 'WAIT', 'SKIP'];
    const msg =
      (dryRun ? '(DRY RUN: nothing written)\n' : '') +
      (timedOut ? '⏱️ Stopped at the time limit: ' + processed + ' of ' + work.length + ' rows done. Run again to continue with the stalest rows.\n\n' : '') +
      'Rows processed: ' + processed + ' of ' + work.length + (full ? '' : ' (quick check)') + ' in ' + sec + 's\n' + alertNote +
      order.filter(function (k) { return counts[k]; }).map(function (k) { return k + ': ' + counts[k]; }).join('   ') + '\n' +
      (sess.open ? '' : 'Market is closed: entry signals are evaluated only while it is open.\n') +
      (spyHead ? 'SPY headwind: strong entries are held back.\n' : '') +
      (full && !ctx.token ? '⚠️ No TastyTrade token: contracts cannot be picked.\n' : '') +
      (errors.length ? '\nErrors:\n' + errors.map(function (e) { return '  • ' + e; }).join('\n') : '');
    notify_(ui, 'Flip scan complete', msg);
    return { processed: processed, counts: counts, timedOut: timedOut };
  } finally {
    props.deleteProperty('FLIP_RUNNING');
  }
}

function flipColorRows_(sheet, map, n) {
  if (!map['Action']) return;
  const colorFor = { 'BUY': '#b7e1cd', 'READY': '#d9ead3', 'BLOCKED': '#fce5cd', 'WAIT': '#fff2cc', 'SKIP': '#eeeeee', 'HOLD': '#cfe2f3',
    'SELL': '#93c47d', 'STOP': '#e06666', 'TIME-STOP': '#f6b26b', 'REVIEW': '#f4cccc', 'FILL IN': '#f4cccc' };
  const rng = sheet.getRange(2, map['Action'], n, 1);
  rng.setBackgrounds(rng.getValues().map(function (v) { return [colorFor[v[0]] || null]; }));
}


// Orders the rows (STOP / SELL first, then HOLD, BUY, READY, BLOCKED, WAIT, SKIP) without a SortKey column on the sheet:
// a temporary column carries the keys for the sort and is deleted straight after. Rows keep their inputs and formulas.
function flipSortRows_(sheet, map, data, keys) {
  const n = data.length;
  if (n < 2) return;
  const a = map['Action'] - 1, sc = map['Score'] - 1;
  const col = data.map(function (r, i) {
    return [keys[i] !== undefined ? keys[i] : flipSortKey_(String(r[a] || ''), flipNum_(r[sc]) || 0, 0)];
  });
  const lastC = sheet.getLastColumn();
  sheet.insertColumnAfter(lastC);
  const tmp = lastC + 1;
  try {
    sheet.getRange(2, tmp, n, 1).setValues(col);
    sheet.getRange(2, 1, n, tmp).sort({ column: tmp, ascending: false });
  } finally {
    sheet.deleteColumn(tmp);
  }
}


/* ============================================================================
 * SIGNAL LOG (FlipLog): every BUY / READY, so it can be graded later
 * ========================================================================== */

function flipBuildLogItems_(rw, res, env, items) {
  const a = res['Action'];
  if ((a !== 'BUY' && a !== 'READY') || !res._geo || rw.held) return;
  const g = res._geo, b = res._base, live = res._live;
  const exp = flipDate_(b.expiry);
  items.push({
    key: rw.ticker + '|' + a,
    row: [Utilities.formatDate(env.now, 'America/New_York', 'yyyy-MM-dd HH:mm'), rw.ticker, a, flipR2_(res._price), b.strike,
      exp ? Utilities.formatDate(exp, 'America/New_York', 'yyyy-MM-dd') : '', flipR2_(live.mid), flipR2_(live.delta), flipR1_(g.lev), flipR2_(live.spreadPct),
      flipR2_(g.need), flipR2_(g.stopDist), flipR1_(g.pHit * 100), flipR1_(g.edgeNeeded), res['Score'],
      res['AUP'] === undefined ? '' : res['AUP'], res['ADN'] === undefined ? '' : res['ADN'], res['RSI'] === undefined ? '' : res['RSI'],
      res['VW %'] === undefined ? '' : res['VW %'], res['RVOL'] === undefined ? '' : res['RVOL'],
      res['Off High %'] === undefined ? '' : res['Off High %'], res['Trend'] || '', res['Earn Days'] === undefined ? '' : res['Earn Days'],
      '', '', '', '', '', '']
  });
}

// Appends new signals, at most one per ticker+signal per logCooldownMin minutes.
function flipAppendLog_(items, now) {
  try {
    const props = PropertiesService.getScriptProperties();
    let state = {};
    try { state = JSON.parse(props.getProperty('FLIP_LOG_STATE') || '{}'); } catch (e) { state = {}; }
    const nowMs = now.getTime(), cool = FLIP_CONFIG.logCooldownMin * 60000;
    const rows = [];
    items.forEach(function (it) {
      if (state[it.key] && nowMs - state[it.key] < cool) return;
      state[it.key] = nowMs; rows.push(it.row);
    });
    if (!rows.length) return 0;
    Object.keys(state).forEach(function (k) { if (nowMs - state[k] > 86400000) delete state[k]; });
    props.setProperty('FLIP_LOG_STATE', JSON.stringify(state));
    const sh = flipEnsureSheet_(FLIP_LOG_SHEET, FLIP_LOG_HEADERS);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, FLIP_LOG_HEADERS.length).setValues(rows);
    return rows.length;
  } catch (e) { logToSheet_('Flip: signal log failed: ' + e); return 0; }
}


/* ============================================================================
 * ALERTS (same Telegram / Pushover / ntfy setup as Quick; own on/off switch and own state)
 * ========================================================================== */

function flipAlertsOn_() { return PropertiesService.getScriptProperties().getProperty('FLIP_ALERTS') !== 'false'; }

function flipBuildAlertItems_(rw, res, items) {
  const a = res['Action'];
  const t = rw.ticker;
  if (a === 'STOP' || a === 'TIME-STOP' || a === 'SELL') {
    if (!rw.complete) return;
    const key = a + '|' + t + '|' + rw.strike + '|' + Utilities.formatDate(rw.expiry, 'America/New_York', 'yyyyMMdd');
    items.push({ kind: 'exit', key: key, text: a + ' ' + t + ' ' + flipContractText_(rw.expiry, rw.strike) + ' (x' + rw.qty + '): ' + res['Why'] });
  } else if (a === 'BUY' || a === 'READY') {
    if (!res._base) return;
    const b = res._base, live = res._live;
    const key = a + '|' + t + '|' + b.strike + '|' + String(b.expiry).replace(/-/g, '');
    const txt = (a === 'BUY' ? 'BUY ' : 'READY ') + t + ' ' + res['Contract'] + ' | ask ' + flipR2_(live.ask) + ' (spread ' + flipR1_(live.spreadPct) + '%) | size ' + res['Size'] +
      ' | target ' + res['Target'] + ' stop ' + res['Stop'] + ' (-' + res['Stop %'] + '%) | stock needs +' + res['Need %'] + '% | P hit ' + res['P Hit %'] + '% edge ' + res['Edge Needed'] +
      ' | AUP ' + res['AUP'] + ' ADN ' + res['ADN'] + ' RSI ' + res['RSI'] + ' | score ' + res['Score'];
    items.push({ kind: a === 'BUY' ? 'buy' : 'ready', key: key, text: txt });
  }
}

// Returns { sent, note }. State only changes when the message really went out.
function flipDispatchAlerts_(items, now) {
  try {
    if (!items || !items.length) return { sent: 0, note: '' };
    if (!flipAlertsOn_()) return { sent: 0, note: 'Flip alerts are switched off (menu: Flip > Alerts & Schedule).' };
    const A = FLIP_CONFIG.alerts;
    const cfg = getAlertConfig_();
    if (!cfg.ready) return { sent: 0, note: 'phone alerts are not set up or are off (menu: Options Validator > Phone Alerts).' };
    const props = PropertiesService.getScriptProperties();
    let state = {};
    try { state = JSON.parse(props.getProperty('FLIP_ALERT_STATE') || '{}'); } catch (e) { state = {}; }
    const nowMs = now.getTime();
    const repeat = { exit: A.exitRepeatMin, buy: A.buyRepeatMin, ready: A.readyRepeatMin };
    const fresh = items.filter(function (it) {
      if (it.kind === 'ready' && !A.alertReady) return false;
      return !state[it.key] || nowMs - state[it.key] >= repeat[it.kind] * 60000;
    });
    if (!fresh.length) return { sent: 0, note: items.length + ' signal(s), none new (already alerted inside their repeat window, or READY alerts are off).' };
    const rank = { exit: 0, buy: 1, ready: 2 };
    fresh.sort(function (a, b) { return rank[a.kind] - rank[b.kind]; });
    const n = function (k) { return fresh.filter(function (it) { return it.kind === k; }).length; };
    const parts = [];
    if (n('exit')) parts.push(n('exit') + ' EXIT');
    if (n('buy')) parts.push(n('buy') + ' BUY');
    if (n('ready')) parts.push(n('ready') + ' get ready');
    const lines = fresh.slice(0, 6).map(function (it) { return it.text; });
    if (fresh.length > 6) lines.push('+' + (fresh.length - 6) + ' more on the sheet');
    const r = sendPhoneAlert_(cfg, 'Flip: ' + parts.join(', '), lines.join('\n\n'), n('exit') + n('buy') > 0);
    if (!r.ok) { logToSheet_('Flip alert failed: ' + r.detail); return { sent: 0, note: 'send failed (' + r.detail + ')' }; }
    fresh.forEach(function (it) { state[it.key] = nowMs; });
    Object.keys(state).forEach(function (k) { if (nowMs - state[k] > 3 * 86400000) delete state[k]; });
    props.setProperty('FLIP_ALERT_STATE', JSON.stringify(state));
    return { sent: fresh.length, note: 'sent ' + fresh.length + ' (' + parts.join(', ') + ')' };
  } catch (e) {
    logToSheet_('Flip alert error: ' + e);
    return { sent: 0, note: 'error: ' + e };
  }
}

function sendTestFlipAlert_() {
  const ui = tryGetUi_();
  const cfg = getAlertConfig_();
  if (!cfg.ready) { notify_(ui, 'Flip alert test', 'Phone alerts are not set up or are off. Use Options Validator > Phone Alerts first (the same setup serves Quick, CSP and Flip).'); return; }
  const r = sendPhoneAlert_(cfg, 'Flip: test', 'Test alert from the Flip tab. A real one looks like:\nBUY APP Jan 2028 $300C | ask 61.40 (spread 1.1%) | size 1 | target 63.7 stop 55.9 (-9.0%) | stock needs +1.9% | P hit 39% edge 4.1 | AUP 85 ADN 20 RSI 33 | score 72', false);
  notify_(ui, 'Flip alert test', r.ok ? 'Sent. ' + r.detail : 'Failed: ' + r.detail);
}

function toggleFlipAlerts_() {
  const ui = tryGetUi_();
  const nowOn = flipAlertsOn_();
  PropertiesService.getScriptProperties().setProperty('FLIP_ALERTS', nowOn ? 'false' : 'true');
  notify_(ui, 'Flip alerts', 'Flip alerts are now ' + (nowOn ? 'OFF' : 'ON') + '. (Quick and CSP alerts are unaffected.)');
}


/* ============================================================================
 * SCHEDULE — one 5-minute trigger. Outside market hours it returns at once (no network).
 *   every tick in market hours: held positions + candidates already picked today (cheap)
 *   every fullScanEveryMin: full scan (new contracts, earnings, sort)
 *   before the open: research promotion      after the close: grade past signals
 * ========================================================================== */

const FLIP_TICK_FN = 'flipScheduledTick_';

function flipEtParts_(now) {
  const tz = 'America/New_York';
  return { dow: parseInt(Utilities.formatDate(now, tz, 'u'), 10), hhmm: Utilities.formatDate(now, tz, 'HH:mm'), ymd: Utilities.formatDate(now, tz, 'yyyy-MM-dd') };
}

function flipRemoveTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === FLIP_TICK_FN) { ScriptApp.deleteTrigger(t); n++; } });
  return n;
}

function startFlipSchedule_() {
  const ui = tryGetUi_();
  flipRemoveTriggers_();
  ScriptApp.newTrigger(FLIP_TICK_FN).timeBased().everyMinutes(5).create();
  const S = FLIP_CONFIG.schedule;
  notify_(ui, 'Flip schedule started',
    'Runs every 5 minutes; outside Mon-Fri ' + S.startHHmm + '-' + S.endHHmm + ' ET each run exits in milliseconds.\n' +
    'Each in-hours tick checks your held positions and today\'s candidates; every ' + S.fullScanEveryMin + ' minutes it does a full scan.\n' +
    'Research promotion runs before the open; past signals are graded after ' + S.gradeAfterHHmm + '.\n' +
    'Phone alerts go through the Quick alert setup.');
}

function stopFlipSchedule_() { notify_(tryGetUi_(), 'Flip schedule', 'Stopped (' + flipRemoveTriggers_() + ' trigger(s) removed).'); }

function flipScheduleStatus_() {
  const props = PropertiesService.getScriptProperties();
  const n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === FLIP_TICK_FN; }).length;
  const lastFull = parseInt(props.getProperty('FLIP_LAST_FULL') || '0', 10);
  const cfg = getAlertConfig_();
  notify_(tryGetUi_(), 'Flip schedule status',
    'Schedule: ' + (n ? 'ON' : 'OFF') + '\nLast full scan: ' + (lastFull ? new Date(lastFull).toString() : 'never') +
    '\nLast promotion: ' + (props.getProperty('FLIP_LAST_PROMOTE') || 'never') + '\nLast grading: ' + (props.getProperty('FLIP_LAST_GRADE') || 'never') +
    '\nFlip alerts: ' + (flipAlertsOn_() ? 'ON' : 'OFF') + '; phone provider ' + (cfg.ready ? 'ready (' + cfg.provider + ')' : 'NOT ready'));
}

function flipScheduledTick_() {
  const now = new Date();
  const p = flipEtParts_(now);
  if (p.dow < 1 || p.dow > 5) return;
  const S = FLIP_CONFIG.schedule;
  const inMarket = p.hhmm >= S.startHHmm && p.hhmm <= S.endHHmm;
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('FLIP_RUNNING') || '0', 10);
  if (running && Date.now() - running < 10 * 60000) return;
  const mark = function (k) { props.setProperty(k, p.ymd); };

  if (!inMarket) {
    if (p.hhmm >= '06:00' && p.hhmm < S.startHHmm && props.getProperty('FLIP_LAST_PROMOTE') !== p.ymd) {
      props.setProperty('FLIP_RUNNING', String(Date.now()));
      try { const r = flipPromote_({ quiet: true, timeBudgetMs: 240000 }); if (r && r.complete) mark('FLIP_LAST_PROMOTE'); }
      catch (e) { logToSheet_('Flip promote error: ' + e); }
      finally { props.deleteProperty('FLIP_RUNNING'); }
    } else if (p.hhmm >= S.gradeAfterHHmm && p.hhmm < '20:00' && props.getProperty('FLIP_LAST_GRADE') !== p.ymd) {
      props.setProperty('FLIP_RUNNING', String(Date.now()));
      try { flipGradeSignals({ quiet: true }); mark('FLIP_LAST_GRADE'); }
      catch (e) { logToSheet_('Flip grading error: ' + e); }
      finally { props.deleteProperty('FLIP_RUNNING'); }
    }
    return;
  }
  const lastFull = parseInt(props.getProperty('FLIP_LAST_FULL') || '0', 10);
  const full = !lastFull || Date.now() - lastFull >= S.fullScanEveryMin * 60000 - 90000 || new Date(lastFull).toDateString() !== now.toDateString();
  const r = runFlipScan(full ? 250000 : 100000, false, { quiet: true, full: full });
  if (full && r && !r.timedOut) props.setProperty('FLIP_LAST_FULL', String(Date.now()));
}


/* ============================================================================
 * PROMOTION — which names deserve a row
 * ----------------------------------------------------------------------------
 * Fit (0-100) = Range 25 + Liquidity 25 + Structure 35 + Personal 15.
 *   Range     ATR% sweet spot 3-6% (enough movement to reach +3% in days, not so much that the stop is noise)
 *   Liquidity average daily dollar volume, log scale, $1B (0) to $10B (full)
 *   Structure daily trend (Up 15, Pullback 10, Mixed 5, Down 0) + distance under the 52-week high (10) + above the 200-day (10)
 *   Personal  your own Results history: net winner 15, net loser 6; on Quick/Research only 8
 * Hard gates: dollar volume >= $1B, price >= $20, ATR 1.8-9%, <= 40% under the 52-week high.
 * Keeps the best 30 with Fit >= 60. A name you added by hand (only names this promotion added can be retired), a held position, or a row with
 * a Qty is never removed. Promoted names that miss the cut 5 promotions in a row are retired.
 * ========================================================================== */

function flipReadTickerColumn_(sheetName) {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return [];
    const top = sh.getRange(1, 1, Math.min(5, sh.getLastRow()), sh.getLastColumn()).getValues();
    let hr = -1, hc = -1;
    for (let r = 0; r < top.length && hr < 0; r++) for (let c = 0; c < top[r].length; c++) if (String(top[r][c]).trim().toLowerCase() === 'ticker') { hr = r; hc = c; break; }
    if (hr < 0) return [];
    const vals = sh.getRange(hr + 2, hc + 1, sh.getLastRow() - hr - 1, 1).getValues();
    return vals.map(function (v) { return String(v[0] || '').trim().toUpperCase(); }).filter(function (t) { return /^[A-Z.]{1,6}$/.test(t); });
  } catch (e) { return []; }
}

// Net result per ticker from the Results tab (calls only).
function flipResultsByTicker_() {
  const out = {};
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIP_RESULTS_SHEET);
    if (!sh || sh.getLastRow() < 3) return out;
    sh.getRange(3, 1, sh.getLastRow() - 2, 10).getValues().forEach(function (r) {
      const t = String(r[1] || '').trim().toUpperCase(), profit = flipMoney_(r[8]);
      if (!t || profit == null || !/C$/i.test(String(r[2]).trim())) return;
      out[t] = (out[t] || 0) + profit;
    });
  } catch (e) { /* personal score falls back to 0 */ }
  return out;
}

function flipMoney_(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v == null ? '' : v).replace(/[$,%\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (s === '') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

// Pure: Fit score from inputs. f = flipFeatures_, d = Cloud daily, dollarVolM, personal in {win, loss, listed, none}.
function flipFit_(f, d, dollarVolM, personal) {
  const C = FLIP_CONFIG;
  if (!f) return { fit: 0, gate: 'no price history' };
  if (!(dollarVolM >= C.promote.minDollarVolM)) return { fit: 0, gate: 'dollar volume $' + Math.round(dollarVolM || 0) + 'M under $' + C.promote.minDollarVolM + 'M' };
  if (f.price < C.minPrice) return { fit: 0, gate: 'price under $' + C.minPrice };
  if (!(f.atrPct >= C.minAtrPct && f.atrPct <= C.maxAtrPct)) return { fit: 0, gate: 'ATR ' + flipR1_(f.atrPct) + '% outside ' + C.minAtrPct + '-' + C.maxAtrPct };
  const offHigh = d && d.offHigh != null ? d.offHigh : (1 - f.price / f.high3m) * 100;
  if (offHigh > C.maxOffHighPct) return { fit: 0, gate: flipR1_(offHigh) + '% under the high' };
  const range = 25 * Math.min(flipLin_(f.atrPct, 1.8, 3), flipLin_(f.atrPct, 9, 6));
  const liq = 25 * flipLin_(Math.log(dollarVolM) / Math.LN10, 3, 4);
  const trend = { 'Up': 15, 'Pullback': 10, 'Mixed': 5, 'Down': 0 }[f.trend] || 0;
  const struct = trend + 10 * flipLin_(offHigh, 40, 10) + ((d && d.t200 != null) ? (d.t200 > 0 ? 10 : 0) : 5);
  const pers = { win: 15, loss: 6, listed: 8, none: 0 }[personal] || 0;
  const fit = Math.round(range + liq + struct + pers);
  return { fit: fit, note: 'range ' + Math.round(range) + ' liq ' + Math.round(liq) + ' struct ' + Math.round(struct) + ' you ' + pers + ' | ATR ' + flipR1_(f.atrPct) + '% $vol ' + Math.round(dollarVolM) + 'M ' + f.trend };
}

function runFlipPromote() { return flipPromote_({}); }

function flipPromote_(opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const C = FLIP_CONFIG, P = C.promote;
  const startMs = Date.now();
  const budget = opts.timeBudgetMs || P.timeBudgetMs;
  const now = new Date();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(FLIP_SHEET_NAME);
  if (!sheet) { notify_(ui, 'Flip promote', 'No Flip tab. Run setupFlip first.'); return { complete: false }; }
  const map = flipEnsureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  const width = sheet.getLastColumn();
  const data = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];

  const onSheet = {};
  data.forEach(function (r, i) { const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase(); if (t) onSheet[t] = i; });
  const byResults = flipResultsByTicker_();
  const listed = {};
  flipReadTickerColumn_(FLIP_QUICK_SHEET).concat(flipReadTickerColumn_('Research')).forEach(function (t) { listed[t] = true; });
  const universe = FLIP_UNIVERSE.concat(Object.keys(listed)).concat(Object.keys(onSheet)).concat(Object.keys(byResults))
    .filter(function (t, i, a) { return a.indexOf(t) === i && t !== 'SPY'; });

  const cache = flipCacheLoad_(), pending = {};
  const ctx = { cache: cache, pending: pending, now: now };
  const todayYmd = flipTodayYmd_(now);
  const rawBars = flipGetBars_(universe.concat(['SPY']), ctx, '6mo', 'FB');
  const daily = flipGetDaily_(universe, ctx);
  const barsOf = function (t) { const o = flipBarsToObjects_(rawBars[t]); return o.length && o[o.length - 1].d === todayYmd ? o.slice(0, -1) : o; };
  const spyObj = barsOf('SPY');

  const scored = [];
  universe.forEach(function (t) {
    if (Date.now() - startMs > budget) return;
    const b = barsOf(t);
    const f = flipFeatures_(b, spyObj);
    let dv = null;
    if (b.length >= 20) { let s = 0; for (let i = b.length - 20; i < b.length; i++) s += b[i].c * (b[i].v || 0); dv = s / 20 / 1e6; }
    const personal = byResults[t] != null ? (byResults[t] > 0 ? 'win' : 'loss') : (listed[t] ? 'listed' : 'none');
    const r = flipFit_(f, daily[t], dv, personal);
    scored.push({ t: t, fit: r.fit, note: r.gate ? 'gated: ' + r.gate : r.note, gated: !!r.gate });
  });
  const complete = scored.length === universe.length;
  scored.sort(function (a, b) { return b.fit - a.fit; });
  const keep = {};
  scored.filter(function (s) { return !s.gated && s.fit >= P.minFit; }).slice(0, P.maxKeep).forEach(function (s) { keep[s.t] = s; });
  const scoreOf = {};
  scored.forEach(function (s) { scoreOf[s.t] = s; });

  const props = PropertiesService.getScriptProperties();
  let misses = {};
  try { misses = JSON.parse(props.getProperty('FLIP_MISSES') || '{}'); } catch (e) { misses = {}; }

  let promotedSet = {};
  try { promotedSet = JSON.parse(props.getProperty('FLIP_PROMOTED') || '{}'); } catch (e) { promotedSet = {}; }
  const added = [], retired = [], protectedKept = [];
  const toDelete = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const s = scoreOf[t];
    if (s) r[map['Fit'] - 1] = s.fit;
    if (keep[t]) { misses[t] = 0; return; }
    // Only names this promotion added (remembered in FLIP_PROMOTED) can be retired. Everything else, and anything you hold, stays.
    const heldNow = flipNum_(r[map['Qty'] - 1]) > 0;
    if (!promotedSet[t] || heldNow) { protectedKept.push(t); return; }
    if (!complete || !s) return;
    misses[t] = (misses[t] || 0) + 1;
    if (misses[t] >= P.removeAfterMisses) { toDelete.push(i); retired.push(t); delete misses[t]; }
  });
  const newRows = [];
  Object.keys(keep).forEach(function (t) {
    if (onSheet[t] != null) return;
    const row = new Array(width).fill('');
    row[map['Ticker'] - 1] = t; row[map['Fit'] - 1] = keep[t].fit;
    newRows.push(row); added.push(t);
  });

  if (!opts.dryRun) {
    if (data.length) {
      sheet.getRange(2, map['Fit'], data.length, 1).setValues(data.map(function (r) { return [r[map['Fit'] - 1]]; }));
    }
    toDelete.sort(function (a, b) { return b - a; }).forEach(function (i) { sheet.deleteRow(i + 2); });
    if (newRows.length) {
      const start = sheet.getLastRow() + 1;
      sheet.getRange(start, 1, newRows.length, width).setValues(newRows);
    }
    added.forEach(function (t) { promotedSet[t] = 1; });
    retired.forEach(function (t) { delete promotedSet[t]; });
    props.setProperty('FLIP_PROMOTED', JSON.stringify(promotedSet));
    props.setProperty('FLIP_MISSES', JSON.stringify(misses));
    flipCacheFlush_(pending);
    logToSheet_('Flip promotion COMPLETE: ' + scored.length + ' scored, kept ' + Object.keys(keep).length + ', added ' + added.length + ', retired ' + retired.length);
  }
  const top = scored.filter(function (s) { return !s.gated; }).slice(0, 12).map(function (s) { return s.t + ' ' + s.fit; }).join(', ');
  notify_(ui, 'Flip promotion' + (opts.dryRun ? ' (DRY RUN)' : ''),
    'Scored ' + scored.length + ' of ' + universe.length + ' names in ' + Math.round((Date.now() - startMs) / 1000) + 's' + (complete ? '' : ' (time limit: partial, nothing retired)') + '.\n' +
    'Added (' + added.length + '): ' + (added.join(', ') || 'none') + '\nRetired (' + retired.length + '): ' + (retired.join(', ') || 'none') + '\n' +
    'Top Fit: ' + top + '\nPromotion needs Fit >= ' + P.minFit + ' and passes the hard gates; names you added by hand are never removed.');
  return { complete: complete, added: added, retired: retired, scored: scored.length };
}


/* ============================================================================
 * GRADING — did the signals work? (independent of what you traded)
 * ----------------------------------------------------------------------------
 * For each logged BUY / READY, the daily bars AFTER the signal day are walked for up to horizonDays days:
 *   TARGET  the stock's high reached the Need % level first
 *   STOP    the stock's low reached the stop distance first (a day touching both counts as STOP: the conservative call)
 *   TIME    neither within the window
 * The signal day itself cannot be graded from daily bars (the high/low may have come before the signal), so a same-day
 * +1.5% scalp is invisible here. MFE / MAE are the best / worst stock excursions in the window.
 * ========================================================================== */

// Pure. bars: [{d,h,l,c}] oldest first. sig: { ymd, stock, need, stop }. Returns null while undecided.
function flipGradeOne_(bars, sig, horizon) {
  const after = bars.filter(function (b) { return b.d > sig.ymd; });
  if (!after.length || !(sig.stock > 0)) return null;
  let mfe = -Infinity, mae = Infinity;
  const n = Math.min(after.length, horizon);
  for (let k = 0; k < n; k++) {
    const b = after[k];
    const up = (b.h / sig.stock - 1) * 100, dn = (b.l / sig.stock - 1) * 100;
    mfe = Math.max(mfe, up); mae = Math.min(mae, dn);
    const hitT = up >= sig.need, hitS = dn <= -sig.stop;
    if (hitT || hitS) {
      return { outcome: hitS ? 'STOP' : 'TARGET', days: k + 1, mfe: mfe, mae: mae, note: hitT && hitS ? 'touched both the same day: counted as STOP' : '' };
    }
  }
  if (after.length >= horizon) {
    const close = (after[horizon - 1].c / sig.stock - 1) * 100;
    return { outcome: 'TIME', days: horizon, mfe: mfe, mae: mae, note: 'close on day ' + horizon + ' ' + (close >= 0 ? '+' : '') + close.toFixed(1) + '%' };
  }
  return null;
}

function flipGradeSignals(opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(FLIP_LOG_SHEET);
  if (!sh || sh.getLastRow() < 2) { notify_(ui, 'Flip grading', 'No signals logged yet.'); return { graded: 0 }; }
  const H = {}; FLIP_LOG_HEADERS.forEach(function (h, i) { H[h] = i; });
  const n = sh.getLastRow() - 1;
  const data = sh.getRange(2, 1, n, FLIP_LOG_HEADERS.length).getValues();
  const todo = [];
  data.forEach(function (r, i) {
    if (r[H['Outcome']] !== '' || !r[H['Ticker']]) return;
    const ymd = String(r[H['Time']]).substring(0, 10);
    const stock = flipNum_(r[H['Stock']]), need = flipNum_(r[H['Need %']]), stop = flipNum_(r[H['Stop Dist %']]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || !(stock > 0) || !(need > 0) || !(stop > 0)) return;
    todo.push({ i: i, t: String(r[H['Ticker']]).toUpperCase(), sig: { ymd: ymd, stock: stock, need: need, stop: stop } });
  });
  if (!todo.length) { notify_(ui, 'Flip grading', 'Nothing waiting to be graded.'); return { graded: 0 }; }
  const tickers = todo.map(function (x) { return x.t; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
  const bars = flipFetchBars_(tickers, '3mo');
  const today = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
  let graded = 0;
  const hz = FLIP_CONFIG.horizonDays;
  todo.forEach(function (x) {
    const b = bars[x.t] ? flipBarsToObjects_(bars[x.t]) : null;
    if (!b) return;
    // a bar dated today may still be forming: only count completed days
    const done = b.filter(function (z) { return z.d < today; });
    const g = flipGradeOne_(done, x.sig, hz);
    if (!g) return;
    const r = data[x.i];
    r[H['Outcome']] = g.outcome; r[H['Days']] = g.days; r[H['MFE %']] = flipR1_(g.mfe); r[H['MAE %']] = flipR1_(g.mae); r[H['Graded']] = today; r[H['Note']] = g.note;
    graded++;
  });
  if (graded) sh.getRange(2, H['Outcome'] + 1, n, 6).setValues(data.map(function (r) {
    return [r[H['Outcome']], r[H['Days']], r[H['MFE %']], r[H['MAE %']], r[H['Graded']], r[H['Note']]];
  }));
  notify_(ui, 'Flip grading', 'Graded ' + graded + ' of ' + todo.length + ' waiting signal(s). The rest need more trading days.');
  return { graded: graded };
}


/* ============================================================================
 * STATS (FlipStats tab) — the honest scoreboard
 * ----------------------------------------------------------------------------
 * Realized trades come from Results (Strategy Quick / Flip, calls only). Open positions come from the Flip tab
 * (and Quick, if it has Ticker / Qty / P/L $ headers). "Win rate" is shown realized-only AND with open positions
 * marked to market, because a realized-only rate hides losers you are still holding.
 * ========================================================================== */

// "Sep 9" / Date / "2026-09-09" -> Date (year inferred: the latest date not in the future).
function flipParseTradeDate_(v, now) {
  if (flipIsDate_(v)) return v;
  const s = String(v == null ? '' : v).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return flipDate_(s.substring(0, 10));
  const m = s.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (!m) return null;
  const mon = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m[1].toLowerCase());
  if (mon < 0) return null;
  let y = m[3] ? parseInt(m[3], 10) : now.getFullYear();
  let d = new Date(y, mon, parseInt(m[2], 10), 12, 0, 0);
  if (!m[3] && d.getTime() > now.getTime() + 2 * 86400000) d = new Date(y - 1, mon, parseInt(m[2], 10), 12, 0, 0);
  return d;
}

// Pure. trades: [{t, profit, ret, days}] -> summary numbers.
function flipSummarize_(trades) {
  const n = trades.length;
  const wins = trades.filter(function (x) { return x.profit > 0; }), losses = trades.filter(function (x) { return x.profit <= 0; });
  const sum = function (a, f) { return a.reduce(function (s, x) { return s + f(x); }, 0); };
  const gross = sum(wins, function (x) { return x.profit; }), loss = -sum(losses, function (x) { return x.profit; });
  const rets = trades.filter(function (x) { return x.ret != null; });
  const avg = function (a) { return a.length ? sum(a, function (x) { return x.ret; }) / a.length : null; };
  const sortedWins = wins.map(function (x) { return x.profit; }).sort(function (a, b) { return b - a; });
  const buckets = [['same day', 0, 0], ['1 day', 1, 1], ['2-4 days', 2, 4], ['5+ days', 5, 999]].map(function (b) {
    const g = trades.filter(function (x) { return x.days != null && x.days >= b[1] && x.days <= b[2]; });
    return { label: b[0], n: g.length, avgRet: avg(g.filter(function (x) { return x.ret != null; })), net: sum(g, function (x) { return x.profit; }) };
  });
  return {
    n: n, wins: wins.length, losses: losses.length, winRate: n ? wins.length / n * 100 : null, total: sum(trades, function (x) { return x.profit; }),
    avgWinPct: avg(wins.filter(function (x) { return x.ret != null; })), avgLossPct: avg(losses.filter(function (x) { return x.ret != null; })),
    expectancyPct: avg(rets), profitFactor: loss > 0 ? gross / loss : null,
    top1Share: gross > 0 && sortedWins.length ? sortedWins[0] / gross * 100 : null,
    top3Share: gross > 0 ? sortedWins.slice(0, 3).reduce(function (s, v) { return s + v; }, 0) / gross * 100 : null,
    buckets: buckets
  };
}

function flipReadOpenBook_(sheetName, pnlColNo) {
  const out = [];
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sh || sh.getLastRow() < 2) return out;
    const hdr = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
    const col = function (n) { return hdr.indexOf(n); };
    const ct = col('Ticker'), cq = col('Qty'), cp = pnlColNo ? pnlColNo - 1 : col('P/L $'), cpp = col('P/L %'), ce = col('Entry'), cd = col('Days'), cth = col('Theme');
    if (ct < 0 || cq < 0 || cp < 0) return out;
    sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues().forEach(function (r) {
      const q = flipNum_(r[cq]), pl = flipMoney_(r[cp]);
      if (!(q > 0) || pl == null) return;
      const ent = ce >= 0 ? flipNum_(r[ce]) : null;
      out.push({ t: String(r[ct]).toUpperCase(), qty: q, pl: pl, plPct: cpp >= 0 ? flipNum_(r[cpp]) : null, cost: ent ? ent * 100 * q : null, days: cd >= 0 ? flipNum_(r[cd]) : null, theme: cth >= 0 ? r[cth] : flipThemeOf_(String(r[ct]).toUpperCase()), src: sheetName });
    });
  } catch (e) { /* missing columns: skipped */ }
  return out;
}

function flipBuildStats() {
  const ui = tryGetUi_();
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const now = new Date();
  const rs = ss.getSheetByName(FLIP_RESULTS_SHEET);
  const trades = [];
  if (rs && rs.getLastRow() >= 3) {
    rs.getRange(3, 1, rs.getLastRow() - 2, 10).getValues().forEach(function (r) {
      const strat = String(r[0] || ''), contract = String(r[2] || '').trim();
      if (!/quick|flip/i.test(strat) || !/C$/i.test(contract)) return;
      const profit = flipMoney_(r[8]);
      if (profit == null) return;
      let ret = flipMoney_(r[9]);
      const e = flipMoney_(r[4]), x = flipMoney_(r[6]);
      if (ret == null && e > 0 && x != null) ret = (x / e - 1) * 100;
      const d0 = flipParseTradeDate_(r[3], now), d1 = flipParseTradeDate_(r[5], now);
      trades.push({ t: String(r[1] || '').toUpperCase(), profit: profit, ret: ret, days: d0 && d1 ? flipTradingDays_(d0, d1) : null, strat: strat });
    });
  }
  const S = flipSummarize_(trades);
  const fsh = ss.getSheetByName(FLIP_SHEET_NAME);
  const pnlNo = fsh ? flipPnlCol_(flipHeaderMap_(fsh)) : 0;
  const open = flipReadOpenBook_(FLIP_SHEET_NAME, pnlNo).concat(flipReadOpenBook_(FLIP_QUICK_SHEET));
  const openPl = open.reduce(function (s, o) { return s + o.pl; }, 0);
  const openWin = open.filter(function (o) { return o.pl > 0; }).length;
  const f1 = function (v) { return v == null ? 'n/a' : (Math.round(v * 10) / 10) + '%'; };
  const usd = function (v) { return (v < 0 ? '-$' : '$') + Math.abs(Math.round(v)).toLocaleString('en-US'); };

  const rows = [];
  const sect = function (t) { rows.push([t, '', '', '', '']); };
  const line = function (a, b, c, d, e) { rows.push([a, b === undefined ? '' : b, c === undefined ? '' : c, d === undefined ? '' : d, e === undefined ? '' : e]); };
  rows.push(['FLIP STATS  (built ' + Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd HH:mm') + ' ET)', '', '', '', '']);
  sect('1. REALIZED (Results tab, Quick / Flip calls)');
  line('Closed trades', S.n); line('Wins / losses', S.wins + ' / ' + S.losses); line('Win rate (realized only)', f1(S.winRate));
  line('Net profit', usd(S.total)); line('Average % on a win', f1(S.avgWinPct)); line('Average % on a loss', f1(S.avgLossPct));
  line('Expectancy per trade (avg %)', f1(S.expectancyPct)); line('Profit factor (gross win / gross loss)', S.profitFactor == null ? 'n/a' : (Math.round(S.profitFactor * 100) / 100));
  line('Best winner as % of all winnings', f1(S.top1Share)); line('Best 3 winners as % of all winnings', f1(S.top3Share));
  sect('2. OPEN BOOK (what the win rate above leaves out)');
  line('Open positions', open.length); line('Open P/L', usd(openPl)); line('Open winners / losers', openWin + ' / ' + (open.length - openWin));
  const mtmN = S.n + open.length, mtmW = S.wins + openWin;
  line('Win rate, open positions marked to market', mtmN ? f1(mtmW / mtmN * 100) : 'n/a');
  line('Realized + open P/L', usd(S.total + openPl));
  const th = {};
  open.forEach(function (o) { th[o.theme || 'Other'] = th[o.theme || 'Other'] || { n: 0, pl: 0 }; th[o.theme || 'Other'].n++; th[o.theme || 'Other'].pl += o.pl; });
  Object.keys(th).sort(function (a, b) { return th[b].n - th[a].n; }).forEach(function (k) { line('  open in ' + k, th[k].n + ' position(s)', usd(th[k].pl)); });
  sect('3. HOLD TIME');
  line('Bucket', 'Trades', 'Avg %', 'Net $');
  S.buckets.forEach(function (b) { line('  ' + b.label, b.n, f1(b.avgRet), usd(b.net)); });
  sect('4. BY TICKER (realized)');
  line('Ticker', 'Trades', 'Net $');
  const bt = {};
  trades.forEach(function (x) { bt[x.t] = bt[x.t] || { n: 0, p: 0 }; bt[x.t].n++; bt[x.t].p += x.profit; });
  Object.keys(bt).sort(function (a, b) { return bt[b].p - bt[a].p; }).forEach(function (k) { line('  ' + k, bt[k].n, usd(bt[k].p)); });

  sect('5. SIGNAL CALIBRATION (FlipLog, graded on daily bars)');
  const lg = ss.getSheetByName(FLIP_LOG_SHEET);
  let gradedN = 0;
  if (lg && lg.getLastRow() >= 2) {
    const H = {}; FLIP_LOG_HEADERS.forEach(function (h, i) { H[h] = i; });
    const g = lg.getRange(2, 1, lg.getLastRow() - 1, FLIP_LOG_HEADERS.length).getValues().filter(function (r) { return r[H['Outcome']] !== ''; });
    gradedN = g.length;
    ['BUY', 'READY'].forEach(function (kind) {
      const k = g.filter(function (r) { return r[H['Signal']] === kind; });
      if (!k.length) return;
      const c = function (o) { return k.filter(function (r) { return r[H['Outcome']] === o; }).length; };
      const pred = k.reduce(function (s, r) { return s + (flipNum_(r[H['P Hit %']]) || 0); }, 0) / k.length;
      const mfe = k.reduce(function (s, r) { return s + (flipNum_(r[H['MFE %']]) || 0); }, 0) / k.length;
      const mae = k.reduce(function (s, r) { return s + (flipNum_(r[H['MAE %']]) || 0); }, 0) / k.length;
      line(kind + ' signals graded', k.length, 'TARGET ' + c('TARGET') + '  STOP ' + c('STOP') + '  TIME ' + c('TIME'));
      line('  target hit rate vs the sheet\'s P Hit % (random-walk prediction)', f1(c('TARGET') / k.length * 100), f1(pred));
      line('  average best / worst stock excursion', f1(mfe), f1(mae));
    });
  }
  if (!gradedN) line('No graded signals yet', 'Signals are graded after enough trading days (menu: Grade Past Signals).');
  line('Note', 'Hit rate above the predicted P Hit % over many signals (30+) is the evidence the entry trigger adds something. Near or below it means the trigger is not beating a random walk.');

  const sh = flipEnsureSheet_(FLIP_STATS_SHEET, ['Flip stats']);
  sh.clear();
  sh.getRange(1, 1, rows.length, 5).setValues(rows);
  sh.setColumnWidth(1, 430); sh.setColumnWidth(2, 140); sh.setColumnWidth(3, 190); sh.setColumnWidth(4, 110); sh.setColumnWidth(5, 80);
  sh.getRange(1, 1).setFontWeight('bold').setFontSize(13);
  rows.forEach(function (r, i) { if (/^\d\. /.test(r[0])) sh.getRange(i + 1, 1, 1, 5).setBackground('#d9ead3').setFontWeight('bold'); });
  notify_(ui, 'Flip stats', 'Wrote ' + FLIP_STATS_SHEET + '. Realized win rate ' + f1(S.winRate) + ', with open positions marked to market ' + (mtmN ? f1(mtmW / mtmN * 100) : 'n/a') + '. Realized + open P/L ' + usd(S.total + openPl) + '.');
  return { realized: S, open: open.length };
}


/* ============================================================================
 * DEBUG — one ticker, full decision trail
 * ========================================================================== */

function debugFlipOneTicker() {
  const ui = tryGetUi_();
  if (!ui) return;
  const r = ui.prompt('Flip debug', 'Ticker (e.g. APP):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = r.getResponseText().trim().toUpperCase();
  if (!t) return;
  const now = new Date(), sess = marketSessionAt_(now), todayYmd = flipTodayYmd_(now);
  const cache = flipCacheLoad_(), pending = {};
  const ctx = { cache: cache, pending: pending, now: now, token: getTastyTradeAccessToken_(), chains: {}, finnhubKey: getFinnhubApiKey_() };
  const raw = flipGetBars_([t, 'SPY'], ctx, '6mo', 'FB');
  const barsOf = function (k) { const o = flipBarsToObjects_(raw[k]); return o.length && o[o.length - 1].d === todayYmd ? o.slice(0, -1) : o; };
  const b = barsOf(t);
  const feat = {}, prevClose = {};
  feat[t] = flipFeatures_(b, barsOf('SPY')); prevClose[t] = b.length ? b[b.length - 1].c : null;
  const daily = flipGetDaily_([t], ctx);
  const ivMap = sess.open ? fetchIntradayMap_([t, 'SPY']) : {};
  const spy = ivMap['SPY'] || null;
  const env = { now: now, sess: sess, closeMin: US_MARKET_EARLY_CLOSES[todayYmd] ? 210 : 390, S: FLIP_SIGNAL,
    spyHead: !!(spy && spy.vwapPct != null && spy.aroonUp != null && spy.aroonDown != null && spy.vwapPct < 0 && spy.aroonDown > spy.aroonUp),
    feat: feat, prevClose: prevClose, daily: daily, ivFresh: {}, picks: {}, quotes: {}, ctx: ctx, full: true, open: [], todayYmd: todayYmd };
  env.ivFresh[t] = flipFreshIv_(ivMap[t], env);
  const f = feat[t];
  if (f) env.picks[t] = flipPickContract_(t, env.ivFresh[t] && env.ivFresh[t].lastPrice > 0 ? env.ivFresh[t].lastPrice : f.price, f.sigmaDay, ctx);
  if (env.picks[t] && env.picks[t].ok && env.picks[t].c.symbol) env.quotes = fetchOptionQuotesMap_([env.picks[t].c.symbol]);
  const res = flipProcessCandidate_({ ticker: t, held: false }, env);
  flipCacheFlush_(pending);
  const lines = ['Market open: ' + sess.open + ' | SPY headwind: ' + env.spyHead + ' | intraday: ' + (env.ivFresh[t] ? 'fresh' : 'none/stale'),
    'Pick: ' + (env.picks[t] ? (env.picks[t].ok ? 'ok' + (env.picks[t].stale ? ' (stale)' : '') : env.picks[t].why) : 'none'), '---'];
  Object.keys(res).filter(function (k) { return k.charAt(0) !== '_'; }).forEach(function (k) {
    const v = res[k];
    lines.push(k + ': ' + (flipIsDate_(v) ? Utilities.formatDate(v, 'America/New_York', 'yyyy-MM-dd') : v));
  });
  ui.alert('Flip debug: ' + t, lines.join('\n').substring(0, 5000), ui.ButtonSet.OK);
}