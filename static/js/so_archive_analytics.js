/* Archive visual analytics ù aggregates GET /api/sales-report/ytd into SVG charts. */

const SOA_AN_PP_TYPES = ['MPS', 'APS', 'NPS', 'PPS', 'CPS', 'SR'];
const SOA_AN_PARETO_TOP = 8;
const SOA_AN_OTIF_BUCKETS = [
  { id: 'le_neg_14', label: '??14', lo: null, hi: -14 },
  { id: 'neg_13_1', label: '?13 to ?1', lo: -13, hi: -1 },
  { id: 'on_time', label: '0', lo: 0, hi: 0 },
  { id: 'd1_7', label: '1ù7', lo: 1, hi: 7 },
  { id: 'd8_14', label: '8ù14', lo: 8, hi: 14 },
  { id: 'd15_30', label: '15ù30', lo: 15, hi: 30 },
  { id: 'ge_31', label: '31+', lo: 31, hi: null },
];

const SOA_AN_PP_COLORS = {
  MPS: '#475569',
  APS: '#0369a1',
  NPS: '#0f766e',
  PPS: '#7c3aed',
  CPS: '#c2410c',
  SR: '#db2777',
};

const SOA_AN_SERIES_COLORS = {
  backlog_delivered: '#b45309',
  delivered: '#15803d',
  early_delivered: '#0369a1',
  sales: '#0f766e',
  backlog: '#c2410c',
  on_hand: '#0f766e',
  due_this_month: '#64748b',
};

const SOA_AN_SERIES_LABELS = {
  backlog_delivered: 'Backlog delivered',
  delivered: 'On-time',
  early_delivered: 'Early',
  sales: 'Shipped',
  backlog: 'Backlog',
  on_hand: 'Onhand',
  due_this_month: 'Due this month',
};

const SOA_AN_PRESETS = {
  'aps-nps': ['APS', 'NPS'],
  aps: ['APS'],
  nps: ['NPS'],
  all: [...SOA_AN_PP_TYPES],
};

const soaAnState = {
  loaded: false,
  loading: false,
  year: new Date().getFullYear(),
  dateBasis: 'po_due',
  ppTypes: new Set(['APS', 'NPS']),
  data: null,
};

function soaAnEl(id) {
  return document.getElementById(id);
}

function soaAnEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function soaAnAuthHeaders() {
  const headers = { Accept: 'application/json' };
  if (window.__reportsAuthToken) {
    headers['X-Reports-Token'] = window.__reportsAuthToken;
  }
  return headers;
}

function soaAnMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'ù';
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

function soaAnCompactMoney(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'ù';
  const abs = Math.abs(num);
  const sign = num < 0 ? '-' : '';
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(abs >= 1e4 ? 0 : 1)}k`;
  return `${sign}${Math.round(abs)}`;
}

function soaAnPct(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 'ù';
  return `${(num * 100).toLocaleString(undefined, { maximumFractionDigits: 0 })}%`;
}

function soaAnParseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const d = new Date(`${text.slice(0, 10)}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function soaAnPpType(row) {
  if (row?.pp_type) return String(row.pp_type);
  const raw = String(row?.process_sheet_no || '').split('::')[0];
  if (/\[sr\]/i.test(raw)) return 'SR';
  const match = raw.toUpperCase().match(/^([A-Z]+)/);
  return match ? match[1] : null;
}

function soaAnOpenValue(row) {
  const alloc = Number(row?.allocated_remaining_value);
  if (Number.isFinite(alloc)) return alloc;
  const rem = Number(row?.remaining_value);
  return Number.isFinite(rem) ? rem : 0;
}

function soaAnMoneyField(row, field) {
  const num = Number(row?.[field]);
  return Number.isFinite(num) ? num : 0;
}

function soaAnAllTypes() {
  return soaAnState.ppTypes.size >= SOA_AN_PP_TYPES.length;
}

function soaAnPassesPp(row) {
  if (!soaAnState.ppTypes.size) return false;
  if (soaAnAllTypes()) return true;
  const ppType = soaAnPpType(row);
  return Boolean(ppType) && soaAnState.ppTypes.has(ppType);
}

function soaAnTypeLabel() {
  const selected = SOA_AN_PP_TYPES.filter((type) => soaAnState.ppTypes.has(type));
  if (!selected.length) return 'None';
  if (selected.length >= SOA_AN_PP_TYPES.length) return 'All types';
  return selected.map((type) => (type === 'SR' ? '[SR]' : type)).join(', ');
}

function soaAnBasisPhrase() {
  return soaAnState.dateBasis === 'posted' ? 'SO posted date' : 'PO due date';
}

function soaAnPosted() {
  return soaAnState.dateBasis === 'posted';
}

function soaAnActivePreset() {
  const current = [...soaAnState.ppTypes].sort().join(',');
  for (const [id, types] of Object.entries(SOA_AN_PRESETS)) {
    if ([...types].sort().join(',') === current) return id;
  }
  return '';
}

function soaAnSyncFilters() {
  const yearInput = soaAnEl('soa-an-year');
  if (yearInput && document.activeElement !== yearInput) {
    yearInput.value = String(soaAnState.year);
  }
  document.querySelectorAll('#soa-an-types [data-an-type]').forEach((btn) => {
    const on = soaAnState.ppTypes.has(btn.dataset.anType);
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const preset = soaAnActivePreset();
  document.querySelectorAll('#soa-an-presets [data-an-preset]').forEach((btn) => {
    const on = btn.dataset.anPreset === preset;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  document.querySelectorAll('#soa-an-basis [data-an-basis]').forEach((btn) => {
    const on = btn.dataset.anBasis === soaAnState.dateBasis;
    btn.classList.toggle('is-active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const ctx = soaAnEl('soa-an-context');
  if (ctx) {
    ctx.textContent = `${soaAnState.year} full year ù ${soaAnTypeLabel()} ù ${soaAnBasisPhrase()}`;
  }
}

function soaAnSetLoading(loading) {
  soaAnState.loading = loading;
  const el = soaAnEl('soa-an-loading');
  if (el) el.hidden = !loading;
}

function soaAnSetAlert(message) {
  const el = soaAnEl('soa-an-alert');
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function soaAnSumGridRows(grid) {
  const selected = soaAnState.ppTypes;
  const rows = (grid?.rows || []).filter((row) => selected.has(String(row.id || '')));
  const months = grid?.months || [];
  return months.map((meta, idx) => {
    const cell = { month: meta.month, mode: meta.mode };
    ['sales', 'backlog_delivered', 'delivered', 'early_delivered', 'backlog', 'on_hand', 'due_this_month'].forEach((key) => {
      cell[key] = rows.reduce((sum, row) => {
        const piece = (row.cells || [])[idx] || {};
        return sum + soaAnMoneyField(piece, key);
      }, 0);
    });
    return cell;
  });
}

function soaAnComposition(grid) {
  const months = grid?.months || [];
  const cells = soaAnSumGridRows(grid);
  const posted = soaAnPosted();
  return months.map((meta, idx) => {
    const cell = cells[idx] || {};
    let series;
    if (meta.mode === 'past') {
      if (posted) {
        const sales = soaAnMoneyField(cell, 'sales')
          || (soaAnMoneyField(cell, 'backlog_delivered') + soaAnMoneyField(cell, 'delivered') + soaAnMoneyField(cell, 'early_delivered'));
        series = { sales };
      } else {
        series = {
          backlog_delivered: soaAnMoneyField(cell, 'backlog_delivered'),
          delivered: soaAnMoneyField(cell, 'delivered'),
          early_delivered: soaAnMoneyField(cell, 'early_delivered'),
        };
      }
    } else if (meta.is_current && !posted) {
      series = {
        backlog: soaAnMoneyField(cell, 'backlog'),
        on_hand: soaAnMoneyField(cell, 'on_hand') || soaAnMoneyField(cell, 'due_this_month'),
      };
    } else {
      series = {
        due_this_month: soaAnMoneyField(cell, 'due_this_month') || soaAnMoneyField(cell, 'on_hand'),
      };
    }
    const total = Object.values(series).reduce((sum, val) => sum + val, 0);
    return {
      month: meta.month,
      label: meta.label || `M${meta.month}`,
      mode: meta.mode,
      is_current: Boolean(meta.is_current),
      series,
      total,
    };
  });
}

function soaAnMix(openLines) {
  const totals = Object.fromEntries(SOA_AN_PP_TYPES.map((type) => [type, 0]));
  (openLines || []).forEach((row) => {
    if (!soaAnPassesPp(row)) return;
    const ppType = soaAnPpType(row);
    if (ppType in totals) totals[ppType] += soaAnOpenValue(row);
  });
  const grand = Object.values(totals).reduce((sum, val) => sum + val, 0);
  return SOA_AN_PP_TYPES
    .filter((type) => totals[type] > 0.009)
    .map((type) => ({
      id: type,
      label: type === 'SR' ? '[SR]' : type,
      value: totals[type],
      share: grand ? totals[type] / grand : 0,
    }));
}

function soaAnCustomerKey(row) {
  return String(row?.customer_code || '').trim().toLowerCase()
    || String(row?.customer_name || '').trim().toLowerCase()
    || '__blank__';
}

function soaAnCustomerLabel(row) {
  const name = String(row?.customer_name || '').trim();
  const code = String(row?.customer_code || '').trim();
  if (name && code && name !== code) return `${name} (${code})`;
  return name || code || '(Blank)';
}

function soaAnPareto(openLines) {
  const grouped = new Map();
  (openLines || []).forEach((row) => {
    if (!soaAnPassesPp(row)) return;
    const key = soaAnCustomerKey(row);
    const existing = grouped.get(key);
    if (existing) {
      existing.value += soaAnOpenValue(row);
    } else {
      grouped.set(key, { key, label: soaAnCustomerLabel(row), value: soaAnOpenValue(row) });
    }
  });
  const ranked = [...grouped.values()].sort((a, b) => b.value - a.value);
  const grand = ranked.reduce((sum, item) => sum + item.value, 0);
  const head = ranked.slice(0, SOA_AN_PARETO_TOP);
  const tail = ranked.slice(SOA_AN_PARETO_TOP);
  const items = head.map((item) => ({ ...item }));
  if (tail.length) {
    items.push({
      key: '__other__',
      label: `Other (${tail.length})`,
      value: tail.reduce((sum, item) => sum + item.value, 0),
    });
  }
  let running = 0;
  items.forEach((item) => {
    running += item.value;
    item.share = grand ? item.value / grand : 0;
    item.cumulative = grand ? running / grand : 0;
  });
  return { total: grand, items, customer_count: ranked.length };
}

function soaAnOtifBucketId(days) {
  for (const bucket of SOA_AN_OTIF_BUCKETS) {
    if (bucket.lo != null && days < bucket.lo) continue;
    if (bucket.hi != null && days > bucket.hi) continue;
    return bucket.id;
  }
  return 'ge_31';
}

function soaAnOtif(shipments) {
  const counts = Object.fromEntries(SOA_AN_OTIF_BUCKETS.map((bucket) => [bucket.id, 0]));
  let skipped = 0;
  let onTime = 0;
  (shipments || []).forEach((row) => {
    if (!soaAnPassesPp(row)) return;
    const ship = soaAnParseDate(row.shipment_date || row.shipment_datetime);
    const due = soaAnParseDate(row.so_due_date) || soaAnParseDate(row.due_date);
    if (!ship || !due) {
      skipped += 1;
      return;
    }
    const days = Math.round((ship.getTime() - due.getTime()) / 86400000);
    counts[soaAnOtifBucketId(days)] += 1;
    if (days <= 0) onTime += 1;
  });
  const classified = Object.values(counts).reduce((sum, val) => sum + val, 0);
  return {
    buckets: SOA_AN_OTIF_BUCKETS.map((bucket) => ({
      id: bucket.id,
      label: bucket.label,
      count: counts[bucket.id],
    })),
    classified,
    skipped,
    on_time: onTime,
    on_time_rate: classified ? onTime / classified : 0,
  };
}

function soaAnLegend(keys) {
  return `<div class="soa-chart-legend">${keys.map((key) => `
    <span class="soa-chart-legend-item">
      <span class="soa-chart-swatch" style="background:${SOA_AN_SERIES_COLORS[key]}"></span>
      ${soaAnEscape(SOA_AN_SERIES_LABELS[key] || key)}
    </span>`).join('')}</div>`;
}

function soaAnEmpty(text) {
  return `<div class="soa-chart-empty">${soaAnEscape(text)}</div>`;
}

function soaAnRenderComposition(bars) {
  const host = soaAnEl('soa-an-composition');
  const sub = soaAnEl('soa-an-comp-sub');
  if (!host) return;
  if (sub) {
    sub.textContent = soaAnPosted()
      ? 'Past = total shipped ù current/future = onhand by SO posted date'
      : 'Past = shipped (backlog / on-time / early) ù current = backlog + onhand ù future = due this month';
  }
  const max = Math.max(0, ...bars.map((bar) => bar.total));
  if (!max) {
    host.innerHTML = soaAnEmpty('No composition $ for this filter.');
    return;
  }
  const W = 640;
  const H = 220;
  const left = 44;
  const right = 12;
  const top = 12;
  const bottom = 28;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const gap = 6;
  const barW = Math.max(8, (innerW / bars.length) - gap);
  const seriesKeys = soaAnPosted()
    ? ['sales', 'due_this_month']
    : ['backlog_delivered', 'delivered', 'early_delivered', 'backlog', 'on_hand', 'due_this_month'];
  const usedKeys = seriesKeys.filter((key) => bars.some((bar) => (bar.series[key] || 0) > 0.009));

  const columns = bars.map((bar, idx) => {
    const x = left + idx * (innerW / bars.length) + gap / 2;
    let y = top + innerH;
    const stacks = usedKeys.map((key) => {
      const val = bar.series[key] || 0;
      const h = max ? (val / max) * innerH : 0;
      y -= h;
      if (h < 0.4) return '';
      return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${SOA_AN_SERIES_COLORS[key]}" rx="1">
        <title>${soaAnEscape(bar.label)} ù ${soaAnEscape(SOA_AN_SERIES_LABELS[key])}: $${soaAnMoney(val)}</title>
      </rect>`;
    }).join('');
    const tick = String(bar.label).replace(/-\d+$/, '').slice(0, 3);
    return `${stacks}<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#64748b">${soaAnEscape(tick)}</text>`;
  }).join('');

  const ticks = [0, 0.5, 1].map((frac) => {
    const y = top + innerH * (1 - frac);
    return `<line x1="${left}" x2="${W - right}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="#e2e8f0"/>
      <text x="${left - 6}" y="${(y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="#64748b">${soaAnEscape(soaAnCompactMoney(max * frac))}</text>`;
  }).join('');

  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Monthly composition">${ticks}${columns}</svg>${soaAnLegend(usedKeys)}`;
}

function soaAnPolar(cx, cy, r, angleDeg) {
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
}

function soaAnDonutArc(cx, cy, r, r0, start, end) {
  const sweep = end - start;
  if (sweep >= 359.9) {
    return `M ${cx + r} ${cy} A ${r} ${r} 0 1 1 ${cx - r} ${cy} A ${r} ${r} 0 1 1 ${cx + r} ${cy}
            M ${cx + r0} ${cy} A ${r0} ${r0} 0 1 0 ${cx - r0} ${cy} A ${r0} ${r0} 0 1 0 ${cx + r0} ${cy}`;
  }
  const [sx, sy] = soaAnPolar(cx, cy, r, start);
  const [ex, ey] = soaAnPolar(cx, cy, r, end);
  const [sx0, sy0] = soaAnPolar(cx, cy, r0, end);
  const [ex0, ey0] = soaAnPolar(cx, cy, r0, start);
  const large = sweep > 180 ? 1 : 0;
  return `M ${sx} ${sy} A ${r} ${r} 0 ${large} 1 ${ex} ${ey} L ${sx0} ${sy0} A ${r0} ${r0} 0 ${large} 0 ${ex0} ${ey0} Z`;
}

function soaAnRenderMix(items) {
  const host = soaAnEl('soa-an-mix');
  if (!host) return;
  const total = items.reduce((sum, item) => sum + item.value, 0);
  if (!total) {
    host.innerHTML = soaAnEmpty('No open remaining $ for this filter.');
    return;
  }
  const cx = 80;
  const cy = 80;
  const r = 72;
  const r0 = 40;
  let angle = 0;
  const arcs = items.map((item) => {
    const sweep = item.share * 360;
    const start = angle;
    const end = angle + sweep;
    angle = end;
    const color = SOA_AN_PP_COLORS[item.id] || '#64748b';
    return `<path d="${soaAnDonutArc(cx, cy, r, r0, start, end)}" fill="${color}">
      <title>${soaAnEscape(item.label)}: $${soaAnMoney(item.value)} (${soaAnPct(item.share)})</title>
    </path>`;
  }).join('');
  const legend = items.map((item) => `
    <div class="soa-mix-legend-row">
      <span class="soa-chart-swatch" style="background:${SOA_AN_PP_COLORS[item.id] || '#64748b'}"></span>
      <span>${soaAnEscape(item.label)}</span>
      <strong>$${soaAnCompactMoney(item.value)}</strong>
    </div>`).join('');
  host.innerHTML = `<div class="soa-mix-layout">
    <svg viewBox="0 0 160 160" role="img" aria-label="PP-type mix">${arcs}
      <text x="80" y="76" text-anchor="middle" font-size="11" fill="#64748b">Remaining</text>
      <text x="80" y="94" text-anchor="middle" font-size="13" font-weight="700" fill="#0f172a">$${soaAnEscape(soaAnCompactMoney(total))}</text>
    </svg>
    <div class="soa-mix-legend">${legend}</div>
  </div>`;
}

function soaAnRenderPareto(payload) {
  const host = soaAnEl('soa-an-pareto');
  const sub = soaAnEl('soa-an-pareto-sub');
  if (!host) return;
  if (sub) {
    sub.textContent = payload.customer_count
      ? `${payload.customer_count} customers ù remaining $${soaAnMoney(payload.total)}`
      : 'Who owns remaining open $';
  }
  const items = payload.items || [];
  if (!items.length) {
    host.innerHTML = soaAnEmpty('No customer remaining $ for this filter.');
    return;
  }
  const rowH = 22;
  const left = 128;
  const right = 54;
  const top = 8;
  const W = 640;
  const H = top + items.length * rowH + 16;
  const innerW = W - left - right;
  const max = Math.max(...items.map((item) => item.value), 1);
  const bars = items.map((item, idx) => {
    const y = top + idx * rowH;
    const w = (item.value / max) * innerW;
    const label = item.label.length > 22 ? `${item.label.slice(0, 20)}ù` : item.label;
    return `<text x="${left - 8}" y="${y + 13}" text-anchor="end" font-size="10" fill="#334155">${soaAnEscape(label)}</text>
      <rect x="${left}" y="${y + 4}" width="${Math.max(w, 1).toFixed(1)}" height="12" rx="2" fill="${item.key === '__other__' ? '#94a3b8' : '#0369a1'}">
        <title>${soaAnEscape(item.label)}: $${soaAnMoney(item.value)} ù ${soaAnPct(item.share)} (cum ${soaAnPct(item.cumulative)})</title>
      </rect>
      <text x="${(left + w + 6).toFixed(1)}" y="${y + 13}" font-size="10" fill="#64748b">${soaAnEscape(soaAnCompactMoney(item.value))}</text>`;
  }).join('');
  const linePts = items.map((item, idx) => {
    const x = left + item.cumulative * innerW;
    const y = top + idx * rowH + 10;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Customer Pareto">${bars}
    <polyline fill="none" stroke="#c2410c" stroke-width="1.5" points="${linePts}"/>
  </svg>`;
}

function soaAnRenderOtif(payload) {
  const host = soaAnEl('soa-an-otif');
  const sub = soaAnEl('soa-an-otif-sub');
  if (!host) return;
  if (sub) {
    const skip = payload.skipped ? ` ù ${payload.skipped} missing due` : '';
    sub.textContent = payload.classified
      ? `On-time (ship ? PO due): ${soaAnPct(payload.on_time_rate)} of ${payload.classified} DOs${skip}`
      : 'Shipment date minus original PO due (days)';
  }
  const buckets = payload.buckets || [];
  const max = Math.max(0, ...buckets.map((bucket) => bucket.count));
  if (!max) {
    host.innerHTML = soaAnEmpty('No shipments with both ship and PO due dates.');
    return;
  }
  const W = 640;
  const H = 220;
  const left = 36;
  const right = 12;
  const top = 12;
  const bottom = 32;
  const innerW = W - left - right;
  const innerH = H - top - bottom;
  const gap = 10;
  const barW = Math.max(12, (innerW / buckets.length) - gap);
  const colors = {
    le_neg_14: '#0369a1',
    neg_13_1: '#0ea5e9',
    on_time: '#15803d',
    d1_7: '#d97706',
    d8_14: '#ea580c',
    d15_30: '#c2410c',
    ge_31: '#7f1d1d',
  };
  const cols = buckets.map((bucket, idx) => {
    const x = left + idx * (innerW / buckets.length) + gap / 2;
    const h = (bucket.count / max) * innerH;
    const y = top + innerH - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" rx="2" fill="${colors[bucket.id] || '#64748b'}">
        <title>${soaAnEscape(bucket.label)} days: ${bucket.count}</title>
      </rect>
      <text x="${(x + barW / 2).toFixed(1)}" y="${H - 10}" text-anchor="middle" font-size="10" fill="#64748b">${soaAnEscape(bucket.label)}</text>
      <text x="${(x + barW / 2).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle" font-size="10" fill="#334155">${bucket.count ? bucket.count : ''}</text>`;
  }).join('');
  host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="OTIF histogram">${cols}</svg>`;
}

function soaAnRender() {
  const data = soaAnState.data;
  const gridWrap = soaAnEl('soa-an-grid');
  const empty = soaAnEl('soa-an-empty');
  if (!data) {
    if (gridWrap) gridWrap.hidden = true;
    if (empty) empty.hidden = true;
    return;
  }
  const openLines = data.allocated_open_lines || data.open_lines || [];
  const shipments = data.shipments_attributed || data.shipments || [];
  const composition = soaAnComposition(data.grid || {});
  const mix = soaAnMix(openLines);
  const pareto = soaAnPareto(openLines);
  const otif = soaAnOtif(shipments);
  const hasAny = composition.some((bar) => bar.total > 0.009) || mix.length || pareto.items.length || otif.classified;
  if (empty) empty.hidden = hasAny;
  if (gridWrap) gridWrap.hidden = !hasAny;
  if (!hasAny) return;
  soaAnRenderComposition(composition);
  soaAnRenderMix(mix);
  soaAnRenderPareto(pareto);
  soaAnRenderOtif(otif);
}

async function soaAnLoad({ refresh = false, force = false } = {}) {
  if (soaAnState.loading) return;
  if (soaAnState.loaded && soaAnState.data && !refresh && !force) {
    soaAnSyncFilters();
    soaAnRender();
    return;
  }
  soaAnSetLoading(true);
  soaAnSetAlert('');
  soaAnSyncFilters();
  const params = new URLSearchParams();
  params.set('year', String(soaAnState.year));
  params.set('basis', soaAnState.dateBasis);
  if (refresh) params.set('refresh', '1');
  try {
    const res = await fetch(`/api/sales-report/ytd?${params.toString()}`, {
      headers: soaAnAuthHeaders(),
      credentials: 'same-origin',
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) {
      throw new Error(payload.error || `Request failed (${res.status})`);
    }
    soaAnState.data = payload;
    soaAnState.loaded = true;
    soaAnRender();
  } catch (err) {
    soaAnState.data = null;
    soaAnState.loaded = false;
    const gridWrap = soaAnEl('soa-an-grid');
    const empty = soaAnEl('soa-an-empty');
    if (gridWrap) gridWrap.hidden = true;
    if (empty) empty.hidden = true;
    soaAnSetAlert(err?.message || 'Failed to load sales analytics.');
  } finally {
    soaAnSetLoading(false);
  }
}

function soaAnBind() {
  if (soaAnBind.done) return;
  soaAnBind.done = true;

  document.querySelectorAll('#soa-an-presets [data-an-preset]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const types = SOA_AN_PRESETS[btn.dataset.anPreset] || SOA_AN_PRESETS['aps-nps'];
      soaAnState.ppTypes = new Set(types);
      soaAnSyncFilters();
      soaAnRender();
    });
  });

  document.querySelectorAll('#soa-an-types [data-an-type]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.anType;
      if (!type) return;
      if (soaAnState.ppTypes.has(type)) {
        if (soaAnState.ppTypes.size === 1) return;
        soaAnState.ppTypes.delete(type);
      } else {
        soaAnState.ppTypes.add(type);
      }
      soaAnSyncFilters();
      soaAnRender();
    });
  });

  document.querySelectorAll('#soa-an-basis [data-an-basis]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const basis = btn.dataset.anBasis === 'posted' ? 'posted' : 'po_due';
      if (soaAnState.dateBasis === basis) return;
      soaAnState.dateBasis = basis;
      soaAnLoad({ force: true });
    });
  });

  soaAnEl('soa-an-year')?.addEventListener('change', (event) => {
    const year = Number(event.target.value);
    if (!Number.isInteger(year) || year < 2000 || year > 2100) return;
    if (year === soaAnState.year) return;
    soaAnState.year = year;
    soaAnLoad({ force: true });
  });
}

window.soaAnalytics = {
  ensureLoaded() {
    soaAnBind();
    soaAnSyncFilters();
    return soaAnLoad();
  },
  load(options) {
    soaAnBind();
    return soaAnLoad(options);
  },
};
