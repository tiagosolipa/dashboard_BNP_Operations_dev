// ============================================================
// BNP Paribas Securities — Predictive Operations Engine
//
// The Risk & Alert Monitor is reactive by construction: a transaction
// only appears there once riskStatus is already "critical" (<2h to
// cut-off) or "overdue". This layer looks forward instead, by comparing
// how long a transaction has ALREADY spent in its current stage against
// how long that stage is expected to take, and asking whether the work
// still outstanding fits in the time left before cut-off.
//
// There is no model file and nothing is random: every probability is a
// deterministic function of fields already on the transaction, and every
// number shown in the "why" breakdown is a term of that function.
// ============================================================

"use strict";

(function () {
  // ── Tuning ─────────────────────────────────────────────────
  // Allowances are added to the outstanding work estimate. They express
  // handling cost that the raw stage SLA does not cover.
  const MANUAL_ALLOWANCE   = 45;   // A human has to pick the item up
  const NON_STP_ALLOWANCE  = 15;   // Non-STP items need touch points
  const CONGESTION_PER     = 25;   // Every N transactions queued in a stage…
  const CONGESTION_STEP    = 5;    // …costs this many extra minutes
  const CONGESTION_CAP     = 30;
  // Work still outstanding once a stage is past its expected duration.
  // A flat residual would make a transaction stuck for a day look SAFER
  // than one that just arrived, because "nearly done" beats "a full stage
  // to go". Overrunning predicts more delay, not less, so the residual
  // grows with the overrun instead: a floor of MIN_WORK_SHARE of the
  // stage, plus OVERRUN_DRAG of every minute already overrun, capped at a
  // full stage. The two branches meet exactly at the SLA line, so the
  // estimate is continuous and cannot jump on a refresh.
  const MIN_WORK_SHARE     = 0.10;
  const OVERRUN_DRAG       = 0.15;
  // Cut-off windows narrower than this share of the expected stage
  // duration are structurally impossible rather than merely at risk.
  const SHORT_WINDOW_RATIO = 0.60;
  // A stage running this many times its expected duration, with no
  // cut-off on the record, is treated as stalled. Set high deliberately:
  // aged trades routinely sit in a stage for days, so a low bar flags most
  // of the book instead of the items worth looking at.
  const STALL_RATIO        = 8.0;

  const PROB_FLOOR = 2;
  const PROB_CEIL  = 98;

  // Probability thresholds
  const P_LIKELY   = 50;   // "likely to miss"
  const P_WATCH    = 40;   // worth showing on the watchlist
  const P_NOTIFY   = 80;   // notification threshold

  const STAGE_ORDER = ["Capture", "Confirmation", "Settlement", "Reconciliation", "Completed"];

  // ── Category definitions ───────────────────────────────────
  const CATEGORIES = {
    "breached":     { label: "Cut-off missed",   short: "Missed",       cls: "pf-breached" },
    "miss-cutoff":  { label: "Miss cut-off",     short: "Miss cut-off", cls: "pf-miss" },
    "short-window": { label: "Window too short", short: "Short window", cls: "pf-window" },
    "stalled":      { label: "Stalled in stage", short: "Stalled",      cls: "pf-stalled" },
    "overrun":      { label: "Stage overrun",    short: "Overrun",      cls: "pf-overrun" },
    "intervention": { label: "Needs intervention", short: "Manual",     cls: "pf-manual" },
    "on-track":     { label: "On track",         short: "On track",     cls: "pf-ok" },
  };

  function severityOf(p) {
    if (p >= 85) return "critical";
    if (p >= 65) return "high";
    if (p >= 40) return "medium";
    return "low";
  }

  // ── Helpers ────────────────────────────────────────────────
  function logistic(x, scale) { return 1 / (1 + Math.exp(-x / scale)); }
  function clampProb(p) { return Math.max(PROB_FLOOR, Math.min(PROB_CEIL, Math.round(p))); }

  function expectedStageMinutes(tx) {
    const sla = (window.STAGE_SLA || {})[tx.currentStage];
    if (!sla) return 60;
    const mult = (window.ASSET_MULTIPLIER || {})[tx.asset] || 1;
    return sla.normal[1] * mult;
  }

  // Queue depth per stage, recomputed once per pass rather than per row.
  let queueDepth = {};
  function computeQueueDepth() {
    queueDepth = {};
    (window.TRANSACTIONS || []).forEach(function (tx) {
      if (tx.currentStage === "Completed") return;
      queueDepth[tx.currentStage] = (queueDepth[tx.currentStage] || 0) + 1;
    });
  }

  function congestionAllowance(stage) {
    const depth = queueDepth[stage] || 0;
    return Math.min(CONGESTION_CAP, Math.floor(depth / CONGESTION_PER) * CONGESTION_STEP);
  }

  // Minutes of work still expected in the current stage. Falls as the
  // stage progresses, then rises again once past the SLA, because an
  // overrun tells us the original estimate no longer holds.
  function estimateWorkLeft(elapsed, expected) {
    const floorWork = expected * MIN_WORK_SHARE;
    if (elapsed <= expected) return Math.max(floorWork, expected - elapsed);
    const drag = (elapsed - expected) * OVERRUN_DRAG;
    return Math.min(expected, Math.max(floorWork, floorWork + drag));
  }

  // ── Core forecast for one transaction ──────────────────────
  // Returns a plain object; nothing is cached on the transaction so a
  // forecast can never go stale relative to the data.
  function forecast(tx, now) {
    now = now || new Date();

    const base = {
      txId: tx.id,
      category: "on-track",
      probability: PROB_FLOOR,
      severity: "low",
      factors: [],
      recommendation: null,
      action: null,
      predictedFinishIn: null,
      minutesToCutoff: tx.minutesToCutoff,
      expected: 0,
      elapsed: 0,
    };

    if (tx.currentStage === "Completed") {
      base.note = "Settled — no further exposure";
      return base;
    }

    const expected = expectedStageMinutes(tx);
    const stamp    = tx.timestamps[tx.currentStage];
    const entry    = stamp && stamp.entry ? stamp.entry : now;
    const rawMin   = (now - entry) / 60000;
    // Trades dated tomorrow have a stage entry in the future: the stage
    // has not started, so nothing has elapsed and the wait counts as work.
    const elapsed  = Math.max(0, rawMin);
    const startsIn = Math.max(0, -rawMin);
    const overrunRatio = expected > 0 ? elapsed / expected : 0;

    base.expected = expected;
    base.elapsed  = elapsed;
    base.startsIn = startsIn;
    base.overrunRatio = overrunRatio;

    // An operator has already dealt with this one, or generation
    // suppressed its alert: there is no live cut-off to forecast against.
    const cleared = tx._alertSuppressed || !tx.cutoff;

    // ── Stalled: no cut-off on record, but far past expected duration ──
    if (cleared) {
      if (overrunRatio >= STALL_RATIO) {
        base.category = "stalled";
        base.probability = clampProb(100 * logistic(overrunRatio - STALL_RATIO, 2.5) * 0.9 + 10);
        base.severity = severityOf(base.probability);
        base.factors = [
          { label: "Time in " + tx.currentStage, value: fmt(elapsed), emphasis: true },
          { label: "Expected for " + tx.asset, value: fmt(expected) },
          { label: "Running at", value: Math.round(overrunRatio * 100) + "% of expected" },
          { label: "No cut-off on record", value: "not tracked by SLA alerts", muted: true },
        ];
        base.recommendation = "No deadline is tracking this item and it has been in " +
          tx.currentStage + " for " + fmt(elapsed) + ". Review it or advance the stage.";
        base.action = tx.manualIntervention ? "review" : "advance";
        return base;
      }
      base.note = tx.manualIntervention ? "Awaiting manual handling" : "Within expected stage duration";
      base.category = tx.manualIntervention ? "intervention" : "on-track";
      base.probability = tx.manualIntervention ? 25 : PROB_FLOOR;
      base.severity = severityOf(base.probability);
      return base;
    }

    // ── Already breached — a fact, not a forecast ─────────────
    if (tx.minutesToCutoff < 0) {
      base.category = "breached";
      base.probability = PROB_CEIL;
      base.severity = "critical";
      base.factors = [
        { label: "Cut-off passed", value: fmt(Math.abs(tx.minutesToCutoff)) + " ago", emphasis: true },
        { label: "Time in " + tx.currentStage, value: fmt(elapsed) },
        { label: "Expected for " + tx.asset, value: fmt(expected) },
      ];
      base.recommendation = "Cut-off has already passed — escalate or resolve now.";
      base.action = tx.manualIntervention ? "review" : "resolve";
      return base;
    }

    // ── Outstanding work estimate ────────────────────────────
    const workLeft = estimateWorkLeft(elapsed, expected);
    const manualAllow = tx.manualIntervention ? MANUAL_ALLOWANCE : 0;
    const stpAllow    = tx.isSTP ? 0 : NON_STP_ALLOWANCE;
    const congAllow   = congestionAllowance(tx.currentStage);

    const predictedFinishIn = startsIn + workLeft + manualAllow + stpAllow + congAllow;
    const shortfall = predictedFinishIn - tx.minutesToCutoff;
    const scale = Math.max(30, expected * 0.4);
    let p = clampProb(100 * logistic(shortfall, scale));

    base.predictedFinishIn = predictedFinishIn;
    base.shortfall = shortfall;
    base.workLeft = workLeft;

    // ── Build the "why": every row is a term of the estimate ──
    const factors = [];
    if (startsIn > 0) {
      factors.push({ label: "Stage starts in", value: fmt(startsIn), detail: "trade is dated ahead" });
    }
    factors.push({
      label: "Time in " + tx.currentStage,
      value: fmt(elapsed),
      detail: elapsed > expected ? Math.round(overrunRatio * 100) + "% of expected" : null,
      emphasis: elapsed > expected,
    });
    factors.push({ label: "Expected for " + tx.asset, value: fmt(expected) });
    factors.push({
      label: elapsed > expected ? "Residual work (overrunning)" : "Work still outstanding",
      value: fmt(workLeft),
      detail: elapsed > expected ? "grows with the overrun" : null,
    });
    if (manualAllow) factors.push({ label: "Manual intervention", value: "+" + fmt(manualAllow), detail: "requires a human touch" });
    if (stpAllow)    factors.push({ label: "Non-STP handling", value: "+" + fmt(stpAllow) });
    if (congAllow)   factors.push({ label: "Queue contention", value: "+" + fmt(congAllow), detail: (queueDepth[tx.currentStage] || 0) + " in " + tx.currentStage });
    factors.push({ label: "Predicted finish", value: "in " + fmt(predictedFinishIn), total: true });
    factors.push({ label: "Cut-off", value: "in " + fmt(tx.minutesToCutoff), total: true });
    factors.push({
      label: shortfall > 0 ? "Shortfall" : "Slack",
      value: fmt(Math.abs(shortfall)),
      emphasis: shortfall > 0,
      total: true,
    });
    base.factors = factors;

    // ── Categorise ───────────────────────────────────────────
    const cutoffWindow = Math.round((tx.cutoff - entry) / 60000);
    base.windowMinutes = cutoffWindow;

    if (cutoffWindow < expected * SHORT_WINDOW_RATIO) {
      // The deadline never allowed enough time for the stage at all.
      base.category = "short-window";
      base.probability = clampProb(Math.max(p, 75));
      base.severity = severityOf(base.probability);
      base.factors.unshift({
        label: "Cut-off window",
        value: fmt(cutoffWindow),
        detail: "stage needs " + fmt(expected),
        emphasis: true,
      });
      base.recommendation = "The cut-off allows only " + fmt(cutoffWindow) + " for a stage that typically takes " +
        fmt(expected) + ". The deadline itself needs revisiting, or the item needs priority handling.";
      base.action = "review";
      return base;
    }

    base.probability = p;
    base.severity = severityOf(p);

    if (p >= P_LIKELY) {
      base.category = "miss-cutoff";
      base.recommendation = "Predicted to overrun cut-off by " + fmt(Math.abs(shortfall)) +
        (tx.manualIntervention ? ". Clear the manual review to remove " + fmt(MANUAL_ALLOWANCE) + " from the estimate."
                               : ". Advance the stage now to recover the shortfall.");
      base.action = tx.manualIntervention ? "review" : "advance";
    } else if (elapsed > expected) {
      base.category = "overrun";
      base.recommendation = "Past expected " + tx.currentStage + " duration but still inside cut-off. Monitor.";
      base.action = tx.manualIntervention ? "review" : null;
    } else if (tx.manualIntervention) {
      base.category = "intervention";
      base.recommendation = "Manual review outstanding — clearing it early protects the cut-off.";
      base.action = "review";
    } else {
      base.category = "on-track";
    }

    return base;
  }

  function fmt(mins) {
    return window.formatDuration ? window.formatDuration(Math.round(mins)) : Math.round(mins) + "m";
  }

  // ── Portfolio-level forecast ───────────────────────────────
  // Backlog projection per stage, from the same per-transaction finish
  // estimates: an item leaves a stage when its predicted finish falls
  // inside the horizon, and arrives from the stage immediately upstream.
  function stageForecast(data, horizonMin, now) {
    const stages = ["Capture", "Confirmation", "Settlement", "Reconciliation"];
    const byStage = {};
    stages.forEach(function (s) { byStage[s] = { current: 0, out: 0, in: 0 }; });

    data.forEach(function (tx) {
      if (!byStage[tx.currentStage]) return;
      byStage[tx.currentStage].current++;
      const f = forecast(tx, now);
      const finish = f.predictedFinishIn != null
        ? f.predictedFinishIn
        : Math.max(0, f.expected - f.elapsed);
      if (finish <= horizonMin) {
        byStage[tx.currentStage].out++;
        const nextIdx = STAGE_ORDER.indexOf(tx.currentStage) + 1;
        const next = STAGE_ORDER[nextIdx];
        if (byStage[next]) byStage[next].in++;
      }
    });

    return stages.map(function (s) {
      const b = byStage[s];
      const predicted = Math.max(0, b.current - b.out + b.in);
      const delta = predicted - b.current;
      return {
        stage: s,
        current: b.current,
        predicted: predicted,
        delta: delta,
        pct: b.current > 0 ? Math.round((delta / b.current) * 100) : 0,
        inflow: b.in,
        outflow: b.out,
      };
    });
  }

  // ── Summary across the filtered set ────────────────────────
  function summarise(data, horizonMin, now) {
    now = now || new Date();
    computeQueueDepth();

    const rows = [];
    let active = 0, onTrack = 0, trackable = 0;
    let breachSoon = 0, breachSoonValue = 0;
    let manualLoad = 0, stalledCount = 0;

    data.forEach(function (tx) {
      if (tx.currentStage === "Completed") return;
      active++;
      const f = forecast(tx, now);
      f.tx = tx;

      // "On track" is only meaningful for transactions that actually have a
      // deadline being tracked; measuring it against the whole book would
      // count every aged, untracked item as a failure.
      const tracked = !!(tx.cutoff && !tx._alertSuppressed);
      if (tracked) {
        trackable++;
        if (f.probability < P_WATCH && f.category === "on-track") onTrack++;
      }

      // Imminence and probability are separate: only items whose cut-off
      // actually falls inside the horizon count towards the headline.
      const withinHorizon = tx.cutoff && tx.minutesToCutoff >= 0 && tx.minutesToCutoff <= horizonMin;
      if (withinHorizon && f.probability >= 60) {
        breachSoon++;
        breachSoonValue += tx.notionalEUR;
      }
      if (f.category === "intervention" || (tx.manualIntervention && tx.currentStage !== "Completed")) manualLoad++;
      if (f.category === "stalled") stalledCount++;

      // Stalled items carry no cut-off, so they cannot be ranked by
      // imminence next to deadline risk — they surface as a count instead.
      if (f.category !== "on-track" && f.category !== "stalled" && f.probability >= P_WATCH) {
        rows.push(f);
      }
    });

    // Rank by when the problem lands, not by probability alone: a 90%
    // risk 22 hours out is less actionable than a 70% risk in 40 minutes.
    rows.sort(function (a, b) {
      const aKey = a.minutesToCutoff != null && a.minutesToCutoff >= 0 ? a.minutesToCutoff : 100000;
      const bKey = b.minutesToCutoff != null && b.minutesToCutoff >= 0 ? b.minutesToCutoff : 100000;
      if (aKey !== bKey) return aKey - bKey;
      return b.probability - a.probability;
    });

    return {
      horizon: horizonMin,
      rows: rows,
      active: active,
      trackable: trackable,
      onTrackPct: trackable > 0 ? Math.round((onTrack / trackable) * 100) : 0,
      breachSoon: breachSoon,
      breachSoonValue: breachSoonValue,
      manualLoad: manualLoad,
      stalledCount: stalledCount,
      stages: stageForecast(data, horizonMin, now),
    };
  }

  // ── Public API ─────────────────────────────────────────────
  window.PredictiveOps = {
    forecast: function (tx, now) { computeQueueDepth(); return forecast(tx, now); },
    forecastNoRecount: forecast,
    summarise: summarise,
    CATEGORIES: CATEGORIES,
    thresholds: { watch: P_WATCH, likely: P_LIKELY, notify: P_NOTIFY },
    severityOf: severityOf,
  };
})();


// ============================================================
// Predictive Operations — Presentation Layer
// ============================================================

(function () {
  const P = window.PredictiveOps;

  // Horizon in minutes; driven by the 1h / 2h / 4h control.
  window.predictHorizon = 120;

  function sevClass(sev) { return "pv-" + sev; }
  function fmt(m) { return window.formatDuration(Math.round(m)); }

  // One-line summary of the dominant reason, for the watchlist row.
  function whyLine(f) {
    const tx = f.tx;
    switch (f.category) {
      case "short-window":
        return "Cut-off allows " + fmt(f.windowMinutes) + " · " + tx.currentStage + " needs " + fmt(f.expected);
      case "stalled":
        return fmt(f.elapsed) + " in " + tx.currentStage + " · " + Math.round(f.overrunRatio * 100) + "% of expected · no cut-off tracking it";
      case "breached":
        return "Cut-off passed " + fmt(Math.abs(f.minutesToCutoff)) + " ago";
      case "miss-cutoff":
        return "Needs " + fmt(f.predictedFinishIn) + ", has " + fmt(f.minutesToCutoff) +
               (tx.manualIntervention ? " · manual review outstanding" : "");
      case "overrun":
        return fmt(f.elapsed) + " in " + tx.currentStage + " vs " + fmt(f.expected) + " expected";
      case "intervention":
        return "Manual review outstanding · " + fmt(f.minutesToCutoff) + " to cut-off";
      default:
        return f.note || "—";
    }
  }

  function whenLine(f) {
    if (f.minutesToCutoff == null || f.minutesToCutoff >= 9999 || !f.tx.cutoff) {
      return '<span class="pv-when-none">no cut-off</span>';
    }
    if (f.minutesToCutoff < 0) {
      return '<span class="pv-when-late">' + fmt(Math.abs(f.minutesToCutoff)) + ' late</span>';
    }
    const cls = f.minutesToCutoff <= 60 ? "pv-when-soon" : f.minutesToCutoff <= 240 ? "pv-when-mid" : "pv-when-far";
    return '<span class="' + cls + '">' + fmt(f.minutesToCutoff) + '</span>';
  }

  // ── Forecast cards ───────────────────────────────────────────
  function renderCards(s) {
    const el = document.getElementById("predictCards");
    if (!el) return;
    const hzLabel = fmt(s.horizon);

    // Worst backlog movement across stages drives the backlog card.
    const worst = s.stages.slice().sort(function (a, b) { return b.delta - a.delta; })[0] ||
                  { stage: "—", current: 0, predicted: 0, delta: 0, pct: 0 };
    const worstCls = worst.delta > 0 ? "pv-card-warn" : worst.delta < 0 ? "pv-card-ok" : "";
    const arrow = worst.delta > 0 ? "&#8593;" : worst.delta < 0 ? "&#8595;" : "&#8594;";

    el.innerHTML =
      '<div class="pv-card ' + (s.breachSoon > 0 ? "pv-card-alert" : "pv-card-ok") + '"' +
      ' onclick="predictFocus(\'cutoff\')" title="Cut-off falls within ' + hzLabel + ' and is predicted to be missed">' +
        '<div class="pv-card-top"><span class="pv-card-icon">&#9202;</span>' +
        '<span class="pv-card-label">Predicted to miss cut-off</span></div>' +
        '<div class="pv-card-main"><span class="pv-card-value">' + s.breachSoon + '</span>' +
        '<span class="pv-card-unit">within ' + hzLabel + '</span></div>' +
        '<div class="pv-card-foot">' +
          (s.breachSoonValue > 0 ? window.formatEUR(s.breachSoonValue) + " at risk" : "No exposure in window") +
        '</div>' +
      '</div>' +

      '<div class="pv-card ' + worstCls + '" onclick="predictFocus(\'backlog\')"' +
      ' title="Projected queue depth from predicted stage completions">' +
        '<div class="pv-card-top"><span class="pv-card-icon">&#9707;</span>' +
        '<span class="pv-card-label">' + worst.stage + ' backlog</span></div>' +
        '<div class="pv-card-main"><span class="pv-card-value">' + worst.current + '</span>' +
        '<span class="pv-card-arrow">&#8594;</span>' +
        '<span class="pv-card-value pv-card-value-pred">' + worst.predicted + '</span></div>' +
        '<div class="pv-card-foot">' + arrow + ' ' + (worst.delta >= 0 ? "+" : "") + worst.delta +
        ' (' + (worst.pct >= 0 ? "+" : "") + worst.pct + '%) in ' + hzLabel + '</div>' +
      '</div>' +

      '<div class="pv-card ' + (s.manualLoad > 0 ? "pv-card-manual" : "pv-card-ok") + '"' +
      ' onclick="predictFocus(\'manual\')" title="Transactions that need a human before they can advance">' +
        '<div class="pv-card-top"><span class="pv-card-icon">&#9995;</span>' +
        '<span class="pv-card-label">Intervention load</span></div>' +
        '<div class="pv-card-main"><span class="pv-card-value">' + s.manualLoad + '</span>' +
        '<span class="pv-card-unit">need a human</span></div>' +
        '<div class="pv-card-foot">' + s.stalledCount + ' stalled with no cut-off tracking</div>' +
      '</div>' +

      '<div class="pv-card pv-card-ok" title="Share of active transactions with no predicted exception">' +
        '<div class="pv-card-top"><span class="pv-card-icon">&#10003;</span>' +
        '<span class="pv-card-label">Expected to progress normally</span></div>' +
        '<div class="pv-card-main"><span class="pv-card-value">' + s.onTrackPct +
        '<span class="pv-card-pct">%</span></span></div>' +
        '<div class="pv-card-foot">of ' + s.trackable + ' with a tracked cut-off</div>' +
      '</div>';
  }

  // ── Watchlist ────────────────────────────────────────────────
  const MAX_WATCH = 12;

  function renderWatchlist(s) {
    const el = document.getElementById("predictWatchlist");
    const badge = document.getElementById("predictBadge");
    if (!el) return;

    // The Risk & Alert Monitor already owns everything that is alerting.
    // The watchlist earns its place by showing what is not there yet.
    const emerging = s.rows.filter(function (f) { return f.category !== "breached"; });
    const shown = emerging.slice(0, MAX_WATCH);

    if (badge) badge.textContent = emerging.length + " forecast";

    if (!shown.length) {
      el.innerHTML = '<div class="pv-empty">&#10003; Nothing predicted to breach — every active transaction fits inside its cut-off.</div>';
      return;
    }

    const rowsHtml = shown.map(function (f) {
      const tx = f.tx;
      const cat = P.CATEGORIES[f.category] || P.CATEGORIES["on-track"];
      let actionBtn;
      if (f.action === "review") {
        actionBtn = '<button class="ops-btn ops-btn-review" onclick="performAction(\'' + tx.id + '\',\'review\',event)">&#10003; Review</button>';
      } else if (f.action === "resolve") {
        actionBtn = '<button class="ops-btn ops-btn-resolve" onclick="performAction(\'' + tx.id + '\',\'resolve\',event)">&#9873; Resolve</button>';
      } else if (f.action === "advance") {
        actionBtn = '<button class="ops-btn ops-btn-advance" onclick="performAction(\'' + tx.id + '\',\'advance\',event)">&#8594; Advance</button>';
      } else {
        actionBtn = '<span class="pv-no-action">Monitor</span>';
      }

      return '<div class="pv-row ' + sevClass(f.severity) + '" data-txid="' + tx.id + '">' +
        '<span class="pv-prob-cell">' +
          '<span class="pv-prob-num">' + f.probability + '<span class="pv-prob-pct">%</span></span>' +
          '<span class="pv-prob-bar-wrap"><span class="pv-prob-bar" style="width:' + f.probability + '%"></span></span>' +
        '</span>' +
        '<span class="pv-tx">' +
          '<span class="pv-txid">' + tx.id + '</span>' +
          '<span class="badge ' + assetBadgeClass(tx.asset) + '" style="font-size:9px;">' + tx.asset + '</span>' +
          '<span class="pv-client">' + tx.client.split(" ").slice(0, 2).join(" ") + '</span>' +
        '</span>' +
        '<span><span class="stage-badge ' + stageBadgeClass(tx.currentStage) + '" style="font-size:9px;">' + tx.currentStage + '</span></span>' +
        '<span class="pv-eur">' + window.formatEUR(tx.notionalEUR) + '</span>' +
        '<span><span class="pv-cat ' + cat.cls + '">' + cat.short + '</span></span>' +
        '<span class="pv-when">' + whenLine(f) + '</span>' +
        '<span class="pv-why">' + whyLine(f) + '</span>' +
        '<span class="pv-action" onclick="event.stopPropagation()">' + actionBtn + '</span>' +
      '</div>';
    }).join("");

    el.innerHTML =
      '<div class="pv-table">' +
        '<div class="pv-table-head">' +
          '<span>Probability</span><span>Transaction</span><span>Stage</span><span>Value (EUR)</span>' +
          '<span>Prediction</span><span>Cut-off in</span><span>Why</span><span>Recommended</span>' +
        '</div>' + rowsHtml +
      '</div>' +
      (emerging.length > MAX_WATCH
        ? '<div class="pv-more">+ ' + (emerging.length - MAX_WATCH) + ' more forecast exceptions — narrow the filters to see them</div>'
        : "");

    el.querySelectorAll(".pv-row[data-txid]").forEach(function (row) {
      row.addEventListener("click", function () {
        const tx = window.TRANSACTIONS.find(function (t) { return t.id === row.dataset.txid; });
        if (tx) openModal(tx);
      });
    });
  }

  // ── Modal forecast block ─────────────────────────────────────
  window.renderModalForecast = function (tx) {
    const el = document.getElementById("modalForecast");
    if (!el) return;
    const f = P.forecast(tx);
    f.tx = tx;
    const cat = P.CATEGORIES[f.category] || P.CATEGORIES["on-track"];

    if (!f.factors.length) {
      el.innerHTML = '<div class="pv-modal-ok">&#10003; No exception predicted — ' +
        (f.note || "within expected stage duration") + '.</div>';
      return;
    }

    const factorsHtml = f.factors.map(function (x) {
      const cls = "pv-factor" + (x.total ? " pv-factor-total" : "") +
                  (x.emphasis ? " pv-factor-emph" : "") + (x.muted ? " pv-factor-muted" : "");
      return '<div class="' + cls + '">' +
        '<span class="pv-factor-lbl">' + x.label + '</span>' +
        '<span class="pv-factor-val">' + x.value +
          (x.detail ? ' <span class="pv-factor-detail">' + x.detail + '</span>' : "") +
        '</span></div>';
    }).join("");

    el.innerHTML =
      '<div class="pv-modal-head ' + sevClass(f.severity) + '">' +
        '<span class="pv-modal-prob">' + f.probability + '<span class="pv-prob-pct">%</span></span>' +
        '<div class="pv-modal-headtext">' +
          '<span class="pv-cat ' + cat.cls + '">' + cat.label + '</span>' +
          '<span class="pv-modal-sev">' + f.severity.toUpperCase() + ' severity band</span>' +
        '</div>' +
      '</div>' +
      '<div class="pv-modal-factors">' + factorsHtml + '</div>' +
      (f.recommendation
        ? '<div class="pv-modal-rec"><span class="pv-rec-lbl">Recommended action</span>' +
          '<span class="pv-rec-txt">' + f.recommendation + '</span></div>'
        : "");
  };

  // ── Compact cell for the Risk & Alert Monitor ────────────────
  window.predictAlertCell = function (tx) {
    const f = P.forecastNoRecount(tx);
    const cat = P.CATEGORIES[f.category] || P.CATEGORIES["on-track"];
    if (f.category === "breached") return '<span class="pv-mini pv-mini-breached">Missed</span>';
    if (f.category === "on-track") return '<span class="pv-mini pv-mini-ok">On track</span>';
    return '<span class="pv-mini ' + sevClass(f.severity) + '" title="' + cat.label + '">' +
      '<span class="pv-mini-prob">' + f.probability + '%</span>' +
      '<span class="pv-mini-cat">' + cat.short + '</span></span>';
  };

  // ── Cards drive the existing filters ────────────────────────
  window.predictFocus = function (kind) {
    if (kind === "manual") {
      state.kpiFilter = state.kpiFilter === "manual" ? null : "manual";
    } else if (kind === "cutoff") {
      state.kpiFilter = state.kpiFilter === "nearcutoff" ? null : "nearcutoff";
    } else {
      return;
    }
    state.page = 1;
    render();
  };

  // ── Methodology popover ──────────────────────────────────────
  const POPOVER_HTML =
'<div class="risk-popover pv-popover" id="predictPopover" role="tooltip">' +
  '<div class="risk-pop-title">&#9678; How predictions are calculated</div>' +
  '<div class="risk-pop-formula">' +
    '<span class="risk-pop-eq">Predicted finish = outstanding work + handling allowances</span>' +
  '</div>' +
  '<div class="risk-pop-table">' +
    '<div class="risk-pop-section">Outstanding work</div>' +
    '<div class="risk-pop-row"><span class="rp-label">Expected stage duration</span><span class="rp-pts">SLA &times; asset</span></div>' +
    '<div class="risk-pop-row"><span class="rp-label">Minus time already in stage</span><span class="rp-pts">live</span></div>' +
    '<div class="risk-pop-row"><span class="rp-label">If already overrunning</span><span class="rp-pts">grows with overrun</span></div>' +
    '<div class="risk-pop-section">Handling allowances</div>' +
    '<div class="risk-pop-row"><span class="rp-label">Manual intervention required</span><span class="rp-pts">+45m</span></div>' +
    '<div class="risk-pop-row"><span class="rp-label">Non-STP transaction</span><span class="rp-pts">+15m</span></div>' +
    '<div class="risk-pop-row"><span class="rp-label">Queue contention</span><span class="rp-pts">+5m / 25 queued</span></div>' +
    '<div class="risk-pop-section">Probability</div>' +
    '<div class="risk-pop-row"><span class="rp-label">Shortfall = predicted finish &minus; time to cut-off</span><span class="rp-pts"></span></div>' +
    '<div class="risk-pop-row"><span class="rp-label">Logistic curve on the shortfall</span><span class="rp-pts">0 &rarr; 50%</span></div>' +
  '</div>' +
  '<div class="risk-pop-footer">' +
    'Deterministic — no model and no randomness. Every figure in a transaction&rsquo;s ' +
    'forecast is a term of this calculation, and all of them move as the clock ' +
    'advances or an operator clears an exception.' +
  '</div>' +
'</div>';

  window.togglePredictPopover = function (btn) {
    if (!document.getElementById("predictPopover")) {
      document.body.insertAdjacentHTML("beforeend", POPOVER_HTML);
      document.addEventListener("click", function (e) {
        const pop = document.getElementById("predictPopover");
        if (pop && !pop.contains(e.target) && !e.target.classList.contains("risk-info-btn")) {
          pop.classList.remove("visible");
        }
      });
    }
    const pop = document.getElementById("predictPopover");
    const rect = btn.getBoundingClientRect();
    pop.style.top = (rect.bottom + window.scrollY + 8) + "px";
    pop.style.left = Math.max(8, rect.left + window.scrollX - 320) + "px";
    pop.classList.toggle("visible");
  };

  // ── Entry point, called from render() ───────────────────────
  window.renderPredictive = function (data) {
    const s = P.summarise(data, window.predictHorizon);
    renderCards(s);
    renderWatchlist(s);
    if (window.checkPredictiveAlerts) window.checkPredictiveAlerts(s);
    return s;
  };

  // ── Horizon control ─────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", function () {
    const group = document.getElementById("predictHorizon");
    if (!group) return;
    group.addEventListener("click", function (e) {
      if (!e.target.classList.contains("predict-hz")) return;
      group.querySelectorAll(".predict-hz").forEach(function (b) { b.classList.remove("active"); });
      e.target.classList.add("active");
      window.predictHorizon = parseInt(e.target.dataset.h, 10) || 120;
      render();
    });
  });
})();
