/**
 * ============================================================================
 * HEDGE ENGINE (HedgeEngine.gs)
 * ----------------------------------------------------------------------------
 * Scans every OPEN LONG-CALL position across the Quick / Risky / Leap tabs
 * (any row with a plausible Entry Price) and, for each one, answers: given
 * this LEAPS-style position, how much short-term downside risk am I actually
 * exposed to right now, how expensive is protection, and which protective put
 * gives the most useful coverage per dollar?
 *
 * v1 SCOPE (by design, not an oversight — see the chat this was built from):
 *   - Long calls hedged with protective puts only. Every open position in
 *     this book is currently a long call, so the inverse case (long puts
 *     hedged with calls) is deliberately deferred rather than built and
 *     left untested.
 *   - The same ticker/strike/expiry appearing as multiple lots (e.g. two
 *     CEG $250C lots opened on different days) is combined into ONE
 *     position, sized at the average entry cost across those lots.
 *   - "Eventually backtest the weights" is realistic only for the
 *     UNDERLYING-only components (Drawdown/Momentum/Volatility/Market) —
 *     there's no free historical-options-data source, so the options-cost
 *     side (skew, IV rank) can't be rigorously backtested without a paid
 *     vendor. The weights below are starting points, not validated.
 *
 * REUSES FROM Momentum.gs (this file defines nothing that collides with
 * it — same project, same shared top-level scope):
 *   getColumnMap_, parseStrikeCell_, parseExpiryCell_, parseApiDate_,
 *   fetchYahooDailyBars_, computeATRPercent_, computeTrendPercent_,
 *   computeRelativeStrengthPercent_, computeMaxDrawdownPercent_,
 *   atrOpportunityScore_, trendAlignmentScore_, relativeStrengthScore_,
 *   drawdownRiskScore_, blackScholesDelta_, normCdf_, clamp_, isPlausible_,
 *   round2_, RISK_FREE_RATE, TREND_MA_PERIOD, RS_LOOKBACK_DAYS,
 *   SLOW_REFRESH_DAYS, DATA_START_ROW, getSlowCached_, loadSlowCache_,
 *   flushSlowCacheWrites_, isCatalystPast_, getTastyTradeAccessToken_,
 *   fetchTastyOptionChainNested_, fetchTastyMarketDataBatch_,
 *   fetchTastyTradeQuote_, fetchYahooQuote_, fetchYahooExpirationDatesForScanner_,
 *   fetchYahooFullChainForScannerExpiry_, buildOccSymbol_, getFinnhubApiKey_,
 *   fetchFinnhubNextEarnings_, fetchYahooNextEarnings_, notify_, tryGetUi_,
 *   logToSheet_, COLOR_RISK_LOW/MED/HIGH.
 *
 * A small menu patch is needed in Momentum.gs's onOpen() to expose this —
 * see the instructions delivered alongside this file. Everything else here
 * is self-contained.
 * ============================================================================
 */


/* ============================================================================
 * CONFIG
 * ========================================================================== */

const HEDGE_SHEET_NAME = 'Hedge';
const HEDGE_SOURCE_SHEETS = ['Quick', 'Risky', 'Leap'];
const HEDGE_EXECUTION_TIME_BUDGET_MS = 5 * 60 * 1000;

// Target DTE buckets for candidate expiries. "mid" is the ideal DTE within
// each bucket, used to pick the closest real listed expiration.
const HEDGE_DTE_BUCKETS = [
  { label: '7-14 DTE', min: 7, max: 14, mid: 10 },
  { label: '15-21 DTE', min: 15, max: 21, mid: 18 },
  { label: '22-35 DTE', min: 22, max: 35, mid: 28 },
  { label: '36-60 DTE', min: 36, max: 60, mid: 48 }
];

// Candidate strikes evaluated per expiry, as a % of spot. Nearest ACTUAL
// listed strike is used and duplicates (several targets rounding to the
// same real strike) are collapsed.
const HEDGE_CANDIDATE_STRIKE_PCTS = [0.80, 0.85, 0.88, 0.90, 0.92, 0.95, 0.98, 1.00];

// Stress scenarios for scenario P&L. Balanced/Tail efficiency are each
// averaged over a sub-band of these rather than pinned to one magic number —
// see averageEfficiencyAcross_.
const HEDGE_STRESS_SCENARIOS = [-0.05, -0.08, -0.10, -0.12, -0.15, -0.18, -0.20, -0.25, -0.30];
const HEDGE_BALANCED_SCENARIOS = [-0.10, -0.15, -0.20];
const HEDGE_TAIL_SCENARIOS = [-0.25, -0.30];

// Delta bands (absolute value) for candidate classification.
const HEDGE_TAIL_DELTA_RANGE = { min: 0.10, max: 0.20 };
const HEDGE_BALANCED_DELTA_RANGE = { min: 0.20, max: 0.35 };
const HEDGE_NEARATM_DELTA_RANGE = { min: 0.40, max: 0.55 };

// Liquidity filter — spread as a % of mid price.
const HEDGE_SPREAD_GOOD = 10;
const HEDGE_SPREAD_ACCEPTABLE = 20;
const HEDGE_SPREAD_REJECT = 30;

// HedgeNeedScore / HedgeCostScore component weights — starting points, NOT
// backtested (see file header). Sums don't need to be 100; each score is
// normalized by its own total weight.
const HEDGE_NEED_WEIGHTS = { drawdown: 25, momentum: 20, volatility: 20, event: 15, portfolioExposure: 10, marketRisk: 10 };
const HEDGE_COST_WEIGHTS = { ivRank: 35, skew: 30, spread: 20, thetaDecay: 15 };

// How many days out counts as "inside the hedge's own window" for event
// risk — wider than Momentum.gs's 5-day SWING_WINDOW_DAYS, since a 14-35+
// DTE hedge cares about events across a longer horizon than a swing exit.
const HEDGE_EVENT_WINDOW_DAYS = 14;

// Need x Cost decision-matrix split points (0-100 scale each). See
// hedgeDecisionFromNeedAndCost_ — this replaces a single 1-D threshold
// ladder on Need alone, since Need and Cost need to interact, not stack.
const HEDGE_NEED_HIGH_THRESHOLD = 50;
const HEDGE_COST_HIGH_THRESHOLD = 50;

// Fixed reassessment cadence for v1 — simple and predictable rather than
// trying to derive an "optimal" review interval from the score itself.
const HEDGE_REASSESS_DAYS = 10;


/* ============================================================================
 * FRED (macro events: CPI, Jobs report, FOMC) — genuinely free, no paid
 * tier, official St. Louis Fed data. Finnhub's own /calendar/economic is
 * premium-only (confirmed 403 on a free key), so this is the real option.
 * ========================================================================== */

const FRED_RELEASE_IDS = { CPI: 10, JOBS: 50, FOMC: 101 };
const FRED_SLOW_REFRESH_DAYS = 3; // these dates are known months ahead and rarely change once published

function setFredApiKey() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.prompt(
    'FRED Setup',
    'Paste your free FRED API key (register at fred.stlouisfed.org/docs/api/api_key.html):',
    ui.ButtonSet.OK_CANCEL
  );
  if (response.getSelectedButton() !== ui.Button.OK) return;
  const key = response.getResponseText().trim();
  if (!key) { ui.alert('No API key entered.'); return; }
  PropertiesService.getScriptProperties().setProperty('FRED_API_KEY', key);
  ui.alert('FRED API key saved.\n\nUsed for: FOMC / CPI / Jobs report dates in the Hedge Engine\'s Event Risk factor.');
}

function getFredApiKey_() {
  return PropertiesService.getScriptProperties().getProperty('FRED_API_KEY');
}

// Fetches the nearest upcoming (>= today) release date for one FRED
// release_id. Returns a Date or null (missing key, network failure, or
// nothing scheduled yet).
function fetchFredNextReleaseDate_(releaseId, apiKey) {
  if (!apiKey) return null;
  const todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const url = 'https://api.stlouisfed.org/fred/release/dates?release_id=' + releaseId +
    '&api_key=' + encodeURIComponent(apiKey) + '&file_type=json&sort_order=asc&realtime_start=' + todayStr +
    '&include_release_dates_with_no_data=true&limit=5';
  try {
    const resp = UrlFetchApp.fetch(url, { method: 'get', muteHttpExceptions: true, headers: { Accept: 'application/json' } });
    if (resp.getResponseCode() !== 200) {
      Logger.log('FRED release ' + releaseId + ' failed. HTTP ' + resp.getResponseCode());
      return null;
    }
    const json = JSON.parse(resp.getContentText());
    const dates = json.release_dates || [];
    const todayMidnight = new Date().setHours(0, 0, 0, 0);
    for (let i = 0; i < dates.length; i++) {
      const d = parseApiDate_(dates[i].date);
      if (d && d.getTime() >= todayMidnight) return d;
    }
    return null;
  } catch (err) {
    Logger.log('FRED release ' + releaseId + ' error: ' + err);
    return null;
  }
}

// Wraps the three FRED lookups through the existing slow-cache mechanism
// (shared PropertiesService cache, 3-day refresh window).
function getMacroEventDaysCached_(fredApiKey, slowCache, pendingWrites) {
  const now = new Date();
  function daysUntil(dateStr) {
    if (!dateStr) return null;
    const d = new Date(dateStr + 'T12:00:00');
    return Math.round((d.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
  }
  function fetchAndCache(field, releaseId) {
    return getSlowCached_(slowCache, pendingWrites, field, 'GLOBAL', FRED_SLOW_REFRESH_DAYS, function () {
      const d = fetchFredNextReleaseDate_(releaseId, fredApiKey);
      return d ? Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null;
    });
  }

  const cpiResult = fetchAndCache('FRED_CPI', FRED_RELEASE_IDS.CPI);
  const jobsResult = fetchAndCache('FRED_JOBS', FRED_RELEASE_IDS.JOBS);
  const fomcResult = fetchAndCache('FRED_FOMC', FRED_RELEASE_IDS.FOMC);

  const daysToCpi = daysUntil(cpiResult.value);
  const daysToJobs = daysUntil(jobsResult.value);
  const daysToFomc = daysUntil(fomcResult.value);
  const known = [daysToCpi, daysToJobs, daysToFomc].filter(function (d) { return d != null; });

  return {
    daysToCpi: daysToCpi, daysToJobs: daysToJobs, daysToFomc: daysToFomc,
    daysToNearestMacroEvent: known.length ? Math.min.apply(null, known) : null
  };
}


/* ============================================================================
 * BLACK-SCHOLES PRICE — Momentum.gs only has blackScholesDelta_/Gamma_.
 * Scenario P&L needs a full price to reprice both legs at a stressed spot.
 * ========================================================================== */

function blackScholesPrice_(stockPrice, strike, daysToExpiry, ivPercent, optionType) {
  if (
    !isPlausible_(stockPrice, 0.01, null) || !isPlausible_(strike, 0.01, null) ||
    !isPlausible_(daysToExpiry, 0.01, null) || !isPlausible_(ivPercent, 0.01, null)
  ) return null;

  const T = daysToExpiry / 365;
  const sigma = ivPercent / 100;
  const d1 = (Math.log(stockPrice / strike) + (RISK_FREE_RATE + (sigma * sigma) / 2) * T) / (sigma * Math.sqrt(T));
  const d2 = d1 - sigma * Math.sqrt(T);
  const discountedStrike = strike * Math.exp(-RISK_FREE_RATE * T);

  if (optionType === 'P') {
    return discountedStrike * normCdf_(-d2) - stockPrice * normCdf_(-d1);
  }
  return stockPrice * normCdf_(d1) - discountedStrike * normCdf_(d2);
}

// One-day time decay via finite difference — two extra BS evaluations, zero
// network cost, instead of the full analytic theta formula.
function blackScholesOneDayTheta_(stockPrice, strike, daysToExpiry, ivPercent, optionType) {
  const priceNow = blackScholesPrice_(stockPrice, strike, daysToExpiry, ivPercent, optionType);
  const priceTomorrow = blackScholesPrice_(stockPrice, strike, Math.max(daysToExpiry - 1, 0.5), ivPercent, optionType);
  if (priceNow == null || priceTomorrow == null) return null;
  return priceTomorrow - priceNow;
}

// Simple bisection implied-vol solver. Needed because TastyTrade's batched
// market-data endpoint returns delta/bid/ask but not per-contract IV — this
// backs it out from the observed mid price so skew/ATM-IV work regardless
// of which data source supplied the chain. 40 iterations is far more
// precision than this needs (comparative skew reads, not execution pricing).
function impliedVolatilityBisection_(marketPrice, stockPrice, strike, daysToExpiry, optionType) {
  if (!isPlausible_(marketPrice, 0.001, null)) return null;
  let low = 0.5, high = 300;
  for (let i = 0; i < 40; i++) {
    const mid = (low + high) / 2;
    const price = blackScholesPrice_(stockPrice, strike, daysToExpiry, mid, optionType);
    if (price == null) return null;
    if (price > marketPrice) high = mid; else low = mid;
  }
  return (low + high) / 2;
}


/* ============================================================================
 * MARKET CONTEXT — fetched ONCE per run, shared across every position.
 * ========================================================================== */

// Generalized Yahoo daily-bars fetch (arbitrary range), separate from
// Momentum.gs's fetchYahooDailyBars_ (hardcoded to 2mo, used throughout the
// main validator) so this file never risks changing that function's
// behavior. Used here only for VIX's 1-year history (need real history for
// a percentile rank; 2mo isn't enough).
function fetchYahooDailyBarsForRange_(ticker, range) {
  const urls = [
    'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=' + range + '&interval=1d',
    'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(ticker) + '?range=' + range + '&interval=1d'
  ];
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get', muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' }
      });
      if (resp.getResponseCode() !== 200) continue;
      const json = JSON.parse(resp.getContentText());
      const result = json.chart && json.chart.result && json.chart.result[0];
      if (!result || !result.timestamp || !result.indicators || !result.indicators.quote || !result.indicators.quote[0]) continue;
      const ts = result.timestamp;
      const q = result.indicators.quote[0];
      const closes = [];
      for (let d = 0; d < ts.length; d++) {
        const close = q.close ? q.close[d] : null;
        if (isPlausible_(close, 0, null)) closes.push(close);
      }
      if (closes.length < 20) continue;
      return closes;
    } catch (err) {
      Logger.log('Yahoo range-bars error for ' + ticker + ': ' + err);
    }
  }
  return null;
}

// Percentile rank (0-100) of the last value within its own history, inclusive.
function percentileRankOfLast_(series) {
  if (!series || series.length < 10) return null;
  const last = series[series.length - 1];
  let below = 0;
  series.forEach(function (v) { if (v <= last) below++; });
  return (below / series.length) * 100;
}

// spyBars/vixCloses are passed in (fetched once, cached, in runHedgeAnalysis)
// rather than fetched here, so this never duplicates a network call.
function buildHedgeMarketContext_(spyBars, vixCloses) {
  const spyTrendPercent = spyBars ? computeTrendPercent_(spyBars, TREND_MA_PERIOD) : null;
  const vixLevel = vixCloses && vixCloses.length ? vixCloses[vixCloses.length - 1] : null;
  const vixPercentile = percentileRankOfLast_(vixCloses);
  return { spyTrendPercent: spyTrendPercent, vixLevel: vixLevel, vixPercentile: vixPercentile };
}

// Blends SPY trend direction (falling market = higher risk — reuses
// trendAlignmentScore_ from Momentum.gs, inverted, since a call-favorable
// trend score should map to LOW hedge risk) with VIX's own percentile rank
// (already 0-100 "how elevated is fear right now", used directly).
function marketRiskScore_(marketContext) {
  const trendComponent = marketContext.spyTrendPercent != null
    ? 100 - trendAlignmentScore_(marketContext.spyTrendPercent, 'C')
    : 50;
  const vixComponent = marketContext.vixPercentile != null ? marketContext.vixPercentile : 50;
  return (trendComponent + vixComponent) / 2;
}


/* ============================================================================
 * HEDGE NEED SCORE COMPONENTS
 * ========================================================================== */

// Momentum: reuses trendAlignmentScore_ and relativeStrengthScore_ (already
// scored 0-100 "how call-favorable", from Momentum.gs) inverted, since
// bearish momentum is what raises hedge need, not what lowers it.
function momentumRiskScore_(trendPercent, rsPercent) {
  const trendComp = trendAlignmentScore_(trendPercent, 'C');
  const rsComp = relativeStrengthScore_(rsPercent, 'C');
  return 100 - (trendComp + rsComp) / 2;
}

// Event proximity — earnings AND, if a FRED key is configured, the nearest
// of CPI/Jobs/FOMC. Unknown defaults to neutral 50, matching every other
// "unknown" convention in this codebase.
function eventRiskScore_(daysToNearestEvent, windowDays) {
  if (daysToNearestEvent == null || isNaN(daysToNearestEvent) || daysToNearestEvent < 0) return 50;
  if (daysToNearestEvent >= windowDays) return 0;
  return clamp_(((windowDays - daysToNearestEvent) / windowDays) * 100, 0, 100);
}

// How much of the whole open-positions book this one position represents.
// A position at 50%+ of total cost maxes this out.
function portfolioExposureScore_(positionCost, totalPortfolioCost) {
  if (!isPlausible_(positionCost, 0, null) || !isPlausible_(totalPortfolioCost, 0.01, null)) return 50;
  const sharePercent = (positionCost / totalPortfolioCost) * 100;
  return clamp_(sharePercent * 2, 0, 100);
}

function computeHedgeNeedScore_(inputs) {
  const w = HEDGE_NEED_WEIGHTS;
  const drawdown = drawdownRiskScore_(inputs.maxDrawdownPercent); // reused from Momentum.gs
  const momentum = momentumRiskScore_(inputs.trendPercent, inputs.rsPercent);
  const volatility = atrOpportunityScore_(inputs.atrPercent); // reused from Momentum.gs — same math, "opportunity" there is "risk" here
  const event = eventRiskScore_(inputs.daysToNearestEvent, HEDGE_EVENT_WINDOW_DAYS);
  const portfolioExposure = portfolioExposureScore_(inputs.positionCost, inputs.totalPortfolioCost);
  const marketRisk = marketRiskScore_(inputs.marketContext);

  const totalWeight = w.drawdown + w.momentum + w.volatility + w.event + w.portfolioExposure + w.marketRisk;
  const weightedSum = drawdown * w.drawdown + momentum * w.momentum + volatility * w.volatility +
    event * w.event + portfolioExposure * w.portfolioExposure + marketRisk * w.marketRisk;

  return {
    score: Math.round((weightedSum / totalWeight) * 10) / 10,
    components: { drawdown: drawdown, momentum: momentum, volatility: volatility, event: event, portfolioExposure: portfolioExposure, marketRisk: marketRisk }
  };
}


/* ============================================================================
 * HEDGE COST SCORE — read off the recommended (Balanced, else Tail) bucket's
 * pricing snapshot. "Premium relative to historical levels" from the
 * original spec is deliberately omitted for v1 — no historical option-price
 * data source exists to compare against; faking it would be worse than
 * leaving it out. Flagged here rather than silently dropped.
 * ========================================================================== */

function computeHedgeCostScore_(inputs) {
  const w = HEDGE_COST_WEIGHTS;
  const ivRankComponent = inputs.ivRank != null ? clamp_(inputs.ivRank, 0, 100) : 50;
  const skewComponent = inputs.putSkewPoints != null ? clamp_(inputs.putSkewPoints * 10, 0, 100) : 50;
  const spreadComponent = inputs.spreadPercent != null ? clamp_(inputs.spreadPercent * (100 / HEDGE_SPREAD_REJECT), 0, 100) : 50;
  const thetaComponent = inputs.thetaDecayPercentPerDay != null ? clamp_(inputs.thetaDecayPercentPerDay * 20, 0, 100) : 50;

  const totalWeight = w.ivRank + w.skew + w.spread + w.thetaDecay;
  const weightedSum = ivRankComponent * w.ivRank + skewComponent * w.skew + spreadComponent * w.spread + thetaComponent * w.thetaDecay;

  return {
    score: Math.round((weightedSum / totalWeight) * 10) / 10,
    components: { ivRank: ivRankComponent, skew: skewComponent, spread: spreadComponent, thetaDecay: thetaComponent }
  };
}


/* ============================================================================
 * NEED x COST DECISION MATRIX — replaces a single 1-D threshold ladder on
 * Need alone. Operationalizes "need and cost have to interact" directly.
 * ========================================================================== */

function hedgeDecisionFromNeedAndCost_(needScore, costScore) {
  const needHigh = needScore >= HEDGE_NEED_HIGH_THRESHOLD;
  const costHigh = costScore >= HEDGE_COST_HIGH_THRESHOLD;

  if (needHigh && !costHigh) {
    return { status: 'HEDGE', decision: 'BUY', note: 'Meaningful downside exposure and protection is reasonably priced.' };
  }
  if (needHigh && costHigh) {
    return { status: 'HEDGE (EXPENSIVE)', decision: 'BUY (SIZE DOWN / TAIL)', note: 'Exposure is real but insurance is pricey \u2014 lean toward the cheaper tail hedge or a smaller size rather than skipping protection.' };
  }
  if (!needHigh && !costHigh) {
    return { status: 'WATCH', decision: 'OPTIONAL (CHEAP)', note: 'No urgent need, but protection is cheap right now \u2014 optional to buy ahead of need.' };
  }
  return { status: 'WAIT', decision: 'WAIT', note: 'Low need and expensive insurance \u2014 no action.' };
}


/* ============================================================================
 * CANDIDATE PUT CHAIN SCANNING
 * ========================================================================== */

function findNearestStrikeContract_(contracts, targetStrike) {
  let best = null, bestDiff = Infinity;
  contracts.forEach(function (c) {
    const strike = c.strike != null ? parseFloat(c.strike) : null;
    if (!isPlausible_(strike, 0.01, null)) return;
    const diff = Math.abs(strike - targetStrike);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  });
  return best;
}

// Normalizes one Yahoo chain contract, estimating delta via Black-Scholes
// (Yahoo doesn't return real delta) since IV is available directly.
function normalizeYahooPutContract_(c, underlying, dte) {
  const strike = c.strike != null ? parseFloat(c.strike) : null;
  const ivPct = c.impliedVolatility != null ? parseFloat(c.impliedVolatility) * 100 : null;
  const bid = isPlausible_(c.bid, 0, null) ? parseFloat(c.bid) : null;
  const ask = isPlausible_(c.ask, 0, null) ? parseFloat(c.ask) : null;
  const mid = (bid != null && ask != null) ? (bid + ask) / 2 : (isPlausible_(c.lastPrice, 0, null) ? c.lastPrice : null);
  if (!isPlausible_(strike, 0.01, null) || !isPlausible_(ivPct, 0.01, 1000) || mid == null) return null;
  const delta = blackScholesDelta_(underlying, strike, dte, ivPct, 'P');
  return {
    strike: strike, bid: bid, ask: ask, mid: mid, iv: ivPct, delta: delta,
    oi: isPlausible_(c.openInterest, 0, null) ? c.openInterest : null,
    volume: isPlausible_(c.volume, 0, null) ? c.volume : null,
    source: 'Yahoo (estimated delta)'
  };
}

// Normalized PUT chain for one ticker/expiry: TastyTrade (real delta, via
// the already-fetched nested-chain + one batched market-data call) first,
// Yahoo (estimated delta, implied-vol solved for skew) second. spotHint
// avoids a redundant underlying-price fetch (the caller already has spot).
function getNormalizedPutChainForExpiry_(ticker, expiryDate, dte, tastyExpirations, accessToken, spotHint) {
  if (accessToken && tastyExpirations) {
    const targetKey = Utilities.formatDate(expiryDate, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    const match = tastyExpirations.find(function (e) {
      return Utilities.formatDate(e.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') === targetKey;
    });
    if (match) {
      const putSymbols = match.strikes.map(function (s) { return s.putSymbol; }).filter(Boolean);
      const marketData = fetchTastyMarketDataBatch_(putSymbols, accessToken);
      const contracts = match.strikes.map(function (s) {
        const md = s.putSymbol ? marketData[s.putSymbol] : null;
        if (!md || md.delta == null || md.bid == null || md.ask == null) return null;
        const mid = (md.bid + md.ask) / 2;
        const iv = impliedVolatilityBisection_(mid, spotHint, s.strike, dte, 'P');
        return { strike: s.strike, bid: md.bid, ask: md.ask, mid: mid, iv: iv, delta: md.delta, oi: md.oi, volume: md.volume, source: 'TastyTrade (real delta)' };
      }).filter(Boolean);
      if (contracts.length) return { underlying: spotHint, dte: dte, contracts: contracts };
    }
  }

  const chainInfo = fetchYahooFullChainForScannerExpiry_(ticker, expiryDate, 'P');
  Utilities.sleep(120);
  if (!chainInfo || !chainInfo.contracts.length) return null;
  const underlying = isPlausible_(chainInfo.underlying, 0.01, null) ? chainInfo.underlying : spotHint;
  if (!isPlausible_(underlying, 0.01, null)) return null;
  const normalized = chainInfo.contracts.map(function (c) { return normalizeYahooPutContract_(c, underlying, dte); }).filter(Boolean);
  if (!normalized.length) return null;
  return { underlying: underlying, dte: dte, contracts: normalized };
}

// Nearest listed expiry to the bucket's midpoint among those falling inside
// [min,max]; if none fall inside, nearest overall (flagged via insideWindow).
function pickExpiryForBucket_(expirationDates, runTimestamp, bucket) {
  const inWindow = [];
  const all = [];
  expirationDates.forEach(function (d) {
    const dte = Math.round((d.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));
    if (dte <= 0) return;
    const entry = { date: d, dte: dte };
    all.push(entry);
    if (dte >= bucket.min && dte <= bucket.max) inWindow.push(entry);
  });
  const pool = inWindow.length ? inWindow : all;
  if (!pool.length) return null;
  pool.sort(function (a, b) { return Math.abs(a.dte - bucket.mid) - Math.abs(b.dte - bucket.mid); });
  return { date: pool[0].date, dte: pool[0].dte, insideWindow: inWindow.length > 0 };
}

function findAtmIv_(contracts, underlying) {
  const atm = findNearestStrikeContract_(contracts, underlying);
  return atm ? atm.iv : null;
}

function find25DeltaPutIv_(contracts) {
  let best = null, bestDiff = Infinity;
  contracts.forEach(function (c) {
    if (c.delta == null || c.iv == null) return;
    const diff = Math.abs(Math.abs(c.delta) - 0.25);
    if (diff < bestDiff) { bestDiff = diff; best = c; }
  });
  return best ? best.iv : null;
}

function classifyByDelta_(absDelta) {
  if (absDelta >= HEDGE_TAIL_DELTA_RANGE.min && absDelta <= HEDGE_TAIL_DELTA_RANGE.max) return 'Tail';
  if (absDelta >= HEDGE_BALANCED_DELTA_RANGE.min && absDelta <= HEDGE_BALANCED_DELTA_RANGE.max) return 'Balanced';
  if (absDelta >= HEDGE_NEARATM_DELTA_RANGE.min && absDelta <= HEDGE_NEARATM_DELTA_RANGE.max) return 'Near-ATM';
  return null;
}

function spreadPercentOf_(bid, ask, mid) {
  if (!isPlausible_(bid, 0, null) || !isPlausible_(ask, 0, null) || !isPlausible_(mid, 0.01, null) || ask < bid) return null;
  return ((ask - bid) / mid) * 100;
}

function liquidityLabelForSpread_(spreadPercent) {
  if (spreadPercent == null) return 'Unknown';
  if (spreadPercent < HEDGE_SPREAD_GOOD) return 'Good';
  if (spreadPercent < HEDGE_SPREAD_ACCEPTABLE) return 'Acceptable';
  if (spreadPercent < HEDGE_SPREAD_REJECT) return 'Caution';
  return 'Reject';
}

// Fetches expirations once (Tasty nested chain if available, else Yahoo),
// then evaluates each DTE bucket against that single fetch — NOT once per
// bucket — since the nested chain already contains every expiry/strike.
function evaluateHedgeCandidatesForPosition_(position, accessToken, runTimestamp) {
  let tastyExpirations = null;
  let expirationDates = null;

  if (accessToken) {
    tastyExpirations = fetchTastyOptionChainNested_(position.ticker, accessToken);
    if (tastyExpirations) expirationDates = tastyExpirations.map(function (e) { return e.date; });
  }
  if (!expirationDates) {
    const expiryInfo = fetchYahooExpirationDatesForScanner_(position.ticker);
    Utilities.sleep(120);
    if (expiryInfo && expiryInfo.dates.length) expirationDates = expiryInfo.dates;
  }
  if (!expirationDates || !expirationDates.length) {
    return { error: 'Could not fetch expirations for ' + position.ticker, buckets: [] };
  }

  const buckets = [];
  HEDGE_DTE_BUCKETS.forEach(function (bucket) {
    const picked = pickExpiryForBucket_(expirationDates, runTimestamp, bucket);
    if (!picked) { buckets.push({ bucket: bucket.label, error: 'No listed expiry found' }); return; }

    const chain = getNormalizedPutChainForExpiry_(position.ticker, picked.date, picked.dte, tastyExpirations, accessToken, position.spot);
    if (!chain) {
      buckets.push({ bucket: bucket.label, error: 'Chain fetch failed for ' + Utilities.formatDate(picked.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') });
      return;
    }

    const atmIv = findAtmIv_(chain.contracts, chain.underlying);
    const put25Iv = find25DeltaPutIv_(chain.contracts);
    const skewPoints = (atmIv != null && put25Iv != null) ? (put25Iv - atmIv) : null;

    const seenStrikes = {};
    const candidates = [];
    HEDGE_CANDIDATE_STRIKE_PCTS.forEach(function (pct) {
      const targetStrike = chain.underlying * pct;
      const contract = findNearestStrikeContract_(chain.contracts, targetStrike);
      if (!contract || seenStrikes[contract.strike]) return;
      seenStrikes[contract.strike] = true;

      const spreadPercent = spreadPercentOf_(contract.bid, contract.ask, contract.mid);
      const absDelta = contract.delta != null ? Math.abs(contract.delta) : null;
      candidates.push({
        strike: contract.strike, dte: chain.dte, expiry: picked.date,
        bid: contract.bid, ask: contract.ask, mid: contract.mid,
        iv: contract.iv != null ? contract.iv : atmIv,
        delta: contract.delta, absDelta: absDelta,
        oi: contract.oi, volume: contract.volume,
        spreadPercent: spreadPercent, liquidity: liquidityLabelForSpread_(spreadPercent),
        classification: absDelta != null ? classifyByDelta_(absDelta) : null,
        source: contract.source
      });
    });

    buckets.push({
      bucket: bucket.label, expiry: picked.date, dte: chain.dte, insideWindow: picked.insideWindow,
      underlying: chain.underlying, atmIv: atmIv, put25Iv: put25Iv, skewPoints: skewPoints,
      candidates: candidates
    });
  });

  return { error: null, buckets: buckets };
}


/* ============================================================================
 * SCENARIO P&L, COVERAGE, EFFICIENCY
 * ----------------------------------------------------------------------------
 * P&L is computed relative to your ORIGINAL entry cost for both legs (not
 * current mark) — this shows total position risk from where you actually
 * stand, not incremental risk from today's price. IV is held constant for
 * both legs across the stress test (a real crash usually pushes IV up too,
 * which would help a long put more than modeled here — a documented
 * simplification, not an oversight).
 * ========================================================================== */

function computeScenarioPnl_(position, candidate, stressPercent) {
  const stressedSpot = position.spot * (1 + stressPercent);

  const leapsNewPrice = blackScholesPrice_(stressedSpot, position.strike, position.dte, position.iv, 'C');
  const putNewPrice = blackScholesPrice_(stressedSpot, candidate.strike, candidate.dte, candidate.iv, 'P');
  if (leapsNewPrice == null || putNewPrice == null) return null;

  const leapsPnl = (leapsNewPrice - position.premiumPaid) * 100;
  const putPnl = (putNewPrice - candidate.mid) * 100;
  const combinedPnl = leapsPnl + putPnl;
  const leapsLoss = leapsPnl < 0 ? -leapsPnl : 0;
  const coverage = leapsLoss > 0.01 ? clamp_((Math.max(putPnl, 0) / leapsLoss) * 100, 0, 500) : null;

  return { stressPercent: stressPercent, leapsPnl: leapsPnl, putPnl: putPnl, combinedPnl: combinedPnl, coverage: coverage };
}

// Loss reduction vs. holding the LEAPS unhedged = the put's own P&L at that
// stress level (a losing/expiring-worthless put correctly drags this down).
function averageEfficiencyAcross_(position, candidate, scenarios, hedgeCostDollars) {
  if (!isPlausible_(hedgeCostDollars, 0.01, null)) return null;
  let total = 0, count = 0;
  scenarios.forEach(function (s) {
    const result = computeScenarioPnl_(position, candidate, s);
    if (!result) return;
    total += result.putPnl / hedgeCostDollars;
    count++;
  });
  return count ? total / count : null;
}

// Best Balanced (delta -0.20 to -0.35) candidate by average efficiency over
// the -10/-15/-20% band, and best Tail (-0.10 to -0.20) candidate by average
// efficiency over the -25/-30% band — across every DTE bucket, liquidity-
// filtered (Caution/Reject excluded from being recommended, though still
// shown in the note for transparency... actually excluded from the note
// scan too here; see formatCandidateNote_ which lists everything regardless).
function selectBestHedgeCandidates_(position, evaluation) {
  let bestBalanced = null, bestBalancedScore = -Infinity;
  let bestTail = null, bestTailScore = -Infinity;

  evaluation.buckets.forEach(function (bucketResult) {
    if (bucketResult.error) return;
    bucketResult.candidates.forEach(function (candidate) {
      if (candidate.liquidity === 'Reject' || candidate.liquidity === 'Unknown' || !candidate.classification) return;

      if (candidate.classification === 'Balanced') {
        const eff = averageEfficiencyAcross_(position, candidate, HEDGE_BALANCED_SCENARIOS, candidate.mid * 100);
        if (eff != null && eff > bestBalancedScore) {
          bestBalancedScore = eff;
          candidate.bucketLabel = bucketResult.bucket;
          candidate.efficiency = eff;
          bestBalanced = candidate;
        }
      }
      if (candidate.classification === 'Tail') {
        const eff = averageEfficiencyAcross_(position, candidate, HEDGE_TAIL_SCENARIOS, candidate.mid * 100);
        if (eff != null && eff > bestTailScore) {
          bestTailScore = eff;
          candidate.bucketLabel = bucketResult.bucket;
          candidate.efficiency = eff;
          bestTail = candidate;
        }
      }
    });
  });

  return { balanced: bestBalanced, tail: bestTail };
}


/* ============================================================================
 * HEDGE SHEET OUTPUT
 * ========================================================================== */

const HEDGE_HEADERS = [
  'Avg Cost', 'Lots', 'Ticker', 'Position Expiry', 'Position Strike', 'Spot',
  'Need Score', 'Status', 'Cost Score', 'Decision',
  'Rec Bucket', 'Rec Expiry', 'Rec Strike', 'Rec Delta', 'Rec Premium', 'Rec Contract Cost',
  'Coverage -10%', 'Coverage -15%', 'Coverage -20%', 'Coverage -25%',
  'Tail Expiry', 'Tail Strike', 'Tail Premium',
  'Reassess By', 'LastRun'
];

function getOrCreateHedgeSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(HEDGE_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(HEDGE_SHEET_NAME);
  sheet.getRange(1, 1, 1, HEDGE_HEADERS.length).setValues([HEDGE_HEADERS]);
  sheet.setFrozenRows(1);
  const dataRows = sheet.getMaxRows() - 1;
  if (dataRows > 0) {
    sheet.getRange(2, 1, dataRows, HEDGE_HEADERS.length).clearContent().clearNote().setBackground(null);

    // Spot and Rec Strike are the two numbers people cross-reference most —
    // a fixed background makes them jump out from the rest of the row
    // without implying good/bad the way the Status/Risk color bands do.
    const spotCol = HEDGE_HEADERS.indexOf('Spot') + 1;
    const recStrikeCol = HEDGE_HEADERS.indexOf('Rec Strike') + 1;
    if (spotCol > 0) sheet.getRange(2, spotCol, dataRows, 1).setBackground('#cfe2f3'); // light blue
    if (recStrikeCol > 0) sheet.getRange(2, recStrikeCol, dataRows, 1).setBackground('#d9d2e9'); // light purple

    // Coverage values are already stored on a 0-100 scale (40.5 = 40.5%),
    // so a literal "%" suffix is used instead of Sheets' native percent
    // format, which would otherwise misread 40.5 as 4050%.
    const firstCoverageCol = HEDGE_HEADERS.indexOf('Coverage -10%') + 1;
    const lastCoverageCol = HEDGE_HEADERS.indexOf('Coverage -25%') + 1;
    if (firstCoverageCol > 0 && lastCoverageCol >= firstCoverageCol) {
      sheet.getRange(2, firstCoverageCol, dataRows, lastCoverageCol - firstCoverageCol + 1).setNumberFormat('0.0"%"');
    }
  }
  return sheet;
}

function formatCandidateNote_(evaluation) {
  const lines = [];
  evaluation.buckets.forEach(function (b) {
    if (b.error) { lines.push(b.bucket + ': ' + b.error); return; }
    lines.push(
      b.bucket + ' (expiry ' + Utilities.formatDate(b.expiry, Session.getScriptTimeZone(), 'yyyy-MM-dd') +
      ', ' + b.dte + 'd' + (b.insideWindow ? '' : ', OUTSIDE ideal window \u2014 nothing listed in range') + ') \u2014 ATM IV ' +
      (b.atmIv != null ? round2_(b.atmIv) + '%' : 'n/a') + ', 25\u0394 put IV ' +
      (b.put25Iv != null ? round2_(b.put25Iv) + '%' : 'n/a') + ', skew ' +
      (b.skewPoints != null ? round2_(b.skewPoints) + ' pts' : 'n/a')
    );
    b.candidates.forEach(function (c) {
      lines.push(
        '   $' + round2_(c.strike) + 'P \u0394' + (c.absDelta != null ? c.absDelta.toFixed(2) : '?') +
        ' [' + (c.classification || '-') + '] mid $' + round2_(c.mid) + ' spread ' +
        (c.spreadPercent != null ? round2_(c.spreadPercent) + '% (' + c.liquidity + ')' : 'n/a') +
        ' OI ' + (c.oi != null ? c.oi : '?') + ' (' + c.source + ')'
      );
    });
  });
  return lines.join('\n');
}

function writeHedgeRow_(sheet, row, position, needResult, costResult, decision, selection, reassessDate, runTimestamp) {
  const balanced = selection.balanced;
  const tail = selection.tail;

  const coverageAt = function (candidate, stressPercent) {
    if (!candidate) return '';
    const result = computeScenarioPnl_(position, candidate, stressPercent);
    return result && result.coverage != null ? round2_(result.coverage) : '';
  };

  const values = [
    round2_(position.premiumPaid), position.lots, position.ticker,
    Utilities.formatDate(position.expiry, Session.getScriptTimeZone(), 'MMM d, yyyy'),
    position.strike, round2_(position.spot),
    needResult.score, decision.status, costResult.score, decision.decision,
    balanced ? balanced.bucketLabel : (tail ? tail.bucketLabel : 'n/a'),
    balanced ? Utilities.formatDate(balanced.expiry, Session.getScriptTimeZone(), 'MMM d, yyyy') : '',
    balanced ? balanced.strike : '',
    balanced ? round2_(balanced.absDelta) : '',
    balanced ? round2_(balanced.mid) : '',
    balanced ? round2_(balanced.mid * 100) : '',
    coverageAt(balanced, -0.10), coverageAt(balanced, -0.15), coverageAt(balanced, -0.20), coverageAt(balanced, -0.25),
    tail ? Utilities.formatDate(tail.expiry, Session.getScriptTimeZone(), 'MMM d, yyyy') : '',
    tail ? tail.strike : '', tail ? round2_(tail.mid) : '',
    Utilities.formatDate(reassessDate, Session.getScriptTimeZone(), 'MMM d, yyyy'), runTimestamp
  ];

  sheet.getRange(row, 1, 1, values.length).setValues([values]);

  const statusColor = decision.status.indexOf('HEDGE') === 0 ? COLOR_RISK_HIGH :
    decision.status === 'WATCH' ? COLOR_RISK_MED : COLOR_RISK_LOW;
  sheet.getRange(row, 8).setBackground(statusColor);
}


/* ============================================================================
 * POSITION SCANNING — non-blank Entry Price across Quick/Risky/Leap, long
 * calls only (v1 scope), same ticker+strike+expiry lots combined.
 * ========================================================================== */

function collectOpenPositions_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const grouped = {};

  HEDGE_SOURCE_SHEETS.forEach(function (sheetName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return;
    const map = getColumnMap_(sheet);
    if (!map.ticker || !map.strike || !map.expiry || !map.entryPrice) return;

    const lastRow = sheet.getLastRow();
    for (let row = DATA_START_ROW; row <= lastRow; row++) {
      const entryPrice = parseFloat(sheet.getRange(row, map.entryPrice).getValue());
      if (!isPlausible_(entryPrice, 0.01, null)) continue;

      const tickerVal = sheet.getRange(row, map.ticker).getValue();
      const parsedStrike = parseStrikeCell_(sheet.getRange(row, map.strike).getValue());
      const parsedExpiry = parseExpiryCell_(sheet.getRange(row, map.expiry).getValue());
      if (!tickerVal || !parsedStrike || !parsedExpiry) continue;
      if (parsedStrike.type !== 'C') continue; // v1: long calls only

      const ticker = String(tickerVal).trim().toUpperCase();
      const key = ticker + '|' + parsedStrike.strike + '|' + Utilities.formatDate(parsedExpiry, Session.getScriptTimeZone(), 'yyyy-MM-dd');

      let stockPriceCellNum = null;
      if (map.stockPrice) {
        const raw = parseFloat(sheet.getRange(row, map.stockPrice).getValue());
        if (isPlausible_(raw, 0.01, null)) stockPriceCellNum = raw;
      }

      if (!grouped[key]) {
        grouped[key] = { ticker: ticker, strike: parsedStrike.strike, expiry: parsedExpiry, totalCost: 0, lots: 0, stockPriceHint: null };
      }
      grouped[key].totalCost += entryPrice;
      grouped[key].lots += 1;
      if (grouped[key].stockPriceHint == null) grouped[key].stockPriceHint = stockPriceCellNum;
    }
  });

  return Object.keys(grouped).map(function (key) {
    const g = grouped[key];
    return { ticker: g.ticker, strike: g.strike, expiry: g.expiry, lots: g.lots, premiumPaid: g.totalCost / g.lots, stockPriceHint: g.stockPriceHint };
  });
}


/* ============================================================================
 * MAIN ORCHESTRATOR
 * ========================================================================== */

function runHedgeAnalysis(timeBudgetMsOverride) {
  const ui = tryGetUi_();
  const runTimestamp = new Date();
  const scriptStartTime = Date.now();
  const timeBudgetMs = timeBudgetMsOverride || HEDGE_EXECUTION_TIME_BUDGET_MS;

  const positions = collectOpenPositions_();
  if (!positions.length) {
    notify_(ui, 'Hedge Analysis', 'No open long-call positions found (a non-blank Entry Price) across ' + HEDGE_SOURCE_SHEETS.join(', ') + '.');
    return;
  }

  const totalPortfolioCost = positions.reduce(function (sum, p) { return sum + p.premiumPaid; }, 0);

  const accessToken = getTastyTradeAccessToken_();
  const fredApiKey = getFredApiKey_();
  const finnhubApiKey = getFinnhubApiKey_();

  const slowCache = loadSlowCache_();
  const pendingSlowWrites = {};

  // SPY bars share the exact same cache namespace Momentum.gs uses for its
  // own Market Regime calc — a same-day Validate & Update run means this is
  // often a free cache hit here.
  const spyBarsResult = getSlowCached_(slowCache, pendingSlowWrites, 'DAILYBARS', 'SPY', SLOW_REFRESH_DAYS.DAILYBARS, function () {
    return fetchYahooDailyBars_('SPY');
  });
  const vixResult = getSlowCached_(slowCache, pendingSlowWrites, 'VIXHISTORY', 'GLOBAL', SLOW_REFRESH_DAYS.DAILYBARS, function () {
    return fetchYahooDailyBarsForRange_('^VIX', '1y');
  });
  const marketContext = buildHedgeMarketContext_(spyBarsResult.value, vixResult.value);
  const macroEvents = getMacroEventDaysCached_(fredApiKey, slowCache, pendingSlowWrites);

  const sheet = getOrCreateHedgeSheet_();
  let outputRow = 2;
  let processed = 0, skipped = 0;
  const skipReasons = []; // collected here and shown in the completion popup instead of the Log tab
  let timeBudgetExceeded = false;

  for (let i = 0; i < positions.length; i++) {
    if (Date.now() - scriptStartTime > timeBudgetMs) { timeBudgetExceeded = true; break; }
    const pos = positions[i];

    // Underlying bars — shares Momentum.gs's own per-ticker DAILYBARS cache,
    // so tickers already touched by today's Validate & Update run are free.
    const barsResult = getSlowCached_(slowCache, pendingSlowWrites, 'DAILYBARS', pos.ticker, SLOW_REFRESH_DAYS.DAILYBARS, function () {
      return fetchYahooDailyBars_(pos.ticker);
    });
    const bars = barsResult.value;
    if (!bars) { skipped++; skipReasons.push(pos.ticker + ': could not fetch daily bars.'); continue; }
    // Same reasoning as ResearchEngine.gs's throttling — only delay when a
    // real network call actually happened, not on every cache hit.
    if (barsResult.fetchAttempted) Utilities.sleep(150);

    const spot = pos.stockPriceHint != null ? pos.stockPriceHint : bars[bars.length - 1].close;
    const atrPercent = computeATRPercent_(bars);
    const trendPercent = computeTrendPercent_(bars, TREND_MA_PERIOD);
    const rsPercent = computeRelativeStrengthPercent_(bars, spyBarsResult.value, RS_LOOKBACK_DAYS);
    const maxDrawdownPercent = computeMaxDrawdownPercent_(bars);

    const metrics = accessToken ? fetchTastyMarketMetrics_(pos.ticker, accessToken) : null;
    const ivRank = metrics ? metrics.ivPercent : null;

    // Earnings — shares Momentum.gs's own CATALYST cache.
    const catalystResult = getSlowCached_(slowCache, pendingSlowWrites, 'CATALYST', pos.ticker, SLOW_REFRESH_DAYS.CATALYST, function () {
      let c = finnhubApiKey ? fetchFinnhubNextEarnings_(pos.ticker, finnhubApiKey) : null;
      if (!c) c = fetchYahooNextEarnings_(pos.ticker);
      if (!c) return null;
      return { date: c.date ? Utilities.formatDate(c.date, Session.getScriptTimeZone(), 'yyyy-MM-dd') : null };
    }, isCatalystPast_);
    const daysToEarnings = (catalystResult.value && catalystResult.value.date)
      ? Math.round((new Date(catalystResult.value.date + 'T12:00:00').getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000))
      : null;

    const eventCandidates = [daysToEarnings, macroEvents.daysToNearestMacroEvent].filter(function (d) { return d != null && d >= 0; });
    const daysToNearestEvent = eventCandidates.length ? Math.min.apply(null, eventCandidates) : null;
    if (catalystResult.fetchAttempted) Utilities.sleep(150);

    // Current IV for the LEAPS itself — one live quote, needed to reprice it
    // under stress (original entry premium is the cost basis, current IV is
    // what actually prices it today).
    const daysToExpiry = Math.round((pos.expiry.getTime() - runTimestamp.getTime()) / (24 * 60 * 60 * 1000));

    const occSymbol = buildOccSymbol_(pos.ticker, pos.expiry, pos.strike, 'C');
    const tastyLeapsQuote = fetchTastyTradeQuote_(occSymbol, accessToken);
    let leapsIv = (tastyLeapsQuote && tastyLeapsQuote.contractIv != null) ? tastyLeapsQuote.contractIv : null;

    // TastyTrade's market-data response for a given contract doesn't always
    // include an implied-volatility field at all (confirmed via Debug: Fetch
    // Raw Quote — this specific contract's response has no iv/implied-
    // volatility key whatsoever, even though bid/ask/delta/mark are all
    // present). Rather than treating that as "Tasty failed" and falling
    // through to Yahoo, back the IV out ourselves from Tasty's own mark
    // price — same bisection solver already used for the put-side chain.
    if (leapsIv == null && tastyLeapsQuote && tastyLeapsQuote.mark != null) {
      leapsIv = impliedVolatilityBisection_(tastyLeapsQuote.mark, spot, pos.strike, daysToExpiry, 'C');
    }

    if (leapsIv == null) {
      // By this point the position has already made 1-2 Yahoo calls (bars,
      // possibly earnings) with no pacing between them — Yahoo's unofficial
      // endpoint can silently choke on a rapid burst like that. A short
      // pause plus one retry clears up the transient case without slowing
      // down the common path where the first attempt just works.
      Utilities.sleep(300);
      let yahooLeapsQuote = fetchYahooQuote_(pos.ticker, pos.expiry, pos.strike, 'C');
      if (!yahooLeapsQuote || yahooLeapsQuote.iv == null) {
        Utilities.sleep(700);
        yahooLeapsQuote = fetchYahooQuote_(pos.ticker, pos.expiry, pos.strike, 'C');
      }
      leapsIv = (yahooLeapsQuote && yahooLeapsQuote.iv != null) ? yahooLeapsQuote.iv : null;
    }

    if (leapsIv == null) {
      skipped++;
      skipReasons.push(pos.ticker + ' $' + pos.strike + 'C: could not get a current IV quote for the LEAPS contract.');
      continue;
    }
    const position = { ticker: pos.ticker, strike: pos.strike, expiry: pos.expiry, dte: daysToExpiry, spot: spot, premiumPaid: pos.premiumPaid, iv: leapsIv, lots: pos.lots };

    const needResult = computeHedgeNeedScore_({
      maxDrawdownPercent: maxDrawdownPercent, trendPercent: trendPercent, rsPercent: rsPercent,
      atrPercent: atrPercent, daysToNearestEvent: daysToNearestEvent,
      positionCost: pos.premiumPaid * pos.lots, totalPortfolioCost: totalPortfolioCost, marketContext: marketContext
    });

    const evaluation = evaluateHedgeCandidatesForPosition_(position, accessToken, runTimestamp);
    if (evaluation.error) { skipped++; skipReasons.push(evaluation.error); continue; }

    const selection = selectBestHedgeCandidates_(position, evaluation);

    const costCandidate = selection.balanced || selection.tail;
    const costBucket = costCandidate ? evaluation.buckets.find(function (b) { return b.bucket === costCandidate.bucketLabel; }) : null;
    const theta = costCandidate ? blackScholesOneDayTheta_(spot, costCandidate.strike, costCandidate.dte, costCandidate.iv, 'P') : null;
    const thetaDecayPercentPerDay = (theta != null && costCandidate && costCandidate.mid > 0.01) ? Math.abs(theta / costCandidate.mid) * 100 : null;

    const costResult = computeHedgeCostScore_({
      ivRank: ivRank, putSkewPoints: costBucket ? costBucket.skewPoints : null,
      spreadPercent: costCandidate ? costCandidate.spreadPercent : null, thetaDecayPercentPerDay: thetaDecayPercentPerDay
    });

    const decision = hedgeDecisionFromNeedAndCost_(needResult.score, costResult.score);
    const reassessDate = new Date(runTimestamp.getTime() + HEDGE_REASSESS_DAYS * 24 * 60 * 60 * 1000);

    writeHedgeRow_(sheet, outputRow, position, needResult, costResult, decision, selection, reassessDate, runTimestamp);
    sheet.getRange(outputRow, 1).setNote(
      'Need components \u2014 Drawdown ' + round2_(needResult.components.drawdown) + ', Momentum ' + round2_(needResult.components.momentum) +
      ', Volatility ' + round2_(needResult.components.volatility) + ', Event ' + round2_(needResult.components.event) +
      ', Portfolio Exposure ' + round2_(needResult.components.portfolioExposure) + ', Market ' + round2_(needResult.components.marketRisk) + '.\n\n' +
      decision.note + '\n\n' + formatCandidateNote_(evaluation)
    );

    outputRow++;
    processed++;
    Utilities.sleep(150);
  }

  flushSlowCacheWrites_(pendingSlowWrites);

  notify_(ui, 'Hedge Analysis complete',
    (timeBudgetExceeded ? '\u23f1\ufe0f Stopped early to stay under the execution time limit \u2014 run again to pick up the rest.\n\n' : '') +
    'Positions found: ' + positions.length + '\n' +
    'Processed: ' + processed + '\n' +
    'Skipped (no usable quote/chain data): ' + skipped + '\n' +
    (skipReasons.length ? skipReasons.map(function (r) { return '  \u2022 ' + r; }).join('\n') + '\n\n' : '\n') +
    (fredApiKey ? '' : '\u26a0\ufe0f No FRED API key configured \u2014 Event Risk uses earnings only (no FOMC/CPI/Jobs). Use \u2699 More Tools > Set FRED API Key.\n\n') +
    'See each row\'s note (column A) for the full candidate comparison across all four DTE buckets.'
  );
}