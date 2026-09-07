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
// Columns are sorted now, so look the stage up by name rather than by position.
function pkFor(g, value) {
  return g.pivotKeys.filter(function (pk) { return pk.value === value; })[0];
}
check('header carries capacity attr', pkFor(grid, 'PLATING').attrs[ID.cap], 80);
check('pivot value count', grid.pivotKeys.length, 13);
check('row count', grid.rows.length, 6);
// Cells are source row indices now, so the value columns are read from the data.
var firstCell = grid.rows[0].cells[grid.pivotKeys[0].index];
check('cell is a source row index', typeof firstCell, 'number');
check('cell index resolves the right plate',
  sandbox.DATA[ID.plate][firstCell], sandbox.DATA[ID.plate][0]);
check('cell index resolves the right stage',
  sandbox.DATA[ID.stage][firstCell], grid.pivotKeys[0].value);
// detect() is handed a scoped copy, so compare the underlying column arrays.
check('grid exposes the data for index lookups',
  grid.data[ID.plate] === sandbox.DATA[ID.plate], true);
check('row exposes its own source index', typeof grid.rows[0].index, 'number');

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

console.log('\n--- deterministic order (the click-scramble bug) ---');
/* Sigma re-runs the element query on every control change, and SQL without
   ORDER BY may return rows in a different order each time. Shuffling the source
   rows must not change the rendered grid at all. */
function shuffleData(data, seed) {
  var ids = Object.keys(data);
  var n = data[ids[0]].length;
  var order = [];
  for (var i = 0; i < n; i++) order.push(i);
  // deterministic LCG shuffle so the test is repeatable
  var s = seed;
  for (var j = n - 1; j > 0; j--) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    var k = s % (j + 1);
    var t = order[j]; order[j] = order[k]; order[k] = t;
  }
  var out = {};
  ids.forEach(function (id) {
    out[id] = order.map(function (idx) { return data[id][idx]; });
  });
  return out;
}

function gridShape(data, opts) {
  var scoped = {}, scopedCols = {};
  [ID.plate, ID.plex, ID.batch, ID.stage, ID.ts, ID.op, ID.wit, ID.status, ID.cap]
    .forEach(function (id) { scoped[id] = data[id]; scopedCols[id] = COLUMNS[id]; });
  var lay = PivotDetect.detect(scoped, scopedCols, {
    rowColumns: [ID.plate, ID.plex, ID.batch], pivotColumn: ID.stage,
    valueColumns: [ID.ts, ID.op, ID.wit], excludeColumns: [ID.status]
  });
  var g = PivotDetect.build(lay, ID.status, opts || {});
  return {
    rows: g.rows.map(function (r) { return data[ID.plate][r.index]; }),
    cols: g.pivotKeys.map(function (pk) { return pk.value; }),
    // one cell value per row, resolved through the sorted column slots
    firstCells: g.rows.map(function (r) {
      var slot = g.pivotKeys[0].index;
      var ri = r.cells[slot];
      return ri === undefined ? null : data[ID.op][ri];
    })
  };
}

var natural = gridShape(DATA);
var shuffled1 = gridShape(shuffleData(DATA, 7));
var shuffled2 = gridShape(shuffleData(DATA, 991));

check('row order identical after shuffle', shuffled1.rows, natural.rows);
check('column order identical after shuffle', shuffled1.cols, natural.cols);
check('cells still track their column after shuffle', shuffled1.firstCells, natural.firstCells);
check('a second shuffle agrees too', shuffled2.rows, natural.rows);
check('rows are actually sorted, not arrival order',
  natural.rows.slice().sort(function (a, b) { return PivotDetect.compareValues(a, b); }),
  natural.rows);

console.log('\n--- explicit sort columns ---');
var byOp = gridShape(DATA, { sortRow: ID.op });
check('sorting rows by another column changes the order', byOp.rows !== natural.rows, true);
check('same row set, reordered', byOp.rows.slice().sort(), natural.rows.slice().sort());
var desc = gridShape(DATA, { sortRowDesc: true });
check('descending is the reverse of ascending', desc.rows, natural.rows.slice().reverse());

var byCap = gridShape(DATA, { sortColumn: ID.cap });
check('pivot columns sortable by a header attribute', byCap.cols.length, natural.cols.length);
var capOrder = byCap.cols.map(function (v) {
  var i = DATA[ID.stage].indexOf(v);
  return DATA[ID.cap][i];
});
check('columns ordered by that attribute',
  capOrder, capOrder.slice().sort(function (a, b) { return a - b; }));

console.log('\n--- multi-column sort ---');
// Plex repeats across plates, so it only orders rows down to ties; the second
// key has to break them, and the result must match an independent sort.
var plexOf = {};
DATA[ID.plate].forEach(function (p, i) { plexOf[p] = DATA[ID.plex][i]; });
var multi = gridShape(DATA, { sortRow: [ID.plex, ID.plate] });
// Guard against a vacuous assertion: if every plate shared one plex the first
// key would be inert and this section would prove nothing.
check('fixture has more than one plex', Object.keys(plexOf).map(function (p) {
  return plexOf[p];
}).filter(function (v, i, a) { return a.indexOf(v) === i; }).length > 1, true);
var expected = natural.rows.slice().sort(function (a, b) {
  return PivotDetect.compareValues(plexOf[a], plexOf[b]) ||
    PivotDetect.compareValues(a, b);
});
check('rows ordered by plex then plate', multi.rows, expected);
check('multi-key order survives shuffling',
  gridShape(shuffleData(DATA, 91), { sortRow: [ID.plex, ID.plate] }).rows, multi.rows);
check('descending reverses the whole key list',
  gridShape(DATA, { sortRow: [ID.plex, ID.plate], sortRowDesc: true }).rows,
  multi.rows.slice().reverse());
check('a single id is still accepted', gridShape(DATA, { sortRow: [ID.op] }).rows, byOp.rows);
check('unstreamed sort ids are dropped, not fatal',
  gridShape(DATA, { sortRow: ['not-a-column'] }).rows, natural.rows);

console.log('\n--- a sort-only column must never be displayed ---');
/* Stage Capacity stands in for Stage Seq: streamed so it can order the crosstab
   columns, 1:1 with the pivot value, and with nothing explicitly assigned so
   auto-detection is free to grab it. It must not appear in any visible role. */
var hidden = PivotDetect.detect(DATA, COLUMNS, {
  pivotColumn: ID.stage,
  excludeColumns: [ID.cap]
});
check('not a left column', hidden.rowColumns.indexOf(ID.cap), -1);
check('not a header attribute', hidden.columnDims.indexOf(ID.cap), -1);
check('not a pill value', hidden.valueColumns.indexOf(ID.cap), -1);
var hiddenGrid = PivotDetect.build(hidden, null, { sortColumn: [ID.cap] });
var hiddenOrder = hiddenGrid.pivotKeys.map(function (pk) {
  return DATA[ID.cap][DATA[ID.stage].indexOf(pk.value)];
});
check('still orders the crosstab columns',
  hiddenOrder, hiddenOrder.slice().sort(function (a, b) { return a - b; }));
check('and there is more than one capacity to order by',
  hiddenOrder.filter(function (v, i, a) { return a.indexOf(v) === i; }).length > 1, true);
check('picking it explicitly makes it visible again',
  PivotDetect.detect(DATA, COLUMNS, {
    pivotColumn: ID.stage, valueColumns: [ID.op, ID.cap], excludeColumns: []
  }).columnDims.indexOf(ID.cap) !== -1, true);

console.log('\n--- sorting headers must not shift the cells under them ---');
/* Order the crosstab columns by an attribute so the headers land far from their
   natural order, then check every (plate, stage) pair against a lookup built
   straight from the source arrays. */
var reordered = PivotDetect.build(PivotDetect.detect(DATA, COLUMNS, {
  rowColumns: [ID.plate], pivotColumn: ID.stage, valueColumns: [ID.op],
  excludeColumns: [ID.cap]
}), null, { sortColumn: [ID.cap] });
check('headers really did move', reordered.pivotKeys.map(function (pk) {
  return pk.value;
}).join() !== natural.cols.join(), true);
var truth = {};
DATA[ID.plate].forEach(function (p, i) {
  truth[p + '\u0001' + DATA[ID.stage][i]] = DATA[ID.op][i];
});
var mismatches = 0, compared = 0;
reordered.rows.forEach(function (r) {
  var plate = DATA[ID.plate][r.index];
  reordered.pivotKeys.forEach(function (pk) {
    var ri = r.cells[pk.index];
    if (ri === undefined) return;
    compared++;
    if (DATA[ID.op][ri] !== truth[plate + '\u0001' + pk.value]) mismatches++;
  });
});
check('every cell still pairs with the right column', mismatches, 0);
check('and every populated cell in the fixture was compared',
  compared, Object.keys(truth).length);

console.log('\n--- cap is applied after sorting ---');
var capped = gridShape(DATA, { maxRows: 5 });
check('capped rows are the first 5 in sort order', capped.rows, natural.rows.slice(0, 5));
var cappedShuffled = gridShape(shuffleData(DATA, 31), { maxRows: 5 });
check('cap keeps the same rows regardless of arrival', cappedShuffled.rows, capped.rows);


console.log('\n--- a duplicated (row, stage) pair must show the richest row ---');
/* An extra attempt or step row splits one stage into several source rows. Which one
   the card shows used to depend on the order Snowflake returned them, so a card
   could show an empty duplicate one minute and the real data the next. */
function withDuplicate(emptyFirst) {
  var d = {};
  Object.keys(DATA).forEach(function (k) { d[k] = DATA[k].slice(); });
  // Find a populated (plate, stage) pair and append a second, value-less row for it.
  var at = -1;
  for (var i = 0; i < d[ID.plate].length; i++) {
    if (d[ID.op][i] !== null && d[ID.op][i] !== undefined && d[ID.op][i] !== '') { at = i; break; }
  }
  var rich = {}, poor = {};
  Object.keys(d).forEach(function (k) { rich[k] = d[k][at]; poor[k] = null; });
  poor[ID.plate] = rich[ID.plate]; poor[ID.plex] = rich[ID.plex];
  poor[ID.batch] = rich[ID.batch]; poor[ID.stage] = rich[ID.stage];
  // Rewrite that pair as two rows, in the requested order.
  Object.keys(d).forEach(function (k) {
    d[k][at] = emptyFirst ? poor[k] : rich[k];
    d[k].push(emptyFirst ? rich[k] : poor[k]);
  });
  return { data: d, plate: rich[ID.plate], stage: rich[ID.stage], op: rich[ID.op] };
}
function cellOp(bundle) {
  var scoped = {}, scopedCols = {};
  [ID.plate, ID.plex, ID.batch, ID.stage, ID.ts, ID.op, ID.wit, ID.status, ID.cap]
    .forEach(function (id) { scoped[id] = bundle.data[id]; scopedCols[id] = COLUMNS[id]; });
  var lay = PivotDetect.detect(scoped, scopedCols, {
    rowColumns: [ID.plate, ID.plex, ID.batch], pivotColumn: ID.stage,
    valueColumns: [ID.ts, ID.op, ID.wit], excludeColumns: [ID.status]
  });
  var g = PivotDetect.build(lay, ID.status, {});
  var row = g.rows.filter(function (r) { return bundle.data[ID.plate][r.index] === bundle.plate; })[0];
  var pk = g.pivotKeys.filter(function (k) { return k.value === bundle.stage; })[0];
  var ri = row.cells[pk.index];
  return { op: ri === undefined ? null : bundle.data[ID.op][ri], collisions: g.collisions };
}
var richLast = withDuplicate(true), richFirst = withDuplicate(false);
check('the collision was counted', cellOp(richLast).collisions >= 1, true);
check('the populated row wins when it arrives last', cellOp(richLast).op, richLast.op);
check('and when it arrives first', cellOp(richFirst).op, richFirst.op);
check('so arrival order cannot change the card', cellOp(richLast).op, cellOp(richFirst).op);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
