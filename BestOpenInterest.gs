/**
 * ============================================================================
 * OPTIONS CHAIN SCANNER — by Delta threshold + top-2 Open Interest per expiry
 * ============================================================================
 *
 * THIS VERSION'S CHANGE: PER-SHEET INPUT VIA "Input" TAB
 * ----------------------------------------------------------------------------
 * Instead of reading Type/Delta/MinExpiry/MaxExpiry/MinStrike from row 2 of
 * the active sheet, this version reads TICKER from the active sheet (row 2,
 * col B, same as before) but pulls the rest of the config from a dedicated
 * "Input" sheet, using a labeled block that matches the active sheet's name.
 *
 * Expected "Input" sheet layout (col A = label, col B = value):
 *
 *   Quick
 *   Type        C
 *   Delta       0.7
 *   MinExpiry   180
 *   MaxExpiry   60
 *   MinStrike   70.00
 *
 *   Leap
 *   Type        C
 *   Delta       0.7
 *   MinExpiry   365
 *   MaxExpiry   60
 *   MinStrike   70.00
 *
 *   Risky
 *   Type        C
 *   Delta       0.7
 *   MinExpiry   365
 *   MaxExpiry   60
 *   MinStrike   70.00
 *
 * The block header in column A must exactly match the sheet name you're
 * running the scan from (case-insensitive) — e.g. running the menu item
 * while on the "Leap" tab reads the "Leap" block. Labels are matched
 * case/space-insensitively (MinExpiry, Min Expiry, minexpiry all work).
 * A blank row or an unrecognized label ends the block.
 *
 * MaxExpiry may be left blank — it's only used when Type = P anyway.
 * Type, Delta, MinExpiry, and MinStrike are required.
 *
 * NOTHING ELSE ABOUT THE SCAN LOGIC HAS CHANGED — same Yahoo fetch, same
 * Black-Scholes delta filter, same strike floor/ceiling and expiry window
 * behavior, same output columns, same highlight/trailing-formula logic.
 * See the field-by-field meaning of Type/Delta/MinExpiry/MaxExpiry/MinStrike
 * below (carried over from the row-2-seed version):
 *
 *   Type      = "C" or "P" — option type.
 *   Delta     = Delta threshold (numeric).
 *   MinExpiry = Min expiry window, in DAYS from today (e.g. 120). Applies
 *               to both Calls and Puts.
 *   MinStrike = Strike floor/ceiling, as a percentage. Direction depends
 *               on Type:
 *                 Type = C (call): FLOOR — candidate strikes must be >=
 *                      underlyingPrice * (MinStrike / 100).
 *                 Type = P (put):  CEILING instead — candidate strikes
 *                      must be <= underlyingPrice * (1 + MinStrike / 100).
 *               Leave blank/0 for no strike bound.
 *   MaxExpiry = Max expiry window, in DAYS from today. ONLY used when
 *               Type = P — an upper bound on top of MinExpiry's existing
 *               lower bound. Ignored entirely for calls. Leave blank for
 *               no ceiling.
 *
 * OUTPUT (unchanged from before):
 *
 *   A Rank
 *   B Ticker
 *   C Expiry
 *   D Strike
 *   E Delta
 *   F Current IV
 *   G Current Stock Price
 *   H Price
 *   I Bid
 *   J Ask
 *   K Diff (Ask - Bid), computed directly by the script
 *   L Volume
 *   M Open Interest
 *
 * N onward (Net Price, Extra from current price, # of days, Next Catalyst,
 * Date, etc.) are NOT written by this scanner — they're your own formulas.
 * N:P specifically (Net Price, Extra from current price, # of days) DO get
 * auto-extended: if a scan produces more rows than the last one, whatever
 * formula sits in the lowest row of N:P gets copied down (relative
 * references adjusting automatically) to cover the new rows, so they're
 * never left blank just because a scan grew. See reconcileTrailingFormulas_
 * below. Q and beyond are never touched at all.
 *
 * S:U are explicitly cleared on every scan and never written to again —
 * this used to hold a "Scan Date" column; that's been removed per request.
 *
 * IMPORTANT:
 * The old "J2:L2 master formula" mechanism has been removed. K is a plain
 * computed value (Ask - Bid) for every row, not a copied formula.
 *
 * ----------------------------------------------------------------------------
 * NAMING NOTE (added when merging with the Momentum Validator project):
 * This file's menu entry point and two of its private helpers were renamed
 * to avoid colliding with same-named functions in Momentum.gs:
 *   scanChainByDelta   -> runDeepDiveScan     (menu function)
 *   blackScholesDelta_ -> blackScholesDeltaDeepDive_
 *   round2_            -> round2DeepDive_
 * The OLD blackScholesDelta_ collision was the dangerous one — Momentum.gs's
 * version takes (stockPrice, strike, daysToExpiry, ivPercent, optionType),
 * this file's takes (S, K, T, r, q, sigma, optionType); whichever one lost
 * the silent override would have fed the wrong arguments into the wrong
 * formula with no error. round2_ was a harmless duplicate (identical logic
 * in both files) but renamed anyway for future-proofing. Everything else in
 * this file was already uniquely named and is untouched.
 * ----------------------------------------------------------------------------
 *
 * MOBILE REMOTE COMPATIBILITY (added alongside MobileRemote.gs):
 * runDeepDiveScan() now takes an optional tickerOverride parameter and no
 * longer calls SpreadsheetApp.getUi() directly — both were required for
 * this to run from a web app request (no interactive UI at all, and no
 * way to know a phone's typed ticker except as a real parameter). See:
 *   - SCAN_CONFIG.SHEET_NAME is now pinned to 'DeepDive' instead of null
 *     (null meant "whatever sheet is currently active," which is not a
 *     safe assumption when triggered from a phone with no guarantee about
 *     which tab was last open on desktop).
 *   - tryGetUi_() / notify_() (both defined in Momentum.gs, shared across
 *     this whole Apps Script project) replace the direct getUi()/alert()
 *     calls, so every failure path degrades to the Log tab instead of
 *     throwing when there's no interactive session.
 *   - applyDeepDiveSeedDefaults_() fills in any blank Type/Delta/MinExpiry/
 *     MaxExpiry/MinStrike cells with sensible defaults (and writes them
 *     back into C2:G2) so a mobile run with just a typed ticker still has
 *     a complete, visible configuration afterward — a value you've
 *     actually set yourself is always left alone.
 * ============================================================================
 */


var INPUT_SHEET_NAME = 'Input';


var SCAN_CONFIG = {
  SHEET_NAME: 'DeepDive',  // pinned explicitly — see MOBILE REMOTE COMPATIBILITY note above
  SEED_ROW: 2,
  FIRST_OUTPUT_ROW: 3,


  COL: {
    RANK: 1,               // A
    TICKER: 2,             // B
    EXPIRY: 3,             // C
    STRIKE: 4,             // D
    DELTA: 5,              // E
    IV: 6,                 // F
    STOCK_PRICE: 7,        // G
    PRICE: 8,              // H
    BID: 9,                // I
    ASK: 10,               // J
    DIFF: 11,              // K
    VOLUME: 12,            // L
    OI: 13                 // M
  },


  LAST_RAW_COL: 13,        // M — everything A:M is written in one pass

  // Seed-row (row 2) config columns — DIFFERENT meaning from the output
  // columns above (COL.EXPIRY/STRIKE/DELTA/etc. describe the scan RESULTS
  // starting at FIRST_OUTPUT_ROW). Row 2 reuses columns C:G as a settings
  // row instead: Type, Delta threshold, MinExpiry, MaxExpiry, MinStrike —
  // read directly off this sheet now instead of the "Input" sheet.
  SEED_COL: {
    TYPE: 3,          // C
    DELTA: 4,         // D
    MIN_EXPIRY: 5,    // E
    MAX_EXPIRY: 6,    // F
    MIN_STRIKE: 7     // G
  },


  CLEAR_EXTRA_FIRST_COL: 19, // S
  CLEAR_EXTRA_LAST_COL: 21,  // U


  // N:P (Net Price, Extra from current price, # of days) hold YOUR
  // formulas, not scanner output — but when a scan produces more rows
  // than the last one, those formulas need to be dragged down to cover
  // the new rows too. This auto-extends them: whatever formula is in the
  // lowest row that has one gets copied (with relative references
  // adjusted) down to the new last output row. It only ever extends
  // further, never shrinks/removes formulas from rows a shorter scan no
  // longer needs.
  TRAILING_FORMULA_FIRST_COL: 14, // N
  TRAILING_FORMULA_LAST_COL: 16,  // P


  RISK_FREE_RATE: 0.045,
  TOP_N_PER_EXPIRY: 2,

  // How many rows get background-highlighted after each scan, ranked by
  // highest Open Interest first and lowest Ask-Bid slippage as the
  // tiebreaker. No font color is used for this — see
  // highlightLeastSlippageRows_ below.
  LEAST_SLIPPAGE_HIGHLIGHT_COUNT: 3
};

// Background used for the best-rows highlight — a plain cell fill, not a
// font color, and not a native Sheets conditional-format rule, so it's
// fully under this script's control and gets reset every run.
var LEAST_SLIPPAGE_HIGHLIGHT_COLOR = '#fff2cc';

// Defaults applied to any BLANK seed-row cell (C2:G2) at run time — a
// value you've actually typed in yourself is always left alone. Pulled
// from this file's own long-documented example config. MaxExpiry is only
// ever applied when the resolved Type turns out to be 'P' (it's meaningless
// for calls, same as the rest of this file already treats it). See
// applyDeepDiveSeedDefaults_ below.
var DEEPDIVE_SEED_DEFAULTS = {
  type: 'C',
  delta: 0.7,
  minExpiry: 180,
  maxExpiry: 60,
  minStrike: 70
};




/**
 * ============================================================================
 * INPUT TAB LOOKUP
 * ============================================================================
 *
 * Finds the block in the "Input" sheet whose subheading (col A) matches
 * the active sheet's name, then reads the labeled rows below it (col A =
 * label, col B = value) until it hits a blank row or an unrecognized
 * label. Returns { type, delta, minExpiry, maxExpiry, minStrike }.
 * ============================================================================
 */
function getInputConfigForSheet_(activeSheetName) {


  var ss =
    SpreadsheetApp.getActiveSpreadsheet();


  var inputSheet =
    ss.getSheetByName(INPUT_SHEET_NAME);


  if (!inputSheet) {
    throw new Error(
      'No sheet named "' + INPUT_SHEET_NAME + '" was found.'
    );
  }


  var lastRow =
    inputSheet.getLastRow();


  var data =
    inputSheet
      .getRange(1, 1, lastRow, 2)
      .getValues();


  var blockStartRow = -1;


  for (var i = 0; i < data.length; i++) {


    var label =
      String(data[i][0]).trim().toLowerCase();


    if (label === activeSheetName.trim().toLowerCase()) {
      blockStartRow = i;
      break;
    }
  }


  if (blockStartRow === -1) {
    throw new Error(
      'No "' + activeSheetName + '" section found in "' +
      INPUT_SHEET_NAME +
      '" — column A needs a row that says exactly "' +
      activeSheetName + '".'
    );
  }


  var fieldMap = {
    'type': 'type',
    'delta': 'delta',
    'minexpiry': 'minExpiry',
    'maxexpiry': 'maxExpiry',
    'minstrike': 'minStrike'
  };


  var config = {};


  for (var r = blockStartRow + 1; r < data.length; r++) {


    var rawLabel =
      String(data[r][0]).trim();


    if (rawLabel === '') {
      break; // spacer row before next block
    }


    var key =
      fieldMap[rawLabel.toLowerCase().replace(/\s+/g, '')];


    if (!key) {
      break; // hit the next subheading
    }


    config[key] = data[r][1];
  }


  var required =
    ['type', 'delta', 'minExpiry', 'minStrike'];


  var missing =
    required.filter(function(k) {
      return config[k] === undefined || config[k] === '';
    });


  if (missing.length) {
    throw new Error(
      'The "' + activeSheetName + '" section in "' +
      INPUT_SHEET_NAME + '" is missing: ' + missing.join(', ')
    );
  }


  return config; // { type, delta, minExpiry, maxExpiry, minStrike }
}


/**
 * ============================================================================
 * SEED DEFAULTS (C2:G2) — fills in any BLANK Type/Delta/MinExpiry/
 * MaxExpiry/MinStrike cell with a sensible default, and writes it back so
 * it's visible and individually editable afterward. A cell that already
 * has a value (whether you set it deliberately or a previous run wrote
 * one) is never touched. MaxExpiry only gets defaulted once Type is known
 * to be 'P' — see DEEPDIVE_SEED_DEFAULTS above.
 * ============================================================================
 */
function applyDeepDiveSeedDefaults_(sheet, seedRow) {

  var typeCell = sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.TYPE);
  var deltaCell = sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.DELTA);
  var minExpiryCell = sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.MIN_EXPIRY);
  var maxExpiryCell = sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.MAX_EXPIRY);
  var minStrikeCell = sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.MIN_STRIKE);

  if (String(typeCell.getValue()).trim() === '') {
    typeCell.setValue(DEEPDIVE_SEED_DEFAULTS.type);
  }
  if (String(deltaCell.getValue()).trim() === '') {
    deltaCell.setValue(DEEPDIVE_SEED_DEFAULTS.delta);
  }
  if (String(minExpiryCell.getValue()).trim() === '') {
    minExpiryCell.setValue(DEEPDIVE_SEED_DEFAULTS.minExpiry);
  }
  if (String(minStrikeCell.getValue()).trim() === '') {
    minStrikeCell.setValue(DEEPDIVE_SEED_DEFAULTS.minStrike);
  }

  // MaxExpiry is meaningless for calls (same rule the rest of this file
  // already follows), so it's only defaulted once we know Type resolved
  // to 'P' — checked AFTER the Type default above may have just filled it.
  var resolvedType = parseOptionTypeLabel_(String(typeCell.getValue()));
  if (resolvedType === 'P' && String(maxExpiryCell.getValue()).trim() === '') {
    maxExpiryCell.setValue(DEEPDIVE_SEED_DEFAULTS.maxExpiry);
  }
}




/**
 * ============================================================================
 * MENU ENTRY POINT
 * ============================================================================
 * tickerOverride (optional): when provided (e.g. typed into the Mobile
 * Remote's DeepDive form), this is used instead of reading cell B2, and is
 * also written INTO B2 so the sheet reflects exactly what was scanned —
 * matching how the seed defaults get written back too. Leave it out (or
 * pass a blank string) to keep the existing desktop behavior of reading
 * whatever's already in B2.
 */
/**
 * ============================================================================
 * MENU ENTRY POINT
 * ============================================================================
 * tickerOverride (optional): when provided (e.g. typed into the Mobile
 * Remote's DeepDive form), this is used instead of reading cell B2, and is
 * also written INTO B2 so the sheet reflects exactly what was scanned —
 * matching how the seed defaults get written back too. Leave it out (or
 * pass a blank string) to keep the existing desktop behavior of reading
 * whatever's already in B2.
 */
/**
 * ============================================================================
 * DEBUG: RAW CHAIN FOR ONE EXPIRATION
 * ----------------------------------------------------------------------------
 * Shows Yahoo's RAW, unprocessed contract data for the first 5 calls of a
 * given ticker/expiration — bid, ask, impliedVolatility, openInterest,
 * volume, straight from the API response, before any of this project's
 * own filtering, Black-Scholes delta calculation, or formatting touches
 * it. Built to diagnose exactly why Delta/IV/Bid/Ask can come back
 * uniformly broken (e.g. Delta pinned at 1.00 for every strike) while
 * Open Interest stays correct — that pattern points at IV coming back as
 * zero/missing from Yahoo for that contract, which breaks the Black-
 * Scholes division; this tool lets you confirm that directly instead of
 * guessing from the sheet's processed output.
 * ============================================================================
 */
function debugFetchRawChainForExpiry() {
  const ui = SpreadsheetApp.getUi();
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SCAN_CONFIG.SHEET_NAME);
  const defaultTicker = sheet ? String(sheet.getRange(SCAN_CONFIG.SEED_ROW, SCAN_CONFIG.COL.TICKER).getValue()).trim().toUpperCase() : '';

  const tickerResp = ui.prompt('Debug: Raw Chain',
    'Ticker (blank = use DeepDive!B2, currently "' + defaultTicker + '"):', ui.ButtonSet.OK_CANCEL);
  if (tickerResp.getSelectedButton() !== ui.Button.OK) return;
  const ticker = (tickerResp.getResponseText().trim().toUpperCase() || defaultTicker);
  if (!ticker) { ui.alert('No ticker provided.'); return; }

  const expiryResp = ui.prompt('Debug: Raw Chain',
    'Expiration date for ' + ticker + ' (mm/dd/yyyy \u2014 doesn\'t need to be exact, ' +
    'picks the closest real listed date):', ui.ButtonSet.OK_CANCEL);
  if (expiryResp.getSelectedButton() !== ui.Button.OK) return;
  const expiryDate = new Date(expiryResp.getResponseText().trim());
  if (isNaN(expiryDate.getTime())) { ui.alert('Could not parse that date.'); return; }

  let session;
  try {
    session = getYahooSession_();
  } catch (e) {
    ui.alert('Could not establish a Yahoo session.\n\n' + e.message);
    return;
  }

  let chainRoot;
  try {
    chainRoot = fetchYahooOptionsRoot_(ticker, null, session);
  } catch (e) {
    ui.alert('Could not fetch the root chain for ' + ticker + '.\n\n' + e.message);
    return;
  }

  const allExpirations = chainRoot.expirationDates || [];
  if (!allExpirations.length) {
    ui.alert('No expirations found at all for ' + ticker + ' \u2014 it may have no listed options.');
    return;
  }

  const targetEpoch = Math.floor(expiryDate.getTime() / 1000);
  let bestMatch = allExpirations[0];
  let bestDiff = Math.abs(allExpirations[0] - targetEpoch);
  allExpirations.forEach(function (e) {
    const diff = Math.abs(e - targetEpoch);
    if (diff < bestDiff) { bestDiff = diff; bestMatch = e; }
  });

  let chainForDate;
  try {
    chainForDate = fetchYahooOptionsRoot_(ticker, bestMatch, session);
  } catch (e) {
    ui.alert('Could not fetch the chain for that expiration.\n\n' + e.message);
    return;
  }

  const calls = (chainForDate.calls || []).slice(0, 5);
  const underlyingPrice = chainForDate.quote && chainForDate.quote.regularMarketPrice;

  let output = 'Ticker: ' + ticker + '\n' +
    'Matched expiration: ' + new Date(bestMatch * 1000).toDateString() + ' (closest listed date to what you typed)\n' +
    'Underlying price: ' + underlyingPrice + '\n\n' +
    (calls.length ? 'First ' + calls.length + ' CALL contracts (raw, unprocessed):\n\n' : 'No call contracts returned for this expiration at all.\n');

  calls.forEach(function (c) {
    output += 'Strike $' + c.strike + ':\n' +
      '  bid: ' + c.bid + '  ask: ' + c.ask + '  lastPrice: ' + c.lastPrice + '\n' +
      '  impliedVolatility: ' + c.impliedVolatility + '\n' +
      '  openInterest: ' + c.openInterest + '  volume: ' + c.volume + '\n' +
      '  inTheMoney: ' + c.inTheMoney + '\n\n';
  });

  ui.alert('Debug: Raw Chain \u2014 ' + ticker, output, ui.ButtonSet.OK);
  logToSheet_('Debug Raw Chain (' + ticker + ', ' + new Date(bestMatch * 1000).toDateString() + '):\n' + output);
}


function runDeepDiveScan(tickerOverride) {

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var sheet = SCAN_CONFIG.SHEET_NAME
    ? ss.getSheetByName(SCAN_CONFIG.SHEET_NAME)
    : ss.getActiveSheet();

  var ui = tryGetUi_();

  var seedRow = SCAN_CONFIG.SEED_ROW;

  var tickerCell = sheet.getRange(seedRow, SCAN_CONFIG.COL.TICKER);

  var ticker = (tickerOverride ? String(tickerOverride) : String(tickerCell.getValue()))
    .trim().toUpperCase();

  if (tickerOverride && ticker) {
    tickerCell.setValue(ticker);
  }

  // --------------------------------------------------------------------------
  // Validate ticker
  // --------------------------------------------------------------------------

  if (!ticker) {
    notify_(ui, 'Deep Dive Scan',
      'Row ' + seedRow +
      ' needs a Ticker in column B (or pass one in from the Mobile Remote).'
    );
    return;
  }

  // --------------------------------------------------------------------------
  // Fill in any blank settings (Type/Delta/MinExpiry/MaxExpiry/MinStrike)
  // with sensible defaults before reading them — see
  // applyDeepDiveSeedDefaults_ above. A value you've already set yourself
  // is always left alone.
  // --------------------------------------------------------------------------

  applyDeepDiveSeedDefaults_(sheet, seedRow);

  // --------------------------------------------------------------------------
  // Pull the rest of the config from THIS SHEET's own seed row (row 2,
  // columns C:G) instead of the "Input" sheet — Type/Delta/MinExpiry/
  // MaxExpiry/MinStrike, same 5 settings as before, just read locally now.
  // --------------------------------------------------------------------------

  var sheetName = sheet.getName();

  var inputConfig = {
    type: sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.TYPE).getValue(),
    delta: sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.DELTA).getValue(),
    minExpiry: sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.MIN_EXPIRY).getValue(),
    maxExpiry: sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.MAX_EXPIRY).getValue(),
    minStrike: sheet.getRange(seedRow, SCAN_CONFIG.SEED_COL.MIN_STRIKE).getValue()
  };

  var optionTypeRaw = String(inputConfig.type).trim();
  var deltaThreshold = Number(inputConfig.delta);

  if (!deltaThreshold || isNaN(deltaThreshold)) {
    notify_(ui, 'Deep Dive Scan',
      'Delta in row ' + seedRow + ' (column D) of "' + sheetName +
      '" needs to be numeric.'
    );
    return;
  }

  var optionType = parseOptionTypeLabel_(optionTypeRaw);

  if (!optionType) {
    notify_(ui, 'Deep Dive Scan',
      'Type in row ' + seedRow + ' (column C) of "' + sheetName + '" is "' +
      optionTypeRaw + '" — enter just "C" or "P".'
    );
    return;
  }

  // --------------------------------------------------------------------------
  // Expiry window (MinExpiry = min days out, MaxExpiry = max days out,
  // puts only) and strike floor/ceiling (MinStrike) — see header comment
  // for full explanation.
  // --------------------------------------------------------------------------

  var minDaysRaw = inputConfig.minExpiry;
  var minDays = Number(minDaysRaw);

  if (minDaysRaw === '' || minDaysRaw === undefined || isNaN(minDays)) {
    notify_(ui, 'Deep Dive Scan',
      'MinExpiry in row ' + seedRow + ' (column E) of "' + sheetName +
      '" needs a number of days out (e.g. 120 = only expirations ' +
      'more than 120 days from today).'
    );
    return;
  }

  var strikePercentRaw = inputConfig.minStrike;
  var strikePercent = parseFloat(String(strikePercentRaw).replace('%', '').trim());

  var maxDaysRaw = inputConfig.maxExpiry;
  var maxDays = (optionType === 'P') ? Number(maxDaysRaw) : null;
  if (optionType === 'P' && (maxDaysRaw === '' || maxDaysRaw === undefined || isNaN(maxDays) || maxDays <= 0)) {
    maxDays = null; // no ceiling, same as leaving it blank
  }

  SpreadsheetApp.getActiveSpreadsheet().toast('Fetching ' + ticker + ' expirations…', 'Scanner', 5);

  // --------------------------------------------------------------------------
  // Core scan — shared with the pipeline's auto-fill stage (see
  // DailyPipeline.gs). Everything from here through building resultRows
  // used to live inline in this function; it's now in
  // scanOptionChainCandidates_ below so both callers use identical logic.
  // Nothing about what this menu action does changed — same fetch, same
  // filters, same output.
  // --------------------------------------------------------------------------

  var scan = scanOptionChainCandidates_(ticker, optionType, deltaThreshold, minDays, maxDays, strikePercent);

  if (scan.error) {
    notify_(ui, 'Deep Dive Scan', scan.error);
    return;
  }

  var underlyingPrice = scan.underlyingPrice;
  var scannedCount = scan.scannedCount;
  var skippedCount = scan.skippedCount;
  var futureExpirationsCount = scan.expirationsScanned;

  // --------------------------------------------------------------------------
  // IV formatting — sheet-specific (depends on THIS sheet's own IV column
  // number format), so it stays here rather than in the shared scan
  // function, which knows nothing about any particular sheet's formatting.
  // --------------------------------------------------------------------------

  var ivCellFormat = sheet.getRange(SCAN_CONFIG.FIRST_OUTPUT_ROW, SCAN_CONFIG.COL.IV).getNumberFormat();
  var ivColumnIsPercentFormatted = ivCellFormat.indexOf('%') !== -1;

  var boundsNote = '';
  if (!isNaN(strikePercent) && strikePercent > 0) {
    boundsNote += optionType === 'C'
      ? (' | Strike ≥ ' + strikePercent + '%')
      : (' | Strike ≤ +' + strikePercent + '%');
  }
  if (maxDays != null) {
    var maxExpiryDateForNote = new Date(Date.now() + maxDays * 24 * 3600 * 1000);
    boundsNote += ' | Expiry ≤ ' + maxExpiryDateForNote.toDateString();
  }

  if (scan.resultRows.length === 0) {
    notify_(ui, 'Deep Dive Scan',
      'Scanned ' + scannedCount + ' contracts across ' + futureExpirationsCount +
      ' expirations' + boundsNote + ' — none met the |Delta| >= ' + deltaThreshold + ' threshold.'
    );
    return;
  }

  // --------------------------------------------------------------------------
  // Convert scan.resultRows (candidate objects) into this sheet's exact
  // row-array format — unchanged from the original inline version.
  // --------------------------------------------------------------------------

  var resultRows = scan.resultRows.map(function (row) {
    return [
      0,                                            // Rank (filled in below)
      ticker,                                        // B
      new Date((row.expEpoch + 86400) * 1000),        // C — +1 day corrects tz offset
      formatStrikeLabel_(row.strike, optionType),      // D
      round2DeepDive_(row.delta),                       // E
      ivColumnIsPercentFormatted ? row.iv : (round2DeepDive_(row.iv * 100) + '%'), // F
      underlyingPrice,                                    // G
      round2DeepDive_(row.price),                          // H
      row.bid,                                              // I
      row.ask,                                               // J
      row.diff,                                               // K
      row.volume,                                              // L
      row.oi                                                    // M
    ];
  });

  // --------------------------------------------------------------------------
  // Rank
  // --------------------------------------------------------------------------

  resultRows.forEach(function(r, i) {
    r[0] = i + 1;
  });

  // --------------------------------------------------------------------------
  // Write
  // --------------------------------------------------------------------------

  writeResults_(sheet, resultRows);

  var completionMessage =
    'Wrote ' + resultRows.length + ' rows across ' + futureExpirationsCount +
    ' expirations (' + scannedCount + ' contracts scanned, ' + skippedCount +
    ' skipped)' + boundsNote + '.';

  // A toast is the nicer interactive experience (non-blocking), so it's
  // kept for that case — but the summary is ALSO always logged so a
  // headless run (Mobile Remote) has something to read back afterward,
  // since a toast alone is invisible outside an open, interactive session.
  SpreadsheetApp.getActiveSpreadsheet().toast(completionMessage, 'Scanner', 8);

  logToSheet_('Deep Dive Scan (' + ticker + '): ' + completionMessage);
}


/**
 * ============================================================================
 * CORE SCAN (shared) — everything from resolving the expiry window through
 * building ranked per-expiry candidates, with NO sheet reads or writes at
 * all. Used by runDeepDiveScan() above (behaviorally unchanged, just now
 * delegating to this) and by DailyPipeline.gs's auto-fill stage, which
 * calls this directly with each tab's own settings instead of reading
 * DeepDive's shared config row.
 *
 * Returns either:
 *   { error: 'message' }  — never throws; caller decides how to report it
 *   { underlyingPrice, resultRows, scannedCount, skippedCount,
 *     expirationsScanned, error: null }
 *     where resultRows is a flat array of candidate objects (already
 *     filtered to the top TOP_N_PER_EXPIRY by Open Interest, per
 *     expiration, exactly as before) — NOT yet converted to any
 *     particular sheet's row-array format:
 *       { strike, delta, iv (raw fraction), bid, ask, diff, volume, oi,
 *         price, expEpoch }
 * ============================================================================
 */
/**
 * ============================================================================
 * CLOUD FUNCTION CHAIN SCAN
 * ----------------------------------------------------------------------------
 * Tries the shared Cloud Function first (same one Options_Validator.gs and
 * ResearchEngine.gs already use — getCloudFunctionUrl_/
 * getCloudFunctionSharedSecret_ are defined in ResearchEngine.gs and
 * shared globally across this project) for concurrent expiration
 * fetching. Returns null (triggering the caller's existing sequential
 * fallback) only for genuine INFRASTRUCTURE problems — not configured,
 * unreachable, bad response. A genuine, legitimate scan outcome from the
 * Cloud Function (including "no expirations found" — a real answer, not
 * a failure) is returned as-is, in the exact same shape
 * scanOptionChainCandidates_ itself returns, so the caller can't tell
 * the difference.
 * ========================================================================== */
function scanOptionChainViaCloudFunction_(ticker, optionType, deltaThreshold, minDays, maxDays, strikePercent) {
  const cloudFunctionUrl = getCloudFunctionUrl_();
  const sharedSecret = getCloudFunctionSharedSecret_();
  if (!cloudFunctionUrl || !sharedSecret) return null;

  let resp;
  try {
    resp = UrlFetchApp.fetch(cloudFunctionUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({
        apiKey: sharedSecret,
        chainScan: { ticker: ticker, optionType: optionType, deltaThreshold: deltaThreshold, minDays: minDays, maxDays: maxDays, strikePercent: strikePercent }
      }),
      muteHttpExceptions: true
    });
  } catch (e) {
    logToSheet_('Cloud Function chain scan FAILED (network error) for ' + ticker + ' \u2014 falling back to sequential scan: ' + e);
    return null;
  }

  if (resp.getResponseCode() !== 200) {
    logToSheet_('Cloud Function chain scan FAILED (HTTP ' + resp.getResponseCode() + ') for ' + ticker + ' \u2014 falling back to sequential scan: ' +
      resp.getContentText().substring(0, 300));
    return null;
  }

  let json;
  try {
    json = JSON.parse(resp.getContentText());
  } catch (e) {
    logToSheet_('Cloud Function chain scan FAILED (unparseable response) for ' + ticker + ' \u2014 falling back to sequential scan: ' + e);
    return null;
  }

  if (json.chainScanError) {
    // A genuine, legitimate outcome (e.g. no expirations in the
    // requested window) — the real answer, not something to retry.
    logToSheet_('Cloud Function chain scan: ' + ticker + ' completed in ' + json.elapsedMs + 'ms \u2014 ' + json.chainScanError);
    return { error: json.chainScanError };
  }

  const result = json.chainScanResult;
  if (!result) {
    logToSheet_('Cloud Function chain scan FAILED (empty response) for ' + ticker + ' \u2014 falling back to sequential scan.');
    return null;
  }

  logToSheet_('Cloud Function chain scan: ' + ticker + ' \u2014 ' + result.expirationsScanned + ' expirations, ' +
    result.scannedCount + ' contracts scanned, ' + result.resultRows.length + ' candidates found, in ' + json.elapsedMs + 'ms.');

  return {
    underlyingPrice: result.underlyingPrice,
    resultRows: result.resultRows,
    scannedCount: result.scannedCount,
    skippedCount: result.skippedCount,
    expirationsScanned: result.expirationsScanned,
    error: null
  };
}

function scanOptionChainCandidates_(ticker, optionType, deltaThreshold, minDays, maxDays, strikePercent) {

  // Cloud Function attempt first — fetches every matching expiration
  // concurrently instead of the sequential forEach loop below, which is
  // what makes a scan with many listed expirations slow today. Fails
  // soft: not configured, unreachable, or errors out for any reason, and
  // this just falls through to the original sequential logic unchanged.
  var cloudResult = scanOptionChainViaCloudFunction_(ticker, optionType, deltaThreshold, minDays, maxDays, strikePercent);
  if (cloudResult) return cloudResult;

  var seedExpiry = new Date(Date.now() + minDays * 24 * 3600 * 1000);
  var hasStrikeBound = !isNaN(strikePercent) && strikePercent > 0;
  var maxExpiryDate = (optionType === 'P' && maxDays != null) ? new Date(Date.now() + maxDays * 24 * 3600 * 1000) : null;

  var session;
  try {
    session = getYahooSession_();
  } catch (e) {
    return { error: 'Could not establish a Yahoo Finance session.\n\n' + e.message };
  }

  var chainRoot;
  try {
    chainRoot = fetchYahooOptionsRoot_(ticker, null, session);
  } catch (e) {
    return { error: 'Could not fetch data for ' + ticker + ' from Yahoo Finance.\n\n' + e.message };
  }

  var underlyingPrice = chainRoot.quote && chainRoot.quote.regularMarketPrice;
  if (!underlyingPrice) {
    return { error: 'Yahoo returned no current price for ' + ticker + ' — aborting so nothing bad gets written.' };
  }

  var dividendYield = (chainRoot.quote && (chainRoot.quote.trailingAnnualDividendYield || chainRoot.quote.dividendYield)) || 0;

  var allExpirations = chainRoot.expirationDates || [];
  var seedEpoch = Math.floor(seedExpiry.getTime() / 1000);
  var maxExpiryEpoch = maxExpiryDate ? Math.floor(maxExpiryDate.getTime() / 1000) : null;

  var futureExpirations = allExpirations
    .filter(function (e) {
      if (e <= seedEpoch) return false;
      if (maxExpiryEpoch != null && e > maxExpiryEpoch) return false;
      return true;
    })
    .sort(function (a, b) { return a - b; });

  if (futureExpirations.length === 0) {
    return {
      error: 'No expirations found ' +
        (maxExpiryEpoch != null
          ? ('between ' + seedExpiry.toDateString() + ' and ' + maxExpiryDate.toDateString())
          : ('after ' + seedExpiry.toDateString())) +
        ' for ' + ticker + '.'
    };
  }

  var nowSeconds = Date.now() / 1000;
  var resultRows = [];
  var scannedCount = 0;
  var skippedCount = 0;

  futureExpirations.forEach(function (expEpoch) {
    var chainForDate;
    try {
      chainForDate = fetchYahooOptionsRoot_(ticker, expEpoch, session);
    } catch (e) {
      skippedCount++;
      return;
    }

    var contracts = optionType === 'C' ? chainForDate.calls : chainForDate.puts;
    if (!contracts || contracts.length === 0) return;

    var candidates = [];

    contracts.forEach(function (c) {
      scannedCount++;
      var iv = c.impliedVolatility;
      if (!iv || iv <= 0) { skippedCount++; return; }

      var T = (expEpoch - nowSeconds) / (365 * 24 * 3600);
      if (T <= 0) { skippedCount++; return; }

      if (hasStrikeBound) {
        if (optionType === 'C') {
          var minStrikeAllowed = underlyingPrice * (strikePercent / 100);
          if (c.strike < minStrikeAllowed) { skippedCount++; return; }
        } else {
          var maxStrikeAllowed = underlyingPrice * (1 + strikePercent / 100);
          if (c.strike > maxStrikeAllowed) { skippedCount++; return; }
        }
      }

      var delta = blackScholesDeltaDeepDive_(underlyingPrice, c.strike, T, SCAN_CONFIG.RISK_FREE_RATE, dividendYield, iv, optionType);

      if (Math.abs(delta) >= deltaThreshold) {
        var bid = (c.bid != null && !isNaN(c.bid)) ? c.bid : null;
        var ask = (c.ask != null && !isNaN(c.ask)) ? c.ask : null;
        var price = (bid != null && ask != null) ? (bid + ask) / 2 : (c.lastPrice || 0);
        var diff = (bid != null && ask != null) ? round2DeepDive_(ask - bid) : null;
        var volume = (c.volume != null && !isNaN(c.volume) && c.volume >= 0) ? c.volume : 0;

        candidates.push({
          strike: c.strike,
          delta: delta,
          iv: iv,
          bid: bid != null ? round2DeepDive_(bid) : null,
          ask: ask != null ? round2DeepDive_(ask) : null,
          diff: diff,
          volume: volume,
          oi: c.openInterest || 0,
          price: price,
          expEpoch: expEpoch
        });
      }
    });

    if (candidates.length === 0) return;

    candidates.sort(function (a, b) { return b.oi - a.oi; });
    var top = candidates.slice(0, SCAN_CONFIG.TOP_N_PER_EXPIRY);
    top.forEach(function (row) { resultRows.push(row); });
  });

  return {
    underlyingPrice: underlyingPrice,
    resultRows: resultRows,
    scannedCount: scannedCount,
    skippedCount: skippedCount,
    expirationsScanned: futureExpirations.length,
    error: null
  };
}



/**
 * ============================================================================
 * WRITE RESULTS
 * ============================================================================
 *
 * Writes A:M in a single pass (Rank through Open Interest). N onward is
 * never touched except to auto-extend YOUR existing formulas down to cover
 * any new rows this scan added. S:U are cleared and left empty.
 * ============================================================================
 */
function writeResults_(sheet, resultRows) {


  var firstRow =
    SCAN_CONFIG.FIRST_OUTPUT_ROW;


  var numberOfRows =
    resultRows.length;


  var lastOutputRow =
    firstRow + numberOfRows - 1;




  // --------------------------------------------------------------------------
  // Clear previous scanner output
  // --------------------------------------------------------------------------


  clearPreviousResults_(
    sheet,
    firstRow
  );




  // --------------------------------------------------------------------------
  // Write A:M
  // --------------------------------------------------------------------------


  sheet
    .getRange(
      firstRow,
      SCAN_CONFIG.COL.RANK,
      numberOfRows,
      SCAN_CONFIG.LAST_RAW_COL
    )
    .setValues(resultRows);




  // --------------------------------------------------------------------------
  // Number formatting
  // --------------------------------------------------------------------------


  sheet
    .getRange(
      firstRow,
      SCAN_CONFIG.COL.EXPIRY,
      numberOfRows,
      1
    )
    .setNumberFormat('m/d/yyyy');




  // --------------------------------------------------------------------------
  // Reconcile N:P formulas with the new output size — extend down if this
  // scan grew, trim the excess if it shrank.
  // --------------------------------------------------------------------------


  reconcileTrailingFormulas_(
    sheet,
    firstRow,
    lastOutputRow,
    SCAN_CONFIG.TRAILING_FORMULA_FIRST_COL,
    SCAN_CONFIG.TRAILING_FORMULA_LAST_COL
  );




  // --------------------------------------------------------------------------
  // Highlight the LEAST_SLIPPAGE_HIGHLIGHT_COUNT best rows this scan —
  // background only, no font color logic at all.
  // --------------------------------------------------------------------------

  highlightLeastSlippageRows_(
    sheet,
    firstRow,
    resultRows
  );
}




/**
 * ============================================================================
 * HIGHLIGHT BEST ROWS (highest OI, then lowest slippage)
 * ============================================================================
 *
 * No font color involved anywhere — this is a plain cell BACKGROUND fill
 * (A:M) on whichever LEAST_SLIPPAGE_HIGHLIGHT_COUNT rows rank best this
 * scan. Ranking priority:
 *
 *   1. Highest Open Interest (M) wins.
 *   2. Lowest Ask-Bid diff/slippage (K) breaks ties.
 *
 * Rows with no diff (missing bid/ask) are never eligible — a null diff
 * isn't "zero slippage," it's "unknown," so it's excluded rather than
 * treated as the best case.
 *
 * clearPreviousResults_ (called earlier, inside writeResults_) already
 * resets the background on the whole A:M output range before this runs,
 * so a row that WAS highlighted last scan but isn't this time never keeps
 * a stale fill — this only ever adds fresh highlights to a clean slate.
 * ============================================================================
 */
function highlightLeastSlippageRows_(sheet, firstRow, resultRows) {

  var diffColIndex = SCAN_CONFIG.COL.DIFF - 1; // 0-based index into each result row array
  var oiColIndex = SCAN_CONFIG.COL.OI - 1;     // 0-based index into each result row array

  var candidates = [];

  resultRows.forEach(function(row, i) {
    var diff = row[diffColIndex];
    if (diff != null && !isNaN(diff)) {
      candidates.push({
        sheetRow: firstRow + i,
        diff: diff,
        oi: row[oiColIndex] || 0
      });
    }
  });

  if (!candidates.length) {
    return;
  }

  candidates.sort(function(a, b) {
    if (b.oi !== a.oi) {
      return b.oi - a.oi; // highest OI first
    }
    return a.diff - b.diff; // tie-break: lowest slippage first
  });

  var toHighlight =
    candidates.slice(0, SCAN_CONFIG.LEAST_SLIPPAGE_HIGHLIGHT_COUNT);

  toHighlight.forEach(function(c) {
    sheet
      .getRange(c.sheetRow, 1, 1, SCAN_CONFIG.LAST_RAW_COL)
      .setBackground(LEAST_SLIPPAGE_HIGHLIGHT_COLOR);
  });
}




/**
 * ============================================================================
 * RECONCILE TRAILING FORMULAS (N:P)
 * ============================================================================
 *
 * N:P hold YOUR formulas (Net Price, Extra from current price, # of days),
 * not scanner output — this reconciles how far those formulas reach with
 * how many rows THIS scan actually produced:
 *
 *   - GREW:   the previous scan's formulas didn't reach far enough down for
 *             the new rows -> the lowest existing N:P formula is copied
 *             down (via R1C1, so relative references adjust automatically,
 *             same as dragging the fill handle) through the new last row.
 *   - SHRANK: the previous scan's formulas reach further down than this
 *             scan's output does -> the excess below the new last row is
 *             cleared, so you're not left with formulas referencing rows
 *             whose A:M data no longer exists.
 *   - SAME:   nothing to do.
 *
 * Either way, this only ever touches rows from firstOutputRow downward —
 * it never looks above the scanner's own output area.
 * ============================================================================
 */
function reconcileTrailingFormulas_(
  sheet,
  firstOutputRow,
  newLastRow,
  colStart,
  colEnd
) {


  var colCount =
    colEnd - colStart + 1;


  var sheetLastRow =
    sheet.getLastRow();


  var scanFrom =
    Math.max(sheetLastRow, newLastRow);




  // Find the lowest row at/above scanFrom that currently has a formula
  // in N:P — this reflects the PREVIOUS scan's extent, since N:P aren't
  // touched by clearPreviousResults_ before this function runs.
  var lastFormulaRow = null;


  for (var r = scanFrom; r >= firstOutputRow; r--) {


    var formulasHere =
      sheet
        .getRange(r, colStart, 1, colCount)
        .getFormulas()[0];


    var hasFormulaHere =
      formulasHere.some(function(f) {
        return f && String(f).trim() !== '';
      });


    if (hasFormulaHere) {
      lastFormulaRow = r;
      break;
    }
  }




  // N:P has never had a formula at all — nothing to extend or trim.
  if (lastFormulaRow === null) {
    return;
  }




  // --------------------------------------------------------------------
  // SHRANK: previous formulas reach further than this scan's output —
  // clear the excess below the new last row.
  // --------------------------------------------------------------------


  if (lastFormulaRow > newLastRow) {


    var excessRowCount =
      lastFormulaRow - newLastRow;


    sheet
      .getRange(
        newLastRow + 1,
        colStart,
        excessRowCount,
        colCount
      )
      .clearContent();


    return;
  }




  // --------------------------------------------------------------------
  // SAME: already reaches exactly the new output — nothing to do.
  // --------------------------------------------------------------------


  if (lastFormulaRow === newLastRow) {
    return;
  }




  // --------------------------------------------------------------------
  // GREW: extend the lowest existing formula down to the new last row.
  // --------------------------------------------------------------------


  var masterFormulasR1C1 =
    sheet
      .getRange(lastFormulaRow, colStart, 1, colCount)
      .getFormulasR1C1()[0];


  var hasAnyFormula =
    masterFormulasR1C1.some(function(f) {
      return f && String(f).trim() !== '';
    });


  if (!hasAnyFormula) {
    return;
  }




  var rowsToFill =
    newLastRow - lastFormulaRow;


  var formulaBlock = [];


  for (var i = 0; i < rowsToFill; i++) {
    formulaBlock.push(masterFormulasR1C1.slice());
  }




  sheet
    .getRange(
      lastFormulaRow + 1,
      colStart,
      rowsToFill,
      colCount
    )
    .setFormulasR1C1(formulaBlock);
}




/**
 * ============================================================================
 * CLEAR PREVIOUS RESULTS
 * ============================================================================
 *
 * Clears:
 *   A:M  — this scanner's own output
 *   S:U  — no longer used by this scanner at all; cleared so nothing
 *          left over from an older version lingers
 *
 * Does NOT touch N:R — those are populated by whatever you already have
 * set up there (Net Price, Extra from current price, # of days, Next
 * Catalyst, Date, etc.).
 * ============================================================================
 */
function clearPreviousResults_(
  sheet,
  firstRow
) {


  var lastRow =
    sheet.getLastRow();


  if (lastRow < firstRow) {
    return;
  }




  var rowCount =
    lastRow - firstRow + 1;




  // A:M
  sheet
    .getRange(
      firstRow,
      1,
      rowCount,
      SCAN_CONFIG.LAST_RAW_COL
    )
    .clearContent()
    .setBackground(null)  // resets any prior highlight — see highlightLeastSlippageRows_
    .setFontColor(null);  // this script never sets font color for any reason — kept explicitly reset to default




  // S:U
  sheet
    .getRange(
      firstRow,
      SCAN_CONFIG.CLEAR_EXTRA_FIRST_COL,
      rowCount,
      SCAN_CONFIG.CLEAR_EXTRA_LAST_COL - SCAN_CONFIG.CLEAR_EXTRA_FIRST_COL + 1
    )
    .clearContent();




  // --------------------------------------------------------------------------
  // N:R intentionally NOT touched.
  // --------------------------------------------------------------------------
}




/**
 * ============================================================================
 * YAHOO SESSION
 * ============================================================================
 */
function getYahooSession_(forceRefresh) {


  var cache =
    CacheService.getScriptCache();


  if (!forceRefresh) {


    var cached =
      cache.get('yahoo_session');


    if (cached) {
      return JSON.parse(cached);
    }
  }




  var ua =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
    'AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Chrome/124.0 Safari/537.36';




  var cookieResp =
    UrlFetchApp.fetch(
      'https://fc.yahoo.com',
      {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: {
          'User-Agent': ua
        }
      }
    );




  var cookieHeader =
    extractCookieHeader_(
      cookieResp
    );




  if (!cookieHeader) {


    var altResp =
      UrlFetchApp.fetch(
        'https://finance.yahoo.com',
        {
          muteHttpExceptions: true,
          followRedirects: true,
          headers: {
            'User-Agent': ua
          }
        }
      );




    cookieHeader =
      extractCookieHeader_(
        altResp
      );
  }




  if (!cookieHeader) {


    throw new Error(
      'Yahoo did not return a session cookie.'
    );


  }




  var crumbResp =
    UrlFetchApp.fetch(
      'https://query2.finance.yahoo.com/v1/test/getcrumb',
      {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': ua,
          'Cookie': cookieHeader
        }
      }
    );




  var crumb =
    crumbResp
      .getContentText()
      .trim();




  if (
    !crumb ||
    crumb.indexOf('<') !== -1 ||
    crumbResp.getResponseCode() !== 200
  ) {


    throw new Error(
      'Yahoo did not return a usable crumb (HTTP ' +
      crumbResp.getResponseCode() +
      ').'
    );


  }




  var session = {


    cookie: cookieHeader,


    crumb: crumb,


    ua: ua


  };




  cache.put(
    'yahoo_session',
    JSON.stringify(session),
    1500
  );




  return session;
}




/**
 * ============================================================================
 * COOKIE HELPER
 * ============================================================================
 */
function extractCookieHeader_(resp) {


  var headers =
    resp.getAllHeaders();


  var raw =
    headers['Set-Cookie'] ||
    headers['set-cookie'];




  if (!raw) {
    return null;
  }




  var list =
    Array.isArray(raw)
      ? raw
      : [raw];




  var pairs =
    list.map(function(c) {


      return c.split(';')[0];


    });




  return pairs.join('; ');
}




/**
 * ============================================================================
 * FETCH YAHOO OPTIONS
 * ============================================================================
 */
function fetchYahooOptionsRoot_(
  ticker,
  expirationEpoch,
  session,
  isRetry
) {


  var url =
    'https://query1.finance.yahoo.com/v7/finance/options/' +
    encodeURIComponent(ticker) +
    '?crumb=' +
    encodeURIComponent(session.crumb);




  if (expirationEpoch) {


    url +=
      '&date=' +
      expirationEpoch;


  }




  var resp =
    UrlFetchApp.fetch(
      url,
      {
        muteHttpExceptions: true,
        headers: {
          'User-Agent': session.ua,
          'Cookie': session.cookie
        }
      }
    );




  if (
    resp.getResponseCode() === 401 &&
    !isRetry
  ) {


    var freshSession =
      getYahooSession_(true);




    return fetchYahooOptionsRoot_(
      ticker,
      expirationEpoch,
      freshSession,
      true
    );


  }




  if (resp.getResponseCode() !== 200) {


    throw new Error(
      'Yahoo returned HTTP ' +
      resp.getResponseCode() +
      ' for ' +
      ticker +
      ' — it may be throttling Apps Script right now. Try again shortly.'
    );


  }




  var json =
    JSON.parse(
      resp.getContentText()
    );




  var result =
    json.optionChain &&
    json.optionChain.result &&
    json.optionChain.result[0];




  if (!result) {


    throw new Error(
      'No option chain data returned for ' +
      ticker +
      ' (bad ticker, or no listed options).'
    );


  }




  var out = {


    quote:
      result.quote,


    expirationDates:
      result.expirationDates


  };




  if (
    result.options &&
    result.options[0]
  ) {


    out.calls =
      result.options[0].calls || [];


    out.puts =
      result.options[0].puts || [];


  }




  return out;
}




/**
 * ============================================================================
 * BLACK-SCHOLES DELTA (DeepDive-specific — renamed to avoid colliding with
 * Momentum.gs's blackScholesDelta_, which takes different arguments)
 * ============================================================================
 */
function blackScholesDeltaDeepDive_(
  S,
  K,
  T,
  r,
  q,
  sigma,
  optionType
) {


  var d1 =
    (
      Math.log(S / K) +
      (
        r -
        q +
        (sigma * sigma) / 2
      ) *
      T
    ) /
    (
      sigma *
      Math.sqrt(T)
    );




  var Nd1 =
    normalCdf_(d1);




  if (optionType === 'C') {


    return (
      Math.exp(-q * T) *
      Nd1
    );


  } else {


    return (
      Math.exp(-q * T) *
      (Nd1 - 1)
    );


  }
}




/**
 * ============================================================================
 * NORMAL CDF
 * ============================================================================
 */
function normalCdf_(x) {


  var sign =
    x < 0 ? -1 : 1;




  x =
    Math.abs(x) /
    Math.sqrt(2);




  var a1 = 0.254829592,
      a2 = -0.284496736,
      a3 = 1.421413741,
      a4 = -1.453152027,
      a5 = 1.061405429,
      p = 0.3275911;




  var t =
    1 /
    (
      1 +
      p * x
    );




  var y =
    1 -
    (
      (
        (
          (
            (
              a5 * t +
              a4
            ) *
            t +
            a3
          ) *
          t +
          a2
        ) *
        t +
        a1
      ) *
      t *
      Math.exp(-x * x)
    );




  return (
    0.5 *
    (
      1 +
      sign * y
    )
  );
}




/**
 * ============================================================================
 * OPTION TYPE PARSER
 * ============================================================================
 *
 * Type just holds the letter — "C" or "P". Case-insensitive, trims
 * whitespace.
 * ============================================================================
 */
function parseOptionTypeLabel_(text) {


  var t =
    String(text).trim().toUpperCase();


  if (t === 'C' || t === 'P') {
    return t;
  }


  return null;
}




/**
 * ============================================================================
 * STRIKE FORMATTER
 * ============================================================================
 */
function formatStrikeLabel_(
  strike,
  type
) {


  var num =
    strike % 1 === 0
      ? strike.toFixed(0)
      : strike.toFixed(2);




  return '$' +
    num +
    type;
}




/**
 * ============================================================================
 * ROUND (DeepDive-specific — renamed to avoid colliding with Momentum.gs's
 * identical round2_; harmless today since both did the same thing, but
 * kept separate so a future edit to one can't silently affect the other)
 * ============================================================================
 */
function round2DeepDive_(n) {


  return Math.round(
    n * 100
  ) / 100;
}