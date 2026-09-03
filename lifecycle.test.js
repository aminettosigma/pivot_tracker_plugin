/* Throwaway check of the config lifecycle: (1) recovery when the config emission
   is dropped, as happens when Sigma re-mounts the iframe; (2) re-subscription
   when the requested column set changes. Minimal fake DOM -- no rendering. */
var fs = require('fs'), vm = require('vm'), path = require('path');
var dir = '/Users/aminetto/Documents/CoCo/pivot-tracker-plugin';

var harness = fs.readFileSync(path.join(dir, 'harness.html'), 'utf8');
var fixtureSrc = harness.slice(harness.indexOf('var PLATES ='), harness.indexOf('var CASES ='));

var failures = 0;
function check(label, got, want) {
  var ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + label + '\n        got      ' + JSON.stringify(got) +
    (ok ? '' : '\n        expected ' + JSON.stringify(want)));
}

function el() {
  return {
    innerHTML: '', style: {}, classList: { toggle: function () {}, add: function () {} },
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; },
    addEventListener: function () {},
    getBoundingClientRect: function () { return { width: 100 }; }
  };
}

var s = { console: console, setTimeout: setTimeout, setInterval: function (fn, ms) { s.__tick = fn; return 1; } };
s.window = s; s.global = s;
s.document = { body: el(), getElementById: function () { return s.__root; }, addEventListener: function () {} };
s.__root = el();
s.window.addEventListener = function () {};
vm.createContext(s);
vm.runInContext(fixtureSrc, s);

// Fake host: config lives here; subscribe emissions are opt-in so we can drop them.
var live = {};
var emit = null;
var dataSubs = [];
var emissionsEnabled = true;

s.SigmaPlugin = {
  client: {
      config: {
        configureEditorPanel: function () {},
        subscribe: function (fn) { emit = fn; return function () {}; },
        get: function () { return live; },
        setVariable: function () {}, triggerAction: function () {}
      },
      elements: {
        subscribeToElementColumns: function (id, cb) {
          dataSubs.push({ kind: 'cols', id: id }); cb(s.COLUMNS); return function () {};
        },
        subscribeToElementData: function (id, cb) {
          dataSubs.push({ kind: 'data', id: id }); cb(s.DATA); return function () {};
        }
      }
  }
};

['format.js', 'pivot.js', 'colors.js', 'styles.js', 'app.js'].forEach(function (f) {
  vm.runInContext(fs.readFileSync(path.join(dir, f), 'utf8'), s);
});

var ID = { plate: 'bnCIySI63i', plex: 'A_a_zhT8Gy', stage: 'haTtgretpP',
  ts: 'zLAH_1E7c5', op: 'g3luCwWUhA', status: 'jN9Qax5zgq', cap: 'ilQ8D-l17P' };

check('placeholder is US spelling', /Initializing/.test(s.__root.innerHTML), true);
check('no config emission yet -> no data subscriptions', dataSubs.length, 0);

console.log('\n--- emission dropped (iframe re-mount), poll must recover ---');
live = { source: 'el-plate-stages', rowColumns: [ID.plate, ID.plex],
  pivotColumn: ID.stage, valueColumns: [ID.ts, ID.op], colorColumn: ID.status };
emissionsEnabled = false;              // host never calls our subscriber
s.__tick();                            // the 400ms watchdog
check('poll subscribed to the element', dataSubs.map(function (d) { return d.kind; }), ['cols', 'data']);
check('grid rendered without a refresh', /class="pill"/.test(s.__root.innerHTML), true);

console.log('\n--- idle poll must not churn ---');
var before = dataSubs.length;
s.__tick(); s.__tick();
check('no redundant re-subscribe', dataSubs.length, before);

console.log('\n--- a newly picked column must re-request data ---');
live = Object.assign({}, live, { valueColumns: [ID.ts, ID.op, ID.cap] });
emit(live);
check('re-subscribed for the wider scope',
  dataSubs.slice(before).map(function (d) { return d.kind; }), ['cols', 'data']);
check('capacity moved into the header', /\(80\)/.test(s.__root.innerHTML), true);

console.log('\n--- same config re-emitted must be a no-op ---');
before = dataSubs.length;
emit(Object.assign({}, live));
check('no re-subscribe on identical config', dataSubs.length, before);

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'all checks passed'));
process.exit(failures ? 1 : 0);
