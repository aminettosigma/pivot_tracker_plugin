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

console.log('\n--- column formatting ---');
vm.runInContext(fs.readFileSync(path.join(dir, 'styles.js'), 'utf8'), sandbox);
var PS = sandbox.window.PivotStyles;

var sc = PS.compile('{"*":{"size":11},"Operator":{"bold":true,"size":13,"color":"#333"},' +
  '"Stage Timestamp":"italic 10px #6b7684","header":{"uppercase":true},"leftHeader":"bold"}');
check('styles parse ok', sc.error, null);
check('wildcard applies', PS.css(PS.forColumn(sc, 'Witness')), 'font-size:11px');
check('name overrides wildcard', PS.css(PS.forColumn(sc, 'Operator')),
  'font-size:13px;font-weight:700;color:#333');
check('shorthand string', PS.css(PS.forColumn(sc, 'Stage Timestamp')),
  'font-size:10px;font-style:italic;color:#6b7684');
check('case-insensitive key', PS.css(PS.forColumn(sc, 'operator')),
  'font-size:13px;font-weight:700;color:#333');
check('header slot merges', PS.css(PS.forColumn(sc, 'Stage', 'header')),
  'font-size:11px;text-transform:uppercase');
check('leftHeader slot merges', PS.css(PS.forColumn(sc, 'Plate Id', 'leftHeader')),
  'font-size:11px;font-weight:700');
check('unstyled column emits nothing', PS.css(PS.forColumn(PS.compile(''), 'Witness')), '');
check('bad JSON reports error', /invalid/i.test(PS.compile('{oops}').error || ''), true);
check('bad JSON styles nothing', PS.css(PS.forColumn(PS.compile('{oops}'), 'Operator')), '');

console.log('\n--- color rules: presence tests ---');
vm.runInContext(fs.readFileSync(path.join(dir, 'colors.js'), 'utf8'), sandbox);
var PC = sandbox.window.PivotColors;
function bg(v, json, auto) { return PC.resolve(v, PC.compile(json), !!auto, null).bg; }

var presence = '{"isnotnull":"#1d3a5c","isnull":"#f4f5f7"}';
check('has a comment', bg('needs re-run', presence), '#1d3a5c');
check('null comment', bg(null, presence), '#f4f5f7');
check('undefined comment', bg(undefined, presence), '#f4f5f7');
check('empty string', bg('', presence), '#f4f5f7');
check('whitespace only counts as empty', bg('   ', presence), '#f4f5f7');
check('zero is a value, not null', bg(0, presence), '#1d3a5c');
check('isnotnull beats auto palette', bg('anything', presence, true), '#1d3a5c');
check('synonyms work', bg(null, '{"filled":"#111111","blank":"#222222"}'), '#222222');
check('synonym for present', bg('x', '{"filled":"#111111","blank":"#222222"}'), '#111111');

var envelope = '{"default":"#999999","values":{"Done":"#1d3a5c"},' +
  '"rules":[{"op":"isnull","color":"#f4f5f7"},{"contains":"error","color":"#7a1f1f"}]}';
check('rule-array isnull', bg(null, envelope), '#f4f5f7');
check('named value still wins', bg('Done', envelope), '#1d3a5c');
check('contains rule still works', bg('Fatal error here', envelope), '#7a1f1f');
check('unmatched falls back to default', bg('other', envelope), '#999999');

// A presence key must not be matched as literal cell text.
check('presence key is not matched as literal text', bg('isnull', '{"isnull":"#abcdef"}'),
  PC.NEUTRAL.bg);
check('literal text still colorable alongside it',
  bg('isnull', '{"values":{"isnull":"#abcdef"},"rules":[{"op":"isnull","color":"#123456"}]}'),
  '#abcdef');
check('presence key beside "values" also works',
  bg(null, '{"values":{"Done":"#1d3a5c"},"isnull":"#abcdef"}'), '#abcdef');
check('no rules, null -> neutral', bg(null, ''), PC.NEUTRAL.bg);
check('neutral is distinct from test colors', PC.NEUTRAL.bg !== '#abcdef', true);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
