/**
 * ============================================================================
 * MOBILE REMOTE (MobileRemote.gs)
 * ----------------------------------------------------------------------------
 * A minimal Web App "remote control" for triggering this project's
 * menu-driven functions from a phone. Google Sheets' mobile apps don't
 * render custom menus at all, and Google's own docs confirm image/drawing-
 * assigned scripts explicitly don't execute on mobile either — this is a
 * platform limitation, not something fixable from inside the script. A
 * deployed Web App, opened once in Safari and added to the home screen,
 * sidesteps it entirely.
 *
 * ONE-TIME SETUP:
 *   1. Apps Script editor -> Deploy -> New deployment -> type: Web app.
 *   2. Execute as: Me. Who has access: Only myself.
 *   3. Deploy, copy the resulting .../exec URL.
 *   4. Open that URL once in Safari on your iPhone (sign in if prompted —
 *      only your own Google account can use it), then Share -> Add to
 *      Home Screen. The icon opens straight to this page from then on.
 *   Redeploy (Deploy -> Manage deployments -> edit -> new version) any
 *   time you change this file for the change to take effect at the /exec
 *   URL — this matches how every Apps Script web app deployment works.
 *
 * SCOPE: only functions already built to run with no interactive UI (they
 * use tryGetUi_() internally, same as the existing scheduled-run
 * dispatcher) are wired up here — validateAndUpdate, scanOptionChainForBestOi,
 * runHedgeAnalysis, runDeepDiveScan. Place Trades is deliberately NOT
 * exposed here — it executes real trades, and a home-screen icon is too
 * easy to tap by accident.
 *
 * DEEP DIVE SCAN: runs off whatever ticker and settings are already in the
 * DeepDive sheet's row 2 (no input field on this page) — update those
 * cells directly in the sheet, then tap the button here to run it. This
 * requires BestOpenInterest.gs's runDeepDiveScan to use tryGetUi_()/
 * notify_() instead of a direct SpreadsheetApp.getUi() call — see that
 * file's own header note for the full explanation of what changed there.
 *
 * doGet is a reserved, one-per-project entry point in Apps Script (same
 * rule as onOpen) — if this project already defines one elsewhere, that
 * needs to be merged with this one rather than left as two.
 * ============================================================================
 */

// Bump this every time this file changes, and check it on the phone
// (shown at the bottom of every page) after redeploying — the single
// fastest way to confirm the live web app actually matches what's in the
// editor, rather than guessing based on symptoms.
const MOBILE_REMOTE_VERSION = 'v9';

const MOBILE_REMOTE_ACTIONS = {
  'validate-quick': { label: 'Validate & Update — Quick', run: function () { return runValidateForSheet_('Quick'); } },
  'validate-risky': { label: 'Validate & Update — Risky', run: function () { return runValidateForSheet_('Risky'); } },
  'validate-leap': { label: 'Validate & Update — Leap', run: function () { return runValidateForSheet_('Leap'); } },
  'scan-quick': { label: 'Scan Chain by Delta/OI — Quick', run: function () { return runScanForSheet_('Quick'); } },
  'scan-risky': { label: 'Scan Chain by Delta/OI — Risky', run: function () { return runScanForSheet_('Risky'); } },
  'scan-leap': { label: 'Scan Chain by Delta/OI — Leap', run: function () { return runScanForSheet_('Leap'); } },
  'hedge': { label: 'Run Hedge Analysis', run: function () { return runHedgeForRemote_(); } },
  'research': { label: 'Run Daily Research', run: function () { return runResearchForRemote_(); } },
  'pipeline': { label: 'Run Full Daily Pipeline', run: function () { return runDailyPipelineForRemote_(); } },
  'deepdive': { label: 'Run Deep Dive Scan', run: function () { return runDeepDiveScanSafe_(); } }
};

// Reads back whatever the Log tab gained during this call — validateAndUpdate/
// scanOptionChainForBestOi/runHedgeAnalysis all write their full summary there
// via notify_() whenever tryGetUi_() finds no interactive UI, which is always
// the case here (a web app request has no Sheets UI attached, same as a
// time-driven trigger). This surfaces that real summary on the phone screen
// instead of a generic "done."
function getLatestLogText_(sinceTimeMs) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const logSheet = ss.getSheetByName(SCRIPT_LOG_SHEET_NAME);
  if (!logSheet) return '(No ScriptLog tab found — nothing to show, but the action above did run.)';
  const lastRow = logSheet.getLastRow();
  if (lastRow < 2) return '(ScriptLog tab is empty.)';
  const values = logSheet.getRange(2, 1, lastRow - 1, 2).getValues();
  const relevant = values.filter(function (row) { return row[0] instanceof Date && row[0].getTime() >= sinceTimeMs; });
  if (!relevant.length) return '(No new ScriptLog entries were written for this run.)';
  return relevant.map(function (row) {
    return Utilities.formatDate(row[0], Session.getScriptTimeZone(), 'HH:mm:ss') + ' \u2014 ' + row[1];
  }).join('\n\n');
}

function runValidateForSheet_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return 'Sheet "' + sheetName + '" not found.';
  const startTimeMs = new Date().getTime();
  validateAndUpdate(sheet);
  return getLatestLogText_(startTimeMs);
}

function runScanForSheet_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return 'Sheet "' + sheetName + '" not found.';
  const startTimeMs = new Date().getTime();
  scanOptionChainForBestOi(sheet);
  return getLatestLogText_(startTimeMs);
}

function runHedgeForRemote_() {
  const startTimeMs = new Date().getTime();
  runHedgeAnalysis();
  return getLatestLogText_(startTimeMs);
}

function runResearchForRemote_() {
  const startTimeMs = new Date().getTime();
  runDailyResearch();
  return getLatestLogText_(startTimeMs);
}

// Unlike every other action here, the pipeline outlives this single
// trigger call — it self-schedules across several more runs over
// (sometimes many) minutes via its own separate trigger. Reporting back
// via getLatestLogText_ the way other actions do would show "completed"
// after just the first partial stage, which would be misleading — so
// this returns a fixed, honest "started" message instead of waiting for
// or implying a finished result.
function runDailyPipelineForRemote_() {
  runDailyPipeline();
  return 'Daily Pipeline started \u2014 it runs in stages over several minutes (sometimes longer) ' +
    'and keeps going in the background even after this page shows complete. Check the ScriptLog ' +
    'tab for the final summary once it actually finishes.';
}

function runDeepDiveScanSafe_() {
  const startTimeMs = new Date().getTime();
  runDeepDiveScan(); // no override — uses whatever's already in the DeepDive sheet's B2
  return getLatestLogText_(startTimeMs);
}

// Property keys used to track the last-run action's status, so refreshing
// the page (either the status page itself, via its auto-refresh meta tag,
// or the home page) reflects the real current state instead of requiring
// a separate notification channel.
const MOBILE_STATUS_PROPS_ = {
  ACTION_LABEL: 'MOBILE_REMOTE_ACTION_LABEL',
  STATUS: 'MOBILE_REMOTE_STATUS', // 'running' | 'completed' | 'failed'
  RESULT: 'MOBILE_REMOTE_RESULT',
  STARTED_AT: 'MOBILE_REMOTE_STARTED_AT'
};

function doGet(e) {
  const baseUrl = ScriptApp.getService().getUrl();
  const action = e.parameter && e.parameter.action;

  if (action && MOBILE_REMOTE_ACTIONS[action]) {
    // Don't run the action inline here — validateAndUpdate/scanOptionChainFor
    // BestOi/runHedgeAnalysis can take several minutes, and a phone browser
    // tab that gets backgrounded or the screen locked during that wait is
    // very likely to have its connection dropped by iOS long before the
    // response comes back. Instead, queue the action via a one-time trigger
    // and return immediately — the work then runs fully decoupled from this
    // HTTP request's lifetime.
    const props = PropertiesService.getScriptProperties();
    props.setProperty('MOBILE_REMOTE_PENDING_ACTION', action);
    props.setProperty(MOBILE_STATUS_PROPS_.ACTION_LABEL, MOBILE_REMOTE_ACTIONS[action].label);
    props.setProperty(MOBILE_STATUS_PROPS_.STATUS, 'running');
    props.deleteProperty(MOBILE_STATUS_PROPS_.RESULT);
    props.setProperty(MOBILE_STATUS_PROPS_.STARTED_AT, String(new Date().getTime()));
    ScriptApp.newTrigger('runPendingMobileAction_').timeBased().after(1000).create();
    return HtmlService.createHtmlOutput(renderStatusPage_(baseUrl))
      .setTitle('Options Validator Remote')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  if (e.parameter && e.parameter.status) {
    return HtmlService.createHtmlOutput(renderStatusPage_(baseUrl))
      .setTitle('Options Validator Remote')
      .addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }

  return HtmlService.createHtmlOutput(renderHomePage_(baseUrl))
    .setTitle('Options Validator Remote')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// Fired by the one-time trigger doGet() schedules above. Deletes itself
// first (so one-time triggers never accumulate), then runs whichever
// action was queued. Note: queuing a second action before the first one's
// trigger has fired will overwrite the pending one — fine for a single-
// user tool used one tap at a time, but not built for rapid double-taps.
function runPendingMobileAction_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runPendingMobileAction_') ScriptApp.deleteTrigger(t);
  });

  const props = PropertiesService.getScriptProperties();
  const action = props.getProperty('MOBILE_REMOTE_PENDING_ACTION');
  if (!action || !MOBILE_REMOTE_ACTIONS[action]) {
    logToSheet_('Mobile Remote: runPendingMobileAction_ fired with no valid pending action (found: ' + JSON.stringify(action) + '). Nothing ran.');
    props.setProperty(MOBILE_STATUS_PROPS_.STATUS, 'failed');
    props.setProperty(MOBILE_STATUS_PROPS_.RESULT, 'The trigger fired but found no valid queued action (found: ' + JSON.stringify(action) + '). See the Log tab.');
    return;
  }
  props.deleteProperty('MOBILE_REMOTE_PENDING_ACTION');

  try {
    const resultText = MOBILE_REMOTE_ACTIONS[action].run();
    props.setProperty(MOBILE_STATUS_PROPS_.STATUS, 'completed');
    props.setProperty(MOBILE_STATUS_PROPS_.RESULT, String(resultText));
  } catch (err) {
    props.setProperty(MOBILE_STATUS_PROPS_.STATUS, 'failed');
    props.setProperty(MOBILE_STATUS_PROPS_.RESULT, String(err));
    logToSheet_('Mobile Remote: "' + action + '" failed \u2014 ' + err);
  }
}

// Renders the current state of the last-queued action: still running (with
// a plain HTML meta-refresh — no JS needed — so reloading, or just leaving
// the tab open, picks up the finished result automatically), or the actual
// result/error text once runPendingMobileAction_ has recorded one.
function renderStatusPage_(baseUrl) {
  const props = PropertiesService.getScriptProperties();
  const label = props.getProperty(MOBILE_STATUS_PROPS_.ACTION_LABEL) || 'Last run';
  const status = props.getProperty(MOBILE_STATUS_PROPS_.STATUS);
  const result = props.getProperty(MOBILE_STATUS_PROPS_.RESULT);
  const startedAtRaw = props.getProperty(MOBILE_STATUS_PROPS_.STARTED_AT);
  const agoText = startedAtRaw ? elapsedText_(new Date().getTime() - Number(startedAtRaw)) : '';
  const statusUrl = baseUrl + '?status=1';

  let autoRefresh = '';
  let body;

  if (status === 'running') {
    autoRefresh = '<meta http-equiv="refresh" content="4;url=' + statusUrl + '">';
    body = '<h1>' + label + '</h1>' +
      '<p>Still running' + (agoText ? ' \u2014 started ' + agoText + ' ago' : '') + '\u2026</p>' +
      '<p class="hint">This page checks again automatically every few seconds. You can also lock your phone or close this tab \u2014 the run keeps going either way, and reopening this page later will show the result.</p>';
  } else if (status === 'completed') {
    body = '<h1>' + label + ' \u2014 done' + (agoText ? ' (' + agoText + ' ago)' : '') + '</h1>' +
      '<pre>' + escapeHtml_(result || '(finished \u2014 no summary was captured)') + '</pre>';
  } else if (status === 'failed') {
    body = '<h1>' + label + ' \u2014 failed</h1>' +
      '<pre>' + escapeHtml_(result || 'Unknown error.') + '</pre>';
  } else {
    body = '<h1>No run in progress</h1><p class="hint">Nothing has been started yet, or the status was cleared.</p>';
  }

  return '<!DOCTYPE html><html><head>' + autoRefresh + REMOTE_PAGE_STYLE_ + '</head><body>' +
    '<div class="version-badge-top">' + MOBILE_REMOTE_VERSION + '</div>' +
    body +
    '<a class="back" href="' + baseUrl + '">\u2190 Back to menu</a>' +
    '</body></html>';
}

function elapsedText_(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) return totalSeconds + 's';
  return Math.floor(totalSeconds / 60) + 'm ' + (totalSeconds % 60) + 's';
}

function escapeHtml_(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderHomePage_(baseUrl) {
  const groups = [
    { title: 'Validate & Update', keys: ['validate-quick', 'validate-risky', 'validate-leap'] },
    { title: 'Scan Chain by Delta / OI', keys: ['scan-quick', 'scan-risky', 'scan-leap'] },
    { title: 'Hedge', keys: ['hedge'] },
    { title: 'Research', keys: ['research'] },
    { title: 'Full Pipeline', keys: ['pipeline'] },
    { title: 'DeepDive', keys: ['deepdive'] }
  ];

  const sections = groups.map(function (g) {
    const buttons = g.keys.map(function (key) {
      return '<a class="btn" href="' + baseUrl + '?action=' + encodeURIComponent(key) + '">' + MOBILE_REMOTE_ACTIONS[key].label + '</a>';
    }).join('\n');
    return '<div class="group"><div class="group-title">' + g.title + '</div>' + buttons + '</div>';
  }).join('\n');

  const props = PropertiesService.getScriptProperties();
  const lastStatus = props.getProperty(MOBILE_STATUS_PROPS_.STATUS);
  let statusBanner = '';
  if (lastStatus) {
    const label = props.getProperty(MOBILE_STATUS_PROPS_.ACTION_LABEL) || 'Last run';
    const statusWord = lastStatus === 'running' ? 'still running\u2026' : lastStatus === 'completed' ? 'finished \u2014 tap for details' : 'failed \u2014 tap for details';
    statusBanner = '<a class="status-banner status-' + lastStatus + '" href="' + baseUrl + '?status=1">' + label + ' \u2014 ' + statusWord + '</a>';
  }

  return '<!DOCTYPE html><html><head>' + REMOTE_PAGE_STYLE_ + '</head><body>' +
    '<h1>Options Validator Remote <span class="version-badge">' + MOBILE_REMOTE_VERSION + '</span></h1>' +
    statusBanner +
    sections +
    '<p class="hint">Tapping a button starts the run in the background and confirms immediately \u2014 refresh or reopen this page any time to check on it. Deep Dive runs off whatever ticker/settings are already in the DeepDive sheet.</p>' +
    '</body></html>';
}

const REMOTE_PAGE_STYLE_ =
  '<style>' +
  'body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#f5f5f5;margin:0;padding:20px;color:#1a1a1a;}' +
  'h1{font-size:20px;margin-bottom:16px;}' +
  '.group{margin-bottom:20px;}' +
  '.group-title{font-size:13px;text-transform:uppercase;letter-spacing:0.03em;color:#666;margin-bottom:8px;}' +
  '.btn{display:block;background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px;margin-bottom:10px;' +
  'text-decoration:none;color:#1a1a1a;font-size:16px;box-shadow:0 1px 2px rgba(0,0,0,0.05);}' +
  '.btn:active{background:#eee;}' +
  '.hint{font-size:13px;color:#888;margin-top:8px;}' +
  '.version-badge{display:inline-block;background:#1a73e8;color:#fff;font-size:12px;font-weight:700;padding:3px 8px;border-radius:6px;vertical-align:middle;margin-left:6px;}' +
  '.version-badge-top{display:inline-block;background:#1a73e8;color:#fff;font-size:13px;font-weight:700;padding:4px 10px;border-radius:8px;margin-bottom:16px;}' +

  '.status-banner{display:block;padding:14px;border-radius:10px;margin-bottom:16px;text-decoration:none;font-size:15px;font-weight:600;}' +
  '.status-running{background:#fff3cd;color:#856404;}' +
  '.status-completed{background:#d4edda;color:#155724;}' +
  '.status-failed{background:#f8d7da;color:#721c24;}' +
  'pre{white-space:pre-wrap;background:#fff;border:1px solid #ddd;border-radius:10px;padding:16px;font-size:14px;line-height:1.5;}' +
  '.back{display:inline-block;margin-top:16px;color:#1a73e8;text-decoration:none;font-size:16px;}' +
  '</style>';