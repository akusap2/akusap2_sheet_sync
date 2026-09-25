/**
 * ============================================================================
 * DAILY RESEARCH ENGINE (ResearchEngine.gs)
 * ----------------------------------------------------------------------------
 * Scans a broad, curated candidate universe (RESEARCH_UNIVERSE below, plus
 * whatever's currently on Quick/Risky/Leap) and, for each of your three
 * trading objectives, surfaces the top 20 tickers that best fit it TODAY —
 * with a plain-language reason per pick, and explicit +added/-removed
 * tracking against whatever the LAST research run picked (not "yesterday"
 * specifically, since this is meant to run several times a day).
 *
 * HONEST SCOPE LIMIT: this is NOT a full-market scan. Yahoo's free,
 * unofficial endpoint and Apps Script's execution ceiling make scanning
 * thousands of tickers, several times a day, genuinely impossible without
 * getting rate-limited or timing out — the exact wall Hedge and Deep Dive
 * already ran into elsewhere in this project. RESEARCH_UNIVERSE is a
 * curated ~220-name cross-section of liquid, optionable large/mid-caps
 * spanning every major sector — broad enough for real daily discovery,
 * bounded enough to actually finish. Edit that array directly to add/
 * remove names from the pool.
 *
 * WHY REPEAT RUNS THE SAME DAY ARE FAST: every ticker's daily bars (and,
 * where relevant, analyst target / quality rating) go through the exact
 * same getSlowCached_ / SLOW_REFRESH_DAYS mechanism Momentum.gs's own
 * Validate & Update already uses — same cache keys, so the two even share
 * hits. The FIRST run of the day does real network work and may take
 * several minutes (uses the same time-budget/stop-and-resume pattern as
 * every other long-running action in this project); every subsequent run
 * that day mostly just re-scores already-cached data.
 *
 * SCORING: reuses Momentum.gs's existing 0-100 sub-scorers directly
 * (momentumAlignmentScore_, trendAlignmentScore_, atrOpportunityScore_,
 * relativeStrengthScore_, qualityScore_, upsideAlignmentScore_) rather
 * than redefining them — same math the rest of this project already
 * trusts, just aimed at candidate SELECTION instead of contract scoring.
 * Quick/Risky lean on momentum+ATR+trend+RS (fast movers); Leap leans on
 * quality+analyst upside+trend+RS (steady conviction picks) — see
 * RESEARCH_WEIGHTS below for the exact per-tab weighting.
 * ============================================================================
 */

const RESEARCH_SHEET_NAME = 'Research';
const RESEARCH_TOP_N = 20;
// How many ranks just below the cutoff to also show, so a near-miss like
// a large-cap that fell just short doesn't disappear entirely — visible
// context for why it didn't make the top 20, not another action item.
const RESEARCH_NEAR_MISS_COUNT = 10;
const RESEARCH_EXECUTION_TIME_BUDGET_MS = 5 * 60 * 1000;
const RESEARCH_MIN_SPOT_PRICE = 5; // filters out penny-adjacent names from the universe

// Per-objective weights — starting points, not backtested (same honesty
// standard as Hedge's Need/Cost weights). Quick and Risky share the same
// factor shape, just weighted differently: Risky leans harder into raw
// momentum/ATR (wants faster movers for its much shorter hold window),
// Quick leans a bit more on trend-following. Leap is a different shape
// entirely — quality and analyst upside matter, short-term ATR doesn't.
// 'drawdown' rewards a SMALLER recent max drawdown (least-loss framing) —
// weighted lower for Risky on purpose, since that bucket is explicitly
// the higher-risk-tolerance one; weighted meaningfully for Quick and Leap.
// 'priceFit' is the soft $300 preference — same modest weight everywhere.
const RESEARCH_WEIGHTS = {
  Quick: { momentum: 22, trend: 14, atr: 18, rs: 18, drawdown: 18, priceFit: 10 },
  Risky: { momentum: 27, atr: 27, trend: 9, rs: 13, drawdown: 14, priceFit: 10 },
  Leap: { quality: 22, trend: 18, rs: 14, upside: 18, drawdown: 18, priceFit: 10 }
};

// Curated candidate universe — liquid, optionable, large/mid-cap US
// equities spanning every major sector. Deliberately broader than any
// single tab's current watchlist, deliberately bounded so a daily scan
// (run several times) actually finishes. Add/remove tickers directly here.
const RESEARCH_UNIVERSE = [
  // Technology / Semis
  'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'AMD', 'INTC', 'QCOM',
  'TXN', 'MU', 'AMAT', 'LRCX', 'KLAC', 'CSCO', 'IBM', 'ACN', 'NOW', 'PANW',
  'CRWD', 'SNOW', 'PLTR', 'APP', 'DELL', 'HPQ', 'SHOP', 'NET', 'DDOG', 'MDB',
  'ZS', 'OKTA', 'TEAM', 'WDAY', 'ADSK', 'INTU', 'FTNT', 'ANET', 'MRVL', 'ON',
  'SWKS', 'QRVO', 'MCHP', 'NXPI', 'TER', 'ENTG', 'LSCC',
  // Communication Services / Internet
  'GOOGL', 'META', 'NFLX', 'DIS', 'CMCSA', 'T', 'VZ', 'TMUS', 'PINS', 'SNAP',
  'ROKU', 'TTD', 'SPOT', 'MTCH', 'BMBL',
  // Consumer Cyclical
  'AMZN', 'TSLA', 'HD', 'LOW', 'NKE', 'MCD', 'SBUX', 'BKNG', 'ABNB', 'UBER',
  'LYFT', 'DASH', 'RBLX', 'DKNG', 'PENN', 'MGM', 'WYNN', 'LVS', 'RCL',
  'CCL', 'NCLH', 'DAL', 'UAL', 'AAL', 'LUV', 'F', 'GM',
  // Consumer Defensive
  'WMT', 'COST', 'PG', 'KO', 'PEP', 'CL', 'MDLZ', 'KHC', 'GIS', 'HSY', 'STZ',
  'MNST', 'KDP', 'CLX', 'CHD',
  // Financial Services
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'V', 'MA', 'AXP', 'BLK', 'SCHW', 'C',
  'USB', 'PNC', 'TFC', 'COF', 'SYF', 'PYPL', 'SOFI',
  // Healthcare
  'UNH', 'JNJ', 'LLY', 'PFE', 'ABBV', 'MRK', 'TMO', 'ABT', 'ISRG', 'GILD',
  'VRTX', 'REGN', 'BIIB', 'MRNA', 'AMGN', 'BMY', 'ZTS', 'DXCM', 'EW', 'SYK',
  'BSX', 'MDT', 'DHR', 'CVS', 'HUM', 'ELV', 'CNC',
  // Energy
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'DVN', 'FANG', 'OXY', 'KMI',
  'WMB', 'VLO', 'PSX', 'MPC', 'HAL', 'ENPH', 'FSLR', 'RUN',
  // Industrials
  'BA', 'CAT', 'GE', 'UNP', 'HON', 'VRT', 'LMT', 'RTX', 'NOC', 'GD', 'DE',
  'MMM', 'EMR', 'ETN', 'ITW', 'PH', 'ROK',
  // Utilities
  'CEG', 'NEE', 'DUK', 'SO', 'D', 'AEP', 'EXC', 'XEL', 'ED', 'PEG',
  // Real Estate
  'PLD', 'AMT', 'EQIX', 'PSA', 'O', 'SPG', 'WELL', 'VICI', 'DLR', 'CCI',
  // Basic Materials
  'LIN', 'FCX', 'NEM', 'GOLD', 'ALB', 'DOW', 'DD', 'SHW', 'APD',
  // Insurance — was entirely missing from the original list
  'PGR', 'TRV', 'ALL', 'MET', 'PRU', 'AIG',
  // Additional large-cap coverage gaps (Consumer Defensive, Consumer
  // Cyclical, Healthcare, Technology)
  'PM', 'MO', 'TGT', 'TJX', 'CMG', 'YUM', 'CI', 'ADI', 'CDNS', 'SNPS', 'ARM',
  // Additional mid-cap growth/momentum names, mainly to give Risky (the
  // uncapped tab) more genuinely volatile candidates to choose from
  'CELH', 'SMCI', 'U', 'PATH', 'IOT'
];

/* ============================================================================
 * MARKET CAP TIER — Quick and Leap are restricted to large/mega-cap names
 * only (Risky is deliberately unrestricted). RESEARCH_UNIVERSE was already
 * curated toward well-known, liquid large/mid-caps, so rather than tag
 * all ~200+ tickers individually, this lists only the ones that are NOT
 * large/mega-cap — anything in RESEARCH_UNIVERSE but not in this list is
 * treated as large/mega by construction. This is a hand-classified,
 * approximate tiering (same spirit as the existing sector classification
 * elsewhere in this project) — not live data, and a stock's real market
 * cap can drift across the boundary over time. Edit this list directly if
 * a classification looks wrong.
 * ========================================================================== */

const RESEARCH_KNOWN_MID_OR_SMALLER_CAP = [
  'SNOW', 'NET', 'DDOG', 'MDB', 'ZS', 'OKTA', 'TEAM', 'ON', 'SWKS', 'QRVO',
  'MCHP', 'TER', 'ENTG', 'LSCC', 'PINS', 'SNAP', 'ROKU', 'MTCH', 'BMBL',
  'LYFT', 'RBLX', 'DKNG', 'PENN', 'WYNN', 'CCL', 'NCLH', 'AAL', 'LUV',
  'SYF', 'SOFI', 'BIIB', 'MRNA', 'DXCM', 'CNC', 'DVN', 'ENPH', 'FSLR',
  'RUN', 'VRT', 'CELH', 'SMCI', 'U', 'PATH', 'IOT'
];

// Standard-ish large-cap floor. Used only as a live fallback for tickers
// NOT in RESEARCH_UNIVERSE (i.e. pulled dynamically from your actual
// Quick/Risky/Leap tabs) — those aren't covered by the hand-classification
// above, so their tier is resolved from a real (cached) market cap lookup
// instead of guessed.
const RESEARCH_LARGE_CAP_MIN_MARKET_CAP = 10e9; // $10B

// Soft preference, not a filter — full credit at/under this price, mild
// decay above it, never fully disqualified. Applies to all three tabs.
const RESEARCH_PRICE_PREFERENCE_THRESHOLD = 300;

function fetchYahooMarketCap_(ticker) {
  const urls = [
    'https://query1.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=price&formatted=false&lang=en-US&region=US',
    'https://query2.finance.yahoo.com/v10/finance/quoteSummary/' + encodeURIComponent(ticker) + '?modules=price&formatted=false&lang=en-US&region=US'
  ];
  for (let i = 0; i < urls.length; i++) {
    try {
      const resp = UrlFetchApp.fetch(urls[i], {
        method: 'get', muteHttpExceptions: true,
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', Accept: 'application/json' }
      });
      if (resp.getResponseCode() !== 200) continue;
      const json = JSON.parse(resp.getContentText());
      const result = json.quoteSummary && json.quoteSummary.result && json.quoteSummary.result[0];
      const marketCap = result && result.price && result.price.marketCap;
      if (isPlausible_(marketCap, 0, null)) return marketCap;
    } catch (err) {
      Logger.log('Yahoo market cap error for ' + ticker + ': ' + err);
    }
  }
  return null;
}

// Resolves whether a ticker qualifies as large/mega-cap for Quick/Leap.
// Known-universe tickers resolve instantly from the hand-classification
// above (zero cost); anything else (pulled from your own tabs) gets a
// real, cached market-cap lookup rather than a guess.
function resolveIsLargeOrMegaCap_(ticker, slowCache, pendingWrites) {
  if (RESEARCH_KNOWN_MID_OR_SMALLER_CAP.indexOf(ticker) !== -1) return false;
  if (RESEARCH_UNIVERSE.indexOf(ticker) !== -1) return true;

  const capResult = getSlowCached_(slowCache, pendingWrites, 'MARKETCAP', ticker, 30, function () {
    return fetchYahooMarketCap_(ticker);
  });
  return capResult.value != null && capResult.value >= RESEARCH_LARGE_CAP_MIN_MARKET_CAP;
}

// Soft price preference — full credit at/under the threshold, gradually
// decaying but floored well above zero, so an expensive stock that's
// otherwise the best fit is never fully knocked out.
function priceFitScore_(spot) {
  if (spot == null || isNaN(spot)) return 50;
  if (spot <= RESEARCH_PRICE_PREFERENCE_THRESHOLD) return 100;
  const over = spot - RESEARCH_PRICE_PREFERENCE_THRESHOLD;
  return clamp_(100 - (over / 100) * 10, 30, 100);
}


/* ============================================================================
 * PER-TICKER RESEARCH INPUTS — reuses Momentum.gs's existing fetch/cache
 * pipeline directly (fetchYahooDailyBars_, getSlowCached_, SLOW_REFRESH_DAYS,
 * computeATRPercent_, computeTrendPercent_, computeMomentumPercent_,
 * computeRelativeStrengthPercent_, fetchYahooAnalystTarget_,
 * fetchAlphaVantageAnalystTarget_, fetchFmpRating_, clamp_) — no new fetch
 * logic, just gathering what already exists per ticker.
 * ========================================================================== */

function gatherResearchInputs_(ticker, spyBars, finnhubApiKey, fmpApiKey, alphaVantageApiKey, slowCache, pendingWrites) {
  let fetchAttempted = false;

  const barsResult = getSlowCached_(slowCache, pendingWrites, 'DAILYBARS', ticker, SLOW_REFRESH_DAYS.DAILYBARS, function () {
    return fetchYahooDailyBars_(ticker);
  });
  fetchAttempted = fetchAttempted || barsResult.fetchAttempted;
  const bars = barsResult.value;
  if (!bars) return { ticker: ticker, unusable: true, fetchAttempted: fetchAttempted };

  const spot = bars[bars.length - 1].close;
  if (!isPlausible_(spot, RESEARCH_MIN_SPOT_PRICE, null)) return { ticker: ticker, unusable: true, fetchAttempted: fetchAttempted };

  const atrPercent = computeATRPercent_(bars);
  const trendPercent = computeTrendPercent_(bars, TREND_MA_PERIOD);
  const momentumPercent = computeMomentumPercent_(bars, MOMENTUM_LOOKBACK_DAYS);
  const rsPercent = computeRelativeStrengthPercent_(bars, spyBars, RS_LOOKBACK_DAYS);
  // Same ~2-month bars already in hand — zero extra network cost. Used
  // below as a "least loss" factor: a smaller recent max drawdown scores
  // better, all else equal, across all three tabs.
  const maxDrawdownPercent = computeMaxDrawdownPercent_(bars);

  const analystResult = getSlowCached_(slowCache, pendingWrites, 'ANALYST', ticker, SLOW_REFRESH_DAYS.ANALYST, function () {
    let a = fetchYahooAnalystTarget_(ticker);
    if (!a && alphaVantageApiKey) a = fetchAlphaVantageAnalystTarget_(ticker, alphaVantageApiKey);
    return a;
  });
  fetchAttempted = fetchAttempted || analystResult.fetchAttempted;
  const analyst = analystResult.value;
  const upsidePercent = (analyst && analyst.target != null && spot > 0) ? ((analyst.target - spot) / spot) * 100 : null;

  // Quality: free from the analyst object (inverted recommendation mean)
  // when available, same as Momentum.gs's own getCachedTickerData_ does —
  // only falls back to a real FMP call (and its own 14-day cache) if that
  // free path comes up empty.
  let qualityScoreValue = null;
  if (analyst && analyst.recommendationMean != null && !isNaN(analyst.recommendationMean)) {
    qualityScoreValue = clamp_(6 - analyst.recommendationMean, 1, 5);
  } else {
    const qualityResult = getSlowCached_(slowCache, pendingWrites, 'QUALITY', ticker, SLOW_REFRESH_DAYS.QUALITY, function () {
      if (!fmpApiKey) return null;
      const r = fetchFmpRating_(ticker, fmpApiKey);
      return (r && r.ratingScore != null) ? r.ratingScore : null;
    });
    fetchAttempted = fetchAttempted || qualityResult.fetchAttempted;
    qualityScoreValue = qualityResult.value;
  }

  const isLargeOrMegaCap = resolveIsLargeOrMegaCap_(ticker, slowCache, pendingWrites);

  return {
    ticker: ticker, spot: spot, atrPercent: atrPercent, trendPercent: trendPercent,
    momentumPercent: momentumPercent, rsPercent: rsPercent, upsidePercent: upsidePercent,
    qualityScore: qualityScoreValue, maxDrawdownPercent: maxDrawdownPercent,
    isLargeOrMegaCap: isLargeOrMegaCap, fetchAttempted: fetchAttempted
  };
}


/* ============================================================================
 * SCORING — one function per objective shape (Quick/Risky share a shape,
 * Leap is different), built entirely from Momentum.gs's existing 0-100
 * sub-scorers. 'C' is passed as optionType throughout, matching this whole
 * project's long-call-only convention.
 * ========================================================================== */

function computeResearchScoreForTab_(tabName, inputs) {
  const w = RESEARCH_WEIGHTS[tabName];
  const priceFit = priceFitScore_(inputs.spot);

  if (tabName === 'Leap') {
    const quality = qualityScore_(inputs.qualityScore);
    const trend = trendAlignmentScore_(inputs.trendPercent, 'C');
    const rs = relativeStrengthScore_(inputs.rsPercent, 'C');
    const upside = upsideAlignmentScore_(inputs.upsidePercent, 'C');
    const lowDrawdown = 100 - drawdownRiskScore_(inputs.maxDrawdownPercent);
    const totalWeight = w.quality + w.trend + w.rs + w.upside + w.drawdown + w.priceFit;
    const weightedSum = quality * w.quality + trend * w.trend + rs * w.rs + upside * w.upside + lowDrawdown * w.drawdown + priceFit * w.priceFit;
    return Math.round((weightedSum / totalWeight) * 10) / 10;
  }

  const momentum = momentumAlignmentScore_(inputs.momentumPercent, 'C');
  const trend = trendAlignmentScore_(inputs.trendPercent, 'C');
  // Quick is large/mega-cap only — use the scale calibrated for that
  // pool (see atrOpportunityScoreLargeCap_'s doc comment). Risky is
  // uncapped and keeps the original broad-universe scale.
  const atr = (tabName === 'Quick') ? atrOpportunityScoreLargeCap_(inputs.atrPercent) : atrOpportunityScore_(inputs.atrPercent);
  const rs = relativeStrengthScore_(inputs.rsPercent, 'C');
  const lowDrawdown = 100 - drawdownRiskScore_(inputs.maxDrawdownPercent);
  const totalWeight = w.momentum + w.trend + w.atr + w.rs + w.drawdown + w.priceFit;
  const weightedSum = momentum * w.momentum + trend * w.trend + atr * w.atr + rs * w.rs + lowDrawdown * w.drawdown + priceFit * w.priceFit;
  return Math.round((weightedSum / totalWeight) * 10) / 10;
}

function pctText_(value) {
  return value != null && !isNaN(value) ? ((value >= 0 ? '+' : '') + round2_(value) + '%') : 'n/a';
}

// Sums the weight share of whichever raw inputs feeding into tabName's
// formula are actually missing, as a % of that tab's total weight — so
// "n/a" in the reason text isn't just cosmetic, it's reflected in how
// much of the score to actually trust.
function computeMissingWeightShare_(tabName, inputs) {
  const w = RESEARCH_WEIGHTS[tabName];
  let missingWeight = 0;
  let totalWeight;

  if (tabName === 'Leap') {
    totalWeight = w.quality + w.trend + w.rs + w.upside + w.drawdown + w.priceFit;
    if (inputs.qualityScore == null) missingWeight += w.quality;
    if (inputs.trendPercent == null) missingWeight += w.trend;
    if (inputs.rsPercent == null) missingWeight += w.rs;
    if (inputs.upsidePercent == null) missingWeight += w.upside;
    if (inputs.maxDrawdownPercent == null) missingWeight += w.drawdown;
  } else {
    totalWeight = w.momentum + w.trend + w.atr + w.rs + w.drawdown + w.priceFit;
    if (inputs.momentumPercent == null) missingWeight += w.momentum;
    if (inputs.trendPercent == null) missingWeight += w.trend;
    if (inputs.atrPercent == null) missingWeight += w.atr;
    if (inputs.rsPercent == null) missingWeight += w.rs;
    if (inputs.maxDrawdownPercent == null) missingWeight += w.drawdown;
  }

  return totalWeight > 0 ? (missingWeight / totalWeight) * 100 : 0;
}

function buildResearchReason_(tabName, inputs) {
  const drawdownText = inputs.maxDrawdownPercent != null ? round2_(inputs.maxDrawdownPercent) + '%' : 'n/a';
  const missingSharePercent = computeMissingWeightShare_(tabName, inputs);
  const confidenceNote = missingSharePercent > 0
    ? ' \u26a0\ufe0f ' + round2_(missingSharePercent) + '% of this score is neutral-filled (missing data) \u2014 treat with less confidence.'
    : '';
  const priceText = 'Price $' + round2_(inputs.spot) +
    (inputs.spot > RESEARCH_PRICE_PREFERENCE_THRESHOLD ? ' (over your $' + RESEARCH_PRICE_PREFERENCE_THRESHOLD + ' preference, included anyway on merit)' : '') +
    '. ';
  const capTierText = (tabName !== 'Risky') ? 'Large/mega-cap. ' : '';

  if (tabName === 'Leap') {
    return capTierText + priceText + 'Quality ' + (inputs.qualityScore != null ? inputs.qualityScore.toFixed(1) + '/5' : 'n/a') +
      ', analyst upside ' + pctText_(inputs.upsidePercent) +
      ', trend ' + pctText_(inputs.trendPercent) + ' vs 20DMA' +
      ', RS ' + pctText_(inputs.rsPercent) + ' vs SPY' +
      ', ~2mo max drawdown ' + drawdownText +
      ' \u2014 steady long-term conviction pick.' + confidenceNote;
  }
  return capTierText + priceText + '5D momentum ' + pctText_(inputs.momentumPercent) +
    ', RS ' + pctText_(inputs.rsPercent) + ' vs SPY' +
    ', ATR ' + (inputs.atrPercent != null ? round2_(inputs.atrPercent) + '%' : 'n/a') +
    ', trend ' + pctText_(inputs.trendPercent) + ' vs 20DMA' +
    ', ~2mo max drawdown ' + drawdownText +
    (tabName === 'Risky' ? ' \u2014 fast mover suited to a short hold.' : ' \u2014 solid short-term setup.') + confidenceNote;
}


/* ============================================================================
 * SHEET OUTPUT
 * ========================================================================== */

function getOrCreateResearchSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(RESEARCH_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(RESEARCH_SHEET_NAME);
  sheet.clearContents();
  sheet.clearFormats();
  return sheet;
}

function writeResearchSheet_(picks, nearMisses, changes, timeBudgetExceeded, processed, totalCandidates) {
  const sheet = getOrCreateResearchSheet_();
  const headers = ['Quick Ticker', 'Quick Score', 'Quick Reason', '', 'Risky Ticker', 'Risky Score', 'Risky Reason', '', 'Leap Ticker', 'Leap Score', 'Leap Reason'];
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const rows = [];
  for (let i = 0; i < RESEARCH_TOP_N; i++) {
    const q = picks.Quick[i], r = picks.Risky[i], l = picks.Leap[i];
    rows.push([
      q ? q.ticker : '', q ? q.score : '', q ? q.reason : '', '',
      r ? r.ticker : '', r ? r.score : '', r ? r.reason : '', '',
      l ? l.ticker : '', l ? l.score : '', l ? l.reason : ''
    ]);
  }
  sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);

  let noteRow = 2 + RESEARCH_TOP_N + 1;

  // Just outside the top 20 (ranks 21-30) — visible context for a
  // near-miss like a large-cap that fell just short, not another action
  // item to act on. Same column layout as the main table above.
  sheet.getRange(noteRow, 1).setValue('Just outside the top ' + RESEARCH_TOP_N + ' (ranks ' + (RESEARCH_TOP_N + 1) + '-' + (RESEARCH_TOP_N + RESEARCH_NEAR_MISS_COUNT) + ')').setFontWeight('bold');
  noteRow++;
  const nearMissRows = [];
  for (let i = 0; i < RESEARCH_NEAR_MISS_COUNT; i++) {
    const q = nearMisses.Quick[i], r = nearMisses.Risky[i], l = nearMisses.Leap[i];
    nearMissRows.push([
      q ? q.ticker : '', q ? q.score : '', q ? q.reason : '', '',
      r ? r.ticker : '', r ? r.score : '', r ? r.reason : '', '',
      l ? l.ticker : '', l ? l.score : '', l ? l.reason : ''
    ]);
  }
  sheet.getRange(noteRow, 1, nearMissRows.length, headers.length).setValues(nearMissRows);
  noteRow += nearMissRows.length + 1;

  sheet.getRange(noteRow, 1).setValue('Changes since last run').setFontWeight('bold');
  noteRow++;

  ['Quick', 'Risky', 'Leap'].forEach(function (tabName) {
    sheet.getRange(noteRow, 1).setValue(tabName + ':').setFontWeight('bold');
    noteRow++;
    changes[tabName].added.forEach(function (t) {
      sheet.getRange(noteRow, 1).setValue('  + Added: ' + t + ' \u2014 newly in the top ' + RESEARCH_TOP_N + ' this run.');
      noteRow++;
    });
    changes[tabName].removed.forEach(function (t) {
      sheet.getRange(noteRow, 1).setValue('  \u2212 Removed: ' + t + ' \u2014 no longer ranks in the top ' + RESEARCH_TOP_N + ' (other candidates scored higher this run).');
      noteRow++;
    });
    if (!changes[tabName].added.length && !changes[tabName].removed.length) {
      sheet.getRange(noteRow, 1).setValue('  No changes since last run.');
      noteRow++;
    }
    noteRow++;
  });

  sheet.getRange(noteRow, 1).setValue(
    'Scanned ' + processed + ' of ' + totalCandidates + ' candidates' +
    (timeBudgetExceeded ? ' \u2014 stopped early, run again to complete the pass.' : '.') +
    ' Last run: ' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MMM d, yyyy h:mm a')
  );

  sheet.autoResizeColumns(1, headers.length);
}


/* ============================================================================
 * MAIN ORCHESTRATOR
 * ========================================================================== */

function collectCurrentTabTickers_(sheetName) {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) return [];
  const map = getColumnMap_(sheet);
  if (!map.ticker) return [];
  const lastRow = sheet.getLastRow();
  const tickers = [];
  for (let row = DATA_START_ROW; row <= lastRow; row++) {
    const v = sheet.getRange(row, map.ticker).getValue();
    if (v) tickers.push(String(v).trim().toUpperCase());
  }
  return tickers;
}

/* ============================================================================
 * CLOUD FUNCTION BATCH PREFETCH
 * ----------------------------------------------------------------------------
 * Optional speed layer: if a Cloud Function URL and shared secret are
 * configured (see setCloudFunctionCredentials below), this fetches daily
 * bars for every ticker that actually needs a fresh one — concurrently,
 * on the Cloud Function's side — in ONE HTTP request, instead of Apps
 * Script fetching 200+ tickers one at a time from Yahoo directly. Writes
 * straight into the same slow-cache structure getSlowCached_ already
 * reads from, so nothing downstream needs to know this happened — a
 * ticker prefetched here is just a clean cache hit to everything else.
 *
 * Fully optional and fails soft: no credentials configured, or the call
 * errors out for any reason (network, bad response, Cloud Function down)
 * — this just does nothing and returns, and every ticker falls back to
 * being fetched one-by-one via Yahoo directly in the loop below, exactly
 * as this project has always worked. Never a hard failure point.
 * ========================================================================== */

function getCloudFunctionUrl_() {
  return PropertiesService.getScriptProperties().getProperty('CLOUD_FUNCTION_URL');
}

function getCloudFunctionSharedSecret_() {
  return PropertiesService.getScriptProperties().getProperty('CLOUD_FUNCTION_SHARED_SECRET');
}

function setCloudFunctionCredentials() {
  const ui = SpreadsheetApp.getUi();
  const urlResp = ui.prompt('Cloud Function Setup', 'Paste your Cloud Function URL (from Cloud Run\'s "Service details" page):', ui.ButtonSet.OK_CANCEL);
  if (urlResp.getSelectedButton() !== ui.Button.OK) return;
  const secretResp = ui.prompt('Cloud Function Setup', 'Paste your SHARED_SECRET value (the same one set as an environment variable on the Cloud Function):', ui.ButtonSet.OK_CANCEL);
  if (secretResp.getSelectedButton() !== ui.Button.OK) return;

  const props = PropertiesService.getScriptProperties();
  props.setProperty('CLOUD_FUNCTION_URL', urlResp.getResponseText().trim());
  props.setProperty('CLOUD_FUNCTION_SHARED_SECRET', secretResp.getResponseText().trim());
  ui.alert('Saved. Research will now use the Cloud Function for daily bars whenever it\'s reachable.');
}

function prefetchDailyBarsViaCloudFunction_(tickers, slowCache, pendingWrites) {
  const cloudFunctionUrl = getCloudFunctionUrl_();
  const sharedSecret = getCloudFunctionSharedSecret_();
  if (!cloudFunctionUrl || !sharedSecret) return { attempted: false };

  // A ticker qualifies if ANY of its four data types is stale — not just
  // bars. Bars is the one Research itself needs every day; Analyst/
  // Quality/Catalyst aren't used by Research's own scoring, but
  // prefetching them here still pre-warms the SAME shared cache
  // Validate & Update reads from later, so that run benefits too.
  const staleTickers = tickers.filter(function (ticker) {
    const barsStale = slowEntryAgeDays_(slowCache[slowKey_('DAILYBARS', ticker)]) >= SLOW_REFRESH_DAYS.DAILYBARS;
    const analystStale = slowEntryAgeDays_(slowCache[slowKey_('ANALYST', ticker)]) >= SLOW_REFRESH_DAYS.ANALYST;
    const qualityStale = slowEntryAgeDays_(slowCache[slowKey_('QUALITY', ticker)]) >= SLOW_REFRESH_DAYS.QUALITY;
    const catalystStale = slowEntryAgeDays_(slowCache[slowKey_('CATALYST', ticker)]) >= SLOW_REFRESH_DAYS.CATALYST;
    return barsStale || analystStale || qualityStale || catalystStale;
  });
  if (!staleTickers.length) {
    logToSheet_('Cloud Function prefetch: skipped \u2014 every ticker\'s bars/analyst/quality/catalyst are already fresh in cache.');
    return { attempted: false, reason: 'nothing stale' };
  }

  const startTime = Date.now();
  let resp;
  try {
    resp = UrlFetchApp.fetch(cloudFunctionUrl, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ apiKey: sharedSecret, tickers: staleTickers }),
      muteHttpExceptions: true
    });
  } catch (e) {
    logToSheet_('Cloud Function prefetch FAILED (network error) \u2014 falling back to per-ticker fetching: ' + e);
    return { attempted: true, fetched: 0, error: String(e) };
  }

  if (resp.getResponseCode() !== 200) {
    logToSheet_('Cloud Function prefetch FAILED (HTTP ' + resp.getResponseCode() + ') \u2014 falling back to per-ticker fetching: ' +
      resp.getContentText().substring(0, 300));
    return { attempted: true, fetched: 0, error: 'HTTP ' + resp.getResponseCode() };
  }

  let json;
  try {
    json = JSON.parse(resp.getContentText());
  } catch (e) {
    logToSheet_('Cloud Function prefetch FAILED (unparseable response) \u2014 falling back to per-ticker fetching: ' + e);
    return { attempted: true, fetched: 0, error: 'bad JSON' };
  }

  function writeSlowCacheEntry(field, ticker, value) {
    const key = slowKey_(field, ticker);
    const record = { date: todayKey_(), value: value };
    pendingWrites[key] = JSON.stringify(record);
    slowCache[key] = record;
  }

  const results = json.results || {};
  let barsCount = 0, analystCount = 0, qualityCount = 0, catalystCount = 0;

  Object.keys(results).forEach(function (ticker) {
    const data = results[ticker];
    if (!data) return;
    if (data.bars && data.bars.length) { writeSlowCacheEntry('DAILYBARS', ticker, data.bars); barsCount++; }
    if (data.analyst) { writeSlowCacheEntry('ANALYST', ticker, data.analyst); analystCount++; }
    if (data.quality != null) { writeSlowCacheEntry('QUALITY', ticker, data.quality); qualityCount++; }
    if (data.catalyst) { writeSlowCacheEntry('CATALYST', ticker, data.catalyst); catalystCount++; }
  });

  const elapsedMs = Date.now() - startTime;
  const errorEntries = Object.entries(json.errors || {});
  const errorPreview = errorEntries.slice(0, 5).map(function (e) { return e[0] + ': ' + e[1]; }).join(' | ') +
    (errorEntries.length > 5 ? ' | ...' : '');
  logToSheet_('Cloud Function prefetch: ' + staleTickers.length + ' tickers requested in ' + elapsedMs + 'ms \u2014 bars: ' +
    barsCount + ', analyst: ' + analystCount + ', quality: ' + qualityCount + ', catalyst: ' + catalystCount +
    (errorEntries.length ? (' \u2014 ' + errorEntries.length + ' ticker error(s): ' + errorPreview) : '') + '.');

  // Sample failure reason per data type (one example across the whole
  // batch, not per-ticker) — only present if that type actually failed
  // for at least one ticker. This is what actually tells you WHY
  // analyst/quality/catalyst came back at 0, instead of just that they did.
  const diag = json.diagnostics || {};
  const diagParts = [];
  if (diag.analyst) diagParts.push('analyst: ' + diag.analyst);
  if (diag.quality) diagParts.push('quality: ' + diag.quality);
  if (diag.catalyst) diagParts.push('catalyst: ' + diag.catalyst);
  if (diagParts.length) {
    logToSheet_('Cloud Function prefetch \u2014 sample failure reason(s): ' + diagParts.join(' | '));
  }

  return { attempted: true, fetched: barsCount, requested: staleTickers.length, errors: json.errors || {} };
}


function runDailyResearch(timeBudgetMsOverride) {
  const ui = tryGetUi_();
  const scriptStartTime = Date.now();
  const timeBudgetMs = timeBudgetMsOverride || RESEARCH_EXECUTION_TIME_BUDGET_MS;

  // Universe = curated pool + whatever's currently on all three tabs,
  // deduped. Current holdings are always in the running, never excluded.
  const universeSet = {};
  RESEARCH_UNIVERSE.forEach(function (t) { universeSet[t] = true; });
  ['Quick', 'Risky', 'Leap'].forEach(function (tabName) {
    collectCurrentTabTickers_(tabName).forEach(function (t) { if (t) universeSet[t] = true; });
  });
  const candidateTickers = Object.keys(universeSet);

  const finnhubApiKey = getFinnhubApiKey_();
  const fmpApiKey = getFmpApiKey_();
  const alphaVantageApiKey = getAlphaVantageApiKey_();
  const slowCache = loadSlowCache_();
  const pendingWrites = {};

  // Cloud Function batch prefetch: fetches daily bars for every ticker
  // that actually needs a fresh one (SPY included) in ONE request,
  // concurrently, on the Cloud Function's side, instead of one Yahoo
  // call per ticker here. Writes straight into the same slow cache the
  // per-ticker loop below already reads from — so if this succeeds,
  // every ticker's DAILYBARS lookup downstream is a clean cache hit with
  // no other code needing to change. If the Cloud Function isn't
  // configured yet, or the call fails for any reason, this quietly does
  // nothing and the loop below falls back to fetching one-by-one via
  // Yahoo directly, exactly as it always has — never a hard failure.
  prefetchDailyBarsViaCloudFunction_(candidateTickers.concat(['SPY']), slowCache, pendingWrites);

  // SPY bars shared across every candidate (RS calc), same cache
  // namespace Momentum.gs's own Market Regime calc already uses.
  const spyBarsResult = getSlowCached_(slowCache, pendingWrites, 'DAILYBARS', 'SPY', SLOW_REFRESH_DAYS.DAILYBARS, function () {
    return fetchYahooDailyBars_('SPY');
  });
  const spyBars = spyBarsResult.value;

  const scored = [];
  let processed = 0;
  let timeBudgetExceeded = false;

  for (let i = 0; i < candidateTickers.length; i++) {
    if (Date.now() - scriptStartTime > timeBudgetMs) { timeBudgetExceeded = true; break; }
    const ticker = candidateTickers[i];
    const inputs = gatherResearchInputs_(ticker, spyBars, finnhubApiKey, fmpApiKey, alphaVantageApiKey, slowCache, pendingWrites);
    processed++;
    if (inputs && !inputs.unusable) scored.push(inputs);
    // Only throttle when a real network call actually happened for this
    // ticker — a same-day rerun where most tickers hit the cache cleanly
    // shouldn't pay 100ms of pure waiting per ticker for nothing.
    if (inputs.fetchAttempted) Utilities.sleep(100);
  }

  flushSlowCacheWrites_(pendingWrites);

  const tabs = ['Quick', 'Risky', 'Leap'];
  const picks = {};
  const nearMisses = {};
  tabs.forEach(function (tabName) {
    // Quick and Leap are restricted to large/mega-cap only — Risky is
    // deliberately unrestricted (it needs genuine volatility to hit its
    // objective in 7-14 days, which large/mega-caps structurally lack).
    const eligible = (tabName === 'Risky') ? scored : scored.filter(function (inputs) { return inputs.isLargeOrMegaCap; });
    const ranked = eligible
      .map(function (inputs) {
        return { ticker: inputs.ticker, score: computeResearchScoreForTab_(tabName, inputs), reason: buildResearchReason_(tabName, inputs) };
      })
      .sort(function (a, b) { return b.score - a.score; });
    picks[tabName] = ranked.slice(0, RESEARCH_TOP_N);
    nearMisses[tabName] = ranked.slice(RESEARCH_TOP_N, RESEARCH_TOP_N + RESEARCH_NEAR_MISS_COUNT);
  });

  // Compared against the LAST research run (any prior run, not "yesterday"
  // specifically) — appropriate since this is meant to run multiple times
  // a day, not once daily.
  const props = PropertiesService.getScriptProperties();
  const changes = {};
  tabs.forEach(function (tabName) {
    const prevRaw = props.getProperty('RESEARCH_LAST_' + tabName.toUpperCase());
    const prevTickers = prevRaw ? JSON.parse(prevRaw) : [];
    const currentTickers = picks[tabName].map(function (p) { return p.ticker; });
    changes[tabName] = {
      added: currentTickers.filter(function (t) { return prevTickers.indexOf(t) === -1; }),
      removed: prevTickers.filter(function (t) { return currentTickers.indexOf(t) === -1; })
    };
    props.setProperty('RESEARCH_LAST_' + tabName.toUpperCase(), JSON.stringify(currentTickers));
  });

  writeResearchSheet_(picks, nearMisses, changes, timeBudgetExceeded, processed, candidateTickers.length);

  notify_(ui, 'Daily Research complete',
    (timeBudgetExceeded
      ? '\u23f1\ufe0f Stopped early \u2014 scored ' + processed + ' of ' + candidateTickers.length + ' candidates. Run again to complete the pass (already-scored tickers are cached and will be fast).\n\n'
      : '') +
    'Candidates scored: ' + processed + ' of ' + candidateTickers.length + '\n\n' +
    'Quick: ' + changes.Quick.added.length + ' added, ' + changes.Quick.removed.length + ' removed\n' +
    'Risky: ' + changes.Risky.added.length + ' added, ' + changes.Risky.removed.length + ' removed\n' +
    'Leap: ' + changes.Leap.added.length + ' added, ' + changes.Leap.removed.length + ' removed\n\n' +
    'See the Research tab for the full lists, scores, and reasons.'
  );

  // Lets DailyPipeline.gs know whether to re-run this stage (stopped
  // early) or move on — safe, additive: nothing before this used the
  // return value at all.
  return { timeBudgetExceeded: timeBudgetExceeded };
}