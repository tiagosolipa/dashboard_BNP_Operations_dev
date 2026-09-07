// ============================================================
// BNP Paribas Securities — Synthetic Transaction Data Generator
// v5 — Temporally coherent: cut-off always after workflow entry,
//       realistic overdue durations (15min–3h max)
// ============================================================

// NOW anchored to real current system time
const NOW = new Date();

// ── User Profiles ─────────────────────────────────────────────
const USER_PROFILES = [
  { id: "ops-manager", name: "Ops Manager", initials: "OP", role: "Operations Manager", avatarClass: "op" },
  { id: "project-manager", name: "Project Manager", initials: "PM", role: "Project Manager", avatarClass: "pm" },
];

window.USER_PROFILES = USER_PROFILES;
window.activeUser = USER_PROFILES[0]; // Default to Ops Manager
window.auditLog = []; // Global audit trail

const ASSET_TYPES = ["Cash", "FX", "Derivatives", "Money Markets", "Securities"];
const STAGES = ["Capture", "Confirmation", "Settlement", "Reconciliation", "Completed"];

const CLIENTS = [
  "Allianz Global Investors", "BlackRock Asset Mgmt", "Amundi Asset Management",
  "AXA Investment Managers", "Deutsche Bank AG", "HSBC Global Banking",
  "JPMorgan Asset Management", "Santander Asset Mgmt", "Vanguard Europe",
  "Generali Investments", "Aviva Investors", "Fidelity International",
  "Pictet Asset Management", "Credit Suisse AM", "UBS Asset Management"
];

const CLIENT_IDS = {
  "Allianz Global Investors": "CLI-001",
  "BlackRock Asset Mgmt":     "CLI-002",
  "Amundi Asset Management":  "CLI-003",
  "AXA Investment Managers":  "CLI-004",
  "Deutsche Bank AG":         "CLI-005",
  "HSBC Global Banking":      "CLI-006",
  "JPMorgan Asset Management":"CLI-007",
  "Santander Asset Mgmt":     "CLI-008",
  "Vanguard Europe":          "CLI-009",
  "Generali Investments":     "CLI-010",
  "Aviva Investors":          "CLI-011",
  "Fidelity International":   "CLI-012",
  "Pictet Asset Management":  "CLI-013",
  "Credit Suisse AM":         "CLI-014",
  "UBS Asset Management":     "CLI-015",
};

const CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CHF"];
const FX_TO_EUR  = { USD: 0.92, EUR: 1.0, GBP: 1.17, JPY: 0.006, CHF: 1.04 };

const NOTIONAL_RANGES = {
  Cash:            [500000,  20000000],
  FX:              [1000000, 50000000],
  Derivatives:     [2000000, 80000000],
  "Money Markets": [1000000, 30000000],
  Securities:      [500000,  15000000],
};

// ── Realistic SLA stage durations (minutes) ──────────────────
const STAGE_SLA = {
  Capture:        { normal: [5,  45],  delay: [60,  180] },
  Confirmation:   { normal: [20, 150], delay: [180, 360] },
  Settlement:     { normal: [40, 320], delay: [360, 480] },
  Reconciliation: { normal: [20, 90],  delay: [100, 180] },
};

const ASSET_MULTIPLIER = {
  Cash: 0.7, FX: 0.9, Derivatives: 1.4, "Money Markets": 1.0, Securities: 1.2,
};

const STAGE_RISK_WEIGHT = {
  Settlement: 20, Reconciliation: 15, Confirmation: 10, Capture: 5, Completed: 0,
};

// ── Seeded PRNG (Mulberry32) — deterministic within same calendar day ──
const _daySeed = NOW.getFullYear() * 10000 + (NOW.getMonth() + 1) * 100 + NOW.getDate();
let _seed = _daySeed;
function mulberry32() {
  _seed |= 0; _seed = _seed + 0x6D2B79F5 | 0;
  var t = Math.imul(_seed ^ _seed >>> 15, 1 | _seed);
  t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
  return ((t ^ t >>> 14) >>> 0) / 4294967296;
}
const seededRandom = mulberry32;

// ── Helpers ───────────────────────────────────────────────────
function randInt(min, max) { return Math.floor(seededRandom() * (max - min + 1)) + min; }
function randItem(arr)     { return arr[Math.floor(seededRandom() * arr.length)]; }
function addMinutes(date, mins) { return new Date(date.getTime() + mins * 60000); }

function formatDuration(mins) {
  if (mins == null || isNaN(mins)) return "—";
  if (mins <= 0) return "0m";
  if (mins < 60) return mins + "m";
  var h = Math.floor(mins / 60), m = mins % 60;
  return m === 0 ? h + "h" : h + "h " + m + "m";
}

function fmtDateTime(d) {
  if (!d) return null;
  return d.toLocaleString("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", hour12: false
  }).replace(",", "");
}

function stageDuration(stageName, mult, isDelay) {
  const sla = STAGE_SLA[stageName];
  if (!sla) return 30;
  if (isDelay) return randInt(sla.delay[0], sla.delay[1]);
  const base = randInt(sla.normal[0], sla.normal[1]);
  return Math.round(Math.min(base * mult, sla.normal[1] * mult));
}

function pickWeighted(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = seededRandom() * total, cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (r < cum) return i;
  }
  return weights.length - 1;
}

// ── Today anchor (midnight) ──────────────────────────────────
const TODAY_MIDNIGHT = new Date(NOW);
TODAY_MIDNIGHT.setHours(0, 0, 0, 0);

// ── Rolling trade-day window ─────────────────────────────────
// Days relative to today: -4, -3, -2, -1, 0, +1
const TRADE_DAY_OFFSETS = [-4, -3, -2, -1, 0, 1];
function buildTradeDayWeights() {
  const base = [6, 10, 15, 22, 35, 12];
  return TRADE_DAY_OFFSETS.map((offset, i) => {
    const d = new Date(TODAY_MIDNIGHT);
    d.setDate(d.getDate() + offset);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return Math.max(2, Math.round(base[i] * 0.25));
    return base[i];
  });
}
const TRADE_DAY_WEIGHTS = buildTradeDayWeights();

// ── Age-correlated stage distribution ────────────────────────
// Older trades → more advanced stages; newer trades → earlier stages
function getStageWeightsForAge(dayOffset) {
  if (dayOffset <= -3) return [2,  5,  8, 15, 70];
  if (dayOffset === -2) return [3,  8, 15, 30, 44];
  if (dayOffset === -1) return [8, 15, 25, 28, 24];
  if (dayOffset === 0)  return [25, 30, 22, 15, 8];
  return [40, 30, 18, 8, 4];
}

// ── Main transaction generator ───────────────────────────────
function generateTransaction(id) {
  const asset    = randItem(ASSET_TYPES);
  const client   = randItem(CLIENTS);
  const clientId = CLIENT_IDS[client] || "CLI-000";
  const mult     = ASSET_MULTIPLIER[asset];

  // Financial dimensions
  const currency    = randItem(CURRENCIES);
  const [minN, maxN] = NOTIONAL_RANGES[asset];
  const notional    = Math.round(randInt(minN / 1000, maxN / 1000) * 1000);
  const notionalEUR = Math.round(notional * FX_TO_EUR[currency]);

  // Trade date: pick a day from the rolling window
  const tradeDayIdx = pickWeighted(TRADE_DAY_WEIGHTS);
  const tradeDayOffset = TRADE_DAY_OFFSETS[tradeDayIdx];
  const tradeDayBase = new Date(TODAY_MIDNIGHT);
  tradeDayBase.setDate(tradeDayBase.getDate() + tradeDayOffset);
  const tradeHourOffset = randInt(7 * 60 + 30, 18 * 60);
  const tradeDate = addMinutes(tradeDayBase, tradeHourOffset);

  // Lifecycle stage — correlated with trade age
  const stageWeights = getStageWeightsForAge(tradeDayOffset);
  const stageIndex = pickWeighted(stageWeights);
  const currentStage = STAGES[stageIndex];

  // 5–8% chance of operational delay
  const isDelay = seededRandom() < 0.07;

  // Build timestamps with realistic durations
  const timestamps = {};
  let cursor = tradeDate;

  for (let s = 0; s <= stageIndex; s++) {
    const stageName = STAGES[s];
    timestamps[stageName] = { entry: new Date(cursor) };

    if (s < stageIndex) {
      const minsLeft = Math.max(2, Math.round((NOW - cursor) / 60000));
      const remainingStages = stageIndex - s;
      const maxForThisStage = Math.floor(minsLeft / (remainingStages + 1));
      let dur = stageDuration(stageName, mult, isDelay && s === stageIndex - 1);
      dur = Math.max(1, Math.min(dur, maxForThisStage));
      cursor = addMinutes(cursor, dur);
      timestamps[stageName].exit     = new Date(cursor);
      timestamps[stageName].duration = dur;
    } else if (stageName !== "Completed") {
      const elapsedSoFar = Math.max(0, Math.round((NOW - cursor) / 60000));
      timestamps[stageName].duration = elapsedSoFar;
      timestamps[stageName].exit     = null;
    } else {
      const dur = stageDuration("Reconciliation", mult, false);
      const cappedDur = Math.max(1, Math.min(dur, Math.max(1, Math.round((NOW - cursor) / 60000))));
      cursor = addMinutes(cursor, cappedDur);
      timestamps[stageName].exit     = new Date(cursor);
      timestamps[stageName].duration = cappedDur;
    }
  }

  // ── Cut-off — ALWAYS after last workflow entry ─────────────
  // The cut-off is the deadline for the current active stage to complete.
  // It must be chronologically AFTER the entry into the current stage.
  let cutoff = null;
  let minutesToCutoff = 9999;
  if (currentStage !== "Completed") {
    // The earliest the cut-off can be is after the current stage entry
    const currentEntry = timestamps[currentStage].entry;

    // Add a realistic buffer: the cut-off is currentEntry + SLA allowance + margin
    // This ensures cut-off > capture/trade date always
    const sla = STAGE_SLA[currentStage];
    const slaMax = sla ? sla.normal[1] : 120;
    const marginMin = Math.round(slaMax * mult); // typical max time for this stage
    const extraMargin = randInt(30, 240);         // 30min–4h additional slack

    cutoff = addMinutes(currentEntry, marginMin + extraMargin);

    // Round to a clean minute boundary
    cutoff.setSeconds(0, 0);

    minutesToCutoff = Math.round((cutoff.getTime() - NOW.getTime()) / 60000);

    // ── Cap overdue at realistic durations (max 3h) ─────────
    // For old trades whose SLA-based cutoff is far in the past,
    // push the cutoff forward so overdue is at most 15–180 minutes.
    // This keeps the dashboard operationally credible.
    if (minutesToCutoff < -170) {
      // Pick a realistic small overdue: 15–170 min
      const realisticOverdue = randInt(15, 170);
      cutoff = new Date(NOW.getTime() - realisticOverdue * 60000);
      cutoff.setSeconds(0, 0);
      // Ensure cutoff is still after trade date (chronological safety)
      if (cutoff.getTime() < currentEntry.getTime()) {
        cutoff = addMinutes(currentEntry, randInt(30, 120));
        cutoff.setSeconds(0, 0);
      }
      minutesToCutoff = Math.round((cutoff.getTime() - NOW.getTime()) / 60000);
    }
  }

  // ── Risk status from cut-off proximity ────────────────────
  let riskStatus = "ok";
  if (currentStage !== "Completed" && cutoff) {
    if (minutesToCutoff < 0)        riskStatus = "overdue";
    else if (minutesToCutoff < 120) riskStatus = "critical";
    else if (minutesToCutoff < 240) riskStatus = "warning";
  }

  // ── Alert suppression: cap alerts at ~10% ─────────────────
  let finalRisk = riskStatus;
  let alertSuppressed = false;
  if (currentStage === "Completed") {
    finalRisk = "ok";
  } else if (riskStatus !== "ok" && seededRandom() < 0.93) {
    finalRisk = "ok";
    alertSuppressed = true;
  }

  // Risk score
  const timeScore  = { overdue: 50, critical: 35, warning: 15, ok: 0 }[finalRisk] ?? 0;
  const valM       = notionalEUR / 1000000;
  const valueScore = Math.min(30, Math.round(Math.log10(Math.max(1, valM) + 1) * 20));
  const stageScore = STAGE_RISK_WEIGHT[currentStage] ?? 0;
  const riskScore  = Math.min(100, timeScore + Math.max(0, valueScore) + stageScore);
  const priority   = riskScore >= 65 ? "high" : riskScore >= 35 ? "medium" : "low";

  // Alert reason
  let alertReason = "";
  if (finalRisk === "overdue")      alertReason = formatDuration(Math.abs(minutesToCutoff)) + " overdue";
  else if (finalRisk === "critical") alertReason = formatDuration(minutesToCutoff) + " to cut-off";
  else if (finalRisk === "warning")  alertReason = formatDuration(minutesToCutoff) + " to cut-off";

  const manualIntervention = finalRisk !== "ok" ? seededRandom() < 0.45 : seededRandom() < 0.03;
  const isSTP = !manualIntervention && finalRisk === "ok" && seededRandom() < 0.72;

  let totalDuration = 0;
  STAGES.forEach(s => { if (timestamps[s]) totalDuration += (timestamps[s].duration || 0); });

  return {
    id: `TXN-${String(id).padStart(5, "0")}`,
    asset, client, currentStage, stageIndex, timestamps, tradeDate,
    cutoff: alertSuppressed ? null : (finalRisk === "ok" && currentStage === "Completed" ? null : cutoff),
    minutesToCutoff: alertSuppressed ? 9999 : minutesToCutoff,
    riskStatus: finalRisk,
    _alertSuppressed: alertSuppressed,
    manualIntervention, isSTP, totalDuration,
    currency, notional, notionalEUR,
    clientId,
    riskScore, priority, alertReason,
    activityHistory: [],  // Will be seeded below
    lastModifiedBy: null,
    lastModifiedAt: null,
  };
}

// ── Generate dataset (400 transactions) ───────────────────────
const seed = [];
for (let i = 1; i <= 400; i++) seed.push(generateTransaction(i));

// ── Inject guaranteed alert scenarios ─────────────────────────
// Small, controlled set of alerts with REALISTIC overdue durations.
// Overdue: 15min–3h. Critical: 20–90min. Warning: 2–3.5h.
// Total injected: ~15 txns / 400 = ~3.75%

// Helper: ensure cut-off is after trade date for injected txns
function injectCutoffSafe(tx, cutoffDate) {
  // Guarantee chronological sanity: cutoff must be after trade date
  if (cutoffDate.getTime() <= tx.tradeDate.getTime()) {
    // Push cutoff to at least 1h after trade date
    cutoffDate = addMinutes(tx.tradeDate, 60);
  }
  return cutoffDate;
}

// Inject overdue scenarios (5 txns — realistic 15min–3h overdue)
const injectOverdue = [11, 52, 128, 225, 370];
const OVERDUE_MINUTES = [15, 35, 72, 105, 165]; // controlled overdue durations
injectOverdue.forEach((idx, i) => {
  if (!seed[idx]) return;
  const tx = seed[idx];
  if (tx.currentStage === "Completed") {
    tx.currentStage = "Settlement";
    tx.stageIndex = 2;
  }
  tx._alertSuppressed = false;
  tx.riskStatus = "overdue";

  // Cut-off = NOW minus a small, realistic overdue duration
  const overdueMin = OVERDUE_MINUTES[i];
  let co = new Date(NOW.getTime() - overdueMin * 60000);
  co = injectCutoffSafe(tx, co);
  tx.cutoff = co;
  tx.minutesToCutoff = Math.round((co.getTime() - NOW.getTime()) / 60000);
  tx.manualIntervention = true;
  tx.isSTP = false;
  tx.alertReason = formatDuration(Math.abs(tx.minutesToCutoff)) + " overdue";
  const ts = 50, ss = STAGE_RISK_WEIGHT[tx.currentStage] ?? 0;
  const vs = Math.min(30, Math.round(Math.log10(Math.max(1, tx.notionalEUR / 1000000) + 1) * 20));
  tx.riskScore = Math.min(100, ts + Math.max(0, vs) + ss);
  tx.priority = tx.riskScore >= 65 ? "high" : tx.riskScore >= 35 ? "medium" : "low";
});

// Inject critical scenarios (6 txns — 20–90 min to cut-off)
const injectCritical = [18, 60, 93, 155, 260, 350];
const CRITICAL_MINUTES = [22, 38, 55, 42, 68, 85];
injectCritical.forEach((idx, i) => {
  if (!seed[idx]) return;
  const tx = seed[idx];
  if (tx.currentStage === "Completed") {
    tx.currentStage = "Confirmation";
    tx.stageIndex = 1;
  }
  tx._alertSuppressed = false;
  tx.riskStatus = "critical";
  const critMinutes = CRITICAL_MINUTES[i];
  let co = new Date(NOW.getTime() + critMinutes * 60000);
  co = injectCutoffSafe(tx, co);
  tx.cutoff = co;
  tx.minutesToCutoff = Math.round((co.getTime() - NOW.getTime()) / 60000);
  tx.manualIntervention = seededRandom() < 0.5;
  tx.alertReason = formatDuration(tx.minutesToCutoff) + " to cut-off";
  const ts = 35, ss = STAGE_RISK_WEIGHT[tx.currentStage] ?? 0;
  const vs = Math.min(30, Math.round(Math.log10(Math.max(1, tx.notionalEUR / 1000000) + 1) * 20));
  tx.riskScore = Math.min(100, ts + Math.max(0, vs) + ss);
  tx.priority = tx.riskScore >= 65 ? "high" : tx.riskScore >= 35 ? "medium" : "low";
});

// Inject warning scenarios (4 txns — 2–3.5 hours to cut-off)
const injectWarning = [42, 110, 275, 390];
const WARNING_MINUTES = [135, 155, 190, 210];
injectWarning.forEach((idx, i) => {
  if (!seed[idx]) return;
  const tx = seed[idx];
  if (tx.currentStage === "Completed") {
    tx.currentStage = "Settlement";
    tx.stageIndex = 2;
  }
  tx._alertSuppressed = false;
  tx.riskStatus = "warning";
  const warnMin = WARNING_MINUTES[i];
  let co = new Date(NOW.getTime() + warnMin * 60000);
  co = injectCutoffSafe(tx, co);
  tx.cutoff = co;
  tx.minutesToCutoff = Math.round((co.getTime() - NOW.getTime()) / 60000);
  tx.manualIntervention = seededRandom() < 0.3;
  tx.alertReason = formatDuration(tx.minutesToCutoff) + " to cut-off";
  const ts = 15, ss = STAGE_RISK_WEIGHT[tx.currentStage] ?? 0;
  const vs = Math.min(30, Math.round(Math.log10(Math.max(1, tx.notionalEUR / 1000000) + 1) * 20));
  tx.riskScore = Math.min(100, ts + Math.max(0, vs) + ss);
  tx.priority = tx.riskScore >= 65 ? "high" : tx.riskScore >= 35 ? "medium" : "low";
});
// ── Seed Activity History ─────────────────────────────────────
// Populate synthetic audit entries for transactions that have
// progressed through stages, so the Activity History isn't empty.
seed.forEach(tx => {
  const history = [];
  const actorNames = ["Ops Manager", "Project Manager"];
  const actorInitials = ["OP", "PM"];
  const actorClasses = ["op", "pm"];
  const STAGE_LIST = ["Capture", "Confirmation", "Settlement", "Reconciliation", "Completed"];

  // For each completed stage transition, add a workflow entry
  for (let s = 0; s < tx.stageIndex; s++) {
    const fromStage = STAGE_LIST[s];
    const toStage = STAGE_LIST[s + 1];
    const ts = tx.timestamps[fromStage];
    if (ts && ts.exit) {
      // Alternate between users for realism
      const actorIdx = (s + (parseInt(tx.id.replace("TXN-", ""), 10) % 2)) % 2;
      history.push({
        user: actorNames[actorIdx],
        initials: actorInitials[actorIdx],
        avatarClass: actorClasses[actorIdx],
        action: "Advanced to " + toStage,
        txId: tx.id,
        timestamp: new Date(ts.exit),
        prevStatus: fromStage,
        newStatus: toStage,
      });
    }
  }

  // For some transactions add an additional action (review/approve)
  if (tx.stageIndex >= 2 && tx.timestamps["Confirmation"] && tx.timestamps["Confirmation"].exit) {
    const aIdx = parseInt(tx.id.replace("TXN-", ""), 10) % 2;
    history.push({
      user: actorNames[aIdx],
      initials: actorInitials[aIdx],
      avatarClass: actorClasses[aIdx],
      action: "Approved transaction",
      txId: tx.id,
      timestamp: new Date(tx.timestamps["Confirmation"].exit.getTime() - 60000),
      prevStatus: "Confirmation",
      newStatus: "Settlement",
    });
  }

  // Sort by timestamp (oldest first, will be reversed in display)
  history.sort((a, b) => a.timestamp - b.timestamp);
  tx.activityHistory = history;

  // Set lastModifiedBy from the most recent entry
  if (history.length > 0) {
    const last = history[history.length - 1];
    tx.lastModifiedBy = last.user;
    tx.lastModifiedAt = last.timestamp;
  }
});

window.TRANSACTIONS = seed;
window.NOW_TS = NOW;

// Expected stage durations and asset scaling — read by the predictive
// engine so its forecasts use the same SLA basis as the generator.
window.STAGE_SLA = STAGE_SLA;
window.ASSET_MULTIPLIER = ASSET_MULTIPLIER;
window.STAGE_RISK_WEIGHT = STAGE_RISK_WEIGHT;

// ── Dynamic Risk Recalculation ────────────────────────────────
// Recomputes all time-sensitive fields for every transaction based on
// the REAL current system time — called before each render and on a
// periodic interval so that overdue/countdown values stay live.
window.recalculateRiskData = function() {
  const now = new Date();
  window.NOW_TS = now;

  window.TRANSACTIONS.forEach(function(tx) {
    // Skip completed transactions — they have no risk
    if (tx.currentStage === "Completed") {
      tx.riskStatus = "ok";
      tx.alertReason = "";
      return;
    }

    // Skip transactions whose alerts were suppressed during generation
    if (tx._alertSuppressed) {
      tx.riskStatus = "ok";
      tx.alertReason = "";
      return;
    }

    // No cut-off defined
    if (!tx.cutoff) {
      tx.minutesToCutoff = 9999;
      tx.riskStatus = "ok";
      tx.alertReason = "No cut-off defined";
      return;
    }

    // Dynamic minutesToCutoff
    var diffMs = tx.cutoff.getTime() - now.getTime();
    var diffMin = Math.round(diffMs / 60000);
    tx.minutesToCutoff = diffMin;

    if (diffMin < 0)        tx.riskStatus = "overdue";
    else if (diffMin < 120) tx.riskStatus = "critical";
    else if (diffMin < 240) tx.riskStatus = "warning";
    else                    tx.riskStatus = "ok";

    // Build dynamic alert reason string
    if (tx.riskStatus === "overdue") {
      tx.alertReason = formatDuration(Math.abs(diffMin)) + " overdue";
    } else if (tx.riskStatus === "critical") {
      tx.alertReason = formatDuration(Math.max(0, diffMin)) + " to cut-off";
    } else if (tx.riskStatus === "warning") {
      tx.alertReason = formatDuration(diffMin) + " to cut-off";
    } else {
      tx.alertReason = "";
    }

    // Recalculate risk score
    var timeScore  = { overdue: 50, critical: 35, warning: 15, ok: 0 }[tx.riskStatus] || 0;
    var valM       = tx.notionalEUR / 1000000;
    var valueScore = Math.min(30, Math.round(Math.log10(Math.max(1, valM) + 1) * 20));
    var stageScore = STAGE_RISK_WEIGHT[tx.currentStage] || 0;
    tx.riskScore   = Math.min(100, timeScore + Math.max(0, valueScore) + stageScore);
    tx.priority    = tx.riskScore >= 65 ? "high" : tx.riskScore >= 35 ? "medium" : "low";

    // Keep manualIntervention flag in sync with risk status
    if (tx.riskStatus === "overdue") {
      tx.manualIntervention = true;
      tx.isSTP = false;
    }
  });
};

// Run initial recalculation so data is aligned with real time at load
window.recalculateRiskData();

// ── Shared Formatters (expose to dashboard.js) ────────────────
window.formatDuration = formatDuration;
window.fmtDateTime    = fmtDateTime;

window.formatNotional = function(val, currency) {
  if (val >= 1000000) return `${currency} ${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000)     return `${currency} ${(val / 1000).toFixed(0)}K`;
  return `${currency} ${val}`;
};

window.formatEUR = function(val) {
  if (val >= 1000000) return `€ ${(val / 1000000).toFixed(1)}M`;
  if (val >= 1000)     return `€ ${(val / 1000).toFixed(0)}K`;
  return `€ ${val}`;
};

window.formatTimeToSettlement = function(tx) {
  if (tx.currentStage === "Completed") return "Settled";
  if (!tx.cutoff) return "No cut-off defined";
  var now = new Date();
  var diffMin = Math.round((tx.cutoff.getTime() - now.getTime()) / 60000);
  if (diffMin < 0) return formatDuration(Math.abs(diffMin)) + " overdue";
  if (diffMin === 0) return "0m to cut-off";
  return formatDuration(diffMin) + " to cut-off";
};
