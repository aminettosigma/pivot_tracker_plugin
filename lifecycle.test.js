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
/* Enough DOM for the color picker: it creates a popover, appends it to root, then
   reads its own '.hex' input back. Selector lookups inside the popover return the
   same stub each time so a test can set a value and then fire Apply. */
root.children = [];
/* Setting innerHTML discards child nodes in a browser. Model that, or appended
   nodes -- the color picker popover, the lost-row note -- would pile up across
   paints and make child counts meaningless. */
(function () {
  var buf = '';
  Object.defineProperty(root, 'innerHTML', {
    get: function () { return buf; },
    set: function (v) { buf = v; root.children = []; }
  });
})();
root.appendChild = function (el) { root.children.push(el); el.parentNode = root; return el; };
root.removeChild = function (el) {
  root.children = root.children.filter(function (c) { return c !== el; });
  el.parentNode = null;
};
root.getBoundingClientRect = function () { return { top: 0, left: 0, width: 900, height: 600 }; };

function createElement(tag) {
  var el = node(tag);
  var stubs = {};
  el.querySelector = function (sel) {
    if (!stubs[sel]) {
      var s = node('input');
      s.value = '';
      s.focus = function () {};
      stubs[sel] = s;
    }
    return stubs[sel];
  };
  return el;
}

var sandbox = {
  console: console,
  /* Timers are queued rather than real: the loader now backs off with setTimeout
     when a delivery stalls, and a test has to be able to step that clock. Nothing
     in the suite depends on a timer firing on its own. */
  setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms || 0, id: ++timerId }); return timerId; },
  clearTimeout: function (id) { timers = timers.filter(function (t) { return t.id !== id; }); },
  setInterval: function (fn) { sandbox.__tick = fn; return 1; },
  requestAnimationFrame: function (fn) { fn(); return 1; }
};
sandbox.window = sandbox;
sandbox.global = sandbox;
sandbox.document = {
  body: node('body'),
  getElementById: function () { return root; },
  createElement: createElement,
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
      setKey: function (k, v) { writes.push([k, v]); },
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
      fetchMoreElementData: function () { fetchMores++; if (pager && autoSend) pager.send(); }
    }
  }
};
var vars = [], actions = [];
var writes = [];
var pages = [], pager = null, fetchMores = 0, loadingStates = [];
var timers = [], timerId = 0;
// Runs queued timers, including any they queue in turn, until the queue is empty.
function flushTimers(limit) {
  var rounds = 0;
  while (timers.length && rounds++ < (limit || 200)) {
    var due = timers; timers = [];
    due.sort(function (a, b) { return a.ms - b.ms; }).forEach(function (t) { t.fn(); });
  }
}
/* Pages normally cascade: fetchMore immediately delivers the next one, so a whole
   load runs in one call stack. Turning that off lets a test step through a reload
   page by page and inspect the DOM between pages, which is the only way to prove
   the grid is not repainted mid-reload. */
var autoSend = true;

/* Settings edits reach a real plugin through subscribe(), not through
   config.get(). Drive them that way so the suite exercises the same path the
   workbook does; the snapshot is kept in step, as the host does on re-mount. */
function setConfig(patch) {
  live = Object.assign({}, live, patch);
  emit(live);
}

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

console.log('\n--- a subscribe emission must survive the watchdog poll ---');
/* The real host's config.get() returns a snapshot of the last message it sent.
   Saving a text field reaches subscribe() but does not always refresh that
   snapshot -- a column picker change does, because it re-mounts the iframe. So
   the poll must never revert what subscribe just delivered. Modeled by holding
   live (= get()) frozen while emitting a newer config. */
var fresh = Object.assign({}, live, {
  colorRules: '{"Completed":"#A36E1F"}', darkMode: false, autoPalette: true
});
emit(fresh);
check('the emitted rule color is painted', /#A36E1F/i.test(tbody.innerHTML), true);
sandbox.__tick();
sandbox.__tick();
sandbox.__tick();
check('still painted after three polls', /#A36E1F/i.test(tbody.innerHTML), true);
check('the poll did not revert to the palette', /#e3edfb/i.test(tbody.innerHTML), false);

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
setConfig({ valueColumns: [ID.ts, ID.op, ID.wit] });

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

setConfig({ rowVariable: 'Plate-Id', columnVariable: 'Stage' });
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
setConfig({ darkMode: true, compact: true });
check('repainted for cosmetic change', tbody.innerHTML !== painted, true);
check('cosmetic change did not re-detect', detectCalls, 0);
check('cosmetic change did not rebuild the grid', buildCalls, 0);

wrap.scrollTop = 40 * rowH; wrap.fire('scroll', {});
check('scrolling did not re-detect', detectCalls, 0);
wrap.fire('click', { target: target });
check('clicking did not re-detect', detectCalls, 0);
wrap.scrollTop = 0; wrap.fire('scroll', {});

setConfig({ valueColumns: [ID.ts, ID.op] });
// A structural change also re-subscribes, so the redelivered page detects again;
// what matters is that it detected at all, versus zero for cosmetic changes.
check('structural change does re-detect', detectCalls >= 1, true);
check('dark class applied to body', sandbox.document.body.classList.contains('dark'), true);

console.log('\n--- field-name row under the headers ---');
// Two value columns are in scope from the structural change above, so the row
// would render if it were enabled -- proving the assertion is not vacuous.
check('hidden by default', /grp-sub/.test(root.innerHTML), false);
setConfig({ showValueLabels: true });
check('shown when the toggle is on', /grp-sub/.test(root.innerHTML), true);
check('names its value columns', /OPERATOR|Operator/.test(root.innerHTML), true);
setConfig({ showValueLabels: false });
check('hidden again when turned off', /grp-sub/.test(root.innerHTML), false);

console.log('\n--- custom color rules must beat the auto palette ---');
// Mirrors the reported shape: mixed case, spaces and parentheses in the key, and
// the auto-palette toggle left on. Light theme is forced, because the assertions
// name a light-palette color and would pass vacuously under the dark palette.
setConfig({
  darkMode: false,
  autoPalette: true,
  colorRules: '{"Completed":"#A36E1F","Pending (late)":"#376692"}'
});
check('the rule color is in the painted HTML', /#A36E1F/i.test(tbody.innerHTML), true);
check('the auto palette is not used for a matched value',
  /#e3edfb/i.test(tbody.innerHTML), false);
setConfig({ colorRules: '' });
check('clearing the rules falls back to the palette',
  /#e3edfb/i.test(tbody.innerHTML), true);
check('and the rule color is gone', /#A36E1F/i.test(tbody.innerHTML), false);

// Debug reports rule coverage, so an unsaved rules box is diagnosable.
setConfig({ debug: true });
check('no rules reported when the box is empty', diag('colorRuleKeys'), 0);
setConfig({ colorRules: '{"Completed":"#A36E1F"}' });
check('rule count reported', diag('colorRuleKeys'), 1);
check('values the rules miss are listed',
  diagArray('unmatchedByRules'), ['Not Started', 'Pending']);
setConfig({ debug: false, colorRules: '' });

console.log('\n--- inline field names in the pill ---');
setConfig({ inlineLabels: false, valueColumns: [ID.op, ID.wit] });
var bare = tbody.innerHTML;
check('off by default', /class="ilbl"/.test(bare), false);
function cellWidthPx() {
  // The cell columns are the trailing <col>s; the left columns come first.
  var all = (root.innerHTML.match(/<col style="width:(\d+)px">/g) || [])
    .map(function (m) { return Number(/(\d+)/.exec(m)[1]); });
  return all[all.length - 1];
}
var bareWidth = cellWidthPx();

setConfig({ inlineLabels: true });
check('the field name is rendered', /class="ilbl"/.test(tbody.innerHTML), true);
check('formatted as "Name: value"',
  /class="ilbl"[^>]*>Operator:<\/span> /.test(tbody.innerHTML), true);
check('one label per value column',
  (tbody.innerHTML.match(/class="ilbl"/g) || []).length,
  (bare.match(/class="line l/g) || []).length);
// Labels make every line longer; if the column were not widened the text would
// wrap and rows would stop being exactly rowH tall, which breaks virtualization.
check('cells are widened to fit the labels', cellWidthPx() > bareWidth, true);
check('values are still present', /Haley Cravalho|William Cook/.test(tbody.innerHTML), true);

setConfig({ inlineLabels: false, valueColumns: [ID.ts, ID.op] });
check('turning it off removes them', /class="ilbl"/.test(tbody.innerHTML), false);

console.log('\n--- legend ---');
setConfig({ colorRules: '', autoPalette: true, darkMode: false, debug: false });
function swatches(html) {
  return (html.match(/<span class="sw" style="background:([^;]+);/g) || [])
    .map(function (s) { return /background:([^;]+);/.exec(s)[1]; });
}
function chips(html) {
  return (html.match(/data-lgv="([^"]*)"/g) || [])
    .map(function (s) { return /data-lgv="([^"]*)"/.exec(s)[1]; });
}
check('one chip per distinct color value', chips(root.innerHTML),
  ['Completed', 'Not Started', 'Pending']);
check('the color column is named', /class="lgt">Stage Status</.test(root.innerHTML), true);
// The legend must show the same colors the cells do, or it lies to the reader.
var legendFirst = swatches(root.innerHTML)[0];
check('swatch matches the palette color used in the grid',
  tbody.innerHTML.indexOf(legendFirst) !== -1, true);

setConfig({ colorRules: '{"Completed":"#a36e1f"}' });
check('swatch follows a rule color', swatches(root.innerHTML)[0], '#a36e1f');
check('and so does the grid', /#a36e1f/i.test(tbody.innerHTML), true);

console.log('\n--- color picker ---');
function fire(sel, attrs) {
  var stub = node('button');
  stub.getAttribute = function (a) { return (attrs || {})[a]; };
  root.fire('click', { target: { closest: function (s) { return s === sel ? stub : null; } } });
  return stub;
}
writes = [];
fire('.lg', { 'data-lgv': 'Pending' });
check('clicking a chip opens the picker', root.children.length, 1);
check('presets are offered', (root.children[0].innerHTML.match(/class="opt/g) || []).length > 6, true);
check('the picker names the value', /Color for <b>Pending<\/b>/.test(root.children[0].innerHTML), true);

fire('.opt', { 'data-hex': '#123456' });
check('picking a preset saves it', writes.length, 1);
check('saved under the config key', writes[0][0], 'colorRules');
check('existing colors are kept', JSON.parse(writes[0][1]),
  { Completed: '#a36e1f', Pending: '#123456' });
check('the picker closes', root.children.length, 0);
check('the grid repaints with it', /#123456/i.test(tbody.innerHTML), true);

// A hex typed by hand, including the shorthand and a missing '#'.
writes = [];
var pick = fire('.lg', { 'data-lgv': 'Not Started' });
root.children[0].querySelector('.hex').value = 'abc';
fire('.act', {});
check('shorthand hex expands', JSON.parse(writes[0][1])['Not Started'], '#aabbcc');

writes = [];
fire('.lg', { 'data-lgv': 'Not Started' });
var input = root.children[0].querySelector('.hex');
input.value = 'nope';
fire('.act', {});
check('invalid hex is not saved', writes.length, 0);
check('the input is flagged instead', input.classList.contains('bad'), true);
check('and the picker stays open', root.children.length, 1);

writes = [];
fire('.reset', {});
check('reset removes just that override', JSON.parse(writes[0][1]),
  { Completed: '#a36e1f', Pending: '#123456' });

console.log('\n--- picked colors survive the watchdog poll ---');
// The same clobber that lost saved text would lose a picked color, because
// config.get() has not caught up with our own write yet.
sandbox.__tick(); sandbox.__tick();
check('still painted after polling', /#123456/i.test(tbody.innerHTML), true);

console.log('\n--- advanced rules are not destroyed by the picker ---');
setConfig({ colorRules: '{"default":"#eeeeee","values":{"Completed":"#111111"},' +
  '"rules":[{"op":">=","value":10,"color":"#222222"}],"isnull":"#333333"}' });
writes = [];
fire('.lg', { 'data-lgv': 'Pending' });
fire('.opt', { 'data-hex': '#456789' });
var kept = JSON.parse(writes[0][1]);
check('numeric rules kept', kept.rules, [{ op: '>=', value: 10, color: '#222222' }]);
check('default kept', kept['default'], '#eeeeee');
check('presence test kept', kept.isnull, '#333333');
check('new color lands in values', kept.values,
  { Completed: '#111111', Pending: '#456789' });

console.log('\n--- blank values ---');
// Blanks are a real state on a Comments column, so they get a chip, and it is
// stored as the isnull presence test rather than as a literal empty string.
setConfig({ colorRules: '', colorColumn: ID.wit });
var blankChips = chips(root.innerHTML).filter(function (c) { return c === '\u0000blank'; });
check('a No value chip appears when blanks exist', blankChips.length, 1);
check('labelled for a business reader', /class="lgn">No value</.test(root.innerHTML), true);
writes = [];
fire('.lg', { 'data-lgv': '\u0000blank' });
fire('.opt', { 'data-hex': '#654321' });
check('stored as isnull', JSON.parse(writes[0][1]).isnull, '#654321');
setConfig({ colorColumn: ID.status, colorRules: '' });

console.log('\n--- legend overflow ---');
// A mis-picked color column must not emit hundreds of swatches.
setConfig({ colorColumn: ID.ts, colorRules: '' });
var valueChips = chips(root.innerHTML).filter(function (c) { return c !== '\u0000blank'; });
check('value chips are capped at the limit', valueChips.length, 24);
check('the remainder is reported', /\+\d+ more/.test(root.innerHTML), true);
setConfig({ colorColumn: ID.status, colorRules: '' });

console.log('\n--- max rows cap ---');
setConfig({ maxRows: '25', darkMode: false, compact: false });
check('note reports the truncation', /Showing the first 25 of 400 rows/.test(root.innerHTML), true);
setConfig({ maxRows: '0' });
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
setConfig({ source: 'el-paged', maxRows: '0', debug: true });

// The debug JSON is HTML-escaped, so quotes appear as &quot;.
function diag(field) {
  var m = new RegExp('&quot;' + field + '&quot;: ([^,\n]+)').exec(root.innerHTML);
  return m ? JSON.parse(m[1].replace(/[,\s]+$/, '')) : undefined;
}
// Array fields contain commas, so they need the whole bracketed span.
function diagArray(field) {
  var m = new RegExp('&quot;' + field + '&quot;: \\[([\\s\\S]*?)\\]').exec(root.innerHTML);
  if (!m) return undefined;
  return JSON.parse(('[' + m[1] + ']').replace(/&quot;/g, '"'));
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
setConfig({ source: 'el-resend', debug: true });
check('rewind on repeated offset, no duplicates', diag('rowsLoaded'), totalLen);

console.log('\n--- a delivery that adds no rows is not the end of the data ---');
/* Sigma answers a fetchMore with an empty chunk while it is still working. Treating
   that as end-of-data truncated the element at a page boundary and dropped whole
   stages -- and because the cut-off moved on every reload, cards vanished and came
   back. Two empty deliveries in the middle must not stop the load. */
pages = [
  { data: slice(0, cut), offset: 0, isComplete: false, totalRows: totalLen },
  { data: {}, offset: cut, isComplete: false, totalRows: totalLen },
  { data: {}, offset: cut, isComplete: false, totalRows: totalLen },
  { data: slice(cut, cut * 2), offset: cut, isComplete: false, totalRows: totalLen },
  { data: slice(cut * 2, totalLen), offset: cut * 2, isComplete: true, totalRows: totalLen }
];
fetchMores = 0; pager = null; timers = [];
setConfig({ source: 'el-hiccup', maxRows: '0', debug: true });
flushTimers();
check('the stall did not end the load', diag('rowsLoaded'), totalLen);
check('and the load is genuinely complete', diag('loadComplete'), true);
check('so nothing is reported as missing', diag('loadStalledIncomplete'), false);

console.log('\n--- host that never completes must give up AND say so ---');
pages = [
  { data: slice(0, cut), offset: 0, isComplete: false, totalRows: totalLen },
  { data: { }, offset: cut, isComplete: false, totalRows: totalLen },
  { data: { }, offset: cut, isComplete: false, totalRows: totalLen }
];
fetchMores = 0; pager = null; timers = [];
setConfig({ source: 'el-stalled', debug: true });
flushTimers();
check('it retried more than twice before giving up', fetchMores > 2, true);
check('it did stop rather than loop forever', fetchMores < 40, true);
check('the truncation is recorded, not disguised as success',
  diag('loadStalledIncomplete'), true);
check('and stated on screen',
  /Incomplete data/.test(root.innerHTML), true);
check('loading state cleared', loadingStates[loadingStates.length - 1], false);

console.log('\n--- a reload must not repaint until it is complete ---');
/* This is the bug the plan was written for: rows are sorted globally and then
   capped, so repainting a half-loaded reload showed the first N rows *of the
   fraction that had arrived* -- a different plate set roughly twenty times per
   reload. Step through a five-page reload and require the grid to hold still. */
autoSend = false;
// The fixture is 18 rows tall; give the viewport a smaller height than the grid so
// there is somewhere to scroll to, otherwise every scrollTop clamps to 0.
wrap.clientHeight = 120;
var small = sandbox.DATA;
var smallCols = Object.keys(small);
var smallLen = small[smallCols[0]].length;
function smallSlice(from, to) {
  var d = {};
  smallCols.forEach(function (k) { d[k] = small[k].slice(from, to); });
  return d;
}
function fivePages(data) {
  var n = data[smallCols[0]].length, step = Math.ceil(n / 5), out = [];
  for (var i = 0; i < n; i += step) {
    var d = {};
    smallCols.forEach(function (k) { d[k] = data[k].slice(i, i + step); });
    out.push({ data: d, offset: i, isComplete: i + step >= n, totalRows: n });
  }
  return out;
}

pages = fivePages(small);
fetchMores = 0; pager = null;
setConfig({ source: 'el-reload', rowColumns: [ID.plate, ID.plex], pivotColumn: ID.stage,
  valueColumns: [ID.ts, ID.op], colorColumn: ID.status, maxRows: '0', debug: true,
  // Earlier blocks left a sort in place; these checks reason about row order, so
  // put it back to plain ascending by the row key.
  sortRowColumn: [], sortRowDesc: false, sortColumnColumn: [], sortColumnDesc: false });
// Drive the first load to completion by hand.
while (pager.next < pages.length) pager.send();
check('first load painted the grid', countPills(tbody.innerHTML) > 0, true);
check('first load is complete', diag('loadComplete'), true);

var beforeRepaints = diag('repaints');
var beforeBuffered = diag('bufferedReloads');
var beforeGrid = tbody.innerHTML;
// Sigma re-runs the query: page 0 arrives again on the same subscription.
pager.next = 0;
var midChanged = 0;
for (var p = 0; p < pages.length; p++) {
  pager.send();
  if (p < pages.length - 1 && tbody.innerHTML !== beforeGrid) midChanged++;
}
check('grid was byte-identical through every partial page', midChanged, 0);
check('the reload repainted exactly once', diag('repaints') - beforeRepaints, 1);
check('the reload was buffered, not applied in place',
  diag('bufferedReloads') - beforeBuffered, 1);
check('and it ended with the buffer swapped in', diag('buffering'), false);
check('same rows after the reload', countPills(tbody.innerHTML), countPills(beforeGrid));

console.log('\n--- the viewport is restored by row, not by pixel ---');
var rowH2 = Number(/--row-h: (\d+)px/.exec(root.innerHTML)[1]);
/* Work in terms of the *detected* row key rather than assuming it is Plate Id:
   detection decides that, and this fixture pivots to six rows. A one-row viewport
   leaves room to scroll in a grid that short. */
var rkName = /&quot;rowKey&quot;: &quot;([^&]*)&quot;/.exec(root.innerHTML)[1];
var rkId = Object.keys(sandbox.COLUMNS).filter(function (id) {
  return sandbox.COLUMNS[id].name === rkName;
})[0];
var rkValues = [];
small[rkId].forEach(function (v) { if (rkValues.indexOf(v) === -1) rkValues.push(v); });
rkValues.sort();
check('fixture has rows to scroll through', rkValues.length >= 5, true);

wrap.clientHeight = rowH2;
wrap.scrollTop = 3 * rowH2;
wrap.fire('scroll', {});
pager.next = 0;
for (var q = 0; q < pages.length; q++) pager.send();
check('unchanged data restores the same offset', wrap.scrollTop, 3 * rowH2);

/* Now drop the two rows above the anchor. The old pixel offset would land two rows
   too far down; anchoring by row key must scroll up by exactly that much so the
   row the user was looking at stays where it was. */
function without(drop) {
  var d = {};
  smallCols.forEach(function (k) { d[k] = []; });
  for (var i = 0; i < smallLen; i++) {
    if (drop.indexOf(small[rkId][i]) !== -1) continue;
    smallCols.forEach(function (k) { d[k].push(small[k][i]); });
  }
  return d;
}
var droppedAbove = rkValues.slice(0, 2);
pages = fivePages(without(droppedAbove));
pager.next = 0;
for (var r = 0; r < pages.length; r++) pager.send();
check('anchor row kept its pixel offset after 2 rows vanished above it',
  wrap.scrollTop, 1 * rowH2);

console.log('\n--- a genuinely missing anchor row is reported ---');
wrap.scrollTop = 0;
wrap.fire('scroll', {});
// The row now at the top is the first one that survived; remove that too.
var vanishing = rkValues[2];
pages = fivePages(without(droppedAbove.concat([vanishing])));
pager.next = 0;
for (var s = 0; s < pages.length; s++) pager.send();
var warn = root.children.filter(function (c) { return c.className === 'note warn'; });
check('a warning note was appended', warn.length, 1);
check('it names the row that disappeared',
  warn.length ? warn[0].innerHTML.indexOf(String(vanishing)) !== -1 : false, true);
check('and the view sits at the top', wrap.scrollTop, 0);
check('no note is left behind when the anchor is found', (function () {
  root.children = [];
  pager.next = 0;
  for (var t = 0; t < pages.length; t++) pager.send();
  return root.children.filter(function (c) { return c.className === 'note warn'; }).length;
})(), 0);
autoSend = true;

console.log('\n--- column widths are pinned across a reload ---');
var widthBefore = /<col style="width:(\d+)px">/.exec(root.innerHTML)[1];
pager.next = 0;
for (var u = 0; u < pages.length; u++) pager.send();
check('same measured cell width', /<col style="width:(\d+)px">/.exec(root.innerHTML)[1],
  widthBefore);
wrap.clientHeight = 600;


console.log('\n--- ragged pages must not shift a column out of alignment ---');
/* Columns are parallel arrays. If a page delivers fewer values for one column --
   or omits it entirely -- appending the next page onto it would slide every later
   value of that column up, putting a card's values under the wrong stage and
   blanking the cards whose values drifted away. Pad instead. */
autoSend = false;
var alignPages = fivePages(small);
// Page 2 is short by three values for Operator, and omits Witness altogether.
alignPages[1].data[ID.op] = alignPages[1].data[ID.op].slice(0, -3);
delete alignPages[1].data[ID.wit];
pages = alignPages;
pager = null;
setConfig({ source: 'el-ragged', rowColumns: [ID.plate, ID.plex], pivotColumn: ID.stage,
  valueColumns: [ID.ts, ID.op], colorColumn: ID.status, maxRows: '0', debug: true,
  sortRowColumn: [], sortRowDesc: false, sortColumnColumn: [], sortColumnDesc: false });
while (pager.next < pages.length) pager.send();

check('padding was needed and recorded', diag('paddedValues') > 0, true);

/* The real check: every plate/stage pair that the *source* says is populated must
   still be populated on screen, and with the same operator. Rebuild the truth
   directly from the fixture and compare against the rendered grid. */
/* Truth comes from re-assembling the pages the same way a correct reader would --
   pad each column to the page offset, then append -- so the three Operator values
   the ragged page never sent are absent from both sides of the comparison. */
var assembled = {};
alignPages.forEach(function (pg) {
  smallCols.forEach(function (k) {
    if (!assembled[k]) assembled[k] = [];
    while (assembled[k].length < pg.offset) assembled[k].push(null);
    (pg.data[k] || []).forEach(function (v) { assembled[k].push(v); });
  });
});
var truth = {};
for (var i = 0; i < assembled[ID.plate].length; i++) {
  var op = assembled[ID.op][i];
  if (op === null || op === undefined || op === '') continue;
  truth[assembled[ID.plate][i] + '\u0001' + assembled[ID.stage][i]] = String(op);
}
wrap.clientHeight = 4000;                       // render every row in one window
wrap.scrollTop = 0;
wrap.fire('scroll', {});
var wrong = [], checked = 0;
Object.keys(truth).forEach(function (k) {
  var parts = k.split('\u0001');
  var re = new RegExp('data-row="' + parts[0] + '" data-col="' + parts[1] +
    '">([\\s\\S]*?)</button>');
  var m = re.exec(tbody.innerHTML);
  checked++;
  if (!m || m[1].indexOf(truth[k]) === -1) wrong.push(k);
});
check('every populated cell was checked', checked, Object.keys(truth).length);
check('no cell lost or misplaced its operator after ragged pages', wrong, []);
wrap.clientHeight = 600;
autoSend = true;


console.log('\n--- the cell probe reports what the element actually sent ---');
pages = onePage(sandbox.DATA);
pager = null;
var probePlate = small[ID.plate][0];
var probeStage = small[ID.stage][0];
setConfig({ source: 'el-probe', rowColumns: [ID.plate, ID.plex], pivotColumn: ID.stage,
  valueColumns: [ID.ts, ID.op], colorColumn: ID.status, maxRows: '0', debug: true,
  debugCell: probePlate + ' | ' + probeStage });
var probeText = root.innerHTML;
check('the probe found the row', /&quot;sourceRowsForThisRow&quot;: [1-9]/.test(probeText), true);
check('and reports the pair as present',
  /&quot;displayedByTheGrid&quot;: [1-9]/.test(probeText), true);
check('and confirms it is a pivot column',
  /&quot;isAPivotColumn&quot;: true/.test(probeText), true);
check('the probe shows the markup emitted for the cell',
  /&quot;renderedHtml&quot;: &quot;&lt;td/.test(probeText), true);
check('and that markup contains a pill',
  /&quot;cardsInThisRowsHtml&quot;: [1-9]/.test(probeText), true);
check('the probe reports the grid row it found',
  /&quot;gridRow&quot;: [0-9]/.test(probeText), true);
check('and the header each cell of that row sits under',
  /&quot;rowAsRendered&quot;: \[/.test(probeText), true);
// The point of the coordinates: a card under the wrong header is not "displayed".
check('every located cell sits under its own stage',
  /&quot;headerMatchesItsStage&quot;: false/.test(probeText), false);

// A pair the element never sent: the probe must say so, not stay silent.
setConfig({ debugCell: probePlate + ' | NO-SUCH-STAGE' });
check('a pair with no source rows is called out',
  /streamed no row for this row.column pair/.test(root.innerHTML), true);

setConfig({ debugCell: 'NOT-A-PLATE' });
check('an unknown row value is called out',
  /No source row has this value/.test(root.innerHTML), true);
setConfig({ debugCell: '' });


console.log('\n--- a stalled RELOAD must keep the data it already had ---');
/* The write-back case: Sigma re-runs the query, stalls part way, and the plugin used
   to swap the partial buffer in anyway -- destroying a complete grid to show an
   incomplete one. That is what made a card vanish right after a comment was saved. */
autoSend = false;
pages = fivePages(small);
pager = null; timers = [];
setConfig({ source: 'el-reload-stall', rowColumns: [ID.plate, ID.plex], pivotColumn: ID.stage,
  valueColumns: [ID.ts, ID.op], colorColumn: ID.status, maxRows: '0', debug: true,
  sortRowColumn: [], sortRowDesc: false, sortColumnColumn: [], sortColumnDesc: false });
while (pager.next < pages.length) pager.send();
var completeGrid = tbody.innerHTML;
var completeCards = countPills(completeGrid);
check('the first load is complete', diag('loadComplete'), true);
check('and has cards', completeCards > 0, true);

// Reload delivers only its first page, then goes silent forever.
pages = [fivePages(small)[0]];
pager.next = 0;
pager.send();
/* Nothing more will ever arrive. Drive the silence watchdog to exhaustion -- note
   the queue must NOT be cleared here, since the watchdog lives in it. */
for (var w = 0; w < 40 && !diag('reloadStalledAndWasDiscarded'); w++) flushTimers(1);
check('the stalled reload was discarded', diag('reloadStalledAndWasDiscarded'), true);
check('the complete grid is still on screen', countPills(tbody.innerHTML), completeCards);
check('and the failure is stated', /Refresh did not finish/.test(root.innerHTML), true);
check('it is not misreported as a truncated first load',
  diag('loadStalledIncomplete'), false);
autoSend = true;

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
