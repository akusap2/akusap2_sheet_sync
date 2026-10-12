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
 * dispatcher) are wired up here: every Flip, CSP and Long menu action that does not
 * ask you to type something (scan, promote, update universe, stats, grading,
 * alerts, schedules, dry runs), plus Daily Research, Deep Dive and Hedge.
 * Quick and Leap actions were removed (no longer used). The one-ticker debug
 * tools are NOT here because they ask for a ticker in a pop-up. Place Trades is
 * deliberately NOT exposed here: it executes real trades, and a home-screen icon is too easy to tap by accident.
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
const MOBILE_REMOTE_VERSION = 'v12';

const MOBILE_REMOTE_ACTIONS = {
  // ---- Flip ----
  'flip-scan': { label: 'Run Flip Scan', run: function () { return runLoggedForRemote_(runFlipScan); } },
  'flip-promote': { label: 'Promote Research Picks to Flip', run: function () { return runLoggedForRemote_(runFlipPromote); } },
  'flip-universe': { label: 'Update Flip Universe', run: function () { return runLoggedForRemote_(flipUpdateUniverse); } },
  'flip-stats': { label: 'Build Flip Stats', run: function () { return runLoggedForRemote_(flipBuildStats); } },
  'flip-grade': { label: 'Grade Past Flip Signals', run: function () { return runLoggedForRemote_(flipGradeSignals); } },
  'flip-alert-test': { label: 'Send Test Flip Alert', run: function () { return runLoggedForRemote_(sendTestFlipAlert_); } },
  'flip-alert-toggle': { label: 'Turn Flip Alerts On / Off', run: function () { return runLoggedForRemote_(toggleFlipAlerts_); } },
  'flip-sched-start': { label: 'Start Flip Schedule', run: function () { return runLoggedForRemote_(startFlipSchedule_); } },
  'flip-sched-stop': { label: 'Stop Flip Schedule', run: function () { return runLoggedForRemote_(stopFlipSchedule_); } },
  'flip-sched-status': { label: 'Flip Schedule Status', run: function () { return runLoggedForRemote_(flipScheduleStatus_); } },
  'flip-scan-dry': { label: 'Flip Scan Dry Run (no writes)', run: function () { return runLoggedForRemote_(runFlipScanDryRun); } },
  'flip-promote-dry': { label: 'Flip Promote Dry Run (no writes)', run: function () { return runLoggedForRemote_(runFlipPromoteDryRun); } },
  // ---- CSP ----
  'csp-scan': { label: 'Run CSP Scan', run: function () { return runLoggedForRemote_(runCspScan); } },
  'csp-promote': { label: 'Promote Research Picks to CSP', run: function () { return runLoggedForRemote_(runCspPromote); } },
  'csp-universe': { label: 'Update CSP Universe', run: function () { return runLoggedForRemote_(cspUpdateUniverse); } },
  'csp-detail': { label: 'Show / Hide CSP Detail Columns', run: function () { return runLoggedForRemote_(cspToggleDetailColumns_, 'Detail columns on the CSP tab were toggled (shown if they were hidden, hidden if they were shown).'); } },
  'csp-alert-test': { label: 'Send Test CSP Alert', run: function () { return runLoggedForRemote_(sendTestCspAlert_); } },
  'csp-alert-toggle': { label: 'Turn CSP Alerts On / Off', run: function () { return runLoggedForRemote_(toggleCspAlerts_); } },
  'csp-sched-start': { label: 'Start CSP Schedule', run: function () { return runLoggedForRemote_(startCspSchedule_); } },
  'csp-sched-stop': { label: 'Stop CSP Schedule', run: function () { return runLoggedForRemote_(stopCspSchedule_); } },
  'csp-sched-status': { label: 'CSP Schedule Status', run: function () { return runLoggedForRemote_(cspScheduleStatus_); } },
  'csp-scan-dry': { label: 'CSP Scan Dry Run (no writes)', run: function () { return runLoggedForRemote_(runCspScanDryRun); } },
  'csp-promote-dry': { label: 'CSP Promote Dry Run (no writes)', run: function () { return runLoggedForRemote_(runCspPromoteDryRun); } },
  // ---- Long ----
  'long-scan': { label: 'Run Long Scan', run: function () { return runLoggedForRemote_(runLongScan); } },
  'long-promote': { label: 'Promote Research Picks to Long', run: function () { return runLoggedForRemote_(runLongPromote); } },
  'long-universe': { label: 'Update Long Universe', run: function () { return runLoggedForRemote_(longUpdateUniverse); } },
  'long-detail': { label: 'Show / Hide Long Detail Columns', run: function () { return runLoggedForRemote_(longToggleDetailColumns_, 'Detail columns on the Long tab were toggled (shown if they were hidden, hidden if they were shown).'); } },
  'long-alert-test': { label: 'Send Test Long Alert', run: function () { return runLoggedForRemote_(sendTestLongAlert_); } },
  'long-alert-toggle': { label: 'Turn Long Alerts On / Off', run: function () { return runLoggedForRemote_(toggleLongAlerts_); } },
  'long-sched-start': { label: 'Start Long Schedule', run: function () { return runLoggedForRemote_(startLongSchedule_); } },
  'long-sched-stop': { label: 'Stop Long Schedule', run: function () { return runLoggedForRemote_(stopLongSchedule_); } },
  'long-sched-status': { label: 'Long Schedule Status', run: function () { return runLoggedForRemote_(longScheduleStatus_); } },
  'long-scan-dry': { label: 'Long Scan Dry Run (no writes)', run: function () { return runLoggedForRemote_(runLongScanDryRun); } },
  'long-promote-dry': { label: 'Long Promote Dry Run (no writes)', run: function () { return runLoggedForRemote_(runLongPromoteDryRun); } },
  // ---- Other ----
  'research': { label: 'Run Daily Research', run: function () { return runResearchForRemote_(); } },
  'deepdive': { label: 'Run Deep Dive Scan', run: function () { return runDeepDiveScanSafe_(); } },
  'hedge': { label: 'Run Hedge Analysis', run: function () { return runHedgeForRemote_(); } }
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

// Runs one menu function with no arguments (so it sees no Sheets UI and writes its summary to the ScriptLog), then reads that
// summary back for the phone. fallbackText is shown when the function writes nothing to the log.
function runLoggedForRemote_(fn, fallbackText) {
  const startTimeMs = new Date().getTime();
  fn();
  const text = getLatestLogText_(startTimeMs);
  if (fallbackText && text.indexOf('(No new ScriptLog entries') === 0) return fallbackText;
  return text;
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
    { title: 'Flip', keys: ['flip-scan', 'flip-promote', 'flip-universe', 'flip-stats', 'flip-grade'] },
    { title: 'Flip Alerts & Schedule', keys: ['flip-alert-test', 'flip-alert-toggle', 'flip-sched-start', 'flip-sched-stop', 'flip-sched-status'] },
    { title: 'Flip Dry Runs', keys: ['flip-scan-dry', 'flip-promote-dry'] },
    { title: 'CSP', keys: ['csp-scan', 'csp-promote', 'csp-universe', 'csp-detail'] },
    { title: 'CSP Alerts & Schedule', keys: ['csp-alert-test', 'csp-alert-toggle', 'csp-sched-start', 'csp-sched-stop', 'csp-sched-status'] },
    { title: 'CSP Dry Runs', keys: ['csp-scan-dry', 'csp-promote-dry'] },
    { title: 'Long', keys: ['long-scan', 'long-promote', 'long-universe', 'long-detail'] },
    { title: 'Long Alerts & Schedule', keys: ['long-alert-test', 'long-alert-toggle', 'long-sched-start', 'long-sched-stop', 'long-sched-status'] },
    { title: 'Long Dry Runs', keys: ['long-scan-dry', 'long-promote-dry'] },
    { title: 'Other', keys: ['research', 'deepdive', 'hedge'] }
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
    '<p class="hint">Tapping a button starts the run in the background and confirms immediately \u2014 refresh or reopen this page any time to check on it. Deep Dive runs off whatever ticker/settings are already in the DeepDive sheet. The one-ticker debug tools and Place Trades are not available here.</p>' +
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