/* Day/Night HOTO client */
(function () {
  "use strict";

  const SM = (window.SM = window.SM || {});

  function t(key, vars) {
    return window.smT ? window.smT(key, vars) : key;
  }

  function L(text) {
    return window.smL ? window.smL(text) : text == null ? "" : String(text);
  }

  function uiLocale() {
    return window.smLocale && smLocale() === "zh" ? "zh-CN" : "en";
  }

  function can(flag) {
    return !!(SM.caps && SM.caps[flag]);
  }

  function toast(msg) {
    const el = document.getElementById("sm-toast");
    const text = L(msg);
    if (!el) {
      alert(text);
      return;
    }
    el.textContent = text;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () {
      el.hidden = true;
    }, 2800);
  }

  async function api(path, opts) {
    const ctrl = new AbortController();
    const timeoutMs = (opts && opts.timeoutMs) || 20000;
    const timer = setTimeout(function () {
      ctrl.abort();
    }, timeoutMs);
    const fetchOpts = Object.assign(
      {
        credentials: "same-origin",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        signal: ctrl.signal,
      },
      opts || {}
    );
    delete fetchOpts.timeoutMs;
    let res;
    try {
      res = await fetch(path, fetchOpts);
    } catch (err) {
      if (err && err.name === "AbortError") throw new Error("Request timed out. Try Refresh.");
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }
    if (res.status === 401 && data && data.login) {
      window.location.href = data.login + "?next=" + encodeURIComponent(window.location.pathname);
      throw new Error("login required");
    }
    if (!res.ok) {
      const err = (data && data.error) || res.statusText || "Request failed";
      throw new Error(err);
    }
    return data;
  }

  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function statusClass(status) {
    return "status-" + String(status || "Running").replace(/\s+/g, "-");
  }

  function normalizeShiftClient(val) {
    if (val === "A") return "Day";
    if (val === "B" || val === "C") return "Night";
    if (val === "Day" || val === "Night") return val;
    return SM.defaultShift || "Day";
  }

  function rememberContext(dateVal, shiftVal) {
    try {
      sessionStorage.setItem("sm_shift", normalizeShiftClient(shiftVal));
      sessionStorage.setItem("sm_date", dateVal);
    } catch (_) {}
  }

  function rememberedShift() {
    try {
      return normalizeShiftClient(sessionStorage.getItem("sm_shift") || SM.defaultShift || "Day");
    } catch (_) {
      return normalizeShiftClient(SM.defaultShift || "Day");
    }
  }

  function rememberedDate() {
    try {
      return sessionStorage.getItem("sm_date") || todayISO();
    } catch (_) {
      return todayISO();
    }
  }

  function badgeForHandover(ho) {
    if (!ho) return '<span class="sm-badge">' + escapeHtml(L("No entry")) + "</span>";
    if (ho.status === "pending_ack") return '<span class="sm-badge pending">' + escapeHtml(L("Pending ack")) + "</span>";
    if (ho.status === "acknowledged") return '<span class="sm-badge ack">' + escapeHtml(L("Acked")) + "</span>";
    if (ho.status === "disputed") return '<span class="sm-badge urgent">' + escapeHtml(L("Disputed")) + "</span>";
    if (ho.priority === "Urgent") return '<span class="sm-badge urgent">' + escapeHtml(L("Urgent")) + "</span>";
    return '<span class="sm-badge">' + escapeHtml(L("Draft")) + "</span>";
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  const TICKET_STATUSES = [
    { code: "open", label: "Open", symbol: "○", tone: "open" },
    { code: "in_progress", label: "In progress", symbol: "▶", tone: "progress" },
    { code: "on_hold", label: "On hold", symbol: "⏸", tone: "hold" },
    { code: "resolved", label: "Resolved", symbol: "✓", tone: "resolved" },
    { code: "closed", label: "Closed", symbol: "●", tone: "closed" },
  ];

  const TICKET_CATEGORIES = {
    Quality: { symbol: "◆", tone: "quality" },
    Alarm: { symbol: "⚠", tone: "alarm" },
    Maintenance: { symbol: "⚙", tone: "maint" },
    Material: { symbol: "▣", tone: "material" },
    Tooling: { symbol: "⚒", tone: "tool" },
    Urgent: { symbol: "⚡", tone: "urgent" },
    Other: { symbol: "●", tone: "other" },
  };

  const TICKET_PRIORITIES = {
    Urgent: { symbol: "⚑", tone: "urgent" },
    High: { symbol: "▲", tone: "high" },
    Normal: { symbol: "●", tone: "normal" },
  };

  function ticketStatusMeta(code) {
    const found = TICKET_STATUSES.filter(function (item) {
      return item.code === code;
    })[0];
    if (!found) return { code: code || "open", label: L(code || "Open"), symbol: "●", tone: "other" };
    return { code: found.code, label: L(found.label), symbol: found.symbol, tone: found.tone };
  }

  function ticketIsOpen(status) {
    return status === "open" || status === "in_progress" || status === "on_hold";
  }

  function formatTicketWhen(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).replace("T", " ").slice(0, 16);
    return d.toLocaleString(uiLocale(), {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function sortTickets(items, mode) {
    const copy = (items || []).slice();
    const priorityRank = { Urgent: 0, High: 1, Normal: 2 };
    const statusRank = { open: 0, in_progress: 1, on_hold: 2, resolved: 3, closed: 4 };
    function timeOf(ticket) {
      const n = Date.parse(ticket.created_at || "");
      return Number.isNaN(n) ? 0 : n;
    }
    function whoOf(ticket) {
      return String(ticket.submitter_name || ticket.created_by_name || "").toLowerCase();
    }
    copy.sort(function (a, b) {
      if (mode === "newest") return timeOf(b) - timeOf(a);
      if (mode === "oldest") return timeOf(a) - timeOf(b);
      if (mode === "status") {
        return (statusRank[a.status] ?? 9) - (statusRank[b.status] ?? 9) || timeOf(b) - timeOf(a);
      }
      if (mode === "machine") {
        return (
          String(a.machine_no || "").localeCompare(String(b.machine_no || "")) || timeOf(b) - timeOf(a)
        );
      }
      if (mode === "submitter") return whoOf(a).localeCompare(whoOf(b)) || timeOf(b) - timeOf(a);
      if (mode === "category") {
        return String(a.category || "").localeCompare(String(b.category || "")) || timeOf(b) - timeOf(a);
      }
      return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9) || timeOf(b) - timeOf(a);
    });
    return copy;
  }

  function ticketCardHtml(ticket) {
    const status = ticketStatusMeta(ticket.status);
    const category = TICKET_CATEGORIES[ticket.category] || { symbol: "●", tone: "other" };
    const priority = TICKET_PRIORITIES[ticket.priority] || { symbol: "●", tone: "normal" };
    const priorityClass =
      ticket.priority === "Urgent" ? " is-priority-urgent" : ticket.priority === "High" ? " is-priority-high" : "";
    const name = ticket.submitter_name || ticket.created_by_name || "";
    const username = ticket.submitter_username || ticket.created_by_username || "";
    const role = ticket.submitter_role || ticket.created_by_role || "";
    const when = formatTicketWhen(ticket.created_at);
    const bits = [];
    if (username && username !== name) bits.push(username);
    if (role) bits.push(L(role));
    if (when) bits.push(when);
    if (ticket.shift_out) bits.push(L(ticket.shift_out));
    const actions = can("can_resolve_ticket")
      ? '<label class="sm-ticket-status-label">Status<select class="sm-input sm-ticket-status tone-' +
        status.tone +
        '" data-id="' +
        ticket.ticket_id +
        '" data-status="' +
        escapeHtml(ticket.status || "") +
        '" aria-label="' +
        escapeHtml(t("set_status_for", { id: ticket.ticket_id })) +
        '">' +
        TICKET_STATUSES.map(function (item) {
          return (
            '<option value="' +
            item.code +
            '"' +
            (item.code === ticket.status ? " selected" : "") +
            ">" +
            item.symbol +
            "  " +
            item.label +
            "</option>"
          );
        }).join("") +
        "</select></label>"
      : "";
    return (
      '<article class="sm-ticket is-status-' +
      status.tone +
      priorityClass +
      '">' +
      '<div class="sm-ticket-symbol tone-' +
      category.tone +
      '" title="' +
      escapeHtml(L(ticket.category || "Other")) +
      '" aria-hidden="true">' +
      category.symbol +
      "</div>" +
      '<div class="sm-ticket-main">' +
      '<div class="sm-ticket-title"><span class="sm-ticket-id">#' +
      ticket.ticket_id +
      "</span> " +
      escapeHtml(ticket.machine_no || "") +
      " · " +
      escapeHtml(ticket.title || "") +
      "</div>" +
      '<div class="sm-ticket-chips">' +
      '<span class="sm-ticket-chip tone-' +
      category.tone +
      '">' +
      category.symbol +
      " " +
      escapeHtml(L(ticket.category || "Other")) +
      "</span>" +
      '<span class="sm-ticket-chip tone-' +
      priority.tone +
      '">' +
      priority.symbol +
      " " +
      escapeHtml(L(ticket.priority || "Normal")) +
      "</span>" +
      '<span class="sm-ticket-chip tone-' +
      status.tone +
      '">' +
      status.symbol +
      " " +
      escapeHtml(status.label) +
      "</span>" +
      '<span class="sm-ticket-chip tone-other">' +
      escapeHtml(t("ps_chip", { ps: ticket.process_sheet_no || ticket.job_no || "-" })) +
      "</span></div>" +
      (ticket.description ? '<p class="sm-ticket-desc">' + escapeHtml(ticket.description) + "</p>" : "") +
      '<p class="sm-ticket-who">' +
      escapeHtml(L("Submitted by")) +
      " <strong>" +
      escapeHtml(name || username || L("Unknown user")) +
      "</strong>" +
      (bits.length ? ' <span class="sm-muted">' + escapeHtml(bits.join(" · ")) + "</span>" : "") +
      "</p></div>" +
      actions +
      "</article>"
    );
  }

  function bindTicketStatus(root, onChanged) {
    if (!root) return;
    root.querySelectorAll(".sm-ticket-status").forEach(function (sel) {
      sel.addEventListener("change", async function () {
        const id = sel.dataset.id;
        const prev = sel.dataset.status || "";
        const next = sel.value;
        if (!id || next === prev) return;
        sel.disabled = true;
        try {
          await api("/api/shift-management/tickets/" + id, {
            method: "PATCH",
            body: JSON.stringify({ status: next }),
          });
          toast(t("status_set", { status: ticketStatusMeta(next).label }));
          if (onChanged) await onChanged();
        } catch (err) {
          sel.value = prev;
          toast(err.message);
        } finally {
          sel.disabled = false;
        }
      });
    });
  }

  function handoverStatusKey(ho) {
    if (!ho) return "none";
    if (ho.status === "pending_ack") return "pending";
    if (ho.status === "acknowledged") return "acked";
    if (ho.status === "disputed") return "disputed";
    if (ho.priority === "Urgent") return "urgent";
    return "draft";
  }

  function downloadReportPdf(dateVal, shiftVal) {
    const shift = normalizeShiftClient(shiftVal || rememberedShift());
    const q = new URLSearchParams({ date: dateVal || todayISO(), shift: shift });
    window.location.href = "/api/shift-management/report.pdf?" + q.toString();
  }

  function renderFloorLegend(colors) {
    const legend = document.getElementById("sm-floor-legend");
    if (!legend) return;
    const items = [
      ["Turnmill", colors.turnmill],
      ["MPP", colors.mpp],
      ["Turning", colors.turning],
      ["Milling", colors.milling],
    ];
    legend.innerHTML = items
      .map(function (pair) {
        return (
          '<span class="sm-floor-legend-item">' +
          '<span class="sm-floor-legend-swatch" style="background:' +
          escapeHtml(pair[1]) +
          '"></span>' +
          escapeHtml(L(pair[0])) +
          "</span>"
        );
      })
      .join("");
  }

  function renderFloorMap(machines, layout) {
    const byNo = {};
    (machines || []).forEach(function (m) {
      byNo[String(m.machine_no || "").toUpperCase()] = m;
    });

    const colors = (layout && layout.colors) || {};
    const tiles = (layout && layout.machines) || [];
    const height = Number((layout && layout.height) || 10);
    const viewW = Number((layout && layout.width) || 10);
    const viewH = height;

    function toSvg(m) {
      const x = Number(m.x);
      const y = Number(m.y);
      const w = Number(m.w);
      const h = Number(m.h);
      return {
        x: x,
        y: height - y - h,
        w: w,
        h: h,
        cx: x + w / 2,
        cy: height - y - h / 2,
      };
    }

    const shapes = tiles
      .map(function (tile) {
        const machineNo = "CNC " + String(tile.label);
        const live = byNo[machineNo.toUpperCase()];
        const fill = colors[tile.color] || "#94a3b8";
        const geo = toSvg(tile);
        const rot = Number(tile.rotation) || 0;
        const svgRot = rot ? -rot : 0;
        const labelTransform = svgRot
          ? ' transform="rotate(' + svgRot + " " + geo.cx + " " + geo.cy + ')"'
          : "";
        const ho = live && live.handover;
        const statusKey = handoverStatusKey(ho);
        const clickable = !!(live && live.machine_id);
        const href = clickable ? SM.appPath + "/entry/" + live.machine_id : "";
        const titleBits = [
          machineNo,
          tile.subtitle || "",
          live ? (ho ? L(String(ho.status || "draft")) : L("No entry")) : L("Unavailable"),
          live && live.active_process_sheet ? "PS " + live.active_process_sheet : "",
        ]
          .filter(Boolean)
          .join(" | ");

        const body =
          '<rect x="' +
          geo.x +
          '" y="' +
          geo.y +
          '" width="' +
          geo.w +
          '" height="' +
          geo.h +
          '" rx="0.08" ry="0.08" fill="' +
          escapeHtml(fill) +
          '" stroke="#0b1220" stroke-width="0.12"></rect>' +
          '<text x="' +
          geo.cx +
          '" y="' +
          geo.cy +
          '" text-anchor="middle" dominant-baseline="central" font-size="' +
          (Math.min(geo.w, geo.h) > 1.2 ? "0.55" : "0.42") +
          '" font-weight="800" fill="#0b1220" font-family="Segoe UI, system-ui, sans-serif"' +
          labelTransform +
          ">" +
          escapeHtml(tile.label) +
          "</text>" +
          '<circle class="sm-floor-status sm-floor-status--' +
          statusKey +
          '" cx="' +
          (geo.x + geo.w - 0.18) +
          '" cy="' +
          (geo.y + 0.18) +
          '" r="0.12"></circle>';

        if (!clickable) {
          return (
            '<g class="sm-floor-tile is-disabled" opacity="0.45" aria-label="' +
            escapeHtml(titleBits) +
            '">' +
            body +
            "</g>"
          );
        }
        return (
          '<a class="sm-floor-tile" href="' +
          escapeHtml(href) +
          '" data-status="' +
          statusKey +
          '">' +
          "<title>" +
          escapeHtml(titleBits) +
          "</title>" +
          body +
          "</a>"
        );
      })
      .join("");

    return (
      '<svg class="sm-floor-svg" viewBox="0 0 ' +
      viewW +
      " " +
      viewH +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="' +
      escapeHtml(L("Factory floor plan")) +
      '">' +
      shapes +
      "</svg>"
    );
  }

  function renderMachineCards(machines) {
    const el = document.getElementById("sm-machine-cards");
    if (!el) return;
    if (!(machines || []).length) {
      el.innerHTML = "";
      return;
    }
    el.innerHTML = machines
      .map(function (m) {
        const ho = m.handover;
        const ps = m.active_process_sheet || (ho && ho.job_no) || "-";
        const tickets = Number(m.open_ticket_count || 0);
        return (
          '<a class="sm-machine-card" href="' +
          SM.appPath +
          "/entry/" +
          m.machine_id +
          '">' +
          '<div class="sm-machine-card-top">' +
          "<strong>" +
          escapeHtml(m.machine_no) +
          "</strong>" +
          badgeForHandover(ho) +
          "</div>" +
          '<div class="sm-muted">' +
          escapeHtml(t("ps_chip", { ps: ps })) +
          (m.queue_remaining_qty != null ? " · " + escapeHtml(L("Qty")) + " " + escapeHtml(m.queue_remaining_qty) : "") +
          "</div>" +
          (tickets
            ? '<span class="sm-badge urgent">' + escapeHtml(window.smN ? smN(tickets, "ticket_one", "ticket_many") : String(tickets)) + "</span>"
            : "") +
          "</a>"
        );
      })
      .join("");
  }

  async function initHome() {
    const dateEl = document.getElementById("sm-date");
    const grid = document.getElementById("sm-machine-grid");
    const banner = document.getElementById("sm-pending-banner");
    if (!dateEl || !grid) return;

    dateEl.value = rememberedDate();
    let shift = rememberedShift();

    function paintShiftChips() {
      document.querySelectorAll("#sm-shift-chips .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.dataset.shift === shift);
      });
    }

    async function load() {
      grid.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Loading...")) + "</p>";
      rememberContext(dateEl.value, shift);
      try {
        const q = new URLSearchParams({ date: dateEl.value, shift: shift });
        const data = await api("/api/shift-management/machines?" + q.toString());
        shift = normalizeShiftClient(data.shift_out || shift);
        paintShiftChips();
        rememberContext(dateEl.value, shift);
        const count = data.pending_ack_count || 0;
        if (banner) {
          if (count > 0) {
            banner.hidden = false;
            var pendingHtml = (data.pending_ack || [])
              .map(function (p) {
                return (
                  '<a class="sm-list-item" href="' +
                  SM.appPath +
                  "/ack/" +
                  p.handover_id +
                  '">' +
                  "<span><strong>" +
                  escapeHtml(p.machine_no) +
                  "</strong> | " +
                  escapeHtml(L(p.shift_out)) +
                  "</span>" +
                  '<span class="sm-badge pending">' +
                  escapeHtml(L(p.priority || "Pending")) +
                  "</span></a>"
                );
              })
              .join("");
            banner.innerHTML =
              escapeHtml(window.smN ? smN(count, "handover_wait_one", "handover_wait_many") : String(count)) +
              '<div class="sm-list" style="margin-top:10px">' +
              pendingHtml +
              "</div>";
          } else {
            banner.hidden = true;
            banner.innerHTML = "";
          }
        }
        const machines = data.machines || [];
        const layout = data.floor_layout;
        renderMachineCards(machines);
        if (!layout || !(layout.machines || []).length) {
          grid.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Floor layout unavailable.")) + "</p>";
          return;
        }
        if (!machines.length) {
          grid.innerHTML = '<p class="sm-muted">' + escapeHtml(L("No active machines found.")) + "</p>";
          return;
        }
        renderFloorLegend(layout.colors || {});
        grid.innerHTML = renderFloorMap(machines, layout);
      } catch (err) {
        grid.innerHTML = '<p class="sm-muted">' + escapeHtml(L(err.message)) + "</p>";
      }
    }

    document.querySelectorAll("#sm-shift-chips .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        shift = btn.dataset.shift;
        paintShiftChips();
        load();
      });
    });
    dateEl.addEventListener("change", load);
    paintShiftChips();
    load();
    SM.refresh = function () {
      load();
    };
  }

  function chipGroup(container, options, value, onPick) {
    container.innerHTML = "";
    options.forEach(function (opt) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sm-chip" + (opt === value ? " is-active" : "");
      btn.textContent = L(opt);
      btn.dataset.val = opt;
      btn.addEventListener("click", function () {
        container.querySelectorAll(".sm-chip").forEach(function (b) {
          b.classList.remove("is-active");
        });
        btn.classList.add("is-active");
        onPick(opt);
      });
      container.appendChild(btn);
    });
  }

  function fillSelect(sel, options, value) {
    if (!sel) return;
    sel.innerHTML = (options || [])
      .map(function (opt) {
        return (
          '<option value="' +
          escapeHtml(opt) +
          '"' +
          (opt === value ? " selected" : "") +
          ">" +
          escapeHtml(L(opt)) +
          "</option>"
        );
      })
      .join("");
  }

  async function initOps() {
    const list = document.getElementById("sm-ops-list");
    if (!list) return;
    const dateEl = document.getElementById("sm-ops-date");
    const searchEl = document.getElementById("sm-ops-search");
    let meta = null;
    let machines = [];
    let shift = rememberedShift();

    const dialog = document.getElementById("sm-ticket-dialog");
    const form = document.getElementById("sm-ticket-form");
    const FOCUS_MAX = 4;
    const FOCUS_KEY = "sm_ops_focus_machines";
    const GROUP_ORDER = ["MPP", "MILLING", "TURNING", "TURNMILL"];
    let selectedBlockId = null;
    let selectedIds = loadFocusIds();
    const machineField = document.querySelector(".sm-ops-machine-field");
    if (machineField) machineField.hidden = true;
    let pickerHost = document.getElementById("sm-ops-picker");
    if (!pickerHost) {
      pickerHost = document.createElement("div");
      pickerHost.id = "sm-ops-picker";
      pickerHost.className = "sm-ops-picker";
      list.parentNode.insertBefore(pickerHost, list);
    }
    list.classList.add("sm-ops-lanes");

    if (dateEl) dateEl.value = rememberedDate();

    function paintShiftChips() {
      document.querySelectorAll("#sm-ops-shift-chips .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.dataset.shift === shift);
      });
    }

    function loadFocusIds() {
      try {
        const raw = JSON.parse(localStorage.getItem(FOCUS_KEY) || "[]");
        if (!Array.isArray(raw)) return [];
        return raw.map(function (id) { return String(id); }).filter(Boolean);
      } catch (_) {
        return [];
      }
    }

    function saveFocusIds() {
      try {
        localStorage.setItem(FOCUS_KEY, JSON.stringify(selectedIds));
      } catch (_) {}
    }

    function machineById(id) {
      const want = String(id || "");
      for (let i = 0; i < machines.length; i++) {
        if (String(machines[i].machine_id) === want) return machines[i];
      }
      return null;
    }

    function isSelected(id) {
      return selectedIds.indexOf(String(id)) >= 0;
    }

    function searchQuery() {
      return ((searchEl && searchEl.value) || "").trim().toLowerCase();
    }

    function categoryOf(machine) {
      return String((machine && machine.machine_category) || "OTHER").trim().toUpperCase() || "OTHER";
    }

    function sortByMachineNo(rows) {
      return rows.slice().sort(function (a, b) {
        return String(a.machine_no || "").localeCompare(String(b.machine_no || ""), undefined, {
          numeric: true,
        });
      });
    }

    function groupMachines(rows) {
      const map = {};
      rows.forEach(function (machine) {
        const cat = categoryOf(machine);
        if (!map[cat]) map[cat] = [];
        map[cat].push(machine);
      });
      const cats = GROUP_ORDER.filter(function (cat) { return map[cat]; }).concat(
        Object.keys(map)
          .filter(function (cat) { return GROUP_ORDER.indexOf(cat) < 0; })
          .sort()
      );
      return cats.map(function (cat) {
        return { cat: cat, machines: sortByMachineNo(map[cat]) };
      });
    }

    function pruneSelection() {
      if (!machines.length) return;
      const known = {};
      machines.forEach(function (machine) {
        known[String(machine.machine_id)] = true;
      });
      const next = selectedIds.filter(function (id) { return known[id]; });
      if (next.length !== selectedIds.length) {
        selectedIds = next;
        saveFocusIds();
      }
    }

    function toggleMachine(id) {
      const key = String(id);
      const idx = selectedIds.indexOf(key);
      if (idx >= 0) {
        selectedIds.splice(idx, 1);
      } else if (selectedIds.length >= FOCUS_MAX) {
        toast("Maximum " + FOCUS_MAX + " machines");
        render();
        return;
      } else {
        selectedIds.push(key);
      }
      if (selectedBlockId) {
        const owner = machines.filter(function (machine) {
          return (machine.jobs || []).some(function (job) {
            return String(job.block_id) === String(selectedBlockId);
          });
        })[0];
        if (!owner || !isSelected(owner.machine_id)) selectedBlockId = null;
      }
      saveFocusIds();
      render();
    }

    function jobLabel(job) {
      return (
        "Q" +
        (job.queue_position != null ? job.queue_position : "?") +
        " · PS " +
        (job.process_sheet_no || job.job_no || "-")
      );
    }

    function fillDialogMachines(machineId) {
      const sel = document.getElementById("sm-tk-machine");
      if (!sel) return;
      sel.innerHTML = machines
        .map(function (m) {
          const idle = (m.jobs || []).length ? "" : t("no_queue_suffix");
          return (
            '<option value="' +
            escapeHtml(m.machine_id) +
            '"' +
            (String(m.machine_id) === String(machineId) ? " selected" : "") +
            ">" +
            escapeHtml(m.machine_no) +
            idle +
            "</option>"
          );
        })
        .join("");
    }

    function fillDialogJobs(machineId, blockId) {
      const sel = document.getElementById("sm-tk-job");
      const machine = machineById(machineId);
      const jobs = (machine && machine.jobs) || [];
      if (!sel) return;
      if (!jobs.length) {
        sel.innerHTML = '<option value="">' + escapeHtml(L("No queued job")) + "</option>";
        return;
      }
      sel.innerHTML = jobs
        .map(function (job) {
          return (
            '<option value="' +
            escapeHtml(job.block_id) +
            '" data-ps="' +
            escapeHtml(job.process_sheet_no || job.source_ps_id || "") +
            '" data-job="' +
            escapeHtml(job.job_no || job.process_sheet_no || "") +
            '"' +
            (String(job.block_id) === String(blockId) ? " selected" : "") +
            ">" +
            escapeHtml(jobLabel(job)) +
            "</option>"
          );
        })
        .join("");
    }

    function openTicketDialog(machine, job) {
      const machineId = machine && machine.machine_id;
      fillDialogMachines(machineId);
      fillDialogJobs(machineId, job && job.block_id);
      fillSelect(
        document.getElementById("sm-tk-category"),
        (meta && meta.ticket_categories) || ["Other"],
        "Other"
      );
      document.getElementById("sm-tk-title").value = "";
      document.getElementById("sm-tk-desc").value = "";
      document.getElementById("sm-tk-status").hidden = true;
      if (dialog && dialog.showModal) dialog.showModal();
    }

    function matchesSearch(machine, q) {
      if (!q) return true;
      const hay = [
        machine.machine_no,
        machine.machine_category,
        (machine.jobs || [])
          .map(function (j) {
            return [j.process_sheet_no, j.job_no, j.operation_name].join(" ");
          })
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.indexOf(q) >= 0;
    }

    function seqMeta(idx) {
      if (idx === 0) return { text: L("NOW"), cls: "is-now" };
      if (idx === 1) return { text: L("NEXT"), cls: "is-next" };
      return { text: L("THEN"), cls: "is-later" };
    }

    function renderPicker(q) {
      if (!pickerHost) return;
      if (!machines.length) {
        pickerHost.innerHTML = "";
        return;
      }
      pruneSelection();
      const atMax = selectedIds.length >= FOCUS_MAX;
      const visible = machines.filter(function (machine) {
        return isSelected(machine.machine_id) || matchesSearch(machine, q);
      });
      const countLabel = selectedIds.length + "/" + FOCUS_MAX;
      const groupsHtml = visible.length
        ? groupMachines(visible)
            .map(function (group) {
              const chips = group.machines
                .map(function (machine) {
                  const active = isSelected(machine.machine_id);
                  const disabled = !active && atMax;
                  const count = (machine.jobs || []).length;
                  return (
                    '<label class="sm-focus-check' +
                    (active ? " is-active" : "") +
                    (disabled ? " is-disabled" : "") +
                    '">' +
                    '<input type="checkbox" data-focus-machine="' +
                    escapeHtml(machine.machine_id) +
                    '"' +
                    (active ? " checked" : "") +
                    (disabled ? " disabled" : "") +
                    " />" +
                    "<span>" +
                    escapeHtml(machine.machine_no) +
                    (count ? "" : t("idle_suffix")) +
                    "</span></label>"
                  );
                })
                .join("");
              return (
                '<div class="sm-focus-group">' +
                '<span class="sm-focus-group-label">' +
                escapeHtml(L(group.cat)) +
                "</span>" +
                '<div class="sm-focus-checks">' +
                chips +
                "</div></div>"
              );
            })
            .join("")
        : '<p class="sm-muted sm-focus-picker-empty">' + escapeHtml(L("No machines match that search.")) + "</p>";
      pickerHost.innerHTML =
        '<div class="sm-focus-picker">' +
        '<div class="sm-focus-picker-meta">' +
        '<span class="sm-focus-picker-prompt">' +
        escapeHtml(t("machines_max", { n: FOCUS_MAX })) +
        "</span>" +
        '<span class="sm-focus-picker-count">' +
        escapeHtml(countLabel) +
        "</span></div>" +
        '<div class="sm-focus-groups" role="group" aria-label="' + escapeHtml(L("Machines")) + '">' +
        groupsHtml +
        "</div>" +
        (selectedIds.length
          ? '<button type="button" class="sm-focus-clear" data-focus-clear>' + escapeHtml(L("Clear")) + "</button>"
          : "") +
        "</div>";
    }

    function renderLane(machine) {
      const jobs = machine.jobs || [];
      const ho = machine.handover;
      const tickets = Number(machine.open_ticket_count || 0);
      const laneSelected = jobs.some(function (job) {
        return String(job.block_id) === String(selectedBlockId);
      });
      const extra = Math.max(0, jobs.length - 1);
      const hint = jobs.length
        ? extra
          ? t("now_plus", { n: extra })
          : L("Now")
        : L("Empty queue");
      const cards = jobs
        .map(function (job, idx) {
          const seq = seqMeta(idx);
          const jTickets = Number(job.open_ticket_count || 0);
          const selected = String(job.block_id) === String(selectedBlockId);
          const status = job.execution_status || job.block_status || "";
          return (
            '<button type="button" class="sm-focus-card ' +
            seq.cls +
            (selected ? " is-selected" : "") +
            '" data-block="' +
            escapeHtml(job.block_id) +
            '" data-machine="' +
            escapeHtml(machine.machine_id) +
            '">' +
            '<div class="sm-focus-card-top">' +
            '<span class="sm-focus-seq ' +
            seq.cls +
            '">' +
            seq.text +
            "</span>" +
            (jTickets
              ? '<span class="sm-focus-tickets">' +
                escapeHtml(window.smN ? smN(jTickets, "ticket_one", "ticket_many") : String(jTickets)) +
                "</span>"
              : "") +
            "</div>" +
            '<div class="sm-focus-ps">' +
            escapeHtml(job.process_sheet_no || job.job_no || "-") +
            "</div>" +
            '<div class="sm-focus-op">' +
            escapeHtml(job.operation_name || L("Operation")) +
            "</div>" +
            (job.source_op_no
              ? '<div class="sm-focus-opno">' + escapeHtml(t("op_prefix", { n: job.source_op_no })) + "</div>"
              : "") +
            '<div class="sm-focus-metrics">' +
            '<span class="sm-focus-metric"><span class="sm-focus-k">' + escapeHtml(L("Qty")) + "</span><strong>" +
            escapeHtml(job.remaining_qty != null ? job.remaining_qty : "-") +
            "</strong></span>" +
            '<span class="sm-focus-metric"><span class="sm-focus-k">' + escapeHtml(L("Plan")) + "</span><strong>" +
            escapeHtml(job.scheduled_qty != null ? job.scheduled_qty : "-") +
            "</strong></span>" +
            (status ? '<span class="sm-focus-status">' + escapeHtml(status) + "</span>" : "") +
            "</div></button>"
          );
        })
        .join("");
      const raiseBtn =
        can("can_create_ticket") && can("can_ops_actions")
          ? '<button type="button" class="sm-btn sm-btn-primary" data-raise-machine="' +
            escapeHtml(machine.machine_id) +
            '"' +
            (laneSelected ? "" : " disabled") +
            ">" + escapeHtml(L("Raise ticket")) + "</button>"
          : "";
      return (
        '<section class="sm-focus-lane' +
        (jobs.length ? "" : " is-idle") +
        '" data-machine="' +
        escapeHtml(machine.machine_id) +
        '">' +
        '<header class="sm-focus-lane-head">' +
        '<div class="sm-focus-lane-title">' +
        "<strong>" +
        escapeHtml(machine.machine_no) +
        "</strong>" +
        badgeForHandover(ho) +
        (tickets
          ? '<span class="sm-badge urgent">' +
            escapeHtml(window.smN ? smN(tickets, "ticket_one", "ticket_many") : String(tickets)) +
            "</span>"
          : "") +
        '<span class="sm-focus-hint">' +
        escapeHtml(hint) +
        "</span></div>" +
        (raiseBtn ? '<div class="sm-focus-lane-actions">' + raiseBtn + "</div>" : "") +
        "</header>" +
        '<div class="sm-focus-lane-body">' +
        (jobs.length
          ? cards +
            (machine.queue_count > jobs.length
              ? '<p class="sm-muted sm-ops-more">' +
                escapeHtml(t("more_on_queue", { n: machine.queue_count - jobs.length })) +
                "</p>"
              : "")
          : '<p class="sm-muted">' + escapeHtml(L("No jobs in this queue.")) + "</p>") +
        "</div></section>"
      );
    }

    function render() {
      const q = searchQuery();
      renderPicker(q);
      if (!machines.length) {
        list.innerHTML =
          '<div class="sm-ops-empty"><p class="sm-muted">' +
          escapeHtml(L("No machines assigned. Ask a planner to map machines to your login.")) +
          "</p></div>";
        return;
      }
      const lanes = [];
      groupMachines(
        machines.filter(function (machine) {
          return isSelected(machine.machine_id);
        })
      ).forEach(function (group) {
        group.machines.forEach(function (machine) {
          lanes.push(machine);
        });
      });
      if (selectedBlockId) {
        const stillThere = lanes.some(function (machine) {
          return (machine.jobs || []).some(function (job) {
            return String(job.block_id) === String(selectedBlockId);
          });
        });
        if (!stillThere) selectedBlockId = null;
      }
      if (!lanes.length) {
        list.innerHTML =
          '<div class="sm-focus-landing"><p class="sm-muted">' +
          escapeHtml(L("Select machines above to show lanes.")) +
          "</p></div>";
        return;
      }
      list.innerHTML = lanes.map(renderLane).join("");
    }

    function openRaiseForMachine(machineId) {
      const current = machineById(machineId);
      const job = ((current && current.jobs) || []).filter(function (item) {
        return String(item.block_id) === String(selectedBlockId);
      })[0];
      if (!current) {
        toast(L("Choose a machine first"));
        return;
      }
      if (!job) {
        toast(L("Select a queued job"));
        return;
      }
      openTicketDialog(current, job);
    }

    async function load() {
      list.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Loading…")) + "</p>";
      if (dateEl) rememberContext(dateEl.value, shift);
      try {
        const q = new URLSearchParams({
          date: (dateEl && dateEl.value) || rememberedDate(),
          shift: shift,
        });
        const data = await api("/api/shift-management/ops-queue?" + q.toString());
        meta = data.meta || meta;
        shift = normalizeShiftClient(data.shift_out || shift);
        paintShiftChips();
        machines = data.machines || [];
        render();
      } catch (err) {
        list.innerHTML =
          '<div class="sm-ops-empty"><p class="sm-muted">' +
          escapeHtml(err.message) +
          '</p><button type="button" class="sm-btn sm-btn-ghost" id="sm-ops-retry">' +
          escapeHtml(L("Retry")) +
          "</button></div>";
        const retry = document.getElementById("sm-ops-retry");
        if (retry) retry.addEventListener("click", load);
      }
    }

    const queuePanel = document.getElementById("sm-ops-queue-panel");
    const reportPanel = document.getElementById("sm-ops-report-panel");
    const reportBody = document.getElementById("sm-prod-body");
    let reportBoundKey = "";
    let reportSaveTimer = null;
    let reportSaveChain = Promise.resolve();
    let reportDirty = false;
    let cncMachines = [];
    const REPORT_MAX = 24;
    const lookupTimers = {};
    let suggestTimer = null;
    let suggestToken = 0;
    let suggestHits = [];
    let suggestIndex = 0;
    let suggestInput = null;

    function reportContextKey() {
      return ((dateEl && dateEl.value) || rememberedDate()) + "|" + shift;
    }

    function setReportSave(text) {
      const el = document.getElementById("sm-prod-save");
      if (!el) return;
      el.setAttribute("data-sm-msg", text == null ? "" : String(text));
      el.textContent = text ? L(text) : "";
    }

    function qtyText(value) {
      if (value == null || value === "") return "";
      return String(value);
    }

    function parseQty(value) {
      const text = String(value == null ? "" : value).trim();
      if (!text) return null;
      const number = Number(text);
      if (!isFinite(number) || number < 0) return null;
      return number;
    }

    function collectLines() {
      if (!reportBody) return [];
      return Array.prototype.map.call(reportBody.querySelectorAll("tr[data-no]"), function (tr, index) {
        function val(field) {
          const el = tr.querySelector('[data-field="' + field + '"]');
          return el ? el.value : "";
        }
        return {
          no: index + 1,
          process_sheet_no: val("process_sheet_no").trim().toUpperCase(),
          description: val("description").trim(),
          target_qty: parseQty(val("target_qty")),
          produced_qty: parseQty(val("produced_qty")),
          rejected_qty: parseQty(val("rejected_qty")),
          cnc: val("cnc"),
          scanned_erp: val("scanned_erp"),
        };
      });
    }

    function sumQty(field) {
      let total = 0;
      let any = false;
      collectLines().forEach(function (line) {
        if (line[field] == null) return;
        any = true;
        total += Number(line[field]);
      });
      if (!any) return "";
      const rounded = Math.round(total * 1000) / 1000;
      return String(rounded);
    }

    function updateTotals() {
      const target = document.getElementById("sm-prod-total-target");
      const produced = document.getElementById("sm-prod-total-produced");
      const rejected = document.getElementById("sm-prod-total-rejected");
      if (target) target.textContent = sumQty("target_qty");
      if (produced) produced.textContent = sumQty("produced_qty");
      if (rejected) rejected.textContent = sumQty("rejected_qty");
    }

    function machineOptions(selected) {
      const names = cncMachines.slice();
      if (selected && names.indexOf(selected) < 0) names.unshift(selected);
      let html = '<option value=""></option>';
      names.forEach(function (name) {
        html +=
          '<option value="' +
          escapeHtml(name) +
          '"' +
          (name === selected ? " selected" : "") +
          ">" +
          escapeHtml(name) +
          "</option>";
      });
      return html;
    }

    function renderReport(lines) {
      if (!reportBody) return;
      hideSuggest();
      const editable = can("can_report");
      const disabled = editable ? "" : " disabled";
      reportBody.innerHTML = (lines || [])
        .map(function (line, index) {
          const no = index + 1;
          const scanned = line.scanned_erp === "Y" || line.scanned_erp === "N" ? line.scanned_erp : "";
          return (
            '<tr data-no="' +
            no +
            '" data-looked="' +
            escapeHtml(line.process_sheet_no || "") +
            '">' +
            '<td class="sm-prod-no">' +
            no +
            "</td>" +
            '<td><input type="text" data-field="process_sheet_no" maxlength="80" autocomplete="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="sm-ps-suggest" aria-label="Process sheet ' +
            no +
            '" value="' +
            escapeHtml(line.process_sheet_no || "") +
            '"' +
            disabled +
            " /></td>" +
            '<td><input type="text" class="sm-prod-desc" data-field="description" maxlength="200" autocomplete="off" aria-label="Description ' +
            no +
            '" value="' +
            escapeHtml(line.description || "") +
            '"' +
            disabled +
            " /></td>" +
            '<td><input type="text" inputmode="decimal" data-field="target_qty" aria-label="Target quantity ' +
            no +
            '" value="' +
            escapeHtml(qtyText(line.target_qty)) +
            '"' +
            disabled +
            " /></td>" +
            '<td><input type="text" inputmode="decimal" data-field="produced_qty" aria-label="Produced quantity ' +
            no +
            '" value="' +
            escapeHtml(qtyText(line.produced_qty)) +
            '"' +
            disabled +
            " /></td>" +
            '<td><input type="text" inputmode="decimal" data-field="rejected_qty" aria-label="Rejected quantity ' +
            no +
            '" value="' +
            escapeHtml(qtyText(line.rejected_qty)) +
            '"' +
            disabled +
            " /></td>" +
            '<td><select data-field="cnc" aria-label="CNC ' +
            no +
            '"' +
            disabled +
            ">" +
            machineOptions(line.cnc || "") +
            "</select></td>" +
            '<td><select data-field="scanned_erp" aria-label="Scanned ERP ' +
            no +
            '"' +
            disabled +
            ">" +
            '<option value=""' +
            (scanned === "" ? " selected" : "") +
            "></option>" +
            '<option value="Y"' +
            (scanned === "Y" ? " selected" : "") +
            ">Y</option>" +
            '<option value="N"' +
            (scanned === "N" ? " selected" : "") +
            ">N</option>" +
            "</select></td>" +
            "</tr>"
          );
        })
        .join("");
      updateTotals();
      const addBtn = document.getElementById("sm-prod-add");
      if (addBtn) addBtn.hidden = !editable || reportBody.querySelectorAll("tr[data-no]").length >= REPORT_MAX;
    }

    function scheduleReportSave() {
      if (!can("can_report")) return;
      reportDirty = true;
      setReportSave("Saving…");
      clearTimeout(reportSaveTimer);
      reportSaveTimer = setTimeout(function () {
        flushReportSave();
      }, 500);
    }

    function flushReportSave() {
      clearTimeout(reportSaveTimer);
      if (!reportDirty || !can("can_report") || !reportBoundKey) return reportSaveChain;
      reportDirty = false;
      const key = reportBoundKey;
      const parts = key.split("|");
      const payload = {
        work_date: parts[0],
        shift_out: parts[1],
        lines: collectLines(),
      };
      const job = reportSaveChain.then(function () {
        return api("/api/shift-management/production-report", {
          method: "PUT",
          body: JSON.stringify(payload),
        })
          .then(function () {
            if (reportBoundKey === key && !reportDirty) setReportSave("Saved");
          })
          .catch(function (err) {
            reportDirty = true;
            setReportSave("Not saved");
            toast(err.message);
          });
      });
      reportSaveChain = job.catch(function () {});
      return job;
    }

    function suggestMenu() {
      let menu = document.getElementById("sm-ps-suggest");
      if (menu) return menu;
      menu = document.createElement("div");
      menu.id = "sm-ps-suggest";
      menu.className = "sm-ps-suggest";
      menu.hidden = true;
      menu.setAttribute("role", "listbox");
      document.body.appendChild(menu);
      menu.addEventListener("mousedown", function (event) {
        const btn = event.target.closest("[data-suggest-index]");
        if (!btn) return;
        event.preventDefault();
        const hit = suggestHits[Number(btn.getAttribute("data-suggest-index"))];
        if (hit) applySuggestion(hit);
      });
      return menu;
    }

    function hideSuggest() {
      const menu = document.getElementById("sm-ps-suggest");
      if (menu) {
        menu.hidden = true;
        menu.innerHTML = "";
      }
      if (suggestInput) suggestInput.setAttribute("aria-expanded", "false");
      suggestHits = [];
      suggestInput = null;
    }

    function placeSuggest() {
      const menu = document.getElementById("sm-ps-suggest");
      if (!menu || menu.hidden || !suggestInput) return;
      const rect = suggestInput.getBoundingClientRect();
      const width = Math.max(rect.width, 320);
      let left = rect.left;
      if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - 8 - width);
      let top = rect.bottom + 2;
      menu.style.left = left + "px";
      menu.style.width = width + "px";
      menu.style.top = top + "px";
      const menuRect = menu.getBoundingClientRect();
      if (menuRect.bottom > window.innerHeight - 8 && rect.top > menuRect.height + 8) {
        menu.style.top = Math.max(8, rect.top - menuRect.height - 2) + "px";
      }
    }

    function showSuggest(input, hits) {
      const menu = suggestMenu();
      if (suggestInput && suggestInput !== input) suggestInput.setAttribute("aria-expanded", "false");
      suggestInput = input;
      suggestHits = hits || [];
      suggestIndex = suggestHits.length ? 0 : -1;
      input.setAttribute("aria-expanded", suggestHits.length ? "true" : "false");
      if (!suggestHits.length) {
        menu.hidden = true;
        menu.innerHTML = "";
        return;
      }
      menu.innerHTML = suggestHits
        .map(function (hit, index) {
          const qty = hit.target_qty == null || hit.target_qty === "" ? "" : String(hit.target_qty);
          const desc = hit.description || L("No description");
          return (
            '<button type="button" role="option" id="sm-ps-suggest-' +
            index +
            '" data-suggest-index="' +
            index +
            '"' +
            (index === 0 ? ' class="is-active" aria-selected="true"' : ' aria-selected="false"') +
            ">" +
            '<span class="sm-ps-suggest-code">' +
            escapeHtml(hit.process_sheet_no || "") +
            "</span>" +
            '<span class="sm-ps-suggest-desc">' +
            escapeHtml(desc) +
            (qty ? escapeHtml(t("qty_suggest", { n: qty })) : "") +
            "</span></button>"
          );
        })
        .join("");
      menu.hidden = false;
      input.setAttribute("aria-activedescendant", "sm-ps-suggest-0");
      placeSuggest();
    }

    function moveSuggest(delta) {
      if (!suggestHits.length) return;
      suggestIndex = (suggestIndex + delta + suggestHits.length) % suggestHits.length;
      const menu = document.getElementById("sm-ps-suggest");
      if (!menu) return;
      const buttons = menu.querySelectorAll("button");
      Array.prototype.forEach.call(buttons, function (btn, index) {
        const on = index === suggestIndex;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
        if (on && suggestInput) suggestInput.setAttribute("aria-activedescendant", btn.id);
        if (on) btn.scrollIntoView({ block: "nearest" });
      });
    }

    function applySuggestion(hit) {
      const input = suggestInput;
      if (!input || !hit) return;
      const tr = input.closest("tr");
      const desc = tr && tr.querySelector('[data-field="description"]');
      const target = tr && tr.querySelector('[data-field="target_qty"]');
      const ps = String(hit.process_sheet_no || "").trim().toUpperCase();
      input.value = ps;
      if (desc) {
        desc.value = hit.description || "";
        desc.placeholder = "";
      }
      if (target) target.value = hit.target_qty == null || hit.target_qty === "" ? "" : String(hit.target_qty);
      if (tr) {
        tr.setAttribute("data-looked", ps);
        clearTimeout(lookupTimers[tr.getAttribute("data-no")]);
      }
      hideSuggest();
      updateTotals();
      scheduleReportSave();
      const produced = tr && tr.querySelector('[data-field="produced_qty"]');
      if (produced) produced.focus();
    }

    async function fetchSuggest(input) {
      const q = input.value.trim();
      if (q.length < 2 || input.disabled) {
        if (suggestInput === input) hideSuggest();
        return;
      }
      const token = ++suggestToken;
      try {
        const data = await api(
          "/api/shift-management/process-sheet-suggest?q=" + encodeURIComponent(q)
        );
        if (token !== suggestToken || document.activeElement !== input) return;
        if (input.value.trim().toUpperCase() !== q.toUpperCase()) return;
        showSuggest(input, data.suggestions || []);
      } catch (_) {
        if (token === suggestToken && suggestInput === input) hideSuggest();
      }
    }

    async function lookupRow(tr, settle) {
      const input = tr.querySelector('[data-field="process_sheet_no"]');
      const desc = tr.querySelector('[data-field="description"]');
      const target = tr.querySelector('[data-field="target_qty"]');
      if (!input) return;
      if (settle == null) settle = true;
      const ps = input.value.trim().toUpperCase();
      if (input.value !== ps) {
        const pos = input.selectionStart;
        input.value = ps;
        if (document.activeElement === input && pos != null) input.setSelectionRange(pos, pos);
      }
      if (tr.getAttribute("data-looked") === ps) return;
      if (!ps) {
        if (desc) desc.value = "";
        if (target) target.value = "";
        tr.setAttribute("data-looked", "");
        updateTotals();
        return;
      }
      tr.classList.add("is-looking");
      try {
        const data = await api(
          "/api/shift-management/process-sheet-lookup?ps=" + encodeURIComponent(ps)
        );
        if (input.value.trim().toUpperCase() !== ps) return;
        tr.setAttribute("data-looked", ps);
        if (data.found) {
          if (desc) {
            desc.value = data.description || "";
            desc.placeholder = "";
          }
          if (target && data.target_qty != null) target.value = String(data.target_qty);
          if (data.process_sheet_no && data.process_sheet_no !== ps) {
            input.value = data.process_sheet_no;
            tr.setAttribute("data-looked", data.process_sheet_no);
          }
          updateTotals();
          scheduleReportSave();
        } else if (settle) {
          if (desc) {
            desc.value = "";
            desc.placeholder = L("Not in ERP — type description");
          }
          if (target) target.value = "";
          updateTotals();
          scheduleReportSave();
        }
      } catch (err) {
        toast(err.message);
      } finally {
        tr.classList.remove("is-looking");
      }
    }

    async function loadReport() {
      if (!reportPanel) return;
      const key = reportContextKey();
      setReportSave("Loading…");
      try {
        const q = new URLSearchParams({
          date: (dateEl && dateEl.value) || rememberedDate(),
          shift: shift,
        });
        const data = await api("/api/shift-management/production-report?" + q.toString());
        if (reportContextKey() !== key) return;
        cncMachines = data.cnc_machines || [];
        reportBoundKey = key;
        reportDirty = false;
        renderReport(data.lines || []);
        setReportSave(data.saved ? "Saved" : "");
      } catch (err) {
        setReportSave("");
        if (reportBody) {
          reportBody.innerHTML =
            '<tr><td colspan="8" class="sm-prod-error">' + escapeHtml(err.message) + "</td></tr>";
        }
      }
    }

    function showOpsTab(name) {
      const reporting = name === "reporting";
      const title = document.querySelector(".sm-ops-head .sm-section-title");
      if (title) {
        const label = reporting ? "Shift reporting" : "Active queue";
        title.setAttribute("data-sm-t-src", label);
        title.textContent = L(label);
      }
      document.querySelectorAll("[data-ops-tab]").forEach(function (btn) {
        const on = btn.getAttribute("data-ops-tab") === name;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
      });
      if (queuePanel) queuePanel.hidden = reporting;
      if (reportPanel) reportPanel.hidden = !reporting;
      const main = document.querySelector(".sm-main");
      if (main) main.classList.toggle("sm-main--sheet", reporting);
      document.body.classList.toggle("sm-report-open", reporting);
      const pdfBtn = document.getElementById("sm-ops-report");
      if (pdfBtn) pdfBtn.hidden = reporting;
      const url = new URL(window.location.href);
      if (reporting) url.searchParams.set("tab", "reporting");
      else url.searchParams.delete("tab");
      history.replaceState(null, "", url);
      if (reporting && reportBoundKey !== reportContextKey()) loadReport();
    }

    if (reportBody) {
      reportBody.addEventListener("input", function (event) {
        const field = event.target.getAttribute("data-field");
        updateTotals();
        if (field === "process_sheet_no") {
          const tr = event.target.closest("tr");
          const no = tr && tr.getAttribute("data-no");
          clearTimeout(lookupTimers[no]);
          lookupTimers[no] = setTimeout(function () {
            if (tr) lookupRow(tr, false);
          }, 400);
          clearTimeout(suggestTimer);
          const typed = event.target;
          suggestTimer = setTimeout(function () {
            fetchSuggest(typed);
          }, 160);
        }
        scheduleReportSave();
      });
      reportBody.addEventListener("keydown", function (event) {
        if (event.target.getAttribute("data-field") !== "process_sheet_no") return;
        const menu = document.getElementById("sm-ps-suggest");
        const open = menu && !menu.hidden && suggestHits.length && suggestInput === event.target;
        if (!open) return;
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveSuggest(1);
        } else if (event.key === "ArrowUp") {
          event.preventDefault();
          moveSuggest(-1);
        } else if (event.key === "Enter") {
          event.preventDefault();
          const hit = suggestHits[suggestIndex] || suggestHits[0];
          if (hit) applySuggestion(hit);
        } else if (event.key === "Escape") {
          event.preventDefault();
          hideSuggest();
        }
      });
      reportBody.addEventListener("focusout", function (event) {
        if (event.target.getAttribute("data-field") !== "process_sheet_no") return;
        const typed = event.target;
        setTimeout(function () {
          if (suggestInput === typed && document.activeElement !== typed) hideSuggest();
        }, 150);
      });
      window.addEventListener("resize", placeSuggest);
      window.addEventListener("scroll", placeSuggest, true);
      reportBody.addEventListener("change", function (event) {
        const field = event.target.getAttribute("data-field");
        if (field === "process_sheet_no") {
          const tr = event.target.closest("tr");
          if (tr) lookupRow(tr, true);
        }
        updateTotals();
        scheduleReportSave();
      });
    }
    const addLine = document.getElementById("sm-prod-add");
    if (addLine) {
      addLine.addEventListener("click", function () {
        const lines = collectLines();
        if (lines.length >= REPORT_MAX) return;
        lines.push({
          process_sheet_no: "",
          description: "",
          target_qty: null,
          produced_qty: null,
          rejected_qty: null,
          cnc: "",
          scanned_erp: "",
        });
        renderReport(lines);
        const rows = reportBody.querySelectorAll("tr[data-no]");
        const last = rows[rows.length - 1];
        const input = last && last.querySelector('[data-field="process_sheet_no"]');
        if (input) input.focus();
      });
    }
    const printBtn = document.getElementById("sm-prod-print");
    if (printBtn) {
      printBtn.addEventListener("click", function () {
        window.print();
      });
    }
    document.querySelectorAll("[data-ops-tab]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showOpsTab(btn.getAttribute("data-ops-tab"));
      });
    });

    document.getElementById("sm-ops-refresh").addEventListener("click", function () {
      if (reportPanel && !reportPanel.hidden) {
        flushReportSave().then(function () {
          reportBoundKey = "";
          loadReport();
        });
        return;
      }
      load();
    });
    document.querySelectorAll("#sm-ops-shift-chips .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        flushReportSave().then(function () {
          shift = btn.dataset.shift;
          paintShiftChips();
          reportBoundKey = "";
          load();
          if (reportPanel && !reportPanel.hidden) loadReport();
        });
      });
    });
    if (dateEl) {
      dateEl.addEventListener("change", function () {
        flushReportSave().then(function () {
          reportBoundKey = "";
          load();
          if (reportPanel && !reportPanel.hidden) loadReport();
        });
      });
    }
    if (searchEl) searchEl.addEventListener("input", render);
    pickerHost.addEventListener("change", function (event) {
      const input = event.target.closest("[data-focus-machine]");
      if (!input) return;
      toggleMachine(input.getAttribute("data-focus-machine"));
    });
    pickerHost.addEventListener("click", function (event) {
      if (!event.target.closest("[data-focus-clear]")) return;
      selectedIds = [];
      selectedBlockId = null;
      saveFocusIds();
      render();
    });
    list.addEventListener("click", function (event) {
      const card = event.target.closest(".sm-focus-card");
      if (card) {
        selectedBlockId = card.getAttribute("data-block");
        render();
        return;
      }
      const raise = event.target.closest("[data-raise-machine]");
      if (!raise || raise.disabled) return;
      openRaiseForMachine(raise.getAttribute("data-raise-machine"));
    });
    const tkMachine = document.getElementById("sm-tk-machine");
    if (tkMachine) {
      tkMachine.addEventListener("change", function () {
        fillDialogJobs(tkMachine.value, "");
      });
    }
    const reportBtn = document.getElementById("sm-ops-report");
    if (reportBtn) {
      reportBtn.addEventListener("click", function () {
        downloadReportPdf((dateEl && dateEl.value) || rememberedDate(), shift);
      });
    }
    document.getElementById("sm-tk-cancel").addEventListener("click", function () {
      if (dialog) dialog.close();
    });
    if (form) form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const status = document.getElementById("sm-tk-status");
      const jobSel = document.getElementById("sm-tk-job");
      const opt = jobSel && jobSel.selectedOptions ? jobSel.selectedOptions[0] : null;
      const machineId = tkMachine ? tkMachine.value : "";
      if (!machineId || !jobSel || !jobSel.value) {
        status.hidden = false;
        status.textContent = L("Choose a machine, then a queued job.");
        return;
      }
      try {
        status.hidden = false;
        status.textContent = L("Creating…");
        await api("/api/shift-management/tickets", {
          method: "POST",
          body: JSON.stringify({
            machine_id: Number(machineId),
            block_id: jobSel.value,
            planner_ps_id: (opt && opt.dataset.ps) || "",
            job_no: (opt && opt.dataset.job) || "",
            category: document.getElementById("sm-tk-category").value,
            priority: document.getElementById("sm-tk-priority").value,
            title: document.getElementById("sm-tk-title").value,
            description: document.getElementById("sm-tk-desc").value,
            work_date: (dateEl && dateEl.value) || rememberedDate(),
            shift_out: shift,
          }),
        });
        toast(L("Ticket created"));
        if (dialog) dialog.close();
        load();
      } catch (err) {
        status.hidden = false;
        status.textContent = err.message;
      }
    });

    paintShiftChips();
    load();
    if (new URLSearchParams(window.location.search).get("tab") === "reporting") {
      showOpsTab("reporting");
    }
    SM.refresh = function () {
      const reporting = reportPanel && !reportPanel.hidden;
      showOpsTab(reporting ? "reporting" : "queue");
      render();
      if (reporting) renderReport(collectLines());
    };
  }

  async function initEntry() {
    const root = document.getElementById("sm-entry-root");
    if (!root) return;
    const machineId = Number(SM.machineId || root.dataset.machineId);
    const saveEl = document.getElementById("sm-save-status");
    let handover = null;
    let step = 1;
    let saveTimer = null;
    let meta = null;

    const params = new URLSearchParams(window.location.search);
    const prefPs = params.get("ps") || "";
    const workDate = params.get("date") || rememberedDate();
    const shiftOut = normalizeShiftClient(params.get("shift") || rememberedShift());
    rememberContext(workDate, shiftOut);

    function setSave(text) {
      if (!saveEl) return;
      saveEl.setAttribute("data-sm-msg", text == null ? "" : String(text));
      saveEl.textContent = L(text);
    }

    function schedulePatch(patch) {
      Object.assign(handover, patch);
      setSave("Saving...");
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async function () {
        try {
          const data = await api("/api/shift-management/handovers/" + handover.handover_id, {
            method: "PATCH",
            body: JSON.stringify(patch),
          });
          handover = data.handover;
          setSave("Saved");
          renderReview();
          renderTickets();
          renderComments();
        } catch (err) {
          setSave("Save failed");
          toast(err.message);
        }
      }, 280);
    }

    function showStep(n) {
      step = n;
      document.querySelectorAll(".sm-step").forEach(function (b) {
        b.classList.toggle("is-active", Number(b.dataset.step) === n);
      });
      document.querySelectorAll(".sm-panel").forEach(function (p) {
        const on = Number(p.dataset.panel) === n;
        p.hidden = !on;
        p.classList.toggle("is-active", on);
      });
      const prev = document.getElementById("sm-prev-btn");
      const next = document.getElementById("sm-next-btn");
      if (prev) prev.hidden = n === 1;
      if (next) {
        next.hidden = n === 3;
        const nextLabel = n === 2 ? "Review" : "Next";
        next.setAttribute("data-sm-t-src", nextLabel);
        next.textContent = L(nextLabel);
      }
      if (n === 3) {
        renderReview();
        renderComments();
      }
    }

    function wireIssue(block) {
      const flag = block.dataset.flag;
      const textKey = block.dataset.text;
      const ta = block.querySelector("textarea");
      const nilBtn = block.querySelector(".is-nil");
      const issueBtn = block.querySelector(".is-issue");

      function apply(flagVal) {
        nilBtn.classList.toggle("is-active", !flagVal);
        issueBtn.classList.toggle("is-active", !!flagVal);
        ta.hidden = !flagVal;
        const patch = {};
        patch[flag] = !!flagVal;
        if (!flagVal) patch[textKey] = "";
        schedulePatch(patch);
      }

      nilBtn.addEventListener("click", function () {
        apply(false);
      });
      issueBtn.addEventListener("click", function () {
        apply(true);
      });
      ta.addEventListener("change", function () {
        const patch = {};
        patch[textKey] = ta.value;
        schedulePatch(patch);
      });
      ta.addEventListener("blur", function () {
        const patch = {};
        patch[textKey] = ta.value;
        schedulePatch(patch);
      });

      block._sync = function () {
        const on = !!handover[flag];
        nilBtn.classList.toggle("is-active", !on);
        issueBtn.classList.toggle("is-active", on);
        ta.hidden = !on;
        ta.value = handover[textKey] || "";
      };
    }

    function renderQueueJobs() {
      const sel = document.getElementById("sm-queue-job");
      if (!sel) return;
      const jobs = handover.queue_jobs || [];
      sel.innerHTML =
        '<option value="">' + escapeHtml(L("Manual / other")) + "</option>" +
        jobs
          .map(function (j) {
            const label = t("job_option", {
              ps: j.process_sheet_no || j.job_no || L("Job"),
              q: j.queue_position,
              rem: j.remaining_qty != null ? j.remaining_qty : "-",
            });
            const val = j.process_sheet_no || j.job_no || "";
            const selected = handover.job_no && handover.job_no === val;
            return (
              '<option value="' +
              escapeHtml(val) +
              '" data-rem="' +
              escapeHtml(j.remaining_qty != null ? j.remaining_qty : "") +
              '"' +
              (selected ? " selected" : "") +
              ">" +
              escapeHtml(label) +
              "</option>"
            );
          })
          .join("");
    }

    function renderTickets() {
      const el = document.getElementById("sm-entry-tickets");
      if (!el) return;
      const tickets = handover.tickets || [];
      if (!tickets.length) {
        el.innerHTML = '<p class="sm-muted">' + escapeHtml(L("No open tickets for this machine.")) + "</p>";
        return;
      }
      el.innerHTML = '<div class="sm-list">' + tickets.map(ticketCardHtml).join("") + "</div>";
      bindTicketStatus(el, async function () {
        const data = await api("/api/shift-management/handovers/" + handover.handover_id);
        handover = data.handover;
        renderTickets();
      });
    }

    function renderComments() {
      const el = document.getElementById("sm-entry-comments");
      if (!el) return;
      const comments = handover.comments || [];
      el.innerHTML = comments.length
        ? comments
            .map(function (c) {
              return (
                '<div class="sm-comment">' +
                '<div class="sm-muted">' +
                escapeHtml(c.display_name || c.username || L("User")) +
                " · " +
                escapeHtml(c.created_at || "") +
                "</div>" +
                "<div>" +
                escapeHtml(c.body) +
                "</div></div>"
              );
            })
            .join("")
        : '<p class="sm-muted">' + escapeHtml(L("No comments yet.")) + "</p>";
    }

    function renderReview() {
      const el = document.getElementById("sm-review");
      if (!el || !handover) return;
      const issues = [];
      if (handover.quality_issue_flag) issues.push(t("quality_line", { text: handover.quality_issue_text || "" }));
      if (handover.alarm_flag) issues.push(t("alarm_line", { text: handover.alarm_text || "" }));
      if (handover.maintenance_flag) issues.push(t("maint_line", { text: handover.maintenance_text || "" }));
      el.innerHTML =
        "<div><strong>" +
        escapeHtml(handover.machine_no || "") +
        "</strong> | " +
        escapeHtml(handover.work_date) +
        " | " +
        escapeHtml(L(handover.shift_out)) +
        " → " +
        escapeHtml(handover.shift_in || "") +
        "</div>" +
        "<div>" +
        escapeHtml(t("status_job", { status: L(handover.machine_status), job: handover.job_no || "-" })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("qty_left", { qty: handover.remaining_qty, tool: handover.tool_life_pct })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("material_line", {
          qty: handover.material_qty == null ? "-" : handover.material_qty,
          unit: L(handover.material_unit || ""),
        })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("first_ncr", { first: L(handover.first_piece_status), ncr: L(handover.ncr_status) })) +
        (handover.ncr_ref ? " (" + escapeHtml(handover.ncr_ref) + ")" : "") +
        "</div>" +
        "<div>" +
        escapeHtml(t("priority_line", { priority: L(handover.priority) })) +
        (handover.priority_note ? " - " + escapeHtml(handover.priority_note) : "") +
        "</div>" +
        "<div>" +
        (issues.length ? issues.map(escapeHtml).join("<br>") : escapeHtml(L("Issues: Nil"))) +
        "</div>" +
        "<div>" +
        escapeHtml(t("remarks_line", { text: handover.remarks || "-" })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("open_tickets_n", { n: (handover.tickets || []).length || 0 })) +
        "</div>";
    }

    function syncForm() {
      document.getElementById("sm-entry-machine").textContent =
        handover.status !== "draft"
          ? t("machine_line_status", {
              machine: handover.machine_no || L("Machine"),
              shift: L(handover.shift_out || ""),
              status: L(handover.status),
            })
          : t("machine_line", {
              machine: handover.machine_no || L("Machine"),
              shift: L(handover.shift_out || ""),
            });
      document.getElementById("sm-job-no").value = handover.job_no || "";
      document.getElementById("sm-remaining-qty").value =
        handover.remaining_qty != null ? handover.remaining_qty : 0;
      document.getElementById("sm-tool-life").value =
        handover.tool_life_pct != null ? handover.tool_life_pct : 100;
      document.getElementById("sm-material-qty").value =
        handover.material_qty == null ? "" : handover.material_qty;
      document.getElementById("sm-remarks").value = handover.remarks || "";
      document.getElementById("sm-ncr-ref").value = handover.ncr_ref || "";
      document.getElementById("sm-ncr-ref").hidden = handover.ncr_status !== "Open";
      document.getElementById("sm-priority-note").value = handover.priority_note || "";
      document.getElementById("sm-priority-note").hidden =
        ["High", "Urgent"].indexOf(handover.priority) < 0;

      renderQueueJobs();
      chipGroup(document.getElementById("sm-machine-status"), meta.machine_statuses, handover.machine_status, function (v) {
        schedulePatch({ machine_status: v });
      });
      chipGroup(document.getElementById("sm-first-piece"), meta.first_piece_statuses, handover.first_piece_status, function (v) {
        schedulePatch({ first_piece_status: v });
      });
      chipGroup(document.getElementById("sm-material-unit"), meta.material_units, handover.material_unit || "pcs", function (v) {
        schedulePatch({ material_unit: v });
      });
      chipGroup(document.getElementById("sm-ncr-status"), meta.ncr_statuses, handover.ncr_status, function (v) {
        document.getElementById("sm-ncr-ref").hidden = v !== "Open";
        schedulePatch({ ncr_status: v });
      });
      chipGroup(document.getElementById("sm-priority"), meta.priorities, handover.priority, function (v) {
        document.getElementById("sm-priority-note").hidden = ["High", "Urgent"].indexOf(v) < 0;
        schedulePatch({ priority: v });
      });
      document.querySelectorAll(".sm-issue").forEach(function (b) {
        if (b._sync) b._sync();
      });
      renderReview();
      renderTickets();
      renderComments();

      const locked = handover.status !== "draft";
      root.querySelectorAll("input, textarea, button.sm-chip, select, .sm-stepper button").forEach(function (el) {
        if (el.id === "sm-prev-btn" || el.id === "sm-next-btn") return;
        if (el.closest(".sm-steps")) return;
        if (el.id === "sm-submit-btn") {
          el.disabled = locked;
          const submitLabel = locked ? "Already handed over" : "Confirm & Hand Over";
          el.setAttribute("data-sm-t-src", submitLabel);
          el.textContent = L(submitLabel);
          return;
        }
        if (el.id === "sm-comment-add" || el.id === "sm-comment-body") {
          el.disabled = false;
          return;
        }
        if (el.id === "sm-entry-raise-ticket") {
          el.disabled = false;
          return;
        }
        el.disabled = locked;
      });
    }

    document.querySelectorAll(".sm-issue").forEach(wireIssue);

    document.getElementById("sm-queue-job").addEventListener("change", function (e) {
      const opt = e.target.selectedOptions[0];
      const val = e.target.value;
      const rem = opt && opt.dataset.rem !== "" ? Number(opt.dataset.rem) : null;
      const patch = { job_no: val };
      if (rem != null && !Number.isNaN(rem)) patch.remaining_qty = Math.round(rem);
      document.getElementById("sm-job-no").value = val;
      if (patch.remaining_qty != null) {
        document.getElementById("sm-remaining-qty").value = patch.remaining_qty;
      }
      schedulePatch(patch);
    });

    document.getElementById("sm-job-no").addEventListener("change", function (e) {
      schedulePatch({ job_no: e.target.value });
    });
    document.getElementById("sm-remarks").addEventListener("change", function (e) {
      schedulePatch({ remarks: e.target.value });
    });
    document.getElementById("sm-ncr-ref").addEventListener("change", function (e) {
      schedulePatch({ ncr_ref: e.target.value });
    });
    document.getElementById("sm-priority-note").addEventListener("change", function (e) {
      schedulePatch({ priority_note: e.target.value });
    });

    document.querySelectorAll(".sm-stepper").forEach(function (row) {
      const field = row.dataset.field;
      const input = row.querySelector("input");
      row.querySelectorAll("button[data-delta]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const delta = Number(btn.dataset.delta);
          var val = Number(input.value || 0) + delta;
          if (field === "tool_life_pct") val = Math.max(0, Math.min(100, val));
          if (field === "remaining_qty") val = Math.max(0, Math.round(val));
          input.value = val;
          var patch = {};
          patch[field] = val;
          schedulePatch(patch);
        });
      });
      input.addEventListener("change", function () {
        var val = input.value === "" ? null : Number(input.value);
        if (field === "remaining_qty") val = Math.max(0, Math.round(Number(input.value || 0)));
        if (field === "tool_life_pct") val = Math.max(0, Math.min(100, Number(input.value || 0)));
        var patch = {};
        patch[field] = val;
        schedulePatch(patch);
      });
    });

    document.querySelectorAll(".sm-step").forEach(function (btn) {
      btn.addEventListener("click", function () {
        showStep(Number(btn.dataset.step));
      });
    });
    document.getElementById("sm-prev-btn").addEventListener("click", function () {
      showStep(Math.max(1, step - 1));
    });
    document.getElementById("sm-next-btn").addEventListener("click", function () {
      showStep(Math.min(3, step + 1));
    });

    document.getElementById("sm-comment-add").addEventListener("click", async function () {
      const body = document.getElementById("sm-comment-body").value;
      try {
        const data = await api(
          "/api/shift-management/handovers/" + handover.handover_id + "/comments",
          { method: "POST", body: JSON.stringify({ body: body }) }
        );
        handover.comments = data.comments || [];
        document.getElementById("sm-comment-body").value = "";
        renderComments();
        toast("Comment added");
      } catch (err) {
        toast(err.message);
      }
    });

    const entryDialog = document.getElementById("sm-entry-ticket-dialog");
    document.getElementById("sm-entry-raise-ticket").addEventListener("click", function () {
      fillSelect(
        document.getElementById("sm-etk-category"),
        (meta && meta.ticket_categories) || ["Other"],
        "Other"
      );
      document.getElementById("sm-etk-title").value = "";
      document.getElementById("sm-etk-desc").value = "";
      if (entryDialog && entryDialog.showModal) entryDialog.showModal();
    });
    document.getElementById("sm-etk-cancel").addEventListener("click", function () {
      if (entryDialog) entryDialog.close();
    });
    document.getElementById("sm-entry-ticket-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      try {
        await api("/api/shift-management/tickets", {
          method: "POST",
          body: JSON.stringify({
            machine_id: machineId,
            planner_ps_id: handover.job_no || "",
            job_no: handover.job_no || "",
            category: document.getElementById("sm-etk-category").value,
            priority: document.getElementById("sm-etk-priority").value,
            title: document.getElementById("sm-etk-title").value,
            description: document.getElementById("sm-etk-desc").value,
            handover_id: handover.handover_id,
            work_date: handover.work_date,
            shift_out: handover.shift_out,
          }),
        });
        toast(L("Ticket created"));
        if (entryDialog) entryDialog.close();
        const data = await api("/api/shift-management/handovers/" + handover.handover_id);
        handover = data.handover;
        renderTickets();
      } catch (err) {
        toast(err.message);
      }
    });

    document.getElementById("sm-submit-btn").addEventListener("click", async function () {
      try {
        setSave("Submitting...");
        const data = await api("/api/shift-management/handovers/" + handover.handover_id + "/submit", {
          method: "POST",
          body: "{}",
        });
        handover = data.handover;
        toast("Handed over - pending acknowledgement");
        syncForm();
        setTimeout(function () {
          window.location.href = SM.appPath;
        }, 700);
      } catch (err) {
        toast(err.message);
        setSave("Submit failed");
      }
    });

    try {
      meta = await api("/api/shift-management/meta");
      const created = await api("/api/shift-management/handovers", {
        method: "POST",
        body: JSON.stringify({
          machine_id: machineId,
          work_date: workDate,
          shift_out: shiftOut,
          job_no: prefPs || undefined,
        }),
      });
      handover = created.handover;
      if (prefPs && handover.status === "draft" && handover.job_no !== prefPs) {
        schedulePatch({ job_no: prefPs });
        handover.job_no = prefPs;
      }
      syncForm();
      showStep(1);
      setSave("Ready");
      SM.refresh = function () {
        if (!handover) return;
        syncForm();
        showStep(step);
      };
    } catch (err) {
      toast(err.message);
      root.innerHTML = '<p class="sm-muted">' + escapeHtml(L(err.message)) + "</p>";
    }
  }

  async function initAck() {
    const root = document.getElementById("sm-ack-root");
    if (!root) return;
    const id = Number(SM.handoverId || root.dataset.handoverId);
    let currentHo = null;

    function render(ho) {
      currentHo = ho;
      const flags = [];
      if (ho.priority === "Urgent" || ho.priority === "High") {
        flags.push(
          '<span class="sm-flag">' +
            escapeHtml(t("priority_flag", { priority: L(ho.priority), note: ho.priority_note || "" })) +
            "</span>"
        );
      }
      if (ho.quality_issue_flag)
        flags.push('<span class="sm-flag">' + escapeHtml(t("quality_line", { text: ho.quality_issue_text || "" })) + "</span>");
      if (ho.alarm_flag)
        flags.push('<span class="sm-flag">' + escapeHtml(t("alarm_line", { text: ho.alarm_text || "" })) + "</span>");
      if (ho.maintenance_flag)
        flags.push('<span class="sm-flag warn">' + escapeHtml(t("maint_line", { text: ho.maintenance_text || "" })) + "</span>");
      if (ho.ncr_status === "Open")
        flags.push('<span class="sm-flag">' + escapeHtml(t("ncr_open", { ref: ho.ncr_ref || "" })) + "</span>");
      if (ho.first_piece_status === "Not OK")
        flags.push('<span class="sm-flag">' + escapeHtml(L("First piece Not OK")) + "</span>");
      if (ho.machine_status === "Breakdown") flags.push('<span class="sm-flag">' + escapeHtml(L("Breakdown")) + "</span>");

      const comments = (ho.comments || [])
        .map(function (c) {
          return (
            "<div class=\"sm-comment\"><div class=\"sm-muted\">" +
            escapeHtml(c.display_name || c.username || "") +
            "</div>" +
            escapeHtml(c.body) +
            "</div>"
          );
        })
        .join("");

      const canAct = ho.status === "pending_ack" || ho.status === "disputed";
      root.innerHTML =
        '<h2 class="sm-machine-heading">' +
        escapeHtml(ho.machine_no) +
        "</h2>" +
        '<p class="sm-muted">' +
        escapeHtml(ho.work_date) +
        " | " +
        escapeHtml(L(ho.shift_out)) +
        " → " +
        escapeHtml(L(ho.shift_in || "")) +
        " | " +
        escapeHtml(L(ho.status)) +
        "</p>" +
        '<div class="sm-flags">' +
        (flags.join("") || '<span class="sm-muted">' + escapeHtml(L("No issues flagged")) + "</span>") +
        "</div>" +
        '<div class="sm-review">' +
        "<div><strong>" + escapeHtml(L("Status")) + ":</strong> " + escapeHtml(L(ho.machine_status)) + "</div>" +
        "<div>" +
        escapeHtml(t("job_qty", { job: ho.job_no || "-", qty: ho.remaining_qty })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("tool_material", {
          tool: ho.tool_life_pct,
          qty: ho.material_qty == null ? "-" : ho.material_qty,
          unit: L(ho.material_unit || ""),
        })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("first_piece_line", { status: L(ho.first_piece_status) })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("outgoing_line", { name: ho.outgoing_display_name || "-" })) +
        "</div>" +
        "<div>" +
        escapeHtml(t("remarks_line", { text: ho.remarks || "-" })) +
        "</div>" +
        "</div>" +
        (comments ? '<div class="sm-comments-box"><h3 class="sm-section-title">' + escapeHtml(L("Comments")) + "</h3>" + comments + "</div>" : "") +
        (canAct
          ? '<button type="button" class="sm-btn sm-btn-primary sm-btn-block" id="sm-ack-btn">' + escapeHtml(L("Acknowledge")) + "</button>" +
            '<button type="button" class="sm-btn sm-btn-danger sm-btn-block" id="sm-dispute-btn">' + escapeHtml(L("Flag discrepancy")) + "</button>" +
            '<textarea class="sm-textarea" id="sm-dispute-note" hidden placeholder="' + escapeHtml(L("What is wrong with this handover?")) + '"></textarea>' +
            '<button type="button" class="sm-btn sm-btn-ghost sm-btn-block" id="sm-dispute-confirm" hidden>' + escapeHtml(L("Submit discrepancy")) + "</button>"
          : '<p class="sm-muted">' +
            escapeHtml(t("ack_already", { status: L(ho.status) })) +
            (ho.incoming_display_name ? escapeHtml(t("ack_by", { name: ho.incoming_display_name })) : "") +
            "</p>");

      const ackBtn = document.getElementById("sm-ack-btn");
      if (ackBtn) {
        ackBtn.addEventListener("click", async function () {
          try {
            await api("/api/shift-management/handovers/" + id + "/acknowledge", {
              method: "POST",
              body: "{}",
            });
            toast("Acknowledged");
            window.location.href = SM.appPath;
          } catch (err) {
            toast(err.message);
          }
        });
      }
      const disputeBtn = document.getElementById("sm-dispute-btn");
      const note = document.getElementById("sm-dispute-note");
      const confirm = document.getElementById("sm-dispute-confirm");
      if (disputeBtn) {
        disputeBtn.addEventListener("click", function () {
          note.hidden = false;
          confirm.hidden = false;
          note.focus();
        });
      }
      if (confirm) {
        confirm.addEventListener("click", async function () {
          try {
            await api("/api/shift-management/handovers/" + id + "/dispute", {
              method: "POST",
              body: JSON.stringify({ note: note.value }),
            });
            toast("Discrepancy flagged");
            window.location.href = SM.appPath;
          } catch (err) {
            toast(err.message);
          }
        });
      }
    }

    try {
      const data = await api("/api/shift-management/handovers/" + id);
      render(data.handover);
      SM.refresh = function () {
        if (currentHo) render(currentHo);
      };
    } catch (err) {
      root.innerHTML = '<p class="sm-muted">' + escapeHtml(L(err.message)) + "</p>";
    }
  }

  async function initDashboard() {
    const dateEl = document.getElementById("sm-dash-date");
    const kpi = document.getElementById("sm-kpi-grid");
    const list = document.getElementById("sm-dash-list");
    if (!dateEl || !kpi) return;
    dateEl.value = todayISO();
    let shift = "";

    function paintShift() {
      document.querySelectorAll("#sm-dash-shift-chips .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", (btn.dataset.shift || "") === shift);
      });
    }

    async function load() {
      try {
        const q = new URLSearchParams({ date: dateEl.value });
        if (shift) q.set("shift", shift);
        const data = await api("/api/shift-management/dashboard?" + q.toString());
        const k = data.kpis || {};
        const tiles = [
          [L("Breakdowns"), k.breakdowns],
          [L("Open NCRs"), k.open_ncrs],
          [L("Urgent"), k.urgent_jobs],
          [L("Pending maint."), k.pending_maintenance],
          [L("1st piece NOK"), k.first_piece_not_ok],
          [L("Pending ack"), k.pending_ack],
          [L("Open tickets"), k.open_tickets],
        ];
        kpi.innerHTML = tiles
          .map(function (pair) {
            return (
              '<div class="sm-kpi"><div class="sm-kpi-value">' +
              (pair[1] != null ? pair[1] : 0) +
              '</div><div class="sm-kpi-label">' +
              pair[0] +
              "</div></div>"
            );
          })
          .join("");
        const items = data.handovers || [];
        if (list) {
          list.innerHTML = items.length
          ? items
              .map(function (h) {
                const inner =
                  "<span><strong>" +
                  escapeHtml(h.machine_no) +
                  "</strong> | " +
                  escapeHtml(L(h.shift_out)) +
                  " | " +
                  escapeHtml(L(h.machine_status)) +
                  '<br><span class="sm-muted">' +
                  escapeHtml(h.job_no || "-") +
                  " | " +
                  escapeHtml(L(h.status)) +
                  "</span></span>" +
                  badgeForHandover(h);
                if (!can("can_ops_actions")) {
                  return '<div class="sm-list-item">' + inner + "</div>";
                }
                const href =
                  h.status === "pending_ack" || h.status === "disputed"
                    ? SM.appPath + "/ack/" + h.handover_id
                    : SM.appPath + "/entry/" + h.machine_id;
                return '<a class="sm-list-item" href="' + href + '">' + inner + "</a>";
              })
              .join("")
          : '<p class="sm-muted">' + escapeHtml(L("No handovers for this date yet.")) + "</p>";
        }

        const queueEl = document.getElementById("sm-dash-queue");
        if (queueEl) {
          const queue = data.queue || [];
          const busy = queue.filter(function (row) {
            return Number(row.queue_count || 0) > 0;
          });
          queueEl.innerHTML = busy.length
            ? busy
                .map(function (row) {
                  const head = row.head_job || {};
                  return (
                    '<div class="sm-dash-queue-card">' +
                    "<strong>" +
                    escapeHtml(row.machine_no) +
                    "</strong>" +
                    '<div class="sm-dash-queue-count">' +
                    escapeHtml(row.queue_count) +
                    "</div>" +
                    '<div class="sm-muted">' +
                    escapeHtml(window.smN ? smN(row.queue_count, "queued_one", "queued_many") : "") +
                    "</div>" +
                    '<div class="sm-muted">' +
                    escapeHtml(head.process_sheet_no || head.job_no || "—") +
                    (head.operation_name ? " · " + escapeHtml(head.operation_name) : "") +
                    "</div></div>"
                  );
                })
                .join("")
            : '<p class="sm-muted">' + escapeHtml(L("No queued jobs for this shift.")) + "</p>";
        }

        const ticketsEl = document.getElementById("sm-dash-tickets");
        if (ticketsEl) {
          const tickets = data.open_tickets || [];
          ticketsEl.innerHTML = tickets.length
            ? tickets
                .map(function (t) {
                  return (
                    '<div class="sm-list-item"><span><strong>#' +
                    t.ticket_id +
                    "</strong> " +
                    escapeHtml(t.machine_no || "") +
                    " · " +
                    escapeHtml(L(t.category)) +
                    ": " +
                    escapeHtml(t.title) +
                    '<br><span class="sm-muted">' +
                    escapeHtml(L(t.priority)) +
                    " · " +
                    escapeHtml(L(t.status)) +
                    " · " +
                    escapeHtml(L("Process Sheet")) +
                    " " +
                    escapeHtml(t.process_sheet_no || t.job_no || "-") +
                    "</span></span></div>"
                  );
                })
                .join("")
            : '<p class="sm-muted">' + escapeHtml(L("No open tickets.")) + "</p>";
        }
      } catch (err) {
        kpi.innerHTML = "";
        if (list) list.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
      }
    }

    document.querySelectorAll("#sm-dash-shift-chips .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        shift = btn.dataset.shift || "";
        paintShift();
        load();
      });
    });
    const reportBtn = document.getElementById("sm-dash-report");
    if (reportBtn) {
      reportBtn.addEventListener("click", function () {
        downloadReportPdf(dateEl.value, shift || rememberedShift());
      });
    }
    dateEl.addEventListener("change", load);
    paintShift();
    load();
    SM.refresh = function () {
      load();
    };
  }

  async function initHotoBacklog() {
    const tbody = document.querySelector("#hoto-log-table tbody");
    if (!tbody) return;
    const from = document.getElementById("hoto-log-from");
    const to = document.getElementById("hoto-log-to");
    const shiftEl = document.getElementById("hoto-log-shift");
    to.value = todayISO();
    const start = new Date();
    start.setDate(start.getDate() - 30);
    from.value = start.toISOString().slice(0, 10);

    function stamp(value) {
      return value ? String(value).replace("T", " ") : "";
    }

    async function load() {
      const q = new URLSearchParams();
      if (from.value) q.set("from", from.value);
      if (to.value) q.set("to", to.value);
      if (shiftEl && shiftEl.value) q.set("shift", shiftEl.value);
      tbody.innerHTML = '<tr><td colspan="7">' + escapeHtml(L("Loading...")) + "</td></tr>";
      try {
        const data = await api("/api/shift-management/hoto/backlog?" + q.toString());
        const items = data.items || [];
        tbody.innerHTML = items.length
          ? items
              .map(function (row) {
                const href =
                  SM.appPath +
                  "/hoto?submission=" +
                  encodeURIComponent(row.submission_id) +
                  "&date=" +
                  encodeURIComponent(row.work_date || "") +
                  "&shift=" +
                  encodeURIComponent(row.shift_out || "");
                return (
                  "<tr>" +
                  "<td>" + escapeHtml(stamp(row.submitted_at)) + "</td>" +
                  "<td>" + escapeHtml(row.work_date || "") + "</td>" +
                  "<td>" + escapeHtml(L(row.shift_out || "")) + "</td>" +
                  "<td>" + escapeHtml(row.outgoing_supervisor || row.outgoing_sign_name || "") + "</td>" +
                  "<td>" + escapeHtml(row.incoming_supervisor || row.incoming_sign_name || "") + "</td>" +
                  "<td>" + escapeHtml(row.submitted_by_name || "") + "</td>" +
                  '<td><a href="' + href + '">' + escapeHtml(t("open_record")) + "</a></td>" +
                  "</tr>"
                );
              })
              .join("")
          : '<tr><td colspan="7">' + escapeHtml(L("No submitted handovers in this range.")) + "</td></tr>";
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="7">' + escapeHtml(err.message) + "</td></tr>";
      }
    }

    document.getElementById("hoto-log-apply").addEventListener("click", load);
    load();
    SM.refresh = function () {
      load();
    };
  }

  async function initHistory() {
    const panel = document.getElementById("sm-record-panel");
    const dateEl = document.getElementById("sm-record-date");
    const recentEl = document.getElementById("sm-record-recent");
    if (!panel || !dateEl) return;

    const params = new URLSearchParams(window.location.search);
    const views = ["report", "hoto", "tickets"];
    let shift = normalizeShiftClient(params.get("shift") || rememberedShift());
    let view = views.indexOf(params.get("view")) >= 0 ? params.get("view") : "report";
    let records = [];
    let indexKey = "";
    let detail = null;
    let detailKey = "";
    let loadSeq = 0;
    let ticketSort = "priority";
    dateEl.value = params.get("date") || rememberedDate();

    function addDays(iso, days) {
      const parts = String(iso || todayISO()).split("-");
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      d.setDate(d.getDate() + days);
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return d.getFullYear() + "-" + m + "-" + day;
    }

    function labelDate(iso) {
      const parts = String(iso || "").split("-");
      if (parts.length < 3) return iso || "";
      const d = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      return d.toLocaleDateString(uiLocale(), { weekday: "short", day: "numeric", month: "short" });
    }

    function stamp(value) {
      return value ? String(value).replace("T", " ").slice(0, 16) : "";
    }

    function lineHasData(line) {
      if (!line) return false;
      return !!(
        line.process_sheet_no ||
        line.description ||
        line.cnc ||
        line.scanned_erp ||
        (line.target_qty != null && line.target_qty !== "") ||
        (line.produced_qty != null && line.produced_qty !== "") ||
        (line.rejected_qty != null && line.rejected_qty !== "")
      );
    }

    function qtyText(value) {
      if (value == null || value === "") return "";
      const number = Number(value);
      if (!isFinite(number)) return "";
      if (Math.abs(number - Math.round(number)) < 0.001) return String(Math.round(number));
      return String(Math.round(number * 1000) / 1000);
    }

    function sumQty(lines, key) {
      let total = 0;
      let any = false;
      lines.forEach(function (line) {
        if (line[key] == null || line[key] === "") return;
        const number = Number(line[key]);
        if (!isFinite(number)) return;
        total += number;
        any = true;
      });
      return any ? qtyText(total) : "";
    }

    function hotoLabel(no) {
      const labels = SM.hotoLabels || [];
      const found = labels.filter(function (item) {
        return Number(item.no) === Number(no);
      })[0];
      return t("hoto_item_" + no) !== "hoto_item_" + no
        ? t("hoto_item_" + no)
        : L((found && found.text) || "") || t("item_n", { n: no });
    }

    function writeUrl() {
      const q = new URLSearchParams();
      q.set("date", dateEl.value || todayISO());
      q.set("shift", shift);
      q.set("view", view);
      const next = window.location.pathname + "?" + q.toString();
      if (window.location.pathname + window.location.search !== next) {
        history.replaceState(null, "", next);
      }
    }

    function paintShift() {
      document.querySelectorAll("#sm-record-shift .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.dataset.shift === shift);
      });
    }

    function paintViews() {
      const openCount = detail
        ? (detail.tickets || []).filter(function (t) {
            return ticketIsOpen(t.status);
          }).length
        : 0;
      document.querySelectorAll("#sm-record-views .sm-subtab").forEach(function (btn) {
        const on = btn.dataset.recordView === view;
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-selected", on ? "true" : "false");
        if (btn.dataset.recordView === "tickets") {
          const label = openCount ? t("tickets_tab", { n: openCount }) : L("Tickets");
          btn.setAttribute("data-sm-t-src", openCount ? "" : "Tickets");
          if (!openCount) btn.setAttribute("data-sm-t-src", "Tickets");
          btn.textContent = label;
        }
      });
    }

    function chipNote(row) {
      const bits = [];
      if (row.report_filed) bits.push(L("Report"));
      if (row.hoto_status === "submitted") bits.push(L("HOTO"));
      else if (row.hoto_status === "draft") bits.push(L("HOTO draft"));
      if (row.ticket_count) {
        bits.push(window.smN ? smN(row.ticket_count, "chip_ticket_one", "chip_ticket_many") : String(row.ticket_count));
      }
      return bits.join(" · ");
    }

    function paintRecent() {
      if (!recentEl) return;
      if (!records.length) {
        recentEl.innerHTML = '<p class="sm-muted sm-record-empty">' + escapeHtml(L("No shifts filed in this range.")) + "</p>";
        return;
      }
      recentEl.innerHTML = records
        .map(function (row) {
          const on = row.work_date === dateEl.value && row.shift_out === shift;
          return (
            '<button type="button" class="sm-record-chip' +
            (on ? " is-active" : "") +
            '" data-date="' +
            escapeHtml(row.work_date) +
            '" data-shift="' +
            escapeHtml(row.shift_out) +
            '"><strong>' +
            escapeHtml(labelDate(row.work_date)) +
            " · " +
            escapeHtml(L(row.shift_out)) +
            "</strong><small>" +
            escapeHtml(chipNote(row)) +
            "</small></button>"
          );
        })
        .join("");
      recentEl.querySelectorAll(".sm-record-chip").forEach(function (btn) {
        btn.addEventListener("click", function () {
          dateEl.value = btn.dataset.date;
          shift = normalizeShiftClient(btn.dataset.shift);
          rememberContext(dateEl.value, shift);
          paintShift();
          loadDetail();
        });
      });
      const active = recentEl.querySelector(".sm-record-chip.is-active");
      if (active && active.scrollIntoView) {
        active.scrollIntoView({ inline: "center", block: "nearest" });
      }
    }

    function syncRecord(report, checklist, tickets) {
      const lines = ((report && report.lines) || []).filter(lineHasData);
      const savedHoto = checklist && checklist.saved;
      const row = records.filter(function (item) {
        return item.work_date === dateEl.value && item.shift_out === shift;
      })[0];
      const next = {
        work_date: dateEl.value,
        shift_out: shift,
        report_filed: lines.length > 0,
        report_line_count: lines.length,
        hoto_status: savedHoto ? checklist.doc_status || "draft" : "",
        hoto_submitted_at: savedHoto ? checklist.submitted_at || "" : "",
        outgoing_supervisor: savedHoto ? checklist.outgoing_supervisor || "" : "",
        incoming_supervisor: savedHoto ? checklist.incoming_supervisor || "" : "",
        submitted_by_name: savedHoto ? checklist.submitted_by_name || "" : "",
        ticket_count: tickets.length,
        open_ticket_count: tickets.filter(function (t) {
          return ticketIsOpen(t.status);
        }).length,
      };
      if (row) {
        Object.assign(row, next);
      } else if (next.report_filed || next.hoto_status || next.ticket_count) {
        records.unshift(next);
        records.sort(function (a, b) {
          if (a.work_date !== b.work_date) return a.work_date < b.work_date ? 1 : -1;
          return (b.shift_out === "Night" ? 1 : 0) - (a.shift_out === "Night" ? 1 : 0);
        });
      }
    }

    function fact(text, kind) {
      return '<span class="sm-record-fact is-' + kind + '">' + escapeHtml(text) + "</span>";
    }

    function factsHtml() {
      const report = detail.report || {};
      const checklist = detail.checklist || {};
      const tickets = detail.tickets || [];
      const lines = (report.lines || []).filter(lineHasData);
      const openCount = tickets.filter(function (t) {
        return ticketIsOpen(t.status);
      }).length;
      const bits = [];
      bits.push(
        lines.length
          ? fact(window.smN ? smN(lines.length, "report_lines_one", "report_lines_many") : String(lines.length), "ok")
          : fact(L("No report yet"), "muted")
      );
      if (checklist.saved && checklist.doc_status === "submitted") {
        const when = stamp(checklist.submitted_at);
        bits.push(fact(when ? t("hoto_submitted_when", { when: when }) : L("Submitted"), "ok"));
      } else if (checklist.saved) {
        bits.push(fact(L("HOTO still a draft"), "warn"));
      } else {
        bits.push(fact(L("HOTO not started"), "muted"));
      }
      if (!tickets.length) bits.push(fact(L("No tickets"), "muted"));
      else if (openCount) bits.push(fact(t("tickets_open_of", { open: openCount, total: tickets.length }), "warn"));
      else bits.push(fact(window.smN ? smN(tickets.length, "tickets_closed_one", "tickets_closed_many") : String(tickets.length), "ok"));
      return '<div class="sm-record-facts">' + bits.join("") + "</div>";
    }

    function reportHtml() {
      const lines = ((detail.report && detail.report.lines) || []).filter(lineHasData);
      if (!lines.length) {
        return (
          '<div class="sm-record-empty-card"><p>' + escapeHtml(L("No production report filed for this shift.")) + "</p>" +
          '<a class="sm-btn sm-btn-ghost" href="' +
          SM.appPath +
          '/ops">' + escapeHtml(L("Fill it on the queue")) + "</a></div>"
        );
      }
      const body = lines
        .map(function (line, index) {
          return (
            "<tr><td class=\"sm-prod-no\">" +
            (index + 1) +
            "</td><td>" +
            escapeHtml(line.process_sheet_no || "") +
            "</td><td>" +
            escapeHtml(line.description || "") +
            "</td><td>" +
            escapeHtml(qtyText(line.target_qty)) +
            "</td><td>" +
            escapeHtml(qtyText(line.produced_qty)) +
            "</td><td>" +
            escapeHtml(qtyText(line.rejected_qty)) +
            "</td><td>" +
            escapeHtml(line.cnc || "") +
            "</td><td>" +
            escapeHtml(line.scanned_erp || "") +
            "</td></tr>"
          );
        })
        .join("");
      return (
        '<div class="sm-prod-sheet"><div class="sm-prod-banner">' + escapeHtml(L("PRODUCTION SUMMARY & SCANNED ITEMS")) + "</div>" +
        '<div class="sm-prod-sub">' +
        escapeHtml(labelDate(dateEl.value) + " · " + L(shift)) +
        "</div><div class=\"sm-prod-scroll\"><table class=\"sm-prod-table is-readonly\"><thead><tr>" +
        "<th class=\"sm-prod-no\">#</th><th>" + escapeHtml(L("Process Sheet")) + "</th><th>" + escapeHtml(L("Description")) + "</th><th>" + escapeHtml(L("Target Qty")) + "</th>" +
        "<th>" + escapeHtml(L("Produced Qty")) + "</th><th>" + escapeHtml(L("Rejected Qty")) + "</th><th>" + escapeHtml(L("CNC")) + "</th><th>" + escapeHtml(L("Scanned ERP")) + "</th>" +
        "</tr></thead><tbody>" +
        body +
        "</tbody><tfoot><tr><td></td><td colspan=\"2\" class=\"sm-prod-total-label\">" + escapeHtml(L("TOTAL")) + "</td><td>" +
        escapeHtml(sumQty(lines, "target_qty")) +
        "</td><td>" +
        escapeHtml(sumQty(lines, "produced_qty")) +
        "</td><td>" +
        escapeHtml(sumQty(lines, "rejected_qty")) +
        "</td><td></td><td></td></tr></tfoot></table></div></div>" +
        '<div class="sm-record-links">' +
        '<button type="button" class="sm-btn sm-btn-ghost" id="sm-record-pdf">' + escapeHtml(L("PDF report")) + "</button>" +
        '<a class="sm-btn sm-btn-ghost" href="' +
        SM.appPath +
        '/ops">' + escapeHtml(L("Edit on the queue")) + "</a></div>"
      );
    }

    function hotoHtml() {
      const checklist = detail.checklist || {};
      const href =
        SM.appPath +
        "/hoto?date=" +
        encodeURIComponent(dateEl.value || "") +
        "&shift=" +
        encodeURIComponent(shift);
      if (!checklist.saved) {
        return (
          '<div class="sm-record-empty-card"><p>' + escapeHtml(L("No HOTO checklist filed for this shift.")) + "</p>" +
          '<a class="sm-btn sm-btn-primary" href="' +
          href +
          '">' + escapeHtml(L("Open HOTO")) + "</a></div>"
        );
      }
      const items = checklist.items || [];
      const issues = items.filter(function (item) {
        return item.status === "Issue Raised";
      }).length;
      const banner = checklist.doc_status === "submitted"
        ? (checklist.submitted_by_name
            ? t("submitted_by", { when: stamp(checklist.submitted_at), name: checklist.submitted_by_name })
            : stamp(checklist.submitted_at)
              ? t("submitted_when", { when: stamp(checklist.submitted_at) })
              : L("Submitted"))
        : L("Draft — not submitted yet");
      const rows = items
        .map(function (item) {
          const statusClass =
            item.status === "Issue Raised" ? "sm-issue" : item.status === "No Issue" ? "sm-ok-text" : "";
          return (
            "<tr><td class=\"sm-prod-no\">" +
            escapeHtml(item.no) +
            "</td><td>" +
            escapeHtml(hotoLabel(item.no)) +
            "</td><td class=\"" +
            statusClass +
            "\">" +
            escapeHtml(item.status ? L(item.status) : "—") +
            "</td><td>" +
            escapeHtml(item.remarks || "") +
            "</td><td>" +
            escapeHtml(item.checked_by || "") +
            "</td></tr>"
          );
        })
        .join("");
      const people = (checklist.attendance || []).filter(function (row) {
        return row.name || row.remarks;
      });
      const attendance = people.length
        ? people
            .map(function (row) {
              return (
                "<tr><td>" +
                escapeHtml(row.name) +
                "</td><td>" +
                (row.late ? escapeHtml(L("Late")) : "") +
                "</td><td>" +
                escapeHtml(row.remarks || "") +
                "</td></tr>"
              );
            })
            .join("")
        : '<tr><td colspan="3" class="sm-muted">' + escapeHtml(L("No attendance recorded.")) + "</td></tr>";
      return (
        '<p class="sm-record-banner' +
        (checklist.doc_status === "submitted" ? " is-ok" : " is-warn") +
        '">' +
        escapeHtml(banner) +
        (issues ? " · " + escapeHtml(window.smN ? smN(issues, "issues_one", "issues_many") : String(issues)) : "") +
        "</p>" +
        '<div class="sm-hoto-read"><h3>' + escapeHtml(L("SHIFT DETAILS")) + '</h3><table class="sm-hoto-details"><tbody>' +
        "<tr><th>" + escapeHtml(L("Handover")) + "</th><td>" +
        escapeHtml(stamp(checklist.handover_at) || "—") +
        "</td></tr><tr><th>" + escapeHtml(L("Outgoing")) + "</th><td>" +
        escapeHtml(checklist.outgoing_supervisor || "—") +
        (checklist.outgoing_sign_name
          ? escapeHtml(t("signed_name", { name: checklist.outgoing_sign_name })) +
            (stamp(checklist.outgoing_signed_at) ? " " + escapeHtml(stamp(checklist.outgoing_signed_at)) : "")
          : "") +
        "</td></tr><tr><th>" + escapeHtml(L("Incoming")) + "</th><td>" +
        escapeHtml(checklist.incoming_supervisor || "—") +
        (checklist.incoming_sign_name
          ? escapeHtml(t("signed_name", { name: checklist.incoming_sign_name })) +
            (stamp(checklist.incoming_signed_at) ? " " + escapeHtml(stamp(checklist.incoming_signed_at)) : "")
          : "") +
        "</td></tr></tbody></table>" +
        "<h3>" + escapeHtml(L("HANDOVER CHECKLIST")) + "</h3><div class=\"sm-prod-scroll\"><table><thead><tr>" +
        "<th>#</th><th>" + escapeHtml(L("Item")) + "</th><th>" + escapeHtml(L("Status")) + "</th><th>" + escapeHtml(L("Remarks")) + "</th><th>" + escapeHtml(L("Checked by")) + "</th></tr></thead><tbody>" +
        rows +
        "</tbody></table></div><h3>" + escapeHtml(L("ATTENDANCE")) + "</h3><table><thead><tr><th>" + escapeHtml(L("Name")) + "</th><th>" + escapeHtml(L("Late")) + "</th><th>" + escapeHtml(L("Remarks")) + "</th></tr></thead><tbody>" +
        attendance +
        "</tbody></table></div>" +
        '<div class="sm-record-links"><a class="sm-btn sm-btn-ghost" href="' +
        href +
        '">' +
        escapeHtml(checklist.doc_status === "submitted" ? L("Open checklist") : L("Finish on HOTO")) +
        "</a></div>"
      );
    }

    function ticketsHtml() {
      const tickets = sortTickets(detail.tickets || [], ticketSort);
      if (!tickets.length) {
        return (
          '<div class="sm-record-empty-card"><p>' + escapeHtml(L("No tickets for this shift.")) + "</p>" +
          '<a class="sm-btn sm-btn-ghost" href="' +
          SM.appPath +
          '/ops">' + escapeHtml(L("Raise one from the queue")) + "</a></div>"
        );
      }
      const sortControl = can("can_review_ticket")
        ? '<label class="sm-field-inline sm-ticket-sort-inline"><span>' + escapeHtml(L("Sort")) + "</span>" +
          '<select id="sm-record-ticket-sort" class="sm-input">' +
          '<option value="priority"' +
          (ticketSort === "priority" ? " selected" : "") +
          ">" + escapeHtml(L("Priority")) + "</option>" +
          '<option value="newest"' +
          (ticketSort === "newest" ? " selected" : "") +
          ">" + escapeHtml(L("Newest")) + "</option>" +
          '<option value="oldest"' +
          (ticketSort === "oldest" ? " selected" : "") +
          ">" + escapeHtml(L("Oldest")) + "</option>" +
          '<option value="status"' +
          (ticketSort === "status" ? " selected" : "") +
          ">" + escapeHtml(L("Status")) + "</option>" +
          '<option value="machine"' +
          (ticketSort === "machine" ? " selected" : "") +
          ">" + escapeHtml(L("Machine")) + "</option>" +
          '<option value="submitter"' +
          (ticketSort === "submitter" ? " selected" : "") +
          ">" + escapeHtml(L("Submitted by")) + "</option>" +
          '<option value="category"' +
          (ticketSort === "category" ? " selected" : "") +
          ">" + escapeHtml(L("Category")) + "</option></select></label>"
        : "";
      return (
        sortControl +
        '<div class="sm-list">' +
        tickets.map(ticketCardHtml).join("") +
        "</div>"
      );
    }

    function paint() {
      paintViews();
      paintRecent();
      writeUrl();
      if (!detail) {
        panel.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Loading…")) + "</p>";
        return;
      }
      const body = view === "hoto" ? hotoHtml() : view === "tickets" ? ticketsHtml() : reportHtml();
      panel.innerHTML =
        '<h3 class="sm-record-title">' +
        escapeHtml(labelDate(dateEl.value) + " · " + L(shift)) +
        "</h3>" +
        factsHtml() +
        body;
      const pdf = document.getElementById("sm-record-pdf");
      if (pdf) {
        pdf.addEventListener("click", function () {
          downloadReportPdf(dateEl.value, shift);
        });
      }
      const recordSort = document.getElementById("sm-record-ticket-sort");
      if (recordSort) {
        recordSort.addEventListener("change", function () {
          ticketSort = recordSort.value || "priority";
          paint();
        });
      }
      bindTicketStatus(panel, loadDetail);
    }

    async function loadIndex(seq) {
      const to = todayISO();
      let from = addDays(to, -30);
      if (dateEl.value && dateEl.value < from) from = dateEl.value;
      const key = from + "|" + to;
      if (indexKey === key) return;
      const data = await api(
        "/api/shift-management/shift-records?from=" +
          encodeURIComponent(from) +
          "&to=" +
          encodeURIComponent(to)
      );
      if (seq !== loadSeq) return;
      indexKey = key;
      records = data.items || [];
    }

    async function loadDetail() {
      const seq = ++loadSeq;
      const date = dateEl.value || todayISO();
      const key = date + "|" + shift;
      detailKey = key;
      rememberContext(date, shift);
      paintShift();
      writeUrl();
      panel.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Loading…")) + "</p>";
      try {
        const q = "date=" + encodeURIComponent(date) + "&shift=" + encodeURIComponent(shift);
        const results = await Promise.all([
          api("/api/shift-management/production-report?" + q),
          api("/api/shift-management/hoto?" + q),
          api("/api/shift-management/tickets?" + q),
          loadIndex(seq).catch(function () {
            records = records || [];
          }),
        ]);
        if (seq !== loadSeq || detailKey !== key) return;
        detail = {
          report: results[0] || {},
          checklist: (results[1] && results[1].checklist) || {},
          tickets: (results[2] && results[2].items) || [],
        };
        syncRecord(detail.report, detail.checklist, detail.tickets);
        paint();
      } catch (err) {
        if (seq !== loadSeq) return;
        detail = null;
        panel.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
      }
    }

    document.querySelectorAll("#sm-record-shift .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        shift = btn.dataset.shift || "Day";
        paintShift();
        loadDetail();
      });
    });
    document.querySelectorAll("#sm-record-views .sm-subtab").forEach(function (btn) {
      btn.addEventListener("click", function () {
        view = btn.dataset.recordView || "report";
        paint();
      });
    });
    dateEl.addEventListener("change", loadDetail);
    paintShift();
    paintViews();
    if (params.get("filed") === "1") toast("Handover submitted");
    loadDetail();
    SM.refresh = function () {
      paint();
    };
  }

  async function initJobs() {
    const list = document.getElementById("sm-jobs-list");
    const picker = document.getElementById("sm-jobs-picker");
    if (!list || !picker) return;
    const dateEl = document.getElementById("sm-ops-date");
    const searchEl = document.getElementById("sm-ops-search");
    const leadEl = document.getElementById("sm-jobs-lead");
    const GROUP_ORDER = ["MPP", "MILLING", "TURNING", "TURNMILL"];
    let meta = null;
    let machines = [];
    let shift = rememberedShift();
    let selectedMachineId = null;
    let selectedBlockId = null;
    let popLane = false;
    const dialog = document.getElementById("sm-ticket-dialog");
    const form = document.getElementById("sm-ticket-form");
    if (dateEl) dateEl.value = rememberedDate();

    function paintShiftChips() {
      document.querySelectorAll("#sm-ops-shift-chips .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.dataset.shift === shift);
      });
    }

    function searchQuery() {
      return ((searchEl && searchEl.value) || "").trim().toLowerCase();
    }

    function machineById(id) {
      const want = String(id || "");
      for (let i = 0; i < machines.length; i++) {
        if (String(machines[i].machine_id) === want) return machines[i];
      }
      return null;
    }

    function categoryOf(machine) {
      return String((machine && machine.machine_category) || "OTHER").trim().toUpperCase() || "OTHER";
    }

    function sortByMachineNo(rows) {
      return rows.slice().sort(function (a, b) {
        return String(a.machine_no || "").localeCompare(String(b.machine_no || ""), undefined, {
          numeric: true,
        });
      });
    }

    function groupMachines(rows) {
      const map = {};
      rows.forEach(function (machine) {
        const cat = categoryOf(machine);
        if (!map[cat]) map[cat] = [];
        map[cat].push(machine);
      });
      const cats = GROUP_ORDER.filter(function (cat) { return map[cat]; }).concat(
        Object.keys(map)
          .filter(function (cat) { return GROUP_ORDER.indexOf(cat) < 0; })
          .sort()
      );
      return cats.map(function (cat) {
        return { cat: cat, machines: sortByMachineNo(map[cat]) };
      });
    }

    function openTicketDialog(machine, job) {
      const item = Object.assign({ machine_id: machine.machine_id, machine_no: machine.machine_no }, job || {});
      document.getElementById("sm-tk-machine-id").value = item.machine_id;
      document.getElementById("sm-tk-block-id").value = item.block_id || "";
      document.getElementById("sm-tk-ps").value = item.process_sheet_no || item.source_ps_id || "";
      document.getElementById("sm-tk-job").value = item.job_no || item.process_sheet_no || "";
      document.getElementById("sm-ticket-context").textContent = t("ps_job", {
        machine: item.machine_no || "",
        ps: item.process_sheet_no || item.job_no || "-",
      });
      fillSelect(
        document.getElementById("sm-tk-category"),
        (meta && meta.ticket_categories) || ["Other"],
        (SM.caps && SM.caps.default_ticket_category) || "Other"
      );
      document.getElementById("sm-tk-title").value = "";
      document.getElementById("sm-tk-desc").value = "";
      document.getElementById("sm-tk-status").hidden = true;
      if (dialog && dialog.showModal) dialog.showModal();
    }

    function matchesSearch(machine, q) {
      if (!q) return true;
      const hay = [
        machine.machine_no,
        machine.machine_category,
        (machine.jobs || [])
          .map(function (j) {
            return [j.process_sheet_no, j.job_no, j.operation_name].join(" ");
          })
          .join(" "),
      ]
        .join(" ")
        .toLowerCase();
      return hay.indexOf(q) >= 0;
    }

    function seqMeta(job, idx) {
      const pos = job && job.queue_position != null ? Number(job.queue_position) : idx + 1;
      if (pos <= 1) return { text: L("NOW"), cls: "is-now" };
      if (pos === 2) return { text: L("NEXT"), cls: "is-next" };
      return { text: String(pos), cls: "is-later" };
    }

    function setLead(text) {
      if (!leadEl) return;
      leadEl.setAttribute("data-sm-msg", text);
      leadEl.textContent = L(text);
    }

    function jobsForLane(machine, q) {
      const jobs = machine.jobs || [];
      if (!q) return { jobs: jobs, filtered: false };
      const matched = jobs.filter(function (job) {
        const hay = [job.process_sheet_no, job.job_no, job.operation_name, job.source_op_no]
          .join(" ")
          .toLowerCase();
        return hay.indexOf(q) >= 0;
      });
      if (matched.length && matched.length !== jobs.length) return { jobs: matched, filtered: true };
      return { jobs: jobs, filtered: false };
    }

    function renderPicker() {
      const q = searchQuery();
      const visible = machines.filter(function (machine) {
        return matchesSearch(machine, q);
      });
      if (!machines.length) {
        picker.innerHTML =
          '<div class="sm-jobs-empty"><p class="sm-muted">' + escapeHtml(L("No machines on the queue for this shift.")) + "</p></div>";
        return;
      }
      if (!visible.length) {
        picker.innerHTML =
          '<div class="sm-jobs-empty"><p class="sm-muted">' + escapeHtml(L("No machines match that search.")) + "</p></div>";
        return;
      }
      const groupsHtml = groupMachines(visible)
        .map(function (group) {
          const chips = group.machines
            .map(function (machine) {
              const count = (machine.jobs || []).length;
              const idle = !count;
              return (
                '<button type="button" class="sm-jobs-machine' +
                (idle ? " is-idle" : "") +
                '" data-pick-machine="' +
                escapeHtml(machine.machine_id) +
                '">' +
                "<span>" +
                escapeHtml(machine.machine_no) +
                "</span>" +
                '<span class="sm-jobs-count">' +
                (idle ? "0" : escapeHtml(count)) +
                "</span></button>"
              );
            })
            .join("");
          return (
            '<div class="sm-jobs-group">' +
            '<span class="sm-jobs-group-label">' +
            escapeHtml(L(group.cat)) +
            "</span>" +
            '<div class="sm-jobs-chips">' +
            chips +
            "</div></div>"
          );
        })
        .join("");
      picker.innerHTML =
        '<div class="sm-jobs-picker-card">' +
        '<p class="sm-jobs-prompt">' + escapeHtml(L("Choose a machine")) + "</p>" +
        '<div class="sm-jobs-groups">' +
        groupsHtml +
        "</div></div>";
    }

    function renderLane() {
      const machine = machineById(selectedMachineId);
      if (!machine) {
        list.hidden = true;
        list.innerHTML = "";
        return;
      }
      const q = searchQuery();
      const packed = jobsForLane(machine, q);
      const jobs = packed.jobs;
      if (selectedBlockId) {
        const still = jobs.some(function (job) {
          return String(job.block_id) === String(selectedBlockId);
        });
        if (!still) selectedBlockId = null;
      }
      const extra = Math.max(0, jobs.length - 1);
      const hint = packed.filtered
        ? window.smN ? smN(jobs.length, "match_one", "match_many") : String(jobs.length)
        : jobs.length
          ? extra
            ? t("now_plus", { n: extra })
            : L("Now")
          : L("Empty queue");
      const cards = jobs
        .map(function (job, idx) {
          const seq = seqMeta(job, idx);
          const selected = String(job.block_id) === String(selectedBlockId);
          const status = job.execution_status || job.block_status || "";
          const jTickets = Number(job.open_ticket_count || 0);
          return (
            '<button type="button" class="sm-focus-card ' +
            seq.cls +
            (selected ? " is-selected" : "") +
            '" data-block="' +
            escapeHtml(job.block_id) +
            '">' +
            '<div class="sm-focus-card-top">' +
            '<span class="sm-focus-seq ' +
            seq.cls +
            '">' +
            seq.text +
            "</span>" +
            (jTickets
              ? '<span class="sm-focus-tickets">' +
                escapeHtml(t("open_n", { n: jTickets })) +
                "</span>"
              : "") +
            "</div>" +
            '<div class="sm-focus-ps">' +
            escapeHtml(job.process_sheet_no || job.job_no || "-") +
            "</div>" +
            '<div class="sm-focus-op">' +
            escapeHtml(job.operation_name || L("Operation")) +
            "</div>" +
            (job.source_op_no
              ? '<div class="sm-focus-opno">' + escapeHtml(t("op_prefix", { n: job.source_op_no })) + "</div>"
              : "") +
            '<div class="sm-focus-metrics">' +
            '<span class="sm-focus-metric"><span class="sm-focus-k">' + escapeHtml(L("Qty")) + "</span><strong>" +
            escapeHtml(job.remaining_qty != null ? job.remaining_qty : "-") +
            "</strong></span>" +
            '<span class="sm-focus-metric"><span class="sm-focus-k">' + escapeHtml(L("Plan")) + "</span><strong>" +
            escapeHtml(job.scheduled_qty != null ? job.scheduled_qty : "-") +
            "</strong></span>" +
            (status ? '<span class="sm-focus-status">' + escapeHtml(status) + "</span>" : "") +
            "</div></button>"
          );
        })
        .join("");
      const raiseBtn = can("can_create_ticket")
        ? '<button type="button" class="sm-btn sm-btn-primary" data-jobs-raise' +
          (selectedBlockId ? "" : " disabled") +
          ">" + escapeHtml(L("Raise ticket")) + "</button>"
        : "";
      const more =
        !packed.filtered && machine.queue_count > (machine.jobs || []).length
          ? '<p class="sm-muted sm-jobs-more">' +
            escapeHtml(t("more_on_queue", { n: machine.queue_count - (machine.jobs || []).length })) +
            "</p>"
          : "";
      list.hidden = false;
      list.innerHTML =
        '<section class="sm-jobs-lane-panel' +
        (popLane ? " is-pop" : "") +
        '">' +
        '<header class="sm-jobs-lane-head">' +
        "<div>" +
        '<p class="sm-jobs-kicker">' + escapeHtml(L("Machine queue")) + "</p>" +
        "<h3>" +
        escapeHtml(machine.machine_no) +
        "</h3>" +
        '<p class="sm-jobs-lane-hint">' +
        escapeHtml(hint) +
        escapeHtml(L("· tap a process sheet")) + "</p>" +
        "</div>" +
        '<div class="sm-jobs-lane-actions">' +
        '<button type="button" class="sm-btn sm-btn-ghost" data-jobs-change>' + escapeHtml(L("Machines")) + "</button>" +
        raiseBtn +
        "</div></header>" +
        '<div class="sm-jobs-lane-body">' +
        (jobs.length
          ? cards + more
          : '<p class="sm-muted">' + escapeHtml(L("Nothing queued on this machine.")) + "</p>") +
        "</div></section>";
      popLane = false;
    }

    function render() {
      const machine = machineById(selectedMachineId);
      if (!machine) {
        selectedMachineId = null;
        selectedBlockId = null;
        picker.hidden = false;
        list.hidden = true;
        list.innerHTML = "";
        if (searchEl) {
          searchEl.setAttribute("data-sm-ph-src", "Machine or PS no.");
          searchEl.placeholder = L("Machine or PS no.");
        }
        setLead("Choose a machine. Its queue opens so you can pick a process sheet and raise a ticket.");
        renderPicker();
        return;
      }
      picker.hidden = true;
      if (searchEl) searchEl.placeholder = t("ps_on", { machine: machine.machine_no || L("Machine") });
      setLead("Select a process sheet, then raise a ticket.");
      renderLane();
    }

    function openRaise() {
      const machine = machineById(selectedMachineId);
      const job = ((machine && machine.jobs) || []).filter(function (item) {
        return String(item.block_id) === String(selectedBlockId);
      })[0];
      if (!machine || !job) {
        toast("Select a process sheet");
        return;
      }
      openTicketDialog(machine, job);
    }

    async function load() {
      if (!selectedMachineId) {
        picker.hidden = false;
        list.hidden = true;
        picker.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Loading…")) + "</p>";
      }
      if (dateEl) rememberContext(dateEl.value, shift);
      try {
        const q = new URLSearchParams({
          date: (dateEl && dateEl.value) || rememberedDate(),
          shift: shift,
        });
        const data = await api("/api/shift-management/ops-queue?" + q.toString());
        meta = data.meta || meta;
        shift = normalizeShiftClient(data.shift_out || shift);
        paintShiftChips();
        machines = data.machines || [];
        render();
      } catch (err) {
        selectedMachineId = null;
        selectedBlockId = null;
        picker.hidden = false;
        list.hidden = true;
        picker.innerHTML =
          '<div class="sm-jobs-empty"><p class="sm-muted">' +
          escapeHtml(err.message) +
          '</p><button type="button" class="sm-btn sm-btn-ghost" id="sm-jobs-retry">Retry</button></div>';
        const retry = document.getElementById("sm-jobs-retry");
        if (retry) retry.addEventListener("click", load);
      }
    }

    picker.addEventListener("click", function (e) {
      const btn = e.target.closest("[data-pick-machine]");
      if (!btn) return;
      const machine = machineById(btn.getAttribute("data-pick-machine"));
      const q = searchQuery();
      if (searchEl && machine && q) {
        const jobHit = (machine.jobs || []).some(function (job) {
          return [job.process_sheet_no, job.job_no, job.operation_name, job.source_op_no]
            .join(" ")
            .toLowerCase()
            .indexOf(q) >= 0;
        });
        if (!jobHit) searchEl.value = "";
      }
      selectedMachineId = btn.getAttribute("data-pick-machine");
      selectedBlockId = null;
      popLane = true;
      render();
      if (list && !list.hidden) list.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    list.addEventListener("click", function (e) {
      if (e.target.closest("[data-jobs-change]")) {
        selectedMachineId = null;
        selectedBlockId = null;
        if (searchEl) searchEl.value = "";
        render();
        return;
      }
      if (e.target.closest("[data-jobs-raise]")) {
        openRaise();
        return;
      }
      const card = e.target.closest("[data-block]");
      if (!card) return;
      const id = card.getAttribute("data-block");
      selectedBlockId = String(selectedBlockId) === String(id) ? null : id;
      renderLane();
    });

    const refresh = document.getElementById("sm-jobs-refresh");
    if (refresh) refresh.addEventListener("click", load);
    document.querySelectorAll("#sm-ops-shift-chips .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        shift = btn.dataset.shift;
        paintShiftChips();
        load();
      });
    });
    if (dateEl) dateEl.addEventListener("change", load);
    if (searchEl) searchEl.addEventListener("input", render);
    const cancel = document.getElementById("sm-tk-cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        if (dialog) dialog.close();
      });
    }
    if (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        const status = document.getElementById("sm-tk-status");
        try {
          status.hidden = false;
          status.textContent = L("Creating…");
          await api("/api/shift-management/tickets", {
            method: "POST",
            body: JSON.stringify({
              machine_id: Number(document.getElementById("sm-tk-machine-id").value),
              block_id: document.getElementById("sm-tk-block-id").value || null,
              planner_ps_id: document.getElementById("sm-tk-ps").value,
              job_no: document.getElementById("sm-tk-job").value,
              category: document.getElementById("sm-tk-category").value,
              priority: document.getElementById("sm-tk-priority").value,
              title: document.getElementById("sm-tk-title").value,
              description: document.getElementById("sm-tk-desc").value,
              work_date: (dateEl && dateEl.value) || rememberedDate(),
              shift_out: shift,
            }),
          });
          toast(L("Ticket created"));
          if (dialog) dialog.close();
          load();
        } catch (err) {
          status.hidden = false;
          status.textContent = err.message;
        }
      });
    }
    paintShiftChips();
    load();
    SM.refresh = function () {
      render();
    };
  }

  async function initTickets() {
    const list = document.getElementById("sm-tickets-list");
    if (!list) return;
    const statusEl = document.getElementById("sm-tickets-status");
    const dateEl = document.getElementById("sm-tickets-date");
    const dialog = document.getElementById("sm-ticket-dialog");
    const form = document.getElementById("sm-ticket-form");
    let meta = null;
    let queueMachines = [];
    if (dateEl) dateEl.value = rememberedDate();

    function applyMachineSelect() {
      const sel = document.getElementById("sm-tk-machine-select");
      if (!sel) return;
      const options = [];
      queueMachines.forEach(function (m) {
        const jobs = m.jobs || [];
        if (!jobs.length) {
          options.push({
            label: m.machine_no + t("idle_suffix"),
            machine_id: m.machine_id,
            block_id: "",
            ps: "",
            job: "",
          });
          return;
        }
        jobs.forEach(function (job) {
          options.push({
            label: t("ps_job", { machine: m.machine_no, ps: job.process_sheet_no || job.job_no || "-" }),
            machine_id: m.machine_id,
            block_id: job.block_id || "",
            ps: job.process_sheet_no || job.source_ps_id || "",
            job: job.job_no || job.process_sheet_no || "",
          });
        });
      });
      sel.innerHTML = options
        .map(function (o, i) {
          return (
            '<option value="' +
            i +
            '" data-machine="' +
            o.machine_id +
            '" data-block="' +
            escapeHtml(o.block_id) +
            '" data-ps="' +
            escapeHtml(o.ps) +
            '" data-job="' +
            escapeHtml(o.job) +
            '">' +
            escapeHtml(o.label) +
            "</option>"
          );
        })
        .join("");
      sel._opts = options;
    }

    function syncTicketHidden() {
      const sel = document.getElementById("sm-tk-machine-select");
      if (!sel) return;
      const opt = (sel._opts || [])[Number(sel.value)] || {};
      document.getElementById("sm-tk-machine-id").value = opt.machine_id || "";
      document.getElementById("sm-tk-block-id").value = opt.block_id || "";
      document.getElementById("sm-tk-ps").value = opt.ps || "";
      document.getElementById("sm-tk-job").value = opt.job || "";
    }

    async function loadQueue() {
      try {
        const q = new URLSearchParams({
          date: (dateEl && dateEl.value) || rememberedDate(),
          shift: rememberedShift(),
        });
        const data = await api("/api/shift-management/ops-queue?" + q.toString());
        meta = data.meta || meta;
        queueMachines = data.machines || [];
        applyMachineSelect();
        syncTicketHidden();
      } catch (_) {
        queueMachines = [];
      }
    }

    async function load() {
      list.innerHTML = '<p class="sm-muted">' + escapeHtml(L("Loading…")) + "</p>";
      try {
        const q = new URLSearchParams();
        if (statusEl && statusEl.value) q.set("status", statusEl.value);
        if (dateEl && dateEl.value) q.set("date", dateEl.value);
        const data = await api("/api/shift-management/tickets?" + q.toString());
        meta = data.meta || meta;
        const items = data.items || [];
        if (!items.length) {
          list.innerHTML = '<p class="sm-muted">' + escapeHtml(L("No tickets.")) + "</p>";
          return;
        }
        const sortEl = document.getElementById("sm-tickets-sort");
        const ordered = sortTickets(items, (sortEl && sortEl.value) || "priority");
        list.innerHTML = ordered.map(ticketCardHtml).join("");
        bindTicketStatus(list, load);
      } catch (err) {
        list.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
      }
    }

    const refresh = document.getElementById("sm-tickets-refresh");
    if (refresh) refresh.addEventListener("click", load);
    if (statusEl) statusEl.addEventListener("change", load);
    if (dateEl) dateEl.addEventListener("change", load);
    const sortEl = document.getElementById("sm-tickets-sort");
    if (sortEl) sortEl.addEventListener("change", load);
    const newBtn = document.getElementById("sm-tickets-new");
    if (newBtn) {
      newBtn.addEventListener("click", async function () {
        await loadQueue();
        fillSelect(
          document.getElementById("sm-tk-category"),
          (meta && meta.ticket_categories) || ["Other"],
          (SM.caps && SM.caps.default_ticket_category) || "Other"
        );
        document.getElementById("sm-tk-title").value = "";
        document.getElementById("sm-tk-desc").value = "";
        document.getElementById("sm-tk-status").hidden = true;
        if (dialog && dialog.showModal) dialog.showModal();
      });
    }
    const machineSel = document.getElementById("sm-tk-machine-select");
    if (machineSel) machineSel.addEventListener("change", syncTicketHidden);
    const cancel = document.getElementById("sm-tk-cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        if (dialog) dialog.close();
      });
    }
    if (form) {
      form.addEventListener("submit", async function (e) {
        e.preventDefault();
        syncTicketHidden();
        const status = document.getElementById("sm-tk-status");
        try {
          status.hidden = false;
          status.textContent = L("Creating…");
          await api("/api/shift-management/tickets", {
            method: "POST",
            body: JSON.stringify({
              machine_id: Number(document.getElementById("sm-tk-machine-id").value),
              block_id: document.getElementById("sm-tk-block-id").value || null,
              planner_ps_id: document.getElementById("sm-tk-ps").value,
              job_no: document.getElementById("sm-tk-job").value,
              category: document.getElementById("sm-tk-category").value,
              priority: document.getElementById("sm-tk-priority").value,
              title: document.getElementById("sm-tk-title").value,
              description: document.getElementById("sm-tk-desc").value,
              work_date: (dateEl && dateEl.value) || rememberedDate(),
              shift_out: rememberedShift(),
            }),
          });
          toast(L("Ticket created"));
          if (dialog) dialog.close();
          load();
        } catch (err) {
          status.hidden = false;
          status.textContent = err.message;
        }
      });
    }
    load();
    SM.refresh = function () {
      load();
    };
  }

  function currentPage() {
    return SM.page || (document.body && document.body.getAttribute("data-page")) || "";
  }

  function boot() {
    const page = currentPage();
    if (page === "home") initHome();
    else if (page === "ops") initOps();
    else if (page === "jobs") initJobs();
    else if (page === "tickets") initTickets();
    else if (page === "entry") initEntry();
    else if (page === "ack") initAck();
    else if (page === "dashboard") initDashboard();
    else if (page === "history") initHistory();
    else if (page === "backlog") initHotoBacklog();
  }

  document.addEventListener("sm-locale", function () {
    if (typeof SM.refresh === "function") SM.refresh();
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
