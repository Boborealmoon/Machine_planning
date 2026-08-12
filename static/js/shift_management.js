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
    const res = await fetch(path, Object.assign({
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
    }, opts || {}));
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
          live ? (ho ? String(ho.status || "draft") : "No entry") : "Unavailable",
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
      '" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Factory floor plan">' +
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
          '<div class="sm-muted">PS ' +
          escapeHtml(ps) +
          (m.queue_remaining_qty != null ? " � qty " + escapeHtml(m.queue_remaining_qty) : "") +
          "</div>" +
          (tickets
            ? '<span class="sm-badge urgent">' + tickets + " ticket" + (tickets === 1 ? "" : "s") + "</span>"
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
      grid.innerHTML = '<p class="sm-muted">Loading...</p>';
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
        const machines = data.machines || [];
        const layout = data.floor_layout;
        renderMachineCards(machines);
        if (!layout || !(layout.machines || []).length) {
          grid.innerHTML = '<p class="sm-muted">Floor layout unavailable.</p>';
          return;
        }
        if (!machines.length) {
          grid.innerHTML = '<p class="sm-muted">No active machines found.</p>';
          return;
        }
        renderFloorLegend(layout.colors || {});
        grid.innerHTML = renderFloorMap(machines, layout);
      } catch (err) {
        grid.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
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

  async function initOps() {
    const list = document.getElementById("sm-ops-list");
    if (!list) return;
    let meta = null;
    let ticketCtx = null;

    const dialog = document.getElementById("sm-ticket-dialog");
    const form = document.getElementById("sm-ticket-form");

    function openTicketDialog(item) {
      ticketCtx = item;
      document.getElementById("sm-tk-machine-id").value = item.machine_id;
      document.getElementById("sm-tk-block-id").value = item.block_id || "";
      document.getElementById("sm-tk-ps").value = item.process_sheet_no || item.source_ps_id || "";
      document.getElementById("sm-tk-job").value = item.job_no || item.process_sheet_no || "";
      document.getElementById("sm-ticket-context").textContent =
        (item.machine_no || "") + " � PS " + (item.process_sheet_no || item.job_no || "-");
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

    async function load() {
      list.innerHTML = '<p class="sm-muted">Loading...</p>';
      try {
        const data = await api("/api/shift-management/ops-queue");
        meta = data.meta || meta;
        const items = data.items || [];
        if (!items.length) {
          list.innerHTML = '<p class="sm-muted">No active queue jobs for your machines.</p>';
          return;
        }
        list.innerHTML = items
          .map(function (item) {
            const tickets = Number(item.open_ticket_count || 0);
            return (
              '<article class="sm-ops-card" data-block="' +
              escapeHtml(item.block_id) +
              '">' +
              '<div class="sm-ops-card-main">' +
              "<div><strong>" +
              escapeHtml(item.machine_no) +
              "</strong> � Q" +
              escapeHtml(item.queue_position) +
              "</div>" +
              '<div class="sm-ops-ps">PS ' +
              escapeHtml(item.process_sheet_no || item.job_no || "-") +
              "</div>" +
              '<div class="sm-muted">' +
              escapeHtml(item.operation_name || "Operation") +
              (item.source_op_no ? " � Op " + escapeHtml(item.source_op_no) : "") +
              "</div>" +
              '<div class="sm-muted">Remaining ' +
              escapeHtml(item.remaining_qty != null ? item.remaining_qty : "-") +
              " / planned " +
              escapeHtml(item.scheduled_qty != null ? item.scheduled_qty : "-") +
              " � " +
              escapeHtml(item.execution_status || item.block_status || "") +
              "</div>" +
              (tickets
                ? '<span class="sm-badge urgent">' + tickets + " open ticket(s)</span>"
                : "") +
              "</div>" +
              '<div class="sm-ops-actions">' +
              '<button type="button" class="sm-btn sm-btn-ghost sm-ops-ticket">Ticket</button>' +
              '<a class="sm-btn sm-btn-primary" href="' +
              SM.appPath +
              "/entry/" +
              item.machine_id +
              "?ps=" +
              encodeURIComponent(item.process_sheet_no || item.job_no || "") +
              '">Handover</a>' +
              "</div></article>"
            );
          })
          .join("");

        list.querySelectorAll(".sm-ops-card").forEach(function (card, idx) {
          const item = items[idx];
          card.querySelector(".sm-ops-ticket").addEventListener("click", function () {
            openTicketDialog(item);
          });
        });
      } catch (err) {
        list.innerHTML = '<p class="sm-muted">' + escapeHtml(err.message) + "</p>";
      }
    }

    document.getElementById("sm-ops-refresh").addEventListener("click", load);
    document.getElementById("sm-tk-cancel").addEventListener("click", function () {
      if (dialog) dialog.close();
    });
    form.addEventListener("submit", async function (e) {
      e.preventDefault();
      const status = document.getElementById("sm-tk-status");
      try {
        status.hidden = false;
        status.textContent = "Creating�";
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
            work_date: rememberedDate(),
            shift_out: rememberedShift(),
          }),
        });
        toast("Ticket created");
        if (dialog) dialog.close();
        load();
      } catch (err) {
        status.hidden = false;
        status.textContent = err.message;
      }
    });

    try {
      meta = await api("/api/shift-management/meta");
    } catch (_) {}
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
              " � Q" +
              j.queue_position +
              " � rem " +
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
            " � " +
            escapeHtml(t.priority) +
            " � PS " +
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
                " � " +
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
        " ? " +
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
        " � " +
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
        " ? " +
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
        const items = data.handovers || [];
        list.innerHTML = items.length
          ? items
              .map(function (h) {
                const href =
                  h.status === "pending_ack" || h.status === "disputed"
                    ? SM.appPath + "/ack/" + h.handover_id
                    : SM.appPath + "/entry/" + h.machine_id;
                return (
                  '<a class="sm-list-item" href="' +
                  href +
                  '">' +
                  "<span><strong>" +
                  escapeHtml(h.machine_no) +
                  "</strong> | " +
                  escapeHtml(h.shift_out) +
                  " | " +
                  escapeHtml(h.machine_status) +
                  '<br><span class="sm-muted">' +
                  escapeHtml(h.job_no || "-") +
                  " | " +
                  escapeHtml(h.status) +
                  "</span></span>" +
                  badgeForHandover(h) +
                  "</a>"
                );
              })
              .join("")
          : '<p class="sm-muted">No handovers for this date yet.</p>';
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
                  (h.shift_in ? "?" + escapeHtml(h.shift_in) : "") +
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

  document.addEventListener("DOMContentLoaded", function () {
    if (SM.page === "home") initHome();
    else if (SM.page === "ops") initOps();
    else if (SM.page === "entry") initEntry();
    else if (SM.page === "ack") initAck();
    else if (SM.page === "dashboard") initDashboard();
    else if (SM.page === "history") initHistory();
  });
})();
