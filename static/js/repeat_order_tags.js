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

function repeatOrderFormatPsList(list, max = 3) {
  const items = (Array.isArray(list) ? list : []).slice(0, max);
  const overflow = (Array.isArray(list) ? list : []).length > max ? ` +${list.length - max} more` : '';
  return { preview: items.join(', '), overflow };
}

function repeatOrderRenderPill(similar, options = {}) {
  const hasHistory = Array.isArray(similar) && similar.length > 0;
  const slotWith = repeatOrderSlotWithList(options);
  const requireQueued = Boolean(options.requireQueued);

  if (requireQueued) {
    if (!hasHistory || !slotWith.length) return '';
    const { preview, overflow } = repeatOrderFormatPsList(slotWith);
    const title = `Repeat order — same part already queued on planner: ${slotWith.join(', ')}`;
    return `
      <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
        <span class="new-orders-repeat-badge">Repeat</span>
        <span class="new-orders-repeat-ref">Slot with ${escapeHtml(preview)}${escapeHtml(overflow)}</span>
      </div>
    `;
  }

  if (!hasHistory) return '';
  const { preview, overflow } = repeatOrderFormatPsList(similar);
  const title = `Repeat order — previous PS: ${similar.join(', ')}`;
  return `
    <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
      <span class="new-orders-repeat-badge">Repeat</span>
      <span class="new-orders-repeat-ref">Similar to ${escapeHtml(preview)}${escapeHtml(overflow)}</span>
    </div>
  `;
}

function repeatOrderRenderNewOrdersHints(row, similar, options = {}) {
  const parts = [];
  const crossSlot = repeatOrderSlotWithList({ slotWith: options.slotWith || row?.queued_in_planner });
  const soSlot = repeatOrderSlotWithList({ slotWith: options.slotWithSameSo || row?.queued_in_so });
  const sameSoAll = repeatOrderSlotWithList({ slotWith: row?.same_so_similar_ps || options.sameSoSimilar });
  const sameSoOnly = sameSoAll.filter((ps) => !soSlot.includes(ps));
  const similarList = Array.isArray(similar) ? similar : [];
  const plannerQueued = Boolean(row?.planner_queued ?? options.plannerQueued);

  if (similarList.length && crossSlot.length) {
    const { preview, overflow } = repeatOrderFormatPsList(crossSlot);
    const title = `Repeat — same part from other sales orders already on the planner: ${crossSlot.join(', ')}. Consider batching/slotting together.`;
    parts.push(`
      <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
        <span class="new-orders-repeat-badge">Repeat</span>
        <span class="new-orders-repeat-ref">Slot with ${escapeHtml(preview)}${escapeHtml(overflow)} <span class="new-orders-repeat-scope">· other orders</span></span>
      </div>
    `);
  }

  if (soSlot.length) {
    const { preview, overflow } = repeatOrderFormatPsList(soSlot);
    const title = `Same order — same part on another line of this sales order, already on the planner: ${soSlot.join(', ')}.`;
    parts.push(`
      <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
        <span class="new-orders-repeat-badge new-orders-repeat-badge--same-so">Same order</span>
        <span class="new-orders-repeat-ref new-orders-repeat-ref--same-so">Slot with ${escapeHtml(preview)}${escapeHtml(overflow)} <span class="new-orders-repeat-scope">· this order</span></span>
      </div>
    `);
  } else if (sameSoOnly.length) {
    const { preview, overflow } = repeatOrderFormatPsList(sameSoOnly);
    const title = `Same order — same part appears on another line of this sales order: ${sameSoOnly.join(', ')}.`;
    parts.push(`
      <div class="new-orders-repeat-wrap" title="${escapeHtml(title)}">
        <span class="new-orders-repeat-badge new-orders-repeat-badge--same-so">Same order</span>
        <span class="new-orders-repeat-ref new-orders-repeat-ref--same-so">Also on ${escapeHtml(preview)}${escapeHtml(overflow)} <span class="new-orders-repeat-scope">· this order</span></span>
      </div>
    `);
  }

  if (plannerQueued) {
    parts.push(`
      <div class="new-orders-repeat-wrap" title="This process sheet is already on the production queue">
        <span class="new-orders-repeat-badge new-orders-repeat-badge--queued">Queued</span>
      </div>
    `);
  }

  return parts.join('');
}

function repeatOrderNewOrdersDetailHtml(row, similar, options = {}) {
  const pill = repeatOrderRenderNewOrdersHints(row, similar, options);
  if (!pill) return '';
  return `
    <div class="new-orders-detail-field new-orders-detail-field--repeat">
      <dt>Queue hints</dt>
      <dd class="new-orders-detail-value new-orders-detail-value--repeat">${pill}</dd>
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
