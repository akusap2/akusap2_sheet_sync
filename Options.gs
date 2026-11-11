/**
 * Option.gs  --  "Chain" tab for the Options Trading workbook
 * Data source: TastyTrade REST API. Apps Script only: no Cloud Function redeploy.
 *
 * ONE-TIME SETUP
 *  1. Project Settings > Script Properties. Add:
 *       TASTY_CLIENT_SECRET, TASTY_REFRESH_TOKEN  (already set if Momentum.gs works)
 *     (never paste these into the sheet or into this file)
 *  2. Paste this whole file into a NEW file named Option.gs and save.
 *  3. In the editor pick the function chainSetup and click Run (authorize when asked).
 *     It adds the "Chain" menu and writes the header row.
 *  4. Back in the sheet: Chain > Refresh.
 *
 * Every name here starts with "chain" / "OPTCHAIN" so it cannot collide with your
 * other script files, and no onOpen() is defined, so your existing menus are untouched.
 *
 * SHEET LAYOUT (tab "Chain")
 *   Inputs  rows 3-17, columns A-H:
 *           Ticker | Type (CALL/PUT) | Min Delta | Max Delta | Min Days | Max Days | Top N per expiry | Max Rows
 *   Market  V2 VIX | V3 SPY | V4 QQQ | V5 10Y yield % | V6 updated time
 *   Status  A18 "Last run:" | B18 time | C18 status message
 *   Results row 20 = headers, rows 21+ = data, columns A-T:
 *           Ticker | Expiry | Days | Strike | Mid | Extrinsic $ | Stock | Extrinsic % | Delta | IV % |
 *           Bid | Ask | Spread $ | Volume | Open Int | Theta | Vega | Gamma
 *   Columns X onward (spread calculator) are never touched.
 */

var OPTCHAIN = {
  SHEET: 'Chain',
  INPUT_FIRST_ROW: 3,
  INPUT_ROWS: 15,
  INPUT_COLS: 8,
  STATUS_ROW: 18,
  HEADER_ROW: 20,
  FIRST_ROW: 21,
  CLEAR_COLS: 23,                       // clears A:W below the header; X+ (calculator) is left alone
  MKT: { VIX: 'V2', SPY: 'V3', QQQ: 'V4', TNX: 'V5', STAMP: 'V6' },
  BASES: ['https://api.tastyworks.com', 'https://api.tastytrade.com'],
  DEFAULT_RATE: 0.04,                   // used if the 10Y yield cannot be read
  DIV: { SPY: 0.012, QQQ: 0.006, IWM: 0.012, DIA: 0.015 },
  DEFAULT_DIV: 0.01,
  ROI: { DRIFT: 0.08, Z: [-0.6745, 0, 0.6745], MIN_OI: 100, MAX_SPREAD_CALL: 0.03, MAX_SPREAD_PUT: 0.10,
         EDGES_CALL: [420, 600], EDGES_PUT: [35, 47] },
  MAX_SYMBOLS: 3000,                    // safety cap on option symbols requested per ticker
  HEADERS: ['Ticker', 'Expiry', 'Days', 'Strike', 'Mid', 'Extrinsic $', 'Stock', 'Extrinsic %', 'Delta', 'IV %',
            'Bid', 'Ask', 'Spread $', 'Volume', 'Open Int', 'Theta', 'Vega', 'Gamma', 'Yield %', 'Ann. Yield %']
};

/* ---------------------------------------------------------------- menu / setup */

function chainSetup() {
  const ss = SpreadsheetApp.getActive();
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'chainAddMenu') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('chainAddMenu').forSpreadsheet(ss).onOpen().create();
  chainAddMenu();
  const sh = ss.getSheetByName(OPTCHAIN.SHEET);
  if (sh) chainWriteHeaders_(sh);
  ss.toast('Chain menu added. Use Chain > Refresh.', 'Chain', 6);
}

function chainAddMenu() {
  SpreadsheetApp.getUi().createMenu('Chain')
    .addItem('Refresh', 'chainRefresh')
    .addItem('Auto-refresh ON (every 15 min, market hours)', 'chainAutoOn')
    .addItem('Auto-refresh OFF', 'chainAutoOff')
    .addToUi();
}

function chainAutoOn() {
  chainAutoOff();
  ScriptApp.newTrigger('chainRefreshAuto').timeBased().everyMinutes(15).create();
  SpreadsheetApp.getActive().toast('Auto-refresh ON: every 15 min, Mon-Fri 9:25-16:10 ET.', 'Chain', 6);
}

function chainAutoOff() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'chainRefreshAuto') ScriptApp.deleteTrigger(t);
  });
}

function chainRefresh() {
  chainRun_(false);
}

function chainRefreshAuto() {
  const p = Utilities.formatDate(new Date(), 'America/New_York', 'u HH mm').split(' ').map(Number);
  const mins = p[1] * 60 + p[2];
  if (p[0] > 5 || mins < 565 || mins > 970) return;   // Mon-Fri, 9:25 to 16:10 ET only
  chainRun_(true);
}

/* ---------------------------------------------------------------- main run */

function chainRun_(isAuto) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(OPTCHAIN.SHEET);
  if (!sh) throw new Error('Tab "' + OPTCHAIN.SHEET + '" not found');
  if (!isAuto) ss.toast('Refreshing chain...', 'Chain', 5);

  const notes = [];
  let token;
  try {
    token = chainToken_();
  } catch (e) {
    chainStatus_(sh, 'ERROR: ' + e.message);
    return;
  }

  const rate = chainMarket_(sh, token, notes);
  const inputs = sh.getRange(OPTCHAIN.INPUT_FIRST_ROW, 1, OPTCHAIN.INPUT_ROWS, OPTCHAIN.INPUT_COLS).getValues();
  let rows = [];
  let allCands = [];
  let greeksComputed = false;
  let oiMissing = false;

  const runStart = Date.now();
  inputs.forEach(function (r) {
    const ticker = String(r[0] || '').toUpperCase().trim();
    if (!ticker) return;
    if (Date.now() - runStart > 270000) { notes.push(ticker + ': skipped (time budget)'); return; }   // stay under the 6-min limit
    try {
      const res = chainOne_(token, ticker, r, rate);
      rows = rows.concat(res.rows);
      allCands = allCands.concat(res.cands);
      if (res.computed) greeksComputed = true;
      if (res.oiMissing) oiMissing = true;
      if (!res.rows.length) notes.push(ticker + ': no strikes matched the filters');
    } catch (e) {
      notes.push(ticker + ': ' + e.message);
    }
  });

  chainWriteHeaders_(sh);
  const total = Math.max(sh.getMaxRows() - OPTCHAIN.FIRST_ROW + 1, 1);
  sh.getRange(OPTCHAIN.FIRST_ROW, 1, total, OPTCHAIN.CLEAR_COLS).clearContent();
  sh.getRange(OPTCHAIN.FIRST_ROW, 1, total, OPTCHAIN.HEADERS.length).setBackground(null);   // clear old highlights
  chainTypeDropdown_(sh);
  if (rows.length) {
    const rng = sh.getRange(OPTCHAIN.FIRST_ROW, 1, rows.length, OPTCHAIN.HEADERS.length);
    rng.setValues(rows);
    chainFormat_(sh, rows.length, rows);
    chainHighlight_(sh, rows);
  }
  chainTop_(sh, allCands);

  const parts = ['OK: ' + rows.length + ' rows'];
  if (greeksComputed) parts.push('Greeks computed by script (Black-Scholes), not broker values');
  if (oiMissing) parts.push('Open interest not returned by API, ranked by tightest spread');
  notes.forEach(function (n) { parts.push(n); });
  chainStatus_(sh, parts.join(' | '));
}

/* ---------------------------------------------------------------- one ticker */

function chainOne_(token, ticker, r, rate) {
  const isPut = String(r[1]).toUpperCase().trim() === 'PUT';
  const minD = chainNum_(r[2], 0), maxD = chainNum_(r[3], 1);
  const minDays = chainNum_(r[4], 0), maxDays = chainNum_(r[5], 100000);
  const topN = Math.max(1, Math.round(chainNum_(r[6], 6)));
  const maxRows = Math.max(1, Math.round(chainNum_(r[7], 40)));
  const div = OPTCHAIN.DIV[ticker] !== undefined ? OPTCHAIN.DIV[ticker] : OPTCHAIN.DEFAULT_DIV;

  const spot = chainSpot_(token, ticker);
  const chain = chainGet_('/option-chains/' + encodeURIComponent(ticker) + '/nested', token);

  const wanted = [];
  ((chain.data && chain.data.items) || []).forEach(function (item) {
    (item.expirations || []).forEach(function (e) {
      const expStr = e['expiration-date'];
      let days = Number(e['days-to-expiration']);
      if (!isFinite(days)) days = Math.round((Date.parse(expStr) - Date.now()) / 86400000);
      if (days < minDays || days > maxDays || days <= 0) return;
      (e.strikes || []).forEach(function (s) {
        const k = Number(s['strike-price']);
        const sym = isPut ? s.put : s.call;
        if (!sym || !isFinite(k)) return;
        // rough pre-filter: only strikes that can plausibly sit inside a 0.6-0.9 delta window
        const otm = maxD <= 0.5;   // low-delta request (CSP / covered call) -> look at OTM strikes
        const ok = isPut
          ? (otm ? (k <= spot * 1.02 && k >= spot * 0.7) : (k >= spot * 0.98 && k <= spot * 1.6))
          : (otm ? (k >= spot * 0.98 && k <= spot * 1.3) : (k <= spot * 1.02 && k >= spot * 0.5));
        if (ok) wanted.push({ sym: sym, exp: expStr, days: days, k: k });
      });
    });
  });

  if (wanted.length > OPTCHAIN.MAX_SYMBOLS) {
    throw new Error(wanted.length + ' strikes match; narrow Min/Max Days');
  }

  const quotes = chainQuotes_(token, wanted.map(function (w) { return w.sym; }));
  const byExpiry = {};
  const cands = [];
  let computed = false, anyOi = false;

  wanted.forEach(function (w) {
    const m = quotes[chainKey_(w.sym)];
    if (!m) return;
    const bid = chainPick_(m, ['bid']), ask = chainPick_(m, ['ask']);
    if (!(bid > 0 && ask > 0)) return;
    const mid = (bid + ask) / 2;

    let delta = chainPick_(m, ['delta']);
    let iv = chainPick_(m, ['volatility', 'implied-volatility', 'iv']);
    let theta = chainPick_(m, ['theta']);
    let vega = chainPick_(m, ['vega']);
    let gamma = chainPick_(m, ['gamma']);
    if (isFinite(iv) && iv > 3) iv = iv / 100;

    if (![delta, iv, theta, vega, gamma].every(isFinite)) {
      const g = chainGreeks_(isPut, spot, w.k, w.days / 365, rate, div, mid);
      if (!g) return;
      if (!isFinite(delta)) { delta = g.delta; computed = true; }
      if (!isFinite(iv)) iv = g.iv;
      if (!isFinite(theta)) theta = g.theta;
      if (!isFinite(vega)) vega = g.vega;
      if (!isFinite(gamma)) gamma = g.gamma;
    }

    const absDelta = Math.abs(delta);
    if (!(absDelta >= minD && absDelta <= maxD)) return;

    const intrinsic = isPut ? Math.max(w.k - spot, 0) : Math.max(spot - w.k, 0);
    const extr = mid - intrinsic;
    const vol = chainPick_(m, ['volume', 'day-volume']);
    const oi = chainPick_(m, ['open-interest', 'openInterest']);
    if (oi > 0) anyOi = true;

    const row = [ticker, w.exp, w.days, w.k, mid, extr, spot, extr / mid, absDelta, iv * 100,
                 bid, ask, ask - bid, isFinite(vol) ? vol : 0, isFinite(oi) ? oi : 0, theta, vega, gamma,
                 mid / (isPut ? w.k : spot), (mid / (isPut ? w.k : spot)) * 365 / w.days];
    const rr = chainRoi_(isPut, spot, w.k, mid, w.days, iv);
    const maxSp = isPut ? OPTCHAIN.ROI.MAX_SPREAD_PUT : OPTCHAIN.ROI.MAX_SPREAD_CALL;
    cands.push({
      liquid: (isFinite(oi) ? oi : 0) >= OPTCHAIN.ROI.MIN_OI && (ask - bid) / mid <= maxSp,
      ann: rr.ann, rr: rr, isPut: isPut, label: ticker + (isPut ? ' P' : ' C'),
      exp: w.exp, days: w.days, k: w.k, mid: mid, delta: absDelta, oi: isFinite(oi) ? oi : 0
    });
    (byExpiry[w.exp] = byExpiry[w.exp] || []).push({ row: row, oi: isFinite(oi) ? oi : 0, vol: isFinite(vol) ? vol : 0, sp: (ask - bid) / mid });
  });

  // per expiry: keep the Top N by open interest (or tightest spread if OI is not available)
  let picked = [];
  Object.keys(byExpiry).forEach(function (exp) {
    const list = byExpiry[exp];
    list.sort(function (a, b) {
      return anyOi ? (b.oi - a.oi || b.vol - a.vol || a.sp - b.sp) : (a.sp - b.sp || b.vol - a.vol);
    });
    picked = picked.concat(list.slice(0, topN));
  });
  picked.sort(function (a, b) { return a.row[2] - b.row[2] || a.row[3] - b.row[3]; });

  return { rows: picked.slice(0, maxRows).map(function (p) { return p.row; }), computed: computed, oiMissing: !anyOi && picked.length > 0, cands: cands };
}

/* ---------------------------------------------------------------- market block */

function chainMarket_(sh, token, notes) {
  const M = OPTCHAIN.MKT;
  const vix = chainTry_(function () { return chainPrice_(token, 'index', 'VIX'); });
  const spy = chainTry_(function () { return chainPrice_(token, 'equity', 'SPY'); });
  const qqq = chainTry_(function () { return chainPrice_(token, 'equity', 'QQQ'); });
  let tnx = chainTry_(function () { return chainPrice_(token, 'index', 'TNX'); });
  if (isFinite(tnx) && tnx > 20) tnx = tnx / 10;      // some feeds quote the 10Y yield x10

  sh.getRange(M.VIX).setValue(isFinite(vix) ? vix : 'n/a');
  sh.getRange(M.SPY).setValue(isFinite(spy) ? spy : 'n/a');
  sh.getRange(M.QQQ).setValue(isFinite(qqq) ? qqq : 'n/a');
  sh.getRange(M.TNX).setValue(isFinite(tnx) ? tnx : 'n/a');
  sh.getRange(M.VIX).setNumberFormat('0'); sh.getRange(M.SPY).setNumberFormat('#,##0'); sh.getRange(M.QQQ).setNumberFormat('#,##0'); sh.getRange(M.TNX).setNumberFormat('0.0');
  sh.getRange(M.STAMP).setValue(new Date()).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  if (!isFinite(vix)) notes.push('VIX not available from API');
  if (!isFinite(tnx)) notes.push('10Y yield not available, using ' + (OPTCHAIN.DEFAULT_RATE * 100) + '%');
  return isFinite(tnx) ? tnx / 100 : OPTCHAIN.DEFAULT_RATE;
}

function chainPrice_(token, type, sym) {
  const j = chainGet_('/market-data/by-type?' + type + '=' + encodeURIComponent(sym), token);
  const it = ((j.data && j.data.items) || [])[0];
  if (!it) return NaN;
  return chainPick_(it, ['mark', 'mid', 'last', 'close', 'prev-close']);
}

function chainSpot_(token, ticker) {
  let v = chainTry_(function () { return chainPrice_(token, 'equity', ticker); });
  if (!isFinite(v)) v = chainTry_(function () { return chainPrice_(token, 'index', ticker); });
  if (!isFinite(v)) throw new Error('no price for ' + ticker);
  return v;
}

/* ---------------------------------------------------------------- TastyTrade API */

function chainToken_() {
  const cache = CacheService.getScriptCache();
  const cached = cache.get('chain_tt_access');
  if (cached) return cached;

  const p = PropertiesService.getScriptProperties();
  // Uses the same property names as Momentum.gs (TASTY_*); falls back to TT_* if present
  const secret = p.getProperty('TASTY_CLIENT_SECRET') || p.getProperty('TT_CLIENT_SECRET');
  const refresh = p.getProperty('TASTY_REFRESH_TOKEN') || p.getProperty('TT_REFRESH_TOKEN');
  const cid = p.getProperty('TASTY_CLIENT_ID') || p.getProperty('TT_CLIENT_ID');
  if (!secret || !refresh) throw new Error('Missing Script Properties TASTY_CLIENT_SECRET / TASTY_REFRESH_TOKEN');

  const body = { grant_type: 'refresh_token', refresh_token: refresh, client_secret: secret };
  if (cid) body.client_id = cid;

  let lastErr = '';
  for (let i = 0; i < OPTCHAIN.BASES.length; i++) {
    const base = OPTCHAIN.BASES[i];
    try {
      const res = UrlFetchApp.fetch(base + '/oauth/token', {
        method: 'post',
        contentType: 'application/json',
        headers: { 'User-Agent': 'sheet-chain/1.0' },
        payload: JSON.stringify(body),
        muteHttpExceptions: true
      });
      const txt = res.getContentText();
      let j = {};
      try { j = JSON.parse(txt); } catch (e) { /* not JSON */ }
      if (j.access_token) {
        cache.put('chain_tt_access', j.access_token, 600);
        cache.put('chain_base', base, 21600);
        return j.access_token;
      }
      lastErr = base + ' -> ' + res.getResponseCode() + ' ' + txt.slice(0, 200);
    } catch (e) {
      lastErr = base + ' -> ' + e.message;
    }
  }
  throw new Error('TastyTrade auth failed: ' + lastErr);
}

function chainGet_(path, token) {
  const base = CacheService.getScriptCache().get('chain_base') || OPTCHAIN.BASES[0];
  const res = UrlFetchApp.fetch(base + path, {
    headers: { Authorization: 'Bearer ' + token, 'User-Agent': 'sheet-chain/1.0' },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error(path.split('?')[0] + ' returned ' + res.getResponseCode() + ' ' + res.getContentText().slice(0, 160));
  }
  return JSON.parse(res.getContentText());
}

function chainQuotes_(token, symbols) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 25) {
    const q = symbols.slice(i, i + 25).map(function (s) { return 'equity-option=' + encodeURIComponent(s); }).join('&');
    const j = chainGet_('/market-data/by-type?' + q, token);
    ((j.data && j.data.items) || []).forEach(function (it) { out[chainKey_(it.symbol)] = it; });
  }
  return out;
}

/* ---------------------------------------------------------------- Black-Scholes fallback */

function chainCdf_(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function chainBs_(isPut, S, K, T, r, q, sig) {
  const sq = sig * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sig * sig / 2) * T) / sq;
  const d2 = d1 - sq;
  const df = Math.exp(-r * T), dq = Math.exp(-q * T);
  const pdf = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
  const base = -S * dq * pdf * sig / (2 * Math.sqrt(T));
  let price, delta, theta;
  if (!isPut) {
    price = S * dq * chainCdf_(d1) - K * df * chainCdf_(d2);
    delta = dq * chainCdf_(d1);
    theta = (base - r * K * df * chainCdf_(d2) + q * S * dq * chainCdf_(d1)) / 365;
  } else {
    price = K * df * chainCdf_(-d2) - S * dq * chainCdf_(-d1);
    delta = -dq * chainCdf_(-d1);
    theta = (base + r * K * df * chainCdf_(-d2) - q * S * dq * chainCdf_(-d1)) / 365;
  }
  return {
    price: price, delta: delta, theta: theta,
    gamma: dq * pdf / (S * sig * Math.sqrt(T)),
    vega: S * dq * pdf * Math.sqrt(T) / 100            // per 1 vol point
  };
}

function chainGreeks_(isPut, S, K, T, r, q, mid) {
  if (!(T > 0) || !(S > 0) || !(K > 0) || !(mid > 0)) return null;
  let lo = 0.01, hi = 3;
  if (mid < chainBs_(isPut, S, K, T, r, q, lo).price || mid > chainBs_(isPut, S, K, T, r, q, hi).price) return null;
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (chainBs_(isPut, S, K, T, r, q, m).price < mid) lo = m; else hi = m;
  }
  const iv = (lo + hi) / 2;
  const g = chainBs_(isPut, S, K, T, r, q, iv);
  return { iv: iv, delta: g.delta, gamma: g.gamma, vega: g.vega, theta: g.theta };
}

/* ---------------------------------------------------------------- small helpers */

// Switching Type (column B, rows 3-17) auto-fills the filters for that row:
//   CALL -> delta 0.70-0.85, 300-800 days   (deep ITM LEAPS)
//   PUT  -> delta 0.15-0.30, 25-60 days     (cash-secured puts)
// You can still overwrite the numbers afterwards (e.g. an OTM covered call).
// Simple trigger: runs by itself, no setup. If another file of yours also defines onEdit, merge the two.
function onEdit(e) {
  try {
    const rg = e && e.range;
    if (!rg) return;
    const sh = rg.getSheet();
    if (sh.getName() !== OPTCHAIN.SHEET || rg.getColumn() !== 2) return;
    const first = OPTCHAIN.INPUT_FIRST_ROW, last = first + OPTCHAIN.INPUT_ROWS - 1;
    for (let r = Math.max(rg.getRow(), first); r <= Math.min(rg.getLastRow(), last); r++) {
      const t = String(sh.getRange(r, 2).getValue()).toUpperCase().trim();
      if (t === 'PUT') sh.getRange(r, 3, 1, 4).setValues([[0.15, 0.30, 25, 60]]);
      else if (t === 'CALL') sh.getRange(r, 3, 1, 4).setValues([[0.70, 0.85, 300, 800]]);
    }
  } catch (err) { /* never block an edit */ }
}

// Expected ROI if held to expiry. Stock at expiry is lognormal with the option's own IV:
//   S_T = S * exp((drift - IV^2/2) * T + z * IV * sqrt(T))
// Expected ROI uses the exact expected payoff (drift in place of the risk-free rate), so a longer
// option does not get extra credit just for being longer. Bear / Base / Bull = 25th / 50th / 75th percentile.
// CALL (buying): return on the premium paid.   PUT (selling, cash-secured): return on the strike collateral.
function chainRoi_(isPut, S, K, mid, days, iv) {
  const R = OPTCHAIN.ROI, T = days / 365, sq = iv * Math.sqrt(T), mu = R.DRIFT;
  const d1 = (Math.log(S / K) + (mu + iv * iv / 2) * T) / sq, d2 = d1 - sq;
  const fwd = S * Math.exp(mu * T);
  const ePay = isPut ? K * chainCdf_(-d2) - fwd * chainCdf_(-d1) : fwd * chainCdf_(d1) - K * chainCdf_(d2);
  const exp = isPut ? (mid - ePay) / K : ePay / mid - 1;
  const sc = R.Z.map(function (z) {
    const g = S * Math.exp((mu - iv * iv / 2) * T + z * sq);
    const pay = isPut ? Math.max(K - g, 0) : Math.max(g - K, 0);
    return isPut ? (mid - pay) / K : pay / mid - 1;
  });
  return {
    bear: sc[0], base: sc[1], bull: sc[2],
    ann: (1 + exp) > 0 ? Math.pow(1 + exp, 1 / T) - 1 : -1,
    be: isPut ? (K - mid) / S - 1 : (K + mid) / S - 1
  };
}

// Best liquid contract per ticker for three expiry buckets, shown in J1:S7 (hover a contract cell for details)
function chainTop_(sh, cands) {
  const R = OPTCHAIN.ROI;
  sh.getRange(1, 10, OPTCHAIN.INPUT_ROWS + 2, 11).clearContent().clearNote();
  sh.getRange(3, 10, OPTCHAIN.INPUT_ROWS, 10).setBackground(null);
  const labels = [];
  cands.forEach(function (c) { if (labels.indexOf(c.label) < 0) labels.push(c.label); });
  const put = cands.length && cands[0].isPut;
  const E = put ? R.EDGES_PUT : R.EDGES_CALL;
  const names = [ '<=' + E[0] + 'd', (E[0] + 1) + '-' + E[1] + 'd', '>' + E[1] + 'd' ];
  const bucket = function (d) { return d <= E[0] ? 0 : (d <= E[1] ? 1 : 2); };
  sh.getRange(1, 10).setValue('BEST BY EXPECTED ROI, ONE PER TICKER PER EXPIRY BUCKET (liquid only: OI>=' + R.MIN_OI + ')');
  const head = ['Ticker'];
  names.forEach(function (n) { head.push(n + ' contract', 'Mid', 'Ann ROI'); });
  sh.getRange(2, 10, 1, 10).setValues([head]).setFontWeight('bold');
  const out = [], notes = [], winners = [];
  labels.slice(0, OPTCHAIN.INPUT_ROWS).forEach(function (lb) {
    const row = [lb], nrow = [''];
    let bestB = -1, bestA = -Infinity;
    for (let b = 0; b < 3; b++) {
      const best = cands.filter(function (c) { return c.label === lb && c.liquid && bucket(c.days) === b; })
        .sort(function (a, z) { return z.ann - a.ann; })[0];
      if (!best) { row.push('-', '', ''); nrow.push('', '', ''); continue; }
      row.push(best.exp + ' $' + best.k, best.mid, best.ann);
      if (best.ann > bestA) { bestA = best.ann; bestB = b; }
      nrow.push('Delta ' + best.delta.toFixed(2) + ' | OI ' + best.oi + ' | Breakeven ' + (best.rr.be * 100).toFixed(1) + '%\n' +
        'Bear ' + (best.rr.bear * 100).toFixed(0) + '% / Base ' + (best.rr.base * 100).toFixed(0) + '% / Bull ' + (best.rr.bull * 100).toFixed(0) + '%', '', '');
    }
    out.push(row); notes.push(nrow); winners.push(bestB);
  });
  if (!out.length) { sh.getRange(3, 10).setValue('none'); return; }
  sh.getRange(3, 10, out.length, 10).setValues(out).setNumberFormat('General');
  sh.getRange(3, 10, out.length, 10).setNotes(notes);
  winners.forEach(function (b, i) {   // highlight the best bucket for each ticker
    if (b >= 0) sh.getRange(3 + i, 11 + b * 3, 1, 3).setBackground('#b7e1cd');
  });
  for (let b = 0; b < 3; b++) {
    sh.getRange(3, 12 + b * 3, out.length, 1).setNumberFormat(put ? '#,##0.00' : '#,##0');
    sh.getRange(3, 13 + b * 3, out.length, 1).setNumberFormat('0%');
  }
}

// Highlight, for each ticker + expiry, the row with the highest open interest
function chainHighlight_(sh, rows) {
  const nCols = OPTCHAIN.HEADERS.length;
  const best = {};
  rows.forEach(function (r, i) {
    const key = r[0] + '|' + r[1];
    const oi = Number(r[14]) || 0;
    if (oi > 0 && (best[key] === undefined || oi > (Number(rows[best[key]][14]) || 0))) best[key] = i;
  });
  const bg = rows.map(function () { return new Array(nCols).fill(null); });
  Object.keys(best).forEach(function (k) { bg[best[k]] = new Array(nCols).fill('#ffe599'); });
  sh.getRange(OPTCHAIN.FIRST_ROW, 1, rows.length, nCols).setBackgrounds(bg);
}

// CALL / PUT dropdown in the Type column of the input rows
function chainTypeDropdown_(sh) {
  const rule = SpreadsheetApp.newDataValidation().requireValueInList(['CALL', 'PUT'], true).setAllowInvalid(false).build();
  sh.getRange(OPTCHAIN.INPUT_FIRST_ROW, 2, OPTCHAIN.INPUT_ROWS, 1).setDataValidation(rule);
}

function chainHeadersRow_() { return [OPTCHAIN.HEADERS]; }

function chainWriteHeaders_(sh) {
  sh.getRange(OPTCHAIN.HEADER_ROW, 1, 1, OPTCHAIN.HEADERS.length).setValues(chainHeadersRow_());
  // clear any old header cells to the right of R (S:W) so nothing stale is left behind
  sh.getRange(OPTCHAIN.HEADER_ROW, OPTCHAIN.HEADERS.length + 1, 1, OPTCHAIN.CLEAR_COLS - OPTCHAIN.HEADERS.length).clearContent();
}

function chainStatus_(sh, msg) {
  sh.getRange(OPTCHAIN.STATUS_ROW, 1).setValue('Last run:');
  sh.getRange(OPTCHAIN.STATUS_ROW, 2).setValue(new Date()).setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sh.getRange(OPTCHAIN.STATUS_ROW, 3).setValue(msg);
}

function chainFormat_(sh, n, rows) {
  const r0 = OPTCHAIN.FIRST_ROW;
  // whole numbers everywhere, except cheap options (avg price under $20, e.g. short-dated puts) keep cents
  const avg = rows.reduce(function (a, r) { return a + r[4]; }, 0) / Math.max(rows.length, 1);
  const px = avg < 20 ? '#,##0.00' : '#,##0';
  sh.getRange(r0, 4, n, 1).setNumberFormat('General');       // strike (keeps 152.5)
  sh.getRange(r0, 5, n, 2).setNumberFormat(px);              // mid, extrinsic $
  sh.getRange(r0, 7, n, 1).setNumberFormat('#,##0');         // stock
  sh.getRange(r0, 8, n, 1).setNumberFormat('0%');            // extrinsic %
  sh.getRange(r0, 9, n, 1).setNumberFormat('0.00');          // delta (a whole number would be meaningless)
  sh.getRange(r0, 10, n, 1).setNumberFormat('0');            // IV %
  sh.getRange(r0, 11, n, 3).setNumberFormat(px);             // bid, ask, spread
  sh.getRange(r0, 14, n, 2).setNumberFormat('#,##0');        // volume, open interest
  sh.getRange(r0, 16, n, 2).setNumberFormat('0.00');         // theta, vega
  sh.getRange(r0, 18, n, 1).setNumberFormat('0.000');        // gamma
  sh.getRange(r0, 19, n, 2).setNumberFormat(avg < 20 ? '0.0%' : '0%');   // yield, annualized yield
}

function chainPick_(o, keys) {
  for (let i = 0; i < keys.length; i++) {
    const v = o[keys[i]];
    if (v !== undefined && v !== null && v !== '') {
      const n = Number(v);
      if (isFinite(n)) return n;
    }
  }
  return NaN;
}

function chainNum_(v, dflt) {
  const n = Number(v);
  return (v === '' || v === null || v === undefined || !isFinite(n)) ? dflt : n;
}

function chainKey_(sym) { return String(sym || '').replace(/\s+/g, ''); }

function chainTry_(fn) {
  try { return fn(); } catch (e) { return NaN; }
}