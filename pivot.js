/* Auto-detects the pivot layout from a Sigma pivot-table element's flat, column-oriented data.

   Sigma hands a plugin the pivot's underlying rows, not a pre-pivoted grid, so we
   recover the layout structurally:

     - pivotColumn : a dimension whose values become the crosstab headers
     - rowKey      : the dimension that identifies one output row
     - rowColumns  : rowKey plus every dimension functionally dependent on it
                     (constant per rowKey) -> these are the "left side" columns
     - valueColumns: everything left over -> rendered inside the cell pill

   The (rowKey, pivotColumn) pair is chosen as the dimension pair that most nearly
   forms a complete grid and uniquely identifies each source row. */
(function (global) {
  'use strict';

  function toRows(data, colIds) {
    var n = 0;
    colIds.forEach(function (id) {
      var arr = data[id];
      if (Array.isArray(arr) && arr.length > n) n = arr.length;
    });
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

  function distinct(rows, colId) {
    var set = Object.create(null);
    var count = 0;
    for (var i = 0; i < rows.length; i++) {
      var k = key(rows[i][colId]);
      if (!(k in set)) { set[k] = true; count++; }
    }
    return count;
  }

  // Is `dep` constant within each distinct value of `base`?
  function dependsOn(rows, dep, base) {
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var bk = key(rows[i][base]);
      var dk = key(rows[i][dep]);
      if (bk in seen) {
        if (seen[bk] !== dk) return false;
      } else {
        seen[bk] = dk;
      }
    }
    return true;
  }

  function uniquePair(rows, a, b) {
    var seen = Object.create(null);
    for (var i = 0; i < rows.length; i++) {
      var k = key(rows[i][a]) + '\u0001' + key(rows[i][b]);
      if (k in seen) return false;
      seen[k] = true;
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
   * @returns { rowKey, rowColumns, pivotColumn, columnDims, valueColumns, detected, rowCount, reason }
   */
  function detect(data, columns, overrides) {
    overrides = overrides || {};
    // Only consider columns that actually carry data for this element.
    var colIds = Object.keys(columns || {}).filter(function (id) {
      return Array.isArray(data[id]);
    });
    if (!colIds.length) colIds = Object.keys(data || {});

    var rows = toRows(data, colIds);
    var result = {
      rowKey: null, rowColumns: [], pivotColumn: null, columnDims: [], valueColumns: [],
      rows: rows, rowCount: rows.length, detected: {}, reason: null
    };
    if (!rows.length) { result.reason = 'no rows'; return result; }

    var stats = {};
    colIds.forEach(function (id) { stats[id] = distinct(rows, id); });

    var pivotColumn = overrides.pivotColumn && stats[overrides.pivotColumn] !== undefined
      ? overrides.pivotColumn : null;
    var rowKey = null;

    var explicitRows = (overrides.rowColumns || []).filter(function (id) {
      return stats[id] !== undefined;
    });
    if (explicitRows.length) rowKey = explicitRows[0];

    // Candidate dimensions: repeat across rows, so they can't be per-cell measures.
    var candidates = colIds.filter(function (id) {
      return isDimensionType(columns[id]) && stats[id] > 1 && stats[id] < rows.length;
    });

    if (!pivotColumn || !rowKey) {
      var best = null;
      for (var a = 0; a < candidates.length; a++) {
        for (var b = 0; b < candidates.length; b++) {
          if (a === b) continue;
          var r = candidates[a], c = candidates[b];
          if (rowKey && r !== rowKey) continue;
          if (pivotColumn && c !== pivotColumn) continue;
          if (!uniquePair(rows, r, c)) continue;
          // Prefer the pair that best fills a complete grid.
          var fill = rows.length / (stats[r] * stats[c]);
          var score = fill - Math.abs(1 - fill);
          if (!best || score > best.score) best = { rowKey: r, pivotColumn: c, score: score };
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
    var rowColumns;
    if (explicitRows.length) {
      rowColumns = explicitRows.slice();
      if (rowColumns.indexOf(rowKey) === -1) rowColumns.unshift(rowKey);
    } else {
      rowColumns = [rowKey];
      colIds.forEach(function (id) {
        if (id === rowKey || id === pivotColumn) return;
        if (stats[id] <= 1) return;
        if (dependsOn(rows, id, rowKey)) rowColumns.push(id);
      });
      result.detected.rowColumns = true;
    }
    result.rowColumns = rowColumns;

    // Attributes of the column dimension (constant per pivot value, e.g. a stage's
    // capacity) describe the header, not the cell -- surface them there instead.
    var columnDims = [];
    colIds.forEach(function (id) {
      if (id === rowKey || id === pivotColumn) return;
      if (rowColumns.indexOf(id) !== -1) return;
      if (stats[id] <= 1) return;
      if (dependsOn(rows, id, pivotColumn)) columnDims.push(id);
    });
    result.columnDims = columnDims;

    // Value columns: whatever describes neither dimension.
    var explicitValues = (overrides.valueColumns || []).filter(function (id) {
      return stats[id] !== undefined || Array.isArray(data[id]);
    });
    var excluded = overrides.excludeColumns || [];
    if (explicitValues.length) {
      result.valueColumns = explicitValues;
    } else {
      result.valueColumns = colIds.filter(function (id) {
        return rowColumns.indexOf(id) === -1 && columnDims.indexOf(id) === -1 &&
               id !== pivotColumn && excluded.indexOf(id) === -1;
      });
      result.detected.valueColumns = true;
    }

    return result;
  }

  /** Build the ordered pivot grid from a detect() result. */
  function build(layout, colorColumnId) {
    var rows = layout.rows;
    var pivotKeys = [], pivotSeen = Object.create(null);
    var rowOrder = [], rowMap = Object.create(null);

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var pv = row[layout.pivotColumn];
      var pk = key(pv);
      if (!(pk in pivotSeen)) {
        pivotSeen[pk] = true;
        var attrs = {};
        (layout.columnDims || []).forEach(function (c) { attrs[c] = row[c]; });
        pivotKeys.push({ k: pk, value: pv, attrs: attrs });
      }
      var rk = key(row[layout.rowKey]);
      if (!(rk in rowMap)) {
        rowMap[rk] = { key: rk, rowValues: {}, cells: Object.create(null) };
        layout.rowColumns.forEach(function (c) { rowMap[rk].rowValues[c] = row[c]; });
        rowOrder.push(rowMap[rk]);
      }
      var cell = { values: {}, color: colorColumnId ? row[colorColumnId] : null, source: row };
      layout.valueColumns.forEach(function (c) { cell.values[c] = row[c]; });
      rowMap[rk].cells[pk] = cell;
    }

    return { pivotKeys: pivotKeys, rows: rowOrder };
  }

  global.PivotDetect = { detect: detect, build: build, toRows: toRows, key: key };
})(window);
