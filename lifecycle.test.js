/* DOM-free checks of app.js's lifecycle and virtualization.

   The fake DOM models only what app.js touches: innerHTML on the root, a
   scrollable .wrap, a <tbody> whose innerHTML is swapped per window, and enough
   of the event API for delegated clicks. Real layout, scroll smoothness and
   sticky offsets are NOT covered here -- those need a browser. */
var fs = require('fs'), vm = require('vm'), path = require('path');
var dir = __dirname;

var harness = fs.readFileSync(path.join(dir, 'harness.html'), 'utf8');
var fixtureSrc = harness.slice(harness.indexOf('var PLATES ='), harness.indexOf('var CASES ='));

var failures = 0;
function check(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '\n        got      ' + JSON.stringify(got) +
    (ok ? '' : '\n        expected ' + JSON.stringify(want)));
}

// --- fake DOM ---------------------------------------------------------------
function classList(node) {
  return {
    _set: {},
    add: function (c) { this._set[c] = true; },
    remove: function (c) { delete this._set[c]; },
    toggle: function (c, on) { if (on) this.add(c); else this.remove(c); },
    contains: function (c) { return !!this._set[c]; }
  };
}

function node(tag) {
  var n = {
    tag: tag, innerHTML: '', style: {}, listeners: {},
    clientHeight: 600, scrollTop: 0,
    addEventListener: function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    fire: function (t, ev) { (this.listeners[t] || []).forEach(function (fn) { fn(ev); }); },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    getBoundingClientRect: function () { return { width: 120, height: 20 }; }
  };
  n.classList = classList(n);
  return n;
}

var wrap = node('div'), tbody = node('tbody');
var root = node('div');
root.querySelector = function (sel) {
  if (sel === '.wrap') return wrap;
  if (sel === 'table.pivot tbody') return tbody;
  return null;                                   // no '.pill.sel' before a click
};

var sandbox = {
  console: console, setTimeout: setTimeout,
  setInterval: function (fn) { sandbox.__tick = fn; return 1; },
  requestAnimationFrame: function (fn) { fn(); return 1; }
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.document = {
  body: node('body'),
  getElementById: function () { return root; },
  addEventListener: function () {}
};
sandbox.addEventListener = function () {};
vm.createContext(sandbox);
vm.runInContext(fixtureSrc, sandbox);

// --- fake host --------------------------------------------------------------
var live = {};
var emit = null;
var subs = [];

sandbox.SigmaPlugin = {
  client: {
    config: {
      configureEditorPanel: function () {},
      subscribe: function (fn) { emit = fn; return function () {}; },
      get: function () { return live; },
      setLoadingState: function (on) { loadingStates.push(on); },
      setVariable: function (id) {
        vars.push([id, Array.prototype.slice.call(arguments, 1)[0]]);
      },
      triggerAction: function (id) { actions.push(id); }
    },
    elements: {
      subscribeToElementColumns: function (id, cb) {
        subs.push('cols'); cb(sandbox.COLUMNS); return function () {};
      },
      subscribeToElementData: function (id, cb) {
        subs.push('data'); cb(sandbox.DATA); return function () {};
      },
      // Paginated delivery: pages() yields one chunk per fetchMore call.
      subscribeToIncrementalElementData: function (id, cb) {
        subs.push('data');
        pager = { cb: cb, next: 0 };
        pager.send = function () {
          var page = pages[pager.next++];
          if (!page) return;
          cb(page);
        };
        pager.send();
        return function () {};
      },
      fetchMoreElementData: function () { fetchMores++; if (pager) pager.send(); }
    }
  }
};
var vars = [], actions = [];
var pages = [], pager = null, fetchMores = 0, loadingStates = [];

['format.js', 'pivot.js', 'colors.js', 'styles.js', 'app.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), sandbox);
});

var ID = { plate: 'bnCIySI63i', plex: 'A_a_zhT8Gy', stage: 'haTtgretpP',
  ts: 'zLAH_1E7c5', op: 'g3luCwWUhA', wit: 'iovh7aGvDq',
  status: 'jN9Qax5zgq', cap: 'ilQ8D-l17P' };

function countPills(html) { return (html.match(/class="pill/g) || []).length; }
function spacerHeights(html) {
  return (html.match(/class="spacer" style="height:(\d+)px"/g) || []).map(function (m) {
    return Number(/(\d+)px/.exec(m)[1]);
  });
}

function onePage(data) { return [{ data: data, offset: 0, isComplete: true }]; }
pages = onePage(sandbox.DATA);

check('placeholder is US spelling', /Initializing/.test(root.innerHTML), true);
check('no config yet -> no subscriptions', subs.length, 0);

console.log('\n--- dropped config emission recovered by the poll ---');
live = { source: 'el-plate-stages', rowColumns: [ID.plate, ID.plex],
  pivotColumn: ID.stage, valueColumns: [ID.ts, ID.op], colorColumn: ID.status };
sandbox.__tick();
check('poll subscribed to the element', subs, ['cols', 'data']);
check('grid painted without a refresh', countPills(tbody.innerHTML) > 0, true);

console.log('\n--- virtualization windowing ---');
// 18 fixture plates, 600px viewport. Every row must be exactly one row-height.
var firstWindow = tbody.innerHTML;
var pillsPerRow = 13;                            // fixture stages
var rendered = countPills(firstWindow) / pillsPerRow;
check('renders whole rows only', Number.isInteger(rendered), true);
check('renders at most the fixture row count', rendered <= 18, true);

// Force a taller data set so a window is genuinely a subset.
var big = { plates: 400 };
(function makeBig() {
  var d = {};
  Object.keys(sandbox.DATA).forEach(function (k) { d[k] = []; });
  for (var p = 0; p < big.plates; p++) {
    for (var s = 0; s < 13; s++) {
      Object.keys(sandbox.DATA).forEach(function (k) {
        var src = sandbox.DATA[k];
        d[k].push(k === ID.plate ? 'P' + (10000 + p) : src[(p * 13 + s) % src.length]);
      });
    }
  }
  sandbox.__big = d;
})();

emit(Object.assign({}, live, { __force: 1 }));   // keep config, new data below
pages = onePage(sandbox.__big);
live = Object.assign({}, live, { valueColumns: [ID.ts, ID.op, ID.wit] });
sandbox.__tick();

var win = tbody.innerHTML;
var winRows = countPills(win) / pillsPerRow;
check('window is a subset of 400 rows', winRows > 0 && winRows < 400, true);
var sp = spacerHeights(win);
check('one trailing spacer at scrollTop 0', sp.length, 1);

var rowH = Number(/--row-h: (\d+)px/.exec(root.innerHTML)[1]);
check('row height is fixed and sane', rowH > 20 && rowH < 200, true);
check('trailing spacer covers the unrendered rows',
  sp[0] + Math.round(winRows * rowH) >= 400 * rowH, true);

console.log('\n--- scrolling repaints the window ---');
wrap.scrollTop = 100 * rowH;
wrap.fire('scroll', {});
var mid = tbody.innerHTML;
check('window changed after scrolling', mid !== win, true);
var midSp = spacerHeights(mid);
check('two spacers mid-scroll', midSp.length, 2);
check('leading spacer matches scroll offset', midSp[0] <= 100 * rowH, true);
check('spacers plus rendered rows cover the full height',
  midSp[0] + midSp[1] + Math.round((countPills(mid) / pillsPerRow) * rowH) >= 400 * rowH, true);

wrap.scrollTop = 400 * rowH;                     // past the end
wrap.fire('scroll', {});
check('no trailing spacer at the end', spacerHeights(tbody.innerHTML).length, 1);

console.log('\n--- delegated click ---');
wrap.scrollTop = 0;
wrap.fire('scroll', {});
var m = /data-row="([^"]*)" data-col="([^"]*)"/.exec(tbody.innerHTML);
var btn = node('button');
btn.getAttribute = function (a) { return a === 'data-row' ? m[1] : m[2]; };
var target = { closest: function (sel) { return sel === '.pill' ? btn : null; } };
vars = []; actions = [];
wrap.fire('click', { target: target });
check('one listener serves every pill', (wrap.listeners.click || []).length, 1);
check('click set both controls', vars.length, 0);  // no variables configured yet

live = Object.assign({}, live, { rowVariable: 'Plate-Id', columnVariable: 'Stage' });
sandbox.__tick();
wrap.scrollTop = 0; wrap.fire('scroll', {});
m = /data-row="([^"]*)" data-col="([^"]*)"/.exec(tbody.innerHTML);
vars = [];
wrap.fire('click', { target: target });
check('row control set immediately', vars.length, 1);
check('row value is the plate', vars[0][0], 'Plate-Id');
check('selection ring applied to the clicked pill', btn.classList.contains('sel'), true);

console.log('\n--- presentational changes must not re-detect ---');
// Instrument detect() so memoization is asserted, not inferred from a repaint.
var PD = sandbox.window.PivotDetect;
var detectCalls = 0, buildCalls = 0;
var realDetect = PD.detect, realBuild = PD.build;
PD.detect = function () { detectCalls++; return realDetect.apply(null, arguments); };
PD.build = function () { buildCalls++; return realBuild.apply(null, arguments); };

var painted = tbody.innerHTML;
live = Object.assign({}, live, { darkMode: true, compact: true });
sandbox.__tick();
check('repainted for cosmetic change', tbody.innerHTML !== painted, true);
check('cosmetic change did not re-detect', detectCalls, 0);
check('cosmetic change did not rebuild the grid', buildCalls, 0);

wrap.scrollTop = 40 * rowH; wrap.fire('scroll', {});
check('scrolling did not re-detect', detectCalls, 0);
wrap.fire('click', { target: target });
check('clicking did not re-detect', detectCalls, 0);
wrap.scrollTop = 0; wrap.fire('scroll', {});

live = Object.assign({}, live, { valueColumns: [ID.ts, ID.op] });
sandbox.__tick();
// A structural change also re-subscribes, so the redelivered page detects again;
// what matters is that it detected at all, versus zero for cosmetic changes.
check('structural change does re-detect', detectCalls >= 1, true);
check('dark class applied to body', sandbox.document.body.classList.contains('dark'), true);

console.log('\n--- field-name row under the headers ---');
// Two value columns are in scope from the structural change above, so the row
// would render if it were enabled -- proving the assertion is not vacuous.
check('hidden by default', /grp-sub/.test(root.innerHTML), false);
live = Object.assign({}, live, { showValueLabels: true });
sandbox.__tick();
check('shown when the toggle is on', /grp-sub/.test(root.innerHTML), true);
check('names its value columns', /OPERATOR|Operator/.test(root.innerHTML), true);
live = Object.assign({}, live, { showValueLabels: false });
sandbox.__tick();
check('hidden again when turned off', /grp-sub/.test(root.innerHTML), false);

console.log('\n--- max rows cap ---');
live = Object.assign({}, live, { maxRows: '25', darkMode: false, compact: false });
sandbox.__tick();
check('note reports the truncation', /Showing the first 25 of 400 rows/.test(root.innerHTML), true);
live = Object.assign({}, live, { maxRows: '0' });
sandbox.__tick();
check('0 means unlimited (no note)', /Showing the first/.test(root.innerHTML), false);

console.log('\n--- paginated loading (Sigma sends data in pages) ---');
// Three pages of the big fixture; only the last is marked complete.
var cols = Object.keys(sandbox.__big);
var totalLen = sandbox.__big[cols[0]].length;
var cut = Math.floor(totalLen / 3);
function slice(from, to) {
  var d = {};
  cols.forEach(function (k) { d[k] = sandbox.__big[k].slice(from, to); });
  return d;
}
pages = [
  { data: slice(0, cut), offset: 0, isComplete: false, totalRows: totalLen },
  { data: slice(cut, cut * 2), offset: cut, isComplete: false, totalRows: totalLen },
  { data: slice(cut * 2, totalLen), offset: cut * 2, isComplete: true, totalRows: totalLen }
];
fetchMores = 0; loadingStates = []; pager = null;
live = Object.assign({}, live, { source: 'el-paged', maxRows: '0', debug: true });
sandbox.__tick();

// The debug JSON is HTML-escaped, so quotes appear as &quot;.
function diag(field) {
  var m = new RegExp('&quot;' + field + '&quot;: ([^,\n]+)').exec(root.innerHTML);
  return m ? JSON.parse(m[1].replace(/[,\s]+$/, '')) : undefined;
}
check('pulled every page', fetchMores >= 2, true);
check('accumulated all rows, not just page 1', diag('rowsLoaded'), totalLen);
check('source row count matches the full data', diag('sourceRows'), totalLen);
check('load reported complete', diag('loadComplete'), true);
check('loading state cleared when done', loadingStates[loadingStates.length - 1], false);
check('full grid built from all pages', countPills(tbody.innerHTML) > 0, true);

console.log('\n--- a re-sent page must not duplicate rows ---');
pages = [
  { data: slice(0, cut), offset: 0, isComplete: false, totalRows: totalLen },
  { data: slice(0, cut), offset: 0, isComplete: false, totalRows: totalLen },
  { data: slice(cut, totalLen), offset: cut, isComplete: true, totalRows: totalLen }
];
fetchMores = 0; pager = null;
live = Object.assign({}, live, { source: 'el-resend', debug: true });
sandbox.__tick();
check('rewind on repeated offset, no duplicates', diag('rowsLoaded'), totalLen);

console.log('\n--- host that never completes must not loop forever ---');
pages = [
  { data: slice(0, cut), offset: 0, isComplete: false, totalRows: totalLen },
  { data: { }, offset: cut, isComplete: false, totalRows: totalLen },
  { data: { }, offset: cut, isComplete: false, totalRows: totalLen }
];
fetchMores = 0; pager = null;
live = Object.assign({}, live, { source: 'el-stalled', debug: true });
sandbox.__tick();
check('stopped fetching after no progress', fetchMores <= 3, true);
check('gave up and marked complete', diag('loadComplete'), true);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
