/* Value formatting that inherits Sigma column format metadata.
   Implements the subset of d3-format / d3-time-format that Sigma emits. */
(function (global) {
  'use strict';

  var MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  var DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

  function pad(n, width) {
    var s = String(Math.abs(n));
    while (s.length < (width || 2)) s = '0' + s;
    return (n < 0 ? '-' : '') + s;
  }

  // Sigma hands dates over as ISO strings, epoch seconds, epoch millis, or Date.
  function parseDate(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
    if (typeof value === 'number') {
      var ms = Math.abs(value) < 1e10 ? value * 1000 : value;
      var d = new Date(ms);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof value === 'string') {
      var n = Number(value);
      if (value.trim() !== '' && !isNaN(n) && !/[-:T/]/.test(value)) return parseDate(n);
      var p = new Date(value);
      return isNaN(p.getTime()) ? null : p;
    }
    return null;
  }

  function timeFormat(date, spec) {
    return String(spec).replace(/%([a-zA-Z%])/g, function (_, c) {
      switch (c) {
        case 'Y': return String(date.getFullYear());
        case 'y': return pad(date.getFullYear() % 100);
        case 'm': return pad(date.getMonth() + 1);
        case 'd': return pad(date.getDate());
        case 'e': return String(date.getDate());
        case 'H': return pad(date.getHours());
        case 'I': return pad(((date.getHours() + 11) % 12) + 1);
        case 'M': return pad(date.getMinutes());
        case 'S': return pad(date.getSeconds());
        case 'L': return pad(date.getMilliseconds(), 3);
        case 'p': return date.getHours() < 12 ? 'AM' : 'PM';
        case 'B': return MONTHS[date.getMonth()];
        case 'b': return MONTHS[date.getMonth()].slice(0, 3);
        case 'A': return DAYS[date.getDay()];
        case 'a': return DAYS[date.getDay()].slice(0, 3);
        case 'j': return pad(Math.floor((date - new Date(date.getFullYear(), 0, 0)) / 864e5), 3);
        case '%': return '%';
        default: return c;
      }
    });
  }

  // Parse the numeric bits of a d3-format spec: [prefix]type with , grouping and .N precision.
  function numberFormat(value, spec, formatType) {
    var num = Number(value);
    if (!isFinite(num)) return String(value);

    var s = String(spec || '');
    var currency = /^\$/.test(s) || formatType === 'currency';
    var percent = /%$/.test(s) || formatType === 'percent';
    var compact = /s$/.test(s) || formatType === 'compact';
    var grouping = s.indexOf(',') !== -1;
    var precMatch = s.match(/\.(\d+)/);
    var precision = precMatch ? Number(precMatch[1]) : null;

    if (percent) num = num * 100;

    var opts = { useGrouping: grouping || currency || compact };
    if (precision !== null) {
      opts.minimumFractionDigits = precision;
      opts.maximumFractionDigits = precision;
    } else if (/d$/.test(s)) {
      opts.maximumFractionDigits = 0;
    } else {
      opts.maximumFractionDigits = 2;
    }
    if (compact) {
      opts.notation = 'compact';
      opts.compactDisplay = 'short';
    }
    if (currency) {
      opts.style = 'currency';
      opts.currency = 'USD';
      if (precision === null) { opts.minimumFractionDigits = 0; opts.maximumFractionDigits = 2; }
    }

    var out;
    try {
      out = new Intl.NumberFormat(undefined, opts).format(num);
    } catch (e) {
      out = String(num);
    }
    return percent ? out + '%' : out;
  }

  var DEFAULT_DATE = '%m/%d, %H:%M';

  /**
   * Format one cell value using the Sigma ColumnInfo for its column.
   * colInfo: { name, columnType, format?: { type, format } }
   */
  function formatValue(value, colInfo) {
    if (value === null || value === undefined || value === '') return '';
    var info = colInfo || {};
    var fmt = info.format || {};
    var type = info.columnType || '';
    var isTemporal = type === 'datetime' || type === 'date' || fmt.type === 'date';

    if (isTemporal) {
      var d = parseDate(value);
      if (!d) return String(value);
      var spec = fmt.format;
      if (!spec) spec = type === 'date' ? '%m/%d/%Y' : DEFAULT_DATE;
      return timeFormat(d, spec);
    }

    if (type === 'number' || type === 'integer' || typeof value === 'number') {
      if (fmt.format || fmt.type) return numberFormat(value, fmt.format, fmt.type);
      return numberFormat(value, type === 'integer' ? ',d' : ',', null);
    }

    if (typeof value === 'boolean') return value ? 'True' : 'False';
    return String(value);
  }

  global.PivotFormat = { formatValue: formatValue, parseDate: parseDate, timeFormat: timeFormat };
})(window);
