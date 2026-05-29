// Program / Tool List matching for scheduler op cards (loaded via /api/program-tool-list/lookup).

function trialNormalizePsId(value) {
  let text = String(value || '').trim().toUpperCase();
  if (text.includes('::')) text = text.split('::', 1)[0];
  return text.replace(/\s+/g, '');
}

function trialNormalizePartNo(value) {
  return String(value || '').trim().toUpperCase().replace(/\s+/g, '');
}

function trialNormalizeOpNo(...candidates) {
  for (const raw of candidates) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const tail = text.match(/(\d+)\s*$/);
    if (tail) {
      const digits = tail[1].replace(/^0+/, '');
      return digits || '0';
    }
    const head = text.match(/^(\d+)/);
    if (head) {
      const digits = head[1].replace(/^0+/, '');
      return digits || '0';
    }
  }
  return '';
}

function trialProgramToolsLookup(card) {
  const lookup = trialState.program_tools_lookup;
  if (!lookup) return null;

  const psId = card.source_ps_id || card.ps_id || '';
  const partNo = card.part_no || card.part_name || '';
  const opCandidates = [
    card.source_op_no,
    card.operation_label,
    card.operation_name,
    card.op_type,
  ];

  const ps = trialNormalizePsId(psId);
  const op = trialNormalizeOpNo(...opCandidates);
  if (ps && op) {
    const hit = lookup.by_ps_op?.[`${ps}|${op}`];
    if (hit) return hit;
  }

  const part = trialNormalizePartNo(partNo);
  if (part && op) {
    return lookup.by_part_op?.[`PART|${part}|${op}`] || null;
  }
  return null;
}

function trialProgramNoHtml(value) {
  const text = String(value || '').trim();
  return text
    ? `<span class="trial-ptl-program-no">${escapeHtml(text)}</span>`
    : '<span class="trial-ptl-muted">—</span>';
}

function trialProgramToolsLinkHtml(url, notReadyLabel) {
  const href = String(url || '').trim();
  if (href && /^https?:\/\//i.test(href)) {
    return `<a class="trial-ptl-link" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">View</a>`;
  }
  return `<span class="trial-ptl-not-ready">${escapeHtml(notReadyLabel)}</span>`;
}

function trialProgramToolsBlockHtml(card) {
  const row = trialProgramToolsLookup(card);
  if (!row) {
    return `
      <div class="trial-program-tools trial-program-tools--missing">
        <div class="trial-program-tools-row"><span class="trial-program-tools-label">Program no.</span> ${trialProgramNoHtml('')}</div>
        <div class="trial-program-tools-row"><span class="trial-program-tools-label">Programme</span> ${trialProgramToolsLinkHtml('', 'Programme not ready')}</div>
        <div class="trial-program-tools-row"><span class="trial-program-tools-label">Tool list</span> ${trialProgramToolsLinkHtml('', 'Tool list not ready')}</div>
        <div class="trial-program-tools-row"><span class="trial-program-tools-label">Programmer</span> <span class="trial-ptl-muted">—</span></div>
      </div>`;
  }

  const programmer = String(row.programmer_name || '').trim();
  const programmerHtml = programmer
    ? `<span class="trial-ptl-programmer">${escapeHtml(programmer)}</span>`
    : '<span class="trial-ptl-muted">—</span>';

  return `
    <div class="trial-program-tools">
      <div class="trial-program-tools-row">
        <span class="trial-program-tools-label">Program no.</span>
        ${trialProgramNoHtml(row.program_no)}
      </div>
      <div class="trial-program-tools-row">
        <span class="trial-program-tools-label">Programme</span>
        ${trialProgramToolsLinkHtml(row.program_file, 'Programme not ready')}
      </div>
      <div class="trial-program-tools-row">
        <span class="trial-program-tools-label">Tool list</span>
        ${trialProgramToolsLinkHtml(row.tool_list_files, 'Tool list not ready')}
      </div>
      <div class="trial-program-tools-row">
        <span class="trial-program-tools-label">Programmer</span>
        ${programmerHtml}
      </div>
    </div>`;
}

function trialProgramToolsCompactHtml(card) {
  const row = trialProgramToolsLookup(card);
  if (!row) {
    return '<span class="trial-program-tools-compact trial-ptl-muted">No program data</span>';
  }
  const programmer = String(row.programmer_name || '').trim();
  const parts = [
    trialProgramNoHtml(row.program_no),
    trialProgramToolsLinkHtml(row.program_file, 'Prog'),
    trialProgramToolsLinkHtml(row.tool_list_files, 'Tools'),
  ];
  if (programmer) {
    parts.push(`<span class="trial-ptl-programmer" title="Programmer">${escapeHtml(programmer)}</span>`);
  }
  return `<div class="trial-program-tools-compact">${parts.join('<span class="trial-ptl-sep" aria-hidden="true">·</span>')}</div>`;
}
