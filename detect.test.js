/* Node check for the pure detection layer -- no DOM, no SDK, no browser.
   Uses the same fixture the browser harness builds, extracted at run time so the
   two can never drift. Run: node detect.test.js */
'use strict';

var fs = require('fs');
var path = require('path');
var vm = require('vm');

var dir = __dirname;

// --- load the fixture straight out of harness.html -------------------------
var harness = fs.readFileSync(path.join(dir, 'harness.html'), 'utf8');
var fixtureSrc = harness.slice(harness.indexOf('var PLATES ='), harness.indexOf('var CASES ='));

var sandbox = { window: {}, console: console };
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(fixtureSrc, sandbox);
vm.runInContext(fs.readFileSync(path.join(dir, 'pivot.js'), 'utf8'), sandbox);

var PivotDetect = sandbox.window.PivotDetect;
var COLUMNS = sandbox.COLUMNS;
var DATA = sandbox.DATA;

var ID = {
  plate: 'bnCIySI63i', plex: 'A_a_zhT8Gy', batch: 'WwpuraQVz_', site: 'p5Bgswkwqo',
  stage: 'haTtgretpP', ts: 'zLAH_1E7c5', op: 'g3luCwWUhA', wit: 'iovh7aGvDq',
  status: 'jN9Qax5zgq', cap: 'ilQ8D-l17P'
};

var failures = 0;
function check(label, actual, expected) {
  var a = JSON.stringify(actual), e = JSON.stringify(expected);
  var ok = a === e;
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '\n        got      ' + a +
    (ok ? '' : '\n        expected ' + e));
}

function names(ids) { return (ids || []).map(function (id) { return COLUMNS[id].name; }); }

// Scope the data the way app.js now does: the union of the configured column
// entries, with no separate "Columns" bucket.
function run(cfg) {
  var requested = [];
  [cfg.rowColumns, [cfg.pivotColumn], cfg.valueColumns, [cfg.colorColumn]].forEach(function (g) {
    (g || []).forEach(function (id) { if (id && requested.indexOf(id) === -1) requested.push(id); });
  });
  var data = {}, cols = {};
  requested.forEach(function (id) { data[id] = DATA[id]; cols[id] = COLUMNS[id]; });
  return PivotDetect.detect(data, cols, {
    rowColumns: cfg.rowColumns, pivotColumn: cfg.pivotColumn,
    valueColumns: cfg.valueColumns,
    excludeColumns: cfg.colorColumn ? [cfg.colorColumn] : []
  });
}

var base = {
  rowColumns: [ID.plate, ID.plex, ID.batch], pivotColumn: ID.stage,
  valueColumns: [ID.ts, ID.op, ID.wit], colorColumn: ID.status
};

console.log('--- roles only (no "Columns" entry) ---');
var a = run(base);
check('leftColumns', names(a.rowColumns), ['Plate Id', 'Plex', 'Batch Id']);
check('pivotColumn', COLUMNS[a.pivotColumn].name, 'Stage');
check('valueColumns', names(a.valueColumns), ['Stage Timestamp', 'Operator', 'Witness']);
check('columnAttributes', names(a.columnDims), []);
check('color column not a value', a.valueColumns.indexOf(ID.status), -1);

console.log('\n--- Stage Capacity listed under Cell values ---');
var b = run(Object.assign({}, base, { valueColumns: [ID.ts, ID.op, ID.wit, ID.cap] }));
check('columnAttributes', names(b.columnDims), ['Stage Capacity']);
check('valueColumns exclude capacity', names(b.valueColumns), ['Stage Timestamp', 'Operator', 'Witness']);
var grid = PivotDetect.build(b, ID.status);
check('header carries capacity attr', grid.pivotKeys[0].attrs[ID.cap], 80);
check('pivot value count', grid.pivotKeys.length, 13);
check('row count', grid.rows.length, 6);
check('cell has no capacity', Object.keys(grid.rows[0].cells[grid.pivotKeys[0].k].values).length, 3);

console.log('\n--- nothing configured ---');
var c = PivotDetect.detect({}, {}, {});
check('no rowKey', c.rowKey, null);
check('no pivotColumn', c.pivotColumn, null);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
