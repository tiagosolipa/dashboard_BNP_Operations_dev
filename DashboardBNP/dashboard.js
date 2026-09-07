// ============================================================
// BNP Paribas Securities — Dashboard Controller v3
// Decision-oriented: financial context, smart alerts, bottleneck detection
// ============================================================

"use strict";

// ── State ──────────────────────────────────────────────────
let state = {
  assetFilter: "all", clientFilter: "all",
  cutoffFilter: "all", stageFilter: "all",
  searchQuery: "", page: 1, pageSize: 500,
  kpiFilter: null,
  cutoffTimeFilter: { start: -1, end: -1 }, // -1/-1 = All Day
  riskScoreFilter: null, // {min, max} or null for all
  stageErrFilter: null,  // stage name or null
};

// ── User Profile Switcher ─────────────────────────────────────
let userSwitcherOpen = false;

function toggleUserSwitcher(e) {
  e.stopPropagation();
  userSwitcherOpen = !userSwitcherOpen;
  const dropdown = document.getElementById("userSwitcherDropdown");
  const headerUser = document.getElementById("headerUser");
  if (dropdown) dropdown.classList.toggle("open", userSwitcherOpen);
  if (headerUser) headerUser.classList.toggle("switcher-open", userSwitcherOpen);
  if (userSwitcherOpen) renderUserSwitcher();
}

function closeUserSwitcher() {
  userSwitcherOpen = false;
  const dropdown = document.getElementById("userSwitcherDropdown");
  const headerUser = document.getElementById("headerUser");
  if (dropdown) dropdown.classList.remove("open");
  if (headerUser) headerUser.classList.remove("switcher-open");
}

function switchUser(userId) {
  const profile = window.USER_PROFILES.find(p => p.id === userId);
  if (!profile) return;
  window.activeUser = profile;
  // Update header display
  const avatar = document.getElementById("headerUserAvatar");
  const name = document.getElementById("headerUserName");
  if (avatar) {
    avatar.textContent = profile.initials;
    avatar.className = "user-avatar user-avatar-" + profile.avatarClass;
  }
  if (name) name.textContent = profile.name;
  closeUserSwitcher();
}

function renderUserSwitcher() {
  const dropdown = document.getElementById("userSwitcherDropdown");
  if (!dropdown) return;
  const titleEl = dropdown.querySelector(".user-switcher-title");
  dropdown.innerHTML = "";
  if (titleEl) dropdown.appendChild(titleEl);
  else {
    const t = document.createElement("div");
    t.className = "user-switcher-title";
    t.textContent = "Switch Profile";
    dropdown.appendChild(t);
  }
  window.USER_PROFILES.forEach(profile => {
    const isActive = window.activeUser.id === profile.id;
    const btn = document.createElement("button");
    btn.className = "user-switcher-item" + (isActive ? " active" : "");
    btn.innerHTML = `
      <div class="switcher-avatar switcher-avatar-${profile.avatarClass}">${profile.initials}</div>
      <div class="switcher-info">
        <span class="switcher-name">${profile.name}</span>
        <span class="switcher-role">${profile.role}</span>
      </div>
      ${isActive ? '<span class="switcher-active-badge">Active</span>' : ""}
    `;
    btn.addEventListener("click", function(e) {
      e.stopPropagation();
      switchUser(profile.id);
    });
    dropdown.appendChild(btn);
  });
}

// ── Audit Trail Logging ───────────────────────────────────────
function logAction(txId, actionType, prevStatus, newStatus) {
  const tx = window.TRANSACTIONS.find(t => t.id === txId);
  const user = window.activeUser;
  const entry = {
    user: user.name,
    initials: user.initials,
    avatarClass: user.avatarClass,
    action: actionType,
    txId: txId,
    timestamp: new Date(),
    prevStatus: prevStatus,
    newStatus: newStatus,
  };
  window.auditLog.push(entry);
  if (tx) {
    tx.activityHistory.push(entry);
    tx.lastModifiedBy = user.name;
    tx.lastModifiedAt = entry.timestamp;
  }
  // Push notification for the action
  if (window.pushActionNotification) {
    window.pushActionNotification(txId, user.name, actionType);
  }
}





// ── Helpers ────────────────────────────────────────────────
function getFiltered() {
  return window.TRANSACTIONS.filter(tx => {
    // ─ KPI quick-filter (applied first, combinable with other filters) ─
    if (state.kpiFilter === "reqaction" && !(tx.riskStatus==="overdue"||tx.riskStatus==="critical"||tx.manualIntervention)) return false;
    if (state.kpiFilter === "nearcutoff" && !(tx.currentStage!=="Completed"&&tx.minutesToCutoff>=0&&tx.minutesToCutoff<=30)) return false;
    if (state.kpiFilter === "overdue" && tx.riskStatus !== "overdue") return false;
    if (state.kpiFilter === "manual" && !tx.manualIntervention) return false;
    if (state.kpiFilter === "settlement" && tx.currentStage !== "Settlement") return false;
    if (state.kpiFilter === "sla" && tx.riskStatus !== "overdue") return false;
    if (state.kpiFilter === "confirmation" && tx.currentStage !== "Confirmation") return false;
    if (state.kpiFilter === "critical" && tx.riskStatus !== "critical") return false;

    // ─ Existing bar/chip/search filters ─
    if (state.assetFilter !== "all" && tx.asset !== state.assetFilter) return false;
    if (state.clientFilter !== "all" && tx.client !== state.clientFilter) return false;
    if (state.stageFilter !== "all" && tx.currentStage !== state.stageFilter) return false;
    if (state.cutoffFilter !== "all") {
      if (state.cutoffFilter === "overdue" && tx.riskStatus !== "overdue") return false;
      if (state.cutoffFilter === "critical" && tx.riskStatus !== "critical") return false;
      if (state.cutoffFilter === "today") {
        // "Today" = transactions whose cut-off date is today (ignore time component)
        if (!tx.cutoff) return false;
        const now = new Date();
        const todayStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
        const cutoffStr = tx.cutoff.getFullYear() + '-' + String(tx.cutoff.getMonth() + 1).padStart(2,'0') + '-' + String(tx.cutoff.getDate()).padStart(2,'0');
        if (cutoffStr !== todayStr) return false;
      }
      if (state.cutoffFilter === "24h" && tx.minutesToCutoff > 1440) return false;
    }
    // ─ Cut-off time interval filter (hour bucket) ─
    if (state.cutoffTimeFilter.start >= 0 && tx.cutoff) {
      const h = tx.cutoff.getHours() + tx.cutoff.getMinutes() / 60;
      if (h < state.cutoffTimeFilter.start || h >= state.cutoffTimeFilter.end) return false;
    } else if (state.cutoffTimeFilter.start >= 0 && !tx.cutoff) {
      return false; // has time filter but tx has no cutoff → exclude
    }
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      if (!tx.id.toLowerCase().includes(q) &&
        !tx.client.toLowerCase().includes(q) &&
        !tx.asset.toLowerCase().includes(q)) return false;
    }
    return true;
  });
}


// ── KPI Computation (Operational) ──────────────────────────
function computeKPIs(data) {
  return {
    reqaction: data.filter(t => t.riskStatus==="overdue"||t.riskStatus==="critical"||t.manualIntervention).length,
    nearcutoff: data.filter(t => t.currentStage!=="Completed"&&t.minutesToCutoff>=0&&t.minutesToCutoff<=30).length,
    overdue: data.filter(t => t.riskStatus==="overdue").length,
    manual: data.filter(t => t.manualIntervention).length,
    settlement: data.filter(t => t.currentStage==="Settlement").length,
    sla: data.filter(t => t.riskStatus==="overdue").length,
    confirmation: data.filter(t => t.currentStage==="Confirmation").length,
    critical: data.filter(t => t.riskStatus==="critical").length,
  };
}

function renderKPIs(data) {
  const k = computeKPIs(data);
  const KPI_MAP = {
    "kpi-reqaction":"reqaction","kpi-nearcutoff":"nearcutoff","kpi-overdue":"overdue",
    "kpi-manual":"manual","kpi-settlement":"settlement","kpi-sla":"sla",
    "kpi-confirmation":"confirmation","kpi-critical":"critical"
  };
  Object.entries(KPI_MAP).forEach(([elId, key]) => {
    const el = document.getElementById(elId); if (!el) return;
    const valEl = document.getElementById(elId + "-val");
    if (valEl) valEl.textContent = k[key];
    el.classList.add("kpi-clickable");
    el.classList.toggle("kpi-active", state.kpiFilter === key);
    el.classList.toggle("kpi-inactive", state.kpiFilter !== null && state.kpiFilter !== key);
    const isAlert = ["reqaction","nearcutoff","overdue","manual","sla","critical"].includes(key);
    if (isAlert) el.classList.toggle("kpi-alert-card", k[key] > 0);
  });
}


// ── Operational Workflow Action Handlers ───────────────────────
const STAGE_SEQ = ["Capture","Confirmation","Settlement","Reconciliation","Completed"];

function advanceToNextStage(tx) {
  const idx = STAGE_SEQ.indexOf(tx.currentStage);
  if (idx < 0 || idx >= STAGE_SEQ.length - 1) return;
  const now = new Date();
  if (tx.timestamps[tx.currentStage]) {
    tx.timestamps[tx.currentStage].exit = now;
    tx.timestamps[tx.currentStage].duration = Math.round((now - tx.timestamps[tx.currentStage].entry) / 60000);
  }
  const next = STAGE_SEQ[idx + 1];
  tx.currentStage = next; tx.stageIndex = idx + 1;
  tx.timestamps[next] = { entry: now, exit: null, duration: 0 };
  if (next === "Completed") {
    tx.riskStatus = "ok"; tx._alertSuppressed = true;
    tx.alertReason = ""; tx.manualIntervention = false;
  }
}

function performAction(txId, action, e) {
  if (e) e.stopPropagation();
  const tx = window.TRANSACTIONS.find(t => t.id === txId);
  if (!tx) return;

  // Capture previous state for audit trail
  const prevStage = tx.currentStage;
  const prevRisk = tx.riskStatus;
  let actionLabel = "";

  if (action === "review") {
    actionLabel = "Completed Manual Review";
    tx.manualIntervention = false; tx._alertSuppressed = true; tx.riskStatus = "ok"; tx.alertReason = "";
  }
  else if (action === "approve") {
    actionLabel = "Approved transaction";
    advanceToNextStage(tx); tx.manualIntervention = false;
  }
  else if (action === "resolve") {
    actionLabel = "Resolved alert";
    tx._alertSuppressed = true; tx.riskStatus = "ok"; tx.manualIntervention = false; tx.alertReason = "";
  }
  else if (action === "advance") {
    actionLabel = "Advanced to " + (STAGE_SEQ[STAGE_SEQ.indexOf(prevStage) + 1] || "next stage");
    advanceToNextStage(tx);
  }

  // Log the action to audit trail
  logAction(txId, actionLabel, prevStage, tx.currentStage);

  render();
}

function getActionBtn(tx) {
  if (tx.currentStage === "Completed") return '<span style="color:#9ba3b5;font-size:10px;font-weight:600;">&#10003; Done</span>';
  const btns = [];
  if (tx.manualIntervention) btns.push(`<button class="ops-btn ops-btn-review" onclick="performAction('${tx.id}','review',event)">&#10003; Review</button>`);
  if ((tx.riskStatus==="overdue"||tx.riskStatus==="critical") && !tx.manualIntervention) btns.push(`<button class="ops-btn ops-btn-resolve" onclick="performAction('${tx.id}','resolve',event)">&#9873; Resolve</button>`);
  if (tx.currentStage==="Confirmation" && !tx.manualIntervention) btns.push(`<button class="ops-btn ops-btn-approve" onclick="performAction('${tx.id}','approve',event)">&#10003; Approve</button>`);
  btns.push(`<button class="ops-btn ops-btn-advance" onclick="performAction('${tx.id}','advance',event)">&#8594;</button>`);
  return btns.slice(0, 2).join(" ");
}

function getModalActions(tx) {
  if (tx.currentStage === "Completed") return '<div class="modal-done">&#10003; Transaction Completed &amp; Settled</div>';
  const btns = [];
  if (tx.manualIntervention) btns.push(`<button class="modal-ops-btn modal-btn-review" onclick="performAction('${tx.id}','review',event);closeModal()">&#10003; Complete Manual Review</button>`);
  if (tx.currentStage==="Confirmation") btns.push(`<button class="modal-ops-btn modal-btn-approve" onclick="performAction('${tx.id}','approve',event);closeModal()">&#10003; Approve &amp; Advance to Settlement</button>`);
  if (tx.riskStatus==="overdue"||tx.riskStatus==="critical") btns.push(`<button class="modal-ops-btn modal-btn-resolve" onclick="performAction('${tx.id}','resolve',event);closeModal()">&#9873; Resolve Alert</button>`);
  btns.push(`<button class="modal-ops-btn modal-btn-advance" onclick="performAction('${tx.id}','advance',event);closeModal()">&#8594; Advance to Next Stage</button>`);
  return btns.join(" ");
}

// ── Owner Badge for Alert Table ───────────────────────────────
function getOwnerBadge(tx) {
  if (!tx.lastModifiedBy) {
    return '<span class="al-owner-badge"><span class="al-owner-dot al-owner-dot-none"></span>—</span>';
  }
  const dotClass = tx.lastModifiedBy === "Ops Manager" ? "al-owner-dot-op" : "al-owner-dot-pm";
  return `<span class="al-owner-badge"><span class="al-owner-dot ${dotClass}"></span>${tx.lastModifiedBy.split(" ").map(w => w[0]).join("")}</span>`;
}

// ── Audit Trail / Activity History in Modal ───────────────────
function renderAuditTrail(tx) {
  const container = document.getElementById("auditTrailContainer");
  if (!container) return;

  if (!tx.activityHistory || tx.activityHistory.length === 0) {
    container.innerHTML = `
      <div class="audit-empty-state">
        <span class="audit-empty-icon">📋</span>
        <span>No activity recorded yet</span>
      </div>`;
    return;
  }

  // Show most recent first
  const sorted = [...tx.activityHistory].sort((a, b) => b.timestamp - a.timestamp);

  container.innerHTML = sorted.map(entry => {
    const timeStr = entry.timestamp.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
    const dateStr = entry.timestamp.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit" });
    const avatarClass = "audit-avatar-" + (entry.avatarClass || "wf");
    const transition = (entry.prevStatus && entry.newStatus && entry.prevStatus !== entry.newStatus)
      ? `<div class="audit-entry-transition">
           <span>${entry.prevStatus}</span>
           <span class="audit-transition-arrow">→</span>
           <span>${entry.newStatus}</span>
         </div>`
      : "";

    return `
      <div class="audit-entry">
        <div class="audit-entry-avatar ${avatarClass}">${entry.initials || "WF"}</div>
        <div class="audit-entry-content">
          <div class="audit-entry-header">
            <span class="audit-entry-user">${entry.user || "Workflow"}</span>
            <span class="audit-entry-time">${timeStr} · ${dateStr}</span>
          </div>
          <div class="audit-entry-action">${entry.action}</div>
          ${transition}
        </div>
      </div>`;
  }).join("");
}

// ── Errors by Stage Panel ─────────────────────────────────────
function renderStageErrors(data) {
  const panel = document.getElementById("stageErrorsPanel");
  if (!panel) return;
  const stages = ["Capture","Confirmation","Settlement","Reconciliation"];
  const stageData = stages.map(s => {
    const txs = data.filter(t => t.currentStage === s);
    const errors = txs.filter(t => t.riskStatus==="overdue"||t.riskStatus==="critical"||t.manualIntervention);
    return { stage: s, total: txs.length, errors: errors.length, rate: txs.length > 0 ? Math.round((errors.length/txs.length)*100) : 0 };
  });
  const maxErrors = Math.max(...stageData.map(s => s.errors), 1);
  const STAGE_ICONS = { Capture: "📥", Confirmation: "📋", Settlement: "🏦", Reconciliation: "🔄" };
  panel.innerHTML = stageData.map(s => {
    const isHotspot = s.errors === maxErrors && s.errors > 0;
    const severity = isHotspot ? "stage-err-hotspot" : s.errors > 0 ? "stage-err-warn" : "stage-err-ok";
    const isActive = state.stageErrFilter === s.stage;
    const isInactive = state.stageErrFilter !== null && !isActive;
    return `<div class="stage-err-item ${severity}${isActive ? " stage-err-active" : ""}${isInactive ? " stage-err-inactive" : ""}" onclick="filterByStageErr('${s.stage}')">
      <div class="stage-err-top">
        <span class="stage-err-icon">${STAGE_ICONS[s.stage]}</span>
        <span class="stage-err-name">${s.stage}</span>
        ${isHotspot ? '<span class="stage-err-hotlabel">HOTSPOT</span>' : ""}
      </div>
      <div class="stage-err-nums">
        <span class="stage-err-count">${s.errors}</span>
        <span class="stage-err-sub">/ ${s.total} txns</span>
        <span class="stage-err-rate ${s.rate > 30 ? "rate-high" : s.rate > 0 ? "rate-med" : "rate-ok"}">${s.rate}%</span>
      </div>
      <div class="stage-err-bar-wrap"><div class="stage-err-bar" style="width:${s.total>0?Math.round((s.errors/s.total)*100):0}%"></div></div>
    </div>`;
  }).join("");
}

function filterByStageErr(stage) {
  state.stageErrFilter = (state.stageErrFilter === stage) ? null : stage;
  if (state.stageErrFilter) {
    state.stageFilter = stage;
    document.getElementById("stageFilter").value = stage;
  } else {
    state.stageFilter = "all";
    document.getElementById("stageFilter").value = "all";
  }
  state.page = 1;
  render();
}

// ── Risk Score Explanation Popover ──────────────────────────────────
const RISK_SCORE_HTML = `
<div class="risk-popover" id="riskScorePopover" role="tooltip">
  <div class="risk-pop-title">📊 How the Risk Score is Calculated</div>
  <div class="risk-pop-formula">
    <span class="risk-pop-eq">Risk Score = Time Urgency + Value Weight + Stage Weight</span>
  </div>
  <div class="risk-pop-table">
    <div class="risk-pop-section">⏰ Time Urgency (0–50 pts)</div>
    <div class="risk-pop-row"><span class="rp-label rp-overdue">⛔ Overdue</span><span class="rp-pts">50 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label rp-critical">⚡ Critical (&lt;2 hrs)</span><span class="rp-pts">35 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label rp-warning">⚠️ Warning (&lt;4 hrs)</span><span class="rp-pts">15 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label rp-ok">✅ On Track</span><span class="rp-pts">0 pts</span></div>
    <div class="risk-pop-section">💶 Value Weight (0–30 pts)</div>
    <div class="risk-pop-row"><span class="rp-label">log₁₀(Notional €M + 1) × 20</span><span class="rp-pts">capped 30</span></div>
    <div class="risk-pop-section">🔄 Stage Weight (0–20 pts)</div>
    <div class="risk-pop-row"><span class="rp-label">Settlement</span><span class="rp-pts">20 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label">Reconciliation</span><span class="rp-pts">15 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label">Confirmation</span><span class="rp-pts">10 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label">Capture</span><span class="rp-pts">5 pts</span></div>
    <div class="risk-pop-row"><span class="rp-label">Completed</span><span class="rp-pts">0 pts</span></div>
  </div>
  <div class="risk-pop-footer">Final score is capped at <strong>100</strong>. Higher = more urgent action needed.</div>
</div>`;

function ensureRiskPopover() {
  if (!document.getElementById("riskScorePopover")) {
    document.body.insertAdjacentHTML("beforeend", RISK_SCORE_HTML);
    document.addEventListener("click", e => {
      const pop = document.getElementById("riskScorePopover");
      if (pop && !pop.contains(e.target) && !e.target.classList.contains("risk-info-btn")) {
        pop.classList.remove("visible");
      }
    });
  }
}

function toggleRiskPopover(btn) {
  ensureRiskPopover();
  const pop = document.getElementById("riskScorePopover");
  const rect = btn.getBoundingClientRect();
  pop.style.top = (rect.bottom + window.scrollY + 8) + "px";
  pop.style.left = Math.max(8, rect.left + window.scrollX - 200) + "px";
  pop.classList.toggle("visible");
}

// ── Risk & Alert Monitor — enriched, prioritised table ──────
function renderAlerts(data) {
  const container = document.getElementById("alertsStrip");
  const badge = document.getElementById("alert-count-badge");

  // Collect actionable alerts
  const alertTxs = data.filter(t =>
    t.riskStatus === "overdue" || t.riskStatus === "critical" || t.manualIntervention
  );

  const STAGE_ORDER = { Settlement: 4, Reconciliation: 3, Confirmation: 2, Capture: 1, Completed: 0 };
  const RISK_ORDER = { overdue: 3, critical: 2, warning: 1, ok: 0 };

  alertTxs.sort((a, b) => {
    const rDiff = RISK_ORDER[b.riskStatus] - RISK_ORDER[a.riskStatus];
    if (rDiff !== 0) return rDiff;
    const sDiff = b.riskScore - a.riskScore;
    if (sDiff !== 0) return sDiff;
    const vDiff = b.notionalEUR - a.notionalEUR;
    if (vDiff !== 0) return vDiff;
    return (STAGE_ORDER[b.currentStage] || 0) - (STAGE_ORDER[a.currentStage] || 0);
  });

  // Apply risk score filter if set
  const shown = state.riskScoreFilter
    ? alertTxs.filter(t => t.riskScore >= state.riskScoreFilter.min && t.riskScore <= state.riskScoreFilter.max)
    : alertTxs;
  badge.textContent = shown.length + " alerts";

  if (!shown.length) {
    container.innerHTML = `<div style="color:#5c6070;font-size:12px;padding:10px 0;">✅ No active alerts — all transactions within SLA.</div>`;
    return;
  }

  container.innerHTML = `
    <div class="alert-table">
      <div class="alert-table-head">
        <span>Priority</span>
        <span>Transaction</span>
        <span>Stage</span>
        <span>Value (EUR)</span>
        <span>Cut-off Date</span>
        <span>Cut-off Time</span>
        <span>Alert Reason</span>
        <span class="risk-score-head">
          Risk Score
          <button class="risk-info-btn" onclick="toggleRiskPopover(this)" title="How is this calculated?">&#9432;</button>
        </span>
        <span class="pv-forecast-head">
          Forecast
          <button class="risk-info-btn" onclick="togglePredictPopover(this)" title="How is this predicted?">&#9432;</button>
        </span>
        <span>Action</span>
        <span>Last Action By</span>
      </div>
      ${shown.map(tx => {
    const priorityIcon = tx.priority === "high" ? "🔴" : tx.priority === "medium" ? "🟡" : "🔵";
    const priorityCls = `alert-row-${tx.priority}`;
    const riskReason = tx.alertReason || (tx.manualIntervention ? "Manual required" : "No cut-off defined");
    const scoreWidth = tx.riskScore;
    const eurValueCls = tx.priority === 'high' ? 'al-eur-high' : tx.priority === 'medium' ? 'al-eur-medium' : '';

    let cutoffDate = "—", cutoffTime = "—", cutoffDateCls = "", cutoffTimeCls = "";
    if (tx.cutoff) {
      const co = tx.cutoff;
      cutoffDate = co.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
      cutoffTime = co.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
      if (tx.riskStatus === "overdue") { cutoffDateCls = "cutoff-overdue"; cutoffTimeCls = "cutoff-overdue"; }
      else if (tx.riskStatus === "critical") { cutoffDateCls = "cutoff-critical"; cutoffTimeCls = "cutoff-critical"; }
    }

    return `
        <div class="alert-table-row ${priorityCls}" data-txid="${tx.id}">
          <span class="al-priority">
            <span class="al-icon">${priorityIcon}</span>
            <span class="al-pri-label priority-${tx.priority}">${tx.priority.toUpperCase()}</span>
          </span>
          <span class="al-tx">
            <span class="al-txid">${tx.id}</span>
            <span class="badge ${assetBadgeClass(tx.asset)}" style="font-size:9px;">${tx.asset}</span>
            <span class="al-client">${tx.client.split(" ").slice(0, 2).join(" ")}</span>
          </span>
          <span><span class="stage-badge ${stageBadgeClass(tx.currentStage)}" style="font-size:9px;">${tx.currentStage}</span></span>
          <span class="al-eur-val ${eurValueCls}">${formatEUR(tx.notionalEUR)}</span>
          <span class="al-cutoff-date ${cutoffDateCls}">${cutoffDate}</span>
          <span class="al-cutoff-time ${cutoffTimeCls}">${cutoffTime}</span>
          <span class="al-reason ${tx.riskStatus === 'overdue' ? 'reason-overdue' : tx.riskStatus === 'critical' ? 'reason-critical' : 'reason-manual'}">
            ${riskReason || "—"}
          </span>
          <span class="al-score-cell">
            <div class="al-score-bar-wrap">
              <div class="al-score-bar" style="width:${scoreWidth}%;background:${tx.priority === 'high' ? '#e53935' : tx.priority === 'medium' ? '#f5a623' : '#1976d2'};"></div>
            </div>
            <span class="al-score-val">${tx.riskScore}</span>
          </span>
          <span class="al-forecast">${window.predictAlertCell ? window.predictAlertCell(tx) : ""}</span>
          <span class="al-action" onclick="event.stopPropagation()">${getActionBtn(tx)}</span>
          <span class="al-owner">${getOwnerBadge(tx)}</span>
        </div>`;
  }).join("")}
    </div>`;

  container.querySelectorAll(".alert-table-row[data-txid]").forEach(el => {
    el.addEventListener("click", () => {
      const tx = window.TRANSACTIONS.find(t => t.id === el.dataset.txid);
      if (tx) openModal(tx);
    });
  });
}

// ── Table helpers ─────────────────────────────────────────
function assetBadgeClass(asset) {
  return { Cash: "badge-cash", FX: "badge-fx", Derivatives: "badge-deriv", "Money Markets": "badge-mm", Securities: "badge-sec" }[asset] || "";
}
function stageBadgeClass(stage) {
  return { Capture: "stage-capture", Confirmation: "stage-confirmation", Settlement: "stage-settlement", Reconciliation: "stage-reconciliation", Completed: "stage-completed" }[stage] || "";
}
function riskDotClass(risk) {
  return { ok: "risk-ok", warning: "risk-warn", critical: "risk-critical", overdue: "risk-overdue" }[risk] || "risk-ok";
}
function formatCutoff(tx) {
  if (!tx.cutoff) return `<span style="color:#9ba3b5;">—</span>`;
  const fmt = fmtDateTime(tx.cutoff);
  if (tx.riskStatus === "overdue") return `<span style="color:#e53935;font-weight:700;">⛔ ${fmt}</span>`;
  if (tx.riskStatus === "critical") return `<span style="color:#f5a623;font-weight:700;">⚡ ${fmt}</span>`;
  if (tx.riskStatus === "warning") return `<span style="color:#f9c030;font-weight:600;">${fmt}</span>`;
  return `<span>${fmt}</span>`;
}

// ── Table Rendering ─────────────────────────────────────────
function renderTable(data) {
  const tbody = document.getElementById("txTableBody");
  const start = (state.page - 1) * state.pageSize;
  const paged = data.slice(start, start + state.pageSize);
  document.getElementById("rowCount").textContent = data.length + " rows";

  if (!paged.length) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;padding:28px;color:#9ba3b5;">No transactions match current filters.</td></tr>`;
    return;
  }

  tbody.innerHTML = paged.map(tx => {
    const rowClass = tx.riskStatus === "overdue" ? "row-overdue" : tx.riskStatus === "critical" ? "row-critical" : "";
    const timeInStage = Math.max(0, tx.timestamps[tx.currentStage]?.duration ?? 0);
    return `
    <tr class="${rowClass}" data-txid="${tx.id}">
      <td><span class="tx-id">${tx.id}</span></td>
      <td><span class="badge ${assetBadgeClass(tx.asset)}">${tx.asset}</span></td>
      <td style="max-width:140px;overflow:hidden;text-overflow:ellipsis;">${tx.client}</td>
      <td><span class="client-id-badge">${tx.clientId || '—'}</span></td>
      <td><span class="stage-badge ${stageBadgeClass(tx.currentStage)}">${tx.currentStage}</span></td>
      <td style="font-variant-numeric:tabular-nums;">${formatDuration(timeInStage)}</td>
      <td>${formatCutoff(tx)}</td>
      <td><span class="risk-dot ${riskDotClass(tx.riskStatus)}"></span>${tx.riskStatus.charAt(0).toUpperCase() + tx.riskStatus.slice(1)}</td>
      <td><span class="manual-flag ${tx.manualIntervention ? "manual-yes" : "manual-no"}">${tx.manualIntervention ? "Yes" : "No"}</span></td>
      <td><span class="${tx.isSTP ? "stp-yes" : "stp-no"}">${tx.isSTP ? "STP" : "Non-STP"}</span></td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr[data-txid]").forEach(row => {
    row.addEventListener("click", () => {
      const tx = window.TRANSACTIONS.find(t => t.id === row.dataset.txid);
      if (tx) openModal(tx);
    });
  });

  const totalPages = Math.max(1, Math.ceil(data.length / state.pageSize));
  document.getElementById("pageInfo").textContent = `${data.length} transactions`;
  document.getElementById("prevPage").disabled = state.page <= 1;
  document.getElementById("nextPage").disabled = state.page >= totalPages;

  const paginationRow = document.querySelector(".pagination-row");
  if (paginationRow) paginationRow.style.display = totalPages <= 1 ? "none" : "flex";
}

// ── Modal ───────────────────────────────────────────────────
function openModal(tx) {
  const overlay = document.getElementById("modalOverlay");

  document.getElementById("modalTitle").textContent = tx.id;
  document.getElementById("modalSub").textContent = `${tx.asset} · ${tx.client}`;

  const riskColor = tx.riskStatus === "overdue" ? "#e53935" : tx.riskStatus === "critical" ? "#f5a623" : tx.riskStatus === "warning" ? "#f9c030" : "#2e7d32";
  const priorityIcon = tx.priority === "high" ? "🔴" : tx.priority === "medium" ? "🟡" : "🟢";
  const priorityLabel = tx.priority.charAt(0).toUpperCase() + tx.priority.slice(1);
  const tts = formatTimeToSettlement(tx);

  // Split cut-off into date / time for modal display
  let cutoffDateStr = "—", cutoffTimeStr = "—";
  let cutoffStatusCls = "";
  if (tx.cutoff) {
    cutoffDateStr = tx.cutoff.toLocaleDateString("en-GB", { day: "2-digit", month: "2-digit", year: "numeric" });
    cutoffTimeStr = tx.cutoff.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: false });
    if (tx.riskStatus === "overdue") cutoffStatusCls = "cutoff-modal-overdue";
    else if (tx.riskStatus === "critical") cutoffStatusCls = "cutoff-modal-critical";
  }

  // Enriched meta grid (3 rows × 4 cols)
  document.getElementById("modalMeta").innerHTML = `
    <div class="meta-item"><span class="meta-lbl">Asset Type</span><span class="meta-val">${tx.asset}</span></div>
    <div class="meta-item"><span class="meta-lbl">Client</span><span class="meta-val" style="font-size:11px;">${tx.client}</span></div>
    <div class="meta-item"><span class="meta-lbl">Client ID</span><span class="meta-val"><span class="client-id-badge">${tx.clientId || '—'}</span></span></div>
    <div class="meta-item"><span class="meta-lbl">Current Stage</span><span class="meta-val"><span class="stage-badge ${stageBadgeClass(tx.currentStage)}">${tx.currentStage}</span></span></div>
    <div class="meta-item"><span class="meta-lbl">Risk Status</span><span class="meta-val" style="color:${riskColor};font-weight:700;">${tx.riskStatus.toUpperCase()}</span></div>
    <div class="meta-item cutoff-meta-block ${cutoffStatusCls}">
      <span class="meta-lbl">⏰ Cut-off Date</span>
      <span class="meta-val cutoff-meta-val">${cutoffDateStr}</span>
    </div>
    <div class="meta-item cutoff-meta-block ${cutoffStatusCls}">
      <span class="meta-lbl">⏰ Cut-off Time</span>
      <span class="meta-val cutoff-meta-val">${cutoffTimeStr}</span>
    </div>

    <div class="meta-item meta-financial"><span class="meta-lbl">Notional</span><span class="meta-val meta-val-financial">${formatNotional(tx.notional, tx.currency)}</span></div>
    <div class="meta-item meta-financial"><span class="meta-lbl">EUR Equivalent</span><span class="meta-val meta-val-financial eur-highlight">${formatEUR(tx.notionalEUR)}</span></div>
    <div class="meta-item"><span class="meta-lbl">Time to Settlement</span><span class="meta-val" style="color:${tx.riskStatus === 'overdue' ? '#e53935' : tx.riskStatus === 'critical' ? '#f5a623' : '#1a1d23'};font-weight:700;">${tts}</span></div>
    <div class="meta-item">
      <span class="meta-lbl">Priority
        <button class="risk-info-btn modal-risk-info" onclick="toggleRiskPopover(this)" title="How is the Risk Score calculated?">&#9432;</button>
      </span>
      <span class="meta-val">${priorityIcon} ${priorityLabel} &nbsp;<span class="priority-score-chip">Score: ${tx.riskScore}/100</span></span>
    </div>

    <div class="meta-item"><span class="meta-lbl">Manual Intervention</span><span class="meta-val">${tx.manualIntervention ? "⚠ Required" : "None"}</span></div>
    <div class="meta-item"><span class="meta-lbl">STP</span><span class="meta-val ${tx.isSTP ? 'stp-yes' : 'stp-no'}">${tx.isSTP ? "✔ STP" : "✖ Non-STP"}</span></div>
    <div class="meta-item"><span class="meta-lbl">Trade Date</span><span class="meta-val">${fmtDateTime(tx.tradeDate)}</span></div>
    <div class="meta-item"><span class="meta-lbl">Total Lifecycle</span><span class="meta-val">${formatDuration(tx.totalDuration)}</span></div>
    <div class="meta-item meta-last-modified"><span class="meta-lbl">Last Modified By</span><span class="meta-val"><span class="meta-modified-user">${tx.lastModifiedBy || "—"}</span>${tx.lastModifiedAt ? '<span class="meta-modified-time">' + tx.lastModifiedAt.toLocaleTimeString("en-GB", {hour:"2-digit",minute:"2-digit"}) + " · " + tx.lastModifiedAt.toLocaleDateString("en-GB",{day:"2-digit",month:"2-digit"}) + '</span>' : ""}</span></div>
  `;

  // Timeline
  const stages = ["Capture", "Confirmation", "Settlement", "Reconciliation", "Completed"];
  const stageColors = { Capture: "#1976d2", Confirmation: "#f57f17", Settlement: "#c62828", Reconciliation: "#7b1fa2", Completed: "#2e7d32" };
  const stageClasses = { Capture: "tl-capture", Confirmation: "tl-confirmation", Settlement: "tl-settlement", Reconciliation: "tl-reconciliation", Completed: "tl-completed" };

  document.getElementById("timelineContainer").innerHTML = stages.map(s => {
    const ts = tx.timestamps[s];
    const isActive = tx.currentStage === s && s !== "Completed";
    const isFuture = !ts;
    const cls = isFuture ? "tl-pending" : stageClasses[s];

    if (isFuture) return `
      <div class="tl-item ${cls}">
        <div class="tl-dot"></div>
        <div class="tl-content" style="opacity:0.4;">
          <div class="tl-stage-name">${s}</div>
          <div style="font-size:11px;color:#9ba3b5;margin-top:4px;">Pending</div>
        </div>
      </div>`;

    return `
      <div class="tl-item ${cls}">
        <div class="tl-dot"></div>
        <div class="tl-content">
          <div class="tl-stage-name" style="color:${stageColors[s]};">${s}</div>
          <div class="tl-timestamps">
            <div class="tl-ts-group"><span class="tl-ts-lbl">Entry</span><span class="tl-ts-val">${fmtDateTime(ts.entry)}</span></div>
            ${ts.exit ? `<div class="tl-ts-group"><span class="tl-ts-lbl">Exit</span><span class="tl-ts-val">${fmtDateTime(ts.exit)}</span></div>` : ""}
          </div>
          ${ts.duration != null ? `<span class="tl-duration">⏱ ${formatDuration(ts.duration)}${isActive ? " so far" : ""}</span>` : ""}
          ${isActive ? `<div class="tl-active-indicator"><span class="tl-active-dot"></span> Currently Active</div>` : ""}
        </div>
      </div>`;
  }).join("");

  const actEl = document.getElementById("modalActions");
  if (actEl) actEl.innerHTML = getModalActions(tx);

  // ── Predictive forecast block ────────────────────────────
  if (window.renderModalForecast) window.renderModalForecast(tx);

  // ── Render Activity History / Audit Trail ────────────────
  renderAuditTrail(tx);

  overlay.classList.add("open");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  document.getElementById("modalOverlay").classList.remove("open");
  document.body.style.overflow = "";
}


// ── Master Render ───────────────────────────────────────────
function render() {
  if (window.recalculateRiskData) window.recalculateRiskData();
  const filtered = getFiltered();
  renderKPIs(filtered);
  renderStageErrors(filtered);
  if (window.renderPredictive) window.renderPredictive(filtered);
  renderAlerts(filtered);
  renderTable(filtered);
}

// ── Populate Client Dropdown ────────────────────────────────
function populateClients() {
  const clients = [...new Set(window.TRANSACTIONS.map(t => t.client))].sort();
  const sel = document.getElementById("clientFilter");
  clients.forEach(c => {
    const opt = document.createElement("option");
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
}

// ── Event Listeners ─────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  populateClients();
  render();
  startClock();
  startAutoRefresh();

  document.getElementById("assetFilter").addEventListener("click", e => {
    if (!e.target.classList.contains("chip")) return;
    document.querySelectorAll("#assetFilter .chip").forEach(c => c.classList.remove("active"));
    e.target.classList.add("active");
    state.assetFilter = e.target.dataset.value; state.page = 1; render();
  });

  document.getElementById("cutoffFilter").addEventListener("click", e => {
    if (!e.target.classList.contains("chip")) return;
    document.querySelectorAll("#cutoffFilter .chip").forEach(c => c.classList.remove("active"));
    e.target.classList.add("active");
    state.cutoffFilter = e.target.dataset.value; state.page = 1; render();
  });

  document.getElementById("clientFilter").addEventListener("change", e => {
    state.clientFilter = e.target.value; state.page = 1; render();
  });
  document.getElementById("stageFilter").addEventListener("change", e => {
    state.stageFilter = e.target.value; state.page = 1; render();
  });

  document.getElementById("resetFilters").addEventListener("click", () => {
    state = {
      ...state, assetFilter: "all", clientFilter: "all", cutoffFilter: "all",
      stageFilter: "all", searchQuery: "", kpiFilter: null,
      riskScoreFilter: null, stageErrFilter: null,
      cutoffTimeFilter: { start: -1, end: -1 }, page: 1
    };
    document.querySelectorAll("#assetFilter .chip").forEach(c => c.classList.remove("active"));
    document.querySelector("#assetFilter .chip[data-value='all']").classList.add("active");
    document.querySelectorAll("#cutoffFilter .chip").forEach(c => c.classList.remove("active"));
    document.querySelector("#cutoffFilter .chip[data-value='all']").classList.add("active");
    // Reset cutoff time dropdown
    document.querySelectorAll("#cutoffTimePanel .cutoff-time-option").forEach(o => {
      o.classList.remove("active");
      o.setAttribute("aria-selected", "false");
    });
    const defaultOpt = document.querySelector("#cutoffTimePanel .cutoff-time-option[data-start='-1']");
    if (defaultOpt) { defaultOpt.classList.add("active"); defaultOpt.setAttribute("aria-selected", "true"); }
    document.getElementById("cutoffTimeLabel").textContent = "All Day";
    document.getElementById("cutoffTimeDropdown").classList.remove("is-active", "open");
    document.getElementById("clientFilter").value = "all";
    document.getElementById("stageFilter").value = "all";
    document.getElementById("tableSearch").value = "";
    // Reset risk score chips
    document.querySelectorAll("#riskScoreFilterBar .rs-chip").forEach(c => c.classList.remove("active"));
    const allChip = document.querySelector("#riskScoreFilterBar .rs-chip-all");
    if (allChip) allChip.classList.add("active");
    render();
  });

  let searchTimer;
  document.getElementById("tableSearch").addEventListener("input", e => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.searchQuery = e.target.value.trim(); state.page = 1; render(); }, 200);
  });

  document.getElementById("prevPage").addEventListener("click", () => { if (state.page > 1) { state.page--; renderTable(getFiltered()); } });
  document.getElementById("nextPage").addEventListener("click", () => { state.page++; renderTable(getFiltered()); });

  // ── KPI Card click handlers (Operational) ─────────────────
  const kpiClickMap = {
    "kpi-reqaction":"reqaction","kpi-nearcutoff":"nearcutoff","kpi-overdue":"overdue",
    "kpi-manual":"manual","kpi-settlement":"settlement","kpi-sla":"sla",
    "kpi-confirmation":"confirmation","kpi-critical":"critical"
  };
  Object.entries(kpiClickMap).forEach(([elId, filterKey]) => {
    const el = document.getElementById(elId);
    if (!el) return;
    el.addEventListener("click", () => {
      state.kpiFilter = (state.kpiFilter === filterKey) ? null : filterKey;
      state.page = 1;
      render();
    });
  });


  // ── Risk Score Interval Filter chips ─────────────────────
  const rsFilterBar = document.getElementById("riskScoreFilterBar");
  if (rsFilterBar) {
    rsFilterBar.addEventListener("click", e => {
      const chip = e.target.closest(".rs-chip");
      if (!chip) return;
      rsFilterBar.querySelectorAll(".rs-chip").forEach(c => c.classList.remove("active"));
      chip.classList.add("active");
      const min = parseInt(chip.dataset.min), max = parseInt(chip.dataset.max);
      state.riskScoreFilter = (min === 0 && max === 100) ? null : { min, max };
      state.page = 1;
      render();
    });
  }

  // ── Cut-off time interval dropdown ───────────────────────────
  const ctDropdown = document.getElementById("cutoffTimeDropdown");
  const ctTrigger  = document.getElementById("cutoffTimeTrigger");
  const ctPanel    = document.getElementById("cutoffTimePanel");
  const ctLabel    = document.getElementById("cutoffTimeLabel");

  function closeCutoffDropdown() {
    ctDropdown.classList.remove("open");
    ctTrigger.setAttribute("aria-expanded", "false");
  }

  ctTrigger.addEventListener("click", e => {
    e.stopPropagation();
    const isOpen = ctDropdown.classList.toggle("open");
    ctTrigger.setAttribute("aria-expanded", isOpen ? "true" : "false");
  });

  ctPanel.addEventListener("click", e => {
    const btn = e.target.closest(".cutoff-time-option");
    if (!btn) return;

    // Update active option
    ctPanel.querySelectorAll(".cutoff-time-option").forEach(o => {
      o.classList.remove("active");
      o.setAttribute("aria-selected", "false");
    });
    btn.classList.add("active");
    btn.setAttribute("aria-selected", "true");

    // Update trigger label
    ctLabel.textContent = btn.textContent;

    // Apply/clear accent class on the wrapper
    const start = parseInt(btn.dataset.start, 10);
    const end   = parseInt(btn.dataset.end,   10);
    ctDropdown.classList.toggle("is-active", start >= 0);

    // Update state and re-render
    state.cutoffTimeFilter = { start, end };
    state.page = 1;
    render();

    // Collapse panel
    closeCutoffDropdown();
  });

  // Close dropdown when clicking outside
  document.addEventListener("click", e => {
    if (!ctDropdown.contains(e.target)) closeCutoffDropdown();
    // Close user switcher when clicking outside
    const userEl = document.getElementById("headerUser");
    if (userEl && !userEl.contains(e.target)) closeUserSwitcher();
  });

  // Close on Escape key
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") { closeCutoffDropdown(); closeUserSwitcher(); }
  });

  document.getElementById("modalClose").addEventListener("click", closeModal);
  document.getElementById("modalOverlay").addEventListener("click", e => { if (e.target === document.getElementById("modalOverlay")) closeModal(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });
});

// ── Clock ───────────────────────────────────────────────────
function startClock() {
  function tick() {
    const now = new Date();
    document.getElementById("headerTime").textContent =
      now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) +
      " · " + now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
  }
  tick();
  setInterval(tick, 1000);
}

// ── Auto-Refresh: recalculate risk & re-render every 60 seconds ──
let autoRefreshTimer = null;
function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(function() {
    render();
  }, 60000); // every 60 seconds
}
