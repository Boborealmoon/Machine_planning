// Shared repeat-order tagging (same part_no = repeat; exclude same sales order).

function repeatOrderPsBase(value) {
  return String(value || '').split('::')[0].trim();
}

function repeatOrderBuildSoPsMap(items, soKey, psKey) {
  const map = new Map();
  (items || []).forEach((item) => {
    const soNo = String(soKey(item) || '').trim();
    const ps = repeatOrderPsBase(psKey(item));
    if (!soNo || !ps) return;
    if (!map.has(soNo)) map.set(soNo, new Set());
    map.get(soNo).add(ps);
  });
  return map;
}

function repeatOrderExcludeSameOrderPs(row, similar, soPsMap, soKey) {
  const soNo = String(soKey(row) || '').trim();
  const skip = soPsMap.get(soNo) || new Set();
  const seen = new Set();
  const out = [];
  (similar || []).forEach((value) => {
    const ps = repeatOrderPsBase(value);
    if (!ps || skip.has(ps) || seen.has(ps)) return;
    seen.add(ps);
    out.push(ps);
  });
  return out;
}

function repeatOrderGroupsForPart(row, repeatGroups, partKey) {
  const part = String(partKey(row) || '').trim();
  if (!part) return [];
  return (repeatGroups || []).filter(
    (group) => String(group.part_no || '').trim() === part,
  );
}

function repeatOrderSimilarFromGroups(row, groups, soPsMap, soKey) {
  const similar = [];
  (groups || []).forEach((group) => {
    (group.orders || []).forEach((order) => {
      const ps = repeatOrderPsBase(order.ps_id);
      if (ps) similar.push(ps);
    });
  });
  return repeatOrderExcludeSameOrderPs(row, similar, soPsMap, soKey);
}

function repeatOrderSimilarList(row, repeatGroups, soPsMap, keys) {
  const { soKey, partKey, psKey, similarKey } = keys;
  const raw = row?.[similarKey || 'similar_ps'];
  if (Array.isArray(raw) && raw.length) {
    const seen = new Set();
    const parsed = [];
    raw.forEach((value) => {
      const ps = repeatOrderPsBase(value);
      if (!ps || seen.has(ps)) return;
      seen.add(ps);
      parsed.push(ps);
    });
    return repeatOrderExcludeSameOrderPs(row, parsed, soPsMap, soKey);
  }

  let groups = repeatOrderGroupsForPart(row, repeatGroups, partKey);
  if (!groups.length) {
    const psCurrent = repeatOrderPsBase(psKey(row));
    if (psCurrent) {
      const match = (repeatGroups || []).find((group) =>
        (group.orders || []).some((order) => repeatOrderPsBase(order.ps_id) === psCurrent),
      );
      if (match) groups = [match];
    }
  }
  return groups.length ? repeatOrderSimilarFromGroups(row, groups, soPsMap, soKey) : [];
}

function repeatOrderSlotWithList(options = {}) {
  const raw = options.slotWith || options.queuedInPlanner || options.queuedPs || [];
  const seen = new Set();
  const out = [];
  (Array.isArray(raw) ? raw : []).forEach((value) => {
    const ps = repeatOrderPsBase(value);
    if (!ps || seen.has(ps)) return;
    seen.add(ps);
    out.push(ps);
  });
  return out;
}

function repeatOrderRenderPill(similar, options = {}) {
  const hasHistory = Array.isArray(similar) && similar.length > 0;
  const slotWith = repeatOrderSlotWithList(options);
  const requireQueued = Boolean(options.requireQueued);

  if (requireQueued) {
    if (!hasHistory || !slotWith.length) return '';
    const preview = slotWith.slice(0, 3).join(', ');
    const overflow = slotWith.length > 3 ? ` +${slotWith.length - 3} more` : '';
    const title = `Repeat order — same part already queued on planner: ${slotWith.join(', ')}`;
    return `
      <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
        <span class="new-orders-repeat-badge">Repeat</span>
        <span class="new-orders-repeat-ref">Slot with ${escapeHtml(preview)}${escapeHtml(overflow)}</span>
      </div>
    `;
  }

  if (!hasHistory) return '';
  const preview = similar.slice(0, 3).join(', ');
  const overflow = similar.length > 3 ? ` +${similar.length - 3} more` : '';
  const title = `Repeat order — previous PS: ${similar.join(', ')}`;
  return `
    <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
      <span class="new-orders-repeat-badge">Repeat</span>
      <span class="new-orders-repeat-ref">Similar to ${escapeHtml(preview)}${escapeHtml(overflow)}</span>
    </div>
  `;
}

function repeatOrderDetailHtml(similar, options = {}) {
  const pill = repeatOrderRenderPill(similar, options);
  if (!pill) return '';
  return `
    <div class="new-orders-detail-field new-orders-detail-field--repeat">
      <dt>Repeat order</dt>
      <dd class="new-orders-detail-value new-orders-detail-value--repeat">${pill}</dd>
    </div>
  `;
}
