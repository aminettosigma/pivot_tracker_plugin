/* Pill colour resolution: auto-palette by default, JSON rules override. */
(function (global) {
  'use strict';

  // Light, Sigma-native palette: soft tinted fills with dark readable text.
  var PALETTE = [
    { bg: '#e3edfb', fg: '#1b3f6b', border: '#bcd4f2' },
    { bg: '#fdf1d4', fg: '#6b4e0d', border: '#f0dda6' },
    { bg: '#dff2e9', fg: '#14543c', border: '#b6e0cd' },
    { bg: '#f3e6f7', fg: '#5a2a66', border: '#e0c7e8' },
    { bg: '#fce6df', fg: '#71301d', border: '#f4c8ba' },
    { bg: '#e6f0f8', fg: '#1d4a63', border: '#c3dcea' },
    { bg: '#eaeaf6', fg: '#33356b', border: '#cdcde8' },
    { bg: '#f2f0dc', fg: '#5a5417', border: '#dedaad' }
  ];
  var NEUTRAL = { bg: '#f4f5f7', fg: '#6b7684', border: '#e4e7ec' };

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
       { "default": "#23262e",
         "values": { "Completed": {"bg":"#1d3a5c","fg":"#cfe3f7"} },
         "rules": [ {"op":">=","value":10,"color":"#4a2118"},
                    {"contains":"error","color":"#7a1f1f"} ] }  */
  function compile(json) {
    var parsed = null;
    if (json && String(json).trim()) {
      try { parsed = JSON.parse(json); }
      catch (e) { return { error: e.message, values: {}, rules: [], fallback: null }; }
    }
    if (!parsed || typeof parsed !== 'object') {
      return { error: null, values: {}, rules: [], fallback: null };
    }

    var values = {}, rules = [], fallback = null;
    var hasEnvelope = parsed.values || parsed.rules || parsed['default'];

    if (hasEnvelope) {
      Object.keys(parsed.values || {}).forEach(function (k) {
        var s = asStyle(parsed.values[k]);
        if (s) values[String(k).toLowerCase()] = s;
      });
      (parsed.rules || []).forEach(function (r) {
        var s = asStyle(r.color || r.style || r);
        if (s) rules.push({ op: r.op, value: r.value, contains: r.contains, style: s });
      });
      fallback = asStyle(parsed['default']);
    } else {
      Object.keys(parsed).forEach(function (k) {
        var s = asStyle(parsed[k]);
        if (s) values[String(k).toLowerCase()] = s;
      });
    }
    return { error: null, values: values, rules: rules, fallback: fallback };
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
   * @param raw      the value of the colour column for this cell
   * @param compiled output of compile()
   * @param autoMode when true, unmatched values get a stable palette colour
   * @param domain   ordered list of distinct colour values, for stable auto assignment
   */
  function resolve(raw, compiled, autoMode, domain) {
    if (raw === null || raw === undefined || raw === '') return NEUTRAL;

    var lower = String(raw).toLowerCase();
    if (compiled.values[lower]) return compiled.values[lower];

    for (var i = 0; i < compiled.rules.length; i++) {
      if (matchRule(compiled.rules[i], raw)) return compiled.rules[i].style;
    }

    if (autoMode) {
      var idx = domain ? domain.indexOf(String(raw)) : -1;
      if (idx < 0) idx = hash(String(raw));
      return PALETTE[idx % PALETTE.length];
    }

    return compiled.fallback || NEUTRAL;
  }

  global.PivotColors = {
    compile: compile, resolve: resolve, PALETTE: PALETTE, NEUTRAL: NEUTRAL, readableOn: readableOn
  };
})(window);
