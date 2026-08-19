/* Day/Night HOTO client */
(function () {
  "use strict";

  const SM = (window.SM = window.SM || {});

  function toast(msg) {
    const el = document.getElementById("sm-toast");
    if (!el) {
      alert(msg);
      return;
    }
    el.textContent = msg;
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
    if (!ho) return '<span class="sm-badge">No entry</span>';
    if (ho.status === "pending_ack") return '<span class="sm-badge pending">Pending ack</span>';
    if (ho.status === "acknowledged") return '<span class="sm-badge ack">Acked</span>';
    if (ho.status === "disputed") return '<span class="sm-badge urgent">Disputed</span>';
    if (ho.priority === "Urgent") return '<span class="sm-badge urgent">Urgent</span>';
    return '<span class="sm-badge">Draft</span>';
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
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
          escapeHtml(pair[0]) +
          "</span>"
        );
      })
      .join("");
  }

  function machineNoFromLabel(label) {
    return "CNC " + String(label || "").trim();
  }

  function cachedFloorLayout() {
    if (SM.floorLayout && (SM.floorLayout.machines || []).length) return SM.floorLayout;
    try {
      const raw = sessionStorage.getItem("sm_floor_layout");
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.machines || []).length) return parsed;
      }
    } catch (_) {}
    return null;
  }

  function rememberFloorLayout(layout) {
    if (!layout || !(layout.machines || []).length) return;
    SM.floorLayout = layout;
    try {
      sessionStorage.setItem("sm_floor_layout", JSON.stringify(layout));
    } catch (_) {}
  }

  function renderFloorSvg(layout) {
    const colors = (layout && layout.colors) || {};
    const tiles = (layout && layout.machines) || [];
    const height = Number((layout && layout.height) || 10);
    const viewW = Number((layout && layout.width) || 10);

    const shapes = tiles
      .map(function (tile) {
        const machineNo = machineNoFromLabel(tile.label);
        const fill = colors[tile.color] || "#94a3b8";
        const x = Number(tile.x);
        const y = Number(tile.y);
        const w = Number(tile.w);
        const h = Number(tile.h);
        const geo = {
          x: x,
          y: height - y - h,
          w: w,
          h: h,
          cx: x + w / 2,
          cy: height - y - h / 2,
        };
        const rot = Number(tile.rotation) || 0;
        const svgRot = rot ? -rot : 0;
        const labelTransform = svgRot
          ? ' transform="rotate(' + svgRot + " " + geo.cx + " " + geo.cy + ')"'
          : "";
        return (
          '<g class="sm-floor-tile is-pending" role="button" tabindex="-1" data-machine-no="' +
          escapeHtml(machineNo) +
          '">' +
          "<title>" +
          escapeHtml(machineNo) +
          (tile.subtitle ? " | " + escapeHtml(tile.subtitle) : "") +
          "</title>" +
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
          '<circle class="sm-floor-status sm-floor-status--none" cx="' +
          (geo.x + geo.w - 0.18) +
          '" cy="' +
          (geo.y + 0.18) +
          '" r="0.12"></circle>' +
          "</g>"
        );
      })
      .join("");

    return (
      '<svg class="sm-floor-svg" viewBox="0 0 ' +
      viewW +
      " " +
      height +
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Factory floor plan">' +
      shapes +
      "</svg>"
    );
  }

  function paintFloor(layout) {
    const grid = document.getElementById("sm-machine-grid");
    if (!grid || !layout || !(layout.machines || []).length) return false;
    if (!grid.querySelector(".sm-floor-svg")) {
      renderFloorLegend(layout.colors || {});
      grid.innerHTML = renderFloorSvg(layout);
    }
    return true;
  }

  function applyFloorLive(machines, selectedId) {
    const grid = document.getElementById("sm-machine-grid");
    if (!grid) return;
    const byNo = {};
    (machines || []).forEach(function (m) {
      byNo[String(m.machine_no || "").toUpperCase()] = m;
    });
    grid.querySelectorAll(".sm-floor-tile").forEach(function (tile) {
      const no = String(tile.getAttribute("data-machine-no") || "").toUpperCase();
      const live = byNo[no];
      const ho = live && live.handover;
      const statusKey = handoverStatusKey(ho);
      const clickable = !!(live && live.machine_id);
      const selected = !!(clickable && selectedId && Number(live.machine_id) === Number(selectedId));
      tile.classList.remove("is-pending");
      tile.classList.toggle("is-disabled", !clickable);
      tile.classList.toggle("is-selected", selected);
      tile.setAttribute("data-status", statusKey);
      if (clickable) {
        tile.dataset.machineId = String(live.machine_id);
        tile.setAttribute("tabindex", "0");
      } else {
        delete tile.dataset.machineId;
        tile.setAttribute("tabindex", "-1");
      }
      const titleEl = tile.querySelector("title");
      const titleBits = [
        tile.getAttribute("data-machine-no"),
        live ? (ho ? String(ho.status || "draft") : "No entry") : "Unavailable",
        live && live.active_process_sheet ? "PS " + live.active_process_sheet : "",
      ]
        .filter(Boolean)
        .join(" | ");
      if (titleEl) titleEl.textContent = titleBits;
      const circle = tile.querySelector(".sm-floor-status");
      if (circle) circle.setAttribute("class", "sm-floor-status sm-floor-status--" + statusKey);
    });
  }

  function handoverHref(machine, job) {
    const ps = job
      ? encodeURIComponent(job.process_sheet_no || job.job_no || "")
      : encodeURIComponent(machine.active_process_sheet || machine.active_job_no || "");
    return SM.appPath + "/entry/" + machine.machine_id + (ps ? "?ps=" + ps : "");
  }

  function jobLine(machine, job) {
    if (!job) {
      return machine.active_process_sheet
        ? "PS " +
            escapeHtml(machine.active_process_sheet) +
            (machine.queue_remaining_qty != null ? " · qty " + escapeHtml(machine.queue_remaining_qty) : "")
        : "No active queue job";
    }
    return (
      "Q" +
      escapeHtml(job.queue_position) +
      " · PS " +
      escapeHtml(job.process_sheet_no || job.job_no || "-") +
      (job.remaining_qty != null ? " · qty " + escapeHtml(job.remaining_qty) : "")
    );
  }

  function queueCardHtml(machine, job, idx, jIdx, summary) {
    const ho = machine.handover;
    const tickets = Number(
      summary || !job ? machine.open_ticket_count || 0 : job.open_ticket_count || 0
    );
    return (
      '<article class="sm-machine-card" data-machine="' +
      idx +
      '" data-job="' +
      (jIdx == null ? "" : jIdx) +
      '">' +
      '<div class="sm-machine-card-top">' +
      "<strong>" +
      escapeHtml(machine.machine_no) +
      "</strong>" +
      badgeForHandover(ho) +
      "</div>" +
      '<div class="sm-muted">' +
      jobLine(machine, job) +
      "</div>" +
      (tickets
        ? '<span class="sm-badge urgent">' + tickets + " ticket" + (tickets === 1 ? "" : "s") + "</span>"
        : "") +
      '<div class="sm-card-actions">' +
      '<button type="button" class="sm-btn sm-btn-ghost sm-home-ticket">Ticket</button>' +
      '<a class="sm-btn sm-btn-primary" href="' +
      escapeHtml(handoverHref(machine, job)) +
      '">Handover</a>' +
      "</div></article>"
    );
  }

  function defaultTicketTitle(category, ps) {
    const cat = category || "Other";
    const sheet = String(ps || "").trim();
    return sheet ? cat + " · PS " + sheet : cat;
  }

  function bindTicketDialog(onCreated, getContext) {
    const dialog = document.getElementById("sm-ticket-dialog");
    const form = document.getElementById("sm-ticket-form");
    if (!form) return { open: function () {} };
    const titleEl = document.getElementById("sm-tk-title");
    const catEl = document.getElementById("sm-tk-category");
    const psSearch = document.getElementById("sm-tk-ps-search");
    const psHint = document.getElementById("sm-tk-ps-hint");
    let titleTouched = false;
    let current = null;
    let metaRef = null;

    function applyTicketSheet(item) {
      if (!current) current = {};
      const ps = (item && (item.process_sheet_no || item.planner_ps_id || item.job_no)) || "";
      const job = (item && (item.job_no || item.planner_ps_id || item.process_sheet_no)) || ps;
      current.process_sheet_no = ps;
      current.job_no = job;
      if (item && item.block_id) current.block_id = item.block_id;
      if (item && item.part_no) current.part_no = item.part_no;
      document.getElementById("sm-tk-ps").value = ps;
      document.getElementById("sm-tk-job").value = job;
      if (item && item.block_id) {
        document.getElementById("sm-tk-block-id").value = item.block_id;
      }
      if (psSearch) psSearch.value = ps;
      const ctxEl = document.getElementById("sm-ticket-context");
      if (ctxEl) {
        const extra = item && item.part_no ? " · " + item.part_no : "";
        ctxEl.textContent = (current.machine_no || "") + " · PS " + (ps || "-") + extra;
      }
      syncTitle();
    }

    function syncTitle() {
      if (titleTouched || !titleEl) return;
      titleEl.value = defaultTicketTitle(
        catEl && catEl.value,
        current && (current.process_sheet_no || current.job_no)
      );
    }

    if (titleEl) {
      titleEl.addEventListener("input", function () {
        titleTouched = !!titleEl.value.trim();
      });
    }
    if (catEl) catEl.addEventListener("change", syncTitle);

    bindProcessSheetSearch({
      input: psSearch,
      resultsEl: document.getElementById("sm-tk-ps-results"),
      statusEl: psHint,
      emptyHint: "Search to attach a process sheet, or keep the queue job.",
      getMachineId: function () {
        return (current && current.machine_id) || document.getElementById("sm-tk-machine-id").value;
      },
      onPick: applyTicketSheet,
    });

    const cancel = document.getElementById("sm-tk-cancel");
    if (cancel) {
      cancel.addEventListener("click", function () {
        if (dialog) dialog.close();
      });
    }

    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const ctx = (getContext && getContext()) || {};
      const status = document.getElementById("sm-tk-status");
      const typed = ((psSearch && psSearch.value) || "").trim();
      if (typed && typed !== document.getElementById("sm-tk-ps").value) {
        applyTicketSheet({ process_sheet_no: typed, job_no: typed });
      }
      const ps = document.getElementById("sm-tk-ps").value;
      const category = catEl.value;
      const title = ((titleEl && titleEl.value) || "").trim() || defaultTicketTitle(category, ps);
      try {
        if (status) {
          status.hidden = false;
          status.textContent = "Creating…";
        }
        await api("/api/shift-management/tickets", {
          method: "POST",
          body: JSON.stringify({
            machine_id: Number(document.getElementById("sm-tk-machine-id").value),
            block_id: document.getElementById("sm-tk-block-id").value || null,
            planner_ps_id: ps,
            job_no: document.getElementById("sm-tk-job").value,
            category: category,
            priority: document.getElementById("sm-tk-priority").value,
            title: title,
            description: document.getElementById("sm-tk-desc").value,
            work_date: ctx.date,
            shift_out: ctx.shift,
          }),
        });
        toast("Ticket created");
        if (dialog) dialog.close();
        if (onCreated) onCreated();
      } catch (err) {
        if (status) {
          status.hidden = false;
          status.textContent = err.message;
        } else {
          toast(err.message);
        }
      }
    });

    return {
      open: function (machine, job, meta) {
        current = Object.assign(
          { machine_id: machine.machine_id, machine_no: machine.machine_no },
          job || {}
        );
        metaRef = meta || metaRef;
        document.getElementById("sm-tk-machine-id").value = current.machine_id;
        document.getElementById("sm-tk-block-id").value = current.block_id || "";
        applyTicketSheet({
          process_sheet_no: current.process_sheet_no || current.source_ps_id || "",
          job_no: current.job_no || current.process_sheet_no || "",
          block_id: current.block_id,
          part_no: current.part_no,
        });
        fillSelect(catEl, (metaRef && metaRef.ticket_categories) || ["Other"], "Other");
        titleTouched = false;
        syncTitle();
        document.getElementById("sm-tk-desc").value = "";
        const status = document.getElementById("sm-tk-status");
        if (status) status.hidden = true;
        if (dialog && dialog.showModal) dialog.showModal();
      },
    };
  }

  async function initHome() {
    const dateEl = document.getElementById("sm-date");
    const grid = document.getElementById("sm-machine-grid");
    const banner = document.getElementById("sm-pending-banner");
    const cardsEl = document.getElementById("sm-machine-cards");
    const heading = document.getElementById("sm-queue-heading");
    const allBtn = document.getElementById("sm-queue-all");
    if (!dateEl || !grid) return;

    dateEl.value = rememberedDate();
    let shift = rememberedShift();
    let machines = [];
    let meta = null;
    let selectedId = null;
    let showIdle = false;

    paintFloor(cachedFloorLayout());

    const tickets = bindTicketDialog(function () {
      load();
    }, function () {
      return { date: dateEl.value, shift: shift };
    });

    function paintShiftChips() {
      document.querySelectorAll("#sm-shift-chips .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.dataset.shift === shift);
      });
    }

    function selectedMachine() {
      if (!selectedId) return null;
      for (let i = 0; i < machines.length; i++) {
        if (Number(machines[i].machine_id) === Number(selectedId)) return machines[i];
      }
      return null;
    }

    function renderQueue() {
      if (!cardsEl) return;
      const picked = selectedMachine();
      if (allBtn) allBtn.hidden = !picked;
      if (heading) {
        heading.textContent = picked ? "Queue · " + picked.machine_no : "Ticket queue";
      }
      if (!machines.length) {
        cardsEl.innerHTML = '<p class="sm-muted">No active machines found.</p>';
        return;
      }

      if (picked) {
        const jobs = picked.jobs || [];
        cardsEl.innerHTML = jobs.length
          ? jobs
              .map(function (job, jIdx) {
                return queueCardHtml(picked, job, machines.indexOf(picked), jIdx);
              })
              .join("") +
            (picked.queue_count > jobs.length
              ? '<p class="sm-muted sm-ops-more">+' +
                (picked.queue_count - jobs.length) +
                " more on queue</p>"
              : "")
          : queueCardHtml(picked, null, machines.indexOf(picked), null);
      } else {
        const busy = [];
        const idle = [];
        machines.forEach(function (m, idx) {
          if ((m.jobs || []).length || m.open_ticket_count) busy.push({ m: m, idx: idx });
          else idle.push({ m: m, idx: idx });
        });
        let html = busy
          .map(function (row) {
            return queueCardHtml(row.m, (row.m.jobs || [])[0], row.idx, 0, true);
          })
          .join("");
        if (idle.length) {
          html +=
            '<button type="button" class="sm-btn sm-btn-ghost sm-btn-block" id="sm-home-idle-toggle">' +
            (showIdle ? "Hide idle machines" : "Show " + idle.length + " idle machine" + (idle.length === 1 ? "" : "s")) +
            "</button>";
          if (showIdle) {
            html += idle
              .map(function (row) {
                return queueCardHtml(row.m, null, row.idx, null);
              })
              .join("");
          }
        }
        cardsEl.innerHTML = html || '<p class="sm-muted">No queued jobs on your machines.</p>';
      }

      const idleToggle = document.getElementById("sm-home-idle-toggle");
      if (idleToggle) {
        idleToggle.addEventListener("click", function () {
          showIdle = !showIdle;
          renderQueue();
        });
      }
      cardsEl.querySelectorAll(".sm-home-ticket").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const card = btn.closest(".sm-machine-card");
          const machine = machines[Number(card.dataset.machine)];
          const jIdx = card.dataset.job === "" ? null : Number(card.dataset.job);
          const job = jIdx == null ? (machine.jobs || [])[0] : machine.jobs[jIdx];
          tickets.open(machine, job, meta);
        });
      });
    }

    function selectMachine(machineId) {
      const id = machineId ? Number(machineId) : null;
      selectedId = selectedId && id === Number(selectedId) ? null : id;
      applyFloorLive(machines, selectedId);
      renderQueue();
      if (selectedId && cardsEl) cardsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    async function load() {
      rememberContext(dateEl.value, shift);
      grid.classList.add("is-loading");
      if (!grid.querySelector(".sm-floor-svg")) {
        grid.innerHTML = '<p class="sm-muted">Loading...</p>';
      }
      try {
        const q = new URLSearchParams({ date: dateEl.value, shift: shift });
        const data = await api("/api/shift-management/machines?" + q.toString());
        shift = normalizeShiftClient(data.shift_out || shift);
        paintShiftChips();
        rememberContext(dateEl.value, shift);
        meta = data.meta || meta;
        machines = data.machines || [];
        const layout = data.floor_layout || cachedFloorLayout();
        rememberFloorLayout(layout);
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
                  escapeHtml(p.shift_out) +
                  "</span>" +
                  '<span class="sm-badge pending">' +
                  escapeHtml(p.priority || "Pending") +
                  "</span></a>"
                );
              })
              .join("");
            banner.innerHTML =
              count +
              " handover" +
              (count === 1 ? "" : "s") +
              " waiting for acknowledgement." +
              '<div class="sm-list" style="margin-top:10px">' +
              pendingHtml +
              "</div>";
          } else {
            banner.hidden = true;
            banner.innerHTML = "";
          }
        }
        if (!layout || !(layout.machines || []).length) {
          grid.innerHTML = '<p class="sm-muted">Floor layout unavailable.</p>';
          return;
        }
        paintFloor(layout);
        if (selectedId && !selectedMachine()) selectedId = null;
        applyFloorLive(machines, selectedId);
        renderQueue();
      } catch (err) {
        if (!grid.querySelector(".sm-floor-svg")) {
          grid.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
        } else {
          toast(err.message);
        }
      } finally {
        grid.classList.remove("is-loading");
      }
    }

    grid.addEventListener("click", function (e) {
      const tile = e.target.closest && e.target.closest(".sm-floor-tile");
      if (!tile || tile.classList.contains("is-disabled") || tile.classList.contains("is-pending")) return;
      if (!tile.dataset.machineId) return;
      selectMachine(tile.dataset.machineId);
    });
    grid.addEventListener("keydown", function (e) {
      if (e.key !== "Enter" && e.key !== " ") return;
      const tile = e.target.closest && e.target.closest(".sm-floor-tile");
      if (!tile || !tile.dataset.machineId) return;
      e.preventDefault();
      selectMachine(tile.dataset.machineId);
    });
    if (allBtn) {
      allBtn.addEventListener("click", function () {
        selectMachine(null);
      });
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
  }

  function chipGroup(container, options, value, onPick) {
    container.innerHTML = "";
    options.forEach(function (opt) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "sm-chip" + (opt === value ? " is-active" : "");
      btn.textContent = opt;
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
          escapeHtml(opt) +
          "</option>"
        );
      })
      .join("");
  }

  function bindProcessSheetSearch(opts) {
    const input = opts.input;
    const resultsEl = opts.resultsEl;
    const statusEl = opts.statusEl;
    const getMachineId = opts.getMachineId || function () {
      return "";
    };
    const onPick = opts.onPick;
    const emptyHint = opts.emptyHint || "Search process sheets to auto-fill.";
    let timer = null;
    let seq = 0;
    let hits = [];
    let index = -1;

    function close() {
      if (resultsEl) {
        resultsEl.hidden = true;
        resultsEl.innerHTML = "";
      }
      hits = [];
      index = -1;
    }

    function paintActive() {
      if (!resultsEl) return;
      resultsEl.querySelectorAll(".sm-ps-hit").forEach(function (el, i) {
        el.classList.toggle("is-active", i === index);
      });
    }

    function render(items, message) {
      hits = items || [];
      index = hits.length ? 0 : -1;
      if (!resultsEl) return;
      if (!hits.length) {
        resultsEl.innerHTML =
          '<div class="sm-ps-empty">' +
          escapeHtml(message || "No process sheets matched.") +
          "</div>";
        resultsEl.hidden = false;
        return;
      }
      resultsEl.innerHTML = hits
        .map(function (item, i) {
          const bits = [item.part_no, item.description].filter(Boolean).join(" · ");
          const qty = item.remaining_qty != null ? "qty " + item.remaining_qty : "";
          const queue = item.on_queue ? "on queue" : "";
          return (
            '<button type="button" class="sm-ps-hit' +
            (i === 0 ? " is-active" : "") +
            '" data-index="' +
            i +
            '" role="option">' +
            "<strong>" +
            escapeHtml(item.display_ps_id || item.process_sheet_no || item.job_no) +
            "</strong>" +
            (bits ? "<span>" + escapeHtml(bits) + "</span>" : "") +
            "<small>" +
            escapeHtml([qty, queue, item.operation_name].filter(Boolean).join(" · ")) +
            "</small></button>"
          );
        })
        .join("");
      resultsEl.hidden = false;
    }

    function pick(item) {
      close();
      if (!item) return;
      if (input) input.value = item.process_sheet_no || item.planner_ps_id || item.job_no || "";
      if (onPick) onPick(item);
    }

    async function search(query) {
      const my = ++seq;
      if (statusEl) statusEl.textContent = "Searching…";
      try {
        const mid = getMachineId();
        let path =
          "/api/shift-management/process-sheets/search?q=" +
          encodeURIComponent(query) +
          "&limit=20";
        if (mid) path += "&machine_id=" + encodeURIComponent(mid);
        const data = await api(path);
        if (my !== seq) return;
        const items = data.items || [];
        render(items);
        if (statusEl) {
          statusEl.textContent = items.length
            ? items.length +
              " match" +
              (items.length === 1 ? "" : "es") +
              " — tap one to fill."
            : "No process sheets matched.";
        }
      } catch (err) {
        if (my !== seq) return;
        render([], err.message);
        if (statusEl) statusEl.textContent = err.message;
      }
    }

    function queueSearch() {
      clearTimeout(timer);
      const q = ((input && input.value) || "").trim();
      if (q.length < 2) {
        close();
        if (statusEl) {
          statusEl.textContent = q ? "Type at least 2 characters to search." : emptyHint;
        }
        return;
      }
      timer = setTimeout(function () {
        search(q);
      }, 220);
    }

    if (input) {
      input.addEventListener("input", queueSearch);
      input.addEventListener("keydown", function (e) {
        if (!resultsEl || resultsEl.hidden) return;
        if (e.key === "ArrowDown") {
          e.preventDefault();
          index = Math.min(index + 1, hits.length - 1);
          paintActive();
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          index = Math.max(index - 1, 0);
          paintActive();
        } else if (e.key === "Enter" && index >= 0 && hits[index]) {
          e.preventDefault();
          pick(hits[index]);
        } else if (e.key === "Escape") {
          close();
        }
      });
      input.addEventListener("blur", function () {
        setTimeout(close, 180);
      });
    }
    if (resultsEl) {
      resultsEl.addEventListener("mousedown", function (e) {
        e.preventDefault();
        const btn = e.target.closest(".sm-ps-hit");
        if (!btn) return;
        pick(hits[Number(btn.dataset.index)]);
      });
    }
    return { close: close, pick: pick };
  }

  async function initOps() {
    const list = document.getElementById("sm-ops-list");
    if (!list) return;
    const dateEl = document.getElementById("sm-ops-date");
    const searchEl = document.getElementById("sm-ops-search");
    let meta = null;
    let machines = [];
    let shift = rememberedShift();

    if (dateEl) dateEl.value = rememberedDate();

    const tickets = bindTicketDialog(function () {
      load(true);
    }, function () {
      return { date: (dateEl && dateEl.value) || rememberedDate(), shift: shift };
    });

    function paintShiftChips() {
      document.querySelectorAll("#sm-ops-shift-chips .sm-chip").forEach(function (btn) {
        btn.classList.toggle("is-active", btn.dataset.shift === shift);
      });
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

    function render() {
      const q = ((searchEl && searchEl.value) || "").trim().toLowerCase();
      const shown = machines.filter(function (m) {
        return matchesSearch(m, q);
      });
      if (!shown.length) {
        list.innerHTML =
          '<div class="sm-ops-empty"><p class="sm-muted">' +
          (machines.length
            ? "No machines match that search."
            : "No machines assigned. Ask a planner to map machines to your login.") +
          "</p></div>";
        return;
      }

      function cardHtml(m, idx) {
          const jobs = m.jobs || [];
          const head = jobs[0];
          const tickets = Number(m.open_ticket_count || 0);
          const ho = m.handover;
          const ps = head ? encodeURIComponent(head.process_sheet_no || head.job_no || "") : "";
          const jobHtml = jobs
            .map(function (job, jIdx) {
              const jTickets = Number(job.open_ticket_count || 0);
              return (
                '<div class="sm-ops-job" data-machine="' +
                idx +
                '" data-job="' +
                jIdx +
                '">' +
                '<div class="sm-ops-job-row">' +
                "<div>" +
                '<div class="sm-ops-ps">Q' +
                escapeHtml(job.queue_position) +
                " · PS " +
                escapeHtml(job.process_sheet_no || job.job_no || "-") +
                "</div>" +
                '<div class="sm-muted">' +
                escapeHtml(job.operation_name || "Operation") +
                (job.source_op_no ? " · Op " + escapeHtml(job.source_op_no) : "") +
                "</div>" +
                '<div class="sm-muted">Remaining ' +
                escapeHtml(job.remaining_qty != null ? job.remaining_qty : "-") +
                " / planned " +
                escapeHtml(job.scheduled_qty != null ? job.scheduled_qty : "-") +
                (job.execution_status || job.block_status
                  ? " · " + escapeHtml(job.execution_status || job.block_status)
                  : "") +
                "</div>" +
                (jTickets
                  ? '<span class="sm-badge urgent">' + jTickets + " ticket" + (jTickets === 1 ? "" : "s") + "</span>"
                  : "") +
                "</div>" +
                '<button type="button" class="sm-btn sm-btn-ghost sm-ops-ticket">Ticket</button>' +
                "</div></div>"
              );
            })
            .join("");

          return (
            '<article class="sm-ops-machine' +
            (jobs.length ? "" : " is-idle") +
            '" data-machine="' +
            idx +
            '">' +
            '<div class="sm-ops-machine-head">' +
            '<div class="sm-ops-machine-title">' +
            "<strong>" +
            escapeHtml(m.machine_no) +
            "</strong>" +
            badgeForHandover(ho) +
            (tickets
              ? '<span class="sm-badge urgent">' + tickets + " ticket" + (tickets === 1 ? "" : "s") + "</span>"
              : "") +
            "</div>" +
            '<div class="sm-ops-actions">' +
            '<a class="sm-btn sm-btn-primary" href="' +
            SM.appPath +
            "/entry/" +
            m.machine_id +
            (ps ? "?ps=" + ps : "") +
            '">Handover</a>' +
            "</div></div>" +
            (jobs.length
              ? jobHtml +
                (m.queue_count > jobs.length
                  ? '<p class="sm-muted sm-ops-more">+' +
                    (m.queue_count - jobs.length) +
                    " more on queue</p>"
                  : "")
              : '<p class="sm-muted">No active queue job. Still hand over machine status.</p>') +
            "</article>"
          );
      }

      const busy = [];
      const idle = [];
      shown.forEach(function (m, idx) {
        if ((m.jobs || []).length || m.open_ticket_count) busy.push({ m: m, idx: idx });
        else idle.push({ m: m, idx: idx });
      });
      list.innerHTML =
        busy.map(function (row) { return cardHtml(row.m, row.idx); }).join("") +
        (idle.length
          ? '<button type="button" class="sm-btn sm-btn-ghost sm-btn-block" id="sm-ops-idle-toggle">Show ' +
            idle.length +
            " idle machine" +
            (idle.length === 1 ? "" : "s") +
            "</button>" +
            '<div id="sm-ops-idle" hidden>' +
            idle.map(function (row) { return cardHtml(row.m, row.idx); }).join("") +
            "</div>"
          : "");

      const idleToggle = document.getElementById("sm-ops-idle-toggle");
      const idleBox = document.getElementById("sm-ops-idle");
      if (idleToggle && idleBox) {
        idleToggle.addEventListener("click", function () {
          idleBox.hidden = !idleBox.hidden;
          idleToggle.textContent = idleBox.hidden
            ? "Show " + idle.length + " idle machine" + (idle.length === 1 ? "" : "s")
            : "Hide idle machines";
        });
      }

      list.querySelectorAll(".sm-ops-ticket").forEach(function (btn) {
        btn.addEventListener("click", function () {
          const jobEl = btn.closest(".sm-ops-job");
          const card = btn.closest(".sm-ops-machine");
          const mIdx = Number((jobEl || card).dataset.machine);
          const machine = shown[mIdx];
          const job = jobEl ? machine.jobs[Number(jobEl.dataset.job)] : (machine.jobs || [])[0];
          tickets.open(machine, job, meta);
        });
      });
    }

    async function load(keep) {
      if (!keep) list.innerHTML = '<p class="sm-muted">Loading…</p>';
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
          '</p><button type="button" class="sm-btn sm-btn-ghost" id="sm-ops-retry">Retry</button></div>';
        const retry = document.getElementById("sm-ops-retry");
        if (retry) retry.addEventListener("click", load);
      }
    }

    document.getElementById("sm-ops-refresh").addEventListener("click", function () {
      load(true);
    });
    document.querySelectorAll("#sm-ops-shift-chips .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        shift = btn.dataset.shift;
        paintShiftChips();
        load();
      });
    });
    if (dateEl) dateEl.addEventListener("change", load);
    if (searchEl) searchEl.addEventListener("input", render);

    paintShiftChips();
    load();
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

    function setSave(text) {
      if (saveEl) saveEl.textContent = text;
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
        next.textContent = n === 2 ? "Review" : "Next";
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
        '<option value="">Manual / other</option>' +
        jobs
          .map(function (j) {
            const label =
              (j.process_sheet_no || j.job_no || "Job") +
              " · Q" +
              j.queue_position +
              " · rem " +
              (j.remaining_qty != null ? j.remaining_qty : "-");
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
        el.innerHTML = '<p class="sm-muted">No open tickets for this machine.</p>';
        return;
      }
      el.innerHTML = tickets
        .map(function (t) {
          return (
            '<div class="sm-list-item">' +
            "<span><strong>#" +
            t.ticket_id +
            "</strong> " +
            escapeHtml(t.category) +
            ": " +
            escapeHtml(t.title) +
            '<br><span class="sm-muted">' +
            escapeHtml(t.status) +
            " · " +
            escapeHtml(t.priority) +
            " · PS " +
            escapeHtml(t.process_sheet_no || t.job_no || "-") +
            "</span></span>" +
            '<button type="button" class="sm-btn sm-btn-ghost sm-close-ticket" data-id="' +
            t.ticket_id +
            '">Close</button>' +
            "</div>"
          );
        })
        .join("");
      el.querySelectorAll(".sm-close-ticket").forEach(function (btn) {
        btn.addEventListener("click", async function () {
          try {
            await api("/api/shift-management/tickets/" + btn.dataset.id, {
              method: "PATCH",
              body: JSON.stringify({ status: "closed" }),
            });
            toast("Ticket closed");
            const data = await api("/api/shift-management/handovers/" + handover.handover_id);
            handover = data.handover;
            renderTickets();
          } catch (err) {
            toast(err.message);
          }
        });
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
                escapeHtml(c.display_name || c.username || "User") +
                " · " +
                escapeHtml(c.created_at || "") +
                "</div>" +
                "<div>" +
                escapeHtml(c.body) +
                "</div></div>"
              );
            })
            .join("")
        : '<p class="sm-muted">No comments yet.</p>';
    }

    function renderReview() {
      const el = document.getElementById("sm-review");
      if (!el || !handover) return;
      const issues = [];
      if (handover.quality_issue_flag) issues.push("Quality: " + (handover.quality_issue_text || ""));
      if (handover.alarm_flag) issues.push("Alarm: " + (handover.alarm_text || ""));
      if (handover.maintenance_flag) issues.push("Maint: " + (handover.maintenance_text || ""));
      el.innerHTML =
        "<div><strong>" +
        escapeHtml(handover.machine_no || "") +
        "</strong> | " +
        escapeHtml(handover.work_date) +
        " | " +
        escapeHtml(handover.shift_out) +
        " → " +
        escapeHtml(handover.shift_in || "") +
        "</div>" +
        "<div>Status: <strong>" +
        escapeHtml(handover.machine_status) +
        "</strong> | Job " +
        escapeHtml(handover.job_no || "-") +
        "</div>" +
        "<div>Qty left: " +
        escapeHtml(handover.remaining_qty) +
        " | Tool life: " +
        escapeHtml(handover.tool_life_pct) +
        "%</div>" +
        "<div>Material: " +
        escapeHtml(handover.material_qty == null ? "-" : handover.material_qty) +
        " " +
        escapeHtml(handover.material_unit || "") +
        "</div>" +
        "<div>First piece: " +
        escapeHtml(handover.first_piece_status) +
        " | NCR: " +
        escapeHtml(handover.ncr_status) +
        (handover.ncr_ref ? " (" + escapeHtml(handover.ncr_ref) + ")" : "") +
        "</div>" +
        "<div>Priority: <strong>" +
        escapeHtml(handover.priority) +
        "</strong>" +
        (handover.priority_note ? " - " + escapeHtml(handover.priority_note) : "") +
        "</div>" +
        "<div>" +
        (issues.length ? issues.map(escapeHtml).join("<br>") : "Issues: Nil") +
        "</div>" +
        "<div>Remarks: " +
        escapeHtml(handover.remarks || "-") +
        "</div>" +
        "<div>Open tickets: " +
        ((handover.tickets || []).length || 0) +
        "</div>";
    }

    function syncForm() {
      document.getElementById("sm-entry-machine").textContent =
        (handover.machine_no || "Machine") +
        " · " +
        (handover.shift_out || "") +
        (handover.status !== "draft" ? " | " + handover.status : "");
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
          el.textContent = locked ? "Already handed over" : "Confirm & Hand Over";
          return;
        }
        if (el.id === "sm-comment-add" || el.id === "sm-comment-body") {
          el.disabled = false;
          return;
        }
        if (el.id === "sm-entry-raise-ticket" || el.closest("#sm-entry-ticket-dialog")) {
          el.disabled = false;
          return;
        }
        el.disabled = locked;
      });
    }

    document.querySelectorAll(".sm-issue").forEach(wireIssue);

    function applyProcessSheet(item) {
      if (!item || !handover) return;
      const job = item.job_no || item.planner_ps_id || item.process_sheet_no || "";
      const patch = { job_no: job };
      handover.job_no = job;
      document.getElementById("sm-job-no").value = job;
      if (item.remaining_qty != null && item.remaining_qty !== "") {
        patch.remaining_qty = Math.round(Number(item.remaining_qty));
        handover.remaining_qty = patch.remaining_qty;
        document.getElementById("sm-remaining-qty").value = patch.remaining_qty;
      }
      if (item.tool_life_pct != null && item.tool_life_pct !== "") {
        patch.tool_life_pct = Number(item.tool_life_pct);
        handover.tool_life_pct = patch.tool_life_pct;
        document.getElementById("sm-tool-life").value = patch.tool_life_pct;
      }
      if (item.material_qty != null && item.material_qty !== "") {
        patch.material_qty = Number(item.material_qty);
        handover.material_qty = patch.material_qty;
        document.getElementById("sm-material-qty").value = patch.material_qty;
      }
      if (item.material_unit) {
        patch.material_unit = item.material_unit;
        handover.material_unit = item.material_unit;
      }
      if (item.first_piece_status) {
        patch.first_piece_status = item.first_piece_status;
        handover.first_piece_status = item.first_piece_status;
      }
      renderQueueJobs();
      if (patch.material_unit) {
        chipGroup(
          document.getElementById("sm-material-unit"),
          meta.material_units,
          handover.material_unit || "pcs",
          function (v) {
            schedulePatch({ material_unit: v });
          }
        );
      }
      if (patch.first_piece_status) {
        chipGroup(
          document.getElementById("sm-first-piece"),
          meta.first_piece_statuses,
          handover.first_piece_status,
          function (v) {
            schedulePatch({ first_piece_status: v });
          }
        );
      }
      renderReview();
      schedulePatch(patch);
      const statusEl = document.getElementById("sm-job-search-status");
      if (statusEl) {
        const bits = [];
        if (item.on_queue) bits.push("on this machine queue");
        if (item.remaining_qty != null) bits.push("qty " + item.remaining_qty);
        if (item.part_no) bits.push(item.part_no);
        statusEl.textContent = "Filled " + job + (bits.length ? " · " + bits.join(" · ") : "");
      }
    }

    bindProcessSheetSearch({
      input: document.getElementById("sm-job-no"),
      resultsEl: document.getElementById("sm-job-results"),
      statusEl: document.getElementById("sm-job-search-status"),
      emptyHint: "Search process sheets to auto-fill remaining qty and last-shift values.",
      getMachineId: function () {
        return machineId;
      },
      onPick: applyProcessSheet,
    });

    document.getElementById("sm-queue-job").addEventListener("change", function (e) {
      const opt = e.target.selectedOptions[0];
      const val = e.target.value;
      const rem = opt && opt.dataset.rem !== "" ? Number(opt.dataset.rem) : null;
      const patch = { job_no: val };
      if (rem != null && !Number.isNaN(rem)) patch.remaining_qty = Math.round(rem);
      document.getElementById("sm-job-no").value = val;
      if (patch.remaining_qty != null) {
        document.getElementById("sm-remaining-qty").value = patch.remaining_qty;
        handover.remaining_qty = patch.remaining_qty;
      }
      handover.job_no = val;
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
    const etkCat = document.getElementById("sm-etk-category");
    const etkTitle = document.getElementById("sm-etk-title");
    const etkPsSearch = document.getElementById("sm-etk-ps-search");
    let etkTitleTouched = false;
    let entryTicketPs = "";
    function entryTicketSheet() {
      return ((etkPsSearch && etkPsSearch.value) || entryTicketPs || (handover && handover.job_no) || "").trim();
    }
    function syncEntryTicketTitle() {
      if (etkTitleTouched || !etkTitle) return;
      etkTitle.value = defaultTicketTitle(etkCat && etkCat.value, entryTicketSheet());
    }
    if (etkTitle) {
      etkTitle.addEventListener("input", function () {
        etkTitleTouched = !!etkTitle.value.trim();
      });
    }
    if (etkCat) etkCat.addEventListener("change", syncEntryTicketTitle);
    bindProcessSheetSearch({
      input: etkPsSearch,
      resultsEl: document.getElementById("sm-etk-ps-results"),
      statusEl: document.getElementById("sm-etk-ps-status"),
      emptyHint: "Defaults to the active job. Search to change it.",
      getMachineId: function () {
        return machineId;
      },
      onPick: function (item) {
        entryTicketPs = item.process_sheet_no || item.job_no || "";
        if (etkPsSearch) etkPsSearch.value = entryTicketPs;
        syncEntryTicketTitle();
      },
    });
    document.getElementById("sm-entry-raise-ticket").addEventListener("click", function () {
      fillSelect(etkCat, (meta && meta.ticket_categories) || ["Other"], "Other");
      entryTicketPs = (handover && handover.job_no) || "";
      if (etkPsSearch) etkPsSearch.value = entryTicketPs;
      etkTitleTouched = false;
      syncEntryTicketTitle();
      document.getElementById("sm-etk-desc").value = "";
      if (entryDialog && entryDialog.showModal) entryDialog.showModal();
    });
    document.getElementById("sm-etk-cancel").addEventListener("click", function () {
      if (entryDialog) entryDialog.close();
    });
    document.getElementById("sm-entry-ticket-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      const category = etkCat.value;
      const ps = entryTicketSheet();
      const title =
        ((etkTitle && etkTitle.value) || "").trim() ||
        defaultTicketTitle(category, ps);
      try {
        await api("/api/shift-management/tickets", {
          method: "POST",
          body: JSON.stringify({
            machine_id: machineId,
            planner_ps_id: ps,
            job_no: ps,
            category: category,
            priority: document.getElementById("sm-etk-priority").value,
            title: title,
            description: document.getElementById("sm-etk-desc").value,
            handover_id: handover.handover_id,
            work_date: handover.work_date,
            shift_out: handover.shift_out,
          }),
        });
        toast("Ticket created");
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
          work_date: rememberedDate(),
          shift_out: rememberedShift(),
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
    } catch (err) {
      toast(err.message);
      root.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
    }
  }

  async function initAck() {
    const root = document.getElementById("sm-ack-root");
    if (!root) return;
    const id = Number(SM.handoverId || root.dataset.handoverId);

    function render(ho) {
      const flags = [];
      if (ho.priority === "Urgent" || ho.priority === "High") {
        flags.push(
          '<span class="sm-flag">' +
            escapeHtml(ho.priority) +
            ": " +
            escapeHtml(ho.priority_note || "") +
            "</span>"
        );
      }
      if (ho.quality_issue_flag)
        flags.push('<span class="sm-flag">Quality: ' + escapeHtml(ho.quality_issue_text || "") + "</span>");
      if (ho.alarm_flag)
        flags.push('<span class="sm-flag">Alarm: ' + escapeHtml(ho.alarm_text || "") + "</span>");
      if (ho.maintenance_flag)
        flags.push('<span class="sm-flag warn">Maint: ' + escapeHtml(ho.maintenance_text || "") + "</span>");
      if (ho.ncr_status === "Open")
        flags.push('<span class="sm-flag">NCR open: ' + escapeHtml(ho.ncr_ref || "") + "</span>");
      if (ho.first_piece_status === "Not OK")
        flags.push('<span class="sm-flag">First piece Not OK</span>');
      if (ho.machine_status === "Breakdown") flags.push('<span class="sm-flag">Breakdown</span>');

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
        escapeHtml(ho.shift_out) +
        " → " +
        escapeHtml(ho.shift_in || "") +
        " | " +
        escapeHtml(ho.status) +
        "</p>" +
        '<div class="sm-flags">' +
        (flags.join("") || '<span class="sm-muted">No issues flagged</span>') +
        "</div>" +
        '<div class="sm-review">' +
        "<div>Status: <strong>" +
        escapeHtml(ho.machine_status) +
        "</strong></div>" +
        "<div>Job: " +
        escapeHtml(ho.job_no || "-") +
        " | Qty: " +
        escapeHtml(ho.remaining_qty) +
        "</div>" +
        "<div>Tool life: " +
        escapeHtml(ho.tool_life_pct) +
        "% | Material: " +
        escapeHtml(ho.material_qty == null ? "-" : ho.material_qty) +
        " " +
        escapeHtml(ho.material_unit || "") +
        "</div>" +
        "<div>First piece: " +
        escapeHtml(ho.first_piece_status) +
        "</div>" +
        "<div>Outgoing: " +
        escapeHtml(ho.outgoing_display_name || "-") +
        "</div>" +
        "<div>Remarks: " +
        escapeHtml(ho.remarks || "-") +
        "</div>" +
        "</div>" +
        (comments ? '<div class="sm-comments-box"><h3 class="sm-section-title">Comments</h3>' + comments + "</div>" : "") +
        (canAct
          ? '<button type="button" class="sm-btn sm-btn-primary sm-btn-block" id="sm-ack-btn">Acknowledge</button>' +
            '<button type="button" class="sm-btn sm-btn-danger sm-btn-block" id="sm-dispute-btn">Flag discrepancy</button>' +
            '<textarea class="sm-textarea" id="sm-dispute-note" hidden placeholder="What is wrong with this handover?"></textarea>' +
            '<button type="button" class="sm-btn sm-btn-ghost sm-btn-block" id="sm-dispute-confirm" hidden>Submit discrepancy</button>'
          : '<p class="sm-muted">Already ' +
            escapeHtml(ho.status) +
            (ho.incoming_display_name ? " by " + escapeHtml(ho.incoming_display_name) : "") +
            ".</p>");

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
    } catch (err) {
      root.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
    }
  }

  async function initDashboard() {
    const dateEl = document.getElementById("sm-dash-date");
    const kpi = document.getElementById("sm-kpi-grid");
    const list = document.getElementById("sm-dash-list");
    if (!dateEl || !kpi || !list) return;
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
          ["Breakdowns", k.breakdowns],
          ["Open NCRs", k.open_ncrs],
          ["Urgent", k.urgent_jobs],
          ["Pending maint.", k.pending_maintenance],
          ["1st piece NOK", k.first_piece_not_ok],
          ["Pending ack", k.pending_ack],
          ["Open tickets", k.open_tickets],
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
        const attention = data.attention || {};
        const pending = attention.pending_ack || [];
        const disputed = attention.disputed || [];
        const issues = attention.issues || [];
        const tickets = attention.tickets || [];

        function hoHref(h) {
          return h.status === "pending_ack" || h.status === "disputed"
            ? SM.appPath + "/ack/" + h.handover_id
            : SM.appPath + "/entry/" + h.machine_id;
        }

        function hoItem(h, extraMuted) {
          return (
            '<a class="sm-list-item" href="' +
            hoHref(h) +
            '">' +
            "<span><strong>" +
            escapeHtml(h.machine_no) +
            "</strong> | " +
            escapeHtml(h.shift_out || "") +
            '<br><span class="sm-muted">' +
            escapeHtml(extraMuted || h.job_no || h.machine_status || "") +
            "</span></span>" +
            badgeForHandover(h) +
            "</a>"
          );
        }

        function section(title, html) {
          if (!html) return "";
          return (
            '<section class="sm-dash-section"><h2 class="sm-section-title">' +
            title +
            '</h2><div class="sm-list">' +
            html +
            "</div></section>"
          );
        }

        const pendingHtml = pending
          .map(function (h) {
            return hoItem(h, (h.job_no || "-") + " · tap to acknowledge");
          })
          .join("");
        const disputedHtml = disputed
          .map(function (h) {
            return hoItem(h, h.job_no || "Review discrepancy");
          })
          .join("");
        const issuesHtml = issues
          .map(function (h) {
            const labels = (h.issue_labels || []).join(" · ");
            return hoItem(h, labels || h.job_no || "Needs attention");
          })
          .join("");
        const ticketsHtml = tickets
          .map(function (t) {
            return (
              '<a class="sm-list-item" href="' +
              SM.appPath +
              "/entry/" +
              t.machine_id +
              '">' +
              "<span><strong>" +
              escapeHtml(t.machine_no) +
              "</strong> | " +
              escapeHtml(t.category || "Ticket") +
              '<br><span class="sm-muted">' +
              escapeHtml(t.title || t.process_sheet_no || "") +
              "</span></span>" +
              '<span class="sm-badge urgent">' +
              escapeHtml(t.priority || "Open") +
              "</span></a>"
            );
          })
          .join("");

        const feed =
          section("Needs acknowledgement", pendingHtml) +
          section("Disputed", disputedHtml) +
          section("Issues this shift", issuesHtml) +
          section("Open tickets", ticketsHtml);

        list.innerHTML = feed
          ? feed
          : '<p class="sm-muted sm-dash-empty">Nothing outstanding for this date. Start a handover from Ops or Machines. Past records are under History.</p>';
      } catch (err) {
        kpi.innerHTML = "";
        list.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
      }
    }

    document.querySelectorAll("#sm-dash-shift-chips .sm-chip").forEach(function (btn) {
      btn.addEventListener("click", function () {
        shift = btn.dataset.shift || "";
        paintShift();
        load();
      });
    });
    document.getElementById("sm-dash-report").addEventListener("click", function () {
      downloadReportPdf(dateEl.value, shift || rememberedShift());
    });
    dateEl.addEventListener("change", load);
    paintShift();
    load();
  }

  async function initHistory() {
    const tbody = document.querySelector("#sm-hist-table tbody");
    if (!tbody) return;
    const from = document.getElementById("sm-hist-from");
    const to = document.getElementById("sm-hist-to");
    to.value = todayISO();
    const d = new Date();
    d.setDate(d.getDate() - 14);
    from.value = d.toISOString().slice(0, 10);

    async function load() {
      const q = new URLSearchParams();
      if (from.value) q.set("from", from.value);
      if (to.value) q.set("to", to.value);
      const shift = document.getElementById("sm-hist-shift").value;
      const status = document.getElementById("sm-hist-status").value;
      if (shift) q.set("shift", shift);
      if (status) q.set("status", status);
      try {
        const data = await api("/api/shift-management/history?" + q.toString());
        const items = data.items || [];
        tbody.innerHTML = items.length
          ? items
              .map(function (h) {
                return (
                  "<tr>" +
                  '<td><a href="' +
                  SM.appPath +
                  "/ack/" +
                  h.handover_id +
                  '">' +
                  escapeHtml(h.work_date) +
                  "</a></td>" +
                  "<td>" +
                  escapeHtml(h.machine_no) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(h.shift_out) +
                  (h.shift_in ? " → " + escapeHtml(h.shift_in) : "") +
                  "</td>" +
                  "<td>" +
                  escapeHtml(h.status) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(h.priority) +
                  "</td>" +
                  "<td>" +
                  escapeHtml(h.job_no || "") +
                  "</td>" +
                  "<td>" +
                  escapeHtml(h.outgoing_display_name || "") +
                  "</td>" +
                  "<td>" +
                  escapeHtml(h.incoming_display_name || "") +
                  "</td>" +
                  "</tr>"
                );
              })
              .join("")
          : '<tr><td colspan="8" class="sm-muted">No rows</td></tr>';
      } catch (err) {
        tbody.innerHTML = '<tr><td colspan="8">' + escapeHtml(err.message) + "</td></tr>";
      }
    }
    document.getElementById("sm-hist-apply").addEventListener("click", load);
    document.getElementById("sm-hist-report").addEventListener("click", function () {
      const shift = document.getElementById("sm-hist-shift").value || rememberedShift();
      downloadReportPdf(to.value || todayISO(), shift);
    });
    load();
  }

  function currentPage() {
    return SM.page || (document.body && document.body.getAttribute("data-page")) || "";
  }

  function boot() {
    const page = currentPage();
    if (page === "home") initHome();
    else if (page === "ops") initOps();
    else if (page === "entry") initEntry();
    else if (page === "ack") initAck();
    else if (page === "dashboard") initDashboard();
    else if (page === "history") initHistory();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
