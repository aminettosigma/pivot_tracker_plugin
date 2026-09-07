/* Reproducible performance baseline. Run: node bench.js [plates] [stages]
   Builds a synthetic pivot source and times detection, grid build and the
   per-row HTML generation that render() performs. */
var fs = require('fs'), vm = require('vm'), path = require('path');
var dir = __dirname;

var NPLATE = Number(process.argv[2] || 30000);
var STAGES = Number(process.argv[3] || 13);

var sandbox = { window: {}, console: console };
sandbox.global = sandbox;
vm.createContext(sandbox);
['format.js', 'pivot.js', 'colors.js', 'styles.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox);
});
var PD = sandbox.window.PivotDetect;
var PC = sandbox.window.PivotColors;

var ids = ['plate', 'plex', 'batch', 'stage', 'ts', 'op', 'wit', 'status', 'cap'];
var data = {};
ids.forEach(function (i) { data[i] = []; });
for (var p = 0; p < NPLATE; p++) {
  for (var st = 0; st < STAGES; st++) {
    data.plate.push('A' + (10000 + p));
    data.plex.push(p % 3 ? 'X16' : 'G64');
    data.batch.push('AN' + (3000 + (p >> 2)));
    data.stage.push('S' + st);
    data.ts.push('2026-08-2' + (st % 9) + ' 1' + (p % 9) + ':00');
    data.op.push('Op ' + (p % 50));
    data.wit.push('W' + (p % 37));
    data.status.push(st % 4 ? 'Done' : 'Pending');
    data.cap.push(80 + st);
  }
}
var columns = {};
ids.forEach(function (i) {
  columns[i] = { id: i, name: i, columnType: i === 'cap' ? 'number' : 'text' };
});

function t(label, fn) {
  var a = process.hrtime.bigint();
  var r = fn();
  var ms = Number(process.hrtime.bigint() - a) / 1e6;
  console.log('  ' + label.padEnd(38) + ms.toFixed(0) + ' ms');
  return r;
}

console.log('source rows: ' + data.plate.length +
  '  (' + NPLATE + ' row keys x ' + STAGES + ' pivot columns)');

var overrides = { rowColumns: ['plate', 'plex', 'batch'], pivotColumn: 'stage',
  valueColumns: ['ts', 'op', 'wit'], excludeColumns: ['status'] };

console.log('\ndetection');
var layout = t('detect (explicit overrides)', function () {
  return PD.detect(data, columns, overrides);
});
t('detect (auto, no overrides)', function () { return PD.detect(data, columns, {}); });
var grid = t('build (uncapped)', function () { return PD.build(layout, 'status'); });
t('build (capped at 5000)', function () { return PD.build(layout, 'status', 5000); });

console.log('  grid: ' + grid.rows.length + ' rows x ' + grid.pivotKeys.length +
  ' cols = ' + (grid.rows.length * grid.pivotKeys.length) + ' cells');

/* Mirrors render()'s per-cell string work, which is what the DOM cost tracks. */
function paintRows(rows, cols, valueCols) {
  var out = [];
  var compiled = PC.compile('');
  for (var r = 0; r < rows.length; r++) {
    out.push('<tr>');
    for (var i = 0; i < 3; i++) out.push('<td class="lead">' + data.plate[rows[r].index] + '</td>');
    for (var c = 0; c < cols.length; c++) {
      var ri = rows[r].cells[c];
      if (ri === undefined) { out.push('<td class="cell empty"></td>'); continue; }
      var style = PC.resolve(data.status[ri], compiled, true, null);
      var body = '';
      for (var l = 0; l < valueCols.length; l++) {
        body += '<span class="line l' + l + '">' + data[valueCols[l]][ri] + '</span>';
      }
      out.push('<td class="cell"><button type="button" class="pill" style="background:' +
        style.bg + ';color:' + style.fg + '" data-row="x" data-col="y">' + body + '</button></td>');
    }
    out.push('</tr>');
  }
  return out.join('');
}

console.log('\nrendering');
var all = t('html for every row (old behavior)', function () {
  return paintRows(grid.rows, grid.pivotKeys, layout.valueColumns);
});
console.log('  ' + (all.length / 1e6).toFixed(0) + ' MB of HTML, ~' +
  ((grid.rows.length * (3 + grid.pivotKeys.length * 5)) / 1e6).toFixed(1) + 'M DOM nodes');

var WINDOW = 50;
t('html for one window (' + WINDOW + ' rows)', function () {
  return paintRows(grid.rows.slice(0, WINDOW), grid.pivotKeys, layout.valueColumns);
});
t('html for 20 windows (scrolling)', function () {
  var s = 0;
  for (var w = 0; w < 20; w++) {
    s += paintRows(grid.rows.slice(w * WINDOW, w * WINDOW + WINDOW),
      grid.pivotKeys, layout.valueColumns).length;
  }
  return s;
});

console.log('\npeak heap: ' + Math.round(process.memoryUsage().heapUsed / 1e6) + ' MB');
