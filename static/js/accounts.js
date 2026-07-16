(function accountsAppInit() {
  'use strict';

  const state = {
    section: 'credit-notes',
    bucket: 'posted',
    items: [],
    summary: null,
    newCount: null,
    outstandingCount: null,
    postedCount: null,
    loading: false,
    selectedNote: null,
    detail: null,
    detailLoading: false,
    filterTimer: null,
    soaPeriods: [],
    soaPeriodKey: '',
    soaCustomers: [],
    soaSelectedKey: '',
    soaStatement: null,
    soaLoadingCustomers: false,
    soaLoadingStatement: false,
  };

  const els = {
    stats: document.getElementById('ar-stats'),
    sectionLinks: Array.from(document.querySelectorAll('[data-ar-section]')),
    sectionCreditNotes: document.getElementById('ar-section-credit-notes'),
    sectionSoa: document.getElementById('ar-section-soa'),
    countNew: document.getElementById('ar-count-new'),
    countOutstanding: document.getElementById('ar-count-outstanding'),
    countPosted: document.getElementById('ar-count-posted'),
    summary: document.getElementById('ar-summary'),
    summaryCount: document.getElementById('ar-summary-count'),
    summaryCustomers: document.getElementById('ar-summary-customers'),
    summaryTotals: document.getElementById('ar-summary-totals'),
    tabs: Array.from(document.querySelectorAll('[data-ar-bucket]')),
    search: document.getElementById('ar-search'),
    customer: document.getElementById('ar-customer'),
    currency: document.getElementById('ar-currency'),
    dateFrom: document.getElementById('ar-date-from'),
    dateTo: document.getElementById('ar-date-to'),
    loading: document.getElementById('ar-loading'),
    tableWrap: document.getElementById('ar-table-wrap'),
    tableBody: document.getElementById('ar-table-body'),
    empty: document.getElementById('ar-empty'),
    refresh: document.getElementById('ar-refresh'),
    clearFilters: document.getElementById('ar-clear-filters'),
    detail: document.getElementById('ar-detail'),
    detailBucket: document.getElementById('ar-detail-bucket'),
    detailTitle: document.getElementById('ar-detail-title'),
    detailMeta: document.getElementById('ar-detail-meta'),
    detailFields: document.getElementById('ar-detail-fields'),
    detailLoading: document.getElementById('ar-detail-loading'),
    detailBody: document.getElementById('ar-detail-body'),
    detailClose: document.getElementById('ar-detail-close'),
    linesBody: document.getElementById('ar-lines-body'),
    linesEmpty: document.getElementById('ar-lines-empty'),
    soaPeriod: document.getElementById('ar-soa-period'),
    soaCustomer: document.getElementById('ar-soa-customer'),
    soaCurrency: document.getElementById('ar-soa-currency'),
    soaCustomerMeta: document.getElementById('ar-soa-customer-meta'),
    soaCustomersLoading: document.getElementById('ar-soa-customers-loading'),
    soaCustomersWrap: document.getElementById('ar-soa-customers-wrap'),
    soaCustomersBody: document.getElementById('ar-soa-customers-body'),
    soaCustomersEmpty: document.getElementById('ar-soa-customers-empty'),
    soaStatementPlaceholder: document.getElementById('ar-soa-statement-placeholder'),
    soaStatementLoading: document.getElementById('ar-soa-statement-loading'),
    soaStatementBody: document.getElementById('ar-soa-statement-body'),
    soaStatementPeriod: document.getElementById('ar-soa-statement-period'),
    soaStatementParty: document.getElementById('ar-soa-statement-party'),
    soaStatementAddress: document.getElementById('ar-soa-statement-address'),
    soaOpeningBalance: document.getElementById('ar-soa-opening-balance'),
    soaClosingBalance: document.getElementById('ar-soa-closing-balance'),
    soaLinesBody: document.getElementById('ar-soa-lines-body'),
    soaLinesEmpty: document.getElementById('ar-soa-lines-empty'),
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function compact(value) {
    return String(value ?? '').trim();
  }

  function formatMoney(value, currency) {
    const num = Number(value);
    if (!Number.isFinite(num)) return '-';
    const formatted = num.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return currency ? `${formatted} ${currency}` : formatted;
  }

  function formatDate(value) {
    const text = compact(value);
    if (!text) return '-';
    return text.slice(0, 10);
  }

  const BUCKET_LABELS = {
    new: 'New',
    outstanding: 'Outstanding',
    posted: 'Posted',
  };

  function bucketLabel(bucket) {
    return BUCKET_LABELS[bucket] || bucket;
  }

  function periodKey(year, period) {
    return `${year}:${period}`;
  }

  function parsePeriodKey(key) {
    const [year, period] = String(key || '').split(':');
    return { year: Number(year), period: Number(period) };
  }

  function customerKey(customerCode, currencyCode) {
    return `${customerCode}::${currencyCode}`;
  }

  function selectedPeriod() {
    return parsePeriodKey(state.soaPeriodKey);
  }

  function queryParams(refresh) {
    const params = new URLSearchParams();
    params.set('bucket', state.bucket);
    if (refresh) params.set('refresh', '1');
    if (compact(els.search.value)) params.set('q', els.search.value.trim());
    if (compact(els.customer.value)) params.set('customer', els.customer.value.trim());
    if (compact(els.currency.value)) params.set('currency', els.currency.value);
    if (compact(els.dateFrom.value)) params.set('from', els.dateFrom.value);
    if (compact(els.dateTo.value)) params.set('to', els.dateTo.value);
    return params;
  }

  function updateTabCounts() {
    if (state.newCount != null) els.countNew.textContent = String(state.newCount);
    if (state.outstandingCount != null) els.countOutstanding.textContent = String(state.outstandingCount);
    if (state.postedCount != null) els.countPosted.textContent = String(state.postedCount);
  }

  function renderSummary() {
    const summary = state.summary;
    if (!summary) {
      els.summary.hidden = true;
      return;
    }
    els.summary.hidden = false;
    els.summaryCount.textContent = String(summary.count || 0);
    els.summaryCustomers.textContent = String(summary.customer_count || 0);
    const totals = (summary.currency_totals || [])
      .map((row) => formatMoney(row.total_after_tax_amt, row.currency_code))
      .join(' | ');
    els.summaryTotals.textContent = totals || '-';
  }

  function rebuildCurrencyOptions(selectEl, items, valueKey) {
    const current = selectEl.value;
    const codes = new Set();
    items.forEach((item) => {
      const code = compact(item[valueKey]);
      if (code) codes.add(code);
    });
    const sorted = Array.from(codes).sort();
    selectEl.innerHTML = '<option value="">All</option>'
      + sorted.map((code) => `<option value="${escapeHtml(code)}">${escapeHtml(code)}</option>`).join('');
    if (current && sorted.includes(current)) {
      selectEl.value = current;
    }
  }

  function appliedAmount(item) {
    if (state.bucket === 'new') {
      return item.unposted_applied_inv_amt;
    }
    return item.total_applied_inv_amt;
  }

  function sourceLabel(item) {
    const parts = [];
    if (compact(item.source_voucher_no)) parts.push(`Source: ${item.source_voucher_no}`);
    if (compact(item.reversed_invoice_no)) parts.push(`Invoice: ${item.reversed_invoice_no}`);
    return parts.join(' | ') || '-';
  }

  function renderTable() {
    const items = state.items;
    rebuildCurrencyOptions(els.currency, items, 'currency_code');

    if (!items.length) {
      els.tableWrap.hidden = true;
      els.empty.hidden = false;
      return;
    }

    els.empty.hidden = true;
    els.tableWrap.hidden = false;
    els.tableBody.innerHTML = items.map((item) => {
      const selected = state.selectedNote === item.credit_note_no ? ' is-selected' : '';
      const customer = compact(item.customer_name)
        ? `${item.customer_code} - ${item.customer_name}`
        : (item.customer_code || '-');
      return `
        <tr data-note="${escapeHtml(item.credit_note_no)}" class="${selected.trim()}">
          <td><span class="ar-cell-main">${escapeHtml(item.credit_note_no)}</span></td>
          <td>${escapeHtml(formatDate(item.credit_note_date))}</td>
          <td>
            <span class="ar-cell-main">${escapeHtml(customer)}</span>
            ${item.customer_po_no ? `<span class="ar-cell-sub">PO ${escapeHtml(item.customer_po_no)}</span>` : ''}
          </td>
          <td>${escapeHtml(item.credit_note_type_label || item.credit_note_type || '-')}</td>
          <td class="ar-col-num">${escapeHtml(item.line_count ?? 0)}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(item.total_pre_tax_amt, ''))}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(item.total_after_tax_amt, ''))}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(appliedAmount(item), ''))}</td>
          <td>${escapeHtml(item.currency_code || '-')}</td>
          <td>${escapeHtml(sourceLabel(item))}</td>
        </tr>
      `;
    }).join('');
  }

  function detailField(label, value) {
    const text = compact(value);
    if (!text) return '';
    return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(text)}</dd></div>`;
  }

  function renderDetail() {
    const detail = state.detail;
    if (!detail || !detail.header) {
      els.detail.hidden = true;
      return;
    }

    els.detail.hidden = false;
    const header = detail.header;
    els.detailBucket.textContent = bucketLabel(detail.bucket);
    els.detailTitle.textContent = header.credit_note_no || '-';
    const metaParts = [
      formatDate(header.credit_note_date),
      header.customer_code,
      header.customer_name,
    ].filter(Boolean);
    els.detailMeta.textContent = metaParts.join(' | ');

    const fields = [
      detailField('Type', header.credit_note_type_label || header.credit_note_type),
      detailField('Category', header.crn_category_code),
      detailField('Currency', header.currency_code),
      detailField('Exchange rate', header.exch_rate),
      detailField('Reference', header.reference_no),
      detailField('Customer PO', header.customer_po_no),
      detailField('Sales person', header.sales_person_code),
      detailField('SBU', header.sbu_code),
      detailField('Location', header.location_code),
      detailField('Payment option', header.payment_option_code),
      detailField('Billing party', header.billing_party_code),
      detailField('Project', header.project_no),
      detailField('Source voucher', header.source_voucher_no),
      detailField('Reversed invoice', header.reversed_invoice_no),
      detailField('Pre-tax total', formatMoney(header.total_pre_tax_amt, header.currency_code)),
      detailField('After-tax total', formatMoney(header.total_after_tax_amt, header.currency_code)),
      detailField('Applied to invoice', formatMoney(header.total_applied_inv_amt, header.currency_code)),
      detailField('Unposted applied', formatMoney(header.unposted_applied_inv_amt, header.currency_code)),
      detailField('Posted', header.posted_datetime ? `${formatDate(header.posted_date)} by ${header.posted_by || '-'}` : ''),
      detailField('Created', header.created_datetime),
      detailField('Remarks', header.remarks),
      detailField('Customer remarks', header.remarks_to_customer),
      detailField('External remarks', header.external_remarks),
      detailField('Justification', header.credit_note_justification),
    ].filter(Boolean).join('');

    els.detailFields.innerHTML = fields;

    const lines = detail.lines || [];
    els.detailLoading.hidden = true;
    els.detailBody.hidden = false;
    if (!lines.length) {
      els.linesBody.innerHTML = '';
      els.linesEmpty.hidden = false;
      return;
    }

    els.linesEmpty.hidden = true;
    els.linesBody.innerHTML = lines.map((line) => {
      const part = compact(line.inventory_code) || compact(line.service_code) || '-';
      return `
        <tr>
          <td>${escapeHtml(line.line_item_no ?? '-')}</td>
          <td>${escapeHtml(part)}</td>
          <td>${escapeHtml(line.line_item_description || '-')}</td>
          <td class="ar-col-num">${escapeHtml(line.display_qty ?? line.qty ?? '-')}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(line.display_unit_price ?? line.base_unit_selling_price, ''))}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(line.pre_tax_extended_amt, ''))}</td>
          <td>${escapeHtml(line.invoice_no || line.ar_invoice_no || '-')}</td>
          <td>${escapeHtml(line.sales_order_no || '-')}</td>
        </tr>
      `;
    }).join('');
  }

  function setLoading(loading) {
    state.loading = loading;
    els.loading.hidden = !loading;
    if (loading) {
      els.tableWrap.hidden = true;
      els.empty.hidden = true;
    }
  }

  async function loadSummaryCounts(refresh) {
    const suffix = refresh ? '?refresh=1' : '';
    const response = await fetch(`/api/accounts/summary${suffix}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to load summary');
    }
    state.newCount = payload.new?.count ?? 0;
    state.outstandingCount = payload.outstanding?.count ?? 0;
    state.postedCount = payload.posted?.count ?? 0;
    updateTabCounts();
  }

  async function loadList({ refresh = false } = {}) {
    setLoading(true);
    try {
      const params = queryParams(refresh);
      const response = await fetch(`/api/accounts/credit-notes?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Failed to load credit notes');
      }
      state.items = payload.items || [];
      state.summary = payload.summary || null;
      if (state.bucket === 'new') state.newCount = state.summary.count;
      if (state.bucket === 'outstanding') state.outstandingCount = state.summary.count;
      if (state.bucket === 'posted') state.postedCount = state.summary.count;
      updateTabCounts();
      renderSummary();
      renderTable();
      if (state.section === 'credit-notes') {
        els.stats.textContent = `${state.summary?.count || 0} ${bucketLabel(state.bucket).toLowerCase()} credit notes loaded from ERP`;
      }
    } catch (error) {
      if (state.section === 'credit-notes') {
        els.stats.textContent = error.message || 'Failed to load credit notes';
      }
      state.items = [];
      renderTable();
    } finally {
      setLoading(false);
    }
  }

  async function loadDetail(creditNoteNo) {
    state.selectedNote = creditNoteNo;
    state.detail = null;
    state.detailLoading = true;
    els.detail.hidden = false;
    els.detailLoading.hidden = false;
    els.detailBody.hidden = true;
    renderTable();

    try {
      const params = new URLSearchParams({ bucket: state.bucket });
      const response = await fetch(`/api/accounts/credit-notes/${encodeURIComponent(creditNoteNo)}?${params}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Failed to load credit note detail');
      }
      state.detail = payload;
      renderDetail();
    } catch (error) {
      els.detailMeta.textContent = error.message || 'Failed to load detail';
      els.detailLoading.hidden = true;
      els.detailBody.hidden = true;
    } finally {
      state.detailLoading = false;
    }
  }

  function setBucket(bucket) {
    state.bucket = bucket;
    state.selectedNote = null;
    state.detail = null;
    els.detail.hidden = true;
    els.tabs.forEach((tab) => {
      const active = tab.dataset.arBucket === bucket;
      tab.classList.toggle('is-active', active);
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    loadList();
  }

  function scheduleFilterReload() {
    window.clearTimeout(state.filterTimer);
    state.filterTimer = window.setTimeout(() => loadList(), 250);
  }

  function clearCreditNoteFilters() {
    els.search.value = '';
    els.customer.value = '';
    els.currency.value = '';
    els.dateFrom.value = '';
    els.dateTo.value = '';
    loadList();
  }

  function renderSoaPeriodOptions() {
    const current = state.soaPeriodKey;
    els.soaPeriod.innerHTML = state.soaPeriods.map((period) => {
      const key = periodKey(period.financial_year, period.financial_period);
      const close = period.period_closing_date ? ` (close ${period.period_closing_date})` : '';
      const label = `${period.label}${close} - ${period.customer_count} customers`;
      return `<option value="${escapeHtml(key)}">${escapeHtml(label)}</option>`;
    }).join('');
    if (current && state.soaPeriods.some((p) => periodKey(p.financial_year, p.financial_period) === current)) {
      els.soaPeriod.value = current;
    } else if (state.soaPeriods.length) {
      const first = state.soaPeriods[0];
      state.soaPeriodKey = periodKey(first.financial_year, first.financial_period);
      els.soaPeriod.value = state.soaPeriodKey;
    }
  }

  function renderSoaCustomers() {
    const items = state.soaCustomers;
    rebuildCurrencyOptions(els.soaCurrency, items, 'currency_code');
    els.soaCustomersLoading.hidden = true;

    const { year, period } = selectedPeriod();
    els.soaCustomerMeta.textContent = items.length
      ? `${items.length} customer(s) for ${year}/${String(period).padStart(2, '0')}`
      : 'No customers for this period';

    if (!items.length) {
      els.soaCustomersWrap.hidden = true;
      els.soaCustomersEmpty.hidden = false;
      return;
    }

    els.soaCustomersEmpty.hidden = true;
    els.soaCustomersWrap.hidden = false;
    els.soaCustomersBody.innerHTML = items.map((item) => {
      const key = customerKey(item.customer_code, item.currency_code);
      const selected = state.soaSelectedKey === key ? ' is-selected' : '';
      const name = compact(item.party_name) ? `${item.customer_code} - ${item.party_name}` : item.customer_code;
      return `
        <tr data-soa-customer="${escapeHtml(key)}" class="${selected.trim()}">
          <td><span class="ar-cell-main">${escapeHtml(name)}</span></td>
          <td>${escapeHtml(item.currency_code || '-')}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(item.closing_balance, item.currency_code))}</td>
        </tr>
      `;
    }).join('');
  }

  function renderSoaStatement() {
    const statement = state.soaStatement;
    els.soaStatementLoading.hidden = true;

    if (!statement) {
      els.soaStatementPlaceholder.hidden = false;
      els.soaStatementBody.hidden = true;
      return;
    }

    els.soaStatementPlaceholder.hidden = true;
    els.soaStatementBody.hidden = false;

    const periodLabel = `${statement.financial_year}/${String(statement.financial_period).padStart(2, '0')}`;
    const close = statement.period_closing_date ? ` - close ${statement.period_closing_date}` : '';
    els.soaStatementPeriod.textContent = `Period ${periodLabel}${close}`;
    els.soaStatementParty.textContent = `${statement.customer_code} - ${statement.party_name || 'Customer'}`;
    const addressParts = [
      statement.address,
      statement.postal_zip_code,
      statement.country_name,
    ].filter(compact);
    els.soaStatementAddress.textContent = addressParts.join('\n');
    els.soaOpeningBalance.textContent = formatMoney(statement.opening_balance, statement.currency_code);
    els.soaClosingBalance.textContent = formatMoney(statement.closing_balance, statement.currency_code);

    const lines = statement.lines || [];
    if (!lines.length) {
      els.soaLinesBody.innerHTML = '';
      els.soaLinesEmpty.hidden = false;
      return;
    }

    els.soaLinesEmpty.hidden = true;
    els.soaLinesBody.innerHTML = lines.map((line) => {
      const poRemarks = [line.customer_po_no, line.remarks].filter(compact).join(' | ');
      return `
        <tr>
          <td>${escapeHtml(formatDate(line.voucher_date))}</td>
          <td>${escapeHtml(formatDate(line.due_date))}</td>
          <td>${escapeHtml(line.transaction_type || '-')}</td>
          <td><span class="ar-cell-main">${escapeHtml(line.document_no || '-')}</span></td>
          <td class="ar-col-num">${escapeHtml(line.debit_amt != null ? formatMoney(line.debit_amt, '') : '-')}</td>
          <td class="ar-col-num">${escapeHtml(line.credit_amt != null ? formatMoney(line.credit_amt, '') : '-')}</td>
          <td class="ar-col-num">${escapeHtml(formatMoney(line.balance, ''))}</td>
          <td>${escapeHtml(poRemarks || '-')}</td>
        </tr>
      `;
    }).join('');

    if (state.section === 'soa') {
      els.stats.textContent = `${lines.length} transaction(s) on statement for ${statement.customer_code} (${statement.currency_code})`;
    }
  }

  async function loadSoaPeriods(refresh) {
    const suffix = refresh ? '?refresh=1' : '';
    const response = await fetch(`/api/accounts/soa/periods${suffix}`);
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || 'Failed to load SOA periods');
    }
    state.soaPeriods = payload.periods || [];
    renderSoaPeriodOptions();
  }

  async function loadSoaCustomers({ refresh = false } = {}) {
    const { year, period } = selectedPeriod();
    if (!year || !period) return;

    state.soaLoadingCustomers = true;
    state.soaSelectedKey = '';
    state.soaStatement = null;
    renderSoaStatement();
    els.soaCustomersLoading.hidden = false;
    els.soaCustomersWrap.hidden = true;
    els.soaCustomersEmpty.hidden = true;

    try {
      const params = new URLSearchParams({
        year: String(year),
        period: String(period),
      });
      if (refresh) params.set('refresh', '1');
      if (compact(els.soaCustomer.value)) params.set('q', els.soaCustomer.value.trim());
      if (compact(els.soaCurrency.value)) params.set('currency', els.soaCurrency.value);

      const response = await fetch(`/api/accounts/soa/customers?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Failed to load SOA customers');
      }
      state.soaCustomers = payload.items || [];
      renderSoaCustomers();
      if (state.section === 'soa') {
        els.stats.textContent = `${state.soaCustomers.length} customer statement(s) available for ${year}/${String(period).padStart(2, '0')}`;
      }
    } catch (error) {
      if (state.section === 'soa') {
        els.stats.textContent = error.message || 'Failed to load SOA customers';
      }
      state.soaCustomers = [];
      renderSoaCustomers();
    } finally {
      state.soaLoadingCustomers = false;
    }
  }

  async function loadSoaStatement(customerCode, currencyCode) {
    const { year, period } = selectedPeriod();
    if (!customerCode || !currencyCode || !year || !period) return;

    state.soaSelectedKey = customerKey(customerCode, currencyCode);
    state.soaLoadingStatement = true;
    renderSoaCustomers();
    els.soaStatementPlaceholder.hidden = true;
    els.soaStatementLoading.hidden = false;
    els.soaStatementBody.hidden = true;

    try {
      const params = new URLSearchParams({
        customer: customerCode,
        currency: currencyCode,
        year: String(year),
        period: String(period),
      });
      const response = await fetch(`/api/accounts/soa/statement?${params.toString()}`);
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload.error || 'Failed to load statement');
      }
      state.soaStatement = payload.statement;
      renderSoaStatement();
    } catch (error) {
      state.soaStatement = null;
      els.soaStatementPlaceholder.hidden = false;
      els.soaStatementPlaceholder.textContent = error.message || 'Failed to load statement';
      els.soaStatementBody.hidden = true;
      els.soaStatementLoading.hidden = true;
    } finally {
      state.soaLoadingStatement = false;
    }
  }

  function scheduleSoaFilterReload() {
    window.clearTimeout(state.filterTimer);
    state.filterTimer = window.setTimeout(() => loadSoaCustomers(), 250);
  }

  function clearSoaFilters() {
    els.soaCustomer.value = '';
    els.soaCurrency.value = '';
    loadSoaCustomers();
  }

  function setSection(section) {
    state.section = section;
    els.sectionLinks.forEach((link) => {
      const active = link.dataset.arSection === section;
      link.classList.toggle('is-active', active);
      link.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    els.sectionCreditNotes.hidden = section !== 'credit-notes';
    els.sectionSoa.hidden = section !== 'soa';

    if (section === 'credit-notes') {
      els.stats.textContent = `${state.summary?.count || 0} ${bucketLabel(state.bucket).toLowerCase()} credit notes`;
      if (!state.items.length) loadList();
      return;
    }

    if (!state.soaPeriods.length) {
      loadSoaPeriods(false)
        .then(() => loadSoaCustomers())
        .catch((error) => {
          els.stats.textContent = error.message || 'Failed to initialize SOA view';
        });
      return;
    }
    loadSoaCustomers();
  }

  els.sectionLinks.forEach((link) => {
    link.addEventListener('click', () => setSection(link.dataset.arSection || 'credit-notes'));
  });

  els.tabs.forEach((tab) => {
    tab.addEventListener('click', () => setBucket(tab.dataset.arBucket || 'posted'));
  });

  els.tableBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-note]');
    if (!row) return;
    loadDetail(row.dataset.note);
  });

  els.soaCustomersBody.addEventListener('click', (event) => {
    const row = event.target.closest('tr[data-soa-customer]');
    if (!row) return;
    const [customerCode, currencyCode] = row.dataset.soaCustomer.split('::');
    loadSoaStatement(customerCode, currencyCode);
  });

  els.soaPeriod.addEventListener('change', () => {
    state.soaPeriodKey = els.soaPeriod.value;
    loadSoaCustomers();
  });

  [els.soaCustomer, els.soaCurrency].forEach((el) => {
    el.addEventListener('input', scheduleSoaFilterReload);
    el.addEventListener('change', scheduleSoaFilterReload);
  });

  els.refresh.addEventListener('click', async () => {
    try {
      if (state.section === 'soa') {
        await loadSoaPeriods(true);
        await loadSoaCustomers({ refresh: true });
        if (state.soaSelectedKey) {
          const [customerCode, currencyCode] = state.soaSelectedKey.split('::');
          await loadSoaStatement(customerCode, currencyCode);
        }
        return;
      }
      await loadSummaryCounts(true);
      await loadList({ refresh: true });
    } catch (error) {
      els.stats.textContent = error.message || 'Refresh failed';
    }
  });

  els.clearFilters.addEventListener('click', () => {
    if (state.section === 'soa') {
      clearSoaFilters();
      return;
    }
    clearCreditNoteFilters();
  });

  els.detailClose.addEventListener('click', () => {
    state.selectedNote = null;
    state.detail = null;
    els.detail.hidden = true;
    renderTable();
  });

  [els.search, els.customer, els.currency, els.dateFrom, els.dateTo].forEach((el) => {
    el.addEventListener('input', scheduleFilterReload);
    el.addEventListener('change', scheduleFilterReload);
  });

  (async function bootstrap() {
    try {
      await loadSummaryCounts(false);
      await loadList();
    } catch (error) {
      els.stats.textContent = error.message || 'Failed to initialize accounts app';
    }
  }());
}());
