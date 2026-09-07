// ============================================================
// BNP Paribas Securities — In-Page Notification System
// Monitors transactions and alerts the ops team via bell icon
// dropdown and toast pop-ups. Runs every 60 seconds.
// ============================================================

"use strict";

(function () {
  // ── Notification State ─────────────────────────────────────
  const notifications = [];        // Array of notification objects
  const firedAlerts = new Set();   // Dedup keys: "TXN-xxxxx:alertType"
  let unreadCount = 0;
  let dropdownOpen = false;
  let notifIdCounter = 0;
  const MAX_TOASTS = 4;
  const TOAST_DURATION = 5000;     // 5 seconds
  const SCAN_INTERVAL = 60000;     // 60 seconds
  const TOAST_STAGGER = 700;       // Minimum gap between two toasts appearing
  const MAX_QUEUED_TOASTS = 6;     // Backlog shown as toasts; the rest go to the bell only

  // ── Alert Type Definitions ─────────────────────────────────
  const ALERT_TYPES = {
    "overdue":    { icon: "🔴", label: "OVERDUE",       color: "notif-red",    colorVar: "var(--red)" },
    "cutoff-10":  { icon: "⛔", label: "CUT-OFF 10MIN", color: "notif-red",    colorVar: "var(--red)" },
    "cutoff-30":  { icon: "⚡", label: "CUT-OFF 30MIN", color: "notif-orange", colorVar: "var(--orange)" },
    "manual":     { icon: "✋", label: "MANUAL",         color: "notif-purple", colorVar: "var(--purple)" },
    "high-risk":  { icon: "⚠",  label: "HIGH RISK",     color: "notif-orange", colorVar: "var(--orange)" },
    "risk-warn":  { icon: "\u26a0",  label: "RISK WARNING",  color: "notif-orange", colorVar: "var(--orange)" },
    "risk-crit":  { icon: "\ud83d\udd34", label: "RISK CRITICAL", color: "notif-red",    colorVar: "var(--red)" },
    "user-action": { icon: "✅", label: "ACTION",        color: "notif-green",  colorVar: "var(--green)" },
    "predictive": { icon: "◈", label: "PREDICTED",   color: "notif-blue",   colorVar: "var(--blue)" },
  };

  // ── Time Formatting ────────────────────────────────────────
  function timeAgo(date) {
    const now = new Date();
    const diffMs = now - date;
    const diffMin = Math.floor(diffMs / 60000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return diffMin + "m ago";
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return diffH + "h ago";
    return Math.floor(diffH / 24) + "d ago";
  }

  function formatTime(date) {
    return date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  // ── Inject Bell Icon into Header ───────────────────────────
  function injectBellIcon() {
    const headerRight = document.querySelector(".header-right");
    if (!headerRight) return;

    // Insert bell before the clock element
    const headerTime = document.getElementById("headerTime");

    const bellWrapper = document.createElement("div");
    bellWrapper.className = "notif-bell-wrapper";
    bellWrapper.id = "notifBellWrapper";
    bellWrapper.innerHTML = `
      <button class="notif-bell-btn" id="notifBellBtn" title="Notifications" aria-label="Notifications" aria-haspopup="true" aria-expanded="false">
        <svg class="notif-bell-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
          <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
        </svg>
        <span class="notif-bell-badge" id="notifBellBadge" style="display:none;">0</span>
      </button>
    `;

    headerRight.insertBefore(bellWrapper, headerTime);

    // Create dropdown panel
    const dropdown = document.createElement("div");
    dropdown.className = "notif-dropdown";
    dropdown.id = "notifDropdown";
    dropdown.innerHTML = `
      <div class="notif-dropdown-header">
        <div class="notif-dropdown-title">
          <span>Notifications</span>
          <span class="notif-dropdown-count" id="notifDropdownCount">0 unread</span>
        </div>
        <button class="notif-mark-all-btn" id="notifMarkAllBtn" title="Mark all as read">Mark all read</button>
      </div>
      <div class="notif-dropdown-list" id="notifDropdownList">
        <div class="notif-empty-state">
          <span class="notif-empty-icon">🔔</span>
          <span>No notifications yet</span>
          <span class="notif-empty-sub">Alerts will appear here when transactions need attention</span>
        </div>
      </div>
    `;
    bellWrapper.appendChild(dropdown);

    // Event listeners
    document.getElementById("notifBellBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      toggleDropdown();
    });

    document.getElementById("notifMarkAllBtn").addEventListener("click", function (e) {
      e.stopPropagation();
      markAllRead();
    });

    // Close on outside click
    document.addEventListener("click", function (e) {
      if (dropdownOpen && !bellWrapper.contains(e.target)) {
        closeDropdown();
      }
    });

    // Close on Escape
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && dropdownOpen) {
        closeDropdown();
      }
    });
  }

  // ── Inject Toast Container ─────────────────────────────────
  function injectToastContainer() {
    const container = document.createElement("div");
    container.className = "notif-toast-container";
    container.id = "notifToastContainer";
    document.body.appendChild(container);
  }

  // ── Dropdown Toggle ────────────────────────────────────────
  function toggleDropdown() {
    dropdownOpen ? closeDropdown() : openDropdown();
  }

  function openDropdown() {
    dropdownOpen = true;
    const dropdown = document.getElementById("notifDropdown");
    const btn = document.getElementById("notifBellBtn");
    if (dropdown) dropdown.classList.add("open");
    if (btn) btn.setAttribute("aria-expanded", "true");
    renderDropdown();
  }

  function closeDropdown() {
    dropdownOpen = false;
    const dropdown = document.getElementById("notifDropdown");
    const btn = document.getElementById("notifBellBtn");
    if (dropdown) dropdown.classList.remove("open");
    if (btn) btn.setAttribute("aria-expanded", "false");
  }

  // ── Badge Update ───────────────────────────────────────────
  function updateBadge() {
    unreadCount = notifications.filter(n => !n.read).length;
    const badge = document.getElementById("notifBellBadge");
    const countEl = document.getElementById("notifDropdownCount");
    const bellBtn = document.getElementById("notifBellBtn");

    if (badge) {
      if (unreadCount > 0) {
        badge.style.display = "flex";
        badge.textContent = unreadCount > 99 ? "99+" : unreadCount;
        badge.classList.add("has-unread");
      } else {
        badge.style.display = "none";
        badge.classList.remove("has-unread");
      }
    }

    if (bellBtn) {
      bellBtn.classList.toggle("bell-has-unread", unreadCount > 0);
    }

    if (countEl) {
      countEl.textContent = unreadCount > 0 ? unreadCount + " unread" : "All caught up";
      countEl.classList.toggle("notif-count-zero", unreadCount === 0);
    }
  }

  // ── Render Dropdown List ───────────────────────────────────
  function renderDropdown() {
    const list = document.getElementById("notifDropdownList");
    if (!list) return;

    if (notifications.length === 0) {
      list.innerHTML = `
        <div class="notif-empty-state">
          <span class="notif-empty-icon">🔔</span>
          <span>No notifications yet</span>
          <span class="notif-empty-sub">Alerts will appear here when transactions need attention</span>
        </div>
      `;
      return;
    }

    // Sort newest first
    const sorted = [...notifications].sort((a, b) => b.timestamp - a.timestamp);

    list.innerHTML = sorted.map(n => {
      const alertDef = ALERT_TYPES[n.type] || ALERT_TYPES["high-risk"];
      const readClass = n.read ? "notif-item-read" : "notif-item-unread";
      const timeStr = timeAgo(n.timestamp);
      const timeTitle = formatTime(n.timestamp);

      return `
        <div class="notif-item ${readClass} ${alertDef.color}" data-notif-id="${n.id}" data-tx-id="${n.txId}">
          <div class="notif-item-left">
            <span class="notif-item-dot ${n.read ? '' : 'notif-dot-active'}"></span>
            <div class="notif-item-content">
              <div class="notif-item-top">
                <span class="notif-item-icon">${alertDef.icon}</span>
                <span class="notif-item-label">${alertDef.label}</span>
                <span class="notif-item-txid">${n.txId}</span>
              </div>
              <div class="notif-item-msg">${n.message}</div>
              <div class="notif-item-time" title="${timeTitle}">${timeStr}</div>
            </div>
          </div>
          <button class="notif-item-read-btn" data-notif-id="${n.id}" title="${n.read ? 'Already read' : 'Mark as read'}" ${n.read ? 'disabled' : ''}>
            ${n.read ? '✓' : '●'}
          </button>
        </div>
      `;
    }).join("");

    // Attach click handlers
    list.querySelectorAll(".notif-item").forEach(el => {
      el.addEventListener("click", function (e) {
        // Don't navigate if clicking the read button
        if (e.target.closest(".notif-item-read-btn")) return;

        const txId = el.dataset.txId;
        const notifId = parseInt(el.dataset.notifId, 10);

        // Mark as read
        markAsRead(notifId);

        // Navigate to transaction detail
        const tx = window.TRANSACTIONS.find(t => t.id === txId);
        if (tx && typeof openModal === "function") {
          closeDropdown();
          openModal(tx);
        }
      });
    });

    // Attach read button handlers
    list.querySelectorAll(".notif-item-read-btn").forEach(btn => {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        const notifId = parseInt(btn.dataset.notifId, 10);
        markAsRead(notifId);
      });
    });
  }

  // ── Mark as Read ───────────────────────────────────────────
  function markAsRead(notifId) {
    const notif = notifications.find(n => n.id === notifId);
    if (notif && !notif.read) {
      notif.read = true;
      updateBadge();
      if (dropdownOpen) renderDropdown();
    }
  }

  function markAllRead() {
    let changed = false;
    notifications.forEach(n => {
      if (!n.read) { n.read = true; changed = true; }
    });
    if (changed) {
      updateBadge();
      if (dropdownOpen) renderDropdown();
    }
  }

  // ── Toast Queue ─────────────────────────────────
  // A scan can raise dozens of alerts in one pass. Releasing them at a
  // steady pace keeps the stack within MAX_TOASTS and each toast on
  // screen long enough to read; the bell dropdown remains the full record.
  const toastQueue = [];
  let toastPumpTimer = null;

  function enqueueToast(notification) {
    toastQueue.push(notification);
    // A full book scanned for the first time would otherwise trickle for
    // minutes, so keep only the most recent alerts.
    if (toastQueue.length > MAX_QUEUED_TOASTS) {
      toastQueue.splice(0, toastQueue.length - MAX_QUEUED_TOASTS);
    }
    // Nothing in flight: show this one straight away so single events
    // (a user action, one new breach) still feel immediate.
    if (toastPumpTimer === null) pumpToastQueue();
  }

  function pumpToastQueue() {
    const next = toastQueue.shift();
    if (next) showToast(next);
    toastPumpTimer = setTimeout(function () {
      toastPumpTimer = null;
      if (toastQueue.length > 0) pumpToastQueue();
    }, TOAST_STAGGER);
  }

  // ── Toast Notifications ────────────────────────────────────
  function showToast(notification) {
    const container = document.getElementById("notifToastContainer");
    if (!container) return;

    // Limit visible toasts. A toast already animating out still sits in
    // the DOM for a moment, so it must not count towards the limit, and a
    // burst can need more than one eviction to get back under it.
    const existing = Array.prototype.filter.call(
      container.querySelectorAll(".notif-toast"),
      (t) => !t.classList.contains("notif-toast-exit")
    );
    for (let i = 0; i <= existing.length - MAX_TOASTS; i++) {
      dismissToast(existing[i]);
    }

    const alertDef = ALERT_TYPES[notification.type] || ALERT_TYPES["high-risk"];
    const toast = document.createElement("div");
    toast.className = `notif-toast notif-toast-enter ${alertDef.color}`;
    toast.dataset.notifId = notification.id;

    toast.innerHTML = `
      <div class="notif-toast-left">
        <span class="notif-toast-icon">${alertDef.icon}</span>
        <div class="notif-toast-body">
          <div class="notif-toast-top">
            <span class="notif-toast-label">${alertDef.label}</span>
            <span class="notif-toast-txid">${notification.txId}</span>
          </div>
          <div class="notif-toast-msg">${notification.message}</div>
        </div>
      </div>
      <button class="notif-toast-close" title="Dismiss">&times;</button>
    `;

    container.appendChild(toast);

    // Trigger enter animation
    requestAnimationFrame(() => {
      toast.classList.remove("notif-toast-enter");
    });

    // Click to navigate
    toast.addEventListener("click", function (e) {
      if (e.target.closest(".notif-toast-close")) return;
      const tx = window.TRANSACTIONS.find(t => t.id === notification.txId);
      if (tx && typeof openModal === "function") {
        markAsRead(notification.id);
        openModal(tx);
      }
      dismissToast(toast);
    });

    // Close button
    toast.querySelector(".notif-toast-close").addEventListener("click", function (e) {
      e.stopPropagation();
      dismissToast(toast);
    });

    // Auto-dismiss
    setTimeout(() => dismissToast(toast), TOAST_DURATION);
  }

  function dismissToast(toast) {
    if (!toast || toast.classList.contains("notif-toast-exit")) return;
    toast.classList.add("notif-toast-exit");
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 400);
  }

  // ── Alert Engine — Scan Transactions ───────────────────────
  function scanForAlerts() {
    if (!window.TRANSACTIONS) return;

    // Recalculate risk data before scanning
    if (window.recalculateRiskData) window.recalculateRiskData();

    const now = new Date();
    const newAlerts = [];

    window.TRANSACTIONS.forEach(function (tx) {
      // Skip completed or suppressed transactions
      if (tx.currentStage === "Completed") return;
      if (tx._alertSuppressed) return;

      // 1. Overdue
      if (tx.riskStatus === "overdue" && tx.cutoff) {
        const key = tx.id + ":overdue";
        if (!firedAlerts.has(key)) {
          firedAlerts.add(key);
          var overdueMin = Math.abs(tx.minutesToCutoff);
          newAlerts.push(createNotification(tx.id, "overdue",
            tx.id + " is " + window.formatDuration(overdueMin) + " overdue — " + tx.currentStage + " stage"
          ));
        }
      }

      // 2. Cut-off approaching ≤ 10 min (but not overdue)
      if (tx.cutoff && tx.minutesToCutoff >= 0 && tx.minutesToCutoff <= 10 && tx.riskStatus !== "overdue") {
        var key10 = tx.id + ":cutoff-10";
        if (!firedAlerts.has(key10)) {
          firedAlerts.add(key10);
          newAlerts.push(createNotification(tx.id, "cutoff-10",
            tx.id + " cut-off in " + tx.minutesToCutoff + " min — " + tx.currentStage + " stage"
          ));
        }
      }

      // 3. Cut-off approaching ≤ 30 min (but not ≤10 or overdue)
      if (tx.cutoff && tx.minutesToCutoff > 10 && tx.minutesToCutoff <= 30) {
        var key30 = tx.id + ":cutoff-30";
        if (!firedAlerts.has(key30)) {
          firedAlerts.add(key30);
          newAlerts.push(createNotification(tx.id, "cutoff-30",
            tx.id + " cut-off in " + window.formatDuration(tx.minutesToCutoff) + " — " + tx.currentStage + " stage"
          ));
        }
      }

      // 4. Manual intervention required
      if (tx.manualIntervention) {
        var keyManual = tx.id + ":manual";
        if (!firedAlerts.has(keyManual)) {
          firedAlerts.add(keyManual);
          newAlerts.push(createNotification(tx.id, "manual",
            tx.id + " requires manual intervention — " + tx.asset + " · " + tx.client.split(" ").slice(0, 2).join(" ")
          ));
        }
      }

      // 5a. Critical risk score (86-100) - immediate escalation
      if (tx.riskScore >= 86 && tx.riskStatus !== "ok") {
        var keyCrit = tx.id + ":risk-crit";
        if (!firedAlerts.has(keyCrit)) {
          firedAlerts.add(keyCrit);
          newAlerts.push(createNotification(tx.id, "risk-crit",
            tx.id + " requires IMMEDIATE attention (Risk Score: " + tx.riskScore + "/100) - " + tx.currentStage
          ));
        }
      }

      // 5b. High risk score (70-85) - warning
      if (tx.riskScore >= 70 && tx.riskScore < 86 && tx.riskStatus !== "ok") {
        var keyWarn = tx.id + ":risk-warn";
        if (!firedAlerts.has(keyWarn)) {
          firedAlerts.add(keyWarn);
          newAlerts.push(createNotification(tx.id, "risk-warn",
            tx.id + " entered high-risk zone (Score: " + tx.riskScore + ") - " + tx.currentStage
          ));
        }
      }
    });

    // Add all new alerts
    if (newAlerts.length > 0) {
      newAlerts.forEach(function (n) {
        notifications.push(n);
        enqueueToast(n);
      });
      updateBadge();
      if (dropdownOpen) renderDropdown();
    }
  }

  function createNotification(txId, type, message) {
    return {
      id: ++notifIdCounter,
      txId: txId,
      type: type,
      message: message,
      timestamp: new Date(),
      read: false
    };
  }

  // Forecast the whole book and let the predictive check raise anything
  // that crossed a threshold. Deliberately not filtered by the UI: an
  // alert must not disappear because a filter is applied.
  function scanPredictive() {
    if (!window.PredictiveOps || !window.checkPredictiveAlerts) return;
    if (!window.TRANSACTIONS) return;
    var horizon = window.predictHorizon || 120;
    window.checkPredictiveAlerts(window.PredictiveOps.summarise(window.TRANSACTIONS, horizon));
  }

  // ── Initialize ─────────────────────────────────────────────
  function init() {
    injectBellIcon();
    injectToastContainer();

    // Initial scan — slight delay to let the dashboard render first
    setTimeout(function () {
      scanForAlerts();
    }, 1500);

    // The first forecast runs a few seconds later. Both scans share one
    // toast queue that keeps only the most recent entries, so firing them
    // together let the forecast crowd out the live alerts; staggering
    // shows current exceptions first, then what is coming.
    setTimeout(function () {
      scanPredictive();
    }, 5000);

    // Periodic scan every 60 seconds
    setInterval(function () {
      scanForAlerts();
      scanPredictive();
    }, SCAN_INTERVAL);

    // ── Predictive escalations ───────────────────────────────
    // Called from the predictive render pass. Only fires when a
    // transaction is BOTH highly likely to breach and close enough to its
    // cut-off to be actionable, and only once per severity band, so an
    // item escalating high -> critical notifies twice at most.
    window.checkPredictiveAlerts = function (summary) {
      if (!summary || !summary.rows) return;
      var fired = [];
      summary.rows.forEach(function (f) {
        if (f.probability < 80) return;
        if (f.category === "breached") return;
        // Imminence gate: a 90% risk a day out is not tonight's problem.
        if (f.minutesToCutoff == null || f.minutesToCutoff < 0 || f.minutesToCutoff > 240) return;

        var key = f.txId + ":predict-" + f.severity;
        if (firedAlerts.has(key)) return;
        firedAlerts.add(key);

        var msg = f.txId + " has a " + f.probability + "% probability of missing cut-off in " +
                  window.formatDuration(f.minutesToCutoff);
        fired.push(createNotification(f.txId, "predictive", msg));
      });

      if (fired.length) {
        fired.forEach(function (n) {
          notifications.push(n);
          enqueueToast(n);
        });
        updateBadge();
        if (dropdownOpen) renderDropdown();
      }
    };

    // ── Expose push function for user action notifications ──
    window.pushActionNotification = function(txId, userName, actionLabel) {
      var msg = userName + " — " + actionLabel + " on " + txId;
      var notif = createNotification(txId, "user-action", msg);
      notifications.push(notif);
      enqueueToast(notif);
      updateBadge();
      if (dropdownOpen) renderDropdown();
    };
  }

  // Start on DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
