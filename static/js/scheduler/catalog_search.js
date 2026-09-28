// Shared PS / Ops search matching  used by the planner sidebar and board job search.
(function (root) {
  'use strict';

  function trialNormalizeSearchText(value) {
    return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function trialSearchableTokens(values) {
    const raw = (values || [])
      .map(value => String(value == null ? '' : value).trim())
      .filter(Boolean);
    const normalized = raw.map(trialNormalizeSearchText).filter(Boolean);
    return [...raw, ...normalized];
  }

  function trialStripSrSearchTag(value) {
    return String(value == null ? '' : value).replace(/\[sr\]/gi, '');
  }

  function trialUnpadSerial(serial) {
    return String(serial || '').replace(/^0+/, '') || '0';
  }

  const _PS_STANDARD_RE = /^(APS|NPS|PPS|CPS|MPS|SR)(\d{2})-(\d+)(?:-(\d+))?$/i;
  const _PS_COMPACT_RE = /^(APS|NPS|PPS|CPS|MPS|SR)(\d{2})(\d{3,})$/i;
  const _SR_INFIX_RE = /^([A-Z]{0,3})(\d{2})-\[SR\](\d+)(?:-(\d+))?$/i;
  const _SR_SHORT_RE = /^([A-Z]{1,3})(\d{2})-(\d+)(?:-(\d+))?$/i;

  function trialParsePsSearchIdentity(value) {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const body = raw
      .replace(/^\[(?:Temp|SR)\]\s*/ig, '')
      .split('::')[0]
      .trim();
    if (!body) return null;
    let match = body.match(_PS_STANDARD_RE);
    if (match) {
      return {
        prefix: match[1].toUpperCase(),
        year: match[2],
        serial: trialUnpadSerial(match[3]),
        child: match[4] || '',
      };
    }
    match = body.match(_SR_INFIX_RE);
    if (match) {
      return {
        prefix: (match[1] || '').toUpperCase(),
        year: match[2],
        serial: trialUnpadSerial(match[3]),
        child: match[4] || '',
      };
    }
    const compactBody = trialNormalizeSearchText(body);
    match = compactBody.match(_PS_COMPACT_RE);
    if (match) {
      return {
        prefix: match[1].toUpperCase(),
        year: match[2],
        serial: trialUnpadSerial(match[3]),
        child: '',
      };
    }
    const stripped = trialStripSrSearchTag(body).replace(/\s+/g, '');
    match = stripped.match(_SR_SHORT_RE);
    if (match && match[1].length <= 1) {
      return {
        prefix: match[1].toUpperCase(),
        year: match[2],
        serial: trialUnpadSerial(match[3]),
        child: match[4] || '',
      };
    }
    return null;
  }

  function trialPsIdentitiesMatch(queryId, tokenId) {
    if (!queryId || !tokenId) return false;
    if (queryId.serial !== tokenId.serial) return false;
    if (queryId.year && tokenId.year && queryId.year !== tokenId.year) return false;
    if (queryId.prefix && tokenId.prefix && queryId.prefix !== tokenId.prefix) return false;
    if (queryId.child && tokenId.child && queryId.child !== tokenId.child) return false;
    return true;
  }

  function trialDigitBoundaryMatch(token, digits) {
    const unpadded = trialUnpadSerial(digits);
    if (!/^\d+$/.test(unpadded)) return false;
    const pattern = new RegExp(`(?:^|\\D)0*${unpadded}(?!\\d)`);
    const text = String(token || '').toLowerCase();
    if (pattern.test(text)) return true;
    const normalized = trialNormalizeSearchText(token);
    return Boolean(normalized && pattern.test(normalized));
  }

  /** Kept for older callers; identity matching no longer relies on these extras. */
  function trialPsSerialSearchTokens(value) {
    const parsed = trialParsePsSearchIdentity(value);
    if (!parsed) return [];
    const extras = [parsed.serial];
    if (parsed.serial.length < 4) extras.push(parsed.serial.padStart(4, '0'));
    if (parsed.prefix && parsed.year) {
      extras.push(`${parsed.prefix}${parsed.year}-${parsed.serial}`);
      extras.push(`${parsed.prefix}${parsed.year}-${parsed.serial.padStart(4, '0')}`);
    }
    return extras;
  }

  function trialCatalogSearchQueryTerms(rawQuery) {
    return String(rawQuery || '')
      .trim()
      .toLowerCase()
      .split(/[\s,;]+/)
      .filter(Boolean);
  }

  function trialQueryLooksLikeBulkPsIds(terms) {
    return terms.length > 1 && terms.every(term =>
      /(?:aps|nps|pps|cps|mps|sr)\d{2}-\d+/i.test(term)
      || /\d{2}-\[sr\]\d+/i.test(term)
      || /\[sr\]/i.test(term)
    );
  }

  function trialFreeTextTokenMatch(token, term) {
    const text = String(token || '').toLowerCase();
    if (!text || !term) return false;
    if (text.includes(term)) return true;
    const normalized = trialNormalizeSearchText(token);
    const normalizedTerm = trialNormalizeSearchText(term);
    if (normalized && normalizedTerm && normalized.includes(normalizedTerm)) return true;
    const strippedText = trialStripSrSearchTag(text).replace(/\s+/g, '');
    const strippedTerm = trialStripSrSearchTag(term).replace(/\s+/g, '');
    return Boolean(strippedTerm && strippedText.includes(strippedTerm));
  }

  function trialTermMatchesTokens(tokens, term) {
    const list = tokens || [];
    const identity = trialParsePsSearchIdentity(term);
    if (identity && identity.prefix) {
      return list.some(token => trialPsIdentitiesMatch(identity, trialParsePsSearchIdentity(token)));
    }
    const shortPrefixYear = String(term || '').match(/^([an])(\d{2})$/i);
    if (shortPrefixYear) {
      const prefix = shortPrefixYear[1].toUpperCase();
      const year = shortPrefixYear[2];
      return list.some(token => {
        const tokenId = trialParsePsSearchIdentity(token);
        if (tokenId && tokenId.prefix === prefix && tokenId.year === year) return true;
        return trialFreeTextTokenMatch(token, term);
      });
    }
    if (/^\d+$/.test(term)) {
      const serial = trialUnpadSerial(term);
      return list.some(token => {
        const tokenId = trialParsePsSearchIdentity(token);
        if (tokenId && tokenId.serial === serial) return true;
        return trialDigitBoundaryMatch(token, term);
      });
    }
    return list.some(token => trialFreeTextTokenMatch(token, term));
  }

  function trialQueryMatchesSearchTokens(tokens, rawQuery) {
    const terms = trialCatalogSearchQueryTerms(rawQuery);
    if (!terms.length) return true;
    const matchTerm = term => trialTermMatchesTokens(tokens, term);
    return trialQueryLooksLikeBulkPsIds(terms)
      ? terms.some(matchTerm)
      : terms.every(matchTerm);
  }

  function trialCatalogPsBareId(value) {
    return String(value || '').split('::')[0].trim();
  }

  function trialIsComponentChildPs(psId) {
    const raw = trialCatalogPsBareId(psId);
    return (raw.match(/-/g) || []).length >= 2 && /-\d+$/.test(raw);
  }

  function trialParentPsIdFromChild(psId) {
    const raw = trialCatalogPsBareId(psId);
    if (!trialIsComponentChildPs(raw)) return '';
    return raw.replace(/-\d+$/, '');
  }

  function trialCatalogRowSourceId(ps) {
    return trialCatalogPsBareId(ps?.source_ps_id || ps?.ps_id).toUpperCase();
  }

  function trialCatalogNestedChildIds(ps) {
    const ids = new Set();
    const items = Array.isArray(ps?.assembly_line_items) ? ps.assembly_line_items : [];
    for (const item of items) {
      for (const value of [
        item?.process_sheet_no,
        item?.ps_id,
        item?.source_ps_id,
        item?.display_ps_id,
      ]) {
        const id = trialCatalogPsBareId(value).toUpperCase();
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  /** Drop COMP children that are already nested under a visible parent card. */
  function trialCatalogExcludeNestedChildren(rows) {
    const list = Array.isArray(rows) ? rows : [];
    const nestedIds = new Set();
    for (const ps of list) {
      for (const id of trialCatalogNestedChildIds(ps)) nestedIds.add(id);
    }
    if (!nestedIds.size) return list;
    return list.filter(ps => {
      const id = trialCatalogRowSourceId(ps);
      if (!id || !trialIsComponentChildPs(id)) return true;
      return !nestedIds.has(id);
    });
  }

  /** True when search is aimed at this child sheet, not only the parent family. */
  function trialCatalogLineItemIsSearchTarget(psNo, rawQuery) {
    const q = String(rawQuery || '').trim().toLowerCase();
    const id = trialCatalogPsBareId(psNo).toLowerCase();
    if (!q || !id) return false;
    if (id === q) return true;
    if (id.startsWith(q)) return false;
    return id.includes(q) && /-\d+$/.test(q);
  }

  const api = {
    trialNormalizeSearchText,
    trialSearchableTokens,
    trialStripSrSearchTag,
    trialParsePsSearchIdentity,
    trialPsSerialSearchTokens,
    trialCatalogSearchQueryTerms,
    trialQueryMatchesSearchTokens,
    trialIsComponentChildPs,
    trialParentPsIdFromChild,
    trialCatalogExcludeNestedChildren,
    trialCatalogLineItemIsSearchTarget,
  };
  Object.assign(root, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
