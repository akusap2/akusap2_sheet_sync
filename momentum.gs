/**
 * ============================================================================
 * OPTIONS PORTFOLIO VALIDATOR
 * ============================================================================
 *
 * PATCH NOTE (this version)
 * ----------------------------------------------------------------------------
 * CHANGE: "🎯 Scan Chain by Delta / OI" now reads its settings from the
 * "Input" tab instead of auto-creating/reading a separate "Momentum Scanner
 * Settings" sheet.
 *
 * The Input tab holds one labeled block per data sheet (Quick/Leap/Risky/
 * etc.), keyed by a subheading in column A that matches the sheet name:
 *
 *   Quick
 *   Type        C
 *   Delta       0.7
 *   MinExpiry   180
 *   MaxExpiry   60
 *   MinStrike   70.00
 *
 * Whichever sheet you're on when you run "Scan Chain by Delta / OI" (or
 * "Run Deep Dive Scan" in BestOpenInterest.gs), that sheet's block is used.
 * getInputConfigForSheet_() and INPUT_SHEET_NAME — the lookup function and
 * the "Input" sheet name constant — are defined ONCE, in BestOpenInterest.gs,
 * and reused here (Apps Script shares top-level functions/vars across every
 * .gs file in the same project, so this file doesn't redefine them).
 *
 * getOrCreateChainScannerSettingsSheet_() and the "Momentum Scanner Settings"
 * auto-create/backfill logic have been removed entirely — a missing/invalid
 * Input-tab block now surfaces as a clear alert instead of a new sheet being
 * silently created with defaults. readChainScannerSettings_() takes the
 * active sheet's name and throws with a specific, actionable message if
 * that sheet has no matching block or a required field is missing.
 *
 * EVERYTHING ELSE IN THIS FILE (Sector Momentum fix from the prior version,
 * all other columns/scores/etc.) IS UNCHANGED.
 * ============================================================================
 */


/* ============================================================================
 * HEADER MAP
 * ========================================================================== */

const HEADER_MAP = {
  ticker: ['Ticker'],
  strike: ['Strike'],
  expiry: ['Expiry'],
  optionPrice: ['Price'],
  volume: ['Volume', 'Vol.', 'Vol'],
  // NOTE: "Current IV" (contract-level implied volatility) is intentionally
  // NOT a display column anymore, but merged.iv is still fetched and used
  // internally for the Delta/Gamma Black-Scholes estimates and the Balance
  // Score's IV-suitability factor — removing the column doesn't remove the
  // dependency, it just stops writing a cell for it.
  ivRank: ['IV Rank', 'IV Percentile', 'IV Rank/Percentile'],
  atrPercent: ['ATR%', 'ATR', 'ATR %', 'Average True Range %'],
  oi: ['OI'],
  // stockPrice is READ (for internal math) but no longer WRITTEN — see
  // TRACKED_FIELDS below and the "STOCK PRICE" section in validateAndUpdate.
  // You're expected to have your own =GOOGLEFINANCE(ticker,"price") formula
  // in this column; the script reads whatever it shows.
  stockPrice: ['StockPrice', 'Current Stock Price', 'Current'],
  greekDelta: ['Delta'],
  gamma: ['Gamma'],
  bidAskSpread: ['Slippage', 'Bid/Ask Spread', 'Bid-Ask Spread', 'Spread %', 'Spread'],
  extrinsicValue: ['Extra', 'Extrinsic', 'Extrinsic Value', 'Time Value', 'Extrinsic $'],
  analystTarget: ['Analyst', 'Analyst Target', 'Analyst Target Price', 'Target Price', 'Price Target'],
  // NOTE: "Next Catalyst" and "Catalyst Date" are likewise not display
  // columns anymore. The underlying earnings-calendar fetch itself still
  // runs, because Days to Catalyst below and the Balance Score's
  // catalyst-risk factor both depend on it.
  daysToExpiry: ['Days', 'Days to Expiry', 'DTE'],
  daysToCatalyst: ['Catalyst', 'Days to Catalyst', 'Days to Next Catalyst', 'DTC'],
  // changeNow (%age) is back to being script-written (TastyTrade/Yahoo)
  // as of this fix — GOOGLEFINANCE proved too stale (~15-20min delay).
  // changeValue (Value) is new: the companion dollar-amount change,
  // sourced from the same fetch (fetchChangeDataForTicker_) at no extra
  // cost.
  changeNow: ['%age', 'Change Now', 'Change', '% Change'],
  changeValue: ['Value'],
  relativeStrength: ['RS vs SPY', 'Relative Strength', 'RS'],
  sectorMomentum: ['Sector Momentum', 'Sector'],
  riskScore: ['Risk', 'Risk Score'],
  filterScore: ['Quick', 'Filter', 'Trade Setup Score', 'Filter Score'],
  themeCluster: ['Theme / Cluster', 'Theme/Cluster', 'Theme', 'Cluster'],
  // Added for the "Quick" sheet's objective-based Target/Risk/Filter logic
  // (see the "QUICK" SHEET section further down) — optional everywhere
  // else; a sheet with no matching header simply never populates these.
  entryDate: ['Entry Date', 'Date Entered', 'Entered', 'Open Date', 'Date Opened'],
  entryPrice: ['Entry Price', 'Entry', 'Cost Basis', 'Price Paid'],
  target: ['Target', 'Exit Target', 'Target Stock Price', 'Stock Target'],
  // NEW: Score — weighted blend of Filter, Target Probability, and
  // (100 - Risk). See SCORE_WEIGHTS_BY_SHEET / computeCombinedScore_
  // further down for the per-sheet weights and math. Add a header cell
  // literally named "Score" on the Quick/Risky/Leap tabs to enable this.
  score: ['Score'],
  // Read-only lookup — this script never writes PtN, only uses it to know
  // which column to apply a standout background to. See
  // applyStandoutColumnHighlights_ further down.
  ptN: ['PtN', 'Pt N']
};

// Validation Status is now fully optional — the script uses it if the
// column already exists, but no longer auto-creates it if missing (you
// said you don't need it). writeStatus_ already guards on map.status
// being set, so simply not detecting/creating the column is enough.
const STATUS_HEADER = 'Validation Status';
const TIMESTAMP_HEADER = 'LastRun';
const HEADER_ROW = 1;
const DATA_START_ROW = 2;
const REQUEST_DELAY_MS = 300;
// Wall-clock budget for one run of validateAndUpdate() or
// scanOptionChainForBestOi(). Google's own hard ceiling on a single Apps
// Script execution is ~6 minutes for a normal account (longer for some
// Workspace plans) — that's a platform limit this script can't raise.
// What it CAN do is stop itself cleanly well before that hard cutoff,
// with an honest status and a clear "run again to continue" message,
// instead of letting Google kill the run mid-write with no summary.
// 5 minutes leaves a 1-minute safety margin under the ~6-minute ceiling.
const EXECUTION_TIME_BUDGET_MS = 5 * 60 * 1000;


/* ============================================================================
 * COLORS
 * ----------------------------------------------------------------------------
 * Philosophy: color only ever marks the specific cell it describes, never
 * a whole row. Sign-based signals (Change Now, Sector Momentum, RS vs SPY)
 * are FONT COLOR ONLY — green/red text on that one number, no background
 * fill, so they read as data, not paint. Risk/Filter keep their 3-tier
 * background bands (low/med/high) since those bands ARE the signal for
 * those two columns specifically. On top of all of that, the 5 rows with
 * the highest Filter Score this run get a single consistent border color
 * around exactly the 6 columns you cross-reference for a candidate trade —
 * see applyTopFilterHighlight_ near the bottom of validateAndUpdate().
 * ========================================================================== */

const COLOR_FONT_POSITIVE = '#006100';
const COLOR_FONT_NEGATIVE = '#9c0006';

// Risk column background bands — low/moderate/high risk. Reused for the
// Filter column too (inverted: high Filter score = good = green).
const COLOR_RISK_LOW = '#d9ead3';
const COLOR_RISK_MED = '#fff2cc';
const COLOR_RISK_HIGH = '#f4cccc';

// Shared "higher is better" 3-band color — same thresholds and colors
// Filter itself uses (>=70 good/green, >=40 fair/yellow, else poor/red).
// Reused by Score and Target so their fill matches Filter's visual language.
function higherIsBetterBandColor_(value) {
  return value >= 70 ? COLOR_RISK_LOW : (value >= 40 ? COLOR_RISK_MED : COLOR_RISK_HIGH);
}

// Target column highlight — marks a row where Target was computed from a
// REAL Entry Price (an active position), vs. left plain for a candidate
// row's hypothetical target. See the TARGET write block in
// validateAndUpdate.
const COLOR_TARGET_ACTIVE_HIGHLIGHT = '#ffff00';

// Top-5-by-Filter-Score highlight — a single thick border color applied
// only to the handful of columns you actually read together (Filter,
// Risk, Sector Momentum, Change Now, ATR%, IV Rank) for only the 5
// highest Filter Score rows this run. See TOP_FILTER_COUNT and
// applyTopFilterHighlight_ below.
const COLOR_TOP_FILTER_BORDER = '#b45f06';
const TOP_FILTER_COUNT = 5;
// NEW: 'score' added so the top-5 highlight also frames the Score cell
// itself whenever ranking is done by Score (Quick/Risky/Leap) instead of
// Filter Score (any other sheet).
const TOP_FILTER_HIGHLIGHT_COLS = ['filterScore', 'riskScore', 'score', 'sectorMomentum', 'changeNow', 'atrPercent', 'ivRank', 'daysToCatalyst'];

// (NEGATIVE_NUMBER_RULE_ROWS/COLS and the letter-based sign rule that used
// them were retired — see FONT COLOR POLICY further down for what
// replaced it: resetNeutralColumnFontColor_ / FONT_COLOR_EXEMPT_KEYS.)


/* ============================================================================
 * BALANCE SCORE — DAY/SWING SCREENER WEIGHTS
 * ========================================================================== */

// All three sheets (Quick, Leap, Risky) now use the same Filter/Risk/
// Target architecture, each with its own per-sheet weighted formula (see
// "QUICK & RISKY — REVISED FORMULAS" and "LEAP — REVISED FORMULAS"
// further down) — so nothing is skipped by sheet anymore. Kept as a
// function (rather than inlining `true`) in case a future sheet needs a
// real exception again.
function getScoreRelevanceForSheet_(sheetName) {
  return {
    needsFilterScore: true,
    needsRiskScore: true
  };
}

// How many calendar days out counts as "inside your holding window" for
// the catalyst-risk factor below. Tune this to how long you actually
// expect to hold a trade-bucket row (default: a same-day-to-few-days swing).
const SWING_WINDOW_DAYS = 5;

// Trading-day lookback for "Momentum / Relative Strength" — the ticker's
// own N-day return vs SPY's N-day return over the same window. 5 trading
// days (roughly a week) matches a same-day-to-few-days swing horizon
// better than a single day's move, without going so long it starts
// reflecting a totally different holding period than the one you trade.
const RS_LOOKBACK_DAYS = 5;

// The Risk column's thresholds — directly from your stated objective:
// look to be out with a 20% profit if it comes same-day/few-days, willing
// to tolerate up to a 50% loss on the premium if it doesn't. Change these
// if your actual targets change; nothing else needs updating.
const RISK_PROFIT_TARGET_PERCENT = 20;
const RISK_LOSS_TOLERANCE_PERCENT = 50;

// Leap bucket's own thresholds — a completely different exit philosophy
// from the swing/put side: long-dated, high-delta, stock-replacement
// hold, out at +50% or -10% on the premium (not the swing side's 20%/50%).
// Reused directly as Leap's TRADE_OBJECTIVE_SHEETS config below.
const LEAP_PROFIT_TARGET_PERCENT = 50;
const LEAP_LOSS_TOLERANCE_PERCENT = 10;


/* ============================================================================
 * SECTOR -> SPDR ETF DISPLAY MAP
 * ========================================================================== */

const SECTOR_ETF_MAP = {
  'Technology': 'XLK',
  'Financial Services': 'XLF',
  'Financials': 'XLF',
  'Healthcare': 'XLV',
  'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP',
  'Industrials': 'XLI',
  'Energy': 'XLE',
  'Utilities': 'XLU',
  'Real Estate': 'XLRE',
  'Communication Services': 'XLC',
  'Basic Materials': 'XLB'
};

// Sector Momentum's ETF % change genuinely doesn't need refreshing on
// every single run — 45 minutes (the midpoint of a reasonable 30-60 min
// window) is plenty for a sector-level move. CacheService (not the SLOW_
// day-granularity cache above) is the right tool here since it expires
// itself in seconds with no cleanup needed.
const SECTOR_MOMENTUM_CACHE_SECONDS = 45 * 60;


/* ============================================================================
 * GOOGLE FINANCE HELPER SHEET
 * ----------------------------------------------------------------------------
 * A small hidden sheet with one row per ticker/sector-ETF, each holding a
 * live =GOOGLEFINANCE(...) formula for Price and Change %. Sheets keeps
 * these current on its own background schedule — no script network call
 * involved — so this script just reads whatever's already there.
 *
 * Priority for stock price / today's % change / sector ETF % change:
 *   1. TastyTrade (real-time broker data, when credentials are configured)
 *   2. This helper sheet (free, ~15-20min delayed, no crumb/cookie issues)
 *   3. The existing Yahoo/FMP fetch functions (last resort — e.g. right
 *      after a brand-new ticker is added, before Sheets has calculated
 *      its formula yet)
 *
 * New symbols get a formula row appended (never overwritten, so existing
 * rows keep whatever value Sheets already calculated for them); nothing
 * is ever synchronously fetched by the script itself.
 * ========================================================================== */

const GF_SHEET_NAME = 'GF Data (auto-managed)';
const GF_HEADER_ROW = 1;
const GF_DATA_START_ROW = 2;

function getOrCreateGfHelperSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(GF_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(GF_SHEET_NAME);
    sheet.getRange(GF_HEADER_ROW, 1, 1, 3).setValues([['Symbol', 'Price (GOOGLEFINANCE)', 'Change % (GOOGLEFINANCE)']]);
    sheet.setFrozenRows(1);
    try { sheet.hideSheet(); } catch (e) { /* fine if it can't hide (e.g. only sheet) */ }
  }
  return sheet;
}

// Collects every symbol this run could want a Google Finance quote for.
// As of the StockPrice/%age columns becoming your own in-row GOOGLEFINANCE
// formulas, this is ONLY the sector ETFs now (Sector Momentum still needs
// them every run) — individual tickers no longer go through this helper
// sheet at all. Running "Clean Unused Google Finance Rows" after this
// change will naturally purge any leftover per-ticker rows from before.
function collectNeededGfSymbols_(sheet, map, lastRow) {
  const needed = {};
  Object.keys(SECTOR_ETF_MAP).forEach(function (sectorName) {
    needed[SECTOR_ETF_MAP[sectorName]] = true;
  });
  return needed;
}

// Appends a formula row for any symbol not already present. Existing rows
// are never touched, so their already-calculated values aren't disturbed.
// Returns how many rows were added.
function ensureGfSymbolRows_(gfSheet, symbols) {
  const lastRow = gfSheet.getLastRow();
  const existingSet = {};
  if (lastRow >= GF_DATA_START_ROW) {
    gfSheet.getRange(GF_DATA_START_ROW, 1, lastRow - GF_DATA_START_ROW + 1, 1).getValues().forEach(function (r) {
      const s = String(r[0]).trim().toUpperCase();
      if (s) existingSet[s] = true;
    });
  }

  const missing = symbols.filter(function (s) {
    const sym = String(s).trim().toUpperCase();
    return sym && !existingSet[sym];
  });
  if (!missing.length) return 0;

  const startRow = lastRow + 1;
  const rows = missing.map(function (sym, i) {
    const r = startRow + i;
    return [sym, '=GOOGLEFINANCE(A' + r + ',"price")', '=GOOGLEFINANCE(A' + r + ',"changepct")'];
  });
  gfSheet.getRange(startRow, 1, rows.length, 3).setValues(rows);
  return rows.length;
}

// Reads the whole helper sheet in ONE call into { SYMBOL: { price, changePercent } }.
// A formula that hasn't calculated yet (brand-new row) or errors out
// (#N/A — ticker not covered) just yields nulls here, which the calling
// code treats the same as "no Google Finance data" and falls through to
// the existing Yahoo/FMP fetch for that one symbol this run.
function readGfDataMap_(gfSheet) {
  const lastRow = gfSheet.getLastRow();
  const map = {};
  if (lastRow < GF_DATA_START_ROW) return map;

  const values = gfSheet.getRange(GF_DATA_START_ROW, 1, lastRow - GF_DATA_START_ROW + 1, 3).getValues();
  values.forEach(function (row) {
    const symbol = String(row[0]).trim().toUpperCase();
    if (!symbol) return;
    const priceRaw = parseFloat(row[1]);
    const changeRaw = parseFloat(row[2]);
    map[symbol] = {
      price: isPlausible_(priceRaw, 0.01, null) ? priceRaw : null,
      // GOOGLEFINANCE's "changepct" returns the percent value directly
      // (e.g. 1.25 for +1.25%), matching how changePercent is used
      // everywhere else in this script — no /100 or *100 conversion.
      changePercent: isNaN(changeRaw) ? null : changeRaw
    };
  });
  return map;
}

function cleanGfHelperSheetMenuAction_() {
  const ui = SpreadsheetApp.getUi();
  const dataSheet = SpreadsheetApp.getActiveSheet();
  const map = getColumnMap_(dataSheet);
  if (!map.ticker) { ui.alert('No Ticker column found on the active sheet.'); return; }

  const neededSymbols = collectNeededGfSymbols_(dataSheet, map, dataSheet.getLastRow());
  const gfSheet = getOrCreateGfHelperSheet_();
  const gfLastRow = gfSheet.getLastRow();
  if (gfLastRow < GF_DATA_START_ROW) { ui.alert('Nothing to clean — the Google Finance helper sheet is empty.'); return; }

  const existing = gfSheet.getRange(GF_DATA_START_ROW, 1, gfLastRow - GF_DATA_START_ROW + 1, 1).getValues();
  const rowsToDelete = [];
  existing.forEach(function (r, i) {
    const sym = String(r[0]).trim().toUpperCase();
    if (sym && !neededSymbols[sym]) rowsToDelete.push(GF_DATA_START_ROW + i);
  });

  // Delete bottom-up so earlier row numbers don't shift mid-deletion.
  rowsToDelete.sort(function (a, b) { return b - a; }).forEach(function (r) { gfSheet.deleteRow(r); });

  ui.alert(
    rowsToDelete.length
      ? ('Removed ' + rowsToDelete.length + ' unused symbol row(s) — everything still on the active sheet (plus all sector ETFs) was left alone.')
      : 'Nothing to remove — every row in the helper sheet is still in use.'
  );
}


/* ============================================================================
 * CHAIN SCANNER — "Scan Chain by Delta / OI"
 * ----------------------------------------------------------------------------
 * Given a minimum delta and a minimum expiry (days), scans a ticker's full
 * option chain — every strike, across the nearest few qualifying
 * expirations — and picks the single contract with the highest open
 * interest among everything that clears both floors. Overwrites that row's
 * Strike/Expiry with the result, so Omega (and everything downstream of
 * it — Risk, Filter, Target Feasibility) is computed from a real, chosen
 * contract instead of an arbitrary placeholder.
 *
 * Settings live on the "Input" tab (see getInputConfigForSheet_, defined in
 * BestOpenInterest.gs), in a block keyed by the active sheet's name:
 *   Type      = "C" or "P"
 *   Delta     = Min Delta (e.g. 0.65) — every candidate's estimated |delta|
 *               must be at or above this
 *   MinExpiry = Min Expiry in days (e.g. 21) — expirations sooner than this
 *               are never considered
 *   MaxExpiry = Max Expiry in days — ONLY used when Type = P. Leave blank
 *               for no ceiling. Ignored entirely when Type = C.
 *   MinStrike = Strike floor/ceiling as a % of price — floor for calls,
 *               ceiling for puts. Leave blank/0 for no bound.
 *
 * If the active sheet has no matching block in "Input" (or a required
 * field is missing/non-numeric), readChainScannerSettings_ throws with a
 * specific message naming the sheet and the missing field(s) — callers
 * catch this and show it via notify_/ui.alert rather than silently
 * creating a settings sheet.
 *
 * Delta here is ESTIMATED (Black-Scholes, using each contract's own
 * implied volatility from Yahoo's chain) rather than a broker Greek —
 * Yahoo's option-chain endpoint doesn't return real delta. Same estimate
 * this script already falls back to elsewhere when TastyTrade isn't
 * configured or doesn't have a broker quote for that specific contract.
 * ========================================================================== */

const CHAIN_SCANNER_DEFAULT_MIN_DELTA = 0.6;
const CHAIN_SCANNER_DEFAULT_MIN_EXPIRY_DAYS = 21;
const CHAIN_SCANNER_DEFAULT_TYPE = 'C';
// 0 = no floor/ceiling by default. Meaning depends on type: for calls
// it's a strike FLOOR (% of price), for puts it's a strike CEILING (%
// above price).
const CHAIN_SCANNER_DEFAULT_MIN_STRIKE_PERCENT = 0;
// How many of the nearest qualifying expirations to actually pull the full
// chain for, per ticker. Each one is a network call, so this bounds how
// long one scanOptionChainForBestOi() run takes — keeps a normal watchlist well
// inside Apps Script's execution time limit.
const CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN = 6;

/* ============================================================================
 * TRIGGER SAFETY — SpreadsheetApp.getUi() throws when called from a
 * time-driven trigger (no user session to show a dialog to). These
 * helpers let scanOptionChainForBestOi() and validateAndUpdate() run
 * either interactively (menu click — real dialogs) or headlessly
 * (scheduled trigger — logged to the "Log" tab instead), using the exact
 * same code path either way.
 * ========================================================================== */

function tryGetUi_() {
  try { return SpreadsheetApp.getUi(); } catch (e) { return null; }
}

// Appends a timestamped line to your existing "Log" tab (creates one if
// it doesn't exist). This is where scheduled-run summaries/errors land
// instead of a dialog box nobody's there to see.
// Diagnostic messages land in "ScriptLog" — deliberately NOT "Log", since
// that name is already used by TradeExecutor.gs's trade-order tracking
// sheet (Time/Ticker/Expiry/Strike/Order Type/Stop Loss/Filled Price/etc).
// Every diagnostic message this project has ever logged (scheduled-run
// summaries, headless Validate & Update / Hedge results, Mobile Remote
// errors) was silently appending into that trade sheet's columns A/B
// before this fix — worth a one-time check of that sheet for any stray
// diagnostic rows mixed into real trade data.
const SCRIPT_LOG_SHEET_NAME = 'ScriptLog';

function logToSheet_(message) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let logSheet = ss.getSheetByName(SCRIPT_LOG_SHEET_NAME);
    if (!logSheet) {
      logSheet = ss.insertSheet(SCRIPT_LOG_SHEET_NAME);
      logSheet.getRange(1, 1, 1, 2).setValues([['Time', 'Message']]);
      logSheet.setFrozenRows(1);
    }
    logSheet.appendRow([new Date(), message]);
  } catch (e) {
    Logger.log('logToSheet_ failed: ' + e);
  }
}

// Drop-in replacement for ui.alert(title, message) that degrades to a
// Log-tab entry when there's no UI (scheduled trigger) instead of
// throwing.
function notify_(ui, title, message) {
  if (ui) {
    ui.alert(title, message, ui.ButtonSet.OK);
  } else {
    logToSheet_(title + ': ' + message);
  }
}

// Drop-in replacement for a ui.alert(..., YES_NO) confirmation gate.
// Interactively, asks and returns the real answer. Headlessly (no ui),
// there's no one to ask — auto-proceeds (returns true) and logs that it
// did, since silently doing nothing would defeat the point of a
// scheduled run; a genuinely broken sheet still gets caught by the hard
// "missing required column" checks elsewhere, which still bail out.
function confirmOrProceed_(ui, title, message) {
  if (ui) {
    return ui.alert(title, message, ui.ButtonSet.YES_NO) === ui.Button.YES;
  }
  logToSheet_(title + ' (auto-continued, no UI): ' + message);
  return true;
}

// Reads Chain Scanner settings for the given sheet name from the "Input"
// tab, via getInputConfigForSheet_ (defined in BestOpenInterest.gs — a
// global function, reused here rather than duplicated). Throws with a
// specific message if "Input" is missing, has no block matching
// sheetName, or a required field is missing/non-numeric — callers should
// catch this and show it via notify_/ui.alert.
function readChainScannerSettings_(sheetName) {
  const config = getInputConfigForSheet_(sheetName); // throws on missing/invalid block

  const typeRaw = String(config.type || '').trim().toUpperCase();
  const type = typeRaw === 'P' ? 'P' : 'C';

  const minDeltaRaw = parseFloat(config.delta);
  const minExpiryRaw = parseFloat(config.minExpiry);
  // Accepts "50", "50%", or 0.5 in the cell — strip a trailing % and
  // parse whatever's left as a plain number of percentage points.
  const minStrikePctRaw = parseFloat(String(config.minStrike == null ? '' : config.minStrike).replace('%', '').trim());
  const maxExpiryRaw = parseFloat(config.maxExpiry);

  return {
    minDelta: isPlausible_(minDeltaRaw, 0, 1) ? minDeltaRaw : CHAIN_SCANNER_DEFAULT_MIN_DELTA,
    minExpiryDays: isPlausible_(minExpiryRaw, 0, null) ? minExpiryRaw : CHAIN_SCANNER_DEFAULT_MIN_EXPIRY_DAYS,
    // MaxExpiry only applies to puts — blank/invalid, or type=C, both
    // mean "no ceiling" (null). See findBestOiFromTastyChain_ /
    // ...Yahoo... for where this is applied.
    maxExpiryDays: (type === 'P' && isPlausible_(maxExpiryRaw, 0, null)) ? maxExpiryRaw : null,
    type: type,
    // For calls: a FLOOR, strike >= price * (minStrikePercent/100).
    // For puts: a CEILING, strike <= price * (1 + minStrikePercent/100).
    // Same field, different meaning depending on type — see the
    // strike-filter logic in findBestOiFromTastyChain_ / ...Yahoo....
    minStrikePercent: isPlausible_(minStrikePctRaw, 0, null) ? minStrikePctRaw : CHAIN_SCANNER_DEFAULT_MIN_STRIKE_PERCENT
  };
}


/* ============================================================================
 * STATIC SECTOR/INDUSTRY TABLE — zero-cost, zero-cap classification for
 * common large caps.
 *
 * Sector/industry classification for an established company essentially
 * never changes day to day (GICS reclassifications happen maybe once every
 * few years, if that). Hardcoding the common ones means Theme/Cluster and
 * Sector Momentum resolve for these tickers with NO network call at all —
 * not "cached for 30 days", genuinely zero API usage, so there's nothing
 * here to ever hit a cap on.
 *
 * This is a best-effort approximate GICS-style classification, not a
 * certified data feed — if you disagree with one, "Set Sector/Industry
 * Override" (menu) always takes priority over this table and never
 * expires. Anything NOT in this table falls through to the live sources
 * below (Yahoo -> Finnhub -> FMP) as before.
 * ========================================================================== */

const STATIC_SECTOR_MAP = {
  // Technology
  AAPL: { sector: 'Technology', industry: 'Consumer Electronics' },
  MSFT: { sector: 'Technology', industry: 'Software—Infrastructure' },
  NVDA: { sector: 'Technology', industry: 'Semiconductors' },
  AVGO: { sector: 'Technology', industry: 'Semiconductors' },
  ORCL: { sector: 'Technology', industry: 'Software—Infrastructure' },
  CRM: { sector: 'Technology', industry: 'Software—Application' },
  ADBE: { sector: 'Technology', industry: 'Software—Application' },
  AMD: { sector: 'Technology', industry: 'Semiconductors' },
  INTC: { sector: 'Technology', industry: 'Semiconductors' },
  QCOM: { sector: 'Technology', industry: 'Semiconductors' },
  TXN: { sector: 'Technology', industry: 'Semiconductors' },
  MU: { sector: 'Technology', industry: 'Semiconductors' },
  AMAT: { sector: 'Technology', industry: 'Semiconductor Equipment & Materials' },
  LRCX: { sector: 'Technology', industry: 'Semiconductor Equipment & Materials' },
  KLAC: { sector: 'Technology', industry: 'Semiconductor Equipment & Materials' },
  CSCO: { sector: 'Technology', industry: 'Communication Equipment' },
  IBM: { sector: 'Technology', industry: 'IT Services' },
  ACN: { sector: 'Technology', industry: 'IT Services' },
  NOW: { sector: 'Technology', industry: 'Software—Application' },
  PANW: { sector: 'Technology', industry: 'Software—Infrastructure' },
  CRWD: { sector: 'Technology', industry: 'Software—Infrastructure' },
  SNOW: { sector: 'Technology', industry: 'Software—Application' },
  PLTR: { sector: 'Technology', industry: 'Software—Infrastructure' },
  APP: { sector: 'Technology', industry: 'Software—Application' },
  DELL: { sector: 'Technology', industry: 'Computer Hardware' },
  HPQ: { sector: 'Technology', industry: 'Computer Hardware' },
  SHOP: { sector: 'Technology', industry: 'Software—Application' },

  // Communication Services
  GOOGL: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  GOOG: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  META: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  NFLX: { sector: 'Communication Services', industry: 'Entertainment' },
  DIS: { sector: 'Communication Services', industry: 'Entertainment' },
  CMCSA: { sector: 'Communication Services', industry: 'Telecom Services' },
  T: { sector: 'Communication Services', industry: 'Telecom Services' },
  VZ: { sector: 'Communication Services', industry: 'Telecom Services' },
  TMUS: { sector: 'Communication Services', industry: 'Telecom Services' },

  // Consumer Cyclical
  AMZN: { sector: 'Consumer Cyclical', industry: 'Internet Retail' },
  TSLA: { sector: 'Consumer Cyclical', industry: 'Auto Manufacturers' },
  HD: { sector: 'Consumer Cyclical', industry: 'Home Improvement Retail' },
  LOW: { sector: 'Consumer Cyclical', industry: 'Home Improvement Retail' },
  NKE: { sector: 'Consumer Cyclical', industry: 'Footwear & Accessories' },
  MCD: { sector: 'Consumer Cyclical', industry: 'Restaurants' },
  SBUX: { sector: 'Consumer Cyclical', industry: 'Restaurants' },
  BKNG: { sector: 'Consumer Cyclical', industry: 'Travel Services' },

  // Consumer Defensive
  WMT: { sector: 'Consumer Defensive', industry: 'Discount Stores' },
  COST: { sector: 'Consumer Defensive', industry: 'Discount Stores' },
  PG: { sector: 'Consumer Defensive', industry: 'Household & Personal Products' },
  KO: { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic' },
  PEP: { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic' },
  CL: { sector: 'Consumer Defensive', industry: 'Household & Personal Products' },

  // Financial Services
  JPM: { sector: 'Financial Services', industry: 'Banks—Diversified' },
  BAC: { sector: 'Financial Services', industry: 'Banks—Diversified' },
  WFC: { sector: 'Financial Services', industry: 'Banks—Diversified' },
  GS: { sector: 'Financial Services', industry: 'Capital Markets' },
  MS: { sector: 'Financial Services', industry: 'Capital Markets' },
  V: { sector: 'Financial Services', industry: 'Credit Services' },
  MA: { sector: 'Financial Services', industry: 'Credit Services' },
  AXP: { sector: 'Financial Services', industry: 'Credit Services' },
  BLK: { sector: 'Financial Services', industry: 'Asset Management' },
  SCHW: { sector: 'Financial Services', industry: 'Capital Markets' },

  // Healthcare
  UNH: { sector: 'Healthcare', industry: 'Healthcare Plans' },
  JNJ: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  LLY: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  PFE: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  ABBV: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  MRK: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  TMO: { sector: 'Healthcare', industry: 'Diagnostics & Research' },
  ABT: { sector: 'Healthcare', industry: 'Medical Devices' },
  ISRG: { sector: 'Healthcare', industry: 'Medical Devices' },
  GILD: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  VRTX: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  REGN: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  BIIB: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  MRNA: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  AMGN: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  BMY: { sector: 'Healthcare', industry: 'Drug Manufacturers—General' },
  ZTS: { sector: 'Healthcare', industry: 'Drug Manufacturers—Specialty & Generic' },
  DXCM: { sector: 'Healthcare', industry: 'Medical Devices' },
  EW: { sector: 'Healthcare', industry: 'Medical Devices' },
  SYK: { sector: 'Healthcare', industry: 'Medical Devices' },
  BSX: { sector: 'Healthcare', industry: 'Medical Devices' },
  MDT: { sector: 'Healthcare', industry: 'Medical Devices' },
  DHR: { sector: 'Healthcare', industry: 'Diagnostics & Research' },
  CVS: { sector: 'Healthcare', industry: 'Healthcare Plans' },
  HUM: { sector: 'Healthcare', industry: 'Healthcare Plans' },
  ELV: { sector: 'Healthcare', industry: 'Healthcare Plans' },
  CNC: { sector: 'Healthcare', industry: 'Healthcare Plans' },

  // Energy
  XOM: { sector: 'Energy', industry: 'Oil & Gas Integrated' },
  CVX: { sector: 'Energy', industry: 'Oil & Gas Integrated' },
  COP: { sector: 'Energy', industry: 'Oil & Gas E&P' },
  SLB: { sector: 'Energy', industry: 'Oil & Gas Equipment & Services' },
  EOG: { sector: 'Energy', industry: 'Oil & Gas E&P' },
  DVN: { sector: 'Energy', industry: 'Oil & Gas E&P' },
  FANG: { sector: 'Energy', industry: 'Oil & Gas E&P' },
  OXY: { sector: 'Energy', industry: 'Oil & Gas E&P' },
  KMI: { sector: 'Energy', industry: 'Oil & Gas Midstream' },
  WMB: { sector: 'Energy', industry: 'Oil & Gas Midstream' },
  VLO: { sector: 'Energy', industry: 'Oil & Gas Refining & Marketing' },
  PSX: { sector: 'Energy', industry: 'Oil & Gas Refining & Marketing' },
  MPC: { sector: 'Energy', industry: 'Oil & Gas Refining & Marketing' },
  HAL: { sector: 'Energy', industry: 'Oil & Gas Equipment & Services' },
  ENPH: { sector: 'Energy', industry: 'Solar' },
  FSLR: { sector: 'Energy', industry: 'Solar' },
  RUN: { sector: 'Energy', industry: 'Solar' },

  // Industrials
  BA: { sector: 'Industrials', industry: 'Aerospace & Defense' },
  CAT: { sector: 'Industrials', industry: 'Farm & Heavy Construction Machinery' },
  GE: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },
  UNP: { sector: 'Industrials', industry: 'Railroads' },
  HON: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },
  UBER: { sector: 'Industrials', industry: 'Ground Transportation' },
  VRT: { sector: 'Industrials', industry: 'Electrical Equipment & Parts' },
  LMT: { sector: 'Industrials', industry: 'Aerospace & Defense' },
  LYFT: { sector: 'Industrials', industry: 'Ground Transportation' },
  DAL: { sector: 'Industrials', industry: 'Airlines' },
  UAL: { sector: 'Industrials', industry: 'Airlines' },
  AAL: { sector: 'Industrials', industry: 'Airlines' },
  LUV: { sector: 'Industrials', industry: 'Airlines' },
  RTX: { sector: 'Industrials', industry: 'Aerospace & Defense' },
  NOC: { sector: 'Industrials', industry: 'Aerospace & Defense' },
  GD: { sector: 'Industrials', industry: 'Aerospace & Defense' },
  DE: { sector: 'Industrials', industry: 'Farm & Heavy Construction Machinery' },
  MMM: { sector: 'Industrials', industry: 'Conglomerates' },
  EMR: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },
  ETN: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },
  ITW: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },
  PH: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },
  ROK: { sector: 'Industrials', industry: 'Specialty Industrial Machinery' },

  // Utilities
  CEG: { sector: 'Utilities', industry: 'Utilities—Diversified' },
  NEE: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  DUK: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  SO: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  D: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  AEP: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  EXC: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  XEL: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  ED: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },
  PEG: { sector: 'Utilities', industry: 'Utilities—Regulated Electric' },

  // Real Estate
  PLD: { sector: 'Real Estate', industry: 'REIT—Industrial' },
  AMT: { sector: 'Real Estate', industry: 'REIT—Specialty' },
  EQIX: { sector: 'Real Estate', industry: 'REIT—Specialty' },
  PSA: { sector: 'Real Estate', industry: 'REIT—Industrial' },
  O: { sector: 'Real Estate', industry: 'REIT—Retail' },
  SPG: { sector: 'Real Estate', industry: 'REIT—Retail' },
  WELL: { sector: 'Real Estate', industry: 'REIT—Healthcare Facilities' },
  VICI: { sector: 'Real Estate', industry: 'REIT—Specialty' },
  DLR: { sector: 'Real Estate', industry: 'REIT—Specialty' },
  CCI: { sector: 'Real Estate', industry: 'REIT—Specialty' },

  // Basic Materials
  LIN: { sector: 'Basic Materials', industry: 'Specialty Chemicals' },
  FCX: { sector: 'Basic Materials', industry: 'Copper' },
  NEM: { sector: 'Basic Materials', industry: 'Gold' },
  GOLD: { sector: 'Basic Materials', industry: 'Gold' },
  ALB: { sector: 'Basic Materials', industry: 'Specialty Chemicals' },
  DOW: { sector: 'Basic Materials', industry: 'Chemicals' },
  DD: { sector: 'Basic Materials', industry: 'Specialty Chemicals' },
  SHW: { sector: 'Basic Materials', industry: 'Specialty Chemicals' },
  APD: { sector: 'Basic Materials', industry: 'Specialty Chemicals' },

  // Technology — additions from the Research universe (same "sector doesn't
  // change daily" reasoning as the rest of this map: these now resolve
  // for free instead of costing a live Yahoo/Finnhub/FMP call the first
  // time each one is touched)
  NET: { sector: 'Technology', industry: 'Software—Infrastructure' },
  DDOG: { sector: 'Technology', industry: 'Software—Application' },
  MDB: { sector: 'Technology', industry: 'Software—Application' },
  ZS: { sector: 'Technology', industry: 'Software—Infrastructure' },
  OKTA: { sector: 'Technology', industry: 'Software—Infrastructure' },
  TEAM: { sector: 'Technology', industry: 'Software—Application' },
  WDAY: { sector: 'Technology', industry: 'Software—Application' },
  ADSK: { sector: 'Technology', industry: 'Software—Application' },
  INTU: { sector: 'Technology', industry: 'Software—Application' },
  FTNT: { sector: 'Technology', industry: 'Software—Infrastructure' },
  ANET: { sector: 'Technology', industry: 'Communication Equipment' },
  MRVL: { sector: 'Technology', industry: 'Semiconductors' },
  ON: { sector: 'Technology', industry: 'Semiconductors' },
  SWKS: { sector: 'Technology', industry: 'Semiconductors' },
  QRVO: { sector: 'Technology', industry: 'Semiconductors' },
  MCHP: { sector: 'Technology', industry: 'Semiconductors' },
  NXPI: { sector: 'Technology', industry: 'Semiconductors' },
  TER: { sector: 'Technology', industry: 'Semiconductor Equipment & Materials' },
  ENTG: { sector: 'Technology', industry: 'Semiconductor Equipment & Materials' },
  LSCC: { sector: 'Technology', industry: 'Semiconductors' },

  // Communication Services — additions
  PINS: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  SNAP: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  ROKU: { sector: 'Communication Services', industry: 'Entertainment' },
  TTD: { sector: 'Communication Services', industry: 'Advertising Agencies' },
  SPOT: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  MTCH: { sector: 'Communication Services', industry: 'Internet Content & Information' },
  BMBL: { sector: 'Communication Services', industry: 'Internet Content & Information' },

  // Consumer Cyclical — additions
  ABNB: { sector: 'Consumer Cyclical', industry: 'Travel Services' },
  DASH: { sector: 'Consumer Cyclical', industry: 'Internet Retail' },
  RBLX: { sector: 'Communication Services', industry: 'Electronic Gaming & Multimedia' },
  DKNG: { sector: 'Consumer Cyclical', industry: 'Gambling' },
  PENN: { sector: 'Consumer Cyclical', industry: 'Gambling' },
  MGM: { sector: 'Consumer Cyclical', industry: 'Resorts & Casinos' },
  WYNN: { sector: 'Consumer Cyclical', industry: 'Resorts & Casinos' },
  LVS: { sector: 'Consumer Cyclical', industry: 'Resorts & Casinos' },
  RCL: { sector: 'Consumer Cyclical', industry: 'Travel Services' },
  CCL: { sector: 'Consumer Cyclical', industry: 'Travel Services' },
  NCLH: { sector: 'Consumer Cyclical', industry: 'Travel Services' },
  F: { sector: 'Consumer Cyclical', industry: 'Auto Manufacturers' },
  GM: { sector: 'Consumer Cyclical', industry: 'Auto Manufacturers' },

  // Consumer Defensive — additions
  MDLZ: { sector: 'Consumer Defensive', industry: 'Confectioners' },
  KHC: { sector: 'Consumer Defensive', industry: 'Packaged Foods' },
  GIS: { sector: 'Consumer Defensive', industry: 'Packaged Foods' },
  HSY: { sector: 'Consumer Defensive', industry: 'Confectioners' },
  STZ: { sector: 'Consumer Defensive', industry: 'Beverages—Wineries & Distilleries' },
  MNST: { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic' },
  KDP: { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic' },
  CLX: { sector: 'Consumer Defensive', industry: 'Household & Personal Products' },
  CHD: { sector: 'Consumer Defensive', industry: 'Household & Personal Products' },

  // Financial Services — additions
  C: { sector: 'Financial Services', industry: 'Banks—Diversified' },
  USB: { sector: 'Financial Services', industry: 'Banks—Regional' },
  PNC: { sector: 'Financial Services', industry: 'Banks—Regional' },
  TFC: { sector: 'Financial Services', industry: 'Banks—Regional' },
  COF: { sector: 'Financial Services', industry: 'Credit Services' },
  SYF: { sector: 'Financial Services', industry: 'Credit Services' },
  PYPL: { sector: 'Financial Services', industry: 'Credit Services' },
  SOFI: { sector: 'Financial Services', industry: 'Credit Services' },

  // Insurance — new sector coverage
  PGR: { sector: 'Financial Services', industry: 'Insurance—Property & Casualty' },
  TRV: { sector: 'Financial Services', industry: 'Insurance—Property & Casualty' },
  ALL: { sector: 'Financial Services', industry: 'Insurance—Property & Casualty' },
  MET: { sector: 'Financial Services', industry: 'Insurance—Life' },
  PRU: { sector: 'Financial Services', industry: 'Insurance—Life' },
  AIG: { sector: 'Financial Services', industry: 'Insurance—Diversified' },

  // Additional large-cap coverage gaps
  PM: { sector: 'Consumer Defensive', industry: 'Tobacco' },
  MO: { sector: 'Consumer Defensive', industry: 'Tobacco' },
  TGT: { sector: 'Consumer Cyclical', industry: 'Discount Stores' },
  TJX: { sector: 'Consumer Cyclical', industry: 'Apparel Retail' },
  CMG: { sector: 'Consumer Cyclical', industry: 'Restaurants' },
  YUM: { sector: 'Consumer Cyclical', industry: 'Restaurants' },
  CI: { sector: 'Healthcare', industry: 'Healthcare Plans' },
  ADI: { sector: 'Technology', industry: 'Semiconductors' },
  CDNS: { sector: 'Technology', industry: 'Software—Application' },
  SNPS: { sector: 'Technology', industry: 'Software—Application' },
  ARM: { sector: 'Technology', industry: 'Semiconductors' },

  // Additional mid-cap growth/momentum names (mainly for Risky)
  CELH: { sector: 'Consumer Defensive', industry: 'Beverages—Non-Alcoholic' },
  SMCI: { sector: 'Technology', industry: 'Computer Hardware' },
  U: { sector: 'Technology', industry: 'Software—Application' },
  PATH: { sector: 'Technology', industry: 'Software—Application' },
  IOT: { sector: 'Technology', industry: 'Software—Application' }
};

// Finnhub's free /stock/profile2 endpoint only returns a single granular
// "industry" field (e.g. "Semiconductors"), not a broad GICS sector — this
// translates the common ones into the broad sector names SECTOR_ETF_MAP
// already knows, so a Finnhub-sourced classification can still drive
// Sector Momentum's ETF lookup. Anything not listed here still populates
// Theme/Cluster fine; Sector Momentum just has no ETF match for that one
// row (same "Other — N/A" as before, but now the rare case, not the norm).
const FINNHUB_INDUSTRY_TO_SECTOR = {
  'Semiconductors': 'Technology',
  'Software': 'Technology',
  'Computer Hardware': 'Technology',
  'Communications': 'Technology',
  'IT Services': 'Technology',
  'Internet': 'Communication Services',
  'Media': 'Communication Services',
  'Telecommunications': 'Communication Services',
  'Retail': 'Consumer Cyclical',
  'Auto Manufacturers': 'Consumer Cyclical',
  'Hotels, Restaurants & Leisure': 'Consumer Cyclical',
  'Beverages': 'Consumer Defensive',
  'Food Products': 'Consumer Defensive',
  'Packaged Foods': 'Consumer Defensive',
  'Banking': 'Financial Services',
  'Insurance': 'Financial Services',
  'Financial Services': 'Financial Services',
  'Asset Management': 'Financial Services',
  'Pharmaceuticals': 'Healthcare',
  'Biotechnology': 'Healthcare',
  'Health Care': 'Healthcare',
  'Medical Devices & Instruments': 'Healthcare',
  'Oil & Gas': 'Energy',
  'Energy': 'Energy',
  'Aerospace & Defense': 'Industrials',
  'Industrial Conglomerates': 'Industrials',
  'Transportation': 'Industrials',
  'Machinery': 'Industrials',
  'Utilities': 'Utilities',
  'Real Estate': 'Real Estate',
  'REITs': 'Real Estate',
  'Chemicals': 'Basic Materials',
  'Metals & Mining': 'Basic Materials'
};


/* ============================================================================
 * DELTA FALLBACK (Black-Scholes estimate) — unchanged
 * ========================================================================== */

const RISK_FREE_RATE = 0.045;


/* ============================================================================
 * SLOW-CHANGING DATA CACHE — refresh windows, in days
 * ========================================================================== */

const SLOW_REFRESH_DAYS = {
  ANALYST: 7,
  THEME: 30,
  QUALITY: 14,
  CATALYST: 3,
  // Daily OHLC bars (ATR% today; RSI/20 EMA/relative-strength-vs-SPY if
  // added later) only need refreshing once a day — today's bar isn't
  // final until the close, and yesterday's never changes.
  DAILYBARS: 1
};


/* ============================================================================
 * FINNHUB / FMP
 * ========================================================================== */

const FINNHUB_BASE_URL = 'https://finnhub.io/api/v1';
const FINNHUB_MAX_RETRIES = 4;
const FINNHUB_RETRY_BASE_DELAY_MS = 1500;
const FMP_BASE_URL = 'https://financialmodelingprep.com/api/v3';


/* ============================================================================
 * TRACKED FIELDS
 * ========================================================================== */

// stockPrice is intentionally NOT in here — still read from your own
// GOOGLEFINANCE formula (see HEADER_MAP), not written by this script.
// changeNow/changeValue ARE back in here (script-written again) — see
// fetchChangeDataForTicker_.
const TRACKED_FIELDS = {
  optionPrice: 'Price',
  volume: 'Volume',
  ivRank: 'IV Rank',
  atrPercent: 'ATR%',
  oi: 'OI',
  greekDelta: 'Delta',
  gamma: 'Gamma',
  bidAskSpread: 'Slippage',
  extrinsicValue: 'Extra',
  analystTarget: 'Analyst',
  daysToExpiry: 'Days',
  daysToCatalyst: 'Catalyst',
  changeNow: '%age',
  changeValue: 'Value',
  relativeStrength: 'RS vs SPY',
  sectorMomentum: 'Sector Momentum',
  riskScore: 'Risk',
  filterScore: 'Filter',
  themeCluster: 'Theme / Cluster'
};


/* ============================================================================
 * MENU
 * ========================================================================== */

/* ============================================================================
 * SCHEDULED RUNS
 * ----------------------------------------------------------------------------
 * Apps Script time-driven triggers don't support "every 2 hours, but only
 * between 9:05am and 4:30pm" directly — the closest native option is a
 * fixed everyHours(N)/everyMinutes(N) cadence with no window. So instead:
 * ONE lightweight trigger (scheduledDispatcher_) fires every 5 minutes,
 * all day, and does almost nothing on 99% of those firings — it just
 * checks the current America/New_York time against your exact target
 * time lists below, and only does real work (scan or validate) on an
 * exact match. This gives you precise 9:05/11:05/1:05/3:05 and
 * 10:00-4:00-every-30-min scheduling without needing separate triggers
 * per slot, and correctly handles EST/EDT since 'America/New_York' is a
 * real timezone, not a fixed UTC offset.
 *
 * Runs BOTH "Momentum" and "Play" tabs, one after another, in a single
 * trigger firing. To stay safely under Google's own ~6-minute ceiling on
 * one trigger execution, each tab gets a SHORTER time budget than a
 * manual run would (SCHEDULED_PER_TAB_BUDGET_MS below) — if a tab's
 * queue is too long to finish in that window, it stops cleanly (same
 * "resume next time" behavior as a manual run) rather than risking both
 * tabs together blowing the platform limit.
 *
 * Dedup: a slot is identified by "yyyy-MM-dd HH:mm" and only ever runs
 * once — if the checker fires more than once near the same target time
 * (jitter), the second firing sees it already ran and skips. Uses two
 * fixed Script Properties (not one per slot/day), so this never
 * accumulates unbounded storage over time.
 *
 * Summaries land in the "Log" tab (see logToSheet_) instead of a dialog,
 * since there's no one there to see a popup.
 * ========================================================================== */

const SCHEDULED_SCAN_TIMES = ['09:05', '11:05', '13:05', '15:05'];
const SCHEDULED_VALIDATE_TIMES = [
  '10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00',
  '13:30', '14:00', '14:30', '15:00', '15:30', '16:00'
];
const SCHEDULED_TABS = ['Momentum', 'Play'];
const SCHEDULED_PER_TAB_BUDGET_MS = 2.5 * 60 * 1000; // 2.5 min/tab — 2 tabs = 5 min, under the ~6-min trigger ceiling
const SCHEDULED_DISPATCHER_FN = 'scheduledDispatcher_';

function scheduledDispatcher_() {
  const now = new Date();

  // Weekdays only — 'u' gives ISO day-of-week in America/New_York time
  // (1=Monday...7=Sunday), so this is correct regardless of the script
  // project's own timezone setting.
  const nyIsoDayOfWeek = Utilities.formatDate(now, 'America/New_York', 'u');
  if (nyIsoDayOfWeek === '6' || nyIsoDayOfWeek === '7') return;

  const nyTime = Utilities.formatDate(now, 'America/New_York', 'HH:mm');
  const slotId = Utilities.formatDate(now, 'America/New_York', 'yyyy-MM-dd') + ' ' + nyTime;
  const props = PropertiesService.getScriptProperties();

  if (SCHEDULED_SCAN_TIMES.indexOf(nyTime) !== -1 && props.getProperty('LAST_SCHEDULED_SCAN_SLOT') !== slotId) {
    props.setProperty('LAST_SCHEDULED_SCAN_SLOT', slotId);
    runScheduledScanOnTabs_();
  }

  if (SCHEDULED_VALIDATE_TIMES.indexOf(nyTime) !== -1 && props.getProperty('LAST_SCHEDULED_VALIDATE_SLOT') !== slotId) {
    props.setProperty('LAST_SCHEDULED_VALIDATE_SLOT', slotId);
    runScheduledValidateOnTabs_();
  }
}

function runScheduledScanOnTabs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  SCHEDULED_TABS.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { logToSheet_('Scheduled Scan: tab "' + name + '" not found, skipped.'); return; }
    try {
      scanOptionChainForBestOi(sheet, SCHEDULED_PER_TAB_BUDGET_MS);
    } catch (err) {
      logToSheet_('Scheduled Scan on "' + name + '" failed: ' + err);
    }
  });
}

function runScheduledValidateOnTabs_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  SCHEDULED_TABS.forEach(function (name) {
    const sheet = ss.getSheetByName(name);
    if (!sheet) { logToSheet_('Scheduled Validate: tab "' + name + '" not found, skipped.'); return; }
    try {
      validateAndUpdate(sheet, SCHEDULED_PER_TAB_BUDGET_MS);
    } catch (err) {
      logToSheet_('Scheduled Validate on "' + name + '" failed: ' + err);
    }
  });
}

function installScheduledRuns_() {
  removeScheduledRunsQuiet_();
  ScriptApp.newTrigger(SCHEDULED_DISPATCHER_FN).timeBased().everyMinutes(5).create();
  const ui = tryGetUi_();
  const msg = 'Scheduled runs enabled (weekdays only):\n' +
    'Scan Chain by Delta / OI — ' + SCHEDULED_SCAN_TIMES.join(', ') + ' ET on ' + SCHEDULED_TABS.join(' + ') + '\n' +
    'Validate & Update — ' + SCHEDULED_VALIDATE_TIMES[0] + '-' + SCHEDULED_VALIDATE_TIMES[SCHEDULED_VALIDATE_TIMES.length - 1] +
      ' ET every 30 min on ' + SCHEDULED_TABS.join(' + ') + '\n\n' +
    'Summaries land in the "Log" tab. Use "Disable Scheduled Runs" to stop.';
  if (ui) ui.alert('Scheduled Runs', msg, ui.ButtonSet.OK); else logToSheet_(msg);
}

function removeScheduledRunsQuiet_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === SCHEDULED_DISPATCHER_FN) ScriptApp.deleteTrigger(t);
  });
}

function removeScheduledRuns_() {
  removeScheduledRunsQuiet_();
  const ui = tryGetUi_();
  const msg = 'Scheduled runs disabled. Manual menu use is unaffected.';
  if (ui) ui.alert(msg); else logToSheet_(msg);
}


function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Options Validator')
    .addItem('🎯 Scan Chain by Delta / OI', 'scanOptionChainForBestOi')
    .addItem('▶ Validate & Update All Rows', 'validateAndUpdate')
    .addItem('🚀 Place Trades (TastyTrade)', 'placeTradesFromSheet')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('⚙ More Tools')
      .addItem('🔑 Set TastyTrade Credentials', 'setTastyTradeCredentials')
      .addItem('🔑 Set Finnhub API Key', 'setFinnhubApiKey')
      .addItem('🔑 Set FMP API Key', 'setFmpApiKey')
      .addItem('🔑 Set Alpha Vantage API Key (optional fallback)', 'setAlphaVantageApiKey')
      .addSeparator()
      .addItem('⚙ Set Trade Credentials', 'setTradeCredentials')
      .addSeparator()
      .addItem('🧹 Clear Today\'s API Quota Cache', 'clearTodayApiCache')
      .addItem('🧹 Force-Refresh Slow-Changing Data (Analyst/Theme/Quality/Catalyst)', 'clearSlowCacheMenuAction_')
      .addSeparator()
      .addItem('🏷 Set Sector/Industry Override', 'setSectorOverride_')
      .addItem('🏷 Clear Sector/Industry Override', 'clearSectorOverride_')
      .addSeparator()
      .addItem('📈 Clean Unused Google Finance Rows', 'cleanGfHelperSheetMenuAction_')
      .addSeparator()
      .addItem('⏰ Enable Scheduled Runs (weekdays)', 'installScheduledRuns_')
      .addItem('⏰ Disable Scheduled Runs', 'removeScheduledRuns_')
      .addSeparator()
      .addItem('🔍 Debug: Show Detected Columns', 'debugShowColumns')
      .addItem('🔬 Debug: Fetch Raw Quote (one row)', 'debugFetchRawQuote')
      .addItem('📅 Debug: Fetch Earnings (one ticker)', 'debugFetchEarnings')
      .addItem('🔎 Debug: Scan One Ticker\'s Chain', 'debugScanTickerChain'))
    .addToUi();

  // Separate top-level menu for BestOpenInterest.gs's single-ticker,
  // all-expirations scanner. Registered here (not a second onOpen() in
  // that file) because Apps Script only runs ONE onOpen() per project —
  // a second one would silently fight with this one exactly like
  // scanChainByDelta used to. The scanning logic itself still lives
  // entirely in BestOpenInterest.gs; this just points a menu at it.
  SpreadsheetApp.getUi()
    .createMenu('DeepDive')
    .addItem('🔬 Run Deep Dive Scan', 'runDeepDiveScan')
    .addItem('🐞 Debug: Raw Chain (one expiration)', 'debugFetchRawChainForExpiry')
    .addToUi();

  // Separate top-level menu for HedgeEngine.gs, same reasoning as DeepDive
  // above: this is the ONLY place in Momentum.gs that knows HedgeEngine.gs
  // exists, so the hedge logic (weights, buckets, decision rules) can change
  // freely without ever touching this file.
  SpreadsheetApp.getUi()
    .createMenu('🛡️ Hedge')
    .addItem('Run Hedge Analysis', 'runHedgeAnalysis')
    .addSubMenu(SpreadsheetApp.getUi().createMenu('⚙ Hedge Setup')
      .addItem('🔑 Set FRED API Key', 'setFredApiKey'))
    .addToUi();

  // Separate top-level menu for ResearchEngine.gs, same reasoning as Hedge
  // and DeepDive above.
  SpreadsheetApp.getUi()
    .createMenu('🔎 Research')
    .addItem('Run Daily Research', 'runDailyResearch')
    .addItem('🚀 Run Full Daily Pipeline (Research + Promote + Auto-fill / Best OI)', 'runDailyPipeline')
    .addItem('☁️ Set Cloud Function URL/Secret', 'setCloudFunctionCredentials')
    .addToUi();
}


/* ============================================================================
 * API KEY / CREDENTIAL SETUP — unchanged
 * ========================================================================== */

function setFinnhubApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('Finnhub Setup', 'Paste your free Finnhub API key:', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const key = response.getResponseText().trim();
  if (!key) { ui.alert('No API key entered.'); return; }
  PropertiesService.getScriptProperties().setProperty('FINNHUB_API_KEY', key);
  ui.alert('Finnhub API key saved.\n\nUsed for: Next Catalyst / Catalyst Date.');
}

function getFinnhubApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('FINNHUB_API_KEY');
}

function setFmpApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt('FMP Setup', 'Paste your free Financial Modeling Prep API key:', ui.ButtonSet.OK_CANCEL);
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const key = response.getResponseText().trim();
  if (!key) { ui.alert('No API key entered.'); return; }
  PropertiesService.getScriptProperties().setProperty('FMP_API_KEY', key);
  ui.alert('FMP API key saved.\n\nUsed as the last-resort fallback for Theme/Cluster, Sector Momentum, and the Leap Score quality factor.');
}

function getFmpApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('FMP_API_KEY');
}

function setAlphaVantageApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'Alpha Vantage Setup (optional)',
    'Paste your free Alpha Vantage API key:\n\n(Only used as a backup for Analyst Target if Yahoo Finance is unreachable — free tier is 25 requests/day.)',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const key = response.getResponseText().trim();
  if (!key) { ui.alert('No API key entered.'); return; }
  PropertiesService.getScriptProperties().setProperty('ALPHA_VANTAGE_API_KEY', key);
  ui.alert('Alpha Vantage API key saved. Used only when Yahoo fails to return an Analyst Target.');
}

function getAlphaVantageApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('ALPHA_VANTAGE_API_KEY');
}

function setTastyTradeCredentials() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const secretResp = ui.prompt('TastyTrade Setup (1/2)', 'Paste your client_secret:', ui.ButtonSet.OK_CANCEL);
  if (secretResp.getSelectedButton() !== ui.Button.OK) return;
  const tokenResp = ui.prompt('TastyTrade Setup (2/2)', 'Paste your refresh_token:', ui.ButtonSet.OK_CANCEL);
  if (tokenResp.getSelectedButton() !== ui.Button.OK) return;
  props.setProperty('TASTY_CLIENT_SECRET', secretResp.getResponseText().trim());
  props.setProperty('TASTY_REFRESH_TOKEN', tokenResp.getResponseText().trim());
  ui.alert('TastyTrade credentials saved.');
}


/* ============================================================================
 * DAILY QUOTA-AWARE CACHE (FMP + Alpha Vantage) — unchanged
 *
 * This is about a source's DAILY REQUEST QUOTA running out mid-day; it is
 * separate from the SLOW-CHANGING DATA CACHE below, which is about not
 * re-asking for data that doesn't change day to day in the first place.
 * ========================================================================== */

function todayKey_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function isQuotaExceededResponse_(resp) {
  const code = resp.getResponseCode();
  if (code === 429 || code === 403) return true;
  const text = resp.getContentText().toLowerCase();
  return (
    text.indexOf('limit reach') !== -1 ||
    text.indexOf('rate limit') !== -1 ||
    text.indexOf('upgrade your plan') !== -1 ||
    text.indexOf('daily limit') !== -1 ||
    text.indexOf('request limit') !== -1
  );
}

function isQuotaHitToday_(sourceName) {
  const flag = PropertiesService.getScriptProperties().getProperty('QUOTA_HIT_' + sourceName);
  return flag === todayKey_();
}

function markQuotaHitToday_(sourceName) {
  PropertiesService.getScriptProperties().setProperty('QUOTA_HIT_' + sourceName, todayKey_());
  Logger.log(sourceName + ' daily quota appears exhausted — pausing calls for the rest of today.');
}

function readTickerCache_(sourceName, ticker) {
  const raw = PropertiesService.getScriptProperties().getProperty('CACHE_' + sourceName + '_' + ticker);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed.date !== todayKey_()) return null;
    return parsed.value;
  } catch (err) {
    return null;
  }
}

function writeTickerCache_(sourceName, ticker, value) {
  try {
    PropertiesService.getScriptProperties().setProperty(
      'CACHE_' + sourceName + '_' + ticker,
      JSON.stringify({ date: todayKey_(), value: value })
    );
  } catch (err) {
    Logger.log('Daily cache write failed for ' + sourceName + '/' + ticker + ': ' + err);
  }
}

function clearTodayApiCache() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const all = props.getProperties();
  const keysToDelete = Object.keys(all).filter(function (k) {
    return k.indexOf('QUOTA_HIT_') === 0 || k.indexOf('CACHE_') === 0;
  });
  keysToDelete.forEach(function (k) { props.deleteProperty(k); });
  ui.alert(
    'API quota cache cleared',
    'Removed ' + keysToDelete.length + ' cached quota flag(s)/value(s). ' +
    'The next run will call every configured API fresh.',
    ui.ButtonSet.OK
  );
}


/* ============================================================================
 * SLOW-CHANGING DATA CACHE (Analyst Target, Theme/Cluster, Quality, Catalyst)
 *
 * Persistent across runs AND across days (Script Properties, not the
 * per-run-only ticker cache used elsewhere). A cached value is reused with
 * zero network calls until it's older than its field's refresh window (see
 * SLOW_REFRESH_DAYS), or an optional forceStale(value) check says it must
 * be refreshed regardless of age (used for Catalyst: a past earnings date
 * always forces a refresh).
 * ========================================================================== */

// The slow cache moved from Script Properties to this dedicated sheet —
// Properties' small total-storage quota couldn't hold a 200+ ticker
// research universe's worth of daily-bars JSON (each ticker's ~2 months
// of bars is several KB; hundreds of them blew right through it). A
// sheet has no meaningful ceiling for this by comparison.
const DATA_CACHE_SHEET_NAME = 'DataCache';

function loadSlowCache_() {
  // One-time migration cleanup: old SLOW_-prefixed Script Properties left
  // over from before this moved to a sheet are now dead weight, still
  // eating into the same quota that other things (FMP/AlphaVantage daily
  // caches, sector overrides) legitimately still use. Harmless once
  // there's nothing left to find — cheap no-op check on every run after
  // the first.
  const props = PropertiesService.getScriptProperties();
  const allProps = props.getProperties();
  const staleKeys = Object.keys(allProps).filter(function (k) { return k.indexOf('SLOW_') === 0; });
  staleKeys.forEach(function (k) { props.deleteProperty(k); });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_CACHE_SHEET_NAME);
  const cache = {};
  if (!sheet) return cache;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return cache;
  const values = sheet.getRange(1, 1, lastRow, 2).getValues();
  values.forEach(function (row) {
    const key = row[0];
    const raw = row[1];
    if (!key || !raw) return;
    try {
      cache[key] = JSON.parse(raw);
    } catch (e) {
      // corrupt entry — treat as absent, will simply be refetched
    }
  });
  return cache;
}

function slowKey_(field, ticker) {
  return 'SLOW_' + field + '_' + ticker;
}

function slowEntryAgeDays_(entry) {
  if (!entry || !entry.date) return Infinity;
  const ms = new Date().getTime() - new Date(entry.date + 'T00:00:00').getTime();
  return ms / (24 * 60 * 60 * 1000);
}

/**
 * Returns { value, fromCache, isFreshFetch }.
 * fetchFn() is only called (i.e. the network is only hit) when the cached
 * entry is missing, stale, or forceStale(cachedValue) returns true.
 * On a successful fetch, queues the write into pendingWrites rather than
 * writing immediately — validateAndUpdate() flushes all of them in ONE
 * batched PropertiesService call at the end of the run.
 */
function getSlowCached_(slowCache, pendingWrites, field, ticker, maxAgeDays, fetchFn, forceStale) {
  const key = slowKey_(field, ticker);
  const entry = slowCache[key];
  const age = slowEntryAgeDays_(entry);
  const mustRefresh = age >= maxAgeDays || (entry && typeof forceStale === 'function' && forceStale(entry.value));

  if (entry && !mustRefresh) {
    // The only case where fetchFn is never called at all — a genuine,
    // zero-network-cost cache hit. fetchAttempted lets callers (Research/
    // Hedge's per-ticker throttling sleeps) skip an unnecessary delay
    // specifically in this case, without guessing from fromCache/
    // isFreshFetch alone (both of which can also be true after a FAILED
    // fetch attempt fell back to a stale value below).
    return { value: entry.value, fromCache: true, isFreshFetch: false, fetchAttempted: false };
  }

  const fresh = fetchFn();

  if (fresh != null) {
    const record = { date: todayKey_(), value: fresh };
    pendingWrites[key] = JSON.stringify(record);
    slowCache[key] = record; // keep this run's in-memory copy current too
    return { value: fresh, fromCache: false, isFreshFetch: true, fetchAttempted: true };
  }

  // Fetch failed or no key configured — reuse the stale value rather than
  // blanking the cell, but do NOT touch its timestamp, so the next run
  // tries the network again instead of treating this as "up to date".
  if (entry) {
    return { value: entry.value, fromCache: true, isFreshFetch: false, fetchAttempted: true };
  }

  return { value: null, fromCache: false, isFreshFetch: false, fetchAttempted: true };
}

function flushSlowCacheWrites_(pendingWrites) {
  const keys = Object.keys(pendingWrites);
  if (!keys.length) return 0;

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(DATA_CACHE_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(DATA_CACHE_SHEET_NAME);
    try { sheet.hideSheet(); } catch (e) { /* fine if it can't hide (e.g. only sheet) */ }
  }

  // Merge onto whatever's currently in the sheet (not just what this run's
  // loadSlowCache_ saw at the start) so a long-running scan's writes never
  // clobber entries a DIFFERENT concurrent run may have added meanwhile.
  const existing = {};
  const lastRow = sheet.getLastRow();
  if (lastRow >= 1) {
    sheet.getRange(1, 1, lastRow, 2).getValues().forEach(function (row) {
      if (row[0]) existing[row[0]] = row[1];
    });
  }
  keys.forEach(function (k) { existing[k] = pendingWrites[k]; });

  const rows = Object.keys(existing).map(function (k) { return [k, existing[k]]; });
  sheet.clearContents();
  if (rows.length) sheet.getRange(1, 1, rows.length, 2).setValues(rows);

  return keys.length;
}

function clearSlowCache_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(DATA_CACHE_SHEET_NAME);
  if (!sheet) return 0;
  const lastRow = sheet.getLastRow();
  if (lastRow < 1) return 0;
  sheet.clearContents();
  return lastRow;
}

function clearSlowCacheMenuAction_() {
  const ui = SpreadsheetApp.getUi();
  const removed = clearSlowCache_();
  ui.alert(
    'Slow-changing data cache cleared',
    'Removed ' + removed + ' cached value(s) for Analyst Target, Theme/Cluster, ' +
    'Quality, and Catalyst. The next "Validate & Update" run fetches all of ' +
    'these fresh instead of reusing cached values.',
    ui.ButtonSet.OK
  );
}

/* ============================================================================
 * SECTOR/INDUSTRY OVERRIDES — user-taught classifications, never expire,
 * never re-fetched, always checked before the built-in STATIC_SECTOR_MAP
 * or any live source. Persistent across runs (Script Properties), loaded
 * once per run the same way the slow cache is.
 * ========================================================================== */

function loadSectorOverrides_() {
  const props = PropertiesService.getScriptProperties().getProperties();
  const overrides = {};
  Object.keys(props).forEach(function (k) {
    if (k.indexOf('SECTOROVERRIDE_') === 0) {
      try {
        overrides[k.substring('SECTOROVERRIDE_'.length)] = JSON.parse(props[k]);
      } catch (e) {
        // corrupt entry — treat as absent
      }
    }
  });
  return overrides;
}

function setSectorOverride_() {
  const ui = SpreadsheetApp.getUi();

  const tickerResp = ui.prompt('Set Sector/Industry Override (1/3)', 'Ticker symbol:', ui.ButtonSet.OK_CANCEL);
  if (tickerResp.getSelectedButton() !== ui.Button.OK) return;
  const ticker = tickerResp.getResponseText().trim().toUpperCase();
  if (!ticker) { ui.alert('No ticker entered.'); return; }

  const sectorOptions = Object.keys(SECTOR_ETF_MAP).join(', ');
  const sectorResp = ui.prompt(
    'Set Sector/Industry Override (2/3)',
    'Sector — use one of these exactly so Sector Momentum can match an ETF:\n' + sectorOptions,
    ui.ButtonSet.OK_CANCEL
  );
  if (sectorResp.getSelectedButton() !== ui.Button.OK) return;
  const sector = sectorResp.getResponseText().trim();

  const industryResp = ui.prompt(
    'Set Sector/Industry Override (3/3)',
    'Industry / theme label (free text — this is what shows in the Theme/Cluster column):',
    ui.ButtonSet.OK_CANCEL
  );
  if (industryResp.getSelectedButton() !== ui.Button.OK) return;
  const industry = industryResp.getResponseText().trim();

  PropertiesService.getScriptProperties().setProperty(
    'SECTOROVERRIDE_' + ticker,
    JSON.stringify({ sector: sector || null, industry: industry || sector || null, source: 'User (manual override)' })
  );

  ui.alert(
    'Saved',
    ticker + ' will use this classification on every future run — no network call, and it never expires until you clear it.',
    ui.ButtonSet.OK
  );
}

function clearSectorOverride_() {
  const ui = SpreadsheetApp.getUi();
  const tickerResp = ui.prompt('Clear Sector/Industry Override', 'Ticker symbol to clear:', ui.ButtonSet.OK_CANCEL);
  if (tickerResp.getSelectedButton() !== ui.Button.OK) return;
  const ticker = tickerResp.getResponseText().trim().toUpperCase();
  if (!ticker) { ui.alert('No ticker entered.'); return; }

  PropertiesService.getScriptProperties().deleteProperty('SECTOROVERRIDE_' + ticker);
  ui.alert(ticker + ' override cleared. It will fall back to the built-in table or live sources on the next run.');
}

function isCatalystPast_(value) {
  if (!value || !value.date) return false;
  const d = new Date(value.date);
  if (isNaN(d.getTime())) return false;
  return d.getTime() < new Date().setHours(0, 0, 0, 0);
}



/* ============================================================================
 * FORMULA COLUMN EXTENSION — for any column that already holds a formula
 * somewhere on the sheet (your own — Net Price, or anything else you've
 * set up beyond what this script writes), extends it down to match the
 * sheet's actual last row, using the LOWEST existing formula in that
 * column as the template (copied via R1C1 so relative references adjust
 * automatically, same technique BestOpenInterest.gs's own
 * reconcileTrailingFormulas_ already uses for DeepDive's N:P columns —
 * this is the same idea, generalized to any column instead of a fixed
 * range, since Quick/Risky/Leap can each have formulas in different
 * places). A column with no formula anywhere is left alone entirely —
 * this never touches or invents a value in a column the script writes
 * directly (Ticker/Strike/Expiry/Score/etc.).
 * ========================================================================== */
function extendFormulaColumnsToLastRow_(sheet, map) {
  if (!map.ticker) return 0;

  const lastRow = sheet.getLastRow();
  if (lastRow < DATA_START_ROW) return 0;

  const lastCol = sheet.getLastColumn();
  if (lastCol < 1) return 0;

  const numRows = lastRow - DATA_START_ROW + 1;
  const dataRange = sheet.getRange(DATA_START_ROW, 1, numRows, lastCol);
  const allFormulas = dataRange.getFormulasR1C1();
  const allFormats = dataRange.getNumberFormats();
  let extendedCols = 0;

  for (let col = 1; col <= lastCol; col++) {
    let lowestFormulaRowIndex = -1; // 0-based index into allFormulas
    for (let i = numRows - 1; i >= 0; i--) {
      const f = allFormulas[i][col - 1];
      if (f && String(f).trim() !== '') { lowestFormulaRowIndex = i; break; }
    }
    if (lowestFormulaRowIndex === -1) continue; // no formula anywhere in this column

    const lowestFormulaRow = DATA_START_ROW + lowestFormulaRowIndex;
    if (lowestFormulaRow >= lastRow) continue; // already reaches the bottom

    const formula = allFormulas[lowestFormulaRowIndex][col - 1];
    const format = allFormats[lowestFormulaRowIndex][col - 1];
    const rowsToFill = lastRow - lowestFormulaRow;

    const formulaBlock = [];
    const formatBlock = [];
    for (let i = 0; i < rowsToFill; i++) {
      formulaBlock.push([formula]);
      formatBlock.push([format]);
    }

    const targetRange = sheet.getRange(lowestFormulaRow + 1, col, rowsToFill, 1);
    targetRange.setFormulasR1C1(formulaBlock);
    targetRange.setNumberFormats(formatBlock);
    extendedCols++;
  }

  return extendedCols;
}


/* ============================================================================
 * COLUMN DETECTION
 * ========================================================================== */

function normalizeHeader_(v) {
  return String(v || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function getColumnMap_(sheet) {
  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(HEADER_ROW, 1, 1, lastCol).getValues()[0];
  const map = {};

  Object.keys(HEADER_MAP).forEach(function (key) {
    const aliases = HEADER_MAP[key].map(normalizeHeader_);
    const idx = headers.findIndex(function (h) { return aliases.includes(normalizeHeader_(h)); });
    map[key] = idx === -1 ? null : idx + 1;
  });

  // Validation Status: detected if present, but never auto-created —
  // you said you don't need it. If you still have the column from
  // before, it's simply left alone (never written to); delete it
  // yourself in Sheets if you want it gone entirely.
  const statusCol = headers.findIndex(function (h) { return normalizeHeader_(h) === normalizeHeader_(STATUS_HEADER); });
  map.status = statusCol === -1 ? null : statusCol + 1;

  // LastRun (was "Last Validated") — recognizes the old header text so
  // an existing sheet doesn't get a duplicate column; renames the cell
  // in place to the new name the first time this runs.
  const lastCol2 = sheet.getLastColumn();
  let tsCol = headers.findIndex(function (h) {
    const norm = normalizeHeader_(h);
    return norm === normalizeHeader_(TIMESTAMP_HEADER) || norm === normalizeHeader_('Last Validated');
  });
  if (tsCol === -1) {
    sheet.getRange(HEADER_ROW, lastCol2 + 1).setValue(TIMESTAMP_HEADER);
    map.timestamp = lastCol2 + 1;
  } else {
    sheet.getRange(HEADER_ROW, tsCol + 1).setValue(TIMESTAMP_HEADER); // upgrade old label in place
    map.timestamp = tsCol + 1;
  }

  return map;
}

function debugShowColumns() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const map = getColumnMap_(sheet);
  const lines = Object.keys(map).map(function (k) {
    const aliasNote = HEADER_MAP[k] ? ' (tried: ' + HEADER_MAP[k].join(' / ') + ')' : '';
    return k + ': ' + (map[k] ? 'column ' + map[k] : 'NOT FOUND' + aliasNote);
  });
  SpreadsheetApp.getUi().alert('Detected Columns', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}

function debugFetchEarnings() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Debug Earnings Lookup', 'Ticker symbol (e.g. NVDA):', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const ticker = resp.getResponseText().trim().toUpperCase();
  if (!ticker) { ui.alert('No ticker entered.'); return; }

  const finnhubKey = getFinnhubApiKey_();
  let output = 'Ticker: ' + ticker + '\n\n';

  if (finnhubKey) {
    output += '--- Finnhub ---\n' + JSON.stringify(fetchFinnhubNextEarnings_(ticker, finnhubKey), null, 2) + '\n\n';
  } else {
    output += '--- Finnhub ---\nNo API key configured.\n\n';
  }

  output += '--- Yahoo Fallback ---\n' + JSON.stringify(fetchYahooNextEarnings_(ticker), null, 2);
  ui.alert('Earnings Debug', output.substring(0, 5000), ui.ButtonSet.OK);
}

// ----------------------------------------------------------------------------
// Debug: Scan One Ticker's Chain — walks findHighestOiContractForScanner_'s
// exact steps for a single ticker/type and reports counts at each stage
// (expirations found, how many cleared the DTE floor, contracts per
// expiry, how many had usable OI/IV, how many cleared the delta floor),
// plus the top few candidates by delta so a "0 matches" result from the
// real scan can be diagnosed without guessing. Uses the same Chain
// Scanner Settings (Min Delta / Min Expiry), now read from the active
// sheet's block in the "Input" tab.
// ----------------------------------------------------------------------------
function debugScanTickerChain() {
  const ui = SpreadsheetApp.getUi();
  const activeSheetName = SpreadsheetApp.getActiveSheet().getName();

  let settings;
  try {
    settings = readChainScannerSettings_(activeSheetName);
  } catch (e) {
    ui.alert(e.message);
    return;
  }

  const tickerResp = ui.prompt('Debug: Scan One Ticker\'s Chain', 'Ticker symbol (e.g. AAPL):', ui.ButtonSet.OK_CANCEL);
  if (tickerResp.getSelectedButton() !== ui.Button.OK) return;
  const ticker = tickerResp.getResponseText().trim().toUpperCase();
  if (!ticker) { ui.alert('No ticker entered.'); return; }

  const typeResp = ui.prompt(
    'Debug: Scan One Ticker\'s Chain',
    'Option type — type C for calls or P for puts (blank = use "' + activeSheetName + '" block\'s Type field in the Input tab, currently ' + settings.type + '):',
    ui.ButtonSet.OK_CANCEL
  );
  if (typeResp.getSelectedButton() !== ui.Button.OK) return;
  const typeInput = typeResp.getResponseText().trim().toUpperCase();
  const type = typeInput === 'P' ? 'P' : (typeInput === 'C' ? 'C' : settings.type);

  const runTimestamp = new Date();
  const strikeBoundNote = type === 'P'
    ? ('Max Strike: ' + settings.minStrikePercent + '% above price')
    : ('Min Strike: ' + settings.minStrikePercent + '% of price');
  let output = 'Ticker: ' + ticker + ' (' + type + ')\n' +
    'Min Delta: ' + settings.minDelta + ' | Min Expiry: ' + settings.minExpiryDays + 'd' +
    (settings.maxExpiryDays != null ? (' | Max Expiry: ' + settings.maxExpiryDays + 'd') : '') +
    ' | ' + strikeBoundNote + '\n\n';

  // --- TastyTrade attempt (tried first by the real scan) ---
  const accessToken = getTastyTradeAccessToken_();
  if (!accessToken) {
    output += '--- TastyTrade ---\nNo credentials configured — Options Validator > Set TastyTrade Credentials.\n\n';
  } else {
    const tastyExpirations = fetchTastyOptionChainNested_(ticker, accessToken);
    if (!tastyExpirations) {
      output += '--- TastyTrade ---\nNested chain call failed or returned nothing usable (see Executions log for the raw HTTP/parse error).\n\n';
    } else {
      const tastyQualifying = tastyExpirations
        .filter(function (e) {
          const dte = Math.round((e.date.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
          if (dte < settings.minExpiryDays) return false;
          if (settings.maxExpiryDays != null && dte > settings.maxExpiryDays) return false;
          return true;
        })
        .sort(function (a, b) { return a.date.getTime() - b.date.getTime(); });

      output += '--- TastyTrade ---\n' +
        'Total expirations: ' + tastyExpirations.length +
        ' | meeting expiry window: ' + tastyQualifying.length +
        ' (scanning nearest ' + Math.min(tastyQualifying.length, CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN) + ')\n';

      const tastyBest = findBestOiFromTastyChain_(ticker, type, settings.minDelta, settings.minExpiryDays, settings.maxExpiryDays, settings.minStrikePercent, runTimestamp, accessToken);
      output += (tastyBest
        ? ('WOULD PICK (TastyTrade): $' + round2_(tastyBest.strike) + type + ' @ ' +
            Utilities.formatDate(tastyBest.expiry, Session.getScriptTimeZone(), 'yyyy-MM-dd') +
            ' (Δ' + tastyBest.estDelta.toFixed(2) + ', OI ' + tastyBest.oi + ')')
        : 'No TastyTrade contract met all floors in the scanned window.') + '\n\n';
    }
  }

  // --- Yahoo fallback breakdown ---
  const expiryInfo = fetchYahooExpirationDatesForScanner_(ticker);
  if (!expiryInfo || !expiryInfo.dates.length) {
    output += '--- Yahoo ---\nCould not fetch expiration dates at all (network/parse failure or ticker not found on Yahoo).';
    ui.alert('Chain Scan Debug', output.substring(0, 8000), ui.ButtonSet.OK);
    return;
  }

  output += '--- Yahoo ---\n';
  output += 'Total expirations Yahoo returned: ' + expiryInfo.dates.length + '\n';
  output += 'Underlying price (from expirations call): ' + (expiryInfo.underlying != null ? expiryInfo.underlying : 'MISSING') + '\n';

  const qualifyingDates = expiryInfo.dates
    .filter(function (d) {
      const dte = Math.round((d.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
      if (dte < settings.minExpiryDays) return false;
      if (settings.maxExpiryDays != null && dte > settings.maxExpiryDays) return false;
      return true;
    })
    .sort(function (a, b) { return a.getTime() - b.getTime(); });

  output += 'Expirations meeting the expiry window: ' + qualifyingDates.length +
    ' (scanning nearest ' + Math.min(qualifyingDates.length, CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN) + ')\n\n';

  const scanList = qualifyingDates.slice(0, CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN);
  let bestOverall = null;

  scanList.forEach(function (expiryDate) {
    const chainInfo = fetchYahooFullChainForScannerExpiry_(ticker, expiryDate, type);
    Utilities.sleep(120);
    const dte = Math.round((expiryDate.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
    const dateLabel = Utilities.formatDate(expiryDate, Session.getScriptTimeZone(), 'yyyy-MM-dd') + ' (' + dte + 'd)';

    if (!chainInfo || !chainInfo.contracts.length) {
      output += dateLabel + ': no contracts returned\n';
      return;
    }

    const underlying = chainInfo.underlying || expiryInfo.underlying;
    const strikeBounds = computeStrikeBounds_(type, settings.minStrikePercent, underlying);
    let withOi = 0, withIv = 0, meetingDelta = 0, outsideStrikeBound = 0;
    let topByDelta = [];

    chainInfo.contracts.forEach(function (c) {
      const strike = c.strike != null ? parseFloat(c.strike) : null;
      const oi = isPlausible_(c.openInterest, 1, null) ? c.openInterest : null;
      const ivPct = c.impliedVolatility != null ? parseFloat(c.impliedVolatility) * 100 : null;
      if (oi != null) withOi++;
      if (isPlausible_(ivPct, 0.01, 1000)) withIv++;
      const belowMin = strikeBounds.min != null && strike != null && strike < strikeBounds.min;
      const aboveMax = strikeBounds.max != null && strike != null && strike > strikeBounds.max;
      if (belowMin || aboveMax) { outsideStrikeBound++; return; }
      if (!isPlausible_(strike, 0.01, null) || oi == null || !isPlausible_(ivPct, 0.01, 1000) || !isPlausible_(underlying, 0.01, null)) return;

      const estDelta = blackScholesDelta_(underlying, strike, dte, ivPct, type);
      if (estDelta == null) return;
      topByDelta.push({ strike: strike, oi: oi, delta: estDelta });
      if (Math.abs(estDelta) >= settings.minDelta) {
        meetingDelta++;
        if (!bestOverall || oi > bestOverall.oi) bestOverall = { strike: strike, expiry: dateLabel, oi: oi, delta: estDelta };
      }
    });

    topByDelta.sort(function (a, b) { return Math.abs(b.delta) - Math.abs(a.delta); });

    output += dateLabel + ': ' + chainInfo.contracts.length + ' contracts, underlying=' + underlying +
      ', withOI=' + withOi + ', withIV=' + withIv + ', outsideStrikeBound=' + outsideStrikeBound + ', meeting delta floor=' + meetingDelta + '\n';
    if (topByDelta.length) {
      output += '  Highest-delta contracts seen: ' + topByDelta.slice(0, 3).map(function (t) {
        return '$' + round2_(t.strike) + ' Δ' + t.delta.toFixed(2) + ' OI' + t.oi;
      }).join(', ') + '\n';
    }
  });

  output += '\n' + (bestOverall
    ? ('WOULD PICK (Yahoo fallback): $' + round2_(bestOverall.strike) + type + ' @ ' + bestOverall.expiry + ' (Δ' + bestOverall.delta.toFixed(2) + ', OI ' + bestOverall.oi + ')')
    : 'WOULD PICK (Yahoo fallback): nothing — no contract in the scanned window met both floors.');

  ui.alert('Chain Scan Debug', output.substring(0, 8000), ui.ButtonSet.OK);
}

function debugFetchRawQuote() {
  const sheet = SpreadsheetApp.getActiveSheet();
  const map = getColumnMap_(sheet);
  const ui = SpreadsheetApp.getUi();

  const rowResp = ui.prompt('Debug Raw Quote', 'Which row number?', ui.ButtonSet.OK_CANCEL);
  if (rowResp.getSelectedButton() !== ui.Button.OK) return;
  const row = parseInt(rowResp.getResponseText().trim(), 10);
  if (isNaN(row)) { ui.alert('Invalid row.'); return; }

  const ticker = String(sheet.getRange(row, map.ticker).getValue()).trim();
  const parsedStrike = parseStrikeCell_(sheet.getRange(row, map.strike).getValue());
  const parsedExpiry = parseExpiryCell_(sheet.getRange(row, map.expiry).getValue());

  if (!ticker || !parsedStrike || !parsedExpiry) {
    ui.alert('Could not parse ticker / strike / expiry.');
    return;
  }

  const occSymbol = buildOccSymbol_(ticker, parsedExpiry, parsedStrike.strike, parsedStrike.type);
  const rawExpiryCellValue = sheet.getRange(row, map.expiry).getValue();
  let output = 'Ticker: ' + ticker + '\nOCC: ' + occSymbol + '\n\n';

  // Timezone diagnostic — each line independently defensive (a prior
  // version let one bad call throw and hide everything else). safe_
  // returns the real error message inline instead of crashing, so
  // whichever specific call is the problem is directly visible.
  function safe_(fn) {
    try { return String(fn()); } catch (e) { return 'ERROR: ' + e.message; }
  }

  output += '--- Timezone Diagnostic ---\n';
  output += 'Script timezone: ' + safe_(function () { return Session.getScriptTimeZone(); }) + '\n';
  output += 'Spreadsheet timezone: ' + safe_(function () { return SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(); }) + '\n';
  output += 'Raw Expiry cell value type: ' + (rawExpiryCellValue instanceof Date ? 'Date object' : typeof rawExpiryCellValue) + '\n';
  if (rawExpiryCellValue instanceof Date) {
    output += 'Raw cell as ISO (absolute UTC instant): ' + safe_(function () { return rawExpiryCellValue.toISOString(); }) + '\n';
    output += 'Raw cell formatted in script tz: ' + safe_(function () {
      return Utilities.formatDate(rawExpiryCellValue, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    }) + '\n';
    output += 'Raw cell formatted in spreadsheet tz: ' + safe_(function () {
      return Utilities.formatDate(rawExpiryCellValue, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'yyyy-MM-dd HH:mm:ss');
    }) + '\n';
  }
  output += 'parseExpiryCell_ result as ISO: ' + safe_(function () { return parsedExpiry.toISOString(); }) + '\n';
  output += 'parseExpiryCell_ result formatted in script tz: ' + safe_(function () {
    return Utilities.formatDate(parsedExpiry, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  }) + '\n\n';

  const finnhubKey = getFinnhubApiKey_();
  if (finnhubKey) {
    output += '--- Finnhub ---\n' + JSON.stringify(fetchFinnhubNextEarnings_(ticker, finnhubKey), null, 2) + '\n\n';
  } else {
    output += '--- Finnhub ---\nNo API key configured.\n\n';
  }

  output += '--- Yahoo Analyst Target ---\n' + JSON.stringify(fetchYahooAnalystTarget_(ticker), null, 2) + '\n\n';

  const fmpKey = getFmpApiKey_();
  if (fmpKey) {
    output += '--- FMP Quote (Change Now) ---\n' + JSON.stringify(fetchFmpQuote_(ticker, fmpKey), null, 2) + '\n\n';
    output += '--- FMP Profile (Sector) ---\n' + JSON.stringify(fetchFmpProfile_(ticker, fmpKey), null, 2) + '\n\n';
  } else {
    output += '--- FMP ---\nNo API key configured.\n\n';
  }

  const accessToken = getTastyTradeAccessToken_();
  if (accessToken) {
    const url = 'https://api.tastyworks.com/market-data/by-type?equity-option=' + encodeURIComponent(occSymbol);
    const resp = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: { Authorization: 'Bearer ' + accessToken, 'User-Agent': TASTY_USER_AGENT, Accept: 'application/json' },
      muteHttpExceptions: true
    });
    output += '--- TastyTrade HTTP ' + resp.getResponseCode() + ' ---\n' + resp.getContentText().substring(0, 1500) + '\n\n';
  } else {
    output += '--- TastyTrade ---\nNo credentials.\n\n';
  }

  output += '--- Yahoo Option ---\n' + JSON.stringify(
    fetchYahooQuote_(ticker, parsedExpiry, parsedStrike.strike, parsedStrike.type), null, 2
  );

  Logger.log(output);
  ui.alert('Debug Output', output.substring(0, 5000), ui.ButtonSet.OK);
}


/* ============================================================================
 * PARSING / OCC SYMBOL — unchanged
 * ========================================================================== */

function parseStrikeCell_(value) {
  const m = String(value).match(/\$?\s*([\d,.]+)\s*([CP])/i);
  if (!m) return null;
  return { strike: parseFloat(m[1].replace(/,/g, '')), type: m[2].toUpperCase() };
}

function parseExpiryCell_(value) {
  if (value instanceof Date) {
    // A raw Date straight from a Sheets date-typed cell sits at midnight.
    // buildOccSymbol_ later formats it via Utilities.formatDate in the
    // script's own timezone — and midnight has ZERO buffer before any
    // timezone mismatch (even a few hours) rolls the formatted date to
    // the PREVIOUS calendar day, producing an OCC symbol for a contract
    // that doesn't exist (confirmed via Debug: Fetch Raw Quote — a
    // 3/19/2027 expiry cell produced OCC date 270318, one day early).
    // Re-anchoring to noon in the script's own timezone — reading the
    // year/month/day as they'd actually display here, then rebuilding
    // at noon — gives ~11 hours of buffer either direction, matching
    // the string-parsing path below, which already does this
    // deliberately for the same reason.
    const tz = Session.getScriptTimeZone();
    const y = Number(Utilities.formatDate(value, tz, 'yyyy'));
    const mo = Number(Utilities.formatDate(value, tz, 'MM')) - 1;
    const da = Number(Utilities.formatDate(value, tz, 'dd'));
    return new Date(y, mo, da, 12, 0, 0);
  }
  const s = String(value).trim();
  const m = s.match(/([A-Za-z]{3,9})\s+(\d{1,2})\D*'?(\d{2,4})/);

  if (!m) {
    const numeric = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
    if (numeric) {
      let year = numeric[3];
      if (year.length === 2) year = '20' + year;
      const d = new Date(Number(year), Number(numeric[1]) - 1, Number(numeric[2]), 12, 0, 0);
      return isNaN(d.getTime()) ? null : d;
    }
    return null;
  }

  let mon = m[1], day = m[2], yr = m[3];
  if (yr.length === 2) yr = '20' + yr;
  const d = new Date(mon + ' ' + day + ', ' + yr + ' 12:00:00');
  return isNaN(d.getTime()) ? null : d;
}

function buildOccSymbol_(ticker, expiryDate, strike, type) {
  const tz = Session.getScriptTimeZone();
  const yy = Utilities.formatDate(expiryDate, tz, 'yy');
  const mm = Utilities.formatDate(expiryDate, tz, 'MM');
  const dd = Utilities.formatDate(expiryDate, tz, 'dd');
  const root = ticker.toUpperCase().padEnd(6, ' ');
  const strikeStr = String(Math.round(strike * 1000)).padStart(8, '0');
  return root + yy + mm + dd + type + strikeStr;
}


/* ============================================================================
 * TASTYTRADE
 * ========================================================================== */

const TASTY_USER_AGENT = 'options-portfolio-validator/1.0';

// Ensures the ScriptLog write below fires once per script execution, not
// once per call — getTastyTradeAccessToken_ can be hit repeatedly across
// many rows (especially now that a 401 triggers a retry-with-refresh),
// and if the credentials are genuinely broken, logging every single
// attempt would flood ScriptLog with duplicate entries.
let TASTY_REFRESH_FAILURE_LOGGED_ = false;

function getTastyTradeAccessToken_() {
  // Cached with a conservative TTL — every top-level action in this
  // project (Validate & Update, Scan Chain, Hedge, Research) calls this
  // independently, and it's common to run several of them back-to-back
  // within a few minutes (e.g. from the Mobile Remote). Without this,
  // that's a full OAuth handshake repeated for a token that's very
  // likely still valid. 15 minutes is a deliberately safe, conservative
  // choice — if TastyTrade calls ever start failing partway through a
  // run, this is the first place to check (shorten the TTL, or remove
  // it) since it's the only new source of a potentially-stale token.
  const cache = CacheService.getScriptCache();
  const cachedToken = cache.get('TASTY_ACCESS_TOKEN');
  if (cachedToken) return cachedToken;

  const props = PropertiesService.getScriptProperties();
  const clientSecret = props.getProperty('TASTY_CLIENT_SECRET');
  const refreshToken = props.getProperty('TASTY_REFRESH_TOKEN');
  if (!clientSecret || !refreshToken) {
    if (!TASTY_REFRESH_FAILURE_LOGGED_) {
      TASTY_REFRESH_FAILURE_LOGGED_ = true;
      logToSheet_('TastyTrade: ' +
        (!clientSecret && !refreshToken ? 'TASTY_CLIENT_SECRET and TASTY_REFRESH_TOKEN are both' :
          !clientSecret ? 'TASTY_CLIENT_SECRET is' : 'TASTY_REFRESH_TOKEN is') +
        ' not set in Script Properties \u2014 nothing was ever sent to TastyTrade this run.');
    }
    return null;
  }

  const resp = UrlFetchApp.fetch('https://api.tastyworks.com/oauth/token', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'User-Agent': TASTY_USER_AGENT },
    payload: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken, client_secret: clientSecret }),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 200) {
    Logger.log('TastyTrade token refresh failed: ' + resp.getContentText());
    // Logged to the ScriptLog sheet too (once per run, not once per
    // call, since this can be hit repeatedly across many rows if the
    // credentials are genuinely broken) — Logger.log alone only reaches
    // Apps Script's internal execution log, which isn't where anyone
    // actually looks day to day.
    if (!TASTY_REFRESH_FAILURE_LOGGED_) {
      TASTY_REFRESH_FAILURE_LOGGED_ = true;
      logToSheet_('TastyTrade token refresh failed (HTTP ' + resp.getResponseCode() + '): ' +
        resp.getContentText().substring(0, 500) +
        ' \u2014 if this says invalid_grant or similar, your TASTY_REFRESH_TOKEN needs to be regenerated.');
    }
    return null;
  }
  const token = JSON.parse(resp.getContentText()).access_token;
  if (token) cache.put('TASTY_ACCESS_TOKEN', token, 900); // 15 minutes
  return token;
}

// Wraps a GET request to a TastyTrade endpoint with automatic retry-on-
// 401: if accessToken turns out to be stale (revoked, or genuinely
// expired sooner than the 15-minute cache above assumed), this clears
// the cached token, fetches a genuinely fresh one, and retries the SAME
// request once with it. Every TastyTrade fetch in this project goes
// through this one place, so a stale cached token can no longer cause a
// silent, total failure across an entire run — confirmed as the root
// cause of an earlier run reporting 0 successful TastyTrade fetches out
// of 24 rows, with every row falling back to the more fragile,
// rate-limited Yahoo path instead. Returns the same HTTPResponse object
// UrlFetchApp.fetch would — callers parse it exactly as before; this
// only changes what happens on a 401.
function fetchTastyWithRetry_(url, accessToken) {
  const headers = { Authorization: 'Bearer ' + accessToken, 'User-Agent': TASTY_USER_AGENT, Accept: 'application/json' };
  let resp = UrlFetchApp.fetch(url, { method: 'get', headers: headers, muteHttpExceptions: true });

  if (resp.getResponseCode() === 401) {
    CacheService.getScriptCache().remove('TASTY_ACCESS_TOKEN');
    const freshToken = getTastyTradeAccessToken_();
    if (freshToken && freshToken !== accessToken) {
      const freshHeaders = { Authorization: 'Bearer ' + freshToken, 'User-Agent': TASTY_USER_AGENT, Accept: 'application/json' };
      resp = UrlFetchApp.fetch(url, { method: 'get', headers: freshHeaders, muteHttpExceptions: true });
    }
  }

  return resp;
}

// Returns true only for a finite, non-NaN number within [min, max]
// (either bound optional). Used throughout the fetch functions below to
// reject clearly-impossible values — a negative price, an out-of-range
// Greek, a mis-scaled IV — right at the source, before a bad reading from
// one source either gets merged in directly or (worse) blocks a genuinely
// good fallback source from ever being tried. Same idea as the OI fix
// above, applied consistently everywhere a value has a known-possible
// range.
function isPlausible_(value, min, max) {
  if (value == null || isNaN(value)) return false;
  if (min != null && value < min) return false;
  if (max != null && value > max) return false;
  return true;
}

// Option quote — now also carries volume (tries 'volume', falls back to
// 'day-volume' since TastyTrade's schema for this field isn't consistently
// documented; use Debug: Fetch Raw Quote to confirm the real key if this
// ever comes back null while TastyTrade credentials are otherwise working).
function fetchTastyTradeQuote_(occSymbol, accessToken) {
  if (!accessToken) return null;

  const url = 'https://api.tastyworks.com/market-data/by-type?equity-option=' + encodeURIComponent(occSymbol);
  const resp = fetchTastyWithRetry_(url, accessToken);

  if (resp.getResponseCode() !== 200) return null;

  const json = JSON.parse(resp.getContentText());
  const item = json.data && json.data.items && json.data.items[0];
  if (!item) return null;

  const bid = parseFloat(item.bid);
  const ask = parseFloat(item.ask);
  const rawDelta = item.delta != null ? parseFloat(item.delta) : null;
  const rawGamma = item.gamma != null ? parseFloat(item.gamma) : null;

  // Per-contract IV — confirmed via Debug: Fetch Raw Quote that
  // TastyTrade's market-data/by-type endpoint uses the key "volatility"
  // for this, not "implied-volatility" or "iv" as originally guessed —
  // that mismatch meant IV silently never resolved from TastyTrade,
  // which in turn meant the "TastyTrade: X" completion count (which
  // requires IV specifically to have come from TastyTrade) always
  // reported 0 regardless of how well the rest of the quote performed.
  // Kept the old candidates too in case the key differs across response
  // shapes. Assumes a fraction (0.35 = 35%), TastyTrade's convention
  // elsewhere. If this ever stays null again, Current IV silently falls
  // back to Yahoo's contract IV — nothing breaks, it just uses the other
  // source.
  const contractIvRaw = item['implied-volatility'] != null ? item['implied-volatility'] :
    (item.iv != null ? item.iv : (item.volatility != null ? item.volatility : null));
  const contractIv = contractIvRaw != null ? parseFloat(contractIvRaw) * 100 : null;

  const volumeRaw = item.volume != null ? item.volume : (item['day-volume'] != null ? item['day-volume'] : null);
  const volume = volumeRaw != null ? parseInt(volumeRaw, 10) : null;

  // Open Interest — same defensive key-guessing as above, plus a sanity
  // floor: an options market can never have negative open contracts, so a
  // negative value here means the field/response is malformed and gets
  // dropped (null) rather than trusted.
  const oiRaw = item['open-interest'] != null ? item['open-interest'] : (item.openInterest != null ? item.openInterest : null);
  const openInterest = oiRaw != null ? parseInt(oiRaw, 10) : null;

  const mark = item.mark != null ? parseFloat(item.mark) : (!isNaN(bid) && !isNaN(ask) ? (bid + ask) / 2 : null);

  return {
    // An option's mark/premium can be a few cents but never negative.
    mark: isPlausible_(mark, 0, null) ? mark : null,
    // A real broker delta for a vanilla option is always in [-1, 1] —
    // anything outside that is a corrupted/mis-scaled reading, and
    // rejecting it here lets the row correctly fall through to the
    // Black-Scholes estimate instead of writing garbage.
    delta: isPlausible_(rawDelta, -1, 1) ? rawDelta : null,
    // Gamma is never negative; the generous upper bound just catches
    // outright garbage, not tight-DTE gamma spikes.
    gamma: isPlausible_(rawGamma, 0, 10) ? rawGamma : null,
    contractIv: isPlausible_(contractIv, 0.01, 1000) ? contractIv : null,
    bid: isPlausible_(bid, 0, null) ? bid : null,
    ask: isPlausible_(ask, 0, null) ? ask : null,
    volume: isPlausible_(volume, 0, null) ? volume : null,
    openInterest: isPlausible_(openInterest, 0, null) ? openInterest : null,
    source: 'TastyTrade'
  };
}


function fetchTastyEquityQuote_(ticker, accessToken) {
  if (!accessToken) return null;

  const url = 'https://api.tastyworks.com/market-data/by-type?equity=' + encodeURIComponent(ticker);
  const resp = fetchTastyWithRetry_(url, accessToken);

  if (resp.getResponseCode() !== 200) return null;

  const json = JSON.parse(resp.getContentText());
  const item = json.data && json.data.items && json.data.items[0];
  if (!item) return null;

  const bid = parseFloat(item.bid);
  const ask = parseFloat(item.ask);
  const last = item.last != null ? parseFloat(item.last) : null;
  const mark = item.mark != null ? parseFloat(item.mark) : (!isNaN(bid) && !isNaN(ask) ? (bid + ask) / 2 : null);
  const currentPrice = (last != null && !isNaN(last)) ? last : mark;
  // A stock price can be a few cents but never zero or negative — reject
  // an invalid reading here so the row falls through to Yahoo's
  // underlying price instead of writing garbage.
  const validPrice = isPlausible_(currentPrice, 0.01, null) ? currentPrice : null;

  const prevCloseRaw =
    item['prev-close'] != null ? item['prev-close'] :
    item['previous-close'] != null ? item['previous-close'] :
    item['close-price'] != null ? item['close-price'] :
    item.close != null ? item.close : null;

  const prevClose = prevCloseRaw != null ? parseFloat(prevCloseRaw) : null;

  let change = null, changePercent = null;
  if (validPrice != null && prevClose != null && !isNaN(prevClose) && prevClose !== 0) {
    change = validPrice - prevClose;
    changePercent = (change / prevClose) * 100;
  }

  return { price: validPrice, change: change, changePercent: changePercent, source: 'TastyTrade' };
}

function fetchTastyMarketMetrics_(ticker, accessToken) {
  if (!accessToken) return null;

  const url = 'https://api.tastyworks.com/market-metrics?symbols=' + encodeURIComponent(ticker);
  const resp = fetchTastyWithRetry_(url, accessToken);

  if (resp.getResponseCode() !== 200) return null;

  const json = JSON.parse(resp.getContentText());
  const item = json.data && json.data.items && json.data.items[0];
  if (!item) return null;

  const ivRank = item['implied-volatility-rank'] != null ? parseFloat(item['implied-volatility-rank']) : null;
  const ivIndex = item['implied-volatility-index'] != null ? parseFloat(item['implied-volatility-index']) : null;
  const raw = ivRank != null ? ivRank : ivIndex;
  if (raw == null || isNaN(raw)) return null;

  const ivPercent = raw <= 1 ? raw * 100 : raw;
  // Can't legitimately be negative, whether this is a Rank (bounded 0-100)
  // or an Index (unbounded — a very volatile name can genuinely show
  // 100+), so only the lower bound is enforced here. There's no free
  // fallback source for this metric, so an invalid reading just means the
  // column stays blank this run rather than showing something impossible.
  if (!isPlausible_(ivPercent, 0, null)) return null;

  return { ivPercent: ivPercent, source: 'TastyTrade (underlying IV Rank)' };
}


/* ============================================================================
 * YAHOO
 * ========================================================================== */

// Option chain — now also returns volume from the matched contract.
function fetchYahooQuote_(ticker, expiryDate, strike, type) {
  const expiryUnix = Math.floor(expiryDate.getTime() / 1000);
  const urls = [
    'https://query1.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(ticker) + '?date=' + expiryUnix,
    'https://query2.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(ticker) + '?date=' + expiryUnix
  ];

  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = UrlFetchApp.fetch(urls[u], {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.optionChain && json.optionChain.result && json.optionChain.result[0];
      if (!result || !result.options || !result.options[0]) continue;

      const chain = type === 'C' ? result.options[0].calls : result.options[0].puts;
      const match = (chain || []).find(function (c) { return Math.abs(c.strike - strike) < 0.01; });
      if (!match) continue;

      let mark = null;
      if (match.bid != null && match.ask != null && !isNaN(parseFloat(match.bid)) && !isNaN(parseFloat(match.ask))) {
        mark = (parseFloat(match.bid) + parseFloat(match.ask)) / 2;
      } else if (match.lastPrice != null) {
        mark = parseFloat(match.lastPrice);
      }

      const rawIv = match.impliedVolatility != null ? parseFloat(match.impliedVolatility) * 100 : null;
      const rawUnderlying = result.quote && result.quote.regularMarketPrice != null ? parseFloat(result.quote.regularMarketPrice) : null;
      const rawBid = match.bid != null ? parseFloat(match.bid) : null;
      const rawAsk = match.ask != null ? parseFloat(match.ask) : null;

      return {
        mark: isPlausible_(mark, 0, null) ? mark : null,
        iv: isPlausible_(rawIv, 0.01, 1000) ? rawIv : null,
        oi: isPlausible_(match.openInterest, 0, null) ? match.openInterest : null,
        volume: isPlausible_(match.volume, 0, null) ? parseInt(match.volume, 10) : null,
        bid: isPlausible_(rawBid, 0, null) ? rawBid : null,
        ask: isPlausible_(rawAsk, 0, null) ? rawAsk : null,
        underlying: isPlausible_(rawUnderlying, 0.01, null) ? rawUnderlying : null,
        source: 'Yahoo Finance (unofficial)'
      };
    } catch (err) {
      Logger.log('Yahoo option error: ' + err);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Fetches every available expiration date for a ticker, plus the current
// underlying price, via the same v7/finance/options endpoint fetchYahooQuote_
// uses. IMPORTANT: passes ?date=<today> rather than omitting the param —
// omitting it entirely turned out to fail outright (even for AAPL), while
// Yahoo's `expirationDates` field is always the FULL list regardless of
// which single date you pass; the date param only controls which one
// expiry's chain gets embedded in `options[0]`, which this function
// ignores anyway. Used by the chain scanner to know which expiries even
// exist before deciding which ones to pull in full.
// ----------------------------------------------------------------------------
function fetchYahooExpirationDatesForScanner_(ticker) {
  const todayUnix = Math.floor(new Date().getTime() / 1000);
  const urls = [
    'https://query1.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(ticker) + '?date=' + todayUnix,
    'https://query2.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(ticker) + '?date=' + todayUnix
  ];

  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = UrlFetchApp.fetch(urls[u], {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.optionChain && json.optionChain.result && json.optionChain.result[0];
      if (!result || !result.expirationDates || !result.expirationDates.length) continue;

      const rawUnderlying = result.quote && result.quote.regularMarketPrice != null ? parseFloat(result.quote.regularMarketPrice) : null;

      return {
        dates: result.expirationDates.map(function (unixSec) { return new Date(unixSec * 1000); }),
        underlying: isPlausible_(rawUnderlying, 0.01, null) ? rawUnderlying : null
      };
    } catch (err) {
      Logger.log('Yahoo expiration-dates error for ' + ticker + ': ' + err);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Fetches the FULL chain (every strike) for one ticker + specific expiry +
// option type — unlike fetchYahooQuote_ above, which filters straight down
// to a single matching strike. Used by the chain scanner to evaluate every
// strike at a qualifying expiry against the minimum-delta floor.
// ----------------------------------------------------------------------------
function fetchYahooFullChainForScannerExpiry_(ticker, expiryDate, type) {
  const expiryUnix = Math.floor(expiryDate.getTime() / 1000);
  const urls = [
    'https://query1.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(ticker) + '?date=' + expiryUnix,
    'https://query2.finance.yahoo.com/v7/finance/options/' + encodeURIComponent(ticker) + '?date=' + expiryUnix
  ];

  for (let u = 0; u < urls.length; u++) {
    try {
      const resp = UrlFetchApp.fetch(urls[u], {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.optionChain && json.optionChain.result && json.optionChain.result[0];
      if (!result || !result.options || !result.options[0]) continue;

      const chain = type === 'C' ? result.options[0].calls : result.options[0].puts;
      const rawUnderlying = result.quote && result.quote.regularMarketPrice != null ? parseFloat(result.quote.regularMarketPrice) : null;

      return {
        contracts: chain || [],
        underlying: isPlausible_(rawUnderlying, 0.01, null) ? rawUnderlying : null
      };
    } catch (err) {
      Logger.log('Yahoo full-chain error for ' + ticker + ' @ ' + expiryDate + ': ' + err);
    }
  }
  return null;
}

// ----------------------------------------------------------------------------
// Scans up to CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN qualifying expirations for one
// ticker/type and returns the single contract with the highest open
// interest among everything meeting minDelta + minExpiryDays — or null if
// ----------------------------------------------------------------------------
// TastyTrade's nested option chain — ONE authenticated call returns every
// expiration and every strike (with each side's OCC symbol) for a ticker,
// no per-strike network call needed just to discover what exists. Tried
// FIRST by the chain scanner (real broker data, no unauthenticated-endpoint
// flakiness) before falling back to the Yahoo functions above.
//
// Schema note: this is coded defensively against field-name variations
// (the nested endpoint has historically nested one extra "items" level in
// some accounts/API versions) — any parse failure just returns null,
// which sends the scanner to the Yahoo fallback rather than crashing. Use
// "🔎 Debug: Scan One Ticker's Chain" to see exactly what came back if
// this isn't finding anything for you.
// ----------------------------------------------------------------------------
function fetchTastyOptionChainNested_(ticker, accessToken) {
  if (!accessToken) return null;

  const url = 'https://api.tastyworks.com/option-chains/' + encodeURIComponent(ticker) + '/nested';
  let resp;
  try {
    resp = fetchTastyWithRetry_(url, accessToken);
  } catch (err) {
    Logger.log('TastyTrade nested chain request error for ' + ticker + ': ' + err);
    return null;
  }

  if (resp.getResponseCode() !== 200) {
    Logger.log('TastyTrade nested chain failed for ' + ticker + '. HTTP ' + resp.getResponseCode());
    return null;
  }

  try {
    const json = JSON.parse(resp.getContentText());
    const items = json.data && json.data.items;
    const rawExpirations =
      (items && items[0] && items[0].expirations) ? items[0].expirations :
      (json.data && json.data.expirations) ? json.data.expirations : null;
    if (!rawExpirations || !rawExpirations.length) return null;

    const expirations = rawExpirations.map(function (exp) {
      const dateStr = exp['expiration-date'];
      const date = dateStr ? new Date(dateStr + 'T12:00:00') : null;
      const strikes = (exp.strikes || []).map(function (s) {
        const strikePrice = s['strike-price'] != null ? parseFloat(s['strike-price']) : null;
        return { strike: strikePrice, callSymbol: s.call || null, putSymbol: s.put || null };
      }).filter(function (s) { return isPlausible_(s.strike, 0.01, null); });
      return { date: date, strikes: strikes };
    }).filter(function (e) { return e.date && !isNaN(e.date.getTime()) && e.strikes.length; });

    return expirations.length ? expirations : null;
  } catch (err) {
    Logger.log('TastyTrade nested chain parse error for ' + ticker + ': ' + err);
    return null;
  }
}

// Fetches real delta + open interest for many option OCC symbols in one
// batched request (chunked to keep each URL a reasonable length), reusing
// the same market-data/by-type endpoint fetchTastyTradeQuote_ already uses
// for a single symbol elsewhere in this script.
const TASTY_MARKET_DATA_BATCH_SIZE = 40;

function fetchTastyMarketDataBatch_(occSymbols, accessToken) {
  const map = {};
  if (!accessToken || !occSymbols.length) return map;

  for (let i = 0; i < occSymbols.length; i += TASTY_MARKET_DATA_BATCH_SIZE) {
    const chunk = occSymbols.slice(i, i + TASTY_MARKET_DATA_BATCH_SIZE);
    const params = chunk.map(function (s) { return 'equity-option=' + encodeURIComponent(s); }).join('&');
    const url = 'https://api.tastyworks.com/market-data/by-type?' + params;

    try {
      const resp = fetchTastyWithRetry_(url, accessToken);
      if (resp.getResponseCode() === 200) {
        const json = JSON.parse(resp.getContentText());
        const items = (json.data && json.data.items) || [];
        items.forEach(function (item) {
          const sym = item.symbol;
          if (!sym) return;
          const rawDelta = item.delta != null ? parseFloat(item.delta) : null;
          const oiRaw = item['open-interest'] != null ? item['open-interest'] : (item.openInterest != null ? item.openInterest : null);
          const bid = item.bid != null ? parseFloat(item.bid) : null;
          const ask = item.ask != null ? parseFloat(item.ask) : null;
          const volumeRaw = item.volume != null ? item.volume : (item['day-volume'] != null ? item['day-volume'] : null);
          map[sym] = {
            delta: isPlausible_(rawDelta, -1, 1) ? rawDelta : null,
            oi: isPlausible_(oiRaw, 0, null) ? Math.round(oiRaw) : null,
            bid: isPlausible_(bid, 0, null) ? bid : null,
            ask: isPlausible_(ask, 0, null) ? ask : null,
            volume: isPlausible_(volumeRaw, 0, null) ? Math.round(volumeRaw) : null
          };
        });
      } else {
        Logger.log('TastyTrade batch market data failed. HTTP ' + resp.getResponseCode());
      }
    } catch (err) {
      Logger.log('TastyTrade batch market data error: ' + err);
    }

    Utilities.sleep(150);
  }

  return map;
}

// Shared underlying-price lookup for the MinStrike floor/ceiling:
// TastyTrade's own equity quote first (real-time, when credentials are
// configured), Yahoo's expirations-call quote as a fallback otherwise.
function getUnderlyingPriceForScanner_(ticker, accessToken) {
  if (accessToken) {
    const eq = fetchTastyEquityQuote_(ticker, accessToken);
    if (eq && eq.price != null) return eq.price;
  }
  const yq = fetchYahooExpirationDatesForScanner_(ticker);
  return (yq && yq.underlying != null) ? yq.underlying : null;
}

// MinStrike means different things depending on type: for calls it's a
// FLOOR (strike >= price * pct%, protects against picking absurdly-low
// legacy/split-adjusted strikes); for puts it's a CEILING (strike <=
// price * (1 + pct%), the equivalent protection in the other direction,
// since a put's deep-ITM strikes sit ABOVE the current price). Returns
// { min, max } where either side can be null (no bound that direction).
function computeStrikeBounds_(type, minStrikePercent, underlying) {
  if (!(minStrikePercent > 0) || !isPlausible_(underlying, 0.01, null)) return { min: null, max: null };
  if (type === 'P') {
    return { min: null, max: underlying * (1 + minStrikePercent / 100) };
  }
  return { min: underlying * (minStrikePercent / 100), max: null };
}

// Picks the highest-OI contract from a TastyTrade nested chain — real
// delta and real OI throughout, no Black-Scholes estimate.
function findBestOiFromTastyChain_(ticker, type, minDelta, minExpiryDays, maxExpiryDays, minStrikePercent, runTimestamp, accessToken) {
  const expirations = fetchTastyOptionChainNested_(ticker, accessToken);
  if (!expirations) return null;

  // Always fetched now (not just when minStrikePercent > 0) — needed to
  // compute Extra (extrinsic value) below regardless of whether a strike
  // bound is active.
  const underlying = getUnderlyingPriceForScanner_(ticker, accessToken);
  const strikeBounds = computeStrikeBounds_(type, minStrikePercent, underlying);

  const qualifying = expirations
    .filter(function (e) {
      const dte = Math.round((e.date.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
      if (dte < minExpiryDays) return false;
      if (maxExpiryDays != null && dte > maxExpiryDays) return false;
      return true;
    })
    .sort(function (a, b) { return a.date.getTime() - b.date.getTime(); })
    .slice(0, CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN);
  if (!qualifying.length) return null;

  const bySymbol = {};
  qualifying.forEach(function (e) {
    e.strikes.forEach(function (s) {
      if (strikeBounds.min != null && s.strike < strikeBounds.min) return;
      if (strikeBounds.max != null && s.strike > strikeBounds.max) return;
      const sym = type === 'C' ? s.callSymbol : s.putSymbol;
      if (sym) bySymbol[sym] = { strike: s.strike, expiryDate: e.date };
    });
  });

  const symbols = Object.keys(bySymbol);
  if (!symbols.length) return null;

  const marketData = fetchTastyMarketDataBatch_(symbols, accessToken);

  let best = null;
  symbols.forEach(function (sym) {
    const md = marketData[sym];
    const info = bySymbol[sym];
    if (!md || md.delta == null || md.oi == null || md.oi < 1) return;
    if (Math.abs(md.delta) < minDelta) return;
    if (!best || md.oi > best.oi) {
      const mark = (md.bid != null && md.ask != null) ? (md.bid + md.ask) / 2 : null;
      best = {
        strike: info.strike, expiry: info.expiryDate, oi: md.oi, estDelta: md.delta, type: type,
        source: 'TastyTrade (real delta)', volume: md.volume, bid: md.bid, ask: md.ask,
        price: mark, underlying: underlying
      };
    }
  });

  return best;
}

// Picks the highest-OI contract from Yahoo's chain — estimated delta via
// Black-Scholes (Yahoo doesn't return real delta), used when TastyTrade
// isn't configured or didn't have this ticker/chain.
function findBestOiFromYahooChain_(ticker, type, minDelta, minExpiryDays, maxExpiryDays, minStrikePercent, runTimestamp) {
  const expiryInfo = fetchYahooExpirationDatesForScanner_(ticker);
  Utilities.sleep(120);
  if (!expiryInfo || !expiryInfo.dates.length) return null;

  const qualifyingDates = expiryInfo.dates
    .filter(function (d) {
      const dte = Math.round((d.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
      if (dte < minExpiryDays) return false;
      if (maxExpiryDays != null && dte > maxExpiryDays) return false;
      return true;
    })
    .sort(function (a, b) { return a.getTime() - b.getTime(); })
    .slice(0, CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN);

  let best = null;

  qualifyingDates.forEach(function (expiryDate) {
    const chainInfo = fetchYahooFullChainForScannerExpiry_(ticker, expiryDate, type);
    Utilities.sleep(120);
    if (!chainInfo || !chainInfo.contracts.length) return;

    const underlying = chainInfo.underlying || expiryInfo.underlying;
    const dte = Math.round((expiryDate.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
    if (!isPlausible_(underlying, 0.01, null) || dte <= 0) return;

    const strikeBounds = computeStrikeBounds_(type, minStrikePercent, underlying);

    chainInfo.contracts.forEach(function (c) {
      const strike = c.strike != null ? parseFloat(c.strike) : null;
      // Require real open interest — a 0-OI contract has never had a
      // position opened and shouldn't win a "best open interest" search
      // even as a last resort.
      const oi = isPlausible_(c.openInterest, 1, null) ? c.openInterest : null;
      const ivPct = c.impliedVolatility != null ? parseFloat(c.impliedVolatility) * 100 : null;
      if (!isPlausible_(strike, 0.01, null) || oi == null || !isPlausible_(ivPct, 0.01, 1000)) return;
      if (strikeBounds.min != null && strike < strikeBounds.min) return;
      if (strikeBounds.max != null && strike > strikeBounds.max) return;

      const estDelta = blackScholesDelta_(underlying, strike, dte, ivPct, type);
      if (estDelta == null || Math.abs(estDelta) < minDelta) return;

      if (!best || oi > best.oi) {
        const bid = isPlausible_(c.bid, 0, null) ? parseFloat(c.bid) : null;
        const ask = isPlausible_(c.ask, 0, null) ? parseFloat(c.ask) : null;
        const mark = (bid != null && ask != null) ? (bid + ask) / 2 : (isPlausible_(c.lastPrice, 0, null) ? c.lastPrice : null);
        best = {
          strike: strike, expiry: expiryDate, oi: oi, estDelta: estDelta, dte: dte, type: type,
          source: 'Yahoo (estimated delta)', volume: isPlausible_(c.volume, 0, null) ? c.volume : null,
          bid: bid, ask: ask, price: mark, underlying: underlying, ivPercent: ivPct
        };
      }
    });
  });

  return best;
}

// ----------------------------------------------------------------------------
// Top-level picker: TastyTrade first (real delta/OI), Yahoo fallback
// (estimated delta) if TastyTrade isn't configured or comes back empty.
// nothing qualifies anywhere in the scanned window.
// ----------------------------------------------------------------------------
function findHighestOiContractForScanner_(ticker, type, minDelta, minExpiryDays, maxExpiryDays, minStrikePercent, runTimestamp, accessToken) {
  if (accessToken) {
    const tastyResult = findBestOiFromTastyChain_(ticker, type, minDelta, minExpiryDays, maxExpiryDays, minStrikePercent, runTimestamp, accessToken);
    if (tastyResult) return tastyResult;
  }
  return findBestOiFromYahooChain_(ticker, type, minDelta, minExpiryDays, maxExpiryDays, minStrikePercent, runTimestamp);
}

// ----------------------------------------------------------------------------
/* ============================================================================
 * CLOUD FUNCTION BEST-OI BATCH PREFETCH (for "Scan Chain by Delta / OI")
 * ----------------------------------------------------------------------------
 * Same shared Cloud Function as the other prefetch helpers in this
 * project. Sends every row's ticker in ONE request; the Cloud Function
 * scans them concurrently (TastyTrade nested chain + batch market data
 * per ticker, same logic as findBestOiFromTastyChain_, just many tickers
 * at once instead of one row at a time). Fully optional and fails soft —
 * returns an empty map on any problem, so the per-row loop's own
 * `bestOiMap[ticker] || findHighestOiContractForScanner_(...)` falls back
 * to fetching individually (with its own Tasty+Yahoo fallback intact)
 * exactly as before.
 * ========================================================================== */
function prefetchBestOiViaCloudFunction_(sheet, map, lastRow, settings) {
  const cloudFunctionUrl = getCloudFunctionUrl_();
  const sharedSecret = getCloudFunctionSharedSecret_();
  if (!cloudFunctionUrl || !sharedSecret) return {};

  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return {};

  const tickerValues = sheet.getRange(DATA_START_ROW, map.ticker, numRows, 1).getValues();
  const entryPriceValues = map.entryPrice ? sheet.getRange(DATA_START_ROW, map.entryPrice, numRows, 1).getValues() : null;

  const tickerSet = {};
  for (let i = 0; i < numRows; i++) {
    const tickerVal = tickerValues[i][0];
    if (!tickerVal) continue;
    // Skip active-position rows, matching the per-row loop's own check —
    // no point fetching a fresh best-OI pick for a row we won't write to.
    if (entryPriceValues) {
      const entryPriceVal = parseFloat(entryPriceValues[i][0]);
      if (isPlausible_(entryPriceVal, 0.01, null)) continue;
    }
    tickerSet[String(tickerVal).trim().toUpperCase()] = true;
  }
  const tickers = Object.keys(tickerSet);
  if (!tickers.length) return {};

  const startTime = Date.now();
  let resp;
  try {
    resp = UrlFetchApp.fetch(cloudFunctionUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        apiKey: sharedSecret,
        bestOiScan: {
          tickers: tickers, type: settings.type, minDelta: settings.minDelta,
          minExpiryDays: settings.minExpiryDays, maxExpiryDays: settings.maxExpiryDays,
          minStrikePercent: settings.minStrikePercent
        }
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    logToSheet_('Cloud Function best-OI prefetch FAILED (network error) \u2014 falling back to per-row scanning: ' + e);
    return {};
  }

  if (resp.getResponseCode() !== 200) {
    logToSheet_('Cloud Function best-OI prefetch FAILED (HTTP ' + resp.getResponseCode() + ') \u2014 falling back to per-row scanning: ' +
      resp.getContentText().substring(0, 300));
    return {};
  }

  let json;
  try {
    json = JSON.parse(resp.getContentText());
  } catch (e) {
    logToSheet_('Cloud Function best-OI prefetch FAILED (unparseable response) \u2014 falling back to per-row scanning: ' + e);
    return {};
  }

  const elapsedMs = Date.now() - startTime;
  const rawResults = json.bestOiResults || {};
  const errorCount = Object.keys(json.bestOiErrors || {}).length;

  // Convert expiry back from the ISO string the Cloud Function sends into
  // a real Date object — everything downstream (scanDte math, sheet
  // writes) expects a Date, same as findHighestOiContractForScanner_'s
  // own return shape.
  const resultMap = {};
  Object.keys(rawResults).forEach(function (ticker) {
    const r = rawResults[ticker];
    resultMap[ticker] = {
      strike: r.strike, expiry: new Date(r.expiry), oi: r.oi, estDelta: r.estDelta, type: r.type,
      source: r.source, volume: r.volume, bid: r.bid, ask: r.ask, price: r.price, underlying: r.underlying
    };
  });

  logToSheet_('Cloud Function best-OI prefetch: ' + tickers.length + ' ticker(s) requested in ' + elapsedMs + 'ms \u2014 ' +
    Object.keys(resultMap).length + ' found a contract' +
    (errorCount ? (', ' + errorCount + ' had no match or failed (will retry individually)') : '') + '.');

  const diag = json.bestOiDiagnostics || {};
  if (diag.tasty) {
    logToSheet_('Cloud Function best-OI prefetch \u2014 sample failure reason: ' + diag.tasty);
  }

  return resultMap;
}

// Menu-triggered entry point ("🎯 Scan Chain by Delta / OI"). For every row
// with a ticker and an existing Strike cell (needs at least a C/P suffix
// to know which side of the chain to search, e.g. a placeholder like
// "$0C"), finds the highest-OI contract meeting this sheet's Input-tab
// floors and overwrites that row's Strike/Expiry with it.
// ----------------------------------------------------------------------------
function scanOptionChainForBestOi(sheetOverride, timeBudgetMsOverride) {
  const sheet = sheetOverride || SpreadsheetApp.getActiveSheet();
  const map = getColumnMap_(sheet);
  const ui = tryGetUi_();

  if (!map.ticker || !map.strike || !map.expiry) {
    notify_(ui, 'Chain scanner', 'Missing Ticker, Strike, or Expiry column on "' + sheet.getName() + '" — can\'t run the chain scanner.');
    return;
  }

  let settings;
  try {
    settings = readChainScannerSettings_(sheet.getName());
  } catch (e) {
    notify_(ui, 'Chain scanner', e.message);
    return;
  }

  const lastRow = sheet.getLastRow();
  const runTimestamp = new Date();
  const accessToken = getTastyTradeAccessToken_();
  const scriptStartTime = Date.now();
  const timeBudgetMs = timeBudgetMsOverride || EXECUTION_TIME_BUDGET_MS;

  let updated = 0, noMatch = 0, skipped = 0, skippedActive = 0, fromTasty = 0, fromYahoo = 0;
  let lastRowProcessed = DATA_START_ROW - 1;
  let timeBudgetExceeded = false;

  // Cloud Function batch prefetch: finds every row's best-OI contract
  // concurrently across TICKERS, instead of one row fully finishing
  // (nested chain + batch market data + underlying price) before the
  // next one starts. TastyTrade-only — the per-row loop below still
  // falls back to its own existing findHighestOiContractForScanner_
  // (which also tries Yahoo) for any ticker this didn't cover, so
  // nothing loses coverage if the Cloud Function is unavailable or
  // misses a specific ticker.
  const bestOiMap = prefetchBestOiViaCloudFunction_(sheet, map, lastRow, settings);

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    if (Date.now() - scriptStartTime > timeBudgetMs) {
      timeBudgetExceeded = true;
      break;
    }
    lastRowProcessed = row;

    const tickerVal = sheet.getRange(row, map.ticker).getValue();
    if (!tickerVal) { skipped++; continue; }

    // Don't touch Strike/Expiry for a row you're already IN — a non-blank
    // Entry Price means this row is an active position, not a candidate
    // to keep re-picking a "best OI" contract for. See getColumnMap_'s
    // entryPrice aliases (includes plain "Entry").
    if (map.entryPrice) {
      const entryPriceVal = parseFloat(sheet.getRange(row, map.entryPrice).getValue());
      if (isPlausible_(entryPriceVal, 0.01, null)) {
        skippedActive++;
        continue;
      }
    }

    const ticker = String(tickerVal).trim().toUpperCase();
    const best = bestOiMap[ticker] || findHighestOiContractForScanner_(
      ticker, settings.type, settings.minDelta, settings.minExpiryDays, settings.maxExpiryDays, settings.minStrikePercent, runTimestamp, accessToken
    );

    if (!best) {
      noMatch++;
      continue;
    }

    if (best.source && best.source.indexOf('TastyTrade') === 0) fromTasty++; else fromYahoo++;
    sheet.getRange(row, map.strike).setValue('$' + round2_(best.strike) + best.type);
    sheet.getRange(row, map.expiry).setValue(best.expiry);

    // Days — pure date math, free, written now for instant feedback;
    // Validate & Update also refreshes this every run since it changes
    // daily even when Strike/Expiry don't move.
    const scanDte = Math.round((best.expiry.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
    if (map.daysToExpiry) sheet.getRange(row, map.daysToExpiry).setValue(scanDte);

    if (map.volume && best.volume != null) sheet.getRange(row, map.volume).setValue(Math.round(best.volume));
    if (map.oi) sheet.getRange(row, map.oi).setValue(best.oi);
    // Initial Price from the scan — Validate & Update is still the
    // authoritative, continuously-refreshed source for this; this just
    // avoids a blank cell between scanning and your next validate run.
    if (map.optionPrice && best.price != null) sheet.getRange(row, map.optionPrice).setValue(round2_(best.price));

    // Extra (extrinsic value) — needs option price + underlying price,
    // both already in hand from the scan, no extra call.
    if (map.extrinsicValue && best.price != null && best.underlying != null) {
      const intrinsic = best.type === 'C'
        ? Math.max(best.underlying - best.strike, 0)
        : Math.max(best.strike - best.underlying, 0);
      sheet.getRange(row, map.extrinsicValue).setValue(round2_(best.price - intrinsic));
    }

    // Slippage (bid/ask spread, as % of price) — same fraction-stored/
    // percent-formatted convention Validate & Update uses elsewhere.
    if (map.bidAskSpread && best.bid != null && best.ask != null && best.price) {
      const spreadPct = ((best.ask - best.bid) / best.price) * 100;
      const spreadCell = sheet.getRange(row, map.bidAskSpread);
      spreadCell.setValue(Math.round(spreadPct * 100) / 10000);
      spreadCell.setNumberFormat('0.00%');
    }

    // IV Rank — a per-underlying metric (TastyTrade market-metrics), not
    // per-contract, so this is one extra call per row — only when
    // TastyTrade is configured (no free Yahoo equivalent exists for it).
    if (map.ivRank && accessToken) {
      const ivMetrics = fetchTastyMarketMetrics_(ticker, accessToken);
      Utilities.sleep(120);
      if (ivMetrics && ivMetrics.ivPercent != null) {
        const ivCell = sheet.getRange(row, map.ivRank);
        ivCell.setValue(Math.round(ivMetrics.ivPercent * 100) / 10000);
        ivCell.setNumberFormat('0.00%');
      }
    }

    updated++;
  }

  const strikeBoundLabel = settings.type === 'P'
    ? ('Max Strike ' + settings.minStrikePercent + '% above price')
    : ('Min Strike ' + settings.minStrikePercent + '% of price');

  notify_(ui, 'Chain scan complete (' + sheet.getName() + ')',
    (timeBudgetExceeded
      ? ('⏱️ Stopped early to stay under Google\'s execution time limit — reached row ' + lastRowProcessed + ' of ' +
          lastRow + '. Run this again to continue with the rest.\n\n')
      : '') +
    'Scanned as: ' + settings.type + ' | Min Delta ' + settings.minDelta + ' | Min Expiry ' + settings.minExpiryDays + 'd' +
      (settings.maxExpiryDays != null ? (' | Max Expiry ' + settings.maxExpiryDays + 'd') : '') +
      ' | ' + strikeBoundLabel + '\n\n' +
    'Updated: ' + updated + ' row(s) (' + fromTasty + ' from TastyTrade, ' + fromYahoo + ' from Yahoo)\n' +
    'No contract met the floors within the nearest ' +
      CHAIN_SCANNER_MAX_EXPIRIES_TO_SCAN + ' expirations: ' + noMatch + '\n' +
    'Skipped (no ticker): ' + skipped + '\n' +
    'Skipped (active position — Entry has a value): ' + skippedActive + '\n\n' +
    'Run Validate & Update next to pull fresh data for the new strikes/expiries.'
  );
}

function fetchYahooPriceChange_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=price&formatted=true&lang=en-US&region=US',
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=price&formatted=true&lang=en-US&region=US'
  ];

  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get',
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
      if (!result || !result.price) continue;

      const priceModule = result.price;
      const currentPrice = getRawYahooValue_(priceModule.regularMarketPrice);
      const change = getRawYahooValue_(priceModule.regularMarketChange);
      const changePercentRaw = getRawYahooValue_(priceModule.regularMarketChangePercent);
      const changePercent = changePercentRaw != null ? changePercentRaw * 100 : null;

      if (changePercent == null || isNaN(changePercent)) continue;

      return { price: currentPrice, change: change, changePercent: changePercent, source: 'Yahoo Finance (unofficial)' };
    } catch (err) {
      Logger.log('Yahoo price change error: ' + err);
    }
  }
  return null;
}

// Lean per-ticker Change %/$ lookup — TastyTrade first (real-time,
// when credentials are configured), Yahoo as the ONE fallback. No FMP
// here deliberately: this is specifically the efficiency-focused path
// for %age/Value, so it stops at two sources instead of the four-deep
// chain other fields use.
function fetchChangeDataForTicker_(ticker, accessToken) {
  if (accessToken) {
    const eq = fetchTastyEquityQuote_(ticker, accessToken);
    if (eq && eq.changePercent != null && !isNaN(eq.changePercent)) {
      return { changePercent: eq.changePercent, changeAbsolute: eq.change, source: 'TastyTrade' };
    }
  }
  const yahooChange = fetchYahooPriceChange_(ticker);
  if (yahooChange && yahooChange.changePercent != null && !isNaN(yahooChange.changePercent)) {
    return { changePercent: yahooChange.changePercent, changeAbsolute: yahooChange.change, source: 'Yahoo Finance (unofficial)' };
  }
  return null;
}

// ----------------------------------------------------------------------------
// NEW: chart-based % change fetch — used specifically as the sector ETF
// change source (see getSectorEtfChangeCached_ below). Reuses the same
// v8/finance/chart endpoint fetchYahooDailyBars_ already relies on
// successfully elsewhere in this script; it does not require a crumb/cookie
// the way quoteSummary?modules=price increasingly does, which is what was
// causing Sector Momentum to show "N/A" across the board.
// meta.regularMarketPrice and meta.chartPreviousClose (falling back to
// meta.previousClose) are enough to compute a same-day % change with one
// lightweight call.
// ----------------------------------------------------------------------------
function fetchYahooChartChangePercent_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=1d&interval=1d',
    'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=1d&interval=1d'
  ];

  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get',
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.chart && json.chart.result && json.chart.result[0];
      const meta = result && result.meta;
      if (!meta) continue;

      const price = meta.regularMarketPrice != null ? parseFloat(meta.regularMarketPrice) : null;
      const prevCloseRaw = meta.chartPreviousClose != null ? meta.chartPreviousClose : meta.previousClose;
      const prevClose = prevCloseRaw != null ? parseFloat(prevCloseRaw) : null;

      if (!isPlausible_(price, 0.01, null) || !isPlausible_(prevClose, 0.01, null)) continue;

      const changePercent = ((price - prevClose) / prevClose) * 100;

      return {
        price: price,
        change: price - prevClose,
        changePercent: changePercent,
        source: 'Yahoo Finance (unofficial, chart)'
      };
    } catch (err) {
      Logger.log('Yahoo chart change error: ' + err);
    }
  }
  return null;
}

/* ============================================================================
 * DAILY OHLC BARS (feeds ATR% below; a future RSI/20 EMA/relative-strength-
 * vs-SPY column would reuse this exact same fetch — see SLOW_REFRESH_DAYS
 * .DAILYBARS. One Yahoo call gets ~2 months of daily bars, cached for a
 * full day since intraday re-fetches would return the same finished bars.
 * ========================================================================== */

function fetchYahooDailyBars_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=2mo&interval=1d',
    'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=2mo&interval=1d'
  ];

  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get',
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) continue;

      const ts = result.timestamp;
      const q = result.indicators.quote[0];
      const bars = [];

      for (let d = 0; d < ts.length; d++) {
  const high = q.high ? q.high[d] : null;
        const low = q.low ? q.low[d] : null;
        const close = q.close ? q.close[d] : null;
        // Volume: same Yahoo response, just wasn't being read before —
        // used by the Volume/relative-volume factor further down. Missing
        // volume doesn't disqualify the bar (high/low/close are what ATR
        // and RS actually need), it's just left null for that day.
        const volume = q.volume ? q.volume[d] : null;
        // Skips market holidays / partial days where Yahoo returns nulls
        // for that slot rather than omitting it entirely.
        if (!isPlausible_(high, 0, null) || !isPlausible_(low, 0, null) || !isPlausible_(close, 0, null)) continue;

        bars.push({
          date: Utilities.formatDate(new Date(ts[d] * 1000), 'America/New_York', 'yyyy-MM-dd'),
          high: high, low: low, close: close,
          volume: isPlausible_(volume, 0, null) ? volume : null
        });
      }

      if (bars.length < ATR_PERIOD + 1) continue; // not enough clean bars for a 14-period ATR
      return bars;
    } catch (err) {
      Logger.log('Yahoo daily bars error: ' + err);
    }
  }
  return null;
}

// Wilder's 14-day Average True Range as a % of the latest close — a
// volatility measure derived from actual price action, distinct from IV
// (which is derived from options pricing and reflects the market's
// forward-looking expectation, not realized range).
const ATR_PERIOD = 14;

function computeATRPercent_(bars) {
  if (!bars || bars.length < ATR_PERIOD + 1) return null;

  const trueRanges = [];
  for (let i = 1; i < bars.length; i++) {
    const prevClose = bars[i - 1].close;
    const high = bars[i].high;
    const low = bars[i].low;
    trueRanges.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }
  if (trueRanges.length < ATR_PERIOD) return null;

  // Wilder smoothing: seed with a simple average of the first PERIOD true
  // ranges, then smooth the remainder.
  let atr = trueRanges.slice(0, ATR_PERIOD).reduce(function (a, b) { return a + b; }, 0) / ATR_PERIOD;
  for (let i = ATR_PERIOD; i < trueRanges.length; i++) {
    atr = (atr * (ATR_PERIOD - 1) + trueRanges[i]) / ATR_PERIOD;
  }

  const lastClose = bars[bars.length - 1].close;
  if (!isPlausible_(lastClose, 0.01, null)) return null;

  return (atr / lastClose) * 100;
}

// This ticker's RS_LOOKBACK_DAYS return minus SPY's return over the same
// window, in percentage points. Reuses the exact same daily bars fetched
// for ATR% (both this ticker's and SPY's — SPY's bars are cached the same
// way, fetched once and shared across every row in the run), so this is
// zero extra network cost beyond one shared SPY fetch per run/day.
function computeRelativeStrengthPercent_(tickerBars, spyBars, lookbackDays) {
  if (!tickerBars || !spyBars || tickerBars.length <= lookbackDays || spyBars.length <= lookbackDays) return null;

  const tickerNow = tickerBars[tickerBars.length - 1].close;
  const tickerThen = tickerBars[tickerBars.length - 1 - lookbackDays].close;
  const spyNow = spyBars[spyBars.length - 1].close;
  const spyThen = spyBars[spyBars.length - 1 - lookbackDays].close;

  if (!isPlausible_(tickerThen, 0.01, null) || !isPlausible_(spyThen, 0.01, null)) return null;

  const tickerReturn = ((tickerNow - tickerThen) / tickerThen) * 100;
  const spyReturn = ((spyNow - spyThen) / spyThen) * 100;

  return tickerReturn - spyReturn;
}

/* ============================================================================
 * QUICK/RISKY REVISED-FORMULA DATA HELPERS — all derived from the SAME
 * daily bars already fetched for ATR%/RS above (ticker's own + SPY's),
 * so every function below costs zero extra network calls. Ticker-level
 * (not sheet-specific), computed once per ticker per run in
 * getCachedTickerData_ and shared by both Quick and Risky rows.
 * ========================================================================== */

// This ticker's OWN N-day return (not relative to SPY, unlike RS above) —
// feeds the "Momentum" factor. lookbackDays defaults to a short window
// (see MOMENTUM_LOOKBACK_DAYS) since both sheets are day/swing-trade
// horizons.
const MOMENTUM_LOOKBACK_DAYS = 5;

// Forward window for the Historical Hit Rate heuristic — matches both
// Quick's and Risky's feasibilityMaxDays (5), so one computation serves
// both sheets without needing a sheet-specific ticker cache.
const HIT_RATE_FORWARD_DAYS = 5;

function computeMomentumPercent_(tickerBars, lookbackDays) {
  if (!tickerBars || tickerBars.length <= lookbackDays) return null;
  const now = tickerBars[tickerBars.length - 1].close;
  const then = tickerBars[tickerBars.length - 1 - lookbackDays].close;
  if (!isPlausible_(then, 0.01, null)) return null;
  return ((now - then) / then) * 100;
}

// How far the latest close sits above/below its own N-day simple moving
// average, as a % — feeds the "Trend" factor. Distinct from Momentum
// (a point-to-point return): this is a smoother "which side of the trend
// line are we on" read.
const TREND_MA_PERIOD = 20;

function computeTrendPercent_(tickerBars, maPeriod) {
  if (!tickerBars || tickerBars.length < maPeriod) return null;
  const recent = tickerBars.slice(tickerBars.length - maPeriod);
  const ma = recent.reduce(function (a, b) { return a + b.close; }, 0) / maPeriod;
  if (!isPlausible_(ma, 0.01, null)) return null;
  const last = tickerBars[tickerBars.length - 1].close;
  return ((last - ma) / ma) * 100;
}

// Today's (latest bar's) volume vs. the average of the prior N days, as a
// % above/below normal — feeds the "Volume" factor. Requires bars to carry
// a volume field (added to fetchYahooDailyBars_ specifically for this).
// Direction-agnostic on purpose (a volume surge is a confirming signal
// regardless of which way price is moving) — kept simple since this is
// only a 5%-or-less weight in either sheet's Target formula.
const VOLUME_AVG_PERIOD = 10;

function computeRelativeVolumePercent_(tickerBars, avgPeriod) {
  if (!tickerBars || tickerBars.length <= avgPeriod) return null;
  const last = tickerBars[tickerBars.length - 1];
  if (!isPlausible_(last.volume, 0, null)) return null;
  const priorBars = tickerBars.slice(tickerBars.length - 1 - avgPeriod, tickerBars.length - 1);
  const validPrior = priorBars.filter(function (b) { return isPlausible_(b.volume, 0, null); });
  if (validPrior.length === 0) return null;
  const avgVolume = validPrior.reduce(function (a, b) { return a + b.volume; }, 0) / validPrior.length;
  if (!isPlausible_(avgVolume, 1, null)) return null;
  return ((last.volume - avgVolume) / avgVolume) * 100;
}

// Largest peak-to-trough decline over the bars window, as a % — feeds
// Risky's "Drawdown Exposure" risk factor. A rolling-peak scan over
// ~2 months of daily bars; small-sample (this is a real number, but over
// a short window, not a robust multi-year drawdown study).
function computeMaxDrawdownPercent_(tickerBars) {
  if (!tickerBars || tickerBars.length < 5) return null;
  let peak = tickerBars[0].close;
  let maxDrawdown = 0;
  for (let i = 1; i < tickerBars.length; i++) {
    const close = tickerBars[i].close;
    if (close > peak) peak = close;
    if (peak > 0) {
      const drawdown = ((peak - close) / peak) * 100;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  }
  return maxDrawdown;
}

// HEURISTIC "Historical Hit Rate" — % of rolling N-day windows in the
// bars lookback where the stock moved at least one ATR%-sized move in the
// favorable direction for optionType. This is a genuine calculation, but
// over only ~2 months of daily bars it's a SHORT-WINDOW HEURISTIC, not a
// statistically robust hit rate — small sample size per ticker. Surfaced
// to the user as such in the Target cell note wherever it's used.
function computeHistoricalHitRateHeuristic_(tickerBars, atrPercent, optionType, forwardDays) {
  if (!tickerBars || tickerBars.length <= forwardDays + 1 || !isPlausible_(atrPercent, 0.01, null)) return null;

  let hits = 0;
  let total = 0;
  for (let i = 0; i + forwardDays < tickerBars.length; i++) {
    const startClose = tickerBars[i].close;
    const endClose = tickerBars[i + forwardDays].close;
    if (!isPlausible_(startClose, 0.01, null)) continue;
    const movePercent = ((endClose - startClose) / startClose) * 100;
    const directional = optionType === 'P' ? -movePercent : movePercent;
    total++;
    if (directional >= atrPercent) hits++;
  }
  if (total < 5) return null; // too few windows to say anything at all
  return (hits / total) * 100;
}

function fetchYahooAssetProfile_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=assetProfile&formatted=true&lang=en-US&region=US',
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=assetProfile&formatted=true&lang=en-US&region=US'
  ];

  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get',
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
      if (!result || !result.assetProfile) continue;

      const ap = result.assetProfile;
      if (!ap.sector && !ap.industry) continue;

      return { sector: ap.sector || null, industry: ap.industry || null, source: 'Yahoo Finance (unofficial)' };
    } catch (err) {
      Logger.log('Yahoo asset profile error: ' + err);
    }
  }
  return null;
}

function getSectorEtfChangeCached_(sectorName, sectorEtfCache, gfDataMap) {
  if (!sectorName) return null;
  const etfTicker = SECTOR_ETF_MAP[sectorName];
  if (!etfTicker) return null;

  // Per-run cache first (free, in-memory — several tickers usually share
  // a sector within one run).
  if (Object.prototype.hasOwnProperty.call(sectorEtfCache, etfTicker)) {
    return sectorEtfCache[etfTicker];
  }

  // Cross-run, time-windowed cache second — avoids re-hitting Yahoo if
  // this script runs again within SECTOR_MOMENTUM_CACHE_SECONDS.
  const scriptCache = CacheService.getScriptCache();
  const cacheKey = 'SECTORETF_' + etfTicker;
  const cachedRaw = scriptCache.get(cacheKey);

  if (cachedRaw != null) {
    const cachedPct = parseFloat(cachedRaw);
    const result = { pct: isNaN(cachedPct) ? null : cachedPct, source: 'Cached (sector ETF)' };
    sectorEtfCache[etfTicker] = result;
    return result;
  }

  // Google Finance helper sheet third — a formula cell Sheets already
  // keeps live in the background, so this is a free in-memory lookup
  // with zero network calls from the script at all.
  const gf = gfDataMap && gfDataMap[etfTicker];
  if (gf && gf.changePercent != null && !isNaN(gf.changePercent)) {
    const result = { pct: gf.changePercent, source: 'Google Finance (formula)' };
    sectorEtfCache[etfTicker] = result;
    scriptCache.put(cacheKey, String(gf.changePercent), SECTOR_MOMENTUM_CACHE_SECONDS);
    return result;
  }

  // FIX (previous version): was fetchYahooPriceChange_ (quoteSummary?modules=price), which
  // increasingly needs a crumb/cookie Yahoo doesn't grant to unauthenticated
  // UrlFetchApp calls and was returning null for every ETF ticker — the
  // cause of Sector Momentum showing "N/A" across the board. Switched to
  // fetchYahooChartChangePercent_, which uses the same v8/finance/chart
  // endpoint fetchYahooDailyBars_ already uses successfully elsewhere in
  // this script. Now only reached when the Google Finance helper sheet
  // above doesn't have a usable value yet.
  const change = fetchYahooChartChangePercent_(etfTicker);
  const pct = (change && change.changePercent != null) ? change.changePercent : null;
  const result = { pct: pct, source: pct != null ? 'Yahoo Finance (unofficial, sector ETF)' : null };
  sectorEtfCache[etfTicker] = result;

  if (pct != null) {
    scriptCache.put(cacheKey, String(pct), SECTOR_MOMENTUM_CACHE_SECONDS);
  }

  Utilities.sleep(100);
  return result;
}

function fetchYahooAnalystTarget_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=financialData&formatted=true&lang=en-US&region=US',
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=financialData&formatted=true&lang=en-US&region=US'
  ];

  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get',
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
      if (!result || !result.financialData) continue;

      const fd = result.financialData;
      const targetMean = getRawYahooValue_(fd.targetMeanPrice);
      const targetMedian = getRawYahooValue_(fd.targetMedianPrice);
      const targetHigh = getRawYahooValue_(fd.targetHighPrice);
      const targetLow = getRawYahooValue_(fd.targetLowPrice);
      const analystCount = getRawYahooValue_(fd.numberOfAnalystOpinions);
      const recommendationMean = getRawYahooValue_(fd.recommendationMean);
      const target = targetMean != null ? targetMean : targetMedian;

      // A real analyst target price is never zero or negative — reject an
      // invalid reading so this properly falls through to Alpha Vantage
      // (if configured) instead of caching garbage for a week.
      if (!isPlausible_(target, 0.01, null)) continue;

      return {
        target: target, targetMean: targetMean, targetMedian: targetMedian,
        targetHigh: targetHigh, targetLow: targetLow, analystCount: analystCount,
        recommendationMean: recommendationMean, source: 'Yahoo Finance (unofficial)'
      };
    } catch (err) {
      Logger.log('Yahoo analyst target error: ' + err);
    }
  }
  return null;
}

function fetchAlphaVantageAnalystTarget_(ticker, apiKey) {
  if (!apiKey) return null;
  if (isQuotaHitToday_('ALPHA_VANTAGE')) return readTickerCache_('AV_ANALYST', ticker);

  try {
    const url = 'https://www.alphavantage.co/query?function=OVERVIEW&symbol=' + encodeURIComponent(ticker) + '&apikey=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });

    if (resp.getResponseCode() !== 200) {
      Logger.log('Alpha Vantage overview failed for ' + ticker + '. HTTP ' + resp.getResponseCode());
      return null;
    }

    const json = JSON.parse(resp.getContentText());

    if (json.Note || json.Information || !json.AnalystTargetPrice) {
      if (json.Note || json.Information) markQuotaHitToday_('ALPHA_VANTAGE');
      return readTickerCache_('AV_ANALYST', ticker);
    }

    const target = parseFloat(json.AnalystTargetPrice);
    if (isNaN(target) || target <= 0) return null;

    const result = {
      target: target, targetMean: target, targetMedian: null, targetHigh: null,
      targetLow: null, analystCount: null, recommendationMean: null, source: 'Alpha Vantage (fallback)'
    };

    writeTickerCache_('AV_ANALYST', ticker, result);
    return result;
  } catch (err) {
    Logger.log('Alpha Vantage overview error for ' + ticker + ': ' + err);
    return null;
  }
}

function getRawYahooValue_(obj) {
  if (obj == null) return null;
  if (typeof obj === 'number') return obj;
  if (obj.raw != null) {
    const n = parseFloat(obj.raw);
    return isNaN(n) ? null : n;
  }
  if (obj.fmt != null) {
    const n = parseFloat(String(obj.fmt).replace(/[$,%BMTK]/g, ''));
    return isNaN(n) ? null : n;
  }
  return null;
}


/* ============================================================================
 * GENERIC RETRY-WITH-BACKOFF FETCH — unchanged
 * ========================================================================== */

function fetchWithRetry_(url, options, maxRetries, baseDelayMs) {
  let lastResp = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    if (code !== 429 && code < 500) return resp;

    lastResp = resp;
    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      Logger.log('HTTP ' + code + ' from ' + url.split('?')[0] + ' — retrying in ' + delay + 'ms (attempt ' + (attempt + 1) + '/' + maxRetries + ')');
      Utilities.sleep(delay);
    }
  }
  return lastResp;
}


/* ============================================================================
 * FINNHUB / YAHOO CATALYST — unchanged
 * ========================================================================== */

function fetchFinnhubNextEarnings_(ticker, apiKey) {
  if (!apiKey) return null;

  try {
    const today = new Date();
    const future = new Date(today.getTime() + 365 * 24 * 60 * 60 * 1000);
    const from = formatDateForApi_(today);
    const to = formatDateForApi_(future);

    const url = FINNHUB_BASE_URL + '/calendar/earnings?from=' + encodeURIComponent(from) +
      '&to=' + encodeURIComponent(to) + '&symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(apiKey);

    const resp = fetchWithRetry_(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Accept: 'application/json', 'User-Agent': 'options-portfolio-validator/1.0' }
    }, FINNHUB_MAX_RETRIES, FINNHUB_RETRY_BASE_DELAY_MS);

    const code = resp.getResponseCode();
    if (code === 401 || code === 403) {
      Logger.log('Finnhub auth/permission error for ' + ticker + '. HTTP ' + code);
      return null;
    }
    if (code !== 200) {
      Logger.log('Finnhub earnings failed for ' + ticker + ' after retries. HTTP ' + code);
      return null;
    }

    const json = JSON.parse(resp.getContentText());
    const events = json.earningsCalendar || [];
    if (!events.length) return null;

    const todayKeyVal = formatDateForApi_(today);
    const futureEvents = events
      .filter(function (e) {
        return e.date && e.date >= todayKeyVal && (!e.symbol || String(e.symbol).toUpperCase() === ticker.toUpperCase());
      })
      .sort(function (a, b) { return String(a.date).localeCompare(String(b.date)); });

    if (!futureEvents.length) return null;

    const next = futureEvents[0];
    let timing = '';
    if (next.hour === 'bmo') timing = 'BMO';
    else if (next.hour === 'amc') timing = 'AMC';
    else if (next.hour === 'dmh') timing = 'DMH';

    const catalystText = buildEarningsCatalystText_(next.quarter, next.year, timing);
    const catalystDate = parseApiDate_(next.date);

    return { catalyst: catalystText, date: catalystDate, source: 'Finnhub' };
  } catch (err) {
    Logger.log('Finnhub earnings error for ' + ticker + ': ' + err);
    return null;
  }
}

function buildEarningsCatalystText_(quarter, year, timing) {
  let text = 'Earnings';
  if (quarter != null && year != null) text = 'Q' + quarter + ' FY' + year + ' Earnings';
  else if (year != null) text = 'FY' + year + ' Earnings';
  if (timing) text += ' (' + timing + ')';
  return text;
}

// Company profile — used as a fallback for Theme/Cluster and Sector
// Momentum classification. Free tier, 60 requests/min (not the small
// daily-quota cap FMP has), and you already have this key configured for
// Catalyst — no new setup needed.
function fetchFinnhubProfile_(ticker, apiKey) {
  if (!apiKey) return null;

  try {
    const url = FINNHUB_BASE_URL + '/stock/profile2?symbol=' + encodeURIComponent(ticker) + '&token=' + encodeURIComponent(apiKey);
    const resp = fetchWithRetry_(url, {
      method: 'get',
      muteHttpExceptions: true,
      headers: { Accept: 'application/json', 'User-Agent': 'options-portfolio-validator/1.0' }
    }, FINNHUB_MAX_RETRIES, FINNHUB_RETRY_BASE_DELAY_MS);

    if (resp.getResponseCode() !== 200) {
      Logger.log('Finnhub profile failed for ' + ticker + '. HTTP ' + resp.getResponseCode());
      return null;
    }

    const json = JSON.parse(resp.getContentText());
    if (!json.finnhubIndustry) return null;

    return { industry: json.finnhubIndustry, source: 'Finnhub' };
  } catch (err) {
    Logger.log('Finnhub profile error for ' + ticker + ': ' + err);
    return null;
  }
}

function fetchYahooNextEarnings_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=calendarEvents&formatted=true&lang=en-US&region=US',
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=calendarEvents&formatted=true&lang=en-US&region=US'
  ];

  const nowUnix = Math.floor(new Date().getTime() / 1000);

  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get',
        muteHttpExceptions: true,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
          Accept: 'application/json'
        }
      });
      if (resp.getResponseCode() !== 200) continue;

      const json = JSON.parse(resp.getContentText());
      const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
      if (!result || !result.calendarEvents || !result.calendarEvents.earnings) continue;

      const earnings = result.calendarEvents.earnings;
      const dates = Array.isArray(earnings) ? earnings : [earnings];

      const futureDates = dates
        .map(function (d) { return d && (d.raw != null ? Number(d.raw) : null); })
        .filter(function (t) { return t != null && !isNaN(t) && t >= nowUnix; })
        .sort(function (a, b) { return a - b; });

      if (!futureDates.length) continue;

      return { catalyst: buildEarningsCatalystText_(null, null, ''), date: new Date(futureDates[0] * 1000), source: 'Yahoo Finance (unofficial)' };
    } catch (err) {
      Logger.log('Yahoo earnings fallback error: ' + err);
    }
  }
  return null;
}


/* ============================================================================
 * FMP — quote, profile, sector performance, rating (unchanged internals)
 * ========================================================================== */

function fetchFmpQuote_(ticker, apiKey) {
  if (!apiKey) return null;
  if (isQuotaHitToday_('FMP')) return readTickerCache_('FMP_QUOTE', ticker);

  try {
    const url = FMP_BASE_URL + '/quote/' + encodeURIComponent(ticker) + '?apikey=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });

    if (isQuotaExceededResponse_(resp)) {
      markQuotaHitToday_('FMP');
      return readTickerCache_('FMP_QUOTE', ticker);
    }
    if (resp.getResponseCode() !== 200) {
      Logger.log('FMP quote failed for ' + ticker + '. HTTP ' + resp.getResponseCode());
      return null;
    }

    const json = JSON.parse(resp.getContentText());
    const item = Array.isArray(json) ? json[0] : null;
    if (!item) return null;

    const changePercent = item.changesPercentage != null ? parseFloat(String(item.changesPercentage).replace('%', '')) : null;
    const changeAbs = item.change != null ? parseFloat(item.change) : null;

    const result = {
      price: item.price != null ? parseFloat(item.price) : null,
      change: (changeAbs != null && !isNaN(changeAbs)) ? changeAbs : null,
      changePercent: (changePercent != null && !isNaN(changePercent)) ? changePercent : null,
      source: 'FMP'
    };

    writeTickerCache_('FMP_QUOTE', ticker, result);
    return result;
  } catch (err) {
    Logger.log('FMP quote error for ' + ticker + ': ' + err);
    return null;
  }
}

function fetchFmpProfile_(ticker, apiKey) {
  if (!apiKey) return null;
  if (isQuotaHitToday_('FMP')) return readTickerCache_('FMP_PROFILE', ticker);

  try {
    const url = FMP_BASE_URL + '/profile/' + encodeURIComponent(ticker) + '?apikey=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });

    if (isQuotaExceededResponse_(resp)) {
      markQuotaHitToday_('FMP');
      return readTickerCache_('FMP_PROFILE', ticker);
    }
    if (resp.getResponseCode() !== 200) {
      Logger.log('FMP profile failed for ' + ticker + '. HTTP ' + resp.getResponseCode());
      return null;
    }

    const json = JSON.parse(resp.getContentText());
    const item = Array.isArray(json) ? json[0] : null;
    if (!item) return null;

    const result = { sector: item.sector || null, industry: item.industry || null, companyName: item.companyName || null, source: 'FMP' };
    writeTickerCache_('FMP_PROFILE', ticker, result);
    return result;
  } catch (err) {
    Logger.log('FMP profile error for ' + ticker + ': ' + err);
    return null;
  }
}

function fetchFmpSectorPerformance_(apiKey) {
  if (!apiKey) return {};
  if (isQuotaHitToday_('FMP')) return readTickerCache_('FMP_SECTORPERF', 'GLOBAL') || {};

  try {
    const url = FMP_BASE_URL + '/stock/sectors-performance?apikey=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });

    if (isQuotaExceededResponse_(resp)) {
      markQuotaHitToday_('FMP');
      return readTickerCache_('FMP_SECTORPERF', 'GLOBAL') || {};
    }
    if (resp.getResponseCode() !== 200) {
      Logger.log('FMP sector performance failed. HTTP ' + resp.getResponseCode());
      return {};
    }

    const json = JSON.parse(resp.getContentText());
    const list = Array.isArray(json) ? json : (json.sectorPerformance || []);
    const map = {};

    (list || []).forEach(function (entry) {
      const name = entry.sector;
      const raw = entry.changesPercentage;
      if (!name || raw == null) return;
      const pct = parseFloat(String(raw).replace('%', ''));
      if (!isNaN(pct)) map[name] = pct;
    });

    writeTickerCache_('FMP_SECTORPERF', 'GLOBAL', map);
    return map;
  } catch (err) {
    Logger.log('FMP sector performance error: ' + err);
    return {};
  }
}

// Ensures the field-mismatch diagnostic in fetchFmpRating_ logs once per
// run, not once per ticker, if FMP's new endpoint's field names turn out
// to differ from what's guessed.
let FMP_RATING_FIELD_MISMATCH_LOGGED_ = false;

function fetchFmpRating_(ticker, apiKey) {
  if (!apiKey) return null;
  if (isQuotaHitToday_('FMP')) return readTickerCache_('FMP_RATING', ticker);

  try {
    // FMP retired the old /api/v3/rating/{symbol} endpoint (confirmed via
    // Debug: Fetch Raw Quote — it now returns HTTP 403 "Legacy Endpoint...
    // only available for legacy users with subscriptions prior August 31,
    // 2025"). This is their current stable replacement. Symbol is a query
    // parameter here, not part of the path, unlike the old endpoint.
    const url = 'https://financialmodelingprep.com/stable/ratings-snapshot?symbol=' +
      encodeURIComponent(ticker) + '&apikey=' + encodeURIComponent(apiKey);
    const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });

    if (isQuotaExceededResponse_(resp)) {
      markQuotaHitToday_('FMP');
      return readTickerCache_('FMP_RATING', ticker);
    }
    if (resp.getResponseCode() !== 200) {
      Logger.log('FMP rating failed for ' + ticker + '. HTTP ' + resp.getResponseCode());
      return null;
    }

    const json = JSON.parse(resp.getContentText());
    const item = Array.isArray(json) ? json[0] : json;

    // The exact field name on this new endpoint isn't confirmed yet — the
    // old endpoint used "ratingScore", but FMP's newer "stable" APIs often
    // rename fields. Tries the most likely candidates; if NONE match, logs
    // the raw response once so the real field name can be read directly
    // instead of guessed again.
    let ratingScoreRaw = null;
    if (item) {
      if (item.ratingScore != null) ratingScoreRaw = item.ratingScore;
      else if (item.rating != null && !isNaN(Number(item.rating))) ratingScoreRaw = item.rating;
      else if (item.overallScore != null) ratingScoreRaw = item.overallScore;
      else if (item.ratingDetailsDCFScore != null) ratingScoreRaw = item.ratingDetailsDCFScore;
    }

    if (ratingScoreRaw == null) {
      if (!FMP_RATING_FIELD_MISMATCH_LOGGED_) {
        FMP_RATING_FIELD_MISMATCH_LOGGED_ = true;
        logToSheet_('FMP rating: got HTTP 200 for ' + ticker + ' but none of the expected field names matched. Raw response: ' +
          resp.getContentText().substring(0, 500));
      }
      return null;
    }

    const ratingScore = Number(ratingScoreRaw);
    if (isNaN(ratingScore)) return null;

    const result = { ratingScore: ratingScore, ratingRecommendation: item.ratingRecommendation || item.rating || '', source: 'FMP' };
    writeTickerCache_('FMP_RATING', ticker, result);
    return result;
  } catch (err) {
    Logger.log('FMP rating error for ' + ticker + ': ' + err);
    return null;
  }
}


/* ============================================================================
 * BALANCE SCORE HELPERS — unchanged
 * ========================================================================== */

function clamp_(value, min, max) { return Math.max(min, Math.min(max, value)); }

function erf_(x) {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX);
  return sign * y;
}

function normCdf_(x) { return (1 + erf_(x / Math.SQRT2)) / 2; }

function blackScholesDelta_(stockPrice, strike, daysToExpiry, ivPercent, optionType) {
  if (
    stockPrice == null || strike == null || daysToExpiry == null || ivPercent == null ||
    isNaN(stockPrice) || isNaN(strike) || isNaN(daysToExpiry) || isNaN(ivPercent) ||
    stockPrice <= 0 || strike <= 0 || daysToExpiry <= 0 || ivPercent <= 0
  ) return null;

  const T = daysToExpiry / 365;
  const sigma = ivPercent / 100;
  const d1 = (Math.log(stockPrice / strike) + (RISK_FREE_RATE + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const nd1 = normCdf_(d1);
  return optionType === 'P' ? (nd1 - 1) : nd1;
}

// Gamma is identical for a call and put at the same strike/expiry, so no
// optionType parameter is needed here.
function blackScholesGamma_(stockPrice, strike, daysToExpiry, ivPercent) {
  if (
    stockPrice == null || strike == null || daysToExpiry == null || ivPercent == null ||
    isNaN(stockPrice) || isNaN(strike) || isNaN(daysToExpiry) || isNaN(ivPercent) ||
    stockPrice <= 0 || strike <= 0 || daysToExpiry <= 0 || ivPercent <= 0
  ) return null;

  const T = daysToExpiry / 365;
  const sigma = ivPercent / 100;
  const d1 = (Math.log(stockPrice / strike) + (RISK_FREE_RATE + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const phi = Math.exp(-(d1 * d1) / 2) / Math.sqrt(2 * Math.PI);

  return phi / (stockPrice * sigma * Math.sqrt(T));
}

// Now scores a BLENDED momentum metric (40% today's Change Now, 60% the
// ticker's 5-day return minus SPY's 5-day return — see
// computeRelativeStrengthPercent_), not just the single day's move, so the
// clamp range is widened accordingly (a 5-day relative move plausibly runs
// wider than a single day's).
function momentumAlignmentScore_(momentumPercent, optionType) {
  if (momentumPercent == null || isNaN(momentumPercent)) return 50;
  const directional = optionType === 'P' ? -momentumPercent : momentumPercent;
  const clamped = clamp_(directional, -5, 5);
  return ((clamped + 5) / 10) * 100;
}

function sectorAlignmentScore_(sectorPercent, optionType) {
  if (sectorPercent == null || isNaN(sectorPercent)) return 50;
  const directional = optionType === 'P' ? -sectorPercent : sectorPercent;
  const clamped = clamp_(directional, -2, 2);
  return ((clamped + 2) / 4) * 100;
}

// Now scores IV RANK (0-100 percentile vs the underlying's own history),
// not raw IV level — a 30% IV might be cheap for a volatile name and rich
// for a calm one, so the percentile is the more honest "is premium cheap"
// signal for a premium buyer. Lower rank still scores better.
function ivRankSuitabilityScore_(ivRank) {
  if (ivRank == null || isNaN(ivRank)) return 50;
  const clamped = clamp_(ivRank, 0, 100);
  return 100 - clamped;
}

// Rewards higher expected near-term movement — the opposite direction
// from IV Rank above. For a same-day/few-day trade looking to hit even a
// modest profit target quickly, a stock that actually moves is an asset,
// not a risk, in this dimension (actual risk-of-loss is handled by the
// separate Risk column, not by this reward-oriented Balance Score).
function atrOpportunityScore_(atrPercent) {
  if (atrPercent == null || isNaN(atrPercent)) return 50;
  const clamped = clamp_(atrPercent, 1, 6);
  return ((clamped - 1) / 5) * 100;
}

// Same idea as atrOpportunityScore_ above, but rescaled for a large/mega-
// cap-only pool (ResearchEngine.gs's Quick and Leap tabs specifically,
// since those are restricted to that pool). The original 1-6% scale was
// calibrated assuming a broad universe including volatile mid/small-caps
// — grading a large-cap against that same scale systematically
// undervalues it just for being large, even a genuinely good candidate,
// since large caps are structurally calmer. This narrower 1-3.5% scale
// reflects what's actually normal within a large-cap-only pool instead.
// Risky (uncapped) intentionally keeps using the original function above.
function atrOpportunityScoreLargeCap_(atrPercent) {
  if (atrPercent == null || isNaN(atrPercent)) return 50;
  const clamped = clamp_(atrPercent, 1, 3.5);
  return ((clamped - 1) / 2.5) * 100;
}

// Rewards higher |delta| — more stock-like exposure, matching the
// stock-replacement structure this screener is built around (your book's
// deltas already run 70-97). Uses the absolute value since a put's delta
// is negative but "how stock-like" is about magnitude, not sign.
function deltaExposureScore_(delta) {
  if (delta == null || isNaN(delta)) return 50;
  const clamped = clamp_(Math.abs(delta), 0.5, 1.0);
  return ((clamped - 0.5) / 0.5) * 100;
}

/* ============================================================================
 * QUICK/RISKY REVISED-FORMULA SCORING HELPERS — normalize the raw bars-
 * derived metrics above (and a few existing fields, reused in a new
 * direction) into 0-100 scores for the new Quick Score / Risk / Target
 * formulas. See computeQuickSheetScores_ / computeRiskySheetScores_
 * further down for how these combine.
 * ========================================================================== */

// Trend factor: same directional shape as momentumAlignmentScore_, but
// scaled to a moving-average deviation's plausible range rather than a
// short-window return's.
function trendAlignmentScore_(trendPercent, optionType) {
  if (trendPercent == null || isNaN(trendPercent)) return 50;
  const directional = optionType === 'P' ? -trendPercent : trendPercent;
  const clamped = clamp_(directional, -10, 10);
  return ((clamped + 10) / 20) * 100;
}

// Volume factor: direction-agnostic (a surge confirms either direction) —
// higher relative volume always scores higher.
function relativeVolumeScore_(relativeVolumePercent) {
  if (relativeVolumePercent == null || isNaN(relativeVolumePercent)) return 50;
  const clamped = clamp_(relativeVolumePercent, -50, 100);
  return ((clamped + 50) / 150) * 100;
}

// Market Regime factor: SPY's own trend (see computeTrendPercent_ applied
// to SPY's bars, computed ONCE per run — see getMarketRegime_) scored the
// same directional way as Trend above, just on a market-wide input
// instead of the ticker's own. Identical for every row in a run by
// design — it's a market-wide backdrop check, not a per-ticker signal.
function marketRegimeScore_(spyTrendPercent, optionType) {
  if (spyTrendPercent == null || isNaN(spyTrendPercent)) return 50;
  const directional = optionType === 'P' ? -spyTrendPercent : spyTrendPercent;
  const clamped = clamp_(directional, -5, 5);
  return ((clamped + 5) / 10) * 100;
}

// IV Rank scored for RISK purposes — the OPPOSITE direction from
// ivRankSuitabilityScore_ (which treats a low rank/cheap premium as
// good). For risk, a richer (higher) IV Rank means more priced-in
// volatility and more IV-crush exposure, so higher rank = higher risk.
function ivRankRiskScore_(ivRank) {
  if (ivRank == null || isNaN(ivRank)) return 50;
  return clamp_(ivRank, 0, 100);
}

// Drawdown Exposure (Risky Risk factor): scores the ~2-month max
// drawdown — 5% or less is calm (low risk), 40%+ is scored as maximum
// risk. Judgment-call clamp range, worth a sanity check against real
// numbers once you see some.
function drawdownRiskScore_(maxDrawdownPercent) {
  if (maxDrawdownPercent == null || isNaN(maxDrawdownPercent)) return 50;
  const clamped = clamp_(maxDrawdownPercent, 5, 40);
  return ((clamped - 5) / 35) * 100;
}

// Option Risk (Risky Risk factor): blends execution risk (bid/ask
// spread, reused from executionRiskScore_) with how much of the premium
// is pure time value (higher extrinsic % = more decay exposure on a
// position you might hold up to 2 weeks). Spread weighted heavier since
// it's the more direct/reliable of the two signals.
function optionRiskScore_(bidAskSpreadPct, extrinsicValue, optionPrice) {
  const spreadComponent = executionRiskScore_(bidAskSpreadPct);
  let extrinsicComponent = 50;
  if (isPlausible_(extrinsicValue, 0, null) && isPlausible_(optionPrice, 0.01, null)) {
    extrinsicComponent = clamp_((extrinsicValue / optionPrice) * 100, 0, 100);
  }
  return spreadComponent * 0.6 + extrinsicComponent * 0.4;
}

// Liquidity Risk (Risky Risk factor): the inverse of the existing
// liquidityScore_ (which rewards high OI/Volume) — thin markets are the
// risk here, not the opportunity.
function liquidityRiskScore_(openInterest, volume) {
  return 100 - liquidityScore_(openInterest, volume);
}

// Historical Hit Rate factor: the heuristic percentage from
// computeHistoricalHitRateHeuristic_ IS already a 0-100 score (a hit
// rate), so this just passes it through with the standard "unknown ->
// neutral" fallback, kept as a named function so every factor in the
// Target formulas has a matching *Score_ entry point.
function historicalHitRateScore_(hitRatePercent) {
  if (hitRatePercent == null || isNaN(hitRatePercent)) return 50;
  return clamp_(hitRatePercent, 0, 100);
}

// Standard normal CDF via the Abramowitz-Stegun approximation (max error
// ~7.5e-8) — no built-in erf/normal CDF in Apps Script's JS runtime.
function normalCdf_(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let prob = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  if (z > 0) prob = 1 - prob;
  return prob;
}

// Volatility Probability factor: the actual probability (0-100) that the
// stock reaches targetStockPrice within horizonDays, using a zero-drift
// lognormal approximation driven by the contract's own IV — the same
// "how far can this realistically move" question Omega/ATR answer
// elsewhere, but framed as a real probability instead of a 1-20 day
// estimate. A snapshot approximation (not a full options-pricing model),
// recomputed fresh every run.
function volatilityProbabilityScore_(currentStockPrice, targetStockPrice, ivDecimal, horizonDays, optionType) {
  if (!isPlausible_(currentStockPrice, 0.01, null) || !isPlausible_(targetStockPrice, 0.01, null) ||
      !isPlausible_(ivDecimal, 0.001, null) || !isPlausible_(horizonDays, 0.5, null)) {
    return null;
  }
  const z = Math.log(targetStockPrice / currentStockPrice) / (ivDecimal * Math.sqrt(horizonDays / 365));
  // Calls need the stock to end ABOVE target; puts need it to end BELOW —
  // note this expects targetStockPrice to already reflect the correct
  // side (computeTargetForObjective_ / stockPriceForOptionLevel_ already
  // handle that directionality upstream).
  const probability = optionType === 'P' ? normalCdf_(z) : (1 - normalCdf_(z));
  return clamp_(probability * 100, 0, 100);
}

function qualityScore_(ratingScore) {
  if (ratingScore == null || isNaN(ratingScore)) return 50;
  const clamped = clamp_(ratingScore, 1, 5);
  return ((clamped - 1) / 4) * 100;
}

function upsideAlignmentScore_(upsidePercent, optionType) {
  if (upsidePercent == null || isNaN(upsidePercent)) return 50;
  const directional = optionType === 'P' ? -upsidePercent : upsidePercent;
  const clamped = clamp_(directional, -20, 40);
  return ((clamped + 20) / 60) * 100;
}

// Blends today's Volume with Open Interest. Volume is weighted heavier
// (65/35) because for a same-day/few-day round trip, what actually traded
// TODAY is the more honest signal for whether you'll get a clean fill —
// high OI with near-zero volume is a classic wide-spread trap. Either
// input missing falls back to the other alone; both missing is neutral.
function liquidityScore_(openInterest, volume) {
  const oiComponent = (openInterest == null || isNaN(openInterest)) ? null : (clamp_(openInterest, 0, 3000) / 3000) * 100;
  const volComponent = (volume == null || isNaN(volume)) ? null : (clamp_(volume, 0, 500) / 500) * 100;

  if (oiComponent == null && volComponent == null) return 50;
  if (oiComponent == null) return volComponent;
  if (volComponent == null) return oiComponent;

  return oiComponent * 0.35 + volComponent * 0.65;
}

// Scores down a row whose next catalyst falls inside SWING_WINDOW_DAYS —
// tomorrow's earnings scores near 0, an event right at the window's edge
// scores 100, anything further out (or unknown) is neutral/full credit.
// A negative value (a stale catalyst date that slipped through) is treated
// as unknown rather than penalized — the slow-cache's forced refresh on a
// passed date should catch this on the next run anyway.
function catalystRiskScore_(daysToCatalyst, swingWindowDays) {
  if (daysToCatalyst == null || isNaN(daysToCatalyst) || daysToCatalyst < 0) return 50;
  if (daysToCatalyst >= swingWindowDays) return 100;
  return clamp_((daysToCatalyst / swingWindowDays) * 100, 0, 100);
}

// LEAP-BUCKET ONLY: rewards getting more stock-like exposure (Omega — see
// computeOmega_ below) per dollar actually spent on the contract. This is
// the "capital efficiency" factor you asked for on the Leap side — two
// contracts with the same delta don't cost the same, and this prefers the
// cheaper one for the same stock-like exposure. Clamp range (1.5-6) is a
// judgment call reflecting typical Omega for long-dated, higher-delta
// contracts specifically — much lower than a short-dated swing option's
// Omega would be, since a long-dated ITM contract's price is a bigger
// fraction of the stock price. Worth a sanity check against real numbers
// once you see some.
function capitalEfficiencyScore_(omega) {
  if (omega == null || isNaN(omega)) return 50;
  const clamped = clamp_(omega, 1.5, 6);
  return ((clamped - 1.5) / 4.5) * 100;
}


/* ============================================================================
 * SHARED: OPTION LEVERAGE (OMEGA)
 *
 * Omega = (|Delta| * Stock Price) / Option Price — a standard options-
 * Greeks "elasticity" concept: roughly how many times faster the option's
 * premium moves than the stock, in percentage terms. Used by BOTH the Risk
 * score (how fast could this swing against you) and the Filter score (can
 * this realistically hit your profit target) — factored out once so the
 * two never drift out of sync with each other.
 * ========================================================================== */

function computeOmega_(delta, stockPrice, optionPrice) {
  if (!isPlausible_(delta, null, null) || !isPlausible_(stockPrice, 0.01, null) || !isPlausible_(optionPrice, 0.01, null)) {
    return null;
  }
  return (Math.abs(delta) * stockPrice) / optionPrice;
}


/* ============================================================================
 * RISK SCORE — separate from Balance Score. Balance Score asks "is this a
 * good trade candidate"; Risk asks "how fast could this position swing
 * against you, given your own 20%-profit / 50%-loss thresholds". Higher
 * number = MORE risk. Capital efficiency ($ invested) is deliberately
 * excluded, same as Balance Score — this is about velocity/magnitude of
 * the position's swings, not how much capital is tied up.
 *
 * Core idea: an option's premium moves roughly Omega times faster than
 * the underlying stock (see computeOmega_ above). Combined with the
 * stock's own typical daily move (ATR%), that gives a rough estimate of
 * how many days it would take a plausible move to swing the PREMIUM by
 * your loss tolerance — using sqrt(N) scaling (moves compound with the
 * square root of time, the standard random-walk approximation), not a
 * straight multiply. Fewer days needed = higher risk score.
 *
 * Two more factors layer on top: a catalyst inside your holding window
 * (event/gap risk), and a wide bid/ask spread (execution risk on a quick
 * exit — the "IV crush" concern from a rich IV Rank going into an event is
 * folded into the catalyst-proximity factor, not scored separately, to
 * avoid double-counting the same underlying event risk twice).
 *
 * The three factors' WEIGHTS depend on option type (see RISK_WEIGHTS_CALL
 * / RISK_WEIGHTS_PUT below) — calls assume a price-target exit (velocity-
 * dominant), puts assume your ITM/max-60-day/exit-within-a-week-regardless
 * strategy, where a scheduled exit can't wait out a bad spread the way an
 * opportunistic one can, so execution risk is weighted much higher and
 * velocity much lower.
 * ========================================================================== */

// Calls (and the default/fallback): velocity-dominant, matching a
// price-target exit — you're willing to ride toward a move, so "how fast
// could this swing against me" carries the most weight.
const RISK_WEIGHTS_CALL = { velocity: 60, catalystProximity: 25, execution: 15 };

// Puts, when used for your ITM/max-60-day/exit-within-a-week-regardless
// strategy: a genuinely different risk framing, not just a direction
// flip. You're not riding toward a price target — you're out on a fixed
// schedule whether it worked or not. So velocity (how fast could this
// swing against me before I'd bail) matters much less than it does for a
// price-target trade, and execution (can I actually get a clean fill
// when I'm FORCED to close, not just when I'd like to) matters much
// more, since a scheduled exit can't wait out a bad spread the way an
// opportunistic one can. Catalyst proximity is left unchanged — an
// earnings surprise inside a one-week window is just as dangerous
// regardless of which exit philosophy you're running.
const RISK_WEIGHTS_PUT = { velocity: 40, catalystProximity: 25, execution: 35 };

function riskWeightsForType_(optionType) {
  return optionType === 'P' ? RISK_WEIGHTS_PUT : RISK_WEIGHTS_CALL;
}

// sqrt(N) "random walk" scaling: solves for how many days (N) of typical
// (ATR-sized) stock moves, amplified by the option's leverage (omega),
// would be needed to reach targetMovePercent on the option's premium.
function estimatedDaysForPremiumMove_(atrPercent, omega, targetMovePercent) {
  if (!isPlausible_(atrPercent, 0.01, null) || !isPlausible_(omega, 0.01, null)) return null;
  const dailyPremiumMovePercent = atrPercent * omega;
  if (dailyPremiumMovePercent <= 0) return null;
  return Math.pow(targetMovePercent / dailyPremiumMovePercent, 2);
}

// <=1 day to a plausible loss-tolerance-sized swing = max risk (100);
// >=20 days = minimal near-term risk (0) — the position just doesn't move
// fast enough, relative to your own thresholds, to be a near-term concern.
function velocityRiskScore_(daysToLossThreshold) {
  if (daysToLossThreshold == null || isNaN(daysToLossThreshold)) return 50;
  const clamped = clamp_(daysToLossThreshold, 1, 20);
  return 100 - ((clamped - 1) / 19) * 100;
}

// Wider spread = more slippage risk getting out quickly. Reuses the same
// isPlausible_ pattern as everything else; unknown spread is neutral.
function executionRiskScore_(bidAskSpreadPct) {
  if (bidAskSpreadPct == null || isNaN(bidAskSpreadPct)) return 50;
  const clamped = clamp_(bidAskSpreadPct, 0, 8);
  return (clamped / 8) * 100;
}

function computeRiskScore_(inputs) {
  const weights = riskWeightsForType_(inputs.optionType);
  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);

  const daysToLoss = (omega != null)
    ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, RISK_LOSS_TOLERANCE_PERCENT)
    : null;

  const velocity = velocityRiskScore_(daysToLoss);
  // Reuses catalystRiskScore_ (100 = far from catalyst = safe for Balance
  // Score's purposes) inverted, since for RISK, near-catalyst is the bad
  // direction — avoids maintaining two copies of the same proximity logic.
  const catalystProximity = 100 - catalystRiskScore_(inputs.daysToCatalyst, SWING_WINDOW_DAYS);
  const execution = executionRiskScore_(inputs.bidAskSpreadPct);

  const totalWeight = weights.velocity + weights.catalystProximity + weights.execution;
  const weightedSum = velocity * weights.velocity + catalystProximity * weights.catalystProximity +
    execution * weights.execution;

  return Math.round((weightedSum / totalWeight) * 10) / 10;
}


/* ============================================================================
 * LEAP's own velocity-risk scale — reused by computeLeapSheetRiskScore_
 * further down (see "LEAP — REVISED FORMULAS"). Widened to a 5-90 day
 * window (rather than Risk's 1-20) — a capital-efficient, lower-Omega
 * long-dated contract naturally needs many more days to reach even a 10%
 * swing than a short-dated high-Omega one would, so the whole scale needs
 * to stretch out to stay meaningful.
 * ========================================================================== */
function velocityRiskScoreLeap_(daysToLossThreshold) {
  if (daysToLossThreshold == null || isNaN(daysToLossThreshold)) return 50;
  const clamped = clamp_(daysToLossThreshold, 5, 90);
  return 100 - ((clamped - 5) / 85) * 100;
}


/* ============================================================================
 * FILTER SCORE ("Trade Setup Score") — the sweet-spot finder: Low Risk +
 * strong RS + enough volatility to actually move + a realistically
 * achievable 20% target + high Delta participation. Higher = better setup.
 *
 * FACTOR                    WEIGHT   WHAT IT ASKS
 * Low Risk                  25%      Inverts the Risk column directly —
 *                                    reuses that exact number rather than
 *                                    recomputing a separate "runway"
 *                                    figure, so Filter and Risk never
 *                                    silently disagree with each other.
 * RS vs SPY                 20%      Is the stock outperforming the
 *                                    market (direction-aware: a Put wants
 *                                    the stock UNDERperforming)?
 * 20% Target Feasibility    30%      See below — this is the "ATR and
 *                                    required move should work together"
 *                                    piece, not a standalone ATR score.
 * Delta                     15%      Reuses deltaExposureScore_ from
 *                                    Balance Score — same "more stock-
 *                                    like exposure = better participation"
 *                                    logic, no need for a second copy.
 * ATR                       10%      A smaller, STANDALONE check that the
 *                                    stock moves at all — deliberately
 *                                    separate from Target Feasibility
 *                                    below, which asks a different
 *                                    question (whether THIS option's
 *                                    leverage turns that movement into
 *                                    your specific 20% target, not just
 *                                    "does the stock move").
 *
 * TARGET FEASIBILITY, IN DETAIL:
 * Scoring raw ATR% alone would reward a volatile stock even when the
 * option's own leverage (Omega, see computeOmega_) is too low to ever
 * turn that volatility into a 20% premium gain within your holding
 * window — and conversely, a modestly-volatile stock paired with a
 * highly-levered option might get there just fine. So instead of scoring
 * ATR and Delta as if they were independent, Target Feasibility runs
 * them through the SAME sqrt(N) formula the Risk score uses (just aimed
 * at your PROFIT target instead of your loss tolerance) to get a single
 * "estimated days to +20% on the premium" number, then scores THAT —
 * against a threshold pair that depends on option type (see
 * TARGET_FEASIBILITY_*_DAYS_CALL / _PUT below):
 *   CALLS: <= 3 days -> 100 (matches your general "1-3 day move" framing),
 *          >= 10 days -> 0, smooth linear falloff in between.
 *   PUTS:  <= 2 days -> 100, >= 7 days -> 0 — tightened to match your
 *          ITM/max-60-day/exit-within-a-week-regardless put strategy,
 *          where anything not feasible inside that week is useless to
 *          you even if it might work out given more time.
 * ========================================================================== */

const FILTER_WEIGHTS = { lowRisk: 25, relativeStrength: 20, targetFeasibility: 30, delta: 15, atr: 10 };

// Calls (and the default/fallback): matches your general "1-3 day move"
// swing framing, with the outer edge of realism at 10 days.
const TARGET_FEASIBILITY_IDEAL_DAYS_CALL = 3;
const TARGET_FEASIBILITY_MAX_DAYS_CALL = 10;

// Puts, for your ITM/max-60-day/exit-within-a-week strategy: tightened
// to match your actual hard ceiling. A setup that's only "feasible" in
// 8-9 days is genuinely useless here — you're out in a week regardless
// of price, so past that the position isn't going to get there before
// your own exit rule closes it anyway.
const TARGET_FEASIBILITY_IDEAL_DAYS_PUT = 2;
const TARGET_FEASIBILITY_MAX_DAYS_PUT = 7;

function targetFeasibilityScore_(daysToTarget, optionType) {
  const idealDays = optionType === 'P' ? TARGET_FEASIBILITY_IDEAL_DAYS_PUT : TARGET_FEASIBILITY_IDEAL_DAYS_CALL;
  const maxDays = optionType === 'P' ? TARGET_FEASIBILITY_MAX_DAYS_PUT : TARGET_FEASIBILITY_MAX_DAYS_CALL;

  if (daysToTarget == null || isNaN(daysToTarget)) return 50;
  if (daysToTarget <= idealDays) return 100;
  if (daysToTarget >= maxDays) return 0;
  return 100 - ((daysToTarget - idealDays) / (maxDays - idealDays)) * 100;
}

// RS vs SPY scored on its own (unlike Balance Score's momentum, which
// blends RS with today's Change Now) — direction-aware, same clamp shape
// as momentumAlignmentScore_ since it's the same kind of multi-day metric.
function relativeStrengthScore_(rsPercent, optionType) {
  if (rsPercent == null || isNaN(rsPercent)) return 50;
  const directional = optionType === 'P' ? -rsPercent : rsPercent;
  const clamped = clamp_(directional, -5, 5);
  return ((clamped + 5) / 10) * 100;
}

function computeFilterScore_(inputs) {
  const lowRisk = isPlausible_(inputs.riskScore, 0, 100) ? (100 - inputs.riskScore) : 50;
  const rs = relativeStrengthScore_(inputs.relativeStrengthPercent, inputs.optionType);
  const delta = deltaExposureScore_(inputs.delta);
  const atr = atrOpportunityScore_(inputs.atrPercent);

  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const daysToTarget = (omega != null)
    ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, RISK_PROFIT_TARGET_PERCENT)
    : null;
  const targetFeasibility = targetFeasibilityScore_(daysToTarget, inputs.optionType);

  const totalWeight = FILTER_WEIGHTS.lowRisk + FILTER_WEIGHTS.relativeStrength +
    FILTER_WEIGHTS.targetFeasibility + FILTER_WEIGHTS.delta + FILTER_WEIGHTS.atr;

  const weightedSum = lowRisk * FILTER_WEIGHTS.lowRisk + rs * FILTER_WEIGHTS.relativeStrength +
    targetFeasibility * FILTER_WEIGHTS.targetFeasibility + delta * FILTER_WEIGHTS.delta + atr * FILTER_WEIGHTS.atr;

  return Math.round((weightedSum / totalWeight) * 10) / 10;
}


/* ============================================================================
 * PER-SHEET OBJECTIVE — RISK / FILTER / TARGET FOR "Quick" AND "Risky"
 * ----------------------------------------------------------------------------
 * Both sheets share the same day/swing-trade shape, just with different
 * timing:
 *   - Ideal: close same-day or within a few days at a MINIMUM profit on
 *     the premium (minProfitPercent below) — not chasing a big gain.
 *   - The long-dated expiry (per each sheet's Input-tab MinExpiry) is
 *     bought purely as a time cushion/hedge, not because the trade is
 *     meant to run that long: if the thesis is wrong, the position is
 *     held rather than closed at a loss — up to maxHoldDays days.
 *   - Starting at phaseShiftDays days held, the objective shifts from
 *     "grab a small profit" to "get out at breakeven, or the smallest
 *     loss you can manage" instead of continuing to chase a gain that
 *     hasn't shown up.
 *
 *   Quick:  minProfitPercent 3%, phaseShiftDays 30 (~1 month), maxHoldDays 60 (~2 months)
 *   Risky:  minProfitPercent 3%, phaseShiftDays 7  (~1 week),  maxHoldDays 14 (~2 weeks)
 *
 * Any OTHER sheet (or a sheet not in TRADE_OBJECTIVE_SHEETS below) keeps
 * the generic computeRiskScore_ / computeFilterScore_ above untouched, and
 * never gets a Target.
 *
 * ACTIVE POSITION SIGNAL: per your setup, a non-blank Entry Price means
 * you're actually IN this position, not just watching it as a candidate.
 * Rows with no Entry Price are candidates: Target stays blank, and
 * Risk/Quick (Filter) still use this sheet's objective formulas (so you
 * can still rank NEW candidates the same way), just with no phase to
 * compute (no Entry Date, since there's no position yet).
 *
 * ASSUMPTIONS TO REVISIT — judgment calls, not values you gave me
 * directly, shared by both sheets:
 *   - lossConcernPercent (15%): you described the downside plan as
 *     time-based (hold up to maxHoldDays, then aim for breakeven) rather
 *     than a fixed loss %, so this just picks a tighter premium-loss
 *     threshold than the generic 50% to keep Risk's "velocity" factor
 *     meaningful for these sheets' tighter posture.
 *   - feasibilityIdealDays / feasibilityMaxDays (1 / 5 days): how many
 *     days counts as "same-day/few-days" vs. "not fast enough" for a
 *     minProfitPercent move specifically.
 * ============================================================================ */

const TRADE_OBJECTIVE_SHEETS = {
  'Quick': {
    minProfitPercent: 3,
    phaseShiftDays: 30,
    maxHoldDays: 60,
    lossConcernPercent: 15,
    feasibilityIdealDays: 1,
    feasibilityMaxDays: 5
  },
  'Risky': {
    minProfitPercent: 3,
    phaseShiftDays: 7,
    maxHoldDays: 14,
    lossConcernPercent: 15,
    feasibilityIdealDays: 1,
    feasibilityMaxDays: 5
  },
  // Leap: long-term, stock-replacement hold — out at +50% or -10% on the
  // premium, held as long as it takes otherwise (no time-based phase
  // shift or max-hold cutoff, unlike Quick/Risky). phaseShiftDays/
  // maxHoldDays set to Infinity so computeTargetForObjective_'s phase
  // never shifts to "breakeven" and the day-count maxHoldWarning below
  // never fires — the -10% loss check (lossThresholdWarning) is the
  // actual exit signal for this sheet instead.
  'Leap': {
    minProfitPercent: LEAP_PROFIT_TARGET_PERCENT,
    lossConcernPercent: LEAP_LOSS_TOLERANCE_PERCENT,
    phaseShiftDays: Infinity,
    maxHoldDays: Infinity
  }
};

const RISK_WEIGHTS_OBJECTIVE_SHEET = { velocity: 35, catalystProximity: 20, execution: 15, holdTimeProximity: 30 };
const FILTER_WEIGHTS_OBJECTIVE_SHEET = { lowRisk: 25, relativeStrength: 20, targetFeasibility: 30, delta: 15, atr: 10 };

// Reads either a real Date or a string in the same formats parseExpiryCell_
// already handles (Mon D, YYYY / M-D-YYYY / etc.) — reused as-is since
// Entry Date needs the exact same flexible parsing Expiry already gets.
// Reads either a real Date or a string in the same formats parseExpiryCell_
// already handles (Mon D, YYYY / M-D-YYYY / etc.) — delegates entirely,
// including its noon-anchoring fix for Date-typed cells, rather than
// duplicating that same check here unfixed.
function parseEntryDateCell_(value) {
  return parseExpiryCell_(value);
}

// How close daysHeld is to config.maxHoldDays — 0 right after entry, 100
// AT the cutoff. No active position / no Entry Date resolves to neutral
// (50), same convention every other risk factor in this file uses for
// "unknown."
function holdTimeProximityRiskScore_(daysHeld, maxHoldDays) {
  if (daysHeld == null || isNaN(daysHeld)) return 50;
  const clamped = clamp_(daysHeld, 0, maxHoldDays);
  return (clamped / maxHoldDays) * 100;
}

// Objective-sheet Risk: same velocity/catalyst/execution shape as the
// generic computeRiskScore_, but velocity targets config.lossConcernPercent
// (not the generic 50%), and a 4th factor — proximity to config.maxHoldDays
// — is added so a position held a long time without hitting its target
// shows as progressively riskier, which the generic (day/week-horizon)
// Risk score has no concept of.
function computeRiskScoreForObjective_(inputs, config) {
  const weights = RISK_WEIGHTS_OBJECTIVE_SHEET;
  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);

  const daysToLoss = (omega != null)
    ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, config.lossConcernPercent)
    : null;

  const velocity = velocityRiskScore_(daysToLoss);
  const catalystProximity = 100 - catalystRiskScore_(inputs.daysToCatalyst, SWING_WINDOW_DAYS);
  const execution = executionRiskScore_(inputs.bidAskSpreadPct);
  const holdTime = holdTimeProximityRiskScore_(inputs.daysHeld, config.maxHoldDays);

  const totalWeight = weights.velocity + weights.catalystProximity + weights.execution + weights.holdTimeProximity;
  const weightedSum = velocity * weights.velocity + catalystProximity * weights.catalystProximity +
    execution * weights.execution + holdTime * weights.holdTimeProximity;

  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

// Same day-count-to-target-feasibility idea as targetFeasibilityScore_
// above, but calibrated to config.minProfitPercent's much smaller,
// faster-to-reach move instead of the generic 20% target — <= config.
// feasibilityIdealDays is full credit, >= config.feasibilityMaxDays is none.
function targetFeasibilityScoreForObjective_(daysToTarget, config) {
  if (daysToTarget == null || isNaN(daysToTarget)) return 50;
  if (daysToTarget <= config.feasibilityIdealDays) return 100;
  if (daysToTarget >= config.feasibilityMaxDays) return 0;
  return 100 - ((daysToTarget - config.feasibilityIdealDays) /
    (config.feasibilityMaxDays - config.feasibilityIdealDays)) * 100;
}

// Objective-sheet Filter ("Quick" column): same 5-factor shape as the
// generic computeFilterScore_, but Target Feasibility is aimed at
// config.minProfitPercent via targetFeasibilityScoreForObjective_ instead
// of the generic 20% target.
function computeFilterScoreForObjective_(inputs, config) {
  const lowRisk = isPlausible_(inputs.riskScore, 0, 100) ? (100 - inputs.riskScore) : 50;
  const rs = relativeStrengthScore_(inputs.relativeStrengthPercent, inputs.optionType);
  const delta = deltaExposureScore_(inputs.delta);
  const atr = atrOpportunityScore_(inputs.atrPercent);

  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const daysToTarget = (omega != null)
    ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, config.minProfitPercent)
    : null;
  const targetFeasibility = targetFeasibilityScoreForObjective_(daysToTarget, config);

  const w = FILTER_WEIGHTS_OBJECTIVE_SHEET;
  const totalWeight = w.lowRisk + w.relativeStrength + w.targetFeasibility + w.delta + w.atr;
  const weightedSum = lowRisk * w.lowRisk + rs * w.relativeStrength +
    targetFeasibility * w.targetFeasibility + delta * w.delta + atr * w.atr;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

// Stock price at which the option's premium would show
// targetOptionPrice's level, using the same Omega-linear approximation
// the Risk/Filter scores above already rely on (computeOmega_) — a
// snapshot approximation recomputed fresh every run from that run's
// Delta/Stock/Option Price, not a full Black-Scholes inversion. Returns
// null if Omega can't be computed (missing Delta/Stock/Option Price) or
// targetOptionPrice is invalid.
function stockPriceForOptionLevel_(currentStockPrice, currentOptionPrice, targetOptionPrice, delta, optionType) {
  const omega = computeOmega_(delta, currentStockPrice, currentOptionPrice);
  if (omega == null || !isPlausible_(targetOptionPrice, 0.001, null)) return null;

  const optionPercentMove = ((targetOptionPrice - currentOptionPrice) / currentOptionPrice) * 100;
  const stockPercentMove = optionPercentMove / omega;
  const directional = optionType === 'P' ? -stockPercentMove : stockPercentMove;

  return currentStockPrice * (1 + directional / 100);
}

// Computes this run's Target stock price + which phase it reflects, for
// an active position (non-blank Entry Price) on a sheet with an entry in
// TRADE_OBJECTIVE_SHEETS. Phase A ("profit", daysHeld < config.
// phaseShiftDays or unknown): Target is the stock price at which the
// option would be worth config.minProfitPercent more than what you paid.
// Phase B ("breakeven", daysHeld >= config.phaseShiftDays): Target is the
// stock price at which the option would be worth exactly what you paid —
// "no gain," per the objective, not a loss-minimization guess beyond
// that. Returns null if Delta/Stock/Option Price aren't resolved this run.
function computeTargetForObjective_(entryPrice, daysHeld, currentStockPrice, currentOptionPrice, delta, optionType, config) {
  if (!isPlausible_(entryPrice, 0.01, null) || !isPlausible_(currentStockPrice, 0.01, null) ||
      !isPlausible_(currentOptionPrice, 0.01, null) || delta == null) {
    return null;
  }

  const phase = (daysHeld == null || daysHeld < config.phaseShiftDays) ? 'profit' : 'breakeven';
  const targetOptionPrice = phase === 'profit'
    ? entryPrice * (1 + config.minProfitPercent / 100)
    : entryPrice;

  const targetStockPrice = stockPriceForOptionLevel_(currentStockPrice, currentOptionPrice, targetOptionPrice, delta, optionType);
  if (targetStockPrice == null) return null;

  return { targetStockPrice: targetStockPrice, phase: phase };
}


/* ============================================================================
 * QUICK & RISKY — REVISED FORMULAS (your custom weighting, replacing the
 * generic objective-sheet Risk/Filter/Target above for these two sheets
 * specifically). Target's cell VALUE is now a PROBABILITY (%), not a
 * stock price — the underlying target stock price (from
 * computeTargetForObjective_ above) is still computed and used as the
 * anchor for Volatility Probability, and is shown in the cell's note,
 * but no longer written to the cell itself.
 *
 * Order of computation per row (see validateAndUpdate): Target Score ->
 * Risk Score -> Quick Score, since Risky's Quick Score depends on its
 * own Target Score as an input.
 * ========================================================================== */

const QUICK_SHEET_WEIGHTS = {
  quick: { rs: 25, atr: 20, requiredMove: 20, risk: 15, sector: 10, ivRank: 5, delta: 5 },
  risk: { atr: 50, omega: 30, ivRank: 20 },
  target: { volProb: 30, momentum: 20, rs: 15, sector: 10, trend: 10, volume: 5, marketRegime: 5, ivEvent: 5 }
};

const RISKY_SHEET_WEIGHTS = {
  quick: { rs: 25, requiredMove: 25, targetProb: 20, atr: 15, sector: 10, ivRank: 3, delta: 2 },
  // Recovery Time's original 30% was folded into Drawdown Exposure (70%
  // total) per your call — see the conversation this was built from.
  risk: { drawdown: 70, optionRisk: 20, liquidityRisk: 10 },
  target: { hitRate: 35, volProb: 20, momentum: 15, rs: 10, sector: 7.5, marketRegime: 5, volume: 5, ivEvent: 2.5 }
};

// Horizon for the Volatility Probability factor: the sooner of days-to-
// expiry or the sheet's own maxHoldDays, since you're out by then
// regardless of whether the option's still alive.
function volatilityProbabilityHorizonDays_(daysToExpiry, config) {
  const candidates = [];
  if (isPlausible_(daysToExpiry, 0.5, null)) candidates.push(daysToExpiry);
  if (config && isPlausible_(config.maxHoldDays, 0.5, null)) candidates.push(config.maxHoldDays);
  if (candidates.length === 0) return null;
  return Math.min.apply(null, candidates);
}

function computeQuickSheetRiskScore_(inputs) {
  const w = QUICK_SHEET_WEIGHTS.risk;
  const atr = atrOpportunityScore_(inputs.atrPercent);
  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const omegaExposure = capitalEfficiencyScore_(omega);
  const ivRankRisk = ivRankRiskScore_(inputs.ivRank);

  const totalWeight = w.atr + w.omega + w.ivRank;
  const weightedSum = atr * w.atr + omegaExposure * w.omega + ivRankRisk * w.ivRank;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function computeQuickSheetTargetScore_(inputs, config) {
  const w = QUICK_SHEET_WEIGHTS.target;
  const horizonDays = volatilityProbabilityHorizonDays_(inputs.daysToExpiry, config);
  const volProbRaw = volatilityProbabilityScore_(
    inputs.stockPrice, inputs.targetStockPrice, inputs.iv != null ? inputs.iv / 100 : null, horizonDays, inputs.optionType
  );
  const volProb = volProbRaw != null ? volProbRaw : 50;
  const momentum = momentumAlignmentScore_(inputs.momentumPercent, inputs.optionType);
  const rs = relativeStrengthScore_(inputs.rsPercent, inputs.optionType);
  const sector = sectorAlignmentScore_(inputs.sectorPercent, inputs.optionType);
  const trend = trendAlignmentScore_(inputs.trendPercent, inputs.optionType);
  const volume = relativeVolumeScore_(inputs.relativeVolumePercent);
  const regime = marketRegimeScore_(inputs.marketRegimePercent, inputs.optionType);
  const ivEvent = catalystRiskScore_(inputs.daysToCatalyst, SWING_WINDOW_DAYS);

  const totalWeight = w.volProb + w.momentum + w.rs + w.sector + w.trend + w.volume + w.marketRegime + w.ivEvent;
  const weightedSum = volProb * w.volProb + momentum * w.momentum + rs * w.rs + sector * w.sector +
    trend * w.trend + volume * w.volume + regime * w.marketRegime + ivEvent * w.ivEvent;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function computeQuickSheetQuickScore_(inputs, config) {
  const w = QUICK_SHEET_WEIGHTS.quick;
  const rs = relativeStrengthScore_(inputs.rsPercent, inputs.optionType);
  const atr = atrOpportunityScore_(inputs.atrPercent);

  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const daysToTarget = (omega != null) ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, config.minProfitPercent) : null;
  const requiredMove = targetFeasibilityScoreForObjective_(daysToTarget, config);

  const lowRisk = isPlausible_(inputs.riskScoreValue, 0, 100) ? (100 - inputs.riskScoreValue) : 50;
  const sector = sectorAlignmentScore_(inputs.sectorPercent, inputs.optionType);
  const ivRank = ivRankSuitabilityScore_(inputs.ivRank);
  const delta = deltaExposureScore_(inputs.delta);

  const totalWeight = w.rs + w.atr + w.requiredMove + w.risk + w.sector + w.ivRank + w.delta;
  const weightedSum = rs * w.rs + atr * w.atr + requiredMove * w.requiredMove + lowRisk * w.risk +
    sector * w.sector + ivRank * w.ivRank + delta * w.delta;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function computeRiskySheetRiskScore_(inputs) {
  const w = RISKY_SHEET_WEIGHTS.risk;
  const drawdown = drawdownRiskScore_(inputs.maxDrawdownPercent);
  const optionRisk = optionRiskScore_(inputs.bidAskSpreadPct, inputs.extrinsicValue, inputs.optionPrice);
  const liquidityRisk = liquidityRiskScore_(inputs.oi, inputs.volume);

  const totalWeight = w.drawdown + w.optionRisk + w.liquidityRisk;
  const weightedSum = drawdown * w.drawdown + optionRisk * w.optionRisk + liquidityRisk * w.liquidityRisk;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function computeRiskySheetTargetScore_(inputs, config) {
  const w = RISKY_SHEET_WEIGHTS.target;
  const hitRatePercent = inputs.optionType === 'P' ? inputs.hitRatePutPercent : inputs.hitRateCallPercent;
  const hitRate = historicalHitRateScore_(hitRatePercent);

  const horizonDays = volatilityProbabilityHorizonDays_(inputs.daysToExpiry, config);
  const volProbRaw = volatilityProbabilityScore_(
    inputs.stockPrice, inputs.targetStockPrice, inputs.iv != null ? inputs.iv / 100 : null, horizonDays, inputs.optionType
  );
  const volProb = volProbRaw != null ? volProbRaw : 50;
  const momentum = momentumAlignmentScore_(inputs.momentumPercent, inputs.optionType);
  const rs = relativeStrengthScore_(inputs.rsPercent, inputs.optionType);
  const sector = sectorAlignmentScore_(inputs.sectorPercent, inputs.optionType);
  const regime = marketRegimeScore_(inputs.marketRegimePercent, inputs.optionType);
  const volume = relativeVolumeScore_(inputs.relativeVolumePercent);
  const ivEvent = catalystRiskScore_(inputs.daysToCatalyst, SWING_WINDOW_DAYS);

  const totalWeight = w.hitRate + w.volProb + w.momentum + w.rs + w.sector + w.marketRegime + w.volume + w.ivEvent;
  const weightedSum = hitRate * w.hitRate + volProb * w.volProb + momentum * w.momentum + rs * w.rs +
    sector * w.sector + regime * w.marketRegime + volume * w.volume + ivEvent * w.ivEvent;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function computeRiskySheetQuickScore_(inputs, config) {
  const w = RISKY_SHEET_WEIGHTS.quick;
  const rs = relativeStrengthScore_(inputs.rsPercent, inputs.optionType);

  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const daysToTarget = (omega != null) ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, config.minProfitPercent) : null;
  const requiredMove = targetFeasibilityScoreForObjective_(daysToTarget, config);

  const targetProb = isPlausible_(inputs.targetScoreValue, 0, 100) ? inputs.targetScoreValue : 50;
  const atr = atrOpportunityScore_(inputs.atrPercent);
  const sector = sectorAlignmentScore_(inputs.sectorPercent, inputs.optionType);
  const ivRank = ivRankSuitabilityScore_(inputs.ivRank);
  const delta = deltaExposureScore_(inputs.delta);

  const totalWeight = w.rs + w.requiredMove + w.targetProb + w.atr + w.sector + w.ivRank + w.delta;
  const weightedSum = rs * w.rs + requiredMove * w.requiredMove + targetProb * w.targetProb + atr * w.atr +
    sector * w.sector + ivRank * w.ivRank + delta * w.delta;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}


/* ============================================================================
 * LEAP — REVISED FORMULAS (long-term stock-replacement hold: out at +50%
 * profit or -10% loss; long-dated, high-delta to mimic stock; capital
 * efficiency matters here in a way it deliberately doesn't on Quick/
 * Risky). Same Filter/Risk/Target architecture as Quick & Risky above —
 * Target is a PROBABILITY (%), same convention: the underlying target
 * stock price is still computed (anchors Volatility Probability) and
 * shown in the cell's note, not written to the cell itself.
 * ========================================================================== */

const LEAP_SHEET_WEIGHTS = {
  filter: { quality: 25, upside: 20, delta: 20, capitalEfficiency: 20, liquidity: 10, momentum: 5 },
  risk: { velocity: 60, catalystRisk: 20, execution: 20 },
  target: { volProb: 30, momentum: 25, rs: 15, sector: 10, trend: 10, marketRegime: 5, ivEvent: 5 }
};

function computeLeapSheetFilterScore_(inputs) {
  const w = LEAP_SHEET_WEIGHTS.filter;
  const quality = qualityScore_(inputs.ratingScore);
  const upside = upsideAlignmentScore_(inputs.upsidePercent, inputs.optionType);
  const delta = deltaExposureScore_(inputs.delta);
  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const capitalEfficiency = capitalEfficiencyScore_(omega);
  const liquidity = liquidityScore_(inputs.openInterest, inputs.volume);
  const momentum = momentumAlignmentScore_(inputs.momentumPercent, inputs.optionType);

  const totalWeight = w.quality + w.upside + w.delta + w.capitalEfficiency + w.liquidity + w.momentum;
  const weightedSum = quality * w.quality + upside * w.upside + delta * w.delta +
    capitalEfficiency * w.capitalEfficiency + liquidity * w.liquidity + momentum * w.momentum;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

// Reuses velocityRiskScoreLeap_ (5-90 day scale) and LEAP_LOSS_TOLERANCE_
// PERCENT (10%) — same underlying "how many days to swing against your
// actual loss threshold" idea as Quick/Risky's Risk, just calibrated to
// a multi-month hold instead of days.
function computeLeapSheetRiskScore_(inputs) {
  const w = LEAP_SHEET_WEIGHTS.risk;
  const omega = computeOmega_(inputs.delta, inputs.stockPrice, inputs.optionPrice);
  const daysToLoss = (omega != null) ? estimatedDaysForPremiumMove_(inputs.atrPercent, omega, LEAP_LOSS_TOLERANCE_PERCENT) : null;
  const velocity = velocityRiskScoreLeap_(daysToLoss);
  const catalystRisk = 100 - catalystRiskScore_(inputs.daysToCatalyst, SWING_WINDOW_DAYS);
  const execution = executionRiskScore_(inputs.bidAskSpreadPct);

  const totalWeight = w.velocity + w.catalystRisk + w.execution;
  const weightedSum = velocity * w.velocity + catalystRisk * w.catalystRisk + execution * w.execution;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function computeLeapSheetTargetScore_(inputs, config) {
  const w = LEAP_SHEET_WEIGHTS.target;
  const horizonDays = volatilityProbabilityHorizonDays_(inputs.daysToExpiry, config);
  const volProbRaw = volatilityProbabilityScore_(
    inputs.stockPrice, inputs.targetStockPrice, inputs.iv != null ? inputs.iv / 100 : null, horizonDays, inputs.optionType
  );
  const volProb = volProbRaw != null ? volProbRaw : 50;
  const momentum = momentumAlignmentScore_(inputs.momentumPercent, inputs.optionType);
  const rs = relativeStrengthScore_(inputs.rsPercent, inputs.optionType);
  const sector = sectorAlignmentScore_(inputs.sectorPercent, inputs.optionType);
  const trend = trendAlignmentScore_(inputs.trendPercent, inputs.optionType);
  const regime = marketRegimeScore_(inputs.marketRegimePercent, inputs.optionType);
  const ivEvent = catalystRiskScore_(inputs.daysToCatalyst, SWING_WINDOW_DAYS);

  const totalWeight = w.volProb + w.momentum + w.rs + w.sector + w.trend + w.marketRegime + w.ivEvent;
  const weightedSum = volProb * w.volProb + momentum * w.momentum + rs * w.rs + sector * w.sector +
    trend * w.trend + regime * w.marketRegime + ivEvent * w.ivEvent;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}


/* ============================================================================
 * COMBINED SCORE — the single ranking metric for Quick/Risky/Leap: a
 * weighted blend of Filter, Target Probability, and (100 - Risk). Just a
 * final roll-up of numbers already computed above elsewhere in this file —
 * not a new data source, no extra network calls. Written to a "Score"
 * column (add that header on the Quick/Risky/Leap tabs to enable it) and
 * used as the new ranking/sort/top-5-border key on those three sheets.
 * ========================================================================== */

const SCORE_WEIGHTS_BY_SHEET = {
  'Quick': { filter: 0.50, targetProb: 0.30, risk: 0.20 },
  'Risky': { filter: 0.45, targetProb: 0.25, risk: 0.30 },
  'Leap':  { filter: 0.50, targetProb: 0.20, risk: 0.30 }
};

function computeCombinedScore_(sheetName, filterScoreValue, targetProbabilityValue, riskScoreValue) {
  const w = SCORE_WEIGHTS_BY_SHEET[sheetName];
  if (!w) return null;
  if (!isPlausible_(filterScoreValue, 0, 100) || !isPlausible_(targetProbabilityValue, 0, 100) || !isPlausible_(riskScoreValue, 0, 100)) {
    return null;
  }
  const value = w.filter * filterScoreValue + w.targetProb * targetProbabilityValue + w.risk * (100 - riskScoreValue);
  return Math.round(value * 10) / 10;
}


/* ============================================================================
 * TOP-5 FILTER HIGHLIGHT
 * ----------------------------------------------------------------------------
 * You said you scan the top 5 Filter Score rows, then read Risk, Sector
 * Momentum, Change Now, ATR%, IV Rank, and Days to Catalyst for exactly
 * those rows. Those columns aren't next to each other on the sheet, so
 * instead of another whole-row paint job this draws one consistent border
 * color around just those cells, only on the 5 rows that earned it this
 * run — everything else on the sheet (Risk/Filter bands, sign-based font
 * colors) is left completely alone.
 *
 * On Quick/Risky/Leap (once a "Score" column exists), the ranking key is
 * Score instead of Filter Score — see rankKey/rankLabel below and the two
 * call sites near the end of validateAndUpdate.
 *
 * Two-call design, not per-row: clearTopFilterHighlight_ wipes the border/
 * note from the full column range in ~7 calls (so a row that drops out of
 * the top 5 doesn't keep a stale border forever), then
 * applyTopFilterHighlight_ draws it fresh on however many rows qualify
 * (<= TOP_FILTER_COUNT * 6 setBorder calls + 1 note per row). Both run once
 * per validateAndUpdate call, not once per ticker — negligible next to the
 * network calls that already dominate this script's runtime.
 * ========================================================================== */

function clearTopFilterHighlight_(sheet, map, lastRow) {
  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return;

  TOP_FILTER_HIGHLIGHT_COLS.forEach(function (key) {
    const col = map[key];
    if (!col) return;
    sheet.getRange(DATA_START_ROW, col, numRows, 1).setBorder(false, false, false, false, false, false);
  });

  if (map.ticker) {
    const tickerRange = sheet.getRange(DATA_START_ROW, map.ticker, numRows, 1);
    tickerRange.setFontWeight('normal');
    tickerRange.clearNote();
  }
}

// Reads the ranking column (Score if rankKey is 'score', else Filter
// Score) directly from the sheet and highlights the top rows — called
// AFTER sortRowsByQuickScoreDescending_, not before. Borders do NOT move
// with Range.sort() in Sheets (values/backgrounds/fonts do, but borders
// are an edge property, not a per-cell one) — so highlighting has to
// happen against the FINAL sorted positions, not positions captured
// mid-loop before the sort ran.
function applyTopFilterHighlight_(sheet, map, lastRow, rankKey, rankLabel) {
  rankKey = rankKey || 'filterScore';
  rankLabel = rankLabel || 'Filter Score';
  if (!map[rankKey]) return [];
  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return [];

  const values = sheet.getRange(DATA_START_ROW, map[rankKey], numRows, 1).getValues();
  const ranked = [];
  for (let i = 0; i < numRows && ranked.length < TOP_FILTER_COUNT; i++) {
    const v = values[i][0];
    if (v === '' || v == null || isNaN(v)) continue;
    ranked.push({ row: DATA_START_ROW + i, score: v });
  }

  ranked.forEach(function (entry, i) {
    const rank = i + 1;

    TOP_FILTER_HIGHLIGHT_COLS.forEach(function (key) {
      const col = map[key];
      if (!col) return;
      sheet.getRange(entry.row, col).setBorder(
        true, true, true, true, false, false,
        COLOR_TOP_FILTER_BORDER, SpreadsheetApp.BorderStyle.SOLID_THICK
      );
    });

    if (map.ticker) {
      sheet.getRange(entry.row, map.ticker)
        .setFontWeight('bold')
        .setNote('#' + rank + ' of ' + ranked.length + ' by ' + rankLabel + ' this run — cross-check the bordered Risk / Sector Momentum / %age / ATR% / IV Rank / Catalyst cells on this row.');
    }
  });

  return ranked;
}

// BEST SCORE ROW LOOKUP (Quick/Risky/Leap only) — read-only, no longer
// paints a special highlight on the winning row (removed per request: the
// top row should look like any other, banded the same way via its own
// Filter/Risk/Target/Score values via higherIsBetterBandColor_, with
// nothing distinguishing it). Kept only so the run summary can still
// name which row scored highest. Reads directly from the sheet (same
// pattern as applyTopFilterHighlight_) so it reflects final post-sort
// positions.
function findBestScoreRow_(sheet, map, lastRow) {
  if (!map.score) return null;
  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return null;

  const scoreValues = sheet.getRange(DATA_START_ROW, map.score, numRows, 1).getValues();

  let bestRow = null;
  let bestScore = -Infinity;
  for (let i = 0; i < numRows; i++) {
    const v = scoreValues[i][0];
    if (v === '' || v == null || isNaN(v)) continue;
    if (v > bestScore) {
      bestScore = v;
      bestRow = DATA_START_ROW + i;
    }
  }

  if (bestRow == null) return null;
  return { row: bestRow, combinedScore: bestScore };
}

// Sorts the entire data range (every column, not just the tracked ones —
// this includes your own PtC/PtN/Invested formulas, so their same-row
// relative references move correctly with their row, same as a native
// manual sort) by the given sortKey descending (Score on Quick/Risky/Leap
// once that column exists, Filter Score everywhere else — see the two
// call sites near the end of validateAndUpdate). Called BEFORE both top-5
// highlights now (not after) — see the doc comment above
// applyTopFilterHighlight_ for why borders specifically need to be
// applied post-sort rather than carried through it.
function sortRowsByQuickScoreDescending_(sheet, map, lastRow, sortKey) {
  const key = sortKey || 'filterScore';
  const col = map[key];
  if (!col || lastRow < DATA_START_ROW) return;
  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 1) return;
  const lastCol = sheet.getLastColumn();
  sheet.getRange(DATA_START_ROW, 1, numRows, lastCol).sort({ column: col, ascending: false });
}


/* ============================================================================
 * DATE HELPERS
 * ========================================================================== */

function formatDateForApi_(date) { return Utilities.formatDate(date, 'America/New_York', 'yyyy-MM-dd'); }

function parseApiDate_(value) {
  if (!value) return null;
  const parts = String(value).split('-');
  if (parts.length !== 3) return null;
  const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]), 12, 0, 0);
  return isNaN(d.getTime()) ? null : d;
}


/* ============================================================================
 * MAIN VALIDATOR
 * ========================================================================== */

/* ============================================================================
 * CLOUD FUNCTION TASTYTRADE BATCH PREFETCH (for Validate & Update)
 * ----------------------------------------------------------------------------
 * Same shared Cloud Function ResearchEngine.gs already uses for ticker-
 * level data (see getCloudFunctionUrl_/getCloudFunctionSharedSecret_,
 * defined in ResearchEngine.gs and shared globally across this project),
 * now also fetching every row's option quote concurrently in one request.
 * Fully optional and fails soft — no credentials configured, or the call
 * errors out for any reason, and this just returns an empty map, so the
 * per-row loop's own `tastyQuoteMap[occSymbol] || fetchTastyTradeQuote_(...)`
 * falls back to fetching individually exactly as it always has.
 * ========================================================================== */
function prefetchTastyQuotesViaCloudFunction_(sheet, map, lastRow) {
  const cloudFunctionUrl = getCloudFunctionUrl_();
  const sharedSecret = getCloudFunctionSharedSecret_();
  if (!cloudFunctionUrl || !sharedSecret) return {};

  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return {};

  // Bulk-read once to build the OCC symbol list — the per-row loop below
  // still reads these same three columns itself afterward (a small,
  // local, cheap redundancy, not a network cost).
  const tickerValues = sheet.getRange(DATA_START_ROW, map.ticker, numRows, 1).getValues();
  const strikeValues = sheet.getRange(DATA_START_ROW, map.strike, numRows, 1).getValues();
  const expiryValues = sheet.getRange(DATA_START_ROW, map.expiry, numRows, 1).getValues();

  const occSymbols = [];
  for (let i = 0; i < numRows; i++) {
    const tickerVal = tickerValues[i][0];
    if (!tickerVal) continue;
    const parsedStrike = parseStrikeCell_(strikeValues[i][0]);
    const parsedExpiry = parseExpiryCell_(expiryValues[i][0]);
    if (!parsedStrike || !parsedExpiry) continue;
    const ticker = String(tickerVal).trim().toUpperCase();
    occSymbols.push(buildOccSymbol_(ticker, parsedExpiry, parsedStrike.strike, parsedStrike.type));
  }
  if (!occSymbols.length) return {};

  const startTime = Date.now();
  let resp;
  try {
    resp = UrlFetchApp.fetch(cloudFunctionUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ apiKey: sharedSecret, occSymbols: occSymbols }),
      muteHttpExceptions: true
    });
  } catch (e) {
    logToSheet_('Cloud Function TastyTrade prefetch FAILED (network error) \u2014 falling back to per-row fetching: ' + e);
    return {};
  }

  if (resp.getResponseCode() !== 200) {
    logToSheet_('Cloud Function TastyTrade prefetch FAILED (HTTP ' + resp.getResponseCode() + ') \u2014 falling back to per-row fetching: ' +
      resp.getContentText().substring(0, 300));
    return {};
  }

  let json;
  try {
    json = JSON.parse(resp.getContentText());
  } catch (e) {
    logToSheet_('Cloud Function TastyTrade prefetch FAILED (unparseable response) \u2014 falling back to per-row fetching: ' + e);
    return {};
  }

  const elapsedMs = Date.now() - startTime;
  const tastyResults = json.tastyResults || {};
  const tastyErrorCount = Object.keys(json.tastyErrors || {}).length;
  logToSheet_('Cloud Function TastyTrade prefetch: ' + occSymbols.length + ' contracts requested in ' + elapsedMs + 'ms \u2014 ' +
    Object.keys(tastyResults).length + ' succeeded' +
    (tastyErrorCount ? (', ' + tastyErrorCount + ' failed (will retry individually)') : '') + '.');

  const diag = json.diagnostics || {};
  if (diag.tasty) {
    logToSheet_('Cloud Function TastyTrade prefetch \u2014 sample failure reason: ' + diag.tasty);
  }

  return tastyResults;
}

function validateAndUpdate(sheetOverride, timeBudgetMsOverride) {
  const sheet = sheetOverride || SpreadsheetApp.getActiveSheet();
  const map = getColumnMap_(sheet);
  const ui = tryGetUi_();

  // One-time cleanup of the old letter-based sign rule, if it's still on
  // the sheet from before — see FONT COLOR POLICY further down for what
  // replaced it (resetNeutralColumnFontColor_ / FONT_COLOR_EXEMPT_KEYS).
  removeLegacySignBasedFontRules_(sheet);

  const required = ['ticker', 'strike', 'expiry'];
  const missing = required.filter(function (k) { return !map[k]; });
  if (missing.length) {
    notify_(ui, 'Validate & Update', 'Missing required columns on "' + sheet.getName() + '": ' + missing.join(', '));
    return;
  }

  // Extends any column that already holds a formula (your own — Net
  // Price, whatever else you've set up) down to match this sheet's
  // actual last row, using the lowest existing formula in that column as
  // the template. Covers new rows regardless of how they got there — the
  // pipeline's Promote stage adding tickers, or you adding them by hand
  // and just running this directly. Never touches a column that holds
  // plain script-written values (Ticker/Strike/Expiry/Score/etc.), since
  // those never have a formula in the template row to copy in the first
  // place.
  extendFormulaColumnsToLastRow_(sheet, map);

  const finnhubApiKey = getFinnhubApiKey_();
  if (!finnhubApiKey) {
    const proceed = confirmOrProceed_(
      ui,
      'Finnhub API key not configured',
      'Catalyst / Catalyst Date columns will fall back to Yahoo Finance (less reliable, no fiscal quarter/year).\n\nUse: Options Validator > Set Finnhub API Key\n\nContinue anyway?'
    );
    if (!proceed) return;
  }

  const fmpApiKey = getFmpApiKey_();
  if (!fmpApiKey) {
    const proceedFmp = confirmOrProceed_(
      ui,
      'FMP API key not configured',
      '"Sector Momentum", "Theme / Cluster" and the quality factor in "Leap" will stay blank/neutral where Yahoo has nothing either.\n\nUse: Options Validator > Set FMP API Key\n\nContinue anyway?'
    );
    if (!proceedFmp) return;
  }

  const alphaVantageApiKey = getAlphaVantageApiKey_();

  let sectorPerfMapCache = null;
  function getSectorPerfMap_() {
    if (sectorPerfMapCache !== null) return sectorPerfMapCache;
    sectorPerfMapCache = fmpApiKey ? fetchFmpSectorPerformance_(fmpApiKey) : {};
    return sectorPerfMapCache;
  }

  const sectorEtfCache = {};

  const missingTracked = Object.keys(TRACKED_FIELDS).filter(function (k) { return !map[k]; });
  if (missingTracked.length) {
    const labels = missingTracked.map(function (k) { return TRACKED_FIELDS[k]; }).join(', ');
    const proceed = confirmOrProceed_(ui, 'Heads up', "Couldn't find columns for: " + labels + '.\n\nThose fields will not be updated.\n\nContinue?');
    if (!proceed) return;
  }

  const accessToken = getTastyTradeAccessToken_();
  if (!accessToken) Logger.log('No TastyTrade token. Yahoo fallback will be used.');

  // Which score columns this sheet actually needs — see
  // getScoreRelevanceForSheet_ doc comment above.
  const scoreRelevance = getScoreRelevanceForSheet_(sheet.getName());
  // Whether this run should use the objective-specific Risk/Filter/Target
  // logic — see the "PER-SHEET OBJECTIVE" section above. null on any
  // sheet not in TRADE_OBJECTIVE_SHEETS (e.g. Leap).
  const objectiveConfig = TRADE_OBJECTIVE_SHEETS[sheet.getName()] || null;
  const hasObjectiveConfig = objectiveConfig != null;
  // Quick and Risky get your custom-weighted Risk/Quick/Target formulas
  // instead of the generic objective-sheet ones above — see the "QUICK &
  // RISKY — REVISED FORMULAS" section. Any other sheet (or a future
  // objective sheet not named Quick/Risky) keeps the generic path.
  const revisedFormulaSheetName = (sheet.getName() === 'Quick' || sheet.getName() === 'Risky' || sheet.getName() === 'Leap') ? sheet.getName() : null;

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  const runTimestamp = new Date();
  const scriptStartTime = Date.now();
  const timeBudgetMs = timeBudgetMsOverride || EXECUTION_TIME_BUDGET_MS;

  // Forces every column's font to black except the named exceptions —
  // see FONT COLOR POLICY / FONT_COLOR_EXEMPT_KEYS further down.
  resetNeutralColumnFontColor_(sheet, map, lastRow);

  // Fixed background on StockPrice/Price/PtN so they stand out visually,
  // independent of the black-font reset above (different property).
  applyStandoutColumnHighlights_(sheet, map, lastRow);

  // GOOGLEFINANCE helper sheet — see the doc comment above getOrCreateGfHelperSheet_.
  // Ensuring rows only appends (never touches existing ones), so this is
  // fast even on a full run; reading is a single getValues() call.
  const gfSheet = getOrCreateGfHelperSheet_();
  const neededGfSymbols = collectNeededGfSymbols_(sheet, map, lastRow);
  const addedGfRows = ensureGfSymbolRows_(gfSheet, Object.keys(neededGfSymbols));
  if (addedGfRows > 0) SpreadsheetApp.flush();
  const gfDataMap = readGfDataMap_(gfSheet);

  let okCount = 0, fallbackCount = 0, failCount = 0, changedCells = 0, changedRows = 0;
  let analystTargetCount = 0, changeNowCount = 0, sectorMomentumCount = 0, themeClusterCount = 0;

  // Slow-changing data cache: loaded ONCE for the whole run, written ONCE
  // (batched) at the end — not per ticker, per field.
  const slowCache = loadSlowCache_();
  const pendingSlowWrites = {};
  const slowStats = { analystFresh: 0, analystCached: 0, themeFresh: 0, themeCached: 0, themeLocal: 0, qualityFresh: 0, qualityCached: 0, catalystFresh: 0, catalystCached: 0, atrFresh: 0, atrCached: 0 };

  // User-taught sector/industry overrides: also loaded once, checked
  // before the built-in static table or any live source, never expires.
  const sectorOverrides = loadSectorOverrides_();

  // SPY's daily bars for Relative Strength — fetched at most once per
  // run (lazy singleton, same pattern as getSectorPerfMap_ above), and
  // themselves slow-cached a full day via the same DAILYBARS mechanism
  // every ticker's own ATR bars use.
  let spyBarsCache;
  let spyBarsFetched = false;
  function getSpyBars_() {
    if (spyBarsFetched) return spyBarsCache;
    const spyResult = getSlowCached_(slowCache, pendingSlowWrites, 'DAILYBARS', 'SPY', SLOW_REFRESH_DAYS.DAILYBARS, function () {
      return fetchYahooDailyBars_('SPY');
    });
    spyBarsCache = spyResult.value;
    spyBarsFetched = true;
    return spyBarsCache;
  }

  // Market Regime: SPY's own trend (price vs. its 20-day MA), computed
  // ONCE per run from the same SPY bars above — identical for every row,
  // by design (it's a market-wide backdrop check, not a per-ticker one).
  let marketRegimePercentCache;
  let marketRegimeComputed = false;
  function getMarketRegimePercent_() {
    if (marketRegimeComputed) return marketRegimePercentCache;
    marketRegimePercentCache = computeTrendPercent_(getSpyBars_(), TREND_MA_PERIOD);
    marketRegimeComputed = true;
    return marketRegimePercentCache;
  }

  const tickerCache = {};

  // Clears last run's top-5 highlight before this run decides the new
  // top 5 — otherwise a row that WAS top-5 but isn't anymore keeps its
  // border forever. Cheap: a handful of whole-column range calls, not a
  // per-row loop.
  clearTopFilterHighlight_(sheet, map, lastRow);
  const revisedFormulaSheetForHighlight = (sheet.getName() === 'Quick' || sheet.getName() === 'Risky' || sheet.getName() === 'Leap') ? sheet.getName() : null;
  // Clears any leftover bright-green best-row background from before this
  // highlight was removed (see findBestScoreRow_ further down) — never
  // reapplied, just a one-time cleanup so old runs' highlight doesn't
  // linger forever.
  if (revisedFormulaSheetForHighlight) {
    const cleanupRows = lastRow - DATA_START_ROW + 1;
    if (cleanupRows > 0) {
      ['filterScore', 'riskScore', 'target', 'score'].forEach(function (key) {
        const col = map[key];
        if (col) sheet.getRange(DATA_START_ROW, col, cleanupRows, 1).setBackground(null);
      });
    }
  }
  let lastRowProcessed = DATA_START_ROW - 1;
  let timeBudgetExceeded = false;

  // Cloud Function batch prefetch: fetches every row's option quote
  // (mark/delta/gamma/bid/ask/volume/OI) concurrently in ONE request,
  // instead of one TastyTrade call per row here. This is Validate &
  // Update's actual dominant per-row cost — unlike Research's ticker-
  // level data, this can't be cached day-to-day (prices change
  // constantly), so every run needs it fresh regardless. Fails soft: not
  // configured, or the call fails for any reason, and the per-row loop
  // below just falls back to fetching individually, exactly as before.
  const tastyQuoteMap = prefetchTastyQuotesViaCloudFunction_(sheet, map, lastRow);

  // Full batching: the whole data range's values/backgrounds/font colors/
  // notes/number formats are read ONCE here, mutated in place as each
  // row is processed below (exactly the same logic as before — only how
  // reads/writes reach the sheet changes), then written back in one bulk
  // call per property after the loop finishes. Replaces what used to be
  // dozens of individual getRange()/getValue()/setValue()/setBackground()
  // calls per row with a handful of calls for the whole sheet.
  const numDataRows = lastRow - DATA_START_ROW + 1;
  let allValues = [], allBackgrounds = [], allFontColors = [], allNotes = [], allNumberFormats = [];
  if (numDataRows > 0) {
    const dataRange = sheet.getRange(DATA_START_ROW, 1, numDataRows, lastCol);
    allValues = dataRange.getValues();
    allBackgrounds = dataRange.getBackgrounds();
    allFontColors = dataRange.getFontColors();
    allNotes = dataRange.getNotes();
    allNumberFormats = dataRange.getNumberFormats();
  }
  // Rows needing the Target cell's conditional border, tracked separately
  // since borders aren't part of the bulk setValues/setBackgrounds/
  // setNotes calls — applied in a small dedicated pass after the loop,
  // only for the rows that actually need one (active positions).
  const targetBorderRows = []; // { row, on }

  // Buffered version of writeStatus_ (defined near the bottom of this
  // file) — same exact logic (status value + background, timestamp
  // value), just writing into this run's in-memory arrays instead of the
  // sheet directly, so it can be flushed once in bulk after the loop.
  function writeStatusBuffered_(rowIdx, text, color) {
    if (map.status) {
      allValues[rowIdx][map.status - 1] = text;
      allBackgrounds[rowIdx][map.status - 1] = color;
    }
    if (map.timestamp) {
      allValues[rowIdx][map.timestamp - 1] = runTimestamp;
    }
  }

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    if (Date.now() - scriptStartTime > timeBudgetMs) {
      timeBudgetExceeded = true;
      break;
    }
    lastRowProcessed = row;
    const rowIdx = row - DATA_START_ROW;

    // Indexes into the whole-range arrays loaded before the loop, instead
    // of a fresh per-row read — rowOut/bgOut/fontOut/noteOut/fmtOut are
    // this row's slice of each, mutated directly in place below exactly
    // where a setValue/setBackground/etc. call used to go, then written
    // back to the sheet in one bulk call per property after the loop.
    const rowValues = allValues[rowIdx];
    const rowOut = allValues[rowIdx];
    const bgOut = allBackgrounds[rowIdx];
    const fontOut = allFontColors[rowIdx];
    const noteOut = allNotes[rowIdx];
    const fmtOut = allNumberFormats[rowIdx];

    const tickerVal = rowValues[map.ticker - 1];
    if (!tickerVal) continue;

    const strikeVal = rowValues[map.strike - 1];
    const expiryVal = rowValues[map.expiry - 1];
    const parsedStrike = parseStrikeCell_(strikeVal);
    const parsedExpiry = parseExpiryCell_(expiryVal);

    if (!parsedStrike || !parsedExpiry) {
      writeStatusBuffered_(rowIdx, 'PARSE ERROR — check Strike/Expiry format', '#f4cccc');
      failCount++;
      continue;
    }

    const ticker = String(tickerVal).trim().toUpperCase();
    const occSymbol = buildOccSymbol_(ticker, parsedExpiry, parsedStrike.strike, parsedStrike.type);
    const daysToExpiry = Math.round((parsedExpiry.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));

    const tastyFromPrefetch = !!tastyQuoteMap[occSymbol];
    const tastyOptionQuote = tastyQuoteMap[occSymbol] || fetchTastyTradeQuote_(occSymbol, accessToken);

    const tickerData = getCachedTickerData_(
      ticker, accessToken, finnhubApiKey, fmpApiKey, alphaVantageApiKey,
      getSectorPerfMap_, sectorEtfCache, tickerCache, slowCache, pendingSlowWrites, slowStats, sectorOverrides, getSpyBars_, gfDataMap
    );

    // Yahoo's option quote is fetched LAZILY now — only when Tasty's
    // response is missing a field that actually matters downstream, OR
    // when the user's own GOOGLEFINANCE stock-price cell is empty/invalid
    // (Yahoo's underlying field is the only fallback for that specific
    // case, so it can't be skipped just because the option quote itself
    // was complete). Tasty's per-contract IV is commonly absent
    // (confirmed via Debug: Fetch Raw Quote), but IV is only ever USED
    // here to estimate delta/gamma via Black-Scholes — an estimate
    // that's already skipped whenever Tasty provides real delta/gamma
    // directly, which it reliably does. So a missing contractIv alone
    // has no downstream consequence and isn't worth a second network
    // call for.
    const tastyOptionQuoteComplete = tastyOptionQuote &&
      tastyOptionQuote.mark != null && tastyOptionQuote.delta != null &&
      tastyOptionQuote.gamma != null && tastyOptionQuote.bid != null && tastyOptionQuote.ask != null;

    const stockPriceCellValid = map.stockPrice &&
      isPlausible_(parseFloat(rowValues[map.stockPrice - 1]), 0.01, null);

    const yahooQuote = (tastyOptionQuoteComplete && stockPriceCellValid)
      ? null
      : fetchYahooQuote_(ticker, parsedExpiry, parsedStrike.strike, parsedStrike.type);

    if (!tastyOptionQuote && !yahooQuote) {
      writeStatusBuffered_(rowIdx, 'NOT FOUND — verify strike/expiry', '#f4cccc');
      failCount++;
      Utilities.sleep(REQUEST_DELAY_MS);
      continue;
    }

    const merged = {};
    const sourceByField = {};
    let changeNowNumeric = null;
    let sectorMomentumNumeric = null;

    // OPTION PRICE
    if (tastyOptionQuote && tastyOptionQuote.mark != null) {
      merged.optionPrice = tastyOptionQuote.mark;
      sourceByField.optionPrice = 'TastyTrade';
    } else if (yahooQuote && yahooQuote.mark != null) {
      merged.optionPrice = yahooQuote.mark;
      sourceByField.optionPrice = 'Yahoo Finance (unofficial)';
    }

    // VOLUME
    if (tastyOptionQuote && tastyOptionQuote.volume != null) {
      merged.volume = tastyOptionQuote.volume;
      sourceByField.volume = 'TastyTrade';
    } else if (yahooQuote && yahooQuote.volume != null) {
      merged.volume = yahooQuote.volume;
      sourceByField.volume = 'Yahoo Finance (unofficial)';
    }

    // CURRENT IV — actual contract-level implied volatility (a real vol %,
    // NOT the underlying's IV Rank — see IV RANK below for that).
    if (tastyOptionQuote && tastyOptionQuote.contractIv != null) {
      merged.iv = tastyOptionQuote.contractIv;
      sourceByField.iv = 'TastyTrade (contract IV)';
    } else if (yahooQuote && yahooQuote.iv != null) {
      merged.iv = yahooQuote.iv;
      sourceByField.iv = 'Yahoo Finance (contract IV)';
    }

    // IV RANK — a separate 0-100 percentile metric, TastyTrade-only (no
    // free equivalent exists elsewhere); left blank rather than
    // approximated if TastyTrade isn't configured.
    if (tickerData.metrics && tickerData.metrics.ivPercent != null) {
      merged.ivRank = tickerData.metrics.ivPercent;
      sourceByField.ivRank = 'TastyTrade (underlying IV Rank)';
    }

    // ATR% — realized-volatility measure (14-day Wilder ATR / last close),
    // ticker-level so it's identical across every row sharing the same
    // underlying. Its daily bars are slow-cached; see getCachedTickerData_.
    if (tickerData.atrInfo && tickerData.atrInfo.atrPercent != null) {
      merged.atrPercent = tickerData.atrInfo.atrPercent;
      sourceByField.atrPercent = tickerData.atrInfo.source;
    }

    // RS vs SPY — ticker's N-day return minus SPY's over the same window;
    // reuses the same daily bars as ATR%, plus one shared SPY fetch.
    if (tickerData.rsInfo && tickerData.rsInfo.relativeStrengthPercent != null) {
      merged.relativeStrength = tickerData.rsInfo.relativeStrengthPercent;
      sourceByField.relativeStrength = tickerData.rsInfo.source;
    }

    // QUICK/RISKY REVISED-FORMULA FIELDS — see getCachedTickerData_ for
    // how each is derived. Only used on sheets with an entry in
    // TRADE_OBJECTIVE_SHEETS; harmless (just unused) elsewhere.
    if (tickerData.momentumInfo) merged.momentumPercent = tickerData.momentumInfo.momentumPercent;
    if (tickerData.trendInfo) merged.trendPercent = tickerData.trendInfo.trendPercent;
    if (tickerData.volumeTrendInfo) merged.relativeVolumePercent = tickerData.volumeTrendInfo.relativeVolumePercent;
    if (tickerData.drawdownInfo) merged.maxDrawdownPercent = tickerData.drawdownInfo.maxDrawdownPercent;
    if (tickerData.hitRateInfo) {
      merged.hitRateCallPercent = tickerData.hitRateInfo.callPercent;
      merged.hitRatePutPercent = tickerData.hitRateInfo.putPercent;
    }
    merged.marketRegimePercent = getMarketRegimePercent_();

    // OPEN INTEREST — TastyTrade first (real broker data, not subject to
    // Yahoo's unofficial-endpoint flakiness/rate-limiting), Yahoo second.
    // Both sources already reject negative values at the fetch functions
    // above, so merged.oi here is guaranteed non-negative when set at all —
    // OI can never legitimately go negative (an options market can't have
    // negative open contracts). If BOTH sources fail this run and the
    // sheet already has a negative OI sitting in it from before this
    // script was ever run, that value is left alone (never blanked) but
    // flagged in Validation Status below so it doesn't look like "no
    // changes" silently hides a real problem.
    if (tastyOptionQuote && tastyOptionQuote.openInterest != null) {
      merged.oi = tastyOptionQuote.openInterest;
      sourceByField.oi = 'TastyTrade';
    } else if (yahooQuote && yahooQuote.oi != null) {
      merged.oi = yahooQuote.oi;
      sourceByField.oi = 'Yahoo Finance (unofficial)';
    }

    let oiStaleWarning = null;
    if (map.oi && merged.oi == null) {
      const existingOi = rowValues[map.oi - 1];
      if (typeof existingOi === 'number' && existingOi < 0) {
        oiStaleWarning = 'OI shows ' + existingOi + ' (impossible) but neither TastyTrade nor Yahoo returned fresh OI this run — left untouched.';
      }
    }

    // STOCK PRICE — reads your own =GOOGLEFINANCE(ticker,"price") formula
    // directly from the row's StockPrice cell (map.stockPrice) instead of
    // fetching via TastyTrade/Yahoo/FMP. This is the single biggest
    // runtime cut in this script: previously every unique ticker cost a
    // TastyTrade equity call (or a Yahoo/FMP fallback chain) just for
    // this one number. Three checks, in order, each only tried if the
    // one before it came up empty:
    //   1. Your own GOOGLEFINANCE formula (free, no network call here).
    //   2. Yahoo's option-chain underlying field (already fetched above
    //      for the option quote itself — free if it ran, no extra call).
    //   3. TastyTrade's own equity quote — a genuinely NEW network call,
    //      only made when both of the above failed, so a ticker with a
    //      working formula never pays for it. Added specifically to
    //      narrow the "Target/Score went blank" gap: GOOGLEFINANCE can
    //      show #N/A for a batch of cells at once (a known Google-side
    //      quirk, often around early morning before it settles down —
    //      you've seen this clear up on its own by market open), and
    //      Yahoo's unofficial endpoint has its own rate-limit failures;
    //      a row only loses its stock price now if all three genuinely
    //      fail together, not just the first two.
    if (map.stockPrice) {
      const stockPriceCellRaw = rowValues[map.stockPrice - 1];
      const stockPriceCellNum = parseFloat(stockPriceCellRaw);
      if (isPlausible_(stockPriceCellNum, 0.01, null)) {
        merged.stockPrice = stockPriceCellNum;
        sourceByField.stockPrice = 'GOOGLEFINANCE (your formula)';
      }
    }
    if (merged.stockPrice == null && yahooQuote && yahooQuote.underlying != null) {
      merged.stockPrice = yahooQuote.underlying;
      sourceByField.stockPrice = 'Yahoo Finance (unofficial, fallback — StockPrice cell empty/invalid)';
    }
    if (merged.stockPrice == null) {
      const tastyEquityQuote = fetchTastyEquityQuote_(ticker, accessToken);
      if (tastyEquityQuote && tastyEquityQuote.price != null) {
        merged.stockPrice = tastyEquityQuote.price;
        sourceByField.stockPrice = 'TastyTrade (fallback — GOOGLEFINANCE and Yahoo both empty/invalid)';
      }
    }

    // DELTA / GAMMA — both estimates (when a broker quote isn't available)
    // use the corrected contract-level IV (merged.iv, set above), not the
    // IV Rank — those are different units and mixing them was a bug in
    // the prior version's Delta fallback.
    if (tastyOptionQuote && tastyOptionQuote.delta != null) {
      merged.greekDelta = tastyOptionQuote.delta;
      sourceByField.greekDelta = 'TastyTrade';
    } else {
      const estimatedDelta = blackScholesDelta_(merged.stockPrice, parsedStrike.strike, daysToExpiry, merged.iv, parsedStrike.type);
      if (estimatedDelta != null) {
        merged.greekDelta = estimatedDelta;
        sourceByField.greekDelta = 'Computed (Black-Scholes estimate)';
      }
    }

    if (tastyOptionQuote && tastyOptionQuote.gamma != null) {
      merged.gamma = tastyOptionQuote.gamma;
      sourceByField.gamma = 'TastyTrade';
    } else {
      const estimatedGamma = blackScholesGamma_(merged.stockPrice, parsedStrike.strike, daysToExpiry, merged.iv);
      if (estimatedGamma != null) {
        merged.gamma = estimatedGamma;
        sourceByField.gamma = 'Computed (Black-Scholes estimate)';
      }
    }

    // BID/ASK SPREAD % — TastyTrade's own bid/ask first, Yahoo's second;
    // expressed as a % of the option's mark price (merged.optionPrice).
    let bid = null, ask = null, bidAskSource = null;
    if (tastyOptionQuote && tastyOptionQuote.bid != null && tastyOptionQuote.ask != null) {
      bid = tastyOptionQuote.bid; ask = tastyOptionQuote.ask; bidAskSource = 'TastyTrade';
    } else if (yahooQuote && yahooQuote.bid != null && yahooQuote.ask != null) {
      bid = yahooQuote.bid; ask = yahooQuote.ask; bidAskSource = 'Yahoo Finance (unofficial)';
    }
    if (bid != null && ask != null && ask >= bid && ask >= 0 && merged.optionPrice) {
      merged.bidAskSpreadPct = ((ask - bid) / merged.optionPrice) * 100;
      sourceByField.bidAskSpread = bidAskSource;
    }

    // EXTRINSIC (TIME) VALUE $ — pure math off values already merged above,
    // so it degrades gracefully to blank if either input is missing.
    if (merged.optionPrice != null && merged.stockPrice != null) {
      const intrinsic = parsedStrike.type === 'C'
        ? Math.max(merged.stockPrice - parsedStrike.strike, 0)
        : Math.max(parsedStrike.strike - merged.stockPrice, 0);
      merged.extrinsicValue = merged.optionPrice - intrinsic;
      sourceByField.extrinsicValue = 'Computed';
    }

    // ANALYST TARGET (slow-cached)
    if (tickerData.analyst && tickerData.analyst.target != null) {
      merged.analystTarget = tickerData.analyst.target;
      sourceByField.analystTarget = tickerData.analyst.source;
      analystTargetCount++;
    }

    // Next Catalyst / Catalyst Date are no longer display columns — but
    // tickerData.catalyst itself is still fetched (see getCachedTickerData_)
    // and its .date is read directly below, for Days to Catalyst and the
    // Balance Score's catalyst-risk factor.

    // DAYS TO EXPIRY / DAYS TO CATALYST — plain math, always available
    // when Strike/Expiry parsed (Days to Expiry) or a catalyst date was
    // found (Days to Catalyst). Computed here regardless of whether either
    // display column exists, since Days to Catalyst also feeds the Balance
    // Score's catalyst-risk factor below.
    merged.daysToExpiry = daysToExpiry;
    // A negative Days to Expiry means this row's option has already
    // expired — a real data-quality signal (dead/rolled position still
    // sitting in the tracker), not just a number to display. Flagged the
    // same way OI staleness is, below.
    const expiredWarning = daysToExpiry < 0
      ? ('Expiry ' + Math.abs(daysToExpiry) + ' day(s) in the past — this contract has expired.')
      : null;
    const daysToCatalystNumeric = (tickerData.catalyst && tickerData.catalyst.date)
      ? Math.round((tickerData.catalyst.date.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000))
      : null;
    if (daysToCatalystNumeric != null) {
      merged.daysToCatalyst = daysToCatalystNumeric;
      sourceByField.daysToCatalyst = 'Computed';
    } else {
      // No earnings/catalyst date found anywhere (Finnhub's calendar has
      // nothing scheduled for this ticker, and Yahoo's calendarEvents
      // module has nothing either) — write an explicit "N/A" instead of
      // silently skipping the cell, so a blank cell means "not yet
      // checked" and "N/A" means "checked, nothing scheduled."
      merged.daysToCatalyst = 'N/A';
      sourceByField.daysToCatalyst = 'No catalyst found';
    }

    // CHANGE NOW / %age + VALUE — fetched fresh (TastyTrade -> Yahoo)
    // instead of read from a GOOGLEFINANCE formula cell; GOOGLEFINANCE's
    // ~15-20min delay proved too stale for these two specifically. See
    // tickerData.changeInfo (fetchChangeDataForTicker_ inside
    // getCachedTickerData_). StockPrice is UNCHANGED — still your own
    // formula, not touched here.
    if (tickerData.changeInfo && tickerData.changeInfo.changePercent != null && !isNaN(tickerData.changeInfo.changePercent)) {
      changeNowNumeric = tickerData.changeInfo.changePercent;
      merged.changeNow = changeNowNumeric;
      sourceByField.changeNow = tickerData.changeInfo.source;
      changeNowCount++;
    }
    if (tickerData.changeInfo && tickerData.changeInfo.changeAbsolute != null && !isNaN(tickerData.changeInfo.changeAbsolute)) {
      merged.changeValue = tickerData.changeInfo.changeAbsolute;
      sourceByField.changeValue = tickerData.changeInfo.source;
    }

    // SECTOR MOMENTUM (classification slow-cached, % change fresh every run)
    if (tickerData.sectorMomentum && tickerData.sectorMomentum.sector) {
      const sectorName = tickerData.sectorMomentum.sector;
      const etfSuffix = SECTOR_ETF_MAP[sectorName] ? ' (' + SECTOR_ETF_MAP[sectorName] + ')' : '';

      if (tickerData.sectorMomentum.changePercent != null) {
        sectorMomentumNumeric = tickerData.sectorMomentum.changePercent;
        merged.sectorMomentumText = sectorName + etfSuffix + ' ' + (sectorMomentumNumeric >= 0 ? '+' : '') + round2_(sectorMomentumNumeric) + '%';
        sectorMomentumCount++;
      } else {
        merged.sectorMomentumText = sectorName + etfSuffix + ' — N/A';
      }
      sourceByField.sectorMomentum = 'FMP/Yahoo';
    } else if (fmpApiKey) {
      merged.sectorMomentumText = 'Other — N/A';
    }

    // THEME / CLUSTER (slow-cached)
    if (tickerData.themeCluster && (tickerData.themeCluster.industry || tickerData.themeCluster.sector)) {
      merged.themeClusterText = tickerData.themeCluster.industry ? tickerData.themeCluster.industry : tickerData.themeCluster.sector;
      sourceByField.themeCluster = 'cached classification';
      themeClusterCount++;
    }

    const upsidePercent = (merged.analystTarget != null && merged.stockPrice != null && merged.stockPrice !== 0)
      ? ((merged.analystTarget - merged.stockPrice) / merged.stockPrice) * 100
      : null;

    // OBJECTIVE-SHEET TARGET — see the "PER-SHEET OBJECTIVE" section above
    // computeFilterScore_ for the full writeup. Computed here (rather
    // than deferred to the write section below) because the Risk/Filter
    // formulas for these sheets also need daysHeld.
    let daysHeld = null;
    let isActivePosition = false;
    let quickTargetResult = null;
    let entryPriceNum = null;

    if (hasObjectiveConfig && map.entryPrice) {
      const entryPriceRaw = rowValues[map.entryPrice - 1];
      entryPriceNum = parseFloat(entryPriceRaw);
      isActivePosition = isPlausible_(entryPriceNum, 0.01, null);

      if (isActivePosition && map.entryDate) {
        const entryDateVal = parseEntryDateCell_(rowValues[map.entryDate - 1]);
        if (entryDateVal && !isNaN(entryDateVal.getTime())) {
          daysHeld = Math.round((runTimestamp.getTime() - entryDateVal.getTime()) / (24 * 60 * 60 * 1000));
        }
      }

      if (isActivePosition) {
        quickTargetResult = computeTargetForObjective_(
          entryPriceNum, daysHeld, merged.stockPrice, merged.optionPrice, merged.greekDelta, parsedStrike.type, objectiveConfig
        );
      }
    }

    // No Entry Price (or no Entry Price column at all) — still show a
    // HYPOTHETICAL Target so candidate rows aren't blank, using the
    // CURRENT option price as a stand-in "entry" (i.e., what the target
    // would be if you opened this position right now). daysHeld stays
    // null, so this always lands in the "profit" phase (min-profit
    // target) — there's no hold history to judge a later phase from.
    // Distinguished from a real position's Target by NOT being
    // highlighted yellow — see the write section below.
    if (hasObjectiveConfig && !isActivePosition) {
      quickTargetResult = computeTargetForObjective_(
        merged.optionPrice, null, merged.stockPrice, merged.optionPrice, merged.greekDelta, parsedStrike.type, objectiveConfig
      );
    }

    // Time-based cutoff — Quick/Risky only (Leap's maxHoldDays is
    // Infinity, so this never fires there; Leap uses lossThresholdWarning
    // below instead, since it's a %-based exit, not a day-count one).
    const maxHoldWarning = (isActivePosition && daysHeld != null && objectiveConfig && isFinite(objectiveConfig.maxHoldDays) &&
        daysHeld >= objectiveConfig.maxHoldDays)
      ? ('Held ' + daysHeld + ' days (>= ' + objectiveConfig.maxHoldDays + ') — objective says close now regardless of price.')
      : null;

    // %-based cutoff — mainly for Leap (out at -10%, held however long it
    // takes otherwise, so there's no day-count trigger to hang a warning
    // on) but written generically off objectiveConfig.lossConcernPercent
    // in case another sheet ever wants the same style of warning.
    const lossThresholdWarning = (isActivePosition && objectiveConfig && objectiveConfig.lossConcernPercent != null &&
        isPlausible_(entryPriceNum, 0.01, null) && isPlausible_(merged.optionPrice, 0.01, null) &&
        merged.optionPrice <= entryPriceNum * (1 - objectiveConfig.lossConcernPercent / 100))
      ? ('Down ' + objectiveConfig.lossConcernPercent + '%+ from your Entry Price — objective says close now regardless of target.')
      : null;

    // TARGET SCORE (Quick/Risky/Leap) — a probability (0-100%), computed
    // BEFORE Risk/Quick below since Risky's Quick formula uses this as an
    // input. Anchored on quickTargetResult's target stock price above
    // (itself already anchored on Entry Price if active, else current
    // Price — same branching as before, just feeding a probability calc
    // now instead of only a display price).
    let targetScoreValue = null;
    if (revisedFormulaSheetName && quickTargetResult != null) {
      const targetInputs = {
        stockPrice: merged.stockPrice, targetStockPrice: quickTargetResult.targetStockPrice,
        iv: merged.iv, daysToExpiry: daysToExpiry, optionType: parsedStrike.type,
        momentumPercent: merged.momentumPercent, rsPercent: merged.relativeStrength,
        sectorPercent: sectorMomentumNumeric, trendPercent: merged.trendPercent,
        relativeVolumePercent: merged.relativeVolumePercent, marketRegimePercent: merged.marketRegimePercent,
        daysToCatalyst: daysToCatalystNumeric,
        hitRateCallPercent: merged.hitRateCallPercent, hitRatePutPercent: merged.hitRatePutPercent
      };
      targetScoreValue = revisedFormulaSheetName === 'Quick'
        ? computeQuickSheetTargetScore_(targetInputs, objectiveConfig)
        : revisedFormulaSheetName === 'Risky'
        ? computeRiskySheetTargetScore_(targetInputs, objectiveConfig)
        : computeLeapSheetTargetScore_(targetInputs, objectiveConfig);
    }

    // RISK — needs Delta, Stock Price, Option Price, ATR%, spread, and
    // catalyst timing (or, for Risky, Drawdown/liquidity fields instead)
    // — all already computed above, so this is free. All three revised-
    // formula sheets (Quick/Risky/Leap) now compute this the same way.
    if (scoreRelevance.needsRiskScore) {
      const riskScoreValue = revisedFormulaSheetName === 'Quick'
        ? computeQuickSheetRiskScore_({
            atrPercent: merged.atrPercent, delta: merged.greekDelta,
            stockPrice: merged.stockPrice, optionPrice: merged.optionPrice, ivRank: merged.ivRank
          })
        : revisedFormulaSheetName === 'Risky'
        ? computeRiskySheetRiskScore_({
            maxDrawdownPercent: merged.maxDrawdownPercent, bidAskSpreadPct: merged.bidAskSpreadPct,
            extrinsicValue: merged.extrinsicValue, optionPrice: merged.optionPrice,
            oi: merged.oi, volume: merged.volume
          })
        : revisedFormulaSheetName === 'Leap'
        ? computeLeapSheetRiskScore_({
            atrPercent: merged.atrPercent, delta: merged.greekDelta,
            stockPrice: merged.stockPrice, optionPrice: merged.optionPrice,
            bidAskSpreadPct: merged.bidAskSpreadPct, daysToCatalyst: daysToCatalystNumeric
          })
        : hasObjectiveConfig
        ? computeRiskScoreForObjective_({
            atrPercent: merged.atrPercent,
            delta: merged.greekDelta,
            stockPrice: merged.stockPrice,
            optionPrice: merged.optionPrice,
            bidAskSpreadPct: merged.bidAskSpreadPct,
            daysToCatalyst: daysToCatalystNumeric,
            daysHeld: daysHeld
          }, objectiveConfig)
        : computeRiskScore_({
            optionType: parsedStrike.type,
            atrPercent: merged.atrPercent,
            delta: merged.greekDelta,
            stockPrice: merged.stockPrice,
            optionPrice: merged.optionPrice,
            bidAskSpreadPct: merged.bidAskSpreadPct,
            daysToCatalyst: daysToCatalystNumeric
          });

      if (riskScoreValue != null && !isNaN(riskScoreValue)) {
        merged.riskScore = riskScoreValue;
        sourceByField.riskScore = revisedFormulaSheetName ? ('Computed (' + sheet.getName() + ' revised formula)')
          : hasObjectiveConfig ? ('Computed (' + sheet.getName() + ' objective)') : 'Computed';
      }
    }

    // FILTER — combines Risk (inverted) with sheet-specific factors. All
    // three revised-formula sheets now compute this the same way.
    if (scoreRelevance.needsFilterScore) {
      const filterScoreValue = revisedFormulaSheetName === 'Quick'
        ? computeQuickSheetQuickScore_({
            rsPercent: merged.relativeStrength, optionType: parsedStrike.type, atrPercent: merged.atrPercent,
            delta: merged.greekDelta, stockPrice: merged.stockPrice, optionPrice: merged.optionPrice,
            riskScoreValue: merged.riskScore, sectorPercent: sectorMomentumNumeric, ivRank: merged.ivRank
          }, objectiveConfig)
        : revisedFormulaSheetName === 'Risky'
        ? computeRiskySheetQuickScore_({
            rsPercent: merged.relativeStrength, optionType: parsedStrike.type, atrPercent: merged.atrPercent,
            delta: merged.greekDelta, stockPrice: merged.stockPrice, optionPrice: merged.optionPrice,
            targetScoreValue: targetScoreValue, sectorPercent: sectorMomentumNumeric, ivRank: merged.ivRank
          }, objectiveConfig)
        : revisedFormulaSheetName === 'Leap'
        ? computeLeapSheetFilterScore_({
            ratingScore: tickerData.qualityInfo ? tickerData.qualityInfo.ratingScore : null,
            upsidePercent: upsidePercent, optionType: parsedStrike.type,
            delta: merged.greekDelta, stockPrice: merged.stockPrice, optionPrice: merged.optionPrice,
            openInterest: merged.oi, volume: merged.volume, momentumPercent: merged.momentumPercent
          })
        : hasObjectiveConfig
        ? computeFilterScoreForObjective_({
            riskScore: merged.riskScore,
            relativeStrengthPercent: merged.relativeStrength,
            optionType: parsedStrike.type,
            delta: merged.greekDelta,
            atrPercent: merged.atrPercent,
            stockPrice: merged.stockPrice,
            optionPrice: merged.optionPrice
          }, objectiveConfig)
        : computeFilterScore_({
            optionType: parsedStrike.type,
            riskScore: merged.riskScore,
            relativeStrengthPercent: merged.relativeStrength,
            delta: merged.greekDelta,
            atrPercent: merged.atrPercent,
            stockPrice: merged.stockPrice,
            optionPrice: merged.optionPrice
          });

      if (filterScoreValue != null && !isNaN(filterScoreValue)) {
        merged.filterScore = filterScoreValue;
        sourceByField.filterScore = revisedFormulaSheetName ? ('Computed (' + sheet.getName() + ' revised formula)')
          : hasObjectiveConfig ? ('Computed (' + sheet.getName() + ' objective)') : 'Computed';
      }
    }

    // Counts whether the OPTION QUOTE itself (price + IV) came from
    // TastyTrade — not whether stock price also did, since stock price
    // is intentionally sourced from your GOOGLEFINANCE formula first (see
    // the STOCK PRICE section above) and essentially never comes from
    // TastyTrade in normal, healthy operation. The old version of this
    // check required stockPrice === 'TastyTrade' too, which meant this
    // counter was structurally broken — it could show 0 even when every
    // single option quote succeeded perfectly, simply because
    // GOOGLEFINANCE was working as designed.
    if (tastyOptionQuote && sourceByField.optionPrice === 'TastyTrade' &&
        sourceByField.iv === 'TastyTrade (contract IV)') {
      okCount++;
    } else {
      fallbackCount++;
    }

    const newValues = {
      optionPrice: (merged.optionPrice != null && !isNaN(merged.optionPrice)) ? round2_(merged.optionPrice) : null,
      volume: (merged.volume != null && !isNaN(merged.volume)) ? Math.round(merged.volume) : null,
      ivRank: (merged.ivRank != null && !isNaN(merged.ivRank)) ? Math.round(merged.ivRank * 100) / 10000 : null,
      atrPercent: (merged.atrPercent != null && !isNaN(merged.atrPercent)) ? Math.round(merged.atrPercent * 100) / 10000 : null,
      oi: merged.oi != null ? merged.oi : null,
      greekDelta: (merged.greekDelta != null && !isNaN(merged.greekDelta))
        ? Math.round(Math.abs(merged.greekDelta) <= 1 ? merged.greekDelta * 100 : merged.greekDelta) : null,
      gamma: (merged.gamma != null && !isNaN(merged.gamma)) ? Math.round(merged.gamma * 10000) / 10000 : null,
      bidAskSpread: (merged.bidAskSpreadPct != null && !isNaN(merged.bidAskSpreadPct)) ? Math.round(merged.bidAskSpreadPct * 100) / 10000 : null,
      extrinsicValue: (merged.extrinsicValue != null && !isNaN(merged.extrinsicValue)) ? round2_(merged.extrinsicValue) : null,
      analystTarget: (merged.analystTarget != null && !isNaN(merged.analystTarget)) ? round2_(merged.analystTarget) : null,
      daysToExpiry: (merged.daysToExpiry != null && !isNaN(merged.daysToExpiry)) ? merged.daysToExpiry : null,
      daysToCatalyst: (merged.daysToCatalyst === 'N/A')
        ? 'N/A'
        : ((merged.daysToCatalyst != null && !isNaN(merged.daysToCatalyst)) ? merged.daysToCatalyst : null),
      changeNow: (merged.changeNow != null && !isNaN(merged.changeNow))
        ? ((merged.changeNow >= 0 ? '+' : '') + round2_(merged.changeNow) + '%') : null,
      changeValue: (merged.changeValue != null && !isNaN(merged.changeValue)) ? round2_(merged.changeValue) : null,
      relativeStrength: (merged.relativeStrength != null && !isNaN(merged.relativeStrength))
        ? ((merged.relativeStrength >= 0 ? '+' : '') + round2_(merged.relativeStrength) + '%') : null,
      sectorMomentum: merged.sectorMomentumText != null ? merged.sectorMomentumText : null,
      riskScore: (merged.riskScore != null && !isNaN(merged.riskScore)) ? merged.riskScore : null,
      filterScore: (merged.filterScore != null && !isNaN(merged.filterScore)) ? merged.filterScore : null,
      themeCluster: merged.themeClusterText != null ? merged.themeClusterText : null
    };

    const rowChanges = [];
    const sourcesUsed = new Set();

    Object.keys(TRACKED_FIELDS).forEach(function (key) {
      const col = map[key];
      const newVal = newValues[key];
      if (!col || newVal === null) return;

      const oldVal = rowOut[col - 1];

      if (valuesDiffer_(oldVal, newVal)) {
        rowOut[col - 1] = newVal;
        if (key === 'ivRank' || key === 'bidAskSpread' || key === 'atrPercent') fmtOut[col - 1] = '0.00%';
        // Plain-number guard for the 0-100 score columns — if the cell
        // ever inherited a stray percentage format from somewhere else
        // (e.g. a copy-paste, or column formatting set before this
        // column held real data), a legitimate value like 72.8 would
        // otherwise DISPLAY as "7280.00%" even though the stored number
        // is correct. This forces plain display regardless of history.
        if (key === 'riskScore' || key === 'filterScore') fmtOut[col - 1] = '0.0';

        const label = TRACKED_FIELDS[key];
        const src = sourceByField[key] || 'unknown';
        sourcesUsed.add(src);
        rowChanges.push(label + ' ' + formatForNote_(oldVal) + '→' + formatForNote_(newVal));
        changedCells++;
      }
    });

    // TARGET — for any sheet in TRADE_OBJECTIVE_SHEETS. Active positions
    // (non-blank Entry Price) get a real target based on what you paid,
    // highlighted YELLOW so it stands out as a real position; candidate
    // rows (no Entry Price) get a hypothetical target based on entering
    // at the current option price, with no highlight. Computed fresh
    // every run from the current Delta/Stock/Option Price — it's a
    // moving guide, not a price fixed once at entry. Cleared (not just
    // left alone) when nothing could be computed this run, same
    // reasoning as Risk L's clear-on-exit handling above.
    if (map.target) {
      const targetCol = map.target - 1;

      if (revisedFormulaSheetName && targetScoreValue != null && quickTargetResult != null) {
        // Quick/Risky: Target is now a PROBABILITY (%), not a stock price —
        // see the "QUICK & RISKY — REVISED FORMULAS" section. The
        // underlying target stock price is still computed (it anchors the
        // Volatility Probability factor) and shown in the note, just not
        // written to the cell.
        const roundedTarget = Math.round(targetScoreValue * 10) / 10;
        const oldTarget = rowOut[targetCol];
        if (valuesDiffer_(oldTarget, roundedTarget)) {
          rowOut[targetCol] = roundedTarget;
          rowChanges.push('Target ' + formatForNote_(oldTarget) + '→' + formatForNote_(roundedTarget) + '%');
          changedCells++;
        }
        bgOut[targetCol] = higherIsBetterBandColor_(roundedTarget);
        targetBorderRows.push({ row: row, on: isActivePosition });
        noteOut[targetCol] =
          'Probability (' + sheet.getName() + ' revised formula) of reaching the ' +
          (isActivePosition
            ? (quickTargetResult.phase === 'profit'
                ? ('minimum-profit exit (+' + objectiveConfig.minProfitPercent + '% on premium vs. your Entry Price)')
                : ('breakeven / minimal-loss exit (held ' + (daysHeld != null ? daysHeld : '?') +
                    ' day(s), past the ' + objectiveConfig.phaseShiftDays + '-day shift)'))
            : ('hypothetical minimum-profit target (+' + objectiveConfig.minProfitPercent +
                '% from the CURRENT option price — not an active position)')) +
          ' — implied stock target ≈ $' + round2_(quickTargetResult.targetStockPrice) + '.' +
          (sheet.getName() === 'Risky'
            ? ' Includes a Historical Hit Rate component that is a short (~2mo) window heuristic, not a statistically robust hit rate.'
            : '') +
          ' Recomputed each run — a moving estimate, not a guarantee.';
      } else if (hasObjectiveConfig && quickTargetResult != null) {
        const roundedTarget = round2_(quickTargetResult.targetStockPrice);
        const oldTarget = rowOut[targetCol];
        if (valuesDiffer_(oldTarget, roundedTarget)) {
          rowOut[targetCol] = roundedTarget;
          rowChanges.push('Target ' + formatForNote_(oldTarget) + '→' + formatForNote_(roundedTarget));
          changedCells++;
        }
        bgOut[targetCol] = isActivePosition ? COLOR_TARGET_ACTIVE_HIGHLIGHT : null;
        noteOut[targetCol] =
          (isActivePosition
            ? (quickTargetResult.phase === 'profit'
                ? ('Phase: minimum-profit exit (+' + objectiveConfig.minProfitPercent + '% on premium vs. your Entry Price).')
                : ('Phase: breakeven / minimal-loss exit (held ' + (daysHeld != null ? daysHeld : '?') +
                    ' day(s), past the ' + objectiveConfig.phaseShiftDays + '-day shift).'))
            : ('Hypothetical — no Entry Price yet. Based on entering at the CURRENT option price ' +
                '(+' + objectiveConfig.minProfitPercent + '% minimum-profit target). Not an active position.')) +
          ' Recomputed each run from current Delta/ATR — a moving guide, not a fixed order price.';
      } else {
        const existingTarget = rowOut[targetCol];
        if (existingTarget !== '' && existingTarget != null) {
          rowOut[targetCol] = '';
          noteOut[targetCol] = '';
          bgOut[targetCol] = null;
          targetBorderRows.push({ row: row, on: false });
          rowChanges.push('Target cleared (missing Delta/Stock/Option Price this run, or not an objective sheet)');
          changedCells++;
        }
      }
    }

    // SCORE — Quick/Risky/Leap only, weighted blend of Filter, Target
    // Probability, and (100 - Risk) via computeCombinedScore_/
    // SCORE_WEIGHTS_BY_SHEET above. Cleared if any input is missing this
    // run, or on any other sheet — same convention Target uses. Requires
    // a header cell literally named "Score" on this sheet (see HEADER_MAP).
    if (map.score) {
      const scoreCol = map.score - 1;
      const scoreValue = revisedFormulaSheetName
        ? computeCombinedScore_(revisedFormulaSheetName, merged.filterScore, targetScoreValue, merged.riskScore)
        : null;

      if (scoreValue != null) {
        const oldScore = rowOut[scoreCol];
        if (valuesDiffer_(oldScore, scoreValue)) {
          rowOut[scoreCol] = scoreValue;
          fmtOut[scoreCol] = '0.0';
          rowChanges.push('Score ' + formatForNote_(oldScore) + '→' + formatForNote_(scoreValue));
          changedCells++;
        }
        bgOut[scoreCol] = higherIsBetterBandColor_(scoreValue);
        const w = SCORE_WEIGHTS_BY_SHEET[revisedFormulaSheetName];
        noteOut[scoreCol] =
          Math.round(w.filter * 100) + '% Filter + ' + Math.round(w.targetProb * 100) +
          '% Target Probability + ' + Math.round(w.risk * 100) + '% (100 - Risk). Recomputed each run.';
      } else {
        const existingScore = rowOut[scoreCol];
        if (existingScore !== '' && existingScore != null) {
          rowOut[scoreCol] = '';
          noteOut[scoreCol] = '';
          bgOut[scoreCol] = null;
          rowChanges.push('Score cleared (missing Filter/Target Probability/Risk this run, or not a Quick/Risky/Leap sheet)');
          changedCells++;
        }
      }
    }

    if (rowChanges.length > 0) changedRows++;

    // CHANGE NOW / %age CELL COLOR — restored now that this column is
    // script-owned again (was removed when it briefly became a
    // GOOGLEFINANCE-only read cell). Font color only, on that one cell —
    // no row paint, no background fill.
    if (map.changeNow && changeNowNumeric != null) {
      fontOut[map.changeNow - 1] = changeNowNumeric >= 0 ? COLOR_FONT_POSITIVE : COLOR_FONT_NEGATIVE;
    }

    // VALUE CELL COLOR — same sign-based treatment, since it's the
    // dollar-amount companion to %age (same sign, same direction).
    if (map.changeValue && merged.changeValue != null && !isNaN(merged.changeValue)) {
      fontOut[map.changeValue - 1] = merged.changeValue >= 0 ? COLOR_FONT_POSITIVE : COLOR_FONT_NEGATIVE;
    }

    // SECTOR MOMENTUM CELL FONT COLOR
    if (map.sectorMomentum && sectorMomentumNumeric != null) {
      fontOut[map.sectorMomentum - 1] = sectorMomentumNumeric >= 0 ? COLOR_FONT_POSITIVE : COLOR_FONT_NEGATIVE;
    }

    // RS vs SPY is intentionally NOT sign-colored — plain black like every
    // other non-exempt column, per FONT_COLOR_EXEMPT_KEYS above (only
    // Score/Filter/Risk/Target/Sector Momentum/%age/Value keep colored
    // font/background treatment).

    // RISK CELL BACKGROUND — low/moderate/high band, same idea as the
    // Days to Catalyst proximity flag below.
    if (map.riskScore && merged.riskScore != null) {
      const riskColor = merged.riskScore <= 33 ? COLOR_RISK_LOW : (merged.riskScore <= 66 ? COLOR_RISK_MED : COLOR_RISK_HIGH);
      bgOut[map.riskScore - 1] = riskColor;
    }

    // FILTER CELL BACKGROUND — high score (good setup) = green, same
    // color language as Risk but inverted thresholds since higher is
    // better here, not worse.
    if (map.filterScore && merged.filterScore != null) {
      bgOut[map.filterScore - 1] = higherIsBetterBandColor_(merged.filterScore);
    }

    // DAYS TO CATALYST — flag when the event falls inside the swing
    // window. Guarded on map.daysToCatalyst so deleting this column just
    // turns the highlight off, same as every other optional column.
    if (map.daysToCatalyst && daysToCatalystNumeric != null && daysToCatalystNumeric >= 0 && daysToCatalystNumeric <= SWING_WINDOW_DAYS) {
      bgOut[map.daysToCatalyst - 1] = '#f9cb9c';
    }

    const sourceLabel = sourcesUsed.size > 0 ? Array.from(sourcesUsed).join(' + ') : (tastyOptionQuote ? 'TastyTrade' : 'Yahoo Finance');
    const baseStatusText = rowChanges.length > 0
      ? ('OK — ' + sourceLabel + ' | Changed: ' + rowChanges.join(', '))
      : ('OK — ' + sourceLabel + ' | No changes');
    const warnings = [oiStaleWarning, expiredWarning, maxHoldWarning, lossThresholdWarning].filter(function (w) { return w != null; });
    const statusText = warnings.length ? (baseStatusText + ' | ⚠️ ' + warnings.join(' ⚠️ ')) : baseStatusText;

    writeStatusBuffered_(rowIdx, statusText, warnings.length ? '#f4cccc' : (rowChanges.length > 0 ? '#fff2cc' : '#d9ead3'));

    // This delay exists to protect TastyTrade/Yahoo from rapid-fire
    // individual calls — it has nothing to protect when this row made
    // NEITHER call itself: TastyTrade came from the batch prefetch above
    // (tastyFromPrefetch) and Yahoo was skipped entirely (yahooQuote is
    // null exactly when it wasn't called — see the lazy-fetch logic
    // above). Paying this delay on every row regardless, even ones the
    // Cloud Function already answered in bulk, is exactly the pattern
    // that made Validate & Update still feel row-by-row despite the
    // prefetch actually working.
    if (!tastyFromPrefetch || yahooQuote) {
      Utilities.sleep(REQUEST_DELAY_MS);
    }
  }

  // Flush every buffered write back to the sheet now, in one bulk call
  // per property, BEFORE the sort/highlight logic below runs — that
  // logic reads the sheet's current state directly, so it has to see
  // this run's results, not what was there before the loop started.
  // Target's conditional border is applied here too (not after the
  // sort), matching exactly where the original per-row code applied it —
  // Range.sort() doesn't carry borders with a row the way it does
  // values/backgrounds/fonts, so the border has to land before the sort,
  // same as it always did.
  if (numDataRows > 0) {
    const dataRange = sheet.getRange(DATA_START_ROW, 1, numDataRows, lastCol);
    dataRange.setValues(allValues);
    dataRange.setBackgrounds(allBackgrounds);
    dataRange.setFontColors(allFontColors);
    dataRange.setNotes(allNotes);
    dataRange.setNumberFormats(allNumberFormats);
  }
  if (map.target) {
    targetBorderRows.forEach(function (b) {
      sheet.getRange(b.row, map.target).setBorder(
        b.on, b.on, b.on, b.on, false, false,
        COLOR_TARGET_ACTIVE_HIGHLIGHT, SpreadsheetApp.BorderStyle.SOLID_THICK
      );
    });
  }

  // Reorders every row by the ranking key (Score on Quick/Risky/Leap once
  // that column exists, Filter Score otherwise), descending — done BEFORE
  // the highlights below, not after: Range.sort() carries values/
  // backgrounds/fonts with a row, but NOT borders (a Sheets quirk —
  // borders behave as an edge property, not a per-cell one), so
  // highlighting has to target the FINAL sorted positions or it ends up
  // on the wrong rows.
  const sortKey = (revisedFormulaSheetName && map.score) ? 'score' : 'filterScore';
  sortRowsByQuickScoreDescending_(sheet, map, lastRow, sortKey);

  // Now that rows are in final position, flag the top 5 by the same
  // ranking key (see COLOR_TOP_FILTER_BORDER). No special highlight for
  // the single best row anymore — findBestScoreRow_ only informs the
  // summary text below, per request that the top row look like any
  // other. Reads directly from the sheet's current state rather than
  // positions captured mid-loop, for the same reason.
  const rankKey = (revisedFormulaSheetForHighlight && map.score) ? 'score' : 'filterScore';
  const rankLabel = rankKey === 'score' ? 'Score' : 'Filter Score';
  const topFilterRanked = applyTopFilterHighlight_(sheet, map, lastRow, rankKey, rankLabel);
  const bestCombination = revisedFormulaSheetForHighlight ? findBestScoreRow_(sheet, map, lastRow) : null;

  // Persist all slow-cache updates from this run in ONE batched write.
  const slowWritesFlushed = flushSlowCacheWrites_(pendingSlowWrites);

  const summary =
    (timeBudgetExceeded
      ? ('⏱️ Stopped early to stay under Google\'s execution time limit — reached row ' + lastRowProcessed + ' of ' +
          lastRow + '. Run Validate & Update again to continue with the rest (already-processed tickers will be ' +
          'much faster this time — most of their data is already cached).\n\n')
      : '') +
    'Validation complete.\n\n' +
    'Rows checked: ' + (okCount + fallbackCount + failCount) + '\n' +
    '  TastyTrade: ' + okCount + '\n' +
    '  Yahoo/fallback: ' + fallbackCount + '\n' +
    '  Not found: ' + failCount + '\n\n' +
    'Changes made: ' + changedCells + ' cell(s) across ' + changedRows + ' row(s).\n\n' +
    (bestCombination
      ? ('Best row by Score: row ' + bestCombination.row + ' (Score ' + bestCombination.combinedScore + '/100).\n\n')
      : '') +
    'Analyst targets updated: ' + analystTargetCount + '\n' +
    '%age / Value (Change %/$) updated: ' + changeNowCount + '\n' +
    'Sector Momentum updated: ' + sectorMomentumCount + '\n' +
    'Theme / Cluster updated: ' + themeClusterCount + '\n' +
    'Top ' + rankLabel + ' rows flagged (border): ' + topFilterRanked.length + '\n' +
    'Rows sorted by ' + rankLabel + ', high to low.\n' +
    'Google Finance helper rows added this run: ' + addedGfRows + ' (existing rows reused, no cost)\n\n' +
    'Slow-changing data cache (this run, per UNIQUE ticker):\n' +
    '  Analyst Target — fetched fresh: ' + slowStats.analystFresh + ', reused cached: ' + slowStats.analystCached + '\n' +
    '  Theme/Cluster  — resolved locally (override/static, no network): ' + slowStats.themeLocal +
      ', fetched fresh: ' + slowStats.themeFresh + ', reused cached: ' + slowStats.themeCached + '\n' +
    '  Quality rating — fetched fresh: ' + slowStats.qualityFresh + ', reused cached: ' + slowStats.qualityCached + '\n' +
    '  Catalyst       — fetched fresh: ' + slowStats.catalystFresh + ', reused cached: ' + slowStats.catalystCached + '\n' +
    '  ATR daily bars — fetched fresh: ' + slowStats.atrFresh + ', reused cached: ' + slowStats.atrCached + '\n' +
    '  (' + slowWritesFlushed + ' cache value(s) written this run. Refresh windows: Analyst 7d, Theme 30d, Quality 14d, Catalyst 3d or on passed date, ATR bars 1d.)\n\n' +
    (isQuotaHitToday_('FMP')
      ? '⚠️ FMP daily quota appears exhausted — reused earlier data where available. Resets tomorrow, or "Clear Today\'s API Quota Cache".\n\n'
      : '') +
    (isQuotaHitToday_('ALPHA_VANTAGE')
      ? '⚠️ Alpha Vantage daily quota appears exhausted — skipped for the rest of this run.\n\n'
      : '');

  notify_(ui, 'Validation complete (' + sheet.getName() + ')', summary);

  // Lets DailyPipeline.gs know whether to re-run this sheet (stopped
  // early) or move on — safe, additive: nothing before this used the
  // return value at all.
  return { timeBudgetExceeded: timeBudgetExceeded };
}


/* ============================================================================
 * CACHED TICKER DATA (per unique ticker, per run) — pulls in the SLOW cache
 * for Analyst Target, Theme/Cluster, Quality, and Catalyst.
 * ========================================================================== */

function getCachedTickerData_(
  ticker, accessToken, finnhubApiKey, fmpApiKey, alphaVantageApiKey,
  getSectorPerfMap, sectorEtfCache, cache, slowCache, pendingSlowWrites, slowStats, sectorOverrides, getSpyBars, gfDataMap
) {
  if (cache[ticker]) return cache[ticker];

  // Change % (%age) and Change $ (Value) — re-added after GOOGLEFINANCE
  // proved too stale (~15-20min delay) for these two specifically.
  // TastyTrade first, Yahoo as the one fallback — no FMP, kept lean since
  // the whole point is efficiency. Current Stock Price is UNCHANGED —
  // still read from your own GOOGLEFINANCE formula cell in the main
  // loop, not this fetch, even though the TastyTrade quote below also
  // happens to include a price (deliberately unused, to avoid clobbering
  // your formula cell with a plain value).
  const changeInfo = fetchChangeDataForTicker_(ticker, accessToken);
  Utilities.sleep(150);

  const metrics = accessToken ? fetchTastyMarketMetrics_(ticker, accessToken) : null;
  Utilities.sleep(150);

  // ---------------------------------------------------------------
  // ANALYST TARGET — slow-cached (7 days). No network call at all
  // unless the cache is missing/stale.
  // ---------------------------------------------------------------
  const analystResult = getSlowCached_(slowCache, pendingSlowWrites, 'ANALYST', ticker, SLOW_REFRESH_DAYS.ANALYST, function () {
    let a = fetchYahooAnalystTarget_(ticker);
    Utilities.sleep(150);
    if (!a && alphaVantageApiKey) a = fetchAlphaVantageAnalystTarget_(ticker, alphaVantageApiKey);
    return a;
  });
  const analyst = analystResult.value;
  if (analystResult.isFreshFetch) slowStats.analystFresh++; else slowStats.analystCached++;

  // ---------------------------------------------------------------
  // CATALYST — slow-cached (3 days, or forced sooner once the cached
  // date has passed). Dates round-trip through JSON as 'yyyy-MM-dd'
  // strings, reconstructed into Date objects below.
  // ---------------------------------------------------------------
  const catalystResult = getSlowCached_(slowCache, pendingSlowWrites, 'CATALYST', ticker, SLOW_REFRESH_DAYS.CATALYST, function () {
    let c = finnhubApiKey ? fetchFinnhubNextEarnings_(ticker, finnhubApiKey) : null;
    Utilities.sleep(150);
    if (!c) c = fetchYahooNextEarnings_(ticker);
    if (!c) return null;
    return {
      catalyst: c.catalyst,
      date: c.date ? Utilities.formatDate(c.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null,
      source: c.source
    };
  }, isCatalystPast_);

  const catalystRaw = catalystResult.value;
  const catalyst = catalystRaw
    ? { catalyst: catalystRaw.catalyst, date: catalystRaw.date ? new Date(catalystRaw.date + 'T12:00:00') : null, source: catalystRaw.source }
    : null;
  if (catalystResult.isFreshFetch) slowStats.catalystFresh++; else slowStats.catalystCached++;

  // ---------------------------------------------------------------
  // THEME / CLUSTER classification — checked in this order:
  //   1. User-taught override (sectorOverrides) — no expiry, no network,
  //      always wins.
  //   2. Built-in STATIC_SECTOR_MAP for common large caps — zero network
  //      cost, zero cap risk.
  //   3. Yahoo assetProfile (free, uncapped, but has gotten unreliable).
  //   4. Finnhub /stock/profile2 (free, 60/min — not a small daily cap;
  //      you already have this key for Catalyst).
  //   5. FMP /profile (small daily cap — last resort).
  // Only 3-5 go through the 30-day slow cache; 1 and 2 are already free
  // every time, so there's nothing to cache.
  // ---------------------------------------------------------------
  let themeRaw = sectorOverrides[ticker] || STATIC_SECTOR_MAP[ticker] || null;

  if (themeRaw) {
    slowStats.themeLocal++;
  } else {
    const themeResult = getSlowCached_(slowCache, pendingSlowWrites, 'THEME', ticker, SLOW_REFRESH_DAYS.THEME, function () {
      const yp = fetchYahooAssetProfile_(ticker);
      Utilities.sleep(100);
      if (yp && (yp.sector || yp.industry)) {
        return { sector: yp.sector, industry: yp.industry, source: 'Yahoo Finance (unofficial)' };
      }
      if (finnhubApiKey) {
        const fh = fetchFinnhubProfile_(ticker, finnhubApiKey);
        if (fh && fh.industry) {
          return { sector: FINNHUB_INDUSTRY_TO_SECTOR[fh.industry] || null, industry: fh.industry, source: 'Finnhub' };
        }
      }
      if (fmpApiKey) {
        const fp = fetchFmpProfile_(ticker, fmpApiKey);
        if (fp && (fp.sector || fp.industry)) return { sector: fp.sector, industry: fp.industry, source: 'FMP' };
      }
      return null;
    });
    themeRaw = themeResult.value;
    if (themeResult.isFreshFetch) slowStats.themeFresh++; else slowStats.themeCached++;
  }

  // Sector's daily % move is NOT cached across runs — it's fetched fresh
  // every time via its SPDR ETF (cheap, uncapped, one Yahoo call per
  // sector per run thanks to sectorEtfCache), using the cached sector
  // NAME above to know which ETF to check.
  let sectorMomentum = null;
  let themeCluster = null;

  if (themeRaw && themeRaw.sector) {
    const sectorEtfResult = getSectorEtfChangeCached_(themeRaw.sector, sectorEtfCache, gfDataMap);
    let sectorPerf = sectorEtfResult ? sectorEtfResult.pct : null;
    let sectorPerfSource = sectorEtfResult ? sectorEtfResult.source : null;

    if (sectorPerf == null && fmpApiKey) {
      const fmpPerfMap = getSectorPerfMap();
      const fmpPerf = fmpPerfMap && fmpPerfMap[themeRaw.sector] != null ? fmpPerfMap[themeRaw.sector] : null;
      if (fmpPerf != null) { sectorPerf = fmpPerf; sectorPerfSource = 'FMP'; }
    }

    sectorMomentum = { sector: themeRaw.sector, changePercent: sectorPerf, source: sectorPerfSource || themeRaw.source };
  }

  if (themeRaw && (themeRaw.industry || themeRaw.sector)) {
    themeCluster = { industry: themeRaw.industry, sector: themeRaw.sector, source: themeRaw.source };
  }

  // ---------------------------------------------------------------
  // QUALITY / "MOAT" PROXY — reuses analyst.recommendationMean for
  // free whenever the (possibly cached) analyst object has it. Only
  // the FMP /rating fallback is itself slow-cached (14 days), since
  // that's the only path that costs a network/quota hit.
  // ---------------------------------------------------------------
  let qualityInfo = null;
  if (analyst && analyst.recommendationMean != null && !isNaN(analyst.recommendationMean)) {
    const inverted = 6 - analyst.recommendationMean;
    qualityInfo = { ratingScore: clamp_(inverted, 1, 5), source: 'Yahoo (analyst recommendation, inverted)' };
  } else {
    const qualityResult = getSlowCached_(slowCache, pendingSlowWrites, 'QUALITY', ticker, SLOW_REFRESH_DAYS.QUALITY, function () {
      if (!fmpApiKey) return null;
      const r = fetchFmpRating_(ticker, fmpApiKey);
      return (r && r.ratingScore != null) ? { ratingScore: r.ratingScore, source: 'FMP' } : null;
    });
    qualityInfo = qualityResult.value;
    if (qualityResult.isFreshFetch) slowStats.qualityFresh++; else slowStats.qualityCached++;
  }

  // ---------------------------------------------------------------
  // ATR% — daily OHLC bars are slow-cached (1 day: see SLOW_REFRESH_DAYS
  // .DAILYBARS), but the ATR itself is recomputed from those bars on
  // every run regardless of whether the fetch was fresh or cached — that
  // computation is free (in-memory, no network), so there's no reason to
  // cache the derived number separately from the raw bars it comes from.
  // ---------------------------------------------------------------
  const barsResult = getSlowCached_(slowCache, pendingSlowWrites, 'DAILYBARS', ticker, SLOW_REFRESH_DAYS.DAILYBARS, function () {
    return fetchYahooDailyBars_(ticker);
  });
  if (barsResult.isFreshFetch) slowStats.atrFresh++; else slowStats.atrCached++;

  const atrPercentValue = computeATRPercent_(barsResult.value);
  const atrInfo = atrPercentValue != null ? { atrPercent: atrPercentValue, source: 'Yahoo Finance (unofficial, 14d ATR)' } : null;

  // ---------------------------------------------------------------
  // RELATIVE STRENGTH vs SPY — reuses this ticker's own bars above plus
  // SPY's (fetched at most once per run/day via getSpyBars). Zero extra
  // network cost beyond the one shared SPY fetch.
  // ---------------------------------------------------------------
  const spyBars = getSpyBars ? getSpyBars() : null;
  const relativeStrengthPercent = computeRelativeStrengthPercent_(barsResult.value, spyBars, RS_LOOKBACK_DAYS);
  const rsInfo = relativeStrengthPercent != null
    ? { relativeStrengthPercent: relativeStrengthPercent, source: 'Yahoo Finance (unofficial, ' + RS_LOOKBACK_DAYS + 'd vs SPY)' }
    : null;

  // ---------------------------------------------------------------
  // QUICK/RISKY REVISED-FORMULA FIELDS — Momentum, Trend, Volume,
  // Drawdown Exposure, and the Historical Hit Rate heuristic. All reuse
  // barsResult.value from the ATR%/RS fetch above — zero extra network
  // calls. Historical Hit Rate needs a direction (optionType), which
  // isn't known at the ticker level (a ticker can appear with a Call on
  // one row and a Put on another) — so this stores BOTH directions,
  // computed once, and the per-row code below picks the one it needs.
  // ---------------------------------------------------------------
  const momentumPercentValue = computeMomentumPercent_(barsResult.value, MOMENTUM_LOOKBACK_DAYS);
  const momentumInfo = momentumPercentValue != null
    ? { momentumPercent: momentumPercentValue, source: 'Yahoo Finance (unofficial, ' + MOMENTUM_LOOKBACK_DAYS + 'd own return)' }
    : null;

  const trendPercentValue = computeTrendPercent_(barsResult.value, TREND_MA_PERIOD);
  const trendInfo = trendPercentValue != null
    ? { trendPercent: trendPercentValue, source: 'Yahoo Finance (unofficial, vs ' + TREND_MA_PERIOD + 'd MA)' }
    : null;

  const relativeVolumePercentValue = computeRelativeVolumePercent_(barsResult.value, VOLUME_AVG_PERIOD);
  const volumeTrendInfo = relativeVolumePercentValue != null
    ? { relativeVolumePercent: relativeVolumePercentValue, source: 'Yahoo Finance (unofficial, vs ' + VOLUME_AVG_PERIOD + 'd avg volume)' }
    : null;

  const maxDrawdownPercentValue = computeMaxDrawdownPercent_(barsResult.value);
  const drawdownInfo = maxDrawdownPercentValue != null
    ? { maxDrawdownPercent: maxDrawdownPercentValue, source: 'Yahoo Finance (unofficial, ~2mo max drawdown)' }
    : null;

  const hitRateCallPercent = computeHistoricalHitRateHeuristic_(barsResult.value, atrPercentValue, 'C', HIT_RATE_FORWARD_DAYS);
  const hitRatePutPercent = computeHistoricalHitRateHeuristic_(barsResult.value, atrPercentValue, 'P', HIT_RATE_FORWARD_DAYS);
  const hitRateInfo = (hitRateCallPercent != null || hitRatePutPercent != null)
    ? {
        callPercent: hitRateCallPercent, putPercent: hitRatePutPercent,
        source: 'Yahoo Finance (unofficial, ~2mo short-window heuristic — NOT a statistically robust hit rate)'
      }
    : null;

  Utilities.sleep(150);

  const data = {
    metrics: metrics, analyst: analyst, catalyst: catalyst, changeInfo: changeInfo,
    sectorMomentum: sectorMomentum, qualityInfo: qualityInfo, themeCluster: themeCluster,
    atrInfo: atrInfo, rsInfo: rsInfo,
    momentumInfo: momentumInfo, trendInfo: trendInfo, volumeTrendInfo: volumeTrendInfo,
    drawdownInfo: drawdownInfo, hitRateInfo: hitRateInfo
  };
  cache[ticker] = data;
  return data;
}


/* ============================================================================
 * CHANGE DETECTION / FORMATTING HELPERS
 * ========================================================================== */

function valuesDiffer_(oldVal, newVal) {
  if (oldVal instanceof Date && newVal instanceof Date) {
    return Math.abs(oldVal.getTime() - newVal.getTime()) > 12 * 60 * 60 * 1000;
  }
  if (typeof newVal === 'number' && typeof oldVal === 'number') {
    return Math.abs(oldVal - newVal) > 0.005;
  }
  return normalizeForCompare_(oldVal) !== normalizeForCompare_(newVal);
}

function normalizeForCompare_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  return String(v == null ? '' : v).trim().toLowerCase();
}

function formatForNote_(v) {
  if (v === null || v === undefined || v === '') return '(blank)';
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'MMM d, yyyy');
  return String(v);
}


/* ============================================================================
 * FONT COLOR POLICY — every tracked column's font is forced to plain black
 * EXCEPT the ones named below, which keep whatever sign-based/banded color
 * they're given elsewhere (Score/Filter/Risk/Target via background bands,
 * %age/Value/Sector Momentum via per-row sign-based font color). This
 * replaces the old SIGN_BASED_FONT_COLUMNS mechanism, which colored
 * columns by hardcoded LETTER (R/S/T/Z) — fragile, since letters shift
 * whenever columns are added/reordered, and it doesn't line up with "which
 * columns should be colored" being a header-name decision. Keyed off the
 * same getColumnMap_ every other column already uses, so it stays correct
 * regardless of layout changes.
 *
 * RS vs SPY is deliberately NOT in this exempt list — its own per-row sign-
 * based coloring has been removed (see the RS FONT COLOR section further
 * down), so it now gets the same plain black as everything else.
 * ========================================================================== */

const FONT_COLOR_EXEMPT_KEYS = ['filterScore', 'riskScore', 'target', 'score', 'sectorMomentum', 'changeNow', 'changeValue'];

// Forces every tracked column's font to black, EXCEPT the exempt list
// above — applied once per run, before any row-level coloring below, as a
// clean slate. Whole-column range operations, not per-cell, so this stays
// cheap regardless of row count.
function resetNeutralColumnFontColor_(sheet, map, lastRow) {
  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return;
  Object.keys(map).forEach(function (key) {
    if (FONT_COLOR_EXEMPT_KEYS.indexOf(key) !== -1) return;
    const col = map[key];
    if (!col) return;
    sheet.getRange(DATA_START_ROW, col, numRows, 1).setFontColor('black');
  });
}

// One-time cleanup: strips out the OLD sign-based conditional-format rules
// this project used to maintain (colored by hardcoded column letter). A
// native Sheets conditional-format rule visually overrides a cell's own
// static font color, so leaving these in place would keep fighting
// resetNeutralColumnFontColor_ above even after the mechanism that created
// them is gone. This removes ANY numeric less-than/greater-than
// conditional-format rule on the sheet — safe here since this script is
// what created them, but worth knowing if you've since added your own
// manual rule of that same shape.
function removeLegacySignBasedFontRules_(sheet) {
  const existingRules = sheet.getConditionalFormatRules();
  const filtered = existingRules.filter(function (rule) {
    const cond = rule.getBooleanCondition();
    if (!cond) return true;
    const criteria = cond.getCriteriaType();
    return criteria !== SpreadsheetApp.BooleanCriteria.NUMBER_LESS_THAN &&
      criteria !== SpreadsheetApp.BooleanCriteria.NUMBER_GREATER_THAN;
  });
  if (filtered.length !== existingRules.length) {
    sheet.setConditionalFormatRules(filtered);
  }
}


/* ============================================================================
 * STANDOUT COLUMN HIGHLIGHTS — StockPrice, Price, and PtN get a fixed,
 * distinct background so they visually stand out from the rest of the
 * row, independent of their value (not a band/signal like Risk or
 * Filter — just a constant "look here" highlight). Same treatment the
 * Hedge tab's Spot/Rec Strike columns already get.
 * ========================================================================== */

const COLOR_STOCKPRICE_HIGHLIGHT = '#cfe2f3'; // light blue
const COLOR_PRICE_HIGHLIGHT = '#fce5cd';      // light orange
const COLOR_PTN_HIGHLIGHT = '#d9d2e9';        // light purple

function applyStandoutColumnHighlights_(sheet, map, lastRow) {
  const numRows = lastRow - DATA_START_ROW + 1;
  if (numRows <= 0) return;
  if (map.stockPrice) sheet.getRange(DATA_START_ROW, map.stockPrice, numRows, 1).setBackground(COLOR_STOCKPRICE_HIGHLIGHT);
  if (map.optionPrice) sheet.getRange(DATA_START_ROW, map.optionPrice, numRows, 1).setBackground(COLOR_PRICE_HIGHLIGHT);
  if (map.ptN) sheet.getRange(DATA_START_ROW, map.ptN, numRows, 1).setBackground(COLOR_PTN_HIGHLIGHT);
}



/* ============================================================================
 * STATUS
 * ========================================================================== */

function writeStatus_(sheet, map, row, text, color, runTimestamp) {
  if (map.status) {
    const cell = sheet.getRange(row, map.status);
    cell.setValue(text);
    cell.setBackground(color);
  }
  if (map.timestamp) {
    // Uses the run's single start time (passed in), not a fresh
    // new Date() per row — every row updated in the same run shows the
    // exact same LastRun value, matching "give me last run time only"
    // rather than each row's own slightly-different completion moment.
    sheet.getRange(row, map.timestamp).setValue(runTimestamp);
  }
}


/* ============================================================================
 * ROUND
 * ========================================================================== */

function round2_(n) { return Math.round(n * 100) / 100; }