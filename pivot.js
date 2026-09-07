/* Auto-detects the pivot layout from a Sigma pivot-table element's flat, column-oriented data.

   Sigma hands a plugin the pivot's underlying rows, not a pre-pivoted grid, so we
   recover the layout structurally:

     - pivotColumn : a dimension whose values become the crosstab headers
     - rowKey      : the dimension that identifies one output row
     - rowColumns  : rowKey plus every dimension functionally dependent on it
                     (constant per rowKey) -> these are the "left side" columns
     - valueColumns: everything left over -> rendered inside the cell pill

   The (rowKey, pivotColumn) pair is chosen as the dimension pair that most nearly
   forms a complete grid and uniquely identifies each source row.

   Everything here reads the column arrays by index. Materializing one object per
   source row costs ~380 MB and seconds of GC at 390k rows, and nothing needs the
   objects -- every probe is a single pass over one or two columns. */
(function (global) {
  'use strict';

  // Above this many rows, structural probes run on a prefix rather than the whole
  // column. Probing every candidate pair across 1M rows costs seconds on the main
  // thread, and a prefix answers the same question for real pivot data.
  var SAMPLE_LIMIT = 20000;
  var PROBE_LIMIT = 50000;

  var NULL_KEY = '\u0000null';

  /* Map keys. Using the raw value avoids building a string per row per column --
     at 1M rows that string building dominated detection. A Map distinguishes 1
     from '1' natively, which is what the old typeof-prefixed string key was for. */
  function mapKey(v) {
    if (v === null || v === undefined) return NULL_KEY;
    if (v instanceof Date) return '\u0000d' + v.getTime();
    if (typeof v === 'object') return '\u0000o' + String(v);
    return v;
  }

  function rowCount(data, colIds) {
    var n = 0;
    for (var i = 0; i < colIds.length; i++) {
      var arr = data[colIds[i]];
      if (Array.isArray(arr) && arr.length > n) n = arr.length;
    }
    return n;
  }

  /* Kept for callers that genuinely want objects (tests, ad-hoc inspection).
     The detection path deliberately does not use it. */
  function toRows(data, colIds) {
    var n = rowCount(data, colIds);
    var rows = [];
    for (var i = 0; i < n; i++) {
      var row = {};
      for (var j = 0; j < colIds.length; j++) {
        var arr = data[colIds[j]];
        row[colIds[j]] = arr ? arr[i] : null;
      }
      rows.push(row);
    }
    return rows;
  }

  function key(v) {
    if (v === null || v === undefined) return '\u0000null';
    if (v instanceof Date) return 'd' + v.getTime();
    return typeof v + ':' + String(v);
  }

  function distinct(data, colId, n) {
    var arr = data[colId];
    if (!arr) return 0;
    var set = new Set();
    for (var i = 0; i < n; i++) set.add(mapKey(arr[i]));
    return set.size;
  }

  /* Exact cardinality costs a full pass per column -- 2.2 s across 9 columns at 2M
     rows, the single biggest cost in detection. Cardinality is only used to reject
     candidates ("does this column repeat?") and to score how completely a pair
     fills a grid, and both are ratios that a bounded window answers: with a small
     pivot cardinality, prefix ratios match full-data ratios. */
  function sampledDistinct(data, colId, probeN) {
    return distinct(data, colId, probeN);
  }

  // Is `dep` constant within each distinct value of `base`?
  function dependsOn(data, dep, base, n) {
    var depArr = data[dep], baseArr = data[base];
    if (!depArr || !baseArr) return false;
    var seen = new Map();
    for (var i = 0; i < n; i++) {
      var bk = mapKey(baseArr[i]);
      var dk = mapKey(depArr[i]);
      var prev = seen.get(bk);
      if (prev === undefined && !seen.has(bk)) seen.set(bk, dk);
      else if (prev !== dk) return false;
    }
    return true;
  }

  function uniquePair(data, a, b, n) {
    var aArr = data[a], bArr = data[b];
    if (!aArr || !bArr) return false;
    var seen = new Map();
    for (var i = 0; i < n; i++) {
      var ak = mapKey(aArr[i]);
      var inner = seen.get(ak);
      if (inner === undefined) { inner = new Set(); seen.set(ak, inner); }
      var bk = mapKey(bArr[i]);
      if (inner.has(bk)) return false;
      inner.add(bk);
    }
    return true;
  }

  function isDimensionType(info) {
    var t = (info && info.columnType) || 'text';
    return t === 'text' || t === 'string' || t === 'boolean' || t === 'integer' ||
           t === 'date' || t === 'datetime' || t === 'number' || t === 'variant' || t === 'link';
  }

  /**
   * @param data     column-oriented element data { [colId]: value[] }
   * @param columns  Sigma ColumnInfo map { [colId]: { name, columnType, format } }
   * @param overrides { rowColumns?, pivotColumn?, valueColumns?, excludeColumns? }
   * @returns { rowKey, rowColumns, pivotColumn, columnDims, valueColumns, detected,
   *            rowCount, reason, data, colIds }
   */
  function detect(data, columns, overrides) {
    overrides = overrides || {};
    data = data || {};
    // Only consider columns that actually carry data for this element.
    var colIds = Object.keys(columns || {}).filter(function (id) {
      return Array.isArray(data[id]);
    });
    if (!colIds.length) colIds = Object.keys(data);

    var n = rowCount(data, colIds);
    var result = {
      rowKey: null, rowColumns: [], pivotColumn: null, columnDims: [], valueColumns: [],
      data: data, colIds: colIds, rowCount: n, detected: {}, reason: null
    };
    if (!n) { result.reason = 'no rows'; return result; }

    /* Cardinality is sampled (see sampledDistinct) and therefore relative to
       probeN, not to n. Every comparison below is written against probeN so the
       two never get mixed up. */
    var probeN = Math.min(n, PROBE_LIMIT);
    var stats = Object.create(null);
    function statOf(id) {
      if (!(id in stats)) {
        stats[id] = Array.isArray(data[id]) ? sampledDistinct(data, id, probeN) : undefined;
      }
      return stats[id];
    }
    function known(id) { return Array.isArray(data[id]); }

    var pivotColumn = overrides.pivotColumn && known(overrides.pivotColumn)
      ? overrides.pivotColumn : null;
    var rowKey = null;

    var explicitRows = (overrides.rowColumns || []).filter(known);
    if (explicitRows.length) rowKey = explicitRows[0];

    if (!pivotColumn || !rowKey) {
      // Candidate dimensions: repeat within the probe window, so they can't be
      // per-cell measures.
      var candidates = colIds.filter(function (id) {
        return isDimensionType(columns[id]) && statOf(id) > 1 && statOf(id) < probeN;
      });

      var probe = Math.min(n, SAMPLE_LIMIT);
      var scored = [];
      for (var a = 0; a < candidates.length; a++) {
        for (var b = 0; b < candidates.length; b++) {
          if (a === b) continue;
          var r = candidates[a], c = candidates[b];
          if (rowKey && r !== rowKey) continue;
          if (pivotColumn && c !== pivotColumn) continue;
          if (!uniquePair(data, r, c, probe)) continue;
          // Prefer the pair that best fills a complete grid. Both cardinalities
          // and the row count come from the same window, so the ratio is sound.
          var fill = probeN / (statOf(r) * statOf(c));
          scored.push({ rowKey: r, pivotColumn: c, score: fill - Math.abs(1 - fill) });
        }
      }
      scored.sort(function (x, y) { return y.score - x.score; });

      /* A prefix can admit a pair that collides later, so confirm the winner over
         a wider slice and fall through to the next best if it does not hold. The
         confirmation is itself bounded: at 1M+ rows a full re-scan per candidate
         is seconds of blocked main thread, and build() tolerates a wrong guess
         (cells simply overwrite) where a frozen tab is unrecoverable. */
      var confirm = Math.min(n, PROBE_LIMIT);
      var best = null;
      for (var i = 0; i < scored.length; i++) {
        if (confirm === probe ||
            uniquePair(data, scored[i].rowKey, scored[i].pivotColumn, confirm)) {
          best = scored[i];
          break;
        }
      }
      if (best) {
        rowKey = rowKey || best.rowKey;
        pivotColumn = pivotColumn || best.pivotColumn;
        result.detected.rowKey = !explicitRows.length;
        result.detected.pivotColumn = !overrides.pivotColumn;
      }
    }

    if (!rowKey || !pivotColumn) {
      result.reason = 'could not identify a row dimension and a pivot column';
      return result;
    }

    result.rowKey = rowKey;
    result.pivotColumn = pivotColumn;

    // Left-side columns: the row key, plus anything constant per row key.
    var excluded = overrides.excludeColumns || [];
    var rowColumns;
    if (explicitRows.length) {
      rowColumns = explicitRows.slice();
      if (rowColumns.indexOf(rowKey) === -1) rowColumns.unshift(rowKey);
    } else {
      rowColumns = [rowKey];
      colIds.forEach(function (id) {
        if (id === rowKey || id === pivotColumn) return;
        if (excluded.indexOf(id) !== -1) return;   // sort/color-only column
        if (statOf(id) <= 1) return;
        if (dependsOn(data, id, rowKey, n)) rowColumns.push(id);
      });
      result.detected.rowColumns = true;
    }
    result.rowColumns = rowColumns;

    var explicitValues = (overrides.valueColumns || []).filter(known);

    /* Attributes of the column dimension (constant per pivot value, e.g. a stage's
       capacity) describe the header, not the cell -- surface them there instead.
       Only columns that could actually be rendered need this probe: with explicit
       value columns, that is exactly those, so unrelated columns cost nothing. */
    var probeForDims = explicitValues.length ? explicitValues : colIds;
    var columnDims = [];
    probeForDims.forEach(function (id) {
      if (id === rowKey || id === pivotColumn) return;
      if (rowColumns.indexOf(id) !== -1) return;
      if (columnDims.indexOf(id) !== -1) return;
      // A column streamed only to sort or color by must not surface in the header
      // either -- and a sort key like a stage sequence number is exactly the kind
      // of column that is 1:1 with the pivot value, so it would land here.
      if (excluded.indexOf(id) !== -1) return;
      if (statOf(id) <= 1) return;
      if (dependsOn(data, id, pivotColumn, n)) columnDims.push(id);
    });
    result.columnDims = columnDims;

    // Value columns: whatever describes neither dimension.
    if (explicitValues.length) {
      // A listed column that is constant per pivot value describes the header, so
      // keep it there only -- otherwise it would render in the header AND the pill.
      result.valueColumns = explicitValues.filter(function (id) {
        return columnDims.indexOf(id) === -1 && excluded.indexOf(id) === -1;
      });
    } else {
      result.valueColumns = colIds.filter(function (id) {
        return rowColumns.indexOf(id) === -1 && columnDims.indexOf(id) === -1 &&
               id !== pivotColumn && excluded.indexOf(id) === -1;
      });
      result.detected.valueColumns = true;
    }

    return result;
  }

  /* One cached collator. String.prototype.localeCompare constructs a collator per
     call, which turned a 400 ms build into 13 s at 2M rows. */
  var COLLATOR = (typeof Intl !== 'undefined' && Intl.Collator)
    ? new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
    : null;

  /* Total order over cell values. Ordering must never depend on the order rows
     happen to arrive in: Sigma re-runs the element query whenever a control
     changes, and SQL without ORDER BY returns rows in whatever order it likes. */
  function compareValues(a, b) {
    var an = a === null || a === undefined || a === '';
    var bn = b === null || b === undefined || b === '';
    if (an || bn) return an ? (bn ? 0 : 1) : -1;      // blanks last
    if (a instanceof Date) a = a.getTime();
    if (b instanceof Date) b = b.getTime();

    if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : (a > b ? 1 : 0);

    var na = typeof a === 'number' ? a : (isFinite(Number(a)) ? Number(a) : null);
    var nb = typeof b === 'number' ? b : (isFinite(Number(b)) ? Number(b) : null);
    if (na !== null && nb !== null) return na < nb ? -1 : (na > nb ? 1 : 0);

    var sa = String(a), sb = String(b);
    if (sa === sb) return 0;
    // numeric collation so A2 sorts before A10, matching how people read plate IDs.
    var c = COLLATOR ? COLLATOR.compare(sa, sb) : (sa < sb ? -1 : 1);
    if (c) return c;
    return sa < sb ? -1 : (sa > sb ? 1 : 0);
  }

  /* Picking the minimum only needs *a* deterministic order, not a human-friendly
     one, so it avoids collation entirely -- this runs once per source row. */
  function lower(a, b) {
    if (a === b) return false;
    var an = a === null || a === undefined || a === '';
    var bn = b === null || b === undefined || b === '';
    if (an || bn) return !an;
    var ta = typeof a, tb = typeof b;
    if (ta === 'number' && tb === 'number') return a < b;
    if (ta === tb) return a < b;
    return String(a) < String(b);
  }

  /* Sort keys are a list, so rows can be ordered by several columns in priority
     order (Batch Id then Plate Id, say). Accepts a single id for convenience and
     drops anything the element is not streaming. */
  function normalizeSort(spec, data, fallback) {
    var list = (Array.isArray(spec) ? spec : (spec ? [spec] : [])).filter(function (id) {
      return Array.isArray(data[id]);
    });
    return list.length ? list : [fallback];
  }

  /* An explicit column order, given as names rather than a column to sort by.
     This is the only way to reproduce a hand-picked order in the source pivot,
     since the SDK exposes no sort metadata to read it from. Listed values come
     first in the order given; anything unlisted keeps its normal sort and falls
     to the end, so a new stage appearing in the data is visible, not dropped. */
  function orderRanks(spec) {
    var list = Array.isArray(spec) ? spec : String(spec == null ? '' : spec).split(/[,\n]/);
    var ranks = new Map();
    for (var i = 0; i < list.length; i++) {
      var name = String(list[i]).trim().toLowerCase();
      if (name && !ranks.has(name)) ranks.set(name, ranks.size);
    }
    return ranks.size ? ranks : null;
  }

  function rankOf(ranks, value) {
    if (value === null || value === undefined) return -1;
    var r = ranks.get(String(value).trim().toLowerCase());
    return r === undefined ? -1 : r;
  }

  /** Build the ordered pivot grid from a detect() result.
   *
   *  Rows and cells hold *source row indices*, not copied values: a cell is the
   *  integer index its data lives at, so the renderer reads `data[colId][index]`
   *  on demand. At 1M source rows the previous shape allocated ~2M objects here.
   *
   *  Row and column order come from `opts.sortRow` / `opts.sortColumn` (defaulting
   *  to the row key and the pivot column), never from arrival order.
   *
   *  @param opts { maxRows, sortRow, sortRowDesc, sortColumn, sortColumnDesc }
   */
  function build(layout, colorColumnId, opts) {
    // Back-compat: build(layout, color, 5000) still means a row cap.
    if (typeof opts === 'number') opts = { maxRows: opts };
    opts = opts || {};

    var data = layout.data || {};
    var n = layout.rowCount || 0;
    var limit = opts.maxRows > 0 ? opts.maxRows : 0;

    var sortRowIds = normalizeSort(opts.sortRow, data, layout.rowKey);
    var sortColIds = normalizeSort(opts.sortColumn, data, layout.pivotColumn);
    var rowDir = opts.sortRowDesc ? -1 : 1;
    var colDir = opts.sortColumnDesc ? -1 : 1;

    var sortRowArrs = sortRowIds.map(function (id) { return data[id] || []; });
    var sortColArrs = sortColIds.map(function (id) { return data[id] || []; });
    /* When a sort column *is* the dimension, every occurrence carries the same
       value, so its per-row minimum is a no-op and can be skipped -- that is the
       default path and it keeps build() free of comparisons. */
    var rowNeedsMin = sortRowIds.map(function (id) { return id !== layout.rowKey; });
    var colNeedsMin = sortColIds.map(function (id) { return id !== layout.pivotColumn; });

    var pivotKeys = [], pivotIndex = new Map();
    var rowOrder = [], rowIndex = new Map();
    var columnDims = layout.columnDims || [];
    var pivotArr = data[layout.pivotColumn], keyArr = data[layout.rowKey];

    /* Pass 1: discover the distinct rows and columns with their sort values. Sort
       values are the MIN over every occurrence, so they do not depend on which
       source row happened to be seen first. */
    for (var i = 0; i < n; i++) {
      var pv = pivotArr ? pivotArr[i] : null;
      var pmk = mapKey(pv);
      var ci = pivotIndex.get(pmk);
      if (ci === undefined) {
        var attrs = {};
        for (var d = 0; d < columnDims.length; d++) {
          attrs[columnDims[d]] = (data[columnDims[d]] || [])[i];
        }
        ci = pivotKeys.length;
        pivotIndex.set(pmk, ci);
        pivotKeys.push({ k: key(pv), value: pv, attrs: attrs, index: ci,
          sortVals: sortColArrs.map(function (arr) { return arr[i]; }) });
      } else {
        var pcur = pivotKeys[ci];
        for (var sc = 0; sc < sortColArrs.length; sc++) {
          if (colNeedsMin[sc] && lower(sortColArrs[sc][i], pcur.sortVals[sc])) {
            pcur.sortVals[sc] = sortColArrs[sc][i];
          }
        }
      }

      var rv = keyArr ? keyArr[i] : null;
      var rmk = mapKey(rv);
      var row = rowIndex.get(rmk);
      if (row === undefined) {
        row = { key: key(rv), index: i, cells: [],
          sortVals: sortRowArrs.map(function (arr) { return arr[i]; }) };
        rowIndex.set(rmk, row);
        rowOrder.push(row);
      } else {
        for (var sr = 0; sr < sortRowArrs.length; sr++) {
          if (rowNeedsMin[sr] && lower(sortRowArrs[sr][i], row.sortVals[sr])) {
            row.sortVals[sr] = sortRowArrs[sr][i];
          }
        }
      }
    }

    // Sort before capping, so the cap keeps the first N rows *in sort order* --
    // otherwise which rows survive would depend on arrival order too.
    function bySortVals(dir, tie) {
      return function (x, y) {
        for (var k = 0; k < x.sortVals.length; k++) {
          var c = compareValues(x.sortVals[k], y.sortVals[k]);
          if (c) return dir * c;
        }
        return compareValues(x[tie], y[tie]);
      };
    }
    rowOrder.sort(bySortVals(rowDir, 'key'));
    var colRanks = orderRanks(opts.pivotOrder);
    if (colRanks) {
      var byVals = bySortVals(colDir, 'k');
      pivotKeys.sort(function (x, y) {
        var rx = rankOf(colRanks, x.value), ry = rankOf(colRanks, y.value);
        if (rx !== -1 && ry !== -1) return colDir * (rx - ry);
        if (rx !== -1 || ry !== -1) return rx !== -1 ? -1 : 1;   // unlisted last
        return byVals(x, y);
      });
    } else {
      pivotKeys.sort(bySortVals(colDir, 'k'));
    }

    var truncated = 0;
    if (limit && rowOrder.length > limit) {
      truncated = rowOrder.length - limit;
      rowOrder.length = limit;
    }

    // Pass 2: fill cells for the rows that survived, keyed by each column's
    // original slot so sorting the headers cannot desynchronize the cells.
    var keep = new Map();
    for (var r = 0; r < rowOrder.length; r++) keep.set(mapKey(rawKeyOf(keyArr, rowOrder[r].index)), rowOrder[r]);

    for (var j = 0; j < n; j++) {
      var target = keep.get(mapKey(keyArr ? keyArr[j] : null));
      if (target === undefined) continue;
      var slot = pivotIndex.get(mapKey(pivotArr ? pivotArr[j] : null));
      if (slot !== undefined) target.cells[slot] = j;
    }

    return {
      pivotKeys: pivotKeys, rows: rowOrder, data: data,
      colorColumn: colorColumnId || null,
      sortedRowsBy: sortRowIds, sortedColumnsBy: sortColIds,
      totalRows: rowOrder.length + truncated, truncated: truncated
    };
  }

  function rawKeyOf(arr, index) { return arr ? arr[index] : null; }

  global.PivotDetect = {
    detect: detect, build: build, toRows: toRows, key: key, rowCount: rowCount,
    compareValues: compareValues
  };
})(window);
