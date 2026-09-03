/* Pill color resolution: auto-palette by default, JSON rules override. */
(function (global) {
  'use strict';

  // Light, Sigma-native palette: soft tinted fills with dark readable text.
  var LIGHT_PALETTE = [
    { bg: '#e3edfb', fg: '#1b3f6b', border: '#bcd4f2' },
    { bg: '#fdf1d4', fg: '#6b4e0d', border: '#f0dda6' },
    { bg: '#dff2e9', fg: '#14543c', border: '#b6e0cd' },
    { bg: '#f3e6f7', fg: '#5a2a66', border: '#e0c7e8' },
    { bg: '#fce6df', fg: '#71301d', border: '#f4c8ba' },
    { bg: '#e6f0f8', fg: '#1d4a63', border: '#c3dcea' },
    { bg: '#eaeaf6', fg: '#33356b', border: '#cdcde8' },
    { bg: '#f2f0dc', fg: '#5a5417', border: '#dedaad' }
  ];
  var LIGHT_NEUTRAL = { bg: '#f4f5f7', fg: '#6b7684', border: '#e4e7ec' };

  // Dark counterpart: same hue order, deep muted fills with light text.
  var DARK_PALETTE = [
    { bg: '#1c3050', fg: '#bcd6f7', border: '#2b4a72' },
    { bg: '#3d3116', fg: '#f0dca4', border: '#544325' },
    { bg: '#153a2c', fg: '#a9dcc4', border: '#22513e' },
    { bg: '#33203a', fg: '#dcb8e6', border: '#472e50' },
    { bg: '#42231a', fg: '#f3bda9', border: '#5a332a' },
    { bg: '#16303d', fg: '#a8cfe1', border: '#234353' },
    { bg: '#22233f', fg: '#c0c2e8', border: '#333457' },
    { bg: '#343218', fg: '#dfd9a6', border: '#494628' }
  ];
  var DARK_NEUTRAL = { bg: '#23272e', fg: '#8b96a5', border: '#333944' };

  var PALETTE = LIGHT_PALETTE;
  var NEUTRAL = LIGHT_NEUTRAL;

  // The pill palette has to follow the shell theme, so app.js flips it alongside
  // the CSS variables rather than each resolve() call carrying a theme argument.
  function setTheme(name) {
    var dark = name === 'dark';
    PALETTE = dark ? DARK_PALETTE : LIGHT_PALETTE;
    NEUTRAL = dark ? DARK_NEUTRAL : LIGHT_NEUTRAL;
  }

  function hash(str) {
    var h = 0;
    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function readableOn(bg) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(bg).trim());
    if (!m) return '#ffffff';
    var n = parseInt(m[1], 16);
    var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    // Relative luminance -> pick light or dark text.
        var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.55 ? '#12151a' : '#ffffff';
  }

  function asStyle(spec) {
    if (!spec) return null;
    if (typeof spec === 'string') {
      return { bg: spec, fg: readableOn(spec), border: 'transparent' };
    }
    var bg = spec.bg || spec.background || spec.backgroundColor || spec.color;
    if (!bg) return null;
    return {
      bg: bg,
      fg: spec.fg || spec.text || spec.textColor || readableOn(bg),
      border: spec.border || spec.borderColor || 'transparent'
    };
  }

  /* Accepted JSON shapes:
       {"Completed": "#1d3a5c", "Pending": "#4a3c12"}
       {"isnotnull": "#1d3a5c", "isnull": "#f4f5f7"}
       { "default": "#23262e",
         "values": { "Completed": {"bg":"#1d3a5c","fg":"#cfe3f7"} },
         "rules": [ {"op":">=","value":10,"color":"#4a2118"},
                    {"contains":"error","color":"#7a1f1f"},
                    {"op":"isnull","color":"#f4f5f7"} ] }  */

  // Reserved keys for presence tests, so "has a comment / has none" needs no rule
  // array. Recognized in the flat map and under "values".
  var NULL_KEYS = { 'null': 1, isnull: 1, 'is null': 1, empty: 1, blank: 1, none: 1, 'no value': 1 };
  var NOT_NULL_KEYS = { notnull: 1, isnotnull: 1, 'is not null': 1, 'not null': 1,
    notempty: 1, 'not empty': 1, nonempty: 1, filled: 1, 'has value': 1, any: 1 };

  function isNullOp(op) { return !!NULL_KEYS[String(op).toLowerCase()]; }
  function isNotNullOp(op) { return !!NOT_NULL_KEYS[String(op).toLowerCase()]; }

  function compile(json) {
    var parsed = null;
    if (json && String(json).trim()) {
      try { parsed = JSON.parse(json); }
      catch (e) { return { error: e.message, values: {}, rules: [], fallback: null, nullStyle: null, notNullStyle: null }; }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { error: null, values: {}, rules: [], fallback: null, nullStyle: null, notNullStyle: null };
    }

    var values = {}, rules = [], fallback = null, nullStyle = null, notNullStyle = null;
    var hasEnvelope = parsed.values || parsed.rules || parsed['default'];

    // Presence keys are pulled out of the flat shorthand map rather than matched
    // by text, so they fire on absent data instead of on a literal "isnull" cell
    // value. Inside the explicit "values" map every key stays literal, which is
    // the escape hatch for data that really does read "isnull".
    function takeValues(map, allowPresence) {
      Object.keys(map || {}).forEach(function (k) {
        var s = asStyle(map[k]);
        if (!s) return;
        if (allowPresence && isNullOp(k)) nullStyle = s;
        else if (allowPresence && isNotNullOp(k)) notNullStyle = s;
        else values[String(k).toLowerCase()] = s;
      });
    }

    if (hasEnvelope) {
      takeValues(parsed.values, false);
      // Presence tests may also sit beside "values" as a convenience.
      Object.keys(parsed).forEach(function (k) {
        if (k === 'values' || k === 'rules' || k === 'default') return;
        var s = asStyle(parsed[k]);
        if (!s) return;
        if (isNullOp(k)) nullStyle = s;
        else if (isNotNullOp(k)) notNullStyle = s;
      });
      (parsed.rules || []).forEach(function (r) {
        var s = asStyle(r.color || r.style || r);
        if (!s) return;
        if (isNullOp(r.op)) { nullStyle = nullStyle || s; return; }
        if (isNotNullOp(r.op)) { notNullStyle = notNullStyle || s; return; }
        rules.push({ op: r.op, value: r.value, contains: r.contains, style: s });
      });
      fallback = asStyle(parsed['default']);
    } else {
      takeValues(parsed, true);
    }
    return { error: null, values: values, rules: rules, fallback: fallback,
      nullStyle: nullStyle, notNullStyle: notNullStyle };
  }

  function matchRule(rule, raw) {
    if (rule.contains !== undefined && rule.contains !== null) {
      return String(raw).toLowerCase().indexOf(String(rule.contains).toLowerCase()) !== -1;
    }
    if (rule.op) {
      var a = Number(raw), b = Number(rule.value);
      if (!isFinite(a) || !isFinite(b)) return false;
      switch (rule.op) {
        case '>': return a > b;
        case '>=': return a >= b;
        case '<': return a < b;
        case '<=': return a <= b;
        case '=': case '==': return a === b;
        case '!=': return a !== b;
        default: return false;
      }
    }
    return false;
  }

  /**
   * @param raw      the value of the color column for this cell
   * @param compiled output of compile()
   * @param autoMode when true, unmatched values get a stable palette color
   * @param domain   ordered list of distinct color values, for stable auto assignment
   */
  function resolve(raw, compiled, autoMode, domain) {
    // Whitespace-only text counts as "no value" -- a comment of " " is not a comment.
    var absent = raw === null || raw === undefined ||
      (typeof raw === 'string' && raw.trim() === '');

    if (absent) {
      return compiled.nullStyle || compiled.fallback || NEUTRAL;
    }

    var lower = String(raw).toLowerCase();
    if (compiled.values[lower]) return compiled.values[lower];

    for (var i = 0; i < compiled.rules.length; i++) {
      if (matchRule(compiled.rules[i], raw)) return compiled.rules[i].style;
    }

    // An explicit "anything present" color outranks the auto palette; otherwise
    // isnotnull would be ignored whenever the palette toggle is on.
    if (compiled.notNullStyle) return compiled.notNullStyle;

    if (autoMode) {
      var idx = domain ? domain.indexOf(String(raw)) : -1;
      if (idx < 0) idx = hash(String(raw));
      return PALETTE[idx % PALETTE.length];
    }

    return compiled.fallback || NEUTRAL;
  }

  global.PivotColors = {
    compile: compile, resolve: resolve, setTheme: setTheme,
    get PALETTE() { return PALETTE; },
    get NEUTRAL() { return NEUTRAL; },
    readableOn: readableOn
  };
})(window);
