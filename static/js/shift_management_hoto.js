/* Shift HOTO checklist - one sheet per date and shift. */
(function () {
  "use strict";

  const SM = (window.SM = window.SM || {});
  const ITEM_COUNT = 6;
  const ATTEND_COUNT = 11;

  const dateEl = document.getElementById("hoto-date");
  const shiftEl = document.getElementById("hoto-shift");
  const whenEl = document.getElementById("hoto-when");
  const outgoingEl = document.getElementById("hoto-outgoing");
  const incomingEl = document.getElementById("hoto-incoming");
  const stateEl = document.getElementById("hoto-save-state");
  const book = document.getElementById("hoto-book");
  if (!dateEl || !book) return;

  let loaded = { date: "", shift: "" };
  let loadSeq = 0;
  let saveTimer = 0;
  let saveChain = Promise.resolve();
  let dirty = false;
  let applying = false;
  let locked = false;
  let editGen = 0;
  const confirmSign = { outgoing: false, incoming: false };
  const pageParams = new URLSearchParams(window.location.search);
  let filingId = pageParams.get("submission") || "";
  let lastFiled = null;

  function todayISO() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day;
  }

  function nowLocal() {
    const d = new Date();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const h = String(d.getHours()).padStart(2, "0");
    const min = String(d.getMinutes()).padStart(2, "0");
    return d.getFullYear() + "-" + m + "-" + day + "T" + h + ":" + min;
  }

  function normalizeShift(val) {
    if (val === "Night") return "Night";
    if (val === "Day") return "Day";
    return SM.defaultShift === "Night" ? "Night" : "Day";
  }

  function rememberedDate() {
    try {
      return sessionStorage.getItem("sm_date") || todayISO();
    } catch (_) {
      return todayISO();
    }
  }

  function rememberedShift() {
    try {
      return normalizeShift(sessionStorage.getItem("sm_shift") || SM.defaultShift || "Day");
    } catch (_) {
      return normalizeShift(SM.defaultShift || "Day");
    }
  }

  function remember(dateVal, shiftVal) {
    try {
      sessionStorage.setItem("sm_date", dateVal);
      sessionStorage.setItem("sm_shift", normalizeShift(shiftVal));
    } catch (_) {}
  }

  function L(text) {
    return window.smL ? window.smL(text) : text == null ? "" : String(text);
  }

  function t(key, vars) {
    return window.smT ? window.smT(key, vars) : key;
  }

  function setState(text) {
    if (!stateEl) return;
    stateEl.setAttribute("data-sm-msg", text == null ? "" : String(text));
    stateEl.textContent = L(text);
  }

  function toast(msg) {
    const el = document.getElementById("sm-toast");
    if (!el) return;
    el.textContent = L(msg);
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
      throw new Error((data && data.error) || res.statusText || "Request failed");
    }
    return data;
  }

  function field(selector) {
    return book.querySelector(selector);
  }

  function signCell(which) {
    return book.querySelector('.hoto-sign-cell[data-sign="' + which + '"]');
  }

  function repEl(which) {
    return which === "incoming" ? incomingEl : outgoingEl;
  }

  function repName(which) {
    const el = repEl(which);
    return el ? el.value.trim() : "";
  }

  function readSign(which) {
    const cell = signCell(which);
    if (!cell) return "";
    return (cell.getAttribute("data-signed-name") || "").trim();
  }

  function paintSign(which, name, signedAt) {
    const cell = signCell(which);
    if (!cell) return;
    const script = cell.querySelector(".hoto-sign-script");
    const meta = cell.querySelector(".hoto-sign-meta");
    const signBtn = cell.querySelector('[data-sign-action="sign"]');
    const clearBtn = cell.querySelector('[data-sign-action="clear"]');
    const signed = !!(name && signedAt);
    cell.setAttribute("data-signed-name", signed ? name : "");
    cell.setAttribute("data-signed-at", signed ? String(signedAt) : "");
    script.hidden = !signed;
    script.textContent = signed ? name : "";
    meta.textContent = signed ? t("signed_meta", { when: String(signedAt).replace("T", " ") }) : "";
    signBtn.hidden = signed;
    clearBtn.hidden = !signed;
  }

  function followRepName(which) {
    const cell = signCell(which);
    if (!cell) return false;
    const signedAt = cell.getAttribute("data-signed-at") || "";
    if (!signedAt) return false;
    const name = repName(which);
    const current = cell.getAttribute("data-signed-name") || "";
    if (!name) {
      if (!current) return false;
      paintSign(which, "", "");
      return true;
    }
    if (current === name) return false;
    paintSign(which, name, signedAt);
    return true;
  }

  function paintStatus(select) {
    if (!select) return;
    const cell = select.closest(".hoto-status");
    if (!cell) return;
    const value = select.value || "";
    const ok = value === "No Issue";
    const issue = value === "Issue Raised";
    cell.classList.toggle("is-ok", ok);
    cell.classList.toggle("is-issue", issue);
    const mark = cell.querySelector(".hoto-status-mark");
    const printed = cell.querySelector(".hoto-status-print");
    const symbol = ok ? "\u2713" : issue ? "\u2715" : "";
    if (mark) mark.textContent = symbol;
    if (printed) printed.textContent = symbol ? symbol + "  " + L(value) : "";
  }

  function paintAllStatuses() {
    book.querySelectorAll("[data-hoto-status]").forEach(paintStatus);
  }

  function collect() {
    const items = [];
    for (let n = 1; n <= ITEM_COUNT; n += 1) {
      const statusEl = field('[data-hoto-status="' + n + '"]');
      const remarksEl = field('[data-hoto-remarks="' + n + '"]');
      const byEl = field('[data-hoto-by="' + n + '"]');
      items.push({
        no: n,
        status: statusEl ? statusEl.value : "",
        remarks: remarksEl ? remarksEl.value : "",
        checked_by: byEl ? byEl.value : "",
      });
    }
    const attendance = [];
    for (let n = 1; n <= ATTEND_COUNT; n += 1) {
      const nameEl = field('[data-hoto-name="' + n + '"]');
      const lateEl = field('[data-hoto-late="' + n + '"]');
      const remarksEl = field('[data-hoto-att-remarks="' + n + '"]');
      attendance.push({
        no: n,
        name: nameEl ? nameEl.value : "",
        late: !!(lateEl && lateEl.checked),
        remarks: remarksEl ? remarksEl.value : "",
      });
    }
    return {
      work_date: loaded.date || dateEl.value,
      shift_out: loaded.shift || normalizeShift(shiftEl.value),
      handover_at: whenEl.value,
      outgoing_supervisor: outgoingEl.value,
      incoming_supervisor: incomingEl.value,
      outgoing_sign_name: readSign("outgoing"),
      incoming_sign_name: readSign("incoming"),
      outgoing_sign: confirmSign.outgoing,
      incoming_sign: confirmSign.incoming,
      items: items,
      attendance: attendance,
    };
  }

  function apply(checklist) {
    applying = true;
    try {
      whenEl.value = checklist.handover_at || nowLocal();
      outgoingEl.value = checklist.outgoing_supervisor || "";
      if (!checklist.saved && !outgoingEl.value && SM.userDisplay) {
        outgoingEl.value = SM.userDisplay;
      }
      incomingEl.value = checklist.incoming_supervisor || "";
      (checklist.items || []).forEach(function (item) {
        const statusEl = field('[data-hoto-status="' + item.no + '"]');
        const remarksEl = field('[data-hoto-remarks="' + item.no + '"]');
        const byEl = field('[data-hoto-by="' + item.no + '"]');
        if (statusEl) statusEl.value = item.status || "";
        if (remarksEl) remarksEl.value = item.remarks || "";
        if (byEl) byEl.value = item.checked_by || "";
      });
      (checklist.attendance || []).forEach(function (row) {
        const nameEl = field('[data-hoto-name="' + row.no + '"]');
        const lateEl = field('[data-hoto-late="' + row.no + '"]');
        const remarksEl = field('[data-hoto-att-remarks="' + row.no + '"]');
        if (nameEl) nameEl.value = row.name || "";
        if (lateEl) lateEl.checked = !!row.late;
        if (remarksEl) remarksEl.value = row.remarks || "";
      });
      paintSign("outgoing", checklist.outgoing_sign_name, checklist.outgoing_signed_at);
      paintSign("incoming", checklist.incoming_sign_name, checklist.incoming_signed_at);
      const followedOut = followRepName("outgoing");
      const followedIn = followRepName("incoming");
      paintAllStatuses();
      const filed = checklist.doc_status === "submitted" || !!checklist.read_only || !!filingId;
      dirty = !filed && (followedOut || followedIn);
      setLocked(filed);
      paintFiled(checklist);
    } finally {
      applying = false;
    }
  }

  function setLocked(on) {
    locked = !!on;
    book.classList.toggle("is-locked", locked);
    book.querySelectorAll("input, select, textarea, button").forEach(function (el) {
      el.disabled = locked;
    });
    const submitBtn = document.getElementById("hoto-submit");
    const reopenBtn = document.getElementById("hoto-reopen");
    if (submitBtn) submitBtn.hidden = locked;
    const canReopen = !!(SM.caps && SM.caps.can_view_hoto_backlog);
    if (reopenBtn) reopenBtn.hidden = !locked || !!filingId || !canReopen;
  }

  function paintFiled(checklist) {
    const el = document.getElementById("hoto-filed");
    if (!el) return;
    lastFiled = checklist;
    const submitted = checklist.doc_status === "submitted" || !!checklist.read_only;
    if (!submitted) {
      el.hidden = true;
      el.textContent = "";
      return;
    }
    const when = checklist.submitted_at ? String(checklist.submitted_at).replace("T", " ") : "";
    const who = checklist.submitted_by_name ? t("by_person", { name: checklist.submitted_by_name }) : "";
    el.hidden = false;
    el.textContent = checklist.read_only
      ? t("filed_handover", { when: when ? " - " + when : "", who: who })
      : t("submitted_locked", { when: when ? " " + when : "", who: who });
  }

  function leaveFiling() {
    if (!filingId) return;
    filingId = "";
    window.history.replaceState(null, "", window.location.pathname);
  }

  function syncShiftUi(shift) {
    const next = normalizeShift(shift);
    shiftEl.value = next;
    document.querySelectorAll("#hoto-shift-chips [data-shift]").forEach(function (btn) {
      btn.classList.toggle("is-active", btn.getAttribute("data-shift") === next);
    });
  }

  async function load(dateVal, shiftVal) {
    const seq = ++loadSeq;
    const date = dateVal || dateEl.value || todayISO();
    const shift = normalizeShift(shiftVal || shiftEl.value);
    dateEl.value = date;
    syncShiftUi(shift);
    setState("Loading...");
    if (filingId) {
      try {
        const data = await api(
          "/api/shift-management/hoto/submissions/" + encodeURIComponent(filingId)
        );
        if (seq !== loadSeq) return;
        const sheet = data.checklist || {};
        loaded = {
          date: sheet.work_date || date,
          shift: normalizeShift(sheet.shift_out || shift),
        };
        dateEl.value = loaded.date;
        syncShiftUi(loaded.shift);
        apply(sheet);
        setState("Filed copy");
      } catch (err) {
        if (seq !== loadSeq) return;
        setState("Could not load");
        toast(err.message || "Could not load handover");
      }
      return;
    }
    try {
      const data = await api(
        "/api/shift-management/hoto?date=" + encodeURIComponent(date) + "&shift=" + encodeURIComponent(shift)
      );
      if (seq !== loadSeq) return;
      loaded = { date: date, shift: shift };
      remember(date, shift);
      apply(data.checklist || {});
      const sheet = data.checklist || {};
      if (dirty) scheduleSave();
      else if (sheet.doc_status === "submitted") setState("Submitted");
      else setState(sheet.saved ? "Saved" : "Not saved yet");
    } catch (err) {
      if (seq !== loadSeq) return;
      setState("Could not load");
      toast(err.message || "Could not load checklist");
    }
  }

  function saveNow() {
    clearTimeout(saveTimer);
    if (!loaded.date || applying || locked) return saveChain;
    const gen = editGen;
    const payload = collect();
    payload.work_date = loaded.date;
    payload.shift_out = loaded.shift;
    confirmSign.outgoing = false;
    confirmSign.incoming = false;
    setState("Saving...");
    saveChain = saveChain.then(async function () {
      try {
        const data = await api("/api/shift-management/hoto", {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        if (gen !== editGen) {
          dirty = true;
          scheduleSave();
          return;
        }
        dirty = false;
        apply(data.checklist || {});
        setState("Saved");
      } catch (err) {
        if (payload.outgoing_sign) confirmSign.outgoing = true;
        if (payload.incoming_sign) confirmSign.incoming = true;
        dirty = true;
        setState("Not saved");
        toast(err.message || "Could not save checklist");
      }
    });
    return saveChain;
  }

  function scheduleSave() {
    if (applying || locked) return;
    dirty = true;
    editGen += 1;
    setState("Unsaved");
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveNow();
    }, 700);
  }

  async function flush() {
    clearTimeout(saveTimer);
    if (!dirty) {
      await saveChain;
      return;
    }
    await saveNow();
  }

  async function openShift(dateVal, shiftVal) {
    const date = dateVal || dateEl.value || todayISO();
    const shift = normalizeShift(shiftVal || shiftEl.value);
    if (filingId) {
      leaveFiling();
      await load(date, shift);
      return;
    }
    if (loaded.date === date && loaded.shift === shift) {
      dateEl.value = date;
      syncShiftUi(shift);
      return;
    }
    await flush();
    await load(date, shift);
  }

  dateEl.addEventListener("change", function () {
    openShift(dateEl.value, shiftEl.value);
  });

  shiftEl.addEventListener("change", function () {
    openShift(dateEl.value, shiftEl.value);
  });

  document.querySelectorAll("#hoto-shift-chips [data-shift]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      openShift(dateEl.value, btn.getAttribute("data-shift"));
    });
  });

  book.addEventListener("input", function (event) {
    const target = event.target;
    if (target === outgoingEl) followRepName("outgoing");
    if (target === incomingEl) followRepName("incoming");
    scheduleSave();
  });
  book.addEventListener("change", function (event) {
    const target = event.target;
    if (target && target.matches("[data-hoto-status]")) {
      paintStatus(target);
      const no = target.getAttribute("data-hoto-status");
      const byEl = field('[data-hoto-by="' + no + '"]');
      if (target.value && byEl && !byEl.value && SM.userDisplay) {
        byEl.value = SM.userDisplay;
      }
    }
    if (target === shiftEl || target === dateEl) return;
    scheduleSave();
  });

  book.addEventListener("click", function (event) {
    const btn = event.target.closest("[data-sign-action]");
    if (!btn) return;
    const cell = btn.closest(".hoto-sign-cell");
    if (!cell) return;
    const which = cell.getAttribute("data-sign");
    if (locked) return;
    if (btn.getAttribute("data-sign-action") === "clear") {
      paintSign(which, "", "");
      scheduleSave();
      return;
    }
    const name = repName(which);
    if (!name) {
      const input = repEl(which);
      if (input) input.focus();
      toast(t("enter_rep", { which: L(which) }));
      return;
    }
    confirmSign[which] = true;
    paintSign(which, name, nowLocal());
    editGen += 1;
    dirty = true;
    saveNow();
  });

  const printBtn = document.getElementById("hoto-print");
  if (printBtn) {
    printBtn.addEventListener("click", function () {
      flush().finally(function () {
        window.print();
      });
    });
  }

  const submitBtn = document.getElementById("hoto-submit");
  if (submitBtn) {
    submitBtn.addEventListener("click", async function () {
      if (locked) return;
      submitBtn.disabled = true;
      try {
        await flush();
        const payload = collect();
        payload.work_date = loaded.date;
        payload.shift_out = loaded.shift;
        setState("Submitting...");
        const data = await api("/api/shift-management/hoto/submit", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        apply(data.checklist || {});
        setState("Submitted");
        window.location.href =
          (SM.appPath || "/Shift-management") +
          "/history?date=" +
          encodeURIComponent(loaded.date || dateEl.value || "") +
          "&shift=" +
          encodeURIComponent(loaded.shift || shiftEl.value || "Day") +
          "&view=hoto&filed=1";
        return;
      } catch (err) {
        setState("Not submitted");
        toast(err.message || "Could not submit");
      } finally {
        submitBtn.disabled = locked;
      }
    });
  }

  const reopenBtn = document.getElementById("hoto-reopen");
  if (reopenBtn) {
    reopenBtn.addEventListener("click", async function () {
      reopenBtn.disabled = true;
      try {
        const data = await api("/api/shift-management/hoto/reopen", {
          method: "POST",
          body: JSON.stringify({ work_date: loaded.date, shift_out: loaded.shift }),
        });
        apply(data.checklist || {});
        setState("Draft");
        toast("Handover reopened");
      } catch (err) {
        toast(err.message || "Could not reopen");
      } finally {
        reopenBtn.disabled = false;
      }
    });
  }

  load(pageParams.get("date") || rememberedDate(), pageParams.get("shift") || rememberedShift());

  document.addEventListener("sm-locale", function () {
    paintAllStatuses();
    if (lastFiled) paintFiled(lastFiled);
    ["outgoing", "incoming"].forEach(function (which) {
      const cell = signCell(which);
      if (!cell) return;
      const name = cell.getAttribute("data-signed-name") || "";
      const at = cell.getAttribute("data-signed-at") || "";
      if (name && at) paintSign(which, name, at);
    });
  });
})();
