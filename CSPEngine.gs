/* ============================================================================
 * CSPEngine.gs — cash-secured puts on quality, moat companies ("CSP" tab)
 * ----------------------------------------------------------------------------
 * PURPOSE
 *   For each ticker you list in the CSP tab (and mark Moat = Y), propose ONE
 *   cash-secured put: expiry (~35 DTE, before earnings), strike (~0.22 delta,
 *   never above your Max Buy Price), the credit, cash required, break-even,
 *   and the exit prices. Rows are sorted: take-profit / review signals on
 *   positions you already hold first, then SELL, then WAIT, then SKIP.
 *
 * STRATEGY RULES (defaults in CSP_CONFIG below — edit there)
 *   - Profit target is a % of the CREDIT, not of the cash: 25% quick take,
 *     50% standard take. (A put can never earn more than its credit, which
 *     is ~1-3% of the strike, so "10% of cash" is not reachable.)
 *   - Time-stop at 21 DTE: close or roll instead of riding gamma to expiry.
 *   - Never sells through earnings: the expiry must fall before the next
 *     earnings date, else the row says WAIT and tells you when to retry.
 *   - Assignment is acceptable only at or below Max Buy; the script never
 *     proposes a strike above it.
 *   - Budget guards: total CSP cash and per-name cash.
 *
 * RESEARCH PROMOTION: "Promote Research Picks" scores a curated quality universe
 *   (CSP_STOCK_UNIVERSE + CSP_ETF_UNIVERSE) on a moat PROXY (returns on equity,
 *   margins, free cash flow, leverage), a 5-year record (CAGR, worst drawdown,
 *   history), size and trend, then adds the best names to this tab
 *   (Source = Research) and retires Research-added names that stay out of the
 *   list. Your own rows, rows with an open put and colored ticker cells are
 *   never touched. Moat cannot be measured directly; this is a proxy.
 *
 * TELEGRAM ALERTS: SELL (new proposal), TAKE PROFIT / TIME-STOP / REVIEW / ROLL
 *   (positions you hold). Uses the same Telegram setup as Quick (menu: Phone
 *   Alerts), one batched message per run, deduped in CSP_ALERT_STATE.
 *
 * SCHEDULE: menu "Start CSP Schedule" runs an hourly check during US market
 *   hours: open puts every tick, full re-scan every 3 hours. Research promotion
 *   runs once a day BEFORE the open (06:00-09:45 ET), away from Quick/Leap.
 *
 * SEPARATE FROM QUICK/LEAP: own universe, own promotion, own cache sheet
 *   (CSPCache), own trigger. Nothing here is wired into ResearchEngine.gs or
 *   DailyPipeline.gs. No cash cap: Cash Req is informational.
 *
 * SETUP (once): run  setupCsp  from the Apps Script editor. It creates the
 * CSP tab (seeded with a starter list), and installs an on-open trigger that
 * adds a "💵 CSP" menu — no edit to Momentum.gs needed.
 *
 * RE-USES (from the other script files): getTastyTradeAccessToken_,
 * fetchTastyOptionChainNested_, fetchTastyMarketDataBatch_,
 * fetchTastyEquityQuote_, fetchTastyMarketMetrics_, fetchTastyTradeQuote_,
 * fetchYahooQuote_, fetchYahooExpirationDatesForScanner_,
 * getNormalizedPutChainForExpiry_, impliedVolatilityBisection_,
 * fetchYahooDailyBarsForRange_, getSlowCached_ (own cache sheet "CSPCache", so
 * Quick/Leap runs never read CSP data),
 * fetchFinnhubNextEarnings_, fetchYahooNextEarnings_, buildOccSymbol_.
 *
 * Apps Script only — no Cloud Function redeploy.
 * Shares ONE thing with Quick/Leap: Yahoo/Tasty rate limits (calls are paced).
 * ========================================================================== */

const CSP_SHEET_NAME = 'CSP';
// CSP keeps ITS OWN cache sheet. The shared DataCache is read in full by every Quick/Leap run, so adding a few hundred CSP
// entries there would make those runs slower. Same row format and same getSlowCached_ logic, just a different sheet.
const CSP_CACHE_SHEET_NAME = 'CSPCache';

function cspLoadCache_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CSP_CACHE_SHEET_NAME);
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

function cspFlushCache_(pending) {
  const keys = Object.keys(pending);
  if (!keys.length) return 0;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CSP_CACHE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CSP_CACHE_SHEET_NAME);
    try { sheet.hideSheet(); } catch (e) { /* ignore */ }
  }
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow >= 1) sheet.getRange(1, 1, lastRow, 2).getValues().forEach(function (row) { if (row[0]) existing[row[0]] = row[1]; });
  keys.forEach(function (k) { existing[k] = pending[k]; });
  const rows = Object.keys(existing).map(function (k) { return [k, existing[k]]; });
  sheet.clearContents();
  if (rows.length) sheet.getRange(1, 1, rows.length, 2).setValues(rows);
  return keys.length;
}

const CSP_CONFIG = {
  // --- money: NO cash cap. Cash Req is shown per contract; you decide what to trade. -------------
  // --- contract choice -------------------------------------------------------
  targetDte: 35,             // closest expiry to this, inside [minDte, maxDte]
  minDte: 21,
  maxDte: 50,
  targetDelta: 0.22,         // |delta| aimed for
  highVixDelta: 0.18,        // used instead when VIX >= vixHigh
  vixHigh: 25,
  minDelta: 0.12,            // acceptable band around the target
  maxDelta: 0.32,
  // --- gates -----------------------------------------------------------------
  requireMoat: true,         // only rows with Moat = Y are processed
  minIvRank: 25,             // below this -> WAIT (premium thin)
  minAnnualizedPct: 8,       // below this -> WAIT
  maxSpreadPct: 8,           // bid-ask spread as % of mid (a $0.05 gap on a $1.25 put is 4%)
  minOi: 250,                // open interest at the strike (null OI is allowed, with a note)
  maxBelow200Pct: 5,         // price more than this % under the 200-day -> SKIP (falling knife)
  maxDrawdownPct: 30,        // more than this % under the 52-week high (closing basis) -> SKIP
  // --- exits -----------------------------------------------------------------
  tp1Pct: 25,                // quick take: buy back when 25% of credit is captured
  tp2Pct: 50,                // standard take
  reviewMultiple: 3,         // review when the put's mark reaches this multiple of credit
  timeStopDte: 21,
  // --- scoring ---------------------------------------------------------------
  scoreSell: 55,             // Score needed for SELL (a typical decent setup scores 55-65)
  // --- runtime ---------------------------------------------------------------
  timeBudgetMs: 4.5 * 60 * 1000,   // Apps Script hard limit is 6 min; leave room for sorting/formatting
  sleepMs: 120,
  // --- research promotion ----------------------------------------------------
  promote: {
    maxStocks: 25,           // best N stocks kept on the tab by quality score
    maxEtfs: 8,              // best N ETFs
    minStockScore: 65,       // moat-proxy + track-record score (0-100) needed
    minEtfScore: 60,
    minCapB: 50,             // $50B market cap floor for stocks
    minHistoryYears: 4.7,    // a "track record" needs about 5 years of trading history
    removeAfterMisses: 5,    // retire a Research-added row after this many promote runs outside the list
    timeBudgetMs: 4 * 60 * 1000
  },
  // --- alerts ----------------------------------------------------------------
  alerts: { sellRepeatHours: 24, takeProfitRepeatHours: 3, reviewRepeatHours: 12 },
  // --- schedule (US/Eastern) -------------------------------------------------
  schedule: { fullScanEveryHours: 3, startHHmm: '09:45', endHHmm: '15:55' }
};

// Starter list for a brand-new tab. A STARTING POINT from general knowledge of
// large, long-record, wide-moat businesses — not a rating, and prices/ratings
// were not verified. Delete or add rows freely. Names priced above the
// per-name cash cap are marked SKIP automatically.
const CSP_STARTER_TICKERS = [
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'V', 'MA', 'COST', 'WMT', 'JPM', 'KO', 'PEP', 'PG',
  'JNJ', 'HD', 'MCD', 'CSCO', 'TXN', 'LIN', 'UNP', 'DHR', 'ISRG', 'SPGI', 'ABT', 'AVGO'
];

// Research universe for CSP promotion — quality large caps with long records and
// liquid options. From general knowledge, NOT a rating: the numeric screen decides
// who qualifies, this list only decides who gets looked at. Add or remove freely.
const CSP_STOCK_UNIVERSE = [
  // Technology
  'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'META', 'NVDA', 'AVGO', 'ORCL', 'ADBE', 'CRM', 'CSCO', 'TXN', 'QCOM', 'INTU', 'NOW',
  'ACN', 'IBM', 'AMAT', 'LRCX', 'KLAC', 'SNPS', 'CDNS', 'ADI', 'TSM', 'ASML',
  // Financials
  'JPM', 'V', 'MA', 'AXP', 'BLK', 'SPGI', 'MCO', 'ICE', 'CME', 'MS', 'GS', 'SCHW', 'CB', 'MMC', 'AON', 'PGR', 'TRV',
  // Healthcare
  'JNJ', 'UNH', 'LLY', 'ABBV', 'MRK', 'TMO', 'DHR', 'ABT', 'ISRG', 'SYK', 'BSX', 'MDT', 'ZTS', 'VRTX', 'REGN', 'AMGN',
  // Consumer
  'WMT', 'COST', 'PG', 'KO', 'PEP', 'MDLZ', 'CL', 'PM', 'HSY', 'HD', 'LOW', 'MCD', 'NKE', 'SBUX', 'TJX', 'BKNG', 'CMG', 'ORLY', 'AZO',
  // Industrials / Materials / Energy / Utilities / Comm
  'UNP', 'CAT', 'DE', 'HON', 'GE', 'RTX', 'LMT', 'ETN', 'ITW', 'WM', 'RSG', 'ADP', 'LIN', 'SHW', 'APD', 'ECL',
  'XOM', 'CVX', 'NEE', 'DUK', 'SO', 'DIS', 'TMUS', 'NFLX', 'PLD', 'AMT', 'EQIX'
];

// Broad US-market and large-sector ETFs with deep option markets. Scored on 5-year record, drawdown and trend (no
// fundamentals). Options liquidity is then checked per contract by the scan (open interest, spread).
const CSP_ETF_UNIVERSE = [
  'SPY', 'VOO', 'IVV', 'QQQ', 'DIA', 'IWM', 'VTI', 'RSP', 'MDY', 'IJH',
  'XLK', 'XLV', 'XLF', 'XLI', 'XLY', 'XLP', 'XLU', 'SMH', 'VGT', 'SCHD', 'VUG', 'VIG'
];
const CSP_ETF_SET = (function () { const o = {}; CSP_ETF_UNIVERSE.forEach(function (t) { o[t] = true; }); return o; })();

// Input columns (yours) first, then everything the script writes.
// Columns you SEE (in this order). Everything else stays on the sheet, hidden, and is still computed.
const CSP_VISIBLE_HEADERS = ['Ticker', 'Price', 'Change', 'Open Date', 'Entry', 'Open Qty', 'Quality', 'Score', 'Action', 'Earn Days', 'IV Rank',
  'Expiry', 'DTE', 'Strike', 'Delta', 'Mid', 'Annualized %', 'Cushion EM', 'P25 in 10d %', 'OI', 'Volume', 'Spread %', 'Why', 'LastRun'];
// Typed by you. Moat blank = Y (only an explicit N excludes a ticker). Max Buy is optional.
// When Open Qty is filled, Strike / Expiry become YOURS (the put you sold) and runs never overwrite them; Entry = the premium you received
// (per share, e.g. 1.25). Mid is always the live mid of the contract, never typed. PNL = Entry - Mid (positive = the put has lost value = you are ahead).
const CSP_INPUT_HEADERS = ['Ticker', 'Open Qty', 'Open Date', 'Entry', 'Moat', 'Max Buy'];
// Horizon (calendar days) of the take-profit probability columns. The header text says 10d: change both together.
const CSP_PROB_DAYS = 10;
const CSP_HELD_WHEN_OPEN = ['Strike', 'Expiry'];
// PNL (Entry - Mid, per share) is written into this fixed COLUMN NUMBER (23 = W), not found by header, because its header cell holds
// your own SUM formula. The script never touches row 1 of this column. Change the number if you move the column, or name the
// header exactly PNL and the script will follow it instead.
const CSP_PNL_COLUMN = 25;
// Entry sits in this fixed COLUMN NUMBER (5 = E) when its header cell holds your own formula (any header text that is not a script header).
// Nothing is added for it and row 1 is never written. If the header says exactly Entry, the name is used instead.
const CSP_FIXED_COLUMNS = { 'Entry': 5 };
// Change = Price now minus Price at the previous fetch (green up, red down); previous prices live in a script property.
const CSP_CHANGE_FORMAT = '[Green]$#,##0.00;[Red]-$#,##0.00;$0.00';
// PNL follows the formula column sitting right before Why (so deleting/moving columns does not break it); CSP_PNL_COLUMN is the fallback.
function cspPnlCol_(map) {
  if (!map) return CSP_PNL_COLUMN;
  if (map['PNL']) return map['PNL'];
  if (map['Why'] > 1) {
    const c = map['Why'] - 1;
    const used = Object.keys(map).some(function (h) { return map[h] === c && CSP_HEADERS.indexOf(h) !== -1; });
    if (!used) return c;
  }
  return CSP_PNL_COLUMN;
}
// Old input columns, folded into Strike / Expiry / Mid by the one-time layout migration in setupCsp.
const CSP_LEGACY_INPUTS = ['Open Strike', 'Open Expiry', 'Open Credit'];
const CSP_OUTPUT_HEADERS = [
  'Action', 'Score', 'Why',
  'Price', 'Change', 'Off 52w High %', 'vs 200d %', 'vs 50d %', 'RSI', 'Next Earnings', 'Earn Days', 'IV Rank', 'IV', 'HV20', 'IV/HV',
  'Expiry', 'DTE', 'Strike', 'Delta', 'Bid', 'Ask', 'Mid', 'Spread %', 'OI', 'Volume',
  'Credit $', 'Cash Req', 'Yield %', 'Annualized %', 'Breakeven', 'Cushion %', 'Cushion EM', 'Prob ITM %', 'P25 in 10d %', 'P50 in 10d %', 'Basis vs Max Buy %',
  'TP25 Buyback', 'TP50 Buyback', 'Time-Stop Date', 'Review Level',
  'Open Mark', 'Open P/L %', 'Open DTE', 'Open Held', 'Open Action',
  'LastRun', 'SortKey'
];
// Written by the research promotion (kept after the outputs so the output block stays contiguous).
const CSP_EXTRA_HEADERS = ['Source', 'Type', 'Quality'];
// Columns written by an earlier version: still blanked on every run so old values do not linger (safe to delete the column).
const CSP_LEGACY_OUTPUTS = ['Max Qty'];
// Physical column order: the visible block first (your order), then the hidden detail columns.
const CSP_HEADERS = (function () {
  const all = CSP_INPUT_HEADERS.concat(CSP_OUTPUT_HEADERS).concat(CSP_EXTRA_HEADERS);
  return CSP_VISIBLE_HEADERS.concat(all.filter(function (h) { return CSP_VISIBLE_HEADERS.indexOf(h) === -1; }));
})();


/* ============================================================================
 * SETUP + MENU
 * ========================================================================== */

// Run ONCE from the Apps Script editor.
function setupCsp() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CSP_SHEET_NAME);
  const isNew = !sheet;
  if (isNew) sheet = ss.insertSheet(CSP_SHEET_NAME);
  let map0 = cspEnsureHeaders_(sheet);
  let migrated = false;
  if (isNew) {
    const rows = CSP_STARTER_TICKERS.map(function (t) {
      const row = new Array(CSP_HEADERS.length).fill('');
      row[map0['Ticker'] - 1] = t; row[map0['Moat'] - 1] = 'Y';
      return row;
    });
    sheet.getRange(2, 1, rows.length, CSP_HEADERS.length).setValues(rows);
  } else {
    migrated = cspMigrateLayout_(sheet);
  }
  cspFormatSheet_(sheet);
  cspApplyVisibility_(sheet, false);

  // Installable on-open trigger -> adds the menu without touching Momentum.gs's onOpen().
  const triggers = ScriptApp.getProjectTriggers();
  const has = triggers.some(function (t) { return t.getHandlerFunction() === 'cspAddMenu_'; });
  if (!has) ScriptApp.newTrigger('cspAddMenu_').forSpreadsheet(ss).onOpen().create();
  try { cspAddMenu_(); } catch (e) { /* no UI when run from some contexts; menu appears on next open */ }

  const ui = tryGetUi_();
  notify_(ui, 'CSP set up',
    (isNew ? 'Created the CSP tab with ' + CSP_STARTER_TICKERS.length + ' starter tickers.\n' : (migrated ? 'CSP tab re-laid out (old layout saved as a CSP_backup_ tab). Open puts carried into Strike / Expiry / Mid.\n' : 'CSP tab already existed: headers checked, your data untouched.\n')) +
    'Menu "💵 CSP" appears after you reload the sheet.\n\n' +
    'Detail columns are hidden (menu: CSP > Show / Hide Detail Columns).\n\nNext:\n' +
    '  1. 💵 CSP > Promote Research Picks to CSP (adds quality names and ETFs)\n' +
    '  2. 💵 CSP > Run CSP Scan\n' +
    '  3. 💵 CSP > CSP Alerts & Schedule > Start CSP Schedule (hourly checks + Telegram alerts)');
}

function cspAddMenu_() {
  SpreadsheetApp.getUi()
    .createMenu('💵 CSP')
    .addItem('Run CSP Scan', 'runCspScan')
    .addItem('Promote Research Picks to CSP', 'runCspPromote')
    .addItem('Show / Hide Detail Columns', 'cspToggleDetailColumns_')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('📱 CSP Alerts & Schedule')
      .addItem('Send Test CSP Alert', 'sendTestCspAlert_')
      .addItem('Turn CSP Alerts On / Off', 'toggleCspAlerts_')
      .addSeparator()
      .addItem('▶ Start CSP Schedule (hourly, market hours)', 'startCspSchedule_')
      .addItem('■ Stop CSP Schedule', 'stopCspSchedule_')
      .addItem('Schedule Status', 'cspScheduleStatus_'))
    .addSubMenu(SpreadsheetApp.getUi().createMenu('🔍 CSP Debug')
      .addItem('One Ticker (full decision trail)', 'debugCspOneTicker')
      .addItem('Quality Score (one ticker)', 'debugCspQuality')
      .addItem('Scan Dry Run (no writes)', 'runCspScanDryRun')
      .addItem('Promote Dry Run (no writes)', 'runCspPromoteDryRun'))
    .addToUi();
}

function runCspScanDryRun() { return runCspScan(null, true); }


/* ============================================================================
 * SHEET HELPERS
 * ========================================================================== */

// Adds any missing header at the end. Existing columns, order and data stay.
function cspEnsureHeaders_(sheet) {
  const lastCol = Math.max(sheet.getLastColumn(), 1);
  const existing = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h || '').trim(); });
  const hasAny = existing.some(function (h) { return h !== ''; });
  if (!hasAny) {
    sheet.getRange(1, 1, 1, CSP_HEADERS.length).setValues([CSP_HEADERS]);
  } else {
    let next = existing.length;
    while (next > 0 && existing[next - 1] === '') next--;   // first empty column after the last header
    CSP_HEADERS.forEach(function (h) {
      const fc = (h === 'Entry' && entryFormulaCol_(sheet, existing.length)) || CSP_FIXED_COLUMNS[h];
      if (fc && existing[fc - 1] && existing[fc - 1] !== '' && CSP_HEADERS.indexOf(existing[fc - 1]) === -1) return;   // your formula header holds this column
      if (existing.indexOf(h) === -1) {
        next++;
        sheet.getRange(1, next).setValue(h);
        existing[next - 1] = h;
      }
    });
  }
  sheet.setFrozenRows(1);
  sheet.setFrozenColumns(1);
  return cspHeaderMap_(sheet);
}

function entryFormulaCol_(sheet, lastCol) {
  try {
    const f = sheet.getRange(1, 1, 1, Math.max(lastCol, 1)).getFormulas()[0];
    for (let i = 0; i < f.length; i++) if (/^=\s*sumproduct\s*\(/i.test(f[i])) return i + 1;
  } catch (e) { /* none */ }
  return 0;
}

function logCspFixedOnce_(name, c, t) {
  try {
    const p = PropertiesService.getScriptProperties(), k = 'CSP_FIXED_WARN_' + name;
    if (p.getProperty(k)) return;
    p.setProperty(k, '1');
    logToSheet_('CSP: column ' + c + ' should hold "' + name + '" (CSP_FIXED_COLUMNS) but its header is ' + (t === '' ? 'empty' : '"' + t + '"') + '. Fix the number in CSP_FIXED_COLUMNS.');
  } catch (e) { /* warning only */ }
}

function cspHeaderMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const row = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const map = {};
  row.forEach(function (h, i) { const k = String(h || '').trim(); if (k && map[k] == null) map[k] = i + 1; });
  // Your formula headers are found by what they contain, so moving columns never matters: a header formula starting with SUMPRODUCT is
  // Entry, one starting with SUM( is PNL (Sheets rewrites the cell references itself when you move a column).
  let entryF = 0, sumF = 0;
  try {
    sheet.getRange(1, 1, 1, lastCol).getFormulas()[0].forEach(function (f, i) {
      if (!entryF && /^=\s*sumproduct\s*\(/i.test(f)) entryF = i + 1;
      else if (!sumF && /^=\s*sum\s*\(/i.test(f)) sumF = i + 1;
    });
  } catch (e) { /* fall back to the positions below */ }
  if (!map['PNL'] && sumF) map['PNL'] = sumF;
  Object.keys(CSP_FIXED_COLUMNS).forEach(function (name) {
    if (map[name]) return;
    const c = (name === 'Entry' && entryF) ? entryF : CSP_FIXED_COLUMNS[name];
    const t = String(row[c - 1] == null ? '' : row[c - 1]).trim();
    if (t !== '' && CSP_HEADERS.indexOf(t) === -1) map[name] = c;
    else logCspFixedOnce_(name, c, t);
  });
  return map;
}

// One-time (setupCsp): moves columns into CSP_HEADERS order and folds the old Open Strike / Open Expiry /
// Open Credit inputs into Strike / Expiry / Mid with Open Qty set. A backup tab is made first.
function cspMigrateLayout_(sheet) {
  const lastCol = sheet.getLastColumn(), lastRow = sheet.getLastRow();
  if (lastCol < 1 || lastRow < 1) return false;
  const all = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  const hdr = all[0].map(function (h) { return String(h || '').trim(); });
  const idx = {};
  hdr.forEach(function (h, i) { if (h && idx[h] == null) idx[h] = i; });
  // Only the old Open Strike / Open Expiry / Open Credit layout needs the one-time re-layout. A sheet you have arranged yourself is left alone.
  if (!CSP_LEGACY_INPUTS.some(function (h) { return idx[h] != null; })) return false;
  const dropped = CSP_LEGACY_INPUTS.concat(CSP_LEGACY_OUTPUTS);
  const extras = hdr.filter(function (h, i) { return h && CSP_HEADERS.indexOf(h) === -1 && dropped.indexOf(h) === -1 && idx[h] === i; });
  const desired = CSP_HEADERS.concat(extras);
  const same = desired.length === hdr.length && desired.every(function (h, i) { return hdr[i] === h; });
  if (same) return false;

  try {
    const ss = sheet.getParent();
    const tz = Session.getScriptTimeZone();
    sheet.copyTo(ss).setName('CSP_backup_' + Utilities.formatDate(new Date(), tz, 'MMdd_HHmm'));
  } catch (e) { /* backup is best-effort */ }

  const body = all.slice(1);
  const blank = function (v) { return v === '' || v == null; };
  if (idx['Open Strike'] != null && idx['Open Qty'] != null) {
    body.forEach(function (r) {
      if (blank(r[idx['Open Strike']])) return;
      if (blank(r[idx['Open Qty']])) r[idx['Open Qty']] = 1;
      r[idx['Strike']] = r[idx['Open Strike']];
      if (idx['Open Expiry'] != null && !blank(r[idx['Open Expiry']])) r[idx['Expiry']] = r[idx['Open Expiry']];
      if (idx['Open Credit'] != null && !blank(r[idx['Open Credit']])) r[idx['Mid']] = r[idx['Open Credit']];
    });
  }
  const matrix = [desired].concat(body.map(function (r) {
    return desired.map(function (h) { return idx[h] != null ? r[idx[h]] : ''; });
  }));
  sheet.getRange(1, 1, matrix.length, desired.length).setValues(matrix);
  if (desired.length < lastCol) sheet.getRange(1, desired.length + 1, lastRow, lastCol - desired.length).clearContent();
  // colours/format of moved columns are stale: reset everything except the Ticker column (research promotion reads its colour)
  if (lastCol > 1) sheet.getRange(1, 2, Math.max(sheet.getMaxRows(), 1), lastCol - 1).setBackground(null);
  return true;
}

// Hides every column that is not in CSP_VISIBLE_HEADERS (showAll = true unhides all).
function cspApplyVisibility_(sheet, showAll) {
  const map = cspHeaderMap_(sheet);
  const last = sheet.getLastColumn();
  if (last < 1) return;
  sheet.showColumns(1, last);
  if (showAll) return;
  const vis = {};
  CSP_VISIBLE_HEADERS.forEach(function (h) { vis[h] = true; });
  const hide = [];
  for (let c = 1; c <= last; c++) hide.push(false);
  Object.keys(map).forEach(function (h) { if (!vis[h]) hide[map[h] - 1] = true; });
  if (cspPnlCol_(map) <= last) hide[cspPnlCol_(map) - 1] = false;   // the PNL column stays visible
  Object.keys(CSP_FIXED_COLUMNS).forEach(function (h) { if (map[h] && map[h] <= last) hide[map[h] - 1] = false; });
  for (let c = 0; c < last; c++) {
    if (!hide[c]) continue;
    let e = c;
    while (e + 1 < last && hide[e + 1]) e++;
    sheet.hideColumns(c + 1, e - c + 1);
    c = e;
  }
}

function cspToggleDetailColumns_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(CSP_SHEET_NAME);
  if (!sheet) return;
  const map = cspHeaderMap_(sheet);
  const hidden = map['Moat'] ? sheet.isColumnHiddenByUser(map['Moat']) : false;
  cspApplyVisibility_(sheet, hidden);   // detail hidden -> show all; shown -> hide detail
}

// Earn Days warning colours (conditional formatting, so they stay right as days tick down): red 0-7, orange 8-21.
// 21 = the minimum DTE, so inside 21 days no expiry can finish before earnings and the row is an unscored WAIT.
// onlyIfMissing = true is the cheap self-heal check used by every scan. Errors go to ScriptLog (not swallowed).
function cspApplyEarnRules_(sheet, map, onlyIfMissing) {
  try {
    const col = map['Earn Days'];
    if (!col) return;
    const rules = sheet.getConditionalFormatRules();
    const mine = function (r) { return r.getRanges().some(function (x) { return x.getColumn() <= col && x.getLastColumn() >= col; }); };
    if (onlyIfMissing && rules.some(mine)) return;
    const rng = sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1);
    const red = SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(0, 7)
      .setBackground('#f4cccc').setFontColor('#990000').setBold(true).setRanges([rng]).build();
    const org = SpreadsheetApp.newConditionalFormatRule().whenNumberBetween(8, 21)
      .setBackground('#fce5cd').setRanges([rng]).build();
    sheet.setConditionalFormatRules(rules.filter(function (r) { return !mine(r); }).concat([red, org]));
  } catch (e) { logToSheet_('CSP: could not apply Earn Days colours: ' + (e && e.message ? e.message : e)); }
}

function cspFormatSheet_(sheet) {
  const map = cspHeaderMap_(sheet);
  const maxRows = Math.max(sheet.getMaxRows() - 1, 1);
  function fmt(h, f) { if (map[h]) sheet.getRange(2, map[h], maxRows, 1).setNumberFormat(f); }
  fmt('Max Buy', '$#,##0.00'); fmt('Entry', '$#,##0.00'); fmt('Change', CSP_CHANGE_FORMAT);
  sheet.getRange(2, cspPnlCol_(map), maxRows, 1).setNumberFormat('[Green]$#,##0.00;[Red]-$#,##0.00;$0.00'); fmt('Open Strike', '$#,##0.00'); fmt('Open Credit', '$#,##0.00');
  fmt('Open Expiry', 'yyyy-mm-dd'); fmt('Open Date', 'yyyy-mm-dd');
  fmt('Price', '$#,##0.00'); fmt('Strike', '$#,##0.00'); fmt('Bid', '$#,##0.00'); fmt('Ask', '$#,##0.00'); fmt('Mid', '$#,##0.00');
  fmt('Credit $', '$#,##0'); fmt('Cash Req', '$#,##0'); fmt('Breakeven', '$#,##0.00');
  fmt('TP25 Buyback', '$#,##0.00'); fmt('TP50 Buyback', '$#,##0.00'); fmt('Review Level', '$#,##0.00'); fmt('Open Mark', '$#,##0.00');
  fmt('Expiry', 'yyyy-mm-dd'); fmt('Next Earnings', 'yyyy-mm-dd'); fmt('Time-Stop Date', 'yyyy-mm-dd');
  fmt('LastRun', 'yyyy-mm-dd hh:mm');
  ['Off 52w High %', 'vs 200d %', 'vs 50d %', 'Spread %', 'Yield %', 'Annualized %', 'Cushion %', 'Prob ITM %', 'P25 in 10d %', 'P50 in 10d %', 'Basis vs Max Buy %', 'Open P/L %', 'IV Rank', 'IV', 'HV20']
    .forEach(function (h) { fmt(h, '0.0'); });
  ['RSI', 'Score', 'IV/HV', 'Cushion EM', 'Delta'].forEach(function (h) { fmt(h, '0.00'); });
  // Input columns: light yellow so it is obvious where you type.
  CSP_INPUT_HEADERS.forEach(function (h) {
    if (map[h]) sheet.getRange(1, map[h]).setBackground('#fff2cc');
  });
  CSP_OUTPUT_HEADERS.forEach(function (h) {
    if (map[h]) sheet.getRange(1, map[h]).setBackground('#d9ead3');
  });
  CSP_EXTRA_HEADERS.forEach(function (h) {
    if (map[h]) sheet.getRange(1, map[h]).setBackground('#cfe2f3');
  });
  fmt('Quality', '0.0');
  cspApplyEarnRules_(sheet, map, false);
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).setFontWeight('bold');
}


/* ============================================================================
 * PURE FUNCTIONS (no Apps Script services — unit-testable)
 * ========================================================================== */

function cspClamp01_(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

function cspSma_(arr, n) {
  if (!arr || arr.length < n) return null;
  let s = 0;
  for (let i = arr.length - n; i < arr.length; i++) s += arr[i];
  return s / n;
}

// Wilder RSI over daily closes.
function cspRsi_(closes, period) {
  period = period || 14;
  if (!closes || closes.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let avgG = gain / period, avgL = loss / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgG = (avgG * (period - 1) + (d > 0 ? d : 0)) / period;
    avgL = (avgL * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgL === 0) return 100;
  return 100 - 100 / (1 + avgG / avgL);
}

// Annualized close-to-close historical volatility (%), last n returns.
function cspHv_(closes, n) {
  n = n || 20;
  if (!closes || closes.length < n + 1) return null;
  const rets = [];
  for (let i = closes.length - n; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  const mean = rets.reduce(function (a, b) { return a + b; }, 0) / rets.length;
  const v = rets.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / (rets.length - 1);
  return Math.sqrt(v) * Math.sqrt(252) * 100;
}

// Daily-bar technicals from ~1y of closes. Stored in the slow cache (small).
function cspComputeTech_(closes) {
  if (!closes || closes.length < 30) return null;
  const last = closes[closes.length - 1];
  const yr = closes.slice(-252);
  return {
    price: last,
    ma50: cspSma_(closes, 50),
    ma200: cspSma_(closes, 200),
    hi52: Math.max.apply(null, yr),
    rsi: cspRsi_(closes, 14),
    hv20: cspHv_(closes, 20),
    n: closes.length
  };
}

// Strike whose put delta is about -targetDelta, from a flat vol guess (BS inverse).
function cspStrikeForDelta_(spot, dte, sigmaPct, targetDelta, r) {
  r = r == null ? 0.045 : r;
  const T = dte / 365, s = sigmaPct / 100;
  // N(d1) = 1 - targetDelta ; invert N by bisection
  const p = 1 - targetDelta;
  let lo = -5, hi = 5;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (normCdf_(mid) < p) lo = mid; else hi = mid;
  }
  const d1 = (lo + hi) / 2;
  return spot * Math.exp(-d1 * s * Math.sqrt(T) + (r + s * s / 2) * T);
}

// contracts: [{strike, bid, ask, mid, delta, iv, oi, volume}] (delta negative for puts)
// Returns { pick, band, reason } ; pick = null when nothing is sellable.
function cspSelectContract_(contracts, p) {
  const out = { pick: null, bestInBand: null, reason: '' };
  const capped = contracts.filter(function (c) { return c.strike <= p.maxStrike + 1e-9; });
  const band = capped.filter(function (c) {
    if (c.delta == null) return false;
    const d = Math.abs(c.delta);
    return d >= p.minDelta && d <= p.maxDelta;
  });
  if (!band.length) {
    out.reason = capped.length
      ? 'no put in the ' + p.minDelta + '-' + p.maxDelta + ' delta band at or below $' + round2_(p.maxStrike)
      : 'no listed strike at or below $' + round2_(p.maxStrike) + ' (your Max Buy or the 0.995 x price cap)';
    return out;
  }
  band.sort(function (a, b) { return Math.abs(Math.abs(a.delta) - p.targetDelta) - Math.abs(Math.abs(b.delta) - p.targetDelta); });
  out.bestInBand = band[0];
  const liquid = band.filter(function (c) {
    const sp = (c.bid != null && c.ask != null && c.mid > 0) ? (c.ask - c.bid) / c.mid * 100 : null;
    return c.bid != null && c.bid > 0 && sp != null && sp <= p.maxSpreadPct && (c.oi == null || c.oi >= p.minOi);
  });
  if (!liquid.length) {
    const b = band[0];
    const sp = (b.bid != null && b.ask != null && b.mid > 0) ? (b.ask - b.bid) / b.mid * 100 : null;
    if (b.bid == null || b.bid <= 0) out.reason = 'no live bid on the $' + b.strike + ' put (market closed or quote missing)';
    else if (sp != null && sp > p.maxSpreadPct) out.reason = 'spread ' + round2_(sp) + '% on the $' + b.strike + ' put is wider than ' + p.maxSpreadPct + '%';
    else out.reason = 'open interest ' + b.oi + ' on the $' + b.strike + ' put is under ' + p.minOi;
    return out;
  }
  out.pick = liquid[0];
  return out;
}

// Score 0-100 (risk is shown separately as Prob ITM %).
function cspScore_(m) {
  const yieldPart = 30 * cspClamp01_((m.annualized - 6) / (24 - 6));
  const ivPart = 20 * (m.ivRank == null ? 0.5 : cspClamp01_((m.ivRank - 20) / (60 - 20)));
  const cushPart = 20 * (m.cushionEm == null ? 0 : cspClamp01_((m.cushionEm - 0.3) / (1.0 - 0.3)));
  // Trend/off-high: 15 pts. Above both averages and within 10% of the high = full.
  let trend = 0;
  if (m.vs50 != null && m.vs200 != null) {
    trend += (m.vs200 >= 0 ? 6 : cspClamp01_(1 + m.vs200 / 10) * 6);
    trend += (m.vs50 >= 0 ? 3 : cspClamp01_(1 + m.vs50 / 8) * 3);
  }
  if (m.offHigh != null) trend += 6 * cspClamp01_(1 - m.offHigh / 20);
  const spreadPart = 6 * (m.spreadPct == null ? 0 : cspClamp01_(1 - (m.spreadPct - 2) / 4));
  const oiPart = 4 * (m.oi == null ? 0.5 : cspClamp01_(m.oi / 1500));
  // Event buffer: days between expiry and the next earnings.
  let ev = 0;
  if (m.earnGapDays != null) ev = 5 * cspClamp01_(m.earnGapDays / 10);
  const total = yieldPart + ivPart + cushPart + trend + spreadPart + oiPart + ev;
  return Math.round(total * 10) / 10;
}

// Action for a position you already hold. pl = % of credit captured.
function cspOpenAction_(o, cfg) {
  if (o.dte == null) return { action: '', why: '' };
  if (o.dte <= 0) return { action: 'EXPIRING', why: 'at or past expiry — check assignment' };
  if (o.pl != null && o.pl >= cfg.tp2Pct) return { action: 'TAKE PROFIT', why: 'captured ' + round2_(o.pl) + '% of credit (target ' + cfg.tp2Pct + '%)' };
  if (o.pl != null && o.pl >= cfg.tp1Pct) return { action: 'TAKE PROFIT', why: 'captured ' + round2_(o.pl) + '% of credit (quick target ' + cfg.tp1Pct + '%)' };
  if (o.spot != null && o.strike != null && o.spot < o.strike) {
    return { action: 'ROLL / ASSIGN?', why: 'in the money (stock ' + round2_(o.spot) + ' < strike ' + o.strike + '); accept shares at ' + round2_(o.strike - (o.credit || 0)) + ' basis or roll out/down' };
  }
  if (o.mark != null && o.credit != null && o.mark >= cfg.reviewMultiple * o.credit) {
    return { action: 'REVIEW', why: 'put mark is ' + round2_(o.mark / o.credit) + 'x the credit' };
  }
  if (o.dte <= cfg.timeStopDte) return { action: 'TIME-STOP', why: o.dte + ' DTE left with ' + (o.pl == null ? '?' : round2_(o.pl)) + '% captured: close or roll, do not ride gamma' };
  return { action: 'HOLD', why: (o.pl == null ? '?' : round2_(o.pl)) + '% captured, ' + o.dte + ' DTE' };
}

// Chance that the put's value falls to (1 - takePct/100) x its starting value on a daily close within
// `horizonDays` calendar days. Black-Scholes repricing of simulated stock paths (geometric Brownian motion,
// constant implied vol, risk-free drift, antithetic draws, fixed seed so a row never flickers between runs).
// Honest limits: no gaps, no IV change, no skew; exits are priced at mid (a real fill at the ask costs the spread).
// Returns 0..100, or null when inputs are unusable.
function cspProbTakeProfit_(spot, strike, dteDays, ivPct, startPrice, takePct, horizonDays, paths) {
  if (!(spot > 0 && strike > 0 && dteDays > 0 && ivPct > 0 && startPrice > 0)) return null;
  const sig = ivPct / 100, r = RISK_FREE_RATE;
  const H = Math.min(horizonDays, Math.floor(dteDays) - 1);
  if (H < 1) return null;
  const target = startPrice * (1 - takePct / 100);
  const cdf = function (x) {   // Abramowitz-Stegun 26.2.17, error < 1e-7
    const a = Math.abs(x), t = 1 / (1 + 0.2316419 * a);
    const d = 0.3989422804 * Math.exp(-a * a / 2);
    const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    return x >= 0 ? 1 - p : p;
  };
  const put = function (S, daysLeft) {
    const T = daysLeft / 365, sq = sig * Math.sqrt(T);
    const d1 = (Math.log(S / strike) + (r + sig * sig / 2) * T) / sq, d2 = d1 - sq;
    return strike * Math.exp(-r * T) * cdf(-d2) - S * cdf(-d1);
  };
  let seed = 123456789;
  const rnd = function () { seed = (seed * 1664525 + 1013904223) % 4294967296; return (seed + 1) / 4294967297; };
  const n = paths || 1000;
  const dt = 1 / 365, drift = (r - sig * sig / 2) * dt, vol = sig * Math.sqrt(dt);
  let hits = 0, total = 0;
  for (let i = 0; i < n / 2; i++) {
    const z = new Array(H);
    for (let k = 0; k < H; k++) z[k] = Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    for (let sgn = 1; sgn >= -1; sgn -= 2) {
      let S = spot, hit = false;
      for (let k = 0; k < H; k++) {
        S *= Math.exp(drift + vol * sgn * z[k]);
        if (put(S, dteDays - (k + 1)) <= target) { hit = true; break; }
      }
      if (hit) hits++;
      total++;
    }
  }
  return hits / total * 100;
}

function cspSortKey_(action, score, openAction, openPl) {
  if (openAction === 'TAKE PROFIT') return 3000 + (openPl || 0);
  if (openAction === 'ROLL / ASSIGN?' || openAction === 'REVIEW' || openAction === 'TIME-STOP' || openAction === 'EXPIRING') return 2800;
  if (action === 'SELL') return 2000 + (score || 0);
  if (openAction === 'HOLD') return 1500;
  if (action === 'WAIT') return 1000 + (score || 0);
  return (score || 0);
}


/* ============================================================================
 * DATA FETCH (thin wrappers around the existing helpers)
 * ========================================================================== */

function cspParseIvRank_(item) {
  const num = function (v) { const n = v != null ? parseFloat(v) : NaN; return isNaN(n) ? null : n; };
  const raws = [num(item['implied-volatility-rank']), num(item['implied-volatility-index-rank']), num(item['implied-volatility-percentile'])];
  for (let i = 0; i < raws.length; i++) {
    if (raws[i] == null) continue;
    const pct = raws[i] <= 1 ? raws[i] * 100 : raws[i];
    if (isPlausible_(pct, 0, 100)) return pct;
  }
  return null;
}

// One request for many tickers; any ticker missing from the reply falls back to
// the existing single-ticker fetch (so a wrong assumption about the batch form
// only costs time, never data).
function cspFetchIvRanks_(tickers, token) {
  const result = {};
  if (!token || !tickers.length) return result;
  for (let i = 0; i < tickers.length; i += 20) {
    const chunk = tickers.slice(i, i + 20);
    try {
      const url = 'https://api.tastyworks.com/market-metrics?symbols=' + chunk.map(encodeURIComponent).join(',');
      const resp = fetchTastyWithRetry_(url, token);
      if (resp.getResponseCode() === 200) {
        const items = (JSON.parse(resp.getContentText()).data || {}).items || [];
        items.forEach(function (it) {
          const sym = String(it.symbol || '').toUpperCase();
          const r = cspParseIvRank_(it);
          if (sym && r != null) result[sym] = r;
        });
      }
    } catch (e) { Logger.log('CSP IV rank batch error: ' + e); }
  }
  tickers.forEach(function (t) {
    if (result[t] != null) return;
    try {
      const m = fetchTastyMarketMetrics_(t, token);
      if (m && m.ivPercent != null) result[t] = m.ivPercent;
    } catch (e) { /* leave blank */ }
  });
  return result;
}

function cspParseDate_(v) {
  if (v == null || v === '') return null;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v.getTime()) ? null : v;
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? null : d;
}

function cspDaysBetween_(from, to) { return Math.round((to.getTime() - from.getTime()) / 86400000); }

function cspFetchEarnings_(ticker, ctx) {
  const res = getSlowCached_(ctx.slowCache, ctx.pending, 'CATALYST', ticker, SLOW_REFRESH_DAYS.CATALYST, function () {
    let c = ctx.finnhubKey ? fetchFinnhubNextEarnings_(ticker, ctx.finnhubKey) : null;
    if (!c) c = fetchYahooNextEarnings_(ticker);
    if (!c) return null;
    return { date: c.date ? Utilities.formatDate(c.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null };
  }, isCatalystPast_);
  if (res.fetchAttempted) Utilities.sleep(CSP_CONFIG.sleepMs);
  return (res.value && res.value.date) ? new Date(res.value.date + 'T12:00:00') : null;
}

function cspFetchTech_(ticker, ctx) {
  const res = getSlowCached_(ctx.slowCache, ctx.pending, 'CSPTECH', ticker, SLOW_REFRESH_DAYS.DAILYBARS, function () {
    const closes = fetchYahooDailyBarsForRange_(ticker, '1y');
    return closes ? cspComputeTech_(closes) : null;
  });
  if (res.fetchAttempted) Utilities.sleep(CSP_CONFIG.sleepMs);
  return res.value || null;
}

// Candidate puts for ONE expiry. Tasty path fetches only a strike window around
// the target-delta strike (one batched market-data call); Yahoo path pulls the
// whole expiry chain once.
function cspFetchPutContracts_(ticker, spot, expiry, dte, hv20, ctx, maxStrike) {
  const sigma0 = Math.max(hv20 || 25, 15);
  const k0 = cspStrikeForDelta_(spot, dte, sigma0, CSP_CONFIG.targetDelta, RISK_FREE_RATE);

  if (ctx.token && ctx.tastyExp && ctx.tastyExp[ticker]) {
    const key = Utilities.formatDate(expiry, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const match = ctx.tastyExp[ticker].find(function (e) { return Utilities.formatDate(e.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') === key; });
    if (match) {
      const strikes = match.strikes
        .filter(function (s) { return s.putSymbol && s.strike >= k0 * 0.80 && s.strike <= Math.min(k0 * 1.15, spot * 1.0); })
        .sort(function (a, b) { return Math.abs(a.strike - k0) - Math.abs(b.strike - k0); })
        .slice(0, 30);
      const md = fetchTastyMarketDataBatch_(strikes.map(function (s) { return s.putSymbol; }), ctx.token);
      const contracts = strikes.map(function (s) {
        const q = md[s.putSymbol];
        if (!q || q.delta == null) return null;
        const bid = q.bid, ask = q.ask;
        const mid = (bid != null && ask != null) ? (bid + ask) / 2 : null;
        const iv = mid != null ? impliedVolatilityBisection_(mid, spot, s.strike, dte, 'P') : null;
        return { strike: s.strike, bid: bid, ask: ask, mid: mid, delta: q.delta, iv: iv, oi: q.oi, volume: q.volume };
      }).filter(Boolean);
      if (contracts.length) return contracts;
    }
  }

  const chain = getNormalizedPutChainForExpiry_(ticker, expiry, dte, null, null, spot);
  if (!chain) return [];
  return chain.contracts
    .filter(function (c) { return c.strike >= k0 * 0.80 && c.strike <= Math.min(k0 * 1.15, spot); })
    .map(function (c) { return { strike: c.strike, bid: c.bid, ask: c.ask, mid: c.mid, delta: c.delta, iv: c.iv, oi: c.oi, volume: c.volume }; });
}

// Expirations inside [minDte, maxDte] as [{date, dte}], nearest to targetDte first.
function cspListExpiries_(ticker, ctx, now) {
  let dates = null;
  if (ctx.token) {
    if (!ctx.tastyExp[ticker]) {
      try { ctx.tastyExp[ticker] = fetchTastyOptionChainNested_(ticker, ctx.token) || null; } catch (e) { ctx.tastyExp[ticker] = null; }
    }
    if (ctx.tastyExp[ticker]) dates = ctx.tastyExp[ticker].map(function (e) { return e.date; });
  }
  if (!dates) {
    const y = fetchYahooExpirationDatesForScanner_(ticker);
    dates = y && y.dates ? y.dates : [];
  }
  return dates
    .map(function (d) { return { date: d, dte: cspDaysBetween_(now, d) }; })
    .filter(function (e) { return e.dte >= CSP_CONFIG.minDte && e.dte <= CSP_CONFIG.maxDte; })
    .sort(function (a, b) { return Math.abs(a.dte - CSP_CONFIG.targetDte) - Math.abs(b.dte - CSP_CONFIG.targetDte); });
}


/* ============================================================================
 * ONE ROW: build all output fields
 * ========================================================================== */

function cspProcessRow_(inp, ctx) {
  const now = ctx.now;
  const out = {};
  const t = inp.ticker;
  const cfg = CSP_CONFIG;
  let action = 'WAIT', why = [];

  if (inp.holdCells && inp.openStrike == null) {
    out.Action = 'FILL IN'; out.Score = '';
    out.Why = 'Open Qty is set but Strike, Expiry or Entry (premium received) is missing: enter them (Strike and Expiry are never overwritten while Open Qty is filled)';
    out.SortKey = 2900; return out;
  }
  const tech = cspFetchTech_(t, ctx);
  if (!tech) { out.Action = 'SKIP'; out.Why = 'no daily price history from Yahoo'; return out; }

  // Live spot: Tasty equity quote first, last close otherwise.
  let spot = null;
  if (ctx.token) {
    try { const q = fetchTastyEquityQuote_(t, ctx.token); if (q && q.price != null) spot = q.price; } catch (e) { /* fall back */ }
  }
  if (spot == null) spot = tech.price;

  out.Price = spot;
  const offHigh = tech.hi52 ? (1 - spot / tech.hi52) * 100 : null;
  const vs200 = tech.ma200 ? (spot / tech.ma200 - 1) * 100 : null;
  const vs50 = tech.ma50 ? (spot / tech.ma50 - 1) * 100 : null;
  out['Off 52w High %'] = offHigh; out['vs 200d %'] = vs200; out['vs 50d %'] = vs50;
  out.RSI = tech.rsi; out.HV20 = tech.hv20;

  const isEtf = !!inp.isEtf;
  const earnDate = isEtf ? null : cspFetchEarnings_(t, ctx);   // ETFs have no earnings
  const earnDays = earnDate ? cspDaysBetween_(now, earnDate) : null;
  out['Next Earnings'] = isEtf ? 'ETF' : (earnDate || ''); out['Earn Days'] = earnDays == null ? '' : earnDays;
  out['IV Rank'] = ctx.ivRanks[t] != null ? ctx.ivRanks[t] : '';

  // ----- open position tracker (independent of the proposal) -----
  let openAction = '';
  if (inp.openStrike != null && inp.openExpiry) {
    const dteLeft = cspDaysBetween_(now, inp.openExpiry);
    let mark = null;
    try {
      if (ctx.token) { const q = fetchTastyTradeQuote_(buildOccSymbol_(t, inp.openExpiry, inp.openStrike, 'P'), ctx.token); if (q) mark = q.mark; }
      if (mark == null) { const y = fetchYahooQuote_(t, inp.openExpiry, inp.openStrike, 'P'); if (y) mark = y.mark; }
    } catch (e) { /* leave null */ }
    const pl = (mark != null && inp.openCredit) ? (inp.openCredit - mark) / inp.openCredit * 100 : null;
    const oa = cspOpenAction_({ dte: dteLeft, pl: pl, spot: spot, strike: inp.openStrike, credit: inp.openCredit, mark: mark }, cfg);
    out['Open Mark'] = mark != null ? mark : ''; out['Open P/L %'] = pl != null ? pl : '';
    if (mark != null) out.Mid = mark;
    out['Open DTE'] = dteLeft; out['Open Held'] = inp.openDate ? cspDaysBetween_(inp.openDate, now) : '';
    out['Open Action'] = oa.action ? (oa.action) : '';
    out._openWhy = oa.why; out._openPl = pl; openAction = oa.action;
    // The row now describes the put you hold: Strike / Expiry / Mid stay as typed, the rest is live data for that contract.
    out.Action = oa.action || 'HOLD'; out.Score = ''; out.DTE = dteLeft;
    try {
      if (ctx.token) {
        const occ = buildOccSymbol_(t, inp.openExpiry, inp.openStrike, 'P');
        const md = fetchTastyMarketDataBatch_([occ], ctx.token);
        const q = md && md[occ];
        if (q) {
          if (q.delta != null) out.Delta = q.delta;
          if (q.oi != null) out.OI = q.oi;
          if (q.volume != null) out.Volume = q.volume;
          if (q.bid != null && q.ask != null && (q.bid + q.ask) > 0) {
            out['Spread %'] = (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 100;
            if (q.bid > 0 && q.ask > 0) { out.Bid = q.bid; out.Ask = q.ask; out.Mid = (q.bid + q.ask) / 2; }
          }
        }
      }
    } catch (e) { /* contract detail is optional */ }
    // Annualized on the premium you received (needs Open Date), cushion in expected moves from the put's current implied vol.
    try {
      if (inp.openCredit && inp.openDate) {
        const held0 = cspDaysBetween_(inp.openDate, inp.openExpiry);
        if (held0 > 0) out['Annualized %'] = inp.openCredit / inp.openStrike * 100 * 365 / held0;
      }
      if (mark != null && dteLeft > 0) {
        const ivO = impliedVolatilityBisection_(mark, spot, inp.openStrike, dteLeft, 'P');
        if (ivO) {
          const emO = spot * (ivO / 100) * Math.sqrt(dteLeft / 365);
          if (emO > 0) out['Cushion EM'] = (spot - (inp.openStrike - inp.openCredit)) / emO;
          // chance of reaching the 25% / 50% profit level on your credit within the horizon, from today's mark
          const pTp = function (pct) {
            const tgt = inp.openCredit * (1 - pct / 100);
            return mark <= tgt ? 100 : cspProbTakeProfit_(spot, inp.openStrike, dteLeft, ivO, mark, (1 - tgt / mark) * 100, CSP_PROB_DAYS);
          };
          out['P25 in 10d %'] = pTp(cfg.tp1Pct); out['P50 in 10d %'] = pTp(cfg.tp2Pct);
        }
      }
    } catch (e) { /* optional */ }
    if (out.Mid !== undefined && out.Mid !== '' && inp.openCredit > 0) out.PNL = Math.round((inp.openCredit - out.Mid) * 100) / 100;
    out.Why = (earnDays != null && earnDays <= dteLeft) ? 'earnings in ' + earnDays + ' days, inside this put\'s life' : '';
    out.SortKey = cspSortKey_(out.Action, 0, out.Action, pl);
    return out;
  } else {
    out['Open Mark'] = ''; out['Open P/L %'] = ''; out['Open DTE'] = ''; out['Open Held'] = ''; out['Open Action'] = '';
  }

  // ----- structural gates (SKIP) -----
  let skip = null;
  if (cfg.requireMoat && String(inp.moat || '').trim().toUpperCase() === 'N') skip = 'Moat marked N';
  else if (vs200 != null && vs200 < -cfg.maxBelow200Pct) skip = round2_(-vs200) + '% under the 200-day average (trend broken)';
  else if (offHigh != null && offHigh > cfg.maxDrawdownPct) skip = round2_(offHigh) + '% under the 52-week high (more than ' + cfg.maxDrawdownPct + '%)';
  if (skip) { out.Action = 'SKIP'; out.Score = ''; out.Why = skip; out.SortKey = cspSortKey_('SKIP', 0, openAction, out._openPl); return out; }

  const maxBuy = inp.maxBuy != null ? inp.maxBuy : null;
  let maxStrike = Math.min(spot * 0.995, maxBuy != null ? maxBuy : Infinity);

  // ----- expiries -----
  const exps = cspListExpiries_(t, ctx, now);
  if (!exps.length) { out.Action = 'SKIP'; out.Why = 'no listed expiry between ' + cfg.minDte + ' and ' + cfg.maxDte + ' DTE (or chain unavailable)'; out.SortKey = cspSortKey_('SKIP', 0, openAction, out._openPl); return out; }
  const eligible = exps.filter(function (e) { return earnDays == null || e.dte <= earnDays - 1; });
  if (!eligible.length) {
    out.Action = 'WAIT';
    out.Why = 'earnings in ' + earnDays + ' days (' + Utilities.formatDate(earnDate, Session.getScriptTimeZone(), 'MMM d') + ') fall inside every expiry in the window; retry after the report';
    out.SortKey = cspSortKey_('WAIT', 0, openAction, out._openPl);
    return out;
  }

  // ----- contract choice (try up to two expiries) -----
  const vixAdj = ctx.vix != null && ctx.vix >= cfg.vixHigh;
  const targetDelta = vixAdj ? cfg.highVixDelta : cfg.targetDelta;
  let chosen = null, chosenExp = null, lastReason = '';
  for (let i = 0; i < Math.min(2, eligible.length) && !chosen; i++) {
    const e = eligible[i];
    const contracts = cspFetchPutContracts_(t, spot, e.date, e.dte, tech.hv20, ctx, maxStrike);
    Utilities.sleep(cfg.sleepMs);
    const sel = cspSelectContract_(contracts, {
      maxStrike: maxStrike, minDelta: cfg.minDelta, maxDelta: cfg.maxDelta, targetDelta: targetDelta,
      maxSpreadPct: cfg.maxSpreadPct, minOi: cfg.minOi
    });
    if (sel.pick) { chosen = sel.pick; chosenExp = e; } else { lastReason = sel.reason; }
  }
  if (!chosen) {
    out.Action = 'WAIT'; out.Why = lastReason || 'no sellable put found';
    out.SortKey = cspSortKey_('WAIT', 0, openAction, out._openPl);
    return out;
  }

  // ----- economics -----
  const dte = chosenExp.dte, strike = chosen.strike, mid = chosen.mid;
  const spreadPct = (chosen.ask - chosen.bid) / mid * 100;
  const yieldPct = mid / strike * 100;
  const annualized = yieldPct * 365 / dte;
  const breakeven = strike - mid;
  const iv = chosen.iv;
  const em = iv != null ? spot * (iv / 100) * Math.sqrt(dte / 365) : null;
  const cushionEm = em ? (spot - breakeven) / em : null;
  const cashReq = strike * 100;
  const earnGap = isEtf ? 30 : (earnDays != null ? earnDays - dte : null);

  out.IV = iv != null ? iv : ''; out['IV/HV'] = (iv != null && tech.hv20) ? iv / tech.hv20 : '';
  out.Expiry = chosenExp.date; out.DTE = dte; out.Strike = strike; out.Delta = chosen.delta;
  out.Bid = chosen.bid; out.Ask = chosen.ask; out.Mid = mid; out['Spread %'] = spreadPct;
  out.OI = chosen.oi != null ? chosen.oi : ''; out.Volume = chosen.volume != null ? chosen.volume : '';
  out['Credit $'] = mid * 100; out['Cash Req'] = cashReq; out['Yield %'] = yieldPct; out['Annualized %'] = annualized;
  out.Breakeven = breakeven; out['Cushion %'] = (spot - breakeven) / spot * 100; out['Cushion EM'] = cushionEm != null ? cushionEm : '';
  out['Prob ITM %'] = Math.abs(chosen.delta) * 100;
  out['Basis vs Max Buy %'] = maxBuy ? (breakeven - maxBuy) / maxBuy * 100 : '';
  if (iv != null) {
    out['P25 in 10d %'] = cspProbTakeProfit_(spot, strike, dte, iv, mid, cfg.tp1Pct, CSP_PROB_DAYS);
    out['P50 in 10d %'] = cspProbTakeProfit_(spot, strike, dte, iv, mid, cfg.tp2Pct, CSP_PROB_DAYS);
  }
  out['TP25 Buyback'] = mid * (1 - cfg.tp1Pct / 100); out['TP50 Buyback'] = mid * (1 - cfg.tp2Pct / 100);
  const ts = new Date(chosenExp.date.getTime() - (dte >= cfg.timeStopDte + 7 ? cfg.timeStopDte : 7) * 86400000);
  out['Time-Stop Date'] = ts;
  out['Review Level'] = mid * cfg.reviewMultiple;

  const score = cspScore_({
    annualized: annualized, ivRank: ctx.ivRanks[t] != null ? ctx.ivRanks[t] : null, cushionEm: cushionEm,
    vs50: vs50, vs200: vs200, offHigh: offHigh, spreadPct: spreadPct, oi: chosen.oi != null ? chosen.oi : null, earnGapDays: earnGap
  });
  out.Score = score;

  // ----- action (SELL needs every soft gate to pass too) -----
  const notes = [];
  if (ctx.ivRanks[t] != null && ctx.ivRanks[t] < cfg.minIvRank) why.push('IV Rank ' + round2_(ctx.ivRanks[t]) + ' < ' + cfg.minIvRank + ' (thin premium)');
  if (annualized < cfg.minAnnualizedPct) why.push('annualized ' + round2_(annualized) + '% < ' + cfg.minAnnualizedPct + '%');
  if (earnDays == null && !isEtf) why.push('earnings date unknown, verify before selling');
  if (score < cfg.scoreSell) why.push('score ' + score + ' < ' + cfg.scoreSell);
  if (chosen.oi == null) notes.push('OI unavailable');
  if (vixAdj) notes.push('VIX ' + round2_(ctx.vix) + ' high: delta ' + targetDelta);

  if (!why.length) {
    action = 'SELL';
    why.push('sell ' + dte + ' DTE $' + strike + 'P for ' + round2_(mid) + ' (' + round2_(annualized) + '% annualized); buy back at ' + round2_(out['TP25 Buyback']) + ' (25%) / ' + round2_(out['TP50 Buyback']) + ' (50%)');
  }
  out.Action = action;
  out.Why = why.concat(notes.length ? ['[' + notes.join('; ') + ']'] : []).join('; ');
  out.SortKey = cspSortKey_(action, score, openAction, out._openPl);
  return out;
}


/* ============================================================================
 * RUN
 * ========================================================================== */

function runCspScan(timeBudgetMsOverride, dryRun, opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const startMs = Date.now();
  const budgetMs = (typeof timeBudgetMsOverride === 'number' && timeBudgetMsOverride > 0) ? timeBudgetMsOverride : CSP_CONFIG.timeBudgetMs;
  const now = new Date();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CSP_SHEET_NAME);
  if (!sheet) { notify_(ui, 'CSP', 'No "' + CSP_SHEET_NAME + '" tab. Run setupCsp once from the Apps Script editor.'); return; }
  const map = cspEnsureHeaders_(sheet);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) { notify_(ui, 'CSP', 'Add tickers in column A first.'); return; }
  const width = sheet.getLastColumn();
  const data = sheet.getRange(2, 1, lastRow - 1, width).getValues();

  // Read inputs
  const rows = [];
  const entryMigrated = PropertiesService.getScriptProperties().getProperty('CSP_ENTRY_MIGRATED') === '1';
  const entryFixes = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const num = function (h) { const v = r[map[h] - 1]; const n = (v === '' || v == null) ? null : parseFloat(v); return isNaN(n) ? null : n; };
    // Open Qty filled = you hold a put: Strike / Expiry are then your entries, Entry is the premium received. Mid is live data.
    const qty = num('Open Qty');
    const holdCells = qty != null && qty > 0;
    const oStrike = holdCells ? num('Strike') : null;
    const oExpiry = holdCells ? cspParseDate_(r[map['Expiry'] - 1]) : null;
    let oCredit = holdCells ? num('Entry') : null;
    // One-time carry-over: before the Entry column existed, the premium you received was typed into Mid. Copy it to Entry once.
    if (holdCells && oCredit == null && !entryMigrated && map['Entry']) {
      const legacy = num('Mid');
      if (legacy != null && legacy > 0) { oCredit = legacy; r[map['Entry'] - 1] = legacy; entryFixes.push({ row: i + 2, col: map['Entry'], value: legacy }); }
    }
    const complete = holdCells && oStrike != null && oExpiry && oCredit != null && oCredit > 0;
    rows.push({
      idx: i, ticker: t, isEtf: false, moat: map['Moat'] ? r[map['Moat'] - 1] : '', maxBuy: map['Max Buy'] ? num('Max Buy') : null,
      holdCells: holdCells, isOpen: !!complete,
      openStrike: complete ? oStrike : null, openExpiry: complete ? oExpiry : null,
      openCredit: complete ? oCredit : null, openDate: map['Open Date'] ? cspParseDate_(r[map['Open Date'] - 1]) : null,
      openQty: qty || 1,
      type: map['Type'] ? String(r[map['Type'] - 1] || '').trim().toUpperCase() : '',
      lastRun: r[map['LastRun'] - 1] instanceof Date ? r[map['LastRun'] - 1].getTime() : 0
    });
  });
  if (!rows.length) { notify_(ui, 'CSP', 'No tickers found in column A.'); return; }

  // Cash behind the short puts you hold (information only)
  let openCashTotal = 0;
  rows.forEach(function (rw) {
    if (rw.openStrike != null && rw.openExpiry && rw.openExpiry.getTime() > now.getTime() - 86400000) {
      const c = rw.openStrike * 100 * rw.openQty;
      openCashTotal += c;
    }
  });

  rows.forEach(function (rw) { rw.isEtf = rw.type === 'ETF' || !!CSP_ETF_SET[rw.ticker]; });
  // Scheduled "open puts only" ticks skip the expensive proposal scan for everything else.
  const work = opts.onlyOpen ? rows.filter(function (rw) { return rw.openStrike != null && rw.openExpiry; }) : rows.slice();
  if (!work.length) { notify_(ui, 'CSP', opts.onlyOpen ? 'No open puts to check.' : 'No rows to process.'); return { processed: 0, counts: { SELL: 0, WAIT: 0, SKIP: 0 } }; }
  // Process stalest first so repeated partial runs cover everything.
  work.sort(function (a, b) { return a.lastRun - b.lastRun; });
  PropertiesService.getScriptProperties().setProperty('CSP_RUNNING', String(Date.now()));

  const token = getTastyTradeAccessToken_();
  const slowCache = cspLoadCache_();
  const pending = {};
  const vixRes = getSlowCached_(slowCache, pending, 'VIXHISTORY', 'GLOBAL', SLOW_REFRESH_DAYS.DAILYBARS, function () {
    return fetchYahooDailyBarsForRange_('^VIX', '1y');
  });
  const vix = (vixRes.value && vixRes.value.length) ? vixRes.value[vixRes.value.length - 1] : null;

  const eligibleTickers = work.filter(function (r) { return !CSP_CONFIG.requireMoat || String(r.moat || '').trim().toUpperCase() !== 'N'; })
    .map(function (r) { return r.ticker; }).filter(function (t, i, a) { return a.indexOf(t) === i; });
  const ivRanks = cspFetchIvRanks_(eligibleTickers, token);

  const ctx = {
    now: now, token: token, slowCache: slowCache, pending: pending, finnhubKey: getFinnhubApiKey_(),
    tastyExp: {}, ivRanks: ivRanks, vix: vix
  };

  const outCols = CSP_OUTPUT_HEADERS.concat(CSP_LEGACY_OUTPUTS).filter(function (h) { return map[h]; });
  let processed = 0, timedOut = false;
  const errors = [];
  const counts = { SELL: 0, WAIT: 0, SKIP: 0 };
  const lastRunStamp = new Date();
  const pnlByIdx = {};
  let alertItems = [];
  let prevPx = {}; const newPx = {};
  try { prevPx = JSON.parse(PropertiesService.getScriptProperties().getProperty('CSP_PREV_PRICE') || '{}') || {}; } catch (e) { prevPx = {}; }

  for (let i = 0; i < work.length; i++) {
    if (Date.now() - startMs > budgetMs) { timedOut = true; break; }
    const rw = work[i];
    let res;
    try {
      res = cspProcessRow_(rw, ctx);
    } catch (e) {
      res = { Action: 'WAIT', Why: 'error: ' + (e && e.message ? e.message : e), SortKey: 1 };
      errors.push(rw.ticker + ': ' + (e && e.message ? e.message : e));
    }
    res.LastRun = lastRunStamp;
    if (typeof res.Price === 'number' && res.Price > 0) {
      if (prevPx[rw.ticker] > 0) res.Change = round2_(res.Price - prevPx[rw.ticker]);
      newPx[rw.ticker] = res.Price;
    }
    try { alertItems = alertItems.concat(cspBuildAlertItems_(rw, res)); } catch (e) { /* never let alert building break a scan */ }
    if (res._openWhy) res.Why = 'OPEN PUT: ' + res._openWhy + (res.Why ? ' | ' + res.Why : '');
    const row = data[rw.idx];
    // Clear previous outputs for this row, then fill.
    // While Open Qty is filled, Strike / Expiry / Mid are your entries: never cleared, never overwritten.
    const held = rw.holdCells ? CSP_HELD_WHEN_OPEN : [];
    outCols.forEach(function (h) { if (held.indexOf(h) === -1) row[map[h] - 1] = ''; });
    outCols.forEach(function (h) {
      if (held.indexOf(h) !== -1) return;
      if (res[h] !== undefined && res[h] !== null) row[map[h] - 1] = res[h];
    });
    pnlByIdx[rw.idx] = (res.PNL === undefined || res.PNL === null) ? '' : res.PNL;
    if (res.Action && counts[res.Action] != null) counts[res.Action]++;
    processed++;
    Utilities.sleep(CSP_CONFIG.sleepMs);
  }

  if (!dryRun) {
    // Write each contiguous group of output columns separately, so your input columns (Open Qty, Open Date, ...)
    // that sit between them are never rewritten.
    const cols = outCols.map(function (h) { return map[h]; }).sort(function (a, b) { return a - b; });
    let g0 = 0;
    while (g0 < cols.length) {
      let g1 = g0;
      while (g1 + 1 < cols.length && cols[g1 + 1] === cols[g1] + 1) g1++;
      const c0 = cols[g0], c1 = cols[g1];
      const block = data.map(function (r) { return r.slice(c0 - 1, c1); });
      sheet.getRange(2, c0, block.length, c1 - c0 + 1).setValues(block);
      g0 = g1 + 1;
    }
    // PNL column: rows processed this run get Entry - Mid (or blank); rows not processed keep whatever is there (formula or value).
    try {
      const pc = cspPnlCol_(map);
      const pcHdr = String(sheet.getRange(1, pc).getValue() == null ? '' : sheet.getRange(1, pc).getValue()).trim();
      if (pcHdr !== 'PNL' && CSP_HEADERS.indexOf(pcHdr) !== -1) throw new Error('column ' + pc + ' is "' + pcHdr + '", not the PNL column: change CSP_PNL_COLUMN');
      const rng = sheet.getRange(2, pc, data.length, 1);
      const fx = rng.getFormulas(), vx = rng.getValues();
      const col = data.map(function (r, i) {
        if (pnlByIdx[i] !== undefined) return [pnlByIdx[i]];
        return [fx[i][0] !== '' ? fx[i][0] : vx[i][0]];
      });
      rng.setValues(col);
    } catch (e) { logToSheet_('CSP: could not write the PNL column: ' + (e && e.message ? e.message : e)); }
    if (map['Change']) sheet.getRange(2, map['Change'], data.length, 1).setNumberFormat(CSP_CHANGE_FORMAT);
    try { Object.keys(newPx).forEach(function (k) { prevPx[k] = newPx[k]; }); PropertiesService.getScriptProperties().setProperty('CSP_PREV_PRICE', JSON.stringify(prevPx)); } catch (e) { /* too big: skip */ }
    cspColorRows_(sheet, map, data.length);
    // One-time carry-over of premium typed in Mid before the Entry column existed (see the input reader above).
    entryFixes.forEach(function (f) { sheet.getRange(f.row, f.col).setValue(f.value); });
    if (!entryMigrated && !timedOut) PropertiesService.getScriptProperties().setProperty('CSP_ENTRY_MIGRATED', '1');
    cspApplyEarnRules_(sheet, map, true);
    // Sort whole rows (inputs travel with their outputs): take-profit, review, SELL, WAIT, SKIP.
    if (map['SortKey']) {
      sheet.getRange(2, 1, data.length, width).sort({ column: map['SortKey'], ascending: false });
    }
    cspFlushCache_(pending);
  }

  let alertNote = '';
  if (!dryRun && !opts.noAlerts) {
    const ar = cspDispatchAlerts_(alertItems, now);
    alertNote = ar.note ? 'Alerts: ' + ar.note + '\n' : '';
  }
  PropertiesService.getScriptProperties().deleteProperty('CSP_RUNNING');

  const sec = Math.round((Date.now() - startMs) / 1000);
  const msg =
    (dryRun ? '(DRY RUN: nothing written)\n' : '') +
    (timedOut ? '⏱️ Stopped early at the time limit: ' + processed + ' of ' + work.length + ' rows done. Run again to continue with the stalest rows.\n\n' : '') +
    'Rows processed: ' + processed + ' of ' + work.length + (opts.onlyOpen ? ' (open puts only)' : '') + ' in ' + sec + 's\n' + alertNote +
    'SELL: ' + counts.SELL + '   WAIT: ' + counts.WAIT + '   SKIP: ' + counts.SKIP + '\n' +
    (vix != null ? 'VIX: ' + round2_(vix) + '\n' : '') +
    'Cash behind your open short puts: $' + Math.round(openCashTotal) + ' (no cap applied)\n' +
    (token ? '' : '⚠️ No TastyTrade token: using Yahoo (estimated delta, slower).\n') +
    (errors.length ? '\nErrors:\n' + errors.map(function (e) { return '  • ' + e; }).join('\n') : '');
  notify_(ui, 'CSP scan complete', msg);
  return { processed: processed, counts: counts, timedOut: timedOut };
}

function cspColorRows_(sheet, map, n) {
  const colorFor = { 'SELL': '#b7e1cd', 'WAIT': '#fff2cc', 'SKIP': '#eeeeee', 'TAKE PROFIT': '#b7e1cd', 'HOLD': '#cfe2f3', 'TIME-STOP': '#fce5cd',
    'REVIEW': '#f4cccc', 'ROLL / ASSIGN?': '#f4cccc', 'EXPIRING': '#f4cccc', 'FILL IN': '#f4cccc' };
  const openColor = { 'TAKE PROFIT': '#b7e1cd', 'HOLD': '#ffffff', 'TIME-STOP': '#fce5cd', 'REVIEW': '#f4cccc', 'ROLL / ASSIGN?': '#f4cccc', 'EXPIRING': '#f4cccc' };
  if (map['Action']) {
    const vals = sheet.getRange(2, map['Action'], n, 1).getValues();
    sheet.getRange(2, map['Action'], n, 1).setBackgrounds(vals.map(function (v) { return [colorFor[v[0]] || null]; }));
  }
  if (map['Open Action']) {
    const vals = sheet.getRange(2, map['Open Action'], n, 1).getValues();
    sheet.getRange(2, map['Open Action'], n, 1).setBackgrounds(vals.map(function (v) { return [openColor[v[0]] || null]; }));
  }
}


/* ============================================================================
 * DEBUG (also add to menu above) — one ticker, prints the decision trail
 * ========================================================================== */

function debugCspOneTicker() {
  const ui = tryGetUi_();
  if (!ui) return;
  const r = ui.prompt('CSP debug', 'Ticker (e.g. MSFT):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = r.getResponseText().trim().toUpperCase();
  if (!t) return;
  const now = new Date();
  const token = getTastyTradeAccessToken_();
  const slowCache = cspLoadCache_();
  const pending = {};
  const ctx = {
    now: now, token: token, slowCache: slowCache, pending: pending, finnhubKey: getFinnhubApiKey_(),
    tastyExp: {}, ivRanks: cspFetchIvRanks_([t], token), vix: null
  };
  const res = cspProcessRow_({ ticker: t, moat: 'Y', maxBuy: null, openStrike: null, openExpiry: null, openCredit: null, openDate: null, openQty: 1 }, ctx);
  cspFlushCache_(pending);
  const lines = Object.keys(res).filter(function (k) { return k.charAt(0) !== '_'; }).map(function (k) {
    const v = res[k];
    return k + ': ' + (Object.prototype.toString.call(v) === '[object Date]' ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : v);
  });
  ui.alert('CSP debug: ' + t, lines.join('\n').substring(0, 5000), ui.ButtonSet.OK);
}


/* ============================================================================
 * TELEGRAM ALERTS (same provider setup as Quick: menu Options Validator >
 * Phone Alerts). One batched message per run. State is only saved when the
 * message actually went out, so a failed send is retried on the next run.
 * ========================================================================== */

function cspAlertsOn_() {
  return PropertiesService.getScriptProperties().getProperty('CSP_ALERTS') !== 'false';
}

function cspIsDate_(v) { return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime()); }

// Alert items for one processed row: a new SELL proposal and/or an action on a put you hold.
function cspBuildAlertItems_(rw, res) {
  const items = [];
  const tz = Session.getScriptTimeZone();
  const fmt = function (d) { return Utilities.formatDate(d, tz, 'MMM d'); };
  const ymd = function (d) { return Utilities.formatDate(d, tz, 'yyyyMMdd'); };
  const r2 = function (v) { return (v === '' || v == null || isNaN(v)) ? '?' : (Math.round(v * 100) / 100).toFixed(2); };
  const t = rw.ticker;

  const oa = res['Open Action'];
  if (oa && rw.openStrike != null && cspIsDate_(rw.openExpiry)) {
    const label = t + ' $' + rw.openStrike + 'P ' + fmt(rw.openExpiry);
    const key = oa + '|' + t + '|' + rw.openStrike + '|' + ymd(rw.openExpiry);
    if (oa === 'TAKE PROFIT') {
      items.push({ kind: 'tp', key: key, text: 'TAKE PROFIT ' + label + ': ' + res._openWhy + '. Mark ' + r2(res['Open Mark']) + ' vs credit ' + r2(rw.openCredit) + ', buy to close.' });
    } else if (oa === 'TIME-STOP' || oa === 'REVIEW' || oa === 'ROLL / ASSIGN?' || oa === 'EXPIRING') {
      items.push({ kind: 'review', key: key, text: oa + ' ' + label + ': ' + res._openWhy });
    }
  }
  if (res.Action === 'SELL' && cspIsDate_(res.Expiry)) {
    items.push({
      kind: 'sell', key: 'SELL|' + t + '|' + ymd(res.Expiry),
      text: 'SELL ' + t + ' ' + fmt(res.Expiry) + ' $' + res.Strike + 'P @ ' + r2(res.Mid) + ' (' + res.DTE + 'd, ' + r2(res['Annualized %']) +
        '% ann, delta ' + r2(Math.abs(res.Delta)) + ', cushion ' + r2(res['Cushion EM']) + ' sigma, cash $' + Math.round(res['Cash Req']) +
        '). Buy back <= ' + r2(res['TP25 Buyback']) + ' (25%) or ' + r2(res['TP50 Buyback']) + ' (50%). Score ' + res.Score
    });
  }
  return items;
}

// Returns { sent, note }. Never throws.
function cspDispatchAlerts_(items, now) {
  try {
    if (!items || !items.length) return { sent: 0, note: '' };
    if (!cspAlertsOn_()) return { sent: 0, note: 'CSP alerts are switched off (menu: CSP > CSP Alerts & Schedule).' };
    const cfg = getAlertConfig_();
    if (!cfg.ready) return { sent: 0, note: 'phone alerts are not set up or are off (menu: Options Validator > Phone Alerts).' };

    const props = PropertiesService.getScriptProperties();
    let state = {};
    try { state = JSON.parse(props.getProperty('CSP_ALERT_STATE') || '{}'); } catch (e) { state = {}; }
    const A = CSP_CONFIG.alerts;
    const hoursFor = { tp: A.takeProfitRepeatHours, review: A.reviewRepeatHours, sell: A.sellRepeatHours };
    const nowMs = now.getTime();
    const fresh = items.filter(function (it) {
      const prev = state[it.key];
      return !prev || nowMs - prev >= hoursFor[it.kind] * 3600000;
    });
    if (!fresh.length) return { sent: 0, note: items.length + ' signal(s), all already alerted within their repeat window.' };

    const order = { tp: 0, review: 1, sell: 2 };
    fresh.sort(function (a, b) { return order[a.kind] - order[b.kind]; });
    const n = function (k) { return fresh.filter(function (it) { return it.kind === k; }).length; };
    const parts = [];
    if (n('tp')) parts.push(n('tp') + ' take-profit');
    if (n('review')) parts.push(n('review') + ' review');
    if (n('sell')) parts.push(n('sell') + ' SELL');
    const title = 'CSP: ' + parts.join(', ');
    const body = fresh.map(function (it) { return it.text; }).join('\n\n');
    const r = sendPhoneAlert_(cfg, title, body, n('tp') > 0);
    if (!r.ok) {
      logToSheet_('CSP alert failed: ' + r.detail);
      return { sent: 0, note: 'send failed (' + r.detail + ')' };
    }
    fresh.forEach(function (it) { state[it.key] = nowMs; });
    Object.keys(state).forEach(function (k) { if (nowMs - state[k] > 14 * 86400000) delete state[k]; });
    props.setProperty('CSP_ALERT_STATE', JSON.stringify(state));
    return { sent: fresh.length, note: 'sent ' + fresh.length + ' (' + parts.join(', ') + ')' };
  } catch (e) {
    logToSheet_('CSP alert error: ' + e);
    return { sent: 0, note: 'error: ' + e };
  }
}

function sendTestCspAlert_() {
  const ui = tryGetUi_();
  const cfg = getAlertConfig_();
  if (!cfg.ready) { notify_(ui, 'CSP alert test', 'Phone alerts are not set up or are off. Use Options Validator > Phone Alerts first (same Telegram setup serves Quick and CSP).'); return; }
  const r = sendPhoneAlert_(cfg, 'CSP: test', 'Test alert from the CSP tab. A real one looks like:\nSELL KO Nov 20 $70P @ 0.95 (35d, 14.2% ann, delta 0.22, cushion 0.9 sigma, cash $7000). Buy back <= 0.71 (25%) or 0.48 (50%). Score 71', false);
  notify_(ui, 'CSP alert test', r.ok ? 'Sent. ' + r.detail : 'Failed: ' + r.detail);
}

function toggleCspAlerts_() {
  const ui = tryGetUi_();
  const props = PropertiesService.getScriptProperties();
  const nowOn = cspAlertsOn_();
  props.setProperty('CSP_ALERTS', nowOn ? 'false' : 'true');
  notify_(ui, 'CSP alerts', 'CSP alerts are now ' + (nowOn ? 'OFF' : 'ON') + '. (Quick alerts are unaffected.)');
}


/* ============================================================================
 * SCHEDULE — hourly trigger; the tick exits at once outside US market hours.
 *   every tick: open puts (cheap)      every ~3h: full proposal scan
 *   first tick of the day: research promotion
 * ========================================================================== */

const CSP_TICK_FN = 'cspScheduledTick_';

function cspEtParts_(now) {
  const tz = 'America/New_York';
  return {
    dow: parseInt(Utilities.formatDate(now, tz, 'u'), 10),      // 1 = Monday ... 7 = Sunday
    hhmm: Utilities.formatDate(now, tz, 'HH:mm'),
    ymd: Utilities.formatDate(now, tz, 'yyyy-MM-dd')
  };
}

function cspWithinMarketHours_(now) {
  const p = cspEtParts_(now);
  return p.dow >= 1 && p.dow <= 5 && p.hhmm >= CSP_CONFIG.schedule.startHHmm && p.hhmm <= CSP_CONFIG.schedule.endHHmm;
}

function cspRemoveTriggers_() {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === CSP_TICK_FN) { ScriptApp.deleteTrigger(t); n++; }
  });
  return n;
}

function startCspSchedule_() {
  const ui = tryGetUi_();
  cspRemoveTriggers_();
  ScriptApp.newTrigger(CSP_TICK_FN).timeBased().everyHours(1).create();
  notify_(ui, 'CSP schedule started',
    'Runs hourly. Outside Mon-Fri ' + CSP_CONFIG.schedule.startHHmm + '-' + CSP_CONFIG.schedule.endHHmm + ' ET it exits immediately.\n' +
    'Each tick checks your open puts; every ' + CSP_CONFIG.schedule.fullScanEveryHours + ' hours it re-scans proposals; the first tick of the day runs research promotion.\n' +
    'Telegram alerts go through the Quick phone-alert setup.');
}

function stopCspSchedule_() {
  const ui = tryGetUi_();
  notify_(ui, 'CSP schedule', 'Stopped (' + cspRemoveTriggers_() + ' trigger(s) removed).');
}

function cspScheduleStatus_() {
  const ui = tryGetUi_();
  const props = PropertiesService.getScriptProperties();
  const n = ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === CSP_TICK_FN; }).length;
  const lastFull = parseInt(props.getProperty('CSP_LAST_FULL') || '0', 10);
  const cfg = getAlertConfig_();
  notify_(ui, 'CSP schedule status',
    'Schedule: ' + (n ? 'ON (' + n + ' trigger)' : 'OFF') + '\n' +
    'Last full scan: ' + (lastFull ? new Date(lastFull).toString() : 'never') + '\n' +
    'Last research promotion: ' + (props.getProperty('CSP_LAST_PROMOTE') || 'never') + '\n' +
    'CSP alerts: ' + (cspAlertsOn_() ? 'ON' : 'OFF') + '; phone provider ' + (cfg.ready ? 'ready (' + cfg.provider + ')' : 'NOT ready'));
}

function cspScheduledTick_() {
  const now = new Date();
  const p = cspEtParts_(now);
  if (p.dow < 1 || p.dow > 5) return;
  const props = PropertiesService.getScriptProperties();
  const running = parseInt(props.getProperty('CSP_RUNNING') || '0', 10);
  if (running && Date.now() - running < 10 * 60000) return;      // a run is already in progress

  const promoteDone = props.getProperty('CSP_LAST_PROMOTE') === p.ymd;
  const inMarket = cspWithinMarketHours_(now);
  const runPromote = function (budgetMs) {
    props.setProperty('CSP_RUNNING', String(Date.now()));
    try {
      const pr = cspPromoteFromResearch_({ quiet: true, timeBudgetMs: budgetMs });
      if (pr && pr.complete) props.setProperty('CSP_LAST_PROMOTE', p.ymd);
    } catch (e) { logToSheet_('CSP promote error: ' + e); }
    props.deleteProperty('CSP_RUNNING');
  };

  if (!inMarket) {
    // Research promotion runs BEFORE the open (06:00 to market start) so it never competes with Quick/Leap during the day.
    if (!promoteDone && p.hhmm >= '06:00' && p.hhmm < CSP_CONFIG.schedule.startHHmm) runPromote(250000);
    return;
  }

  const t0 = Date.now();
  if (!promoteDone) runPromote(110000);        // fallback: schedule started after the pre-market window
  const lastFull = parseInt(props.getProperty('CSP_LAST_FULL') || '0', 10);
  const full = !lastFull || Date.now() - lastFull >= CSP_CONFIG.schedule.fullScanEveryHours * 3600000 - 5 * 60000;
  const remaining = Math.max(60000, 280000 - (Date.now() - t0));
  const r = runCspScan(remaining, false, { quiet: true, onlyOpen: !full });
  if (full && r && !r.timedOut) props.setProperty('CSP_LAST_FULL', String(Date.now()));
}


/* ============================================================================
 * RESEARCH PROMOTION — which quality names deserve a row on this tab
 * ----------------------------------------------------------------------------
 * Moat cannot be read off a data feed. This scores the standard quantitative
 * PROXIES for one (sustained high returns on equity, high margins, free cash
 * flow, low leverage), plus a 5-year record, size and trend. It will miss
 * brand/network-effect judgment and can be fooled by buybacks (return on equity)
 * or by one good year. Use it to build the shortlist, not to replace your view.
 *
 * Stock score (100): ROE 10, operating margin 10, gross margin 10, FCF margin 10,
 *   debt/equity 10, current ratio 5, revenue growth 5, earnings growth 5,
 *   5y CAGR 15, 5y worst drawdown 10, size 10. Missing inputs get half credit
 *   (banks have no gross margin), never a zero.
 * ETF score (100): 5y CAGR 35, 5y worst drawdown 25, trend 20, closeness to the
 *   52-week high 10, curated-list membership 10.
 * Hard gates: history of about 5 years, positive 5y return, not >5% under the
 *   200-day, not >30% under the 52-week high; stocks also need cap >= $50B,
 *   positive profit and free cash flow.
 * ========================================================================== */

function cspLin_(v, zero, full) {
  if (v == null || isNaN(v)) return 0.5;
  return cspClamp01_((v - zero) / (full - zero));
}

function cspQualityStock_(f, w, tech, cfg) {
  const P = cfg.promote;
  const fails = [];
  const parts = {};
  const fcfMargin = (f && f.fcf != null && f.rev) ? f.fcf / f.rev * 100 : null;
  parts.roe = 10 * cspLin_(f && f.roe != null ? f.roe * 100 : null, 5, 15);
  parts.opm = 10 * cspLin_(f && f.opm != null ? f.opm * 100 : null, 8, 20);
  parts.gm = 10 * cspLin_(f && f.gm != null ? f.gm * 100 : null, 20, 40);
  parts.fcf = 10 * cspLin_(fcfMargin, 2, 10);
  parts.de = 10 * cspLin_(f && f.de != null ? -f.de : null, -250, -100);
  parts.cr = 5 * cspLin_(f && f.cr != null ? f.cr : null, 0.6, 1.2);
  parts.rg = 5 * cspLin_(f && f.rg != null ? f.rg * 100 : null, -2, 6);
  parts.eg = 5 * cspLin_(f && f.eg != null ? f.eg * 100 : null, -5, 8);
  parts.cagr = 15 * cspLin_(w ? w.cagr : null, 0, 12);
  parts.dd = 10 * cspLin_(w ? -w.dd : null, -55, -25);
  const capB = f ? f.capB : null;
  parts.size = capB == null ? 5 : (capB >= 200 ? 10 : (capB >= 100 ? 8 : (capB >= P.minCapB ? 5 : 0)));
  let score = 0;
  Object.keys(parts).forEach(function (k) { score += parts[k]; });
  score = Math.round(score * 10) / 10;

  if (!f) fails.push('no fundamentals from Yahoo');
  if (f && capB != null && capB < P.minCapB) fails.push('market cap $' + Math.round(capB) + 'B < $' + P.minCapB + 'B');
  if (f && f.pm != null && f.pm <= 0) fails.push('not profitable');
  if (f && f.fcf != null && f.fcf <= 0) fails.push('negative free cash flow');
  cspTrackGates_(w, tech, cfg, fails);
  return { score: score, fails: fails, parts: parts };
}

function cspQualityEtf_(w, tech, cfg) {
  const fails = [];
  const parts = {};
  const vs200 = tech && tech.ma200 ? (tech.price / tech.ma200 - 1) * 100 : null;
  const vs50 = tech && tech.ma50 ? (tech.price / tech.ma50 - 1) * 100 : null;
  const offHigh = tech && tech.hi52 ? (1 - tech.price / tech.hi52) * 100 : null;
  parts.cagr = 35 * cspLin_(w ? w.cagr : null, 2, 12);
  parts.dd = 25 * cspLin_(w ? -w.dd : null, -45, -15);
  parts.trend = (vs200 == null ? 6 : (vs200 >= 0 ? 12 : 12 * cspLin_(vs200, -8, 0))) + (vs50 == null ? 4 : (vs50 >= 0 ? 8 : 8 * cspLin_(vs50, -6, 0)));
  parts.high = 10 * cspLin_(offHigh == null ? null : -offHigh, -15, -3);
  parts.member = 10;
  let score = 0;
  Object.keys(parts).forEach(function (k) { score += parts[k]; });
  cspTrackGates_(w, tech, cfg, fails);
  return { score: Math.round(score * 10) / 10, fails: fails, parts: parts };
}

function cspTrackGates_(w, tech, cfg, fails) {
  const P = cfg.promote;
  if (!w) fails.push('no 5-year price history');
  else {
    if (w.years < P.minHistoryYears) fails.push('only ' + (Math.round(w.years * 10) / 10) + ' years of history');
    if (w.cagr <= 0) fails.push('5-year return not positive');
  }
  if (!tech) fails.push('no daily price history');
  else {
    const vs200 = tech.ma200 ? (tech.price / tech.ma200 - 1) * 100 : null;
    const offHigh = tech.hi52 ? (1 - tech.price / tech.hi52) * 100 : null;
    if (vs200 != null && vs200 < -cfg.maxBelow200Pct) fails.push('under the 200-day by ' + (Math.round(-vs200 * 10) / 10) + '%');
    if (offHigh != null && offHigh > cfg.maxDrawdownPct) fails.push((Math.round(offHigh * 10) / 10) + '% under the 52-week high');
  }
}

function cspFetchFundamentals_(ticker) {
  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';
  const path = '/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=financialData,price&formatted=false&lang=en-US&region=US';
  const tryUrl = function (url, headers) {
    try {
      const r = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: headers });
      if (r.getResponseCode() !== 200) return null;
      const j = JSON.parse(r.getContentText());
      return (j.quoteSummary && j.quoteSummary.result && j.quoteSummary.result[0]) || null;
    } catch (e) { return null; }
  };
  const hdr = { 'User-Agent': ua, Accept: 'application/json' };
  let res = tryUrl('https://query1.finance.yahoo.com' + path, hdr) || tryUrl('https://query2.finance.yahoo.com' + path, hdr);
  if (!res) {
    try {
      const sess = getYahooSession_();
      res = tryUrl('https://query2.finance.yahoo.com' + path + '&crumb=' + encodeURIComponent(sess.crumb), { 'User-Agent': sess.ua, Cookie: sess.cookie, Accept: 'application/json' });
    } catch (e) { /* no session: leave null */ }
  }
  if (!res) return null;
  const fd = res.financialData || {};
  const g = function (v) { const x = getRawYahooValue_(v); return (x == null || isNaN(x)) ? null : x; };
  const cap = res.price ? g(res.price.marketCap) : null;
  return {
    roe: g(fd.returnOnEquity), opm: g(fd.operatingMargins), gm: g(fd.grossMargins), pm: g(fd.profitMargins),
    fcf: g(fd.freeCashflow), rev: g(fd.totalRevenue), de: g(fd.debtToEquity), cr: g(fd.currentRatio),
    rg: g(fd.revenueGrowth), eg: g(fd.earningsGrowth), capB: cap != null ? cap / 1e9 : null
  };
}

// 5 years of WEEKLY adjusted closes -> CAGR, worst drawdown, years of history. (Weekly: a deeper intraweek dip is not seen.)
function cspFetchWeekly5y_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=5y&interval=1wk',
    'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=5y&interval=1wk'
  ];
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], { method: 'get', muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' } });
      if (resp.getResponseCode() !== 200) continue;
      const result = JSON.parse(resp.getContentText()).chart.result[0];
      const ts = result.timestamp;
      const ind = result.indicators;
      const adj = ind.adjclose && ind.adjclose[0] && ind.adjclose[0].adjclose;
      const closes = adj || (ind.quote && ind.quote[0] && ind.quote[0].close);
      if (!ts || !closes) continue;
      const pts = [];
      for (let k = 0; k < ts.length; k++) if (isPlausible_(closes[k], 0.01, null)) pts.push({ t: ts[k], c: closes[k] });
      if (pts.length < 50) continue;
      const years = (pts[pts.length - 1].t - pts[0].t) / (365.25 * 86400);
      const cagr = (Math.pow(pts[pts.length - 1].c / pts[0].c, 1 / years) - 1) * 100;
      let peak = pts[0].c, dd = 0;
      pts.forEach(function (p) { if (p.c > peak) peak = p.c; const d = (1 - p.c / peak) * 100; if (d > dd) dd = d; });
      return { cagr: cagr, dd: dd, years: years, n: pts.length };
    } catch (e) { Logger.log('CSP weekly 5y error for ' + ticker + ': ' + e); }
  }
  return null;
}

function cspEvaluateTicker_(t, isEtf, ctx) {
  const tech = cspFetchTech_(t, ctx);
  const wRes = getSlowCached_(ctx.slowCache, ctx.pending, 'CSPW5', t, 7, function () { return cspFetchWeekly5y_(t); });
  if (wRes.fetchAttempted) Utilities.sleep(CSP_CONFIG.sleepMs);
  let f = null;
  if (!isEtf) {
    const fRes = getSlowCached_(ctx.slowCache, ctx.pending, 'CSPFUND', t, 14, function () { return cspFetchFundamentals_(t); });
    if (fRes.fetchAttempted) Utilities.sleep(CSP_CONFIG.sleepMs);
    f = fRes.value;
  }
  const q = isEtf ? cspQualityEtf_(wRes.value, tech, CSP_CONFIG) : cspQualityStock_(f, wRes.value, tech, CSP_CONFIG);
  const price = tech ? tech.price : null;
  q.ticker = t; q.isEtf = isEtf; q.price = price;
  q.minScore = isEtf ? CSP_CONFIG.promote.minEtfScore : CSP_CONFIG.promote.minStockScore;
  q.qualifies = q.fails.length === 0 && q.score >= q.minScore;
  return q;
}

function runCspPromote() { return cspPromoteFromResearch_({}); }
function runCspPromoteDryRun() { return cspPromoteFromResearch_({ dryRun: true }); }

// Wipes every ScriptLog row below the header (same behaviour as the Daily Pipeline start). Never throws.
function cspClearScriptLog_() {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCRIPT_LOG_SHEET_NAME);
    if (!sheet) return;
    const lastRow = sheet.getLastRow();
    if (lastRow < 2) return;
    if (sheet.getMaxRows() <= lastRow) sheet.insertRowAfter(lastRow);
    sheet.deleteRows(2, lastRow - 1);
  } catch (e) { Logger.log('cspClearScriptLog_ failed: ' + e); }
}

// Research + promote pipeline wrapper: logs STARTED / STOPPED / COMPLETE / FAILED to ScriptLog.
// A fresh pipeline (not a continuation of a run that stopped at the time limit) first wipes the old ScriptLog rows.
function cspPromoteFromResearch_(opts) {
  opts = opts || {};
  const props = PropertiesService.getScriptProperties();
  const src = opts.quiet ? 'scheduled' : 'manual';
  const t0 = Date.now();
  let cont = false;
  if (opts.dryRun) {
    logToSheet_('CSP research+promote (dry run, nothing will be written): started');
  } else {
    cont = props.getProperty('CSP_PROMO_OPEN') === '1';
    if (!cont) cspClearScriptLog_();
    props.setProperty('CSP_PROMO_OPEN', '1');
    logToSheet_('CSP research+promote ' + (cont ? 'CONTINUING after an unfinished run' : 'STARTED') + ' (' + src + ')');
  }
  let res;
  try {
    res = cspPromoteCore_(opts);
  } catch (e) {
    logToSheet_('CSP research+promote FAILED: ' + (e && e.message ? e.message : e) + ' (the next run continues from cached scores)');
    throw e;
  }
  const sec = Math.round((Date.now() - t0) / 1000);
  if (res && res.complete) {
    if (!opts.dryRun) props.deleteProperty('CSP_PROMO_OPEN');
    logToSheet_('CSP research+promote COMPLETE in ' + sec + 's: ' + res.chosen.length + ' names qualify; added ' +
      (res.added.length ? res.added.join(', ') : 'none') + '; removed ' + (res.removed.length ? res.removed.join(', ') : 'none'));
  } else {
    logToSheet_('CSP research+promote NOT COMPLETE after ' + sec + 's' +
      (res && res.total ? ': ' + res.scored + ' of ' + res.total + ' tickers scored, sheet unchanged. ' : '. ') +
      'The next run continues from cached scores (scheduled runs retry automatically; or run Promote Research Picks again).');
  }
  return res;
}

function cspPromoteCore_(opts) {
  opts = opts || {};
  const ui = opts.quiet ? null : tryGetUi_();
  const P = CSP_CONFIG.promote;
  const start = Date.now();
  const budgetMs = opts.timeBudgetMs || P.timeBudgetMs;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CSP_SHEET_NAME);
  if (!sheet) { notify_(ui, 'CSP promote', 'No CSP tab. Run setupCsp once from the Apps Script editor.'); return { complete: false }; }
  const map = cspEnsureHeaders_(sheet);
  const width = sheet.getLastColumn();
  const lastRow = sheet.getLastRow();
  const data = lastRow >= 2 ? sheet.getRange(2, 1, lastRow - 1, width).getValues() : [];
  const bgs = lastRow >= 2 ? sheet.getRange(2, map['Ticker'], lastRow - 1, 1).getBackgrounds() : [];

  const onSheet = {};
  const sheetRows = [];
  data.forEach(function (r, i) {
    const t = String(r[map['Ticker'] - 1] || '').trim().toUpperCase();
    if (!t) return;
    const type = String(r[map['Type'] - 1] || '').trim().toUpperCase();
    const row = {
      idx: i, ticker: t, source: String(r[map['Source'] - 1] || '').trim(), type: type,
      isEtf: type === 'ETF' || !!CSP_ETF_SET[t],
      hasOpen: parseFloat(r[map['Open Qty'] - 1]) > 0,
      colored: !!(bgs[i] && bgs[i][0] && bgs[i][0] !== '#ffffff')
    };
    onSheet[t] = row; sheetRows.push(row);
  });

  const universe = {};
  CSP_STOCK_UNIVERSE.forEach(function (t) { universe[t] = { isEtf: false }; });
  CSP_ETF_UNIVERSE.forEach(function (t) { universe[t] = { isEtf: true }; });
  sheetRows.forEach(function (rw) { if (!universe[rw.ticker]) universe[rw.ticker] = { isEtf: rw.isEtf }; });

  const slowCache = cspLoadCache_();
  const pending = {};
  const ctx = { slowCache: slowCache, pending: pending };
  const evals = {};
  const names = Object.keys(universe);
  let complete = true;
  for (let i = 0; i < names.length; i++) {
    if (Date.now() - start > budgetMs) { complete = false; break; }
    const t = names[i];
    try { evals[t] = cspEvaluateTicker_(t, universe[t].isEtf, ctx); }
    catch (e) { evals[t] = { ticker: t, isEtf: universe[t].isEtf, score: 0, fails: ['error: ' + e], qualifies: false, parts: {} }; }
  }
  cspFlushCache_(pending);
  if (!complete) {
    notify_(ui, 'CSP promote', 'Stopped at the time limit after ' + Object.keys(evals).length + ' of ' + names.length + ' tickers. Nothing was changed on the sheet. Run again: finished tickers are cached, so the next pass is fast.');
    return { complete: false, scored: Object.keys(evals).length, total: names.length };
  }

  // ----- rank -----
  const rank = function (isEtf, maxN) {
    const pool = Object.keys(evals).map(function (t) { return evals[t]; })
      .filter(function (q) { return q.isEtf === isEtf && q.qualifies; });
    const ok = pool.sort(function (a, b) { return b.score - a.score; }).slice(0, maxN);
    return { chosen: ok };
  };
  const rs = rank(false, P.maxStocks), re = rank(true, P.maxEtfs);
  const chosen = {};
  rs.chosen.concat(re.chosen).forEach(function (q) { chosen[q.ticker] = q; });

  // ----- sheet changes -----
  const props = PropertiesService.getScriptProperties();
  let misses = {};
  try { misses = JSON.parse(props.getProperty('CSP_PROMO_MISS') || '{}'); } catch (e) { misses = {}; }

  const toAdd = Object.keys(chosen).filter(function (t) { return !onSheet[t]; });
  const toRemove = [];
  const keptWithPut = [];
  sheetRows.forEach(function (rw) {
    if (rw.source !== 'Research') return;
    if (chosen[rw.ticker]) { misses[rw.ticker] = 0; return; }
    misses[rw.ticker] = (misses[rw.ticker] || 0) + 1;
    if (misses[rw.ticker] >= P.removeAfterMisses) {
      if (rw.hasOpen || rw.colored) keptWithPut.push(rw.ticker); else toRemove.push(rw);
    }
  });

  if (!opts.dryRun) {
    // Quality column for every row we scored
    if (map['Quality'] && data.length) {
      const col = data.map(function (r) { return [r[map['Quality'] - 1]]; });
      sheetRows.forEach(function (rw) { const q = evals[rw.ticker]; if (q) col[rw.idx][0] = q.score; });
      sheet.getRange(2, map['Quality'], col.length, 1).setValues(col);
    }
    // Remove retired Research rows, bottom-up
    toRemove.sort(function (a, b) { return b.idx - a.idx; }).forEach(function (rw) { sheet.deleteRow(rw.idx + 2); delete misses[rw.ticker]; });
    // Append new rows after the last ticker row (bottom-up deletes above never move this anchor wrongly: recompute)
    if (toAdd.length) {
      const tickCol = sheet.getRange(2, map['Ticker'], Math.max(sheet.getMaxRows() - 1, 1), 1).getValues();
      let lastTicker = 1;
      for (let i = tickCol.length - 1; i >= 0; i--) { if (String(tickCol[i][0]).trim() !== '') { lastTicker = i + 2; break; } }
      const w2 = sheet.getLastColumn();
      const out = toAdd.map(function (t) {
        const q = chosen[t];
        const row = new Array(w2).fill('');
        row[map['Ticker'] - 1] = t; row[map['Moat'] - 1] = 'Y'; row[map['Source'] - 1] = 'Research';
        row[map['Type'] - 1] = q.isEtf ? 'ETF' : 'Stock'; row[map['Quality'] - 1] = q.score;
        return row;
      });
      const need = lastTicker + out.length - sheet.getMaxRows();
      if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
      sheet.getRange(lastTicker + 1, 1, out.length, w2).setValues(out);
      cspFormatSheet_(sheet);
    }
    props.setProperty('CSP_PROMO_MISS', JSON.stringify(misses));
  }

  // ----- summary -----
  const failCounts = {};
  Object.keys(evals).forEach(function (t) {
    const q = evals[t];
    if (q.qualifies) return;
    if (q.fails.length) q.fails.forEach(function (f) { const k = f.replace(/[0-9.]+/g, '#'); failCounts[k] = (failCounts[k] || 0) + 1; });
    else failCounts['score under the bar'] = (failCounts['score under the bar'] || 0) + 1;
  });
  const topFails = Object.keys(failCounts).sort(function (a, b) { return failCounts[b] - failCounts[a]; }).slice(0, 5)
    .map(function (k) { return k + ' (' + failCounts[k] + ')'; }).join('; ');
  const msg =
    (opts.dryRun ? '(DRY RUN: nothing written)\n' : '') +
    'Scored ' + names.length + ' tickers in ' + Math.round((Date.now() - start) / 1000) + 's.\n' +
    'Qualified and kept: ' + rs.chosen.length + ' stocks (max ' + P.maxStocks + '), ' + re.chosen.length + ' ETFs (max ' + P.maxEtfs + ').\n' +
    'Added: ' + (toAdd.length ? toAdd.join(', ') : 'none') + '\n' +
    'Removed (out of the list ' + P.removeAfterMisses + '+ runs): ' + (toRemove.length ? toRemove.map(function (r) { return r.ticker; }).join(', ') : 'none') + '\n' +
    (keptWithPut.length ? 'Kept despite dropping out (open put or colored cell): ' + keptWithPut.join(', ') + '\n' : '') +
    (topFails ? 'Most common reasons for rejection: ' + topFails : '');
  notify_(ui, 'CSP research promotion', msg);
  return { complete: true, added: toAdd, removed: toRemove.map(function (r) { return r.ticker; }), chosen: Object.keys(chosen) };
}

function debugCspQuality() {
  const ui = tryGetUi_();
  if (!ui) return;
  const r = ui.prompt('CSP quality', 'Ticker (e.g. KO or SPY):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const t = r.getResponseText().trim().toUpperCase();
  if (!t) return;
  const slowCache = cspLoadCache_();
  const pending = {};
  const ctx = { slowCache: slowCache, pending: pending };
  const isEtf = !!CSP_ETF_SET[t];
  const q = cspEvaluateTicker_(t, isEtf, ctx);
  cspFlushCache_(pending);
  const f = !isEtf ? (slowCache[slowKey_('CSPFUND', t)] || {}).value : null;
  const w = (slowCache[slowKey_('CSPW5', t)] || {}).value;
  const lines = [
    t + (isEtf ? ' (ETF)' : '') + ': score ' + q.score + ' (needs ' + q.minScore + '), ' + (q.qualifies ? 'QUALIFIES' : 'does not qualify'),
    q.fails.length ? 'Fails: ' + q.fails.join('; ') : 'No hard-gate failures.',
    'Parts: ' + Object.keys(q.parts).map(function (k) { return k + ' ' + (Math.round(q.parts[k] * 10) / 10); }).join(', '),
    w ? '5y: CAGR ' + round2_(w.cagr) + '%, worst weekly drawdown ' + round2_(w.dd) + '%, history ' + round2_(w.years) + 'y' : '5y data: none',
    f ? 'Fundamentals: ' + JSON.stringify(f) : (isEtf ? '' : 'Fundamentals: none returned by Yahoo')
  ].filter(Boolean);
  ui.alert('CSP quality: ' + t, lines.join('\n').substring(0, 5000), ui.ButtonSet.OK);
}