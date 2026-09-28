const assert = require('assert');
const search = require('../static/js/scheduler/catalog_search.js');

function tokensFor(psId, extra = []) {
  return search.trialSearchableTokens([psId, ...extra]);
}

function assertMatch(psId, query, extra = []) {
  const tokens = tokensFor(psId, extra);
  assert.ok(
    search.trialQueryMatchesSearchTokens(tokens, query),
    `expected ${JSON.stringify(query)} to match ${psId}`,
  );
}

function assertNoMatch(psId, query, extra = []) {
  const tokens = tokensFor(psId, extra);
  assert.ok(
    !search.trialQueryMatchesSearchTokens(tokens, query),
    `expected ${JSON.stringify(query)} not to match ${psId}`,
  );
}

assertMatch('NPS26-0361', '0361');
assertMatch('NPS26-0385', '0385');
assertMatch('NPS26-0385', '385');
assertMatch('NPS26-385', '0385');
assertMatch('NPS26-385', '385');
assertMatch('NPS26-0385', 'NPS26-0385');
assertMatch('NPS26-0385', 'NPS26-385');
assertMatch('NPS26-0385', 'NPS 0385');
assertMatch('[Temp] NPS26-0385', 'NPS26-0385');
assertMatch('[Temp] NPS26-0385', '0385');
assertMatch('NPS26-0385::2', 'NPS26-0385');
assertMatch('APS26-0151', 'APS26-0151 NPS25-0277');
assertMatch('N26-[SR]22', 'n26-[sr]22');
assertMatch('N26-[SR]22', 'n26-22');
assertMatch('N26-[SR]22', 'N26');
assertMatch('N26-[SR]22', 'n26');
assertMatch('N26-[SR]22', '22');
assertMatch('N26-[SR]22', '0022');
assertMatch('A24-[SR]04', 'A24');
assertNoMatch('NPS26-0368', 'N26');

assertNoMatch('NPS26-0999', '0385');
assertNoMatch('NPS26-0385', 'turning 0385');
assertNoMatch('MPS26-3850', 'NPS26-0385');
assertNoMatch('MPS26-3850', '0385');
assertNoMatch('NPS26-0999', '0361');
assertNoMatch('MPS26-3850', '385');
assertNoMatch('MPS26-3851', 'NPS26-0385');
assertNoMatch('MPS26-0385', 'NPS26-0385');
assertNoMatch('NPS25-0385', 'NPS26-0385');

assert.strictEqual(search.trialIsComponentChildPs('NPS26-0321'), false);
assert.strictEqual(search.trialIsComponentChildPs('NPS26-0321-1'), true);
assert.strictEqual(search.trialIsComponentChildPs('NPS26-0321-10'), true);
assert.strictEqual(search.trialIsComponentChildPs('N26-[SR]22'), false);
assert.strictEqual(search.trialIsComponentChildPs('N26-[SR]22-1'), true);
assert.strictEqual(search.trialParentPsIdFromChild('NPS26-0321-5'), 'NPS26-0321');
assert.strictEqual(search.trialParentPsIdFromChild('NPS26-0321'), '');

{
  const rows = [
    {
      ps_id: 'NPS26-0321',
      source_ps_id: 'NPS26-0321',
      assembly_line_items: [
        { process_sheet_no: 'NPS26-0321-1', ps_id: 'NPS26-0321-1' },
        { process_sheet_no: 'NPS26-0321-5', ps_id: 'NPS26-0321-5' },
        { process_sheet_no: 'NPS26-0321-10', ps_id: 'NPS26-0321-10' },
        { process_sheet_no: 'NPS26-0321-11', ps_id: 'NPS26-0321-11' },
      ],
    },
    { ps_id: 'NPS26-0321-1', source_ps_id: 'NPS26-0321-1' },
    { ps_id: 'NPS26-0321-5', source_ps_id: 'NPS26-0321-5' },
    { ps_id: 'NPS26-0321-10', source_ps_id: 'NPS26-0321-10' },
    { ps_id: 'NPS26-0321-11', source_ps_id: 'NPS26-0321-11' },
    { ps_id: 'NPS26-0999', source_ps_id: 'NPS26-0999' },
  ];
  assert.deepStrictEqual(
    search.trialCatalogExcludeNestedChildren(rows).map(row => row.ps_id),
    ['NPS26-0321', 'NPS26-0999'],
  );
}

{
  const orphans = [
    { ps_id: 'NPS26-0321-5', source_ps_id: 'NPS26-0321-5' },
    { ps_id: 'NPS26-0321-10', source_ps_id: 'NPS26-0321-10' },
  ];
  assert.deepStrictEqual(
    search.trialCatalogExcludeNestedChildren(orphans).map(row => row.ps_id),
    ['NPS26-0321-5', 'NPS26-0321-10'],
  );
}

assert.strictEqual(search.trialCatalogLineItemIsSearchTarget('NPS26-0321-5', 'NPS26-0321-5'), true);
assert.strictEqual(search.trialCatalogLineItemIsSearchTarget('NPS26-0321-5', '0321-5'), true);
assert.strictEqual(search.trialCatalogLineItemIsSearchTarget('NPS26-0321-5', 'NPS26-0321'), false);
assert.strictEqual(search.trialCatalogLineItemIsSearchTarget('NPS26-0321-1', 'NPS26-0321-5'), false);

console.log('catalog_search.js ok');
