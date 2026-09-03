/* Per-column text formatting: font size, weight, style, color, case, alignment.
   The pivot's column count is dynamic, so styles are declared as JSON keyed by
   column name rather than as fixed editor-panel entries. */
(function (global) {
  'use strict';

  // Reserved keys that target chrome rather than a data column.
  var WILDCARD = '*';
  var HEADER = 'header';        // pivot column headers
  var LEFT_HEADER = 'leftheader'; // the left columns' header row

  var TRUTHY = { true: 1, yes: 1, on: 1, '1': 1 };

  function truthy(v) {
    if (typeof v === 'boolean') return v;
    if (v === undefined || v === null) return false;
    return !!TRUTHY[String(v).toLowerCase()];
  }

  /* A bare string is treated as shorthand for a set of flags, so
     "bold italic 13px #333" works as well as the object form. */
  function fromShorthand(str) {
    var out = {};
    String(str).split(/\s+/).forEach(function (tok) {
      if (!tok) return;
      var low = tok.toLowerCase();
      if (low === 'bold') out.bold = true;
      else if (low === 'italic') out.italic = true;
      else if (low === 'underline') out.underline = true;
      else if (low === 'uppercase' || low === 'caps') out.uppercase = true;
      else if (low === 'left' || low === 'right' || low === 'center') out.align = low;
      else if (/^#|^rgb|^hsl/.test(low)) out.color = tok;
      else if (/^[\d.]+(px|pt|em|rem|%)?$/.test(low)) out.size = tok;
    });
    return out;
  }

  function normalize(spec) {
    if (spec === null || spec === undefined) return null;
    if (typeof spec === 'string') spec = fromShorthand(spec);
    if (typeof spec !== 'object') return null;

    var out = {};
    var size = spec.size !== undefined ? spec.size : spec.fontSize;
    if (size !== undefined && size !== null && size !== '') {
      // A bare number means px, which is what people expect from "size: 13".
      out.size = /^[\d.]+$/.test(String(size)) ? String(size) + 'px' : String(size);
    }
    if (truthy(spec.bold) || String(spec.weight || '').toLowerCase() === 'bold') out.bold = true;
    if (spec.weight !== undefined && !out.bold && /^\d+$/.test(String(spec.weight))) {
      out.weight = String(spec.weight);
    }
    if (truthy(spec.italic)) out.italic = true;
    if (truthy(spec.underline)) out.underline = true;
    if (truthy(spec.uppercase) || truthy(spec.caps)) out.uppercase = true;
    var color = spec.color !== undefined ? spec.color : spec.textColor;
    if (color) out.color = String(color);
    if (spec.background || spec.bg) out.background = String(spec.background || spec.bg);
    var align = spec.align || spec.textAlign;
    if (align) out.align = String(align).toLowerCase();
    if (spec.opacity !== undefined && spec.opacity !== '') out.opacity = String(spec.opacity);
    return Object.keys(out).length ? out : null;
  }

  /* Returns { byName: {lowercased name -> spec}, wildcard, header, leftHeader, error }. */
  function compile(json) {
    var empty = { byName: {}, wildcard: null, header: null, leftHeader: null, error: null };
    if (!json || !String(json).trim()) return empty;

    var parsed;
    try { parsed = JSON.parse(json); }
    catch (e) { empty.error = 'Column formatting JSON is invalid: ' + e.message; return empty; }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      empty.error = 'Column formatting JSON must be an object keyed by column name.';
      return empty;
    }

    var out = { byName: {}, wildcard: null, header: null, leftHeader: null, error: null };
    Object.keys(parsed).forEach(function (key) {
      var spec = normalize(parsed[key]);
      if (!spec) return;
      var k = key.trim().toLowerCase();
      if (k === WILDCARD) out.wildcard = spec;
      else if (k === HEADER) out.header = spec;
      else if (k === LEFT_HEADER) out.leftHeader = spec;
      else out.byName[k] = spec;
    });
    return out;
  }

  function merge(base, over) {
    if (!base) return over || null;
    if (!over) return base;
    var out = {};
    Object.keys(base).forEach(function (k) { out[k] = base[k]; });
    Object.keys(over).forEach(function (k) { out[k] = over[k]; });
    return out;
  }

  /* Resolve the spec for a column, wildcard first so a name can override it.
     `slot` may be 'header' or 'leftHeader' to pull in that chrome spec too. */
  function forColumn(compiled, name, slot) {
    if (!compiled) return null;
    var spec = compiled.wildcard;
    if (slot === 'header') spec = merge(spec, compiled.header);
    if (slot === 'leftHeader') spec = merge(spec, compiled.leftHeader);
    if (name) spec = merge(spec, compiled.byName[String(name).trim().toLowerCase()]);
    return spec;
  }

  /* Inline CSS text. Empty string when nothing is set, so callers can drop the
     attribute entirely rather than emitting style="". */
  function css(spec) {
    if (!spec) return '';
    var parts = [];
    if (spec.size) parts.push('font-size:' + spec.size);
    if (spec.bold) parts.push('font-weight:700');
    else if (spec.weight) parts.push('font-weight:' + spec.weight);
    if (spec.italic) parts.push('font-style:italic');
    if (spec.underline) parts.push('text-decoration:underline');
    if (spec.uppercase) parts.push('text-transform:uppercase');
    if (spec.color) parts.push('color:' + spec.color);
    if (spec.background) parts.push('background:' + spec.background);
    if (spec.align) parts.push('text-align:' + spec.align);
    if (spec.opacity) parts.push('opacity:' + spec.opacity);
    return parts.join(';');
  }

  global.PivotStyles = {
    compile: compile, forColumn: forColumn, css: css, normalize: normalize, merge: merge
  };
})(window);
