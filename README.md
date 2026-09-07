# Operations Monitoring Desk

**BNP Paribas Securities Services — Post-Trade Exception Management**

🌐 **Live Demo:** [https://dashboardbnpoperations.tiagosolipa.workers.dev/](https://dashboardbnpoperations.tiagosolipa.workers.dev/)

---

An action-oriented operational workstation for post-trade exception management. Built as a prototype during the **BNP Paribas DRIVE Mentoring Programme**.

## Overview

Designed for operations teams who need to triage and resolve issues in real time. Unlike the Lifecycle Dashboard, this tool is built for **intervention**, surfacing SLA breaches, cut-off countdowns, and risk-scored alerts so operators can act before deadlines are missed.

## Features

- **8 Live KPI Cards** — Requiring action, near cut-off, overdue, manual queue, settlement pending, SLA breaches, awaiting confirmation, critical alerts
- **Stage Hotspot Indicators** — Highlights which workflow stage has the highest exception concentration
- **Risk & Alert Monitor** — Prioritized alert table with risk scores (0–100), cut-off times, alert reasons, and one-click action buttons
- **Risk Score Filtering** — Filter alerts by Low / Med / High / V.High / Critical
- **Transaction Register** — Full transaction list with workflow timeline per transaction
- **Activity History** — Per-transaction log of actions taken
- **Predictive Operations** — Forward-looking layer that forecasts which transactions will breach before they start alerting, by comparing time already spent in a stage against the stage's expected duration and the time left to cut-off. Each forecast carries a probability, a full arithmetic breakdown of how it was derived, and a recommended action
- **Notification System** — Real-time bell icon notifications and toast pop-ups for overdue, cut-off, risk, and predictive alerts
- **Role-based Profiles** — Switch between Ops Manager and Project Manager roles

## Filters

- Asset Type, Client, Cut-Off Window, Cut-Off Time Interval, Workflow Stage

## 📂 How to Run Locally

Clone the repository (or download the ZIP via the green **Code** button above), then either:

- Open `DashboardBNP/index.html` directly in any browser, or
- Serve the folder over HTTP, which is closer to how it is deployed:

  ```bash
  cd DashboardBNP
  python -m http.server 8765
  ```

  Then visit <http://127.0.0.1:8765/index.html>.

There is no build step and no dependencies — the dashboard is plain HTML, CSS and JavaScript.

## Tech Stack

- Vanilla JavaScript · CSS · HTML — no framework, no build step
- Built with AI-assisted development using Google Antigravity
