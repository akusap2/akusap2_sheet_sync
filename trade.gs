/**
 * ============================================================================
 * TRADE EXECUTOR (TradeExecutor.gs) — sends the Auto_Trade tab to TastyTrade
 * ----------------------------------------------------------------------------
 * Apps Script only (no Cloud Function). Uses the same TASTY_CLIENT_SECRET /
 * TASTY_REFRESH_TOKEN as everything else. The refresh token must have the
 * "trade" scope, otherwise TastyTrade answers 403 on order calls.
 *
 * NOTHING is sent unless a row's Status is exactly "Review" (what the Day tab writes) and you click
 * Place Orders and confirm. "Dry Run" checks the same rows against
 * TastyTrade's dry-run endpoint (buying-power effect, warnings) and sends nothing.
 *
 * ORDER TYPES (column "Order Type")
 *   BTO  Buy to Open    limit debit at Limit Price
 *   STO  Sell to Open   limit credit at Limit Price
 *   BTC  Buy to Close   limit debit
 *   STC  Sell to Close  limit credit
 *   STP  Stop (sell to close a long): triggers at Stop Loss (falls back to Limit Price)
 *   BTO / STO with BOTH Stop Loss and Profit Sell filled become a bracket
 *   (OTOCO: entry, then profit limit + stop, one cancels the other, GTC).
 *   Only one of them filled becomes OTO (entry, then that exit).
 *   Strike "$8C" / "$7.5P" = option; Strike empty = stock.
 *
 * Status flow: Review -> Sent | Rejected | Error | CHECK, then Sent -> Filled / In Position / Closed / Cancelled ...
 *   Any Status other than Review (Draft, Hold, Sent, Filled ...) is never sent. Set a row to Draft to keep it out of the next Place Orders.
 *   then "Refresh Order Status" updates Sent rows to Filled / Cancelled / ...
 *   CHECK = TastyTrade did not answer clearly: look at TastyTrade before re-sending.
 * ============================================================================
 */

const TX_CONFIG = {
  sheet: 'Auto_Trade',
  readyStatus: 'Review',   // ONLY rows with this Status are sent; once sent the Status changes, so a row can never go out twice
  maxLots: 10,             // per order
  maxOrderValue: 3000,     // $ cost cap for a BTO (limit x 100 x lots; stock: limit x shares)
  maxOrdersPerRun: 10,
  entryTif: 'Day',
  exitTif: 'GTC',
  askSlackPct: 25,         // BTO limit may not exceed ask by more than this % (typo guard; only when a live quote exists)
  headers: ['Rank', 'Ticker', 'Expiry', 'Strike', 'Order Type', '# Lot', 'Limit Price', 'Stop Loss', 'Profit Sell', 'Status'],
  idHeader: 'Order ID',
  resultHeader: 'Result',
  firstExtraCol: 14        // N: columns K-M are left alone (your L1:L2 list lives there)
};

const TX_TYPES = {
  BTO: { action: 'Buy to Open', effect: 'Debit', close: 'STC' },
  STO: { action: 'Sell to Open', effect: 'Credit', close: 'BTC' },
  BTC: { action: 'Buy to Close', effect: 'Debit' },
  STC: { action: 'Sell to Close', effect: 'Credit' },
  STP: { action: 'Sell to Close', effect: 'Credit' }
};
const TX_TERMINAL = ['Closed', 'Filled', 'Cancelled', 'Canceled', 'Rejected', 'Expired', 'Removed', 'Error'];

function txAddMenu_() {
  SpreadsheetApp.getUi().createMenu('🚀 Auto Trade')
    .addItem('Set Up Auto_Trade Sheet', 'txSetupSheet')
    .addSeparator()
    .addItem('Dry Run (check Review rows, sends nothing)', 'dryRunTradesFromSheet')
    .addItem('Place Orders (Review rows)', 'placeTradesFromSheet')
    .addItem('Refresh Order Status', 'refreshOrderStatus')
    .addItem('▶ Start Auto-Refresh (every 5 min)', 'txStartRefresh')
    .addItem('■ Stop Auto-Refresh', 'txStopRefresh')
    .addItem('Cancel Order of Selected Row', 'txCancelSelected')
    .addSeparator()
    .addItem('Set Account Number…', 'txSetAccount')
    .addItem('Check Token Permissions', 'txCheckToken')
    .addToUi();
}

/* ------------------------------------------------------------------ pure helpers */

function txNorm_(h) { return String(h || '').toLowerCase().replace(/[^a-z#]/g, ''); }

function txHeaderMap_(sheet) {
  const m = {};
  if (sheet.getLastColumn() < 1) return {};
  sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0].forEach(function (h, i) { const k = txNorm_(h); if (k && !m[k]) m[k] = i + 1; });
  return { rank: m.rank, ticker: m.ticker, expiry: m.expiry, strike: m.strike, type: m.ordertype, lots: m['#lot'] || m.lots || m.lot,
    limit: m.limitprice || m.limit, stop: m.stoploss, profit: m.profitsell, status: m.status, id: m.orderid, result: m.result };
}

// "$8C" "7.5p" "$180P" -> { strike, cp } or null
function txParseStrike_(v) {
  const m = String(v == null ? '' : v).trim().match(/^\$?\s*(\d+(?:\.\d+)?)\s*([CcPp])$/);
  return m ? { strike: parseFloat(m[1]), cp: m[2].toUpperCase() } : null;
}

// yymmdd from a Date (formatted in the sheet's own time zone) or a yyyy-mm-dd / m/d/yyyy string
function txYymmdd_(v, tz) {
  let y, mo, d;
  if (v instanceof Date) {
    // a date cell is midnight in the sheet's own zone (04:00-08:00 UTC for US zones, 00:00 for GMT) or noon UTC when this script wrote it;
    // +6h then reading the UTC date gives the right calendar day for all of those without asking for the sheet's time zone
    const u = new Date(v.getTime() + 6 * 3600000); y = u.getUTCFullYear(); mo = u.getUTCMonth() + 1; d = u.getUTCDate();
  } else {
    const s = String(v || '').trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/))) { mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += 2000; }
    else return null;
  }
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return { yymmdd: String(y).slice(2) + pad(mo) + pad(d), ymd: y + '-' + pad(mo) + '-' + pad(d) };
}

function txOcc_(ticker, yymmdd, cp, strike) {
  return String(ticker).toUpperCase().padEnd(6, ' ') + yymmdd + cp + String(Math.round(strike * 1000)).padStart(8, '0');
}

function txPx_(n) { return (Math.round(n * 100) / 100).toFixed(2); }

// Turns one sheet row into a validated order spec, or { error }. todayYmd is injected so this stays testable.
function txParseRow_(r, cfg, tz, todayYmd) {
  const type = String(r.type || '').trim().toUpperCase();
  const T = TX_TYPES[type];
  if (!T) return { error: 'Order Type must be BTO, STO, BTC, STC or STP (got "' + r.type + '")' };
  const ticker = String(r.ticker || '').trim().toUpperCase();
  if (!/^[A-Z.\/]{1,10}$/.test(ticker)) return { error: 'bad ticker' };
  const qty = Number(r.lots);
  if (!(qty >= 1) || qty !== Math.floor(qty)) return { error: '# Lot must be a whole number >= 1' };
  if (qty > cfg.maxLots) return { error: '# Lot ' + qty + ' is over the cap of ' + cfg.maxLots + ' (TX_CONFIG.maxLots)' };
  let symbol = ticker, instrument = 'Equity', mult = 1, occ = null;
  if (String(r.strike || '').trim() !== '') {
    const s = txParseStrike_(r.strike);
    if (!s) return { error: 'Strike must look like $8C or $7.5P (got "' + r.strike + '")' };
    const e = txYymmdd_(r.expiry, tz);
    if (!e) return { error: 'Expiry is not a date' };
    if (e.ymd < todayYmd) return { error: 'Expiry ' + e.ymd + ' is in the past' };
    symbol = txOcc_(ticker, e.yymmdd, s.cp, s.strike); instrument = 'Equity Option'; mult = 100; occ = symbol;
  }
  const limit = Number(r.limit), stop = Number(r.stop), profit = Number(r.profit);
  const out = { type: type, ticker: ticker, symbol: symbol, instrument: instrument, qty: qty, mult: mult, occ: occ, limit: limit, stop: stop, profit: profit };
  if (type === 'STP') {
    out.trigger = stop > 0 ? stop : limit;
    if (!(out.trigger > 0)) return { error: 'STP needs a trigger in Stop Loss' };
    return out;
  }
  if (!(limit > 0)) return { error: 'Limit Price is required' };
  if (type === 'BTO' && limit * mult * qty > cfg.maxOrderValue) return { error: 'cost $' + Math.round(limit * mult * qty) + ' is over the cap of $' + cfg.maxOrderValue + ' (TX_CONFIG.maxOrderValue)' };
  if (T.close) {
    const hasStop = stop > 0, hasProfit = profit > 0;
    // exits must sit on the right side of the entry, otherwise TastyTrade rejects (or worse, fills) them
    if (type === 'BTO') {
      if (hasStop && stop >= limit) return { error: 'Stop Loss ' + stop + ' must be BELOW the buy limit ' + limit };
      if (hasProfit && profit <= limit) return { error: 'Profit Sell ' + profit + ' must be ABOVE the buy limit ' + limit };
    } else {
      if (hasStop && stop <= limit) return { error: 'Stop Loss ' + stop + ' must be ABOVE the sell limit ' + limit };
      if (hasProfit && profit >= limit) return { error: 'Profit Sell ' + profit + ' must be BELOW the sell limit ' + limit };
    }
    out.hasStop = hasStop; out.hasProfit = hasProfit;
  }
  return out;
}

// Spec -> { path, body } for POST /accounts/{n}/<path>
function txBuildOrder_(o, cfg, extId) {
  const T = TX_TYPES[o.type];
  const leg = function (action) { return [{ 'instrument-type': o.instrument, symbol: o.symbol, quantity: o.qty, action: action }]; };
  if (o.type === 'STP') {
    return { path: 'orders', body: { 'external-identifier': extId, 'time-in-force': cfg.exitTif, 'order-type': 'Stop', 'stop-trigger': txPx_(o.trigger), legs: leg(T.action) } };
  }
  const entry = { 'time-in-force': cfg.entryTif, 'order-type': 'Limit', price: txPx_(o.limit), 'price-effect': T.effect, legs: leg(T.action) };
  const kids = [];
  if (T.close) {
    const C = TX_TYPES[T.close];
    if (o.hasProfit) kids.push({ 'time-in-force': cfg.exitTif, 'order-type': 'Limit', price: txPx_(o.profit), 'price-effect': C.effect, legs: leg(C.action) });
    if (o.hasStop) kids.push({ 'time-in-force': cfg.exitTif, 'order-type': 'Stop', 'stop-trigger': txPx_(o.stop), legs: leg(C.action) });
  }
  if (!kids.length) { entry['external-identifier'] = extId; return { path: 'orders', body: entry }; }
  return { path: 'complex-orders', body: { type: kids.length === 2 ? 'OTOCO' : 'OTO', 'trigger-order': entry, orders: kids } };
}

/* ------------------------------------------------------------------ TastyTrade I/O */

function txFetch_(method, path, body) {
  const doCall = function (token) {
    const opt = { method: method, muteHttpExceptions: true, headers: { Authorization: 'Bearer ' + token, 'User-Agent': TASTY_USER_AGENT, Accept: 'application/json' } };
    if (body) { opt.contentType = 'application/json'; opt.payload = JSON.stringify(body); }
    return UrlFetchApp.fetch('https://api.tastyworks.com' + path, opt);
  };
  let token = getTastyTradeAccessToken_();
  if (!token) return { code: 0, error: 'no TastyTrade token (check TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN in Script Properties)' };
  let resp = doCall(token);
  if (resp.getResponseCode() === 401) {
    CacheService.getScriptCache().remove('TASTY_ACCESS_TOKEN');
    const t2 = getTastyTradeAccessToken_();
    if (t2 && t2 !== token) resp = doCall(t2);
  }
  let json = null; try { json = JSON.parse(resp.getContentText()); } catch (e) {}
  return { code: resp.getResponseCode(), json: json, text: resp.getContentText() };
}

function txErrText_(res) {
  if (res.error) return res.error;
  const e = res.json && res.json.error;
  if (e) {
    const sub = (e.errors || []).map(function (x) { return x.message || x.code; }).join('; ');
    return 'HTTP ' + res.code + ': ' + (e.message || e.code || '') + (sub ? ' — ' + sub : '') + (res.code === 403 ? '  [run Auto Trade > Check Token Permissions]' : '');
  }
  return 'HTTP ' + res.code + ': ' + String(res.text || '').substring(0, 200);
}


function txAccount_(ui) {
  const props = PropertiesService.getScriptProperties();
  let acct = props.getProperty('TASTY_ACCOUNT');
  if (acct) return acct;
  const res = txFetch_('get', '/customers/me/accounts');
  if (res.code !== 200) throw new Error('could not list accounts — ' + txErrText_(res));
  const list = ((res.json && res.json.data && res.json.data.items) || []).map(function (i) { return (i.account || i)['account-number']; }).filter(Boolean);
  if (list.length === 1) { props.setProperty('TASTY_ACCOUNT', list[0]); return list[0]; }
  if (!list.length) throw new Error('TastyTrade returned no accounts');
  throw new Error('several accounts (' + list.join(', ') + ') — use Auto Trade > Set Account Number');
}

// Shows what TastyTrade says about the token this script is actually using (no secrets shown): which permissions it carries.
function txCheckToken() {
  const ui = tryGetUi_(), props = PropertiesService.getScriptProperties();
  CacheService.getScriptCache().remove('TASTY_ACCESS_TOKEN');
  const secret = props.getProperty('TASTY_CLIENT_SECRET'), refresh = props.getProperty('TASTY_REFRESH_TOKEN');
  if (!secret || !refresh) { notify_(ui, 'Token check', 'TASTY_CLIENT_SECRET or TASTY_REFRESH_TOKEN is not set in Script Properties.'); return; }
  const resp = UrlFetchApp.fetch('https://api.tastyworks.com/oauth/token', { method: 'post', contentType: 'application/json', headers: { 'User-Agent': TASTY_USER_AGENT },
    payload: JSON.stringify({ grant_type: 'refresh_token', refresh_token: refresh, client_secret: secret }), muteHttpExceptions: true });
  const lines = ['Refresh token in use ends with: ...' + String(refresh).slice(-5), 'Token request: HTTP ' + resp.getResponseCode()];
  let j = null; try { j = JSON.parse(resp.getContentText()); } catch (e) { lines.push(resp.getContentText().substring(0, 200)); }
  if (j) {
    Object.keys(j).forEach(function (k) { if (['access_token', 'refresh_token', 'id_token'].indexOf(k) < 0) lines.push(k + ': ' + JSON.stringify(j[k])); });
    const t = String(j.access_token || '').split('.');
    if (t.length === 3) {
      try {
        const pl = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(t[1].replace(/=+$/, ''))).getDataAsString());
        ['scope', 'scp', 'scopes', 'exp', 'iss'].forEach(function (k) { if (pl[k] !== undefined) lines.push('token ' + k + ': ' + JSON.stringify(pl[k])); });
      } catch (e) { lines.push('(could not read the token contents)'); }
    }
  }
  lines.push('', 'You need "trade" in the scope list. If it only says "read", the refresh token in Script Properties is an old one: create a new grant with trade ticked and paste that token.');
  notify_(ui, 'Token check', lines.join('\n'));
}

function txSetAccount() {
  const ui = SpreadsheetApp.getUi();
  const cur = PropertiesService.getScriptProperties().getProperty('TASTY_ACCOUNT') || '(auto)';
  const r = ui.prompt('TastyTrade account number', 'Orders go to this account. Current: ' + cur + '\nLeave empty to auto-detect (works if you have one account).', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  const v = r.getResponseText().trim();
  if (v) PropertiesService.getScriptProperties().setProperty('TASTY_ACCOUNT', v); else PropertiesService.getScriptProperties().deleteProperty('TASTY_ACCOUNT');
}

/* ------------------------------------------------------------------ sheet */

function txSheet_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(TX_CONFIG.sheet);
  if (!sh) throw new Error('Tab "' + TX_CONFIG.sheet + '" not found — run Auto Trade > Set Up Auto_Trade Sheet');
  return sh;
}

// Creates the tab if missing, adds Order ID / Result headers, dropdowns and formats. Never moves or overwrites your data.
function txSetupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(TX_CONFIG.sheet);
  if (!sh) {
    sh = ss.insertSheet(TX_CONFIG.sheet);
    sh.getRange(1, 1, 1, TX_CONFIG.headers.length).setValues([TX_CONFIG.headers]);
    sh.setFrozenRows(1);
  }
  let m = txHeaderMap_(sh);
  let col = Math.max(sh.getLastColumn() + 1, TX_CONFIG.firstExtraCol);
  [['id', TX_CONFIG.idHeader], ['result', TX_CONFIG.resultHeader]].forEach(function (p) {
    if (m[p[0]]) return;
    sh.getRange(1, col).setValue(p[1]); m[p[0]] = col++;
  });
  const hdr = sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1));
  hdr.setFontWeight('bold').setHorizontalAlignment('center').setFontFamily('Arial').setFontSize(9);
  const n = 300;
  if (m.type) sh.getRange(2, m.type, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['BTO', 'STO', 'BTC', 'STC', 'STP'], true).setAllowInvalid(false).build());
  if (m.status) sh.getRange(2, m.status, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Draft', TX_CONFIG.readyStatus, 'Sent', 'Live', 'In Position', 'Closed', 'Filled', 'Cancel sent', 'Cancelled', 'Rejected', 'Error', 'CHECK'], true).setAllowInvalid(true).build());
  if (m.expiry) sh.getRange(2, m.expiry, n, 1).setNumberFormat('m/d/yyyy');
  ['limit', 'stop', 'profit'].forEach(function (k) { if (m[k]) sh.getRange(2, m[k], n, 1).setNumberFormat('$#,##0.00'); });
  if (m.result) sh.setColumnWidth(m.result, 380);
  notify_(tryGetUi_(), 'Auto_Trade', 'Auto_Trade is ready. Rows with Status "' + TX_CONFIG.readyStatus + '" are what Dry Run / Place Orders send.');
}

function txReadRows_(sh, m) {
  const n = sh.getLastRow() - 1;
  if (n < 1) return [];
  const width = sh.getLastColumn();
  const vals = sh.getRange(2, 1, n, width).getValues();
  return vals.map(function (v, i) {
    const g = function (c) { return c ? v[c - 1] : ''; };
    return { row: i + 2, ticker: g(m.ticker), expiry: g(m.expiry), strike: g(m.strike), type: g(m.type), lots: g(m.lots), limit: g(m.limit),
      stop: g(m.stop), profit: g(m.profit), status: String(g(m.status) || '').trim(), id: String(g(m.id) || '').trim() };
  });
}

function txPut_(sh, row, m, status, id, result) {
  if (status != null && m.status) sh.getRange(row, m.status).setValue(status);
  if (id != null && m.id) sh.getRange(row, m.id).setValue(id);
  if (result != null && m.result) sh.getRange(row, m.result).setValue(result);
}

/* ------------------------------------------------------------------ run */

function dryRunTradesFromSheet() { txRun_(true); }
function placeTradesFromSheet() { txRun_(false); }

function txRun_(dry) {
  const ui = tryGetUi_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) { notify_(ui, 'Auto Trade', 'Another trade run is in progress. Try again in a minute.'); return; }
  try {
    const sh = txSheet_();
    const m = txHeaderMap_(sh);
    const missing = ['ticker', 'strike', 'type', 'lots', 'limit', 'status', 'id', 'result'].filter(function (k) { return !m[k]; });
    if (missing.length) { notify_(ui, 'Auto Trade', 'Missing column(s): ' + missing.join(', ') + '. Run Auto Trade > Set Up Auto_Trade Sheet.'); return; }
    const tz = null;   // not needed: txYymmdd_ reads the UTC calendar day
    const today = Utilities.formatDate(new Date(), 'America/New_York', 'yyyy-MM-dd');
    const ready = txReadRows_(sh, m).filter(function (r) { return r.status.toLowerCase() === TX_CONFIG.readyStatus.toLowerCase() && r.type !== ''; });
    if (!ready.length) { notify_(ui, 'Auto Trade', 'No rows with Status "' + TX_CONFIG.readyStatus + '".'); return; }

    const specs = [], bad = [];
    ready.slice(0, TX_CONFIG.maxOrdersPerRun).forEach(function (r) {
      const o = txParseRow_(r, TX_CONFIG, tz, today);
      if (o.error) { bad.push(r.row); txPut_(sh, r.row, m, 'Error', '', o.error); return; }
      o.row = r.row; specs.push(o);
    });
    if (ready.length > TX_CONFIG.maxOrdersPerRun) bad.push('(' + (ready.length - TX_CONFIG.maxOrdersPerRun) + ' more Review rows left for the next run)');

    const token = specs.length ? getTastyTradeAccessToken_() : null;
    if (specs.length && !token) { notify_(ui, 'Auto Trade', 'No TastyTrade token — nothing sent.'); return; }
    // typo guard against live quotes: a BTO limit far above the ask, or an STO limit far below the bid
    const optSyms = specs.filter(function (o) { return o.occ && (o.type === 'BTO' || o.type === 'STO'); }).map(function (o) { return o.occ; });
    const q = optSyms.length ? fetchTastyMarketDataBatch_(optSyms, token) : {};
    const ok = [];
    specs.forEach(function (o) {
      const k = o.occ && q[o.occ];
      if (k && o.type === 'BTO' && k.ask > 0 && o.limit > k.ask * (1 + TX_CONFIG.askSlackPct / 100) + 0.05) { txPut_(sh, o.row, m, 'Error', '', 'limit ' + o.limit + ' is far above the ask ' + k.ask + ' — typo?'); return; }
      if (k && o.type === 'STO' && k.bid > 0 && o.limit < k.bid * (1 - TX_CONFIG.askSlackPct / 100) - 0.05) { txPut_(sh, o.row, m, 'Error', '', 'limit ' + o.limit + ' is far below the bid ' + k.bid + ' — typo?'); return; }
      o.quote = k ? (k.bid + ' x ' + k.ask) : '';
      ok.push(o);
    });
    if (!ok.length) { notify_(ui, 'Auto Trade', 'No valid rows. See the Result column for what to fix.'); return; }

    if (!dry && ui) {
      const lines = ok.map(function (o) {
        return 'row ' + o.row + ': ' + o.type + ' ' + o.qty + ' ' + o.symbol.replace(/\s+/g, ' ') + ' @ ' + (o.type === 'STP' ? 'stop ' + txPx_(o.trigger) : txPx_(o.limit)) +
          (o.hasStop || o.hasProfit ? '  [stop ' + (o.hasStop ? txPx_(o.stop) : '-') + ' / profit ' + (o.hasProfit ? txPx_(o.profit) : '-') + ']' : '') + (o.quote ? '   (mkt ' + o.quote + ')' : '');
      });
      const a = ui.alert('Place ' + ok.length + ' REAL order(s) on TastyTrade?', lines.join('\n'), ui.ButtonSet.YES_NO);
      if (a !== ui.Button.YES) { notify_(ui, 'Auto Trade', 'Cancelled — nothing sent.'); return; }
    }

    const acct = txAccount_(ui);
    const stamp = Utilities.formatDate(new Date(), 'America/New_York', 'MMdd-HHmmss');
    const summary = [];
    ok.forEach(function (o) {
      // last look at the cell: if it is no longer "Review" (you changed it while the dialog was open) it is not sent
      if (String(sh.getRange(o.row, m.status).getValue()).trim().toLowerCase() !== TX_CONFIG.readyStatus.toLowerCase()) { summary.push('row ' + o.row + ' skipped: Status changed'); return; }
      const built = txBuildOrder_(o, TX_CONFIG, 'AT-' + o.row + '-' + stamp);
      const path = '/accounts/' + encodeURIComponent(acct) + '/' + built.path + (dry ? '/dry-run' : '');
      let res;
      try { res = txFetch_('post', path, built.body); } catch (e) { res = { code: 0, error: String(e && e.message || e), unknown: true }; }
      const d = res.json && res.json.data;
      if (res.code >= 200 && res.code < 300) {
        if (dry) {
          const bp = d && d['buying-power-effect'];
          const warns = ((d && d.warnings) || []).map(function (w) { return w.message || w.code; }).join('; ');
          const msg = 'DRY OK' + (bp ? ' — BP ' + (bp['change-in-buying-power-effect'] || '') + ' ' + (bp['change-in-buying-power'] || '') : '') + (warns ? ' — warn: ' + warns : '');
          txPut_(sh, o.row, m, null, null, msg); summary.push('row ' + o.row + ' ' + msg);
        } else {
          const cx = d && d['complex-order'];
          const id = cx ? 'C:' + cx.id : (d && d.order && d.order.id);
          const st = cx ? (cx['trigger-order'] && cx['trigger-order'].status) : (d && d.order && d.order.status);
          txPut_(sh, o.row, m, 'Sent', String(id || ''), (st || 'Received') + ' ' + Utilities.formatDate(new Date(), 'America/New_York', 'HH:mm'));
          summary.push('row ' + o.row + ' sent');
        }
      } else if (res.code >= 400 && res.code < 500) {
        const t = txErrText_(res);
        txPut_(sh, o.row, m, dry ? null : 'Rejected', null, (dry ? 'DRY FAIL — ' : '') + t); summary.push('row ' + o.row + ' ' + t);
      } else {
        // 5xx / timeout / exception: the order may or may not exist
        const t = txErrText_(res);
        txPut_(sh, o.row, m, dry ? null : 'CHECK', null, (dry ? 'DRY ' : '') + 'no clear answer (' + t + ') — look in TastyTrade before re-sending'); summary.push('row ' + o.row + ' UNSURE ' + t);
      }
    });
    const msg = (dry ? 'Dry run' : 'Orders') + ' — ' + summary.join(' | ') + (bad.length ? '\nNot sent: ' + bad.join(', ') : '');
    logToSheet_('Auto Trade ' + msg.replace(/\n/g, ' '));
    notify_(ui, 'Auto Trade', msg);
  } catch (e) {
    logToSheet_('Auto Trade failed: ' + (e && e.message ? e.message : e));
    notify_(ui, 'Auto Trade', 'Failed: ' + (e && e.message ? e.message : e));
  } finally { lock.releaseLock(); }
}

/* ------------------------------------------------------------------ status / cancel */

function txOrderPath_(acct, id) {
  return '/accounts/' + encodeURIComponent(acct) + (id.indexOf('C:') === 0 ? '/complex-orders/' + id.slice(2) : '/orders/' + id);
}

function txFillText_(order) {
  let q = 0, v = 0;
  ((order && order.legs) || []).forEach(function (l) { (l.fills || []).forEach(function (f) { const n = Number(f.quantity), p = Number(f['fill-price']); if (n > 0 && p >= 0) { q += n; v += n * p; } }); });
  return q ? ' @ ' + (v / q).toFixed(2) : '';
}

// Status of a bracket (complex order) from TastyTrade's reply: entry first, then the exits
function txComplexStatus_(d) {
  const trig = d['trigger-order'] || {};
  const kids = d.orders || [];
  const kidDone = ['Filled', 'Cancelled', 'Canceled', 'Rejected', 'Expired', 'Removed'];
  const trigSt = trig.status || d.status || '';
  if (trigSt !== 'Filled') return { status: trigSt || '?', text: 'entry ' + (trigSt || '?') };
  const open = kids.filter(function (k) { return kidDone.indexOf(k.status) < 0; });
  const filled = kids.filter(function (k) { return k.status === 'Filled'; });
  const entry = 'entry filled' + txFillText_(trig);
  if (open.length) return { status: 'In Position', text: entry + ' | exits: ' + kids.map(function (k) { return k.status; }).join(', ') };
  if (filled.length) return { status: 'Closed', text: entry + ' | exit filled' + txFillText_(filled[0]) };
  return { status: 'Filled', text: entry };
}

// One pass over the open orders. Returns { open, checked, changes[] }. Writes Status + Result for each.
function txRefresh_() {
  const sh = txSheet_(), m = txHeaderMap_(sh);
  if (!m.id || !m.status || !m.result) return { error: 'Run Auto Trade > Set Up Auto_Trade Sheet first.' };
  const rows = txReadRows_(sh, m).filter(function (r) { return r.id && TX_TERMINAL.indexOf(r.status) < 0; });
  const out = { open: rows.length, checked: 0, changes: [] };
  if (!rows.length) return out;
  const acct = txAccount_();
  const hhmm = Utilities.formatDate(new Date(), 'America/New_York', 'HH:mm');
  rows.forEach(function (r) {
    const res = txFetch_('get', txOrderPath_(acct, r.id));
    const d = res.json && res.json.data;
    if (res.code !== 200 || !d) { txPut_(sh, r.row, m, null, null, 'status check failed: ' + txErrText_(res) + ' ' + hhmm); return; }
    let st, text;
    if (r.id.indexOf('C:') === 0) { const c = txComplexStatus_(d); st = c.status; text = c.text; }
    else { st = d.status || r.status; text = st + txFillText_(d); }
    txPut_(sh, r.row, m, st, null, text + ' ' + hhmm);
    out.checked++;
    if (st !== r.status) out.changes.push({ row: r.row, ticker: String(r.ticker).toUpperCase(), from: r.status, to: st, text: text });
    Utilities.sleep(120);
  });
  return out;
}

function refreshOrderStatus() {
  const ui = tryGetUi_();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) return;
  try {
    const r = txRefresh_();
    if (r.error) { notify_(ui, 'Auto Trade', r.error); return; }
    if (!r.open) { notify_(ui, 'Auto Trade', 'No open orders to refresh.'); return; }
    notify_(ui, 'Auto Trade', 'Refreshed ' + r.checked + ' of ' + r.open + ' open order(s).' + (r.changes.length ? '\n' + r.changes.map(function (c) { return c.ticker + ': ' + c.from + ' -> ' + c.to; }).join('\n') : ''));
  } catch (e) { notify_(ui, 'Auto Trade', 'Failed: ' + (e && e.message ? e.message : e)); }
  finally { lock.releaseLock(); }
}

// Timer entry point: weekdays 09:25-16:15 ET, only does anything when an order is open, alerts + logs only on a change
function txRefreshTick_() {
  const now = new Date();
  if (['6', '7'].indexOf(Utilities.formatDate(now, 'America/New_York', 'u')) >= 0) return;
  const hm = Utilities.formatDate(now, 'America/New_York', 'HH:mm').split(':'), mins = +hm[0] * 60 + +hm[1];
  if (mins < 565 || mins > 975) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const r = txRefresh_();
    if (r.error || !r.changes || !r.changes.length) return;
    const msg = r.changes.map(function (c) { return c.ticker + ' ' + c.from + ' -> ' + c.to + (c.text ? ' (' + c.text + ')' : ''); }).join('\n');
    logToSheet_('Auto Trade status: ' + msg.replace(/\n/g, ' | '));
    const cfg = getAlertConfig_();
    if (cfg.ready) sendPhoneAlert_(cfg, 'Auto Trade: ' + r.changes.map(function (c) { return c.ticker + ' ' + c.to; }).join(', '), msg, true);
  } catch (e) { logToSheet_('Auto Trade status refresh failed: ' + (e && e.message ? e.message : e)); }
  finally { lock.releaseLock(); }
}

function txStartRefresh() {
  txStopRefresh(true);
  ScriptApp.newTrigger('txRefreshTick_').timeBased().everyMinutes(5).create();
  notify_(tryGetUi_(), 'Auto Trade', 'Order status now refreshes every 5 minutes on weekdays 09:25-16:15 ET (only when an order is open). Fills, exits and rejections are written to the sheet and sent to your phone alert.');
}
function txStopRefresh(silent) {
  let n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) { if (t.getHandlerFunction() === 'txRefreshTick_') { ScriptApp.deleteTrigger(t); n++; } });
  if (silent !== true) notify_(tryGetUi_(), 'Auto Trade', n ? 'Auto-refresh stopped.' : 'Auto-refresh was not running.');
}

function txCancelSelected() {
  const ui = SpreadsheetApp.getUi();
  try {
    const sh = txSheet_(), m = txHeaderMap_(sh);
    if (SpreadsheetApp.getActiveSheet().getName() !== sh.getName()) { ui.alert('Select a row on the ' + sh.getName() + ' tab first.'); return; }
    const row = sh.getActiveRange().getRow();
    const id = String(sh.getRange(row, m.id).getValue() || '').trim();
    if (row < 2 || !id) { ui.alert('That row has no Order ID.'); return; }
    if (ui.alert('Cancel order ' + id + ' (row ' + row + ')?', ui.ButtonSet.YES_NO) !== ui.Button.YES) return;
    const res = txFetch_('delete', txOrderPath_(txAccount_(ui), id));
    if (res.code >= 200 && res.code < 300) { txPut_(sh, row, m, 'Cancel sent', null, 'Cancel requested ' + Utilities.formatDate(new Date(), 'America/New_York', 'HH:mm') + ' — Refresh Order Status to confirm'); ui.alert('Cancel requested.'); }
    else ui.alert('Cancel failed: ' + txErrText_(res));
  } catch (e) { ui.alert('Failed: ' + (e && e.message ? e.message : e)); }
}