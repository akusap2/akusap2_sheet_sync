/**
 * ============================================================================
 * DAILY PIPELINE (DailyPipeline.gs)
 * ----------------------------------------------------------------------------
 * One-click chain: Research -> Promote -> Auto-fill contracts, run in
 * stages via triggers (same pattern MobileRemote.gs already uses for its
 * own background actions) so the whole thing never hits Apps Script's
 * ~6-minute execution ceiling. Tap "Run Full Daily Pipeline" once, close
 * the tab if you want, and come back later to a finished result — check
 * the ScriptLog tab for a full summary either way.
 *
 * Validate & Update is deliberately NOT part of this chain — it's the
 * slowest step by far across three tabs, and it's meant to be run
 * on-demand once you're ready to review results, not folded into an
 * unattended background run.
 *
 * STAGES
 * ----------------------------------------------------------------------------
 * 1. RESEARCH   — runs runDailyResearch(). If it stops early (its own
 *                  time-budget-exceeded case), this stage re-runs itself via
 *                  trigger rather than advancing, exactly like Research
 *                  already tells you to do manually — just automatic here.
 * 2. PROMOTE     — for each of Quick/Risky/Leap: reads that tab's current
 *                  top-20 picks from the LAST Research run (the same
 *                  RESEARCH_LAST_<TAB> snapshot ResearchEngine.gs already
 *                  writes — no need to re-read/parse the Research sheet).
 *                  A row with an open position (non-blank Entry Price, same
 *                  detection HedgeEngine.gs already uses) is ALWAYS kept,
 *                  regardless of whether Research still picks it. Same for
 *                  a row whose Ticker cell you've manually colored — any
 *                  non-white background is treated as a deliberate "keep
 *                  this one" marker. A row with neither that ISN'T in
 *                  Research's current top 20 gets deleted, so the tab
 *                  doesn't grow without bound. Any Research pick not
 *                  already present is added as a new row (ticker only —
 *                  Strike/Expiry filled in by the next stage).
 * 3. AUTOFILL    — for every row on Quick/Risky/Leap missing a Strike or
 *                  Expiry (newly-promoted rows always qualify, since
 *                  Promote only ever writes the ticker; any older row you
 *                  left incomplete qualifies too), scans its chain with
 *                  THAT TAB's own settings (see IMPORTANT note below) and
 *                  fills in whichever of Strike/Expiry is still blank —
 *                  ranked by the same "highest Open Interest, tie-broken
 *                  by lowest Ask-Bid slippage" rule BestOpenInterest.gs
 *                  already uses for its own highlight. Never overwrites a
 *                  value you've already entered — only fills what's
 *                  actually empty. Time-budget aware and resumable, same
 *                  as Research. This is the LAST stage — the pipeline
 *                  reaches DONE from here.
 *
 * IMPORTANT — WHERE PER-TAB SCAN SETTINGS COME FROM:
 * BestOpenInterest.gs's interactive "Run Deep Dive Scan" menu action reads
 * its Type/Delta/MinExpiry/MaxExpiry/MinStrike from ONE shared config row
 * (DeepDive!C2:G2) — there's no per-tab distinction there today. But the
 * file ALSO still contains getInputConfigForSheet_(), which reads a
 * genuinely separate block PER TAB NAME from an "Input" sheet — this was
 * apparently an earlier design that the interactive scanner no longer uses,
 * but it's exactly the structure this pipeline needs (Quick, Risky, and
 * Leap each have real, different objectives, so auto-filling all three
 * with one shared setting would be wrong). This stage reuses that existing,
 * already-documented "Input" tab mechanism rather than inventing a new one.
 * If your "Input" sheet doesn't have current Quick/Risky/Leap blocks, this
 * stage will fail for that tab with a clear reason in the log — nothing
 * silently guesses.
 * ============================================================================
 */

const DAILY_PIPELINE_STATE_KEY = 'DAILY_PIPELINE_STATE';
const DAILY_PIPELINE_TRIGGER_FN = 'runDailyPipelineStage_';
// Deliberately tighter than each function's own standalone default (5 min
// for Research/Validate) — the pipeline needs headroom AFTER a stage's
// internal budget check breaks its loop for real wrap-up work (flushing
// caches, writing sheets, computing changes) plus this dispatcher's own
// overhead (trigger cleanup/creation, state serialization) before it can
// schedule the next stage. Cutting it too close risks Apps Script's own
// hard execution ceiling killing the whole run mid-wrap-up — a platform-
// level kill, not something a try/catch here can see or recover from.
const DAILY_PIPELINE_STAGE_TIME_BUDGET_MS = 4 * 60 * 1000;
const DAILY_PIPELINE_AUTOFILL_TIME_BUDGET_MS = 4 * 60 * 1000;
const DAILY_PIPELINE_AUTOFILL_SLEEP_MS = 400;


/**
 * ============================================================================
 * MENU ENTRY POINT — starts a fresh pipeline run from stage 1.
 * ============================================================================
 */
function runDailyPipeline() {
  clearDailyPipelineTriggers_();
  ensureDailyPipelineWatchdog_();

  const state = {
    stage: 'RESEARCH',
    startedAt: Date.now(),
    newlyPromoted: {},
    autofillQueue: [],
    autofillIndex: 0,
    log: []
  };
  PropertiesService.getScriptProperties().setProperty(DAILY_PIPELINE_STATE_KEY, JSON.stringify(state));

  // A toast (non-blocking) instead of notify_'s alert — this, and every
  // stage after it, must never pause waiting for a click. Scheduling
  // stage 1 via trigger below (rather than calling it directly) keeps
  // EVERY stage, including this first one, running with no UI context at
  // all — so any notify_ call a stage makes internally (e.g.
  // runDailyResearch's own completion message) always degrades to a
  // ScriptLog line instead of a dialog you'd have to dismiss.
  try {
    SpreadsheetApp.getActiveSpreadsheet().toast(
      'Daily Pipeline started \u2014 running in stages, check ScriptLog for progress.',
      'Daily Pipeline', 5
    );
  } catch (e) { /* fine if there's no active spreadsheet context */ }

  logToSheet_('Daily Pipeline started.');

  ScriptApp.newTrigger(DAILY_PIPELINE_TRIGGER_FN).timeBased().after(1000).create();
}

function clearDailyPipelineTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === DAILY_PIPELINE_TRIGGER_FN) ScriptApp.deleteTrigger(t);
  });
}

// Safety net beyond the tighter time budgets above: if a single execution
// still gets killed by Apps Script's own hard ceiling for any reason (a
// slow network day, say), the dispatcher's own "schedule the next stage"
// code never runs — leaving pipeline state saved but no trigger to ever
// resume it. This runs every 10 minutes, checks for exactly that
// situation (state exists, no resume trigger scheduled), and restarts
// the stage if it finds one. Near-zero cost the rest of the time — it's
// just two cheap checks and an immediate return.
function dailyPipelineWatchdog_() {
  const props = PropertiesService.getScriptProperties();
  const raw = props.getProperty(DAILY_PIPELINE_STATE_KEY);
  if (!raw) return;

  const hasActiveResumeTrigger = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === DAILY_PIPELINE_TRIGGER_FN;
  });
  if (hasActiveResumeTrigger) return;

  const state = JSON.parse(raw);
  logToSheet_('Daily Pipeline watchdog: found a stalled run at stage ' + state.stage + ', resuming automatically.');
  runDailyPipelineStage_();
}

function ensureDailyPipelineWatchdog_() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) {
    return t.getHandlerFunction() === 'dailyPipelineWatchdog_';
  });
  if (exists) return;
  ScriptApp.newTrigger('dailyPipelineWatchdog_').timeBased().everyMinutes(10).create();
}


/**
 * ============================================================================
 * STAGE DISPATCHER — called directly for the first stage, and via a
 * self-scheduled trigger for every stage after that (or to resume a stage
 * that hit its own time budget).
 * ============================================================================
 */
function runDailyPipelineStage_() {
  // Guards against exactly the failure mode you just hit: two overlapping
  // executions (a leftover trigger from an earlier run, the watchdog, a
  // normal stage trigger — any combination) both reading the same
  // pipeline state and both processing it, producing duplicate log
  // entries and duplicate work. Only one execution can hold this lock at
  // a time; a second one waits briefly, and if the first is still busy,
  // bails out cleanly instead of duplicating anything. The lock is tied
  // to this execution's lifetime, so even if a future execution gets
  // killed by Apps Script's own hard ceiling mid-stage, the lock is
  // released automatically — it can never get stuck held forever.
  const lock = LockService.getScriptLock();
  let gotLock = false;
  try {
    gotLock = lock.tryLock(10000);
  } catch (e) {
    gotLock = false;
  }
  if (!gotLock) {
    logToSheet_('Daily Pipeline: another execution is already processing a stage \u2014 skipping this one to avoid running the same stage twice.');
    return;
  }

  try {
    clearDailyPipelineTriggers_();

    const props = PropertiesService.getScriptProperties();
    const raw = props.getProperty(DAILY_PIPELINE_STATE_KEY);
    if (!raw) {
      logToSheet_('Daily Pipeline: stage trigger fired with no pipeline state \u2014 nothing to do (likely already finished or was reset).');
      return;
    }
    const state = JSON.parse(raw);

    try {
      if (state.stage === 'RESEARCH') {
        runDailyPipelineResearchStage_(state);
      } else if (state.stage === 'PROMOTE') {
        runDailyPipelinePromoteStage_(state);
      } else if (state.stage === 'AUTOFILL') {
        runDailyPipelineAutofillStage_(state);
      } else {
        state.stage = 'DONE';
        state.log.push('Unknown stage reached \u2014 stopping.');
      }
    } catch (err) {
      state.stage = 'FAILED';
      state.log.push('FAILED: ' + err);
    }

    if (state.stage === 'DONE' || state.stage === 'FAILED') {
      props.deleteProperty(DAILY_PIPELINE_STATE_KEY);
      const summary = 'Daily Pipeline ' + (state.stage === 'DONE' ? 'complete' : 'FAILED') +
        ' (' + Math.round((Date.now() - state.startedAt) / 60000) + ' min total):\n' + state.log.join('\n');
      logToSheet_(summary);
      return;
    }

    props.setProperty(DAILY_PIPELINE_STATE_KEY, JSON.stringify(state));
    ScriptApp.newTrigger(DAILY_PIPELINE_TRIGGER_FN).timeBased().after(2000).create();
  } finally {
    lock.releaseLock();
  }
}


/* ============================================================================
 * STAGE 1: RESEARCH
 * ========================================================================== */
function runDailyPipelineResearchStage_(state) {
  const result = runDailyResearch(DAILY_PIPELINE_STAGE_TIME_BUDGET_MS);
  if (result && result.timeBudgetExceeded) {
    state.log.push('Research: stopped early, resuming automatically.');
    // stage stays 'RESEARCH' — dispatcher re-triggers, cached data makes the retry fast
  } else {
    state.log.push('Research: complete.');
    state.stage = 'PROMOTE';
  }
}


/* ============================================================================
 * STAGE 2: PROMOTE
 * ========================================================================== */
function runDailyPipelinePromoteStage_(state) {
  state.newlyPromoted = {};
  const queue = [];

  ['Quick', 'Risky', 'Leap'].forEach(function (tabName) {
    const result = promoteResearchPicksForTab_(tabName);
    state.newlyPromoted[tabName] = result.addedTickers;
    state.log.push(tabName + ' promote: +' + result.added + ' added, \u2212' + result.deleted +
      ' removed (no position, dropped from top 20), ' + result.keptWithPosition + ' kept (open position), ' +
      result.keptColored + ' kept (manually colored).');

    // The auto-fill queue covers EVERY row on this tab missing Strike or
    // Expiry — not just rows Promote just added. This naturally includes
    // newly-added rows (always blank) alongside any older row left
    // incomplete from a previous session or manual entry, so it gets
    // backfilled on every pipeline run rather than only ever touching
    // brand-new tickers.
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(tabName);
    if (sheet) {
      const map = getColumnMap_(sheet);
      findTickersNeedingContract_(sheet, map).forEach(function (item) {
        queue.push({ tab: tabName, ticker: item.ticker, row: item.row });
      });
    }
  });

  state.autofillQueue = queue;
  state.autofillIndex = 0;
  state.stage = queue.length ? 'AUTOFILL' : 'DONE';
  if (!queue.length) state.log.push('Auto-fill: nothing to fill in \u2014 pipeline complete.');
}

// Scans a tab for every row with a ticker but a blank Strike and/or
// Expiry — used to build the auto-fill queue. Returns exact row numbers
// (not just tickers) so auto-fill can write directly without a second
// search, though it still verifies the ticker is still there before
// writing, in case the sheet changed between when this ran and when that
// row is actually processed (auto-fill can span several minutes).
function findTickersNeedingContract_(sheet, map) {
  if (!map.ticker) return [];
  const lastRow = sheet.getLastRow();
  const results = [];
  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    const ticker = String(sheet.getRange(row, map.ticker).getValue()).trim().toUpperCase();
    if (!ticker) continue;
    const strikeVal = map.strike ? sheet.getRange(row, map.strike).getValue() : '';
    const expiryVal = map.expiry ? sheet.getRange(row, map.expiry).getValue() : '';
    const missingStrike = strikeVal === '' || strikeVal == null;
    const missingExpiry = expiryVal === '' || expiryVal == null;
    if (missingStrike || missingExpiry) results.push({ ticker: ticker, row: row });
  }
  return results;
}

// Reads the LAST Research run's top-20 picks for tabName straight from the
// same snapshot ResearchEngine.gs already writes (RESEARCH_LAST_<TAB>) —
// no need to re-read or re-parse the Research sheet itself.
function promoteResearchPicksForTab_(tabName) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(tabName);
  if (!sheet) return { added: 0, deleted: 0, keptWithPosition: 0, keptColored: 0, addedTickers: [] };

  const map = getColumnMap_(sheet);
  if (!map.ticker) return { added: 0, deleted: 0, keptWithPosition: 0, keptColored: 0, addedTickers: [] };

  const lastRunRaw = PropertiesService.getScriptProperties().getProperty('RESEARCH_LAST_' + tabName.toUpperCase());
  const researchTickers = lastRunRaw ? JSON.parse(lastRunRaw) : [];
  const researchTickerSet = {};
  researchTickers.forEach(function (t) { researchTickerSet[t] = true; });

  const lastRow = sheet.getLastRow();
  const existingTickerSet = {};
  const rowsToDelete = [];
  let keptWithPosition = 0;
  let keptColored = 0;

  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    const ticker = String(sheet.getRange(row, map.ticker).getValue()).trim().toUpperCase();
    if (!ticker) continue;
    existingTickerSet[ticker] = true;

    const entryPriceRaw = map.entryPrice ? sheet.getRange(row, map.entryPrice).getValue() : '';
    const hasPosition = isPlausible_(parseFloat(entryPriceRaw), 0.01, null);

    if (hasPosition) {
      keptWithPosition++;
      continue; // always keep — real money is on the line, regardless of Research's current view
    }

    // A manually-colored ticker cell is treated the same as an open
    // position — a deliberate "keep this one" marker, regardless of
    // Research's current view. Any non-white background counts; this
    // script never colors the Ticker column itself for any other
    // reason, so a color there can only mean you set it yourself.
    const tickerBackground = sheet.getRange(row, map.ticker).getBackground();
    const isColored = tickerBackground && tickerBackground !== '#ffffff' && tickerBackground !== '';

    if (isColored) {
      keptColored++;
      continue;
    }

    if (!researchTickerSet[ticker]) {
      rowsToDelete.push(row);
    }
  }

  // Delete from the bottom up so earlier row numbers in the list stay valid.
  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (row) { sheet.deleteRow(row); });

  const newTickers = researchTickers.filter(function (t) { return !existingTickerSet[t]; });
  if (newTickers.length) {
    const startRow = sheet.getLastRow() + 1;
    newTickers.forEach(function (t, i) {
      sheet.getRange(startRow + i, map.ticker).setValue(t);
    });
  }

  return { added: newTickers.length, deleted: rowsToDelete.length, keptWithPosition: keptWithPosition, keptColored: keptColored, addedTickers: newTickers };
}


/* ============================================================================
 * STAGE 3: AUTOFILL — time-budget aware and resumable, same pattern as
 * Research's own ticker loop.
 * ========================================================================== */
function runDailyPipelineAutofillStage_(state) {
  const scriptStartTime = Date.now();
  const sheetCache = {}; // tabName -> Sheet, avoids repeated getSheetByName calls
  const mapCache = {};   // tabName -> column map

  // Persisted in state (not local) since the queue can span several
  // passes — this is what lets the final summary report a true total
  // across the whole stage, not just whatever fit in the last pass.
  if (!state.autofillTotals) {
    state.autofillTotals = { Quick: { filled: 0, skipped: 0 }, Risky: { filled: 0, skipped: 0 }, Leap: { filled: 0, skipped: 0 } };
  }

  let passFilled = 0, passSkipped = 0;
  const skipReasons = [];

  while (state.autofillIndex < state.autofillQueue.length) {
    if (Date.now() - scriptStartTime > DAILY_PIPELINE_AUTOFILL_TIME_BUDGET_MS) break;

    const item = state.autofillQueue[state.autofillIndex];
    state.autofillIndex++;
    const totals = state.autofillTotals[item.tab];

    let config;
    try {
      config = getInputConfigForSheet_(item.tab);
    } catch (e) {
      passSkipped++; totals.skipped++;
      skipReasons.push(item.tab + '/' + item.ticker + ': ' + e.message);
      continue;
    }

    const optionType = parseOptionTypeLabel_(String(config.type).trim());
    const deltaThreshold = Number(config.delta);
    const minDays = Number(config.minExpiry);
    const strikePercent = parseFloat(String(config.minStrike).replace('%', '').trim());
    let maxDays = (optionType === 'P') ? Number(config.maxExpiry) : null;
    if (optionType === 'P' && (config.maxExpiry === '' || config.maxExpiry === undefined || isNaN(maxDays) || maxDays <= 0)) maxDays = null;

    if (!optionType || !deltaThreshold || isNaN(deltaThreshold) || isNaN(minDays)) {
      passSkipped++; totals.skipped++;
      skipReasons.push(item.tab + '/' + item.ticker + ': Input sheet settings incomplete/invalid.');
      continue;
    }

    const scan = scanOptionChainCandidates_(item.ticker, optionType, deltaThreshold, minDays, maxDays, strikePercent);
    Utilities.sleep(DAILY_PIPELINE_AUTOFILL_SLEEP_MS);

    if (scan.error || !scan.resultRows.length) {
      passSkipped++; totals.skipped++;
      skipReasons.push(item.tab + '/' + item.ticker + ': ' + (scan.error || 'no candidates met the delta threshold'));
      continue;
    }

    // Same ranking BestOpenInterest.gs's own highlight already uses:
    // highest Open Interest first, lowest Ask-Bid slippage as the
    // tiebreaker. Rows with no diff (missing bid/ask) aren't eligible.
    const eligible = scan.resultRows.filter(function (r) { return r.diff != null && !isNaN(r.diff); });
    const pool = eligible.length ? eligible : scan.resultRows;
    pool.sort(function (a, b) {
      if (b.oi !== a.oi) return b.oi - a.oi;
      if (a.diff == null || b.diff == null) return 0;
      return a.diff - b.diff;
    });
    const best = pool[0];

    if (!sheetCache[item.tab]) {
      sheetCache[item.tab] = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(item.tab);
      mapCache[item.tab] = getColumnMap_(sheetCache[item.tab]);
    }
    const sheet = sheetCache[item.tab];
    const map = mapCache[item.tab];

    // Use the row captured when the queue was built — fall back to a
    // fresh search only if the sheet changed since then (auto-fill can
    // span several minutes across passes).
    let row = item.row;
    const tickerStillThere = row && row <= sheet.getLastRow() &&
      String(sheet.getRange(row, map.ticker).getValue()).trim().toUpperCase() === item.ticker;
    if (!tickerStillThere) row = findRowForTicker_(sheet, map, item.ticker);

    if (!row) {
      passSkipped++; totals.skipped++;
      skipReasons.push(item.tab + '/' + item.ticker + ': row not found (may have been edited mid-run).');
      continue;
    }

    // Only fills what's actually blank — if you'd already entered a
    // Strike or Expiry yourself, it's left untouched; the other, still-
    // blank field gets filled in alongside it.
    const currentStrike = map.strike ? sheet.getRange(row, map.strike).getValue() : '';
    const currentExpiry = map.expiry ? sheet.getRange(row, map.expiry).getValue() : '';
    if (map.strike && (currentStrike === '' || currentStrike == null)) {
      // Momentum.gs's own parser (parseStrikeCell_) requires a trailing
      // C/P — a bare number silently fails to parse there, leaving the
      // row looking populated but actually invalid to Validate & Update.
      // formatStrikeLabel_ (BestOpenInterest.gs) produces the exact same
      // "$230C" format its own DeepDive output already uses.
      sheet.getRange(row, map.strike).setValue(formatStrikeLabel_(best.strike, optionType));
    }
    if (map.expiry && (currentExpiry === '' || currentExpiry == null)) {
      sheet.getRange(row, map.expiry).setValue(new Date((best.expEpoch + 86400) * 1000));
    }
    passFilled++; totals.filled++;
  }

  state.log.push('Auto-fill (Best Open Interest) pass: ' + passFilled + ' filled, ' + passSkipped + ' skipped' +
    (skipReasons.length ? (' (' + skipReasons.slice(0, 5).join('; ') + (skipReasons.length > 5 ? '; ...' : '') + ')') : '') + '.');

  if (state.autofillIndex >= state.autofillQueue.length) {
    state.stage = 'DONE';
    // Clear, per-tab confirmation that Best Open Interest actually ran
    // across all three tabs — the single success message this whole
    // stage needed but didn't have before.
    const t = state.autofillTotals;
    state.log.push('Auto-fill (Best Open Interest) complete \u2014 Quick: ' + t.Quick.filled + ' filled, ' + t.Quick.skipped +
      ' skipped | Risky: ' + t.Risky.filled + ' filled, ' + t.Risky.skipped +
      ' skipped | Leap: ' + t.Leap.filled + ' filled, ' + t.Leap.skipped + ' skipped.');
  }
  // else: stage stays 'AUTOFILL', dispatcher re-triggers to continue the queue
}

function findRowForTicker_(sheet, map, ticker) {
  const lastRow = sheet.getLastRow();
  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    if (String(sheet.getRange(row, map.ticker).getValue()).trim().toUpperCase() === ticker) return row;
  }
  return null;
}