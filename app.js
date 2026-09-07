/* Pivot Tracker — renders a Sigma pivot-table element as a pill grid with
   sticky left columns, inherited column formatting, rule-driven pill colors,
   and click-through into workbook controls. */
(function () {
  'use strict';

  var SDK = window.SigmaPlugin;
  if (!SDK || !SDK.client) {
    document.getElementById('root').innerHTML =
      '<div class="msg error">Sigma plugin SDK failed to load. ' +
      'Check that vendor/react.min.js loads before vendor/sigma-plugin.js.</div>';
    return;
  }
  // Sort keys are lists now, so diagnostics report them in priority order.
  function names(ids) {
    return asArray(ids).map(colName).join(' > ') || '(none)';
  }
  var client = SDK.client;

  client.config.configureEditorPanel([
    { name: 'source', type: 'element' },

    // Sigma only streams data for columns named by a `column` entry, so these
    // three define both the layout and the request scope.
    { name: 'rowColumns', type: 'column', source: 'source', allowMultiple: true,
      label: 'Left columns',
      description: 'The pivot row dimensions, in display order. The first one is passed to the row control unless overridden below.' },
    { name: 'pivotColumn', type: 'column', source: 'source', allowMultiple: false,
      label: 'Pivot column',
      description: 'The crosstab column dimension whose values become the column headers.' },
    { name: 'valueColumns', type: 'column', source: 'source', allowMultiple: true,
      label: 'Cell values',
      description: 'Rendered stacked inside each pill, in order. A column that is constant per pivot value is moved into the column header instead.' },

    { name: 'sortRowColumn', type: 'column', source: 'source', allowMultiple: true,
      label: 'Sort rows by',
      description: 'One or more columns that order the pivot rows, in priority order (Batch Id then Plate Id, say). A column used only for sorting is not displayed anywhere -- add it to "Left columns" too if you want to see it. Only columns that exist in the source element appear here; use "+ Add new column" in this picker to pull in one that is missing. Direction is set by the "Rows: descending" toggle below.' },
    { name: 'sortRowDesc', type: 'toggle', label: 'Rows: descending (Z\u2192A, 9\u21920)', defaultValue: false },
    { name: 'sortColumnColumn', type: 'column', source: 'source', allowMultiple: true,
      label: 'Sort pivot columns by',
      description: 'One or more columns that order the crosstab columns, in priority order -- e.g. Stage Seq. A column used only for sorting is not displayed anywhere: it does not become a header attribute or a pill value, so Stage Seq can order the stages without showing up. Direction is set by the "Pivot columns: descending" toggle below.' },
    { name: 'sortColumnDesc', type: 'toggle', label: 'Pivot columns: descending (Z\u2192A, 9\u21920)', defaultValue: false },

    { name: 'colorColumn', type: 'column', source: 'source', allowMultiple: false,
      label: 'Color by column (optional)' },
    { name: 'colorRules', type: 'text', multiline: true,
      label: 'Color rules JSON (optional)',
      placeholder: '{"isnotnull":"#1d3a5c","isnull":"#f4f5f7"}',
      description: 'Overrides the auto palette. Flat value:color map, or {"default":..,"values":{..},"rules":[{"op":">=","value":10,"color":"#..."}]}. Presence tests: "isnull" (also null/empty/blank) and "isnotnull" (also notempty/filled) color cells by whether the column has a value -- e.g. {"isnotnull":"#1d3a5c","isnull":"#f4f5f7"} on a Comments column. Whitespace-only text counts as empty.' },
    { name: 'autoPalette', type: 'toggle', label: 'Auto palette for unmatched values',
      defaultValue: true },

    { name: 'rowValueColumn', type: 'column', source: 'source', allowMultiple: false,
      label: 'Row value to pass (optional)',
      description: 'Which left column\'s value is sent to the row control on click. Defaults to the first left column.' },
    { name: 'rowVariable', type: 'variable', label: 'Control: row value (optional)' },
    { name: 'columnValueColumn', type: 'column', source: 'source', allowMultiple: false,
      label: 'Column value to pass (optional)',
      description: 'Which column supplies the value sent to the pivot-column control. Defaults to the pivot column itself; may also be one of its header attributes.' },
    { name: 'columnVariable', type: 'variable', label: 'Control: pivot column value (optional)' },
    { name: 'onCellClick', type: 'action-trigger', label: 'On cell click action (optional)' },

    { name: 'columnStyles', type: 'text', multiline: true,
      label: 'Column formatting JSON (optional)',
      placeholder: '{"Operator":{"bold":true,"size":13},"Stage Timestamp":"italic 10px #6b7684"}',
      description: 'Per-column text style, keyed by column name -- applies to left columns and to the lines inside the pill. Keys: size, bold, italic, underline, uppercase, color, background, align, opacity. Use "*" for all columns, "header" for the pivot column headers, "leftHeader" for the left header row. A string value is shorthand, e.g. "bold 13px #333".' },

    { name: 'maxRows', type: 'text',
      label: 'Max rows',
      placeholder: '5000',
      description: 'Safety cap on the number of pivot rows built, so a mis-picked left column cannot wedge the browser. Rows are virtualized, so a high value is fine. Blank uses 5000; 0 means unlimited.' },

    { name: 'showValueLabels', type: 'toggle',
      label: 'Show a field-name row under each column header', defaultValue: false },
    { name: 'compact', type: 'toggle', label: 'Compact rows' },
    { name: 'darkMode', type: 'toggle', label: 'Dark mode', defaultValue: false,
      description: 'Off (default) matches Sigma\'s light workbook surface. On switches the grid and pill palette to dark.' },
    { name: 'debug', type: 'toggle', label: 'Show detection diagnostics' }
  ]);

  var root = document.getElementById('root');
  var state = { config: {}, data: null, columns: null, selected: null,
    loaded: 0, totalRows: null, complete: false, dataVersion: 0 };
  var unsubData = null, unsubCols = null, boundKey = null, boundElement = null, lastConfigJson = null;

  // Cached pivot resolution and the paint context for the current view. `memo`
  // keeps detect()/build() from re-running for presentational changes; `view`
  // holds everything paintWindow() needs so scrolling parses no config.
  var memo = { data: null, columns: null, sig: null, layout: null, grid: null,
    scopedCount: 0, version: -1 };
  var view = null, wrapEl = null, tbodyEl = null, rafPending = false;

  // ' style=".."' for a column, or '' so we don't emit empty attributes.
  function sty(styles, id, slot) {
    var css = window.PivotStyles.css(
      window.PivotStyles.forColumn(styles, id ? colName(id) : null, slot));
    return css ? ' style="' + esc(css) + '"' : '';
  }

  function asArray(v) {
    if (Array.isArray(v)) return v.filter(Boolean);
    return v ? [v] : [];
  }
  function colName(id) {
    var c = state.columns && state.columns[id];
    return (c && c.name) || id;
  }
  function fmt(value, id) {
    return window.PivotFormat.formatValue(value, state.columns && state.columns[id]);
  }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Columns whose data we need Sigma to stream: the union of every column entry.
  // Sigma only sends data for columns named by a `column` config entry, so this
  // set doubles as the request scope and as the data-subscription cache key.
  function requestedColumns(cfg) {
    var out = [];
    [asArray(cfg.rowColumns), asArray(cfg.pivotColumn),
     asArray(cfg.valueColumns), asArray(cfg.colorColumn),
     asArray(cfg.rowValueColumn), asArray(cfg.columnValueColumn),
     asArray(cfg.sortRowColumn), asArray(cfg.sortColumnColumn)].forEach(function (group) {
      group.forEach(function (id) { if (out.indexOf(id) === -1) out.push(id); });
    });
    return out;
  }

  /* Columns that are streamed for a job other than display -- the color source and
     the sort keys. Without this, a sort-only column such as Stage Seq would be
     picked up by auto-detection and rendered: as a pill value if it varies freely,
     or worse, under the pivot header if it happens to be 1:1 with the pivot column,
     which Stage Seq is. Anything the user *also* placed in a visible role stays
     visible -- an explicit choice outranks the inference. */
  function hiddenColumns(cfg) {
    var visible = asArray(cfg.rowColumns)
      .concat(asArray(cfg.valueColumns), asArray(cfg.pivotColumn));
    return asArray(cfg.colorColumn)
      .concat(asArray(cfg.sortRowColumn), asArray(cfg.sortColumnColumn))
      .filter(function (id, i, a) {
        return id && a.indexOf(id) === i && visible.indexOf(id) === -1;
      });
  }

  /* Re-subscribes when the source changes *or* when the set of requested columns
     changes -- Sigma streams data for the scope that was in effect at subscribe
     time, so a newly picked column never arrives until we ask again. Without
     this, adding a column in the editor panel required a workbook refresh. */
  function bindSource(sourceId, columnKey) {
    var key = (sourceId || '') + '|' + columnKey;
    if (boundKey === key) return;
    if (unsubData) { unsubData(); unsubData = null; }
    if (unsubCols) { unsubCols(); unsubCols = null; }
    boundKey = key;
    // Keep whatever we already have when only the column scope widened, so the
    // grid stays on screen instead of flashing "waiting for data" on every edit.
    if (sourceId !== boundElement) {
      boundElement = sourceId;
      state.data = null;
      state.columns = null;
    }
    if (!sourceId) { render(); return; }

    unsubCols = client.elements.subscribeToElementColumns(sourceId, function (cols) {
      state.columns = cols;
      render();
    });

    /* Sigma paginates element data: the plain subscription delivers whatever fits
       one page, so a large element would silently render a prefix. Subscribe
       incrementally and pull pages until isComplete, accumulating in place. */
    if (typeof client.elements.subscribeToIncrementalElementData === 'function') {
      state.loaded = 0;
      state.totalRows = null;
      state.complete = false;
      state.dataVersion = 0;
      noProgress = 0;
      setLoading(true);
      unsubData = client.elements.subscribeToIncrementalElementData(sourceId, function (chunk) {
        mergeChunk(chunk, sourceId);
      });
    } else {
      unsubData = client.elements.subscribeToElementData(sourceId, function (data) {
        state.data = data;
        state.complete = true;
        state.dataVersion++;
        render();
      });
    }
  }

  var HARD_ROW_CEILING = 5000000;   // refuse to accumulate beyond this
  var CHUNK_RENDER_MS = 500;        // repaint at most this often while loading
  var noProgress = 0, lastChunkPaint = 0, chunkTimer = null;

  function setLoading(on) {
    try { client.config.setLoadingState(!!on); } catch (e) { /* older host */ }
  }

  /* Chunks arrive as { data, offset, isComplete, totalRows }. Accumulate in place
     -- rebuilding the arrays per chunk would make loading O(rows x chunks) -- and
     bump a version so the layout memo still invalidates. */
  function mergeChunk(chunk, sourceId) {
    if (!chunk || typeof chunk !== 'object') return;
    var incoming = chunk.data || {};
    var offset = typeof chunk.offset === 'number' ? chunk.offset : 0;

    if (offset === 0 || !state.data) { state.data = {}; state.loaded = 0; }

    Object.keys(incoming).forEach(function (id) {
      if (id === '__proto__') return;
      var target = state.data[id];
      if (!Array.isArray(target)) target = state.data[id] = [];
      // A re-sent page rewinds to its offset rather than duplicating rows.
      if (target.length > offset) target.length = offset;
      var src = incoming[id] || [];
      for (var i = 0; i < src.length; i++) target.push(src[i]);
    });

    var loaded = 0;
    Object.keys(state.data).forEach(function (id) {
      if (state.data[id].length > loaded) loaded = state.data[id].length;
    });
    noProgress = loaded > state.loaded ? 0 : noProgress + 1;
    state.loaded = loaded;
    state.totalRows = chunk.totalRows || state.totalRows;
    state.complete = !!chunk.isComplete;
    state.dataVersion++;

    // Stop pulling when done, when the host stops making progress (which would
    // otherwise loop forever), or at the ceiling.
    var more = !state.complete && noProgress < 2 && loaded < HARD_ROW_CEILING;
    if (more) {
      try { client.elements.fetchMoreElementData(sourceId); }
      catch (e) { state.complete = true; }
    } else {
      state.complete = true;
      setLoading(false);
    }

    /* Paint the first page immediately so something is on screen, then throttle:
       re-detecting on all ~20 pages of a 1M-row element would cost seconds. */
    var now = Date.now();
    if (state.complete || lastChunkPaint === 0 || now - lastChunkPaint > CHUNK_RENDER_MS) {
      lastChunkPaint = now;
      if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
      render();
    } else if (!chunkTimer) {
      chunkTimer = setTimeout(function () {
        chunkTimer = null;
        lastChunkPaint = Date.now();
        render();
      }, CHUNK_RENDER_MS);
    }
  }

  function applyConfig(config) {
    config = config || {};
    var json;
    try { json = JSON.stringify(config); } catch (e) { json = null; }
    if (json !== null && json === lastConfigJson) return;
    lastConfigJson = json;

    state.config = config;
    bindSource(config.source, requestedColumns(config).join(','));
    render();
  }

  client.config.subscribe(applyConfig);

  /* The host emits config once when the init handshake resolves and again on every
     edit. If the iframe is re-mounted (which Sigma does when settings change) an
     emission can land before this subscription exists, leaving the plugin parked
     on its placeholder until the workbook is refreshed. Polling the live config
     object recovers from any dropped emission; applyConfig() de-dupes, so a
     steady state costs one small JSON.stringify per tick. */
  setInterval(function () {
    try { applyConfig(client.config.get()); } catch (e) { /* host not ready yet */ }
  }, 400);

  // --- which column supplies each passed value ------------------------------
  // Defaults reproduce the original behavior (first left column / the pivot
  // column); an editor-panel override wins whenever that column is available.
  function passRowId(layout) {
    var pick = state.config.rowValueColumn;
    if (pick && layout.rowColumns.indexOf(pick) !== -1) return pick;
    return layout.rowKey;
  }

  function passColId(layout) {
    var pick = state.config.columnValueColumn;
    if (!pick) return layout.pivotColumn;
    if (pick === layout.pivotColumn) return pick;
    if ((layout.columnDims || []).indexOf(pick) !== -1) return pick;
    return layout.pivotColumn;
  }

  function blank(v) { return v === null || v === undefined ? '' : v; }

  function colPassValue(pk, layout, id) {
    if (id === layout.pivotColumn) return blank(pk.value);
    return blank((pk.attrs || {})[id]);
  }

  // --- cell click -> workbook controls -------------------------------------
  // DOM data attributes are always strings; send numeric columns back as numbers
  // so numeric workbook controls accept the value.
  function typedValue(raw, colId) {
    if (raw === null || raw === undefined || raw === '') return '';
    var type = (state.columns && state.columns[colId] || {}).columnType;
    if (type === 'number' || type === 'integer') {
      var n = Number(raw);
      if (!isNaN(n)) return n;
    }
    return String(raw);
  }

  function handleCellClick(rowValue, pivotValue, rowColId, pivotColId, btn) {
    var cfg = state.config;
    var rowOut = typedValue(rowValue, rowColId);
    var colOut = typedValue(pivotValue, pivotColId);

    // Variables and action triggers live on client.config, not on the client root.
    // Two sets fired in the same tick can be coalesced, dropping the first, so
    // send them on separate ticks and trigger the action once both have landed.
    var pending = [];
    if (cfg.rowVariable) pending.push([cfg.rowVariable, rowOut]);
    if (cfg.columnVariable) pending.push([cfg.columnVariable, colOut]);

    (function next(i) {
      if (i >= pending.length) {
        if (cfg.onCellClick) client.config.triggerAction(cfg.onCellClick);
        return;
      }
      client.config.setVariable(pending[i][0], pending[i][1]);
      setTimeout(function () { next(i + 1); }, 0);
    })(0);

    state.selected = window.PivotDetect.key(rowValue) + '\u0001' + window.PivotDetect.key(pivotValue);

    // Move the selection ring by patching two class lists. Re-rendering for this
    // meant re-running the whole pivot pipeline on every click.
    if (btn) {
      var prev = root.querySelector('.pill.sel');
      if (prev && prev !== btn) prev.classList.remove('sel');
      btn.classList.add('sel');
    }
  }

  function message(text, cls) {
    root.innerHTML = '<div class="msg ' + (cls || '') + '">' + esc(text) + '</div>';
  }

  // --- geometry -------------------------------------------------------------
  /* Virtualization needs rows that cannot change height, so the row height is
     derived from the value-line count rather than measured, and column widths are
     computed once from sampled content and pinned with a <colgroup>. That also
     removes the old per-cell `left` writes: with known widths the sticky offsets
     are emitted once as CSS rules. */
  var SAMPLE = 200;      // rows inspected when sizing columns
  var OVERSCAN = 8;      // rows rendered beyond the viewport, each direction

  function textWidth(chars, px) { return Math.round(chars * px); }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  function measureLeft(grid, layout, compact) {
    var data = grid.data || {};
    var widths = [];
    layout.rowColumns.forEach(function (id) {
      var chars = colName(id).length;
      var n = Math.min(grid.rows.length, SAMPLE);
      var arr = data[id] || [];
      for (var i = 0; i < n; i++) {
        var t = fmt(arr[grid.rows[i].index], id);
        if (t && t.length > chars) chars = t.length;
      }
      widths.push(clamp(textWidth(chars, 7.4) + 26, 84, 280));
    });
    return widths;
  }

  function measureCells(grid, layout, compact) {
    var data = grid.data || {};
    var chars = 0;
    var n = Math.min(grid.rows.length, SAMPLE);
    for (var i = 0; i < n; i++) {
      var cells = grid.rows[i].cells;
      for (var c = 0; c < grid.pivotKeys.length; c++) {
        var ri = cells[grid.pivotKeys[c].index];
        if (ri === undefined) continue;
        for (var v = 0; v < layout.valueColumns.length; v++) {
          var vid = layout.valueColumns[v];
          var t = fmt((data[vid] || [])[ri], vid);
          if (t && t.length > chars) chars = t.length;
        }
      }
    }
    // Headers share the same column, so they set the floor.
    grid.pivotKeys.forEach(function (pk) {
      var h = String(fmt(pk.value, layout.pivotColumn) || '').length + 6;
      if (h > chars) chars = h;
    });
    return clamp(textWidth(chars, 6.9) + (compact ? 18 : 24), compact ? 92 : 104, 260);
  }

  function rowHeight(lineCount, compact) {
    var lines = Math.max(1, lineCount);
    var line = compact ? 13 : 14;
    var pill = (compact ? 6 : 10) + 2;          // padding + border
    var cellPad = compact ? 6 : 8;
    return lines * line + pill + cellPad;
  }

  // --- render ---------------------------------------------------------------
  /* render() validates config, resolves the layout (memoized) and paints the
     shell. Only the visible slice of rows is ever in the DOM; paintWindow() swaps
     that slice on scroll. */
  function render() {
    var cfg = state.config;

    // Theme first, so it applies to message states too, not just the grid.
    var dark = !!cfg.darkMode;
    document.body.classList.toggle('dark', dark);
    window.PivotColors.setTheme(dark ? 'dark' : 'light');

    if (!cfg.source) return message('Select a pivot table as the data source in the editor panel.');

    var requested = requestedColumns(cfg);

    // A color column on its own carries no layout, so treat that as "not set up
    // yet" and show guidance rather than a detection failure.
    var structural = requested.filter(function (id) { return id !== cfg.colorColumn; });

    if (!structural.length) {
      return message('Pick the pivot\'s Left columns, Pivot column and Cell values in the editor panel.');
    }

    if (!state.columns) return message('Waiting for column metadata from Sigma…');
    if (!state.data) return message('Waiting for row data from Sigma…');

    var populated = Object.keys(state.data).filter(function (k) {
      return Array.isArray(state.data[k]);
    });
    if (!populated.length) {
      return message('Sigma returned no column data for this element. ' +
        'Requested ' + requested.length + ' column(s); received ' +
        Object.keys(state.data).length + ' key(s).', 'error');
    }

    if (cfg.colorColumn && requested.indexOf(cfg.colorColumn) === -1) {
      return message('The color column is not available in this element\'s data.', 'error');
    }

    var resolved = resolveLayout(cfg, requested);
    var layout = resolved.layout, grid = resolved.grid;

    if (!layout.rowKey || !layout.pivotColumn) {
      var missing = requested.filter(function (id) { return !Array.isArray(state.data[id]); });
      return message(
        'Could not auto-detect the pivot layout (' + (layout.reason || 'unknown') + '). ' +
        'Received data for ' + resolved.scopedCount + ' of ' + requested.length +
        ' configured column(s)' +
        (missing.length ? '; no data for: ' + missing.map(colName).join(', ') : '') +
        '. Set the left columns and pivot column overrides in the editor panel.', 'error');
    }
    if (!layout.valueColumns.length) {
      return message('No value columns found for the pivot cells.', 'error');
    }

    paintShell(cfg, layout, grid, resolved, requested, populated);
  }

  /* detect() + build() are the expensive half (277 ms / 215 ms at 390k rows), and
     nothing presentational can change their result -- so cache them against the
     data object and a signature of the layout-affecting config only. Toggling dark
     mode, compact, formatting or color rules then costs a repaint, not a re-detect. */
  function structuralSig(cfg, requested) {
    return [cfg.source, asArray(cfg.rowColumns).join(','), cfg.pivotColumn || '',
      asArray(cfg.valueColumns).join(','), cfg.colorColumn || '',
      maxRows(cfg), requested.join(','),
      // Sorting happens inside build(), so it belongs to the cached result.
      cfg.sortRowColumn ? asArray(cfg.sortRowColumn).join(',') : '', cfg.sortRowDesc ? 'd' : 'a',
      cfg.sortColumnColumn ? asArray(cfg.sortColumnColumn).join(',') : '', cfg.sortColumnDesc ? 'd' : 'a'].join('|');
  }

  function maxRows(cfg) {
    var raw = cfg.maxRows;
    if (raw === undefined || raw === null || String(raw).trim() === '') return 5000;
    var n = parseInt(String(raw).trim(), 10);
    if (isNaN(n) || n < 0) return 5000;
    return n;                                    // 0 means unlimited
  }

  function resolveLayout(cfg, requested) {
    var sig = structuralSig(cfg, requested);
    if (memo.data === state.data && memo.columns === state.columns &&
        memo.sig === sig && memo.version === state.dataVersion) {
      return memo;
    }

    // Scope detection to the requested columns, preserving the editor's order.
    var scopedData = {}, scopedCols = {};
    requested.forEach(function (id) {
      if (Array.isArray(state.data[id])) {
        scopedData[id] = state.data[id];
        scopedCols[id] = state.columns[id] || { id: id, name: id, columnType: 'text' };
      }
    });

    var layout = window.PivotDetect.detect(scopedData, scopedCols, {
      rowColumns: asArray(cfg.rowColumns),
      pivotColumn: cfg.pivotColumn,
      valueColumns: asArray(cfg.valueColumns),
      excludeColumns: hiddenColumns(cfg)
    });

    var grid = (layout.rowKey && layout.pivotColumn)
      ? window.PivotDetect.build(layout, cfg.colorColumn, {
        maxRows: maxRows(cfg),
        sortRow: asArray(cfg.sortRowColumn),
        sortRowDesc: !!cfg.sortRowDesc,
        sortColumn: asArray(cfg.sortColumnColumn),
        sortColumnDesc: !!cfg.sortColumnDesc
      })
      : { pivotKeys: [], rows: [], totalRows: 0, truncated: 0 };

    memo = { data: state.data, columns: state.columns, sig: sig, layout: layout,
      grid: grid, scopedCount: Object.keys(scopedData).length, version: state.dataVersion };
    return memo;
  }

  function paintShell(cfg, layout, grid, resolved, requested, populated) {
    var compact = !!cfg.compact;
    var compiled = window.PivotColors.compile(cfg.colorRules);
    var styles = window.PivotStyles.compile(cfg.columnStyles);

    // Stable color domain so palette assignment doesn't shift between renders.
    var domain = [];
    if (cfg.colorColumn) {
      var seen = Object.create(null);
      var carr = state.data[cfg.colorColumn] || [];
      for (var i = 0; i < carr.length; i++) {
        var v = carr[i];
        if (v === null || v === undefined || v === '') continue;
        var s = String(v);
        if (!seen[s]) { seen[s] = true; domain.push(s); }
      }
      domain.sort();
    }

    var leftWidths = measureLeft(grid, layout, compact);
    var cellWidth = measureCells(grid, layout, compact);
    var rowH = rowHeight(layout.valueColumns.length, compact);

    // Everything paintWindow() needs, so scrolling touches no config parsing.
    view = {
      layout: layout, grid: grid, compact: compact,
      data: grid.data || {},
      compiled: compiled, styles: styles, domain: domain,
      autoPalette: cfg.autoPalette !== false,
      colorColumn: cfg.colorColumn || null,
      colorArr: cfg.colorColumn ? (state.data[cfg.colorColumn] || []) : null,
      rowH: rowH, leftWidths: leftWidths, cellWidth: cellWidth,
      leftCount: layout.rowColumns.length,
      colCount: layout.rowColumns.length + grid.pivotKeys.length,
      rowPassId: passRowId(layout), colPassId: passColId(layout),
      start: -1, end: -1
    };

    // Off by default: with more than one value in a pill the order is consistent
    // down the whole column, so the names are noise once you know the layout.
    var showLabels = !!cfg.showValueLabels && layout.valueColumns.length > 1;
    var html = [];

    // Sticky offsets as generated rules: one per left column instead of one
    // inline style per rendered cell.
    var offsets = [], acc = 0;
    leftWidths.forEach(function (w) { offsets.push(acc); acc += w; });
    var rules = ['.pivot { --row-h: ' + rowH + 'px; }'];
    offsets.forEach(function (off, i) {
      rules.push('.pivot .lead.c' + i + ' { left: ' + off + 'px; }');
    });
    html.push('<style>' + rules.join('\n') + '</style>');

    html.push('<div class="wrap' + (compact ? ' compact' : '') + '">');
    html.push('<table class="pivot">');

    html.push('<colgroup>');
    leftWidths.forEach(function (w) { html.push('<col style="width:' + w + 'px">'); });
    grid.pivotKeys.forEach(function () {
      html.push('<col style="width:' + cellWidth + 'px">');
    });
    html.push('</colgroup><thead>');

    // Header row 1: left column names + one group header per pivot value.
    html.push('<tr class="hdr-main">');
    layout.rowColumns.forEach(function (id, i) {
      html.push('<th class="lead c' + i + (i === 0 ? ' first' : '') +
        (i === layout.rowColumns.length - 1 ? ' last' : '') + '"' +
        (showLabels ? ' rowspan="2"' : '') + sty(styles, id, 'leftHeader') + '>' +
        esc(colName(id)) + '</th>');
    });
    grid.pivotKeys.forEach(function (pk) {
      // Column-dimension attributes ride along in the header, e.g. PLATING (80).
      var attrs = (layout.columnDims || []).map(function (id) {
        var t = fmt(pk.attrs[id], id);
        return t ? t : null;
      }).filter(Boolean);
      html.push('<th class="grp" title="' + esc(colName(layout.pivotColumn)) + '"' +
        sty(styles, layout.pivotColumn, 'header') + '>' +
        esc(fmt(pk.value, layout.pivotColumn) || '(blank)') +
        (attrs.length ? ' <span class="attr">(' + esc(attrs.join(' \u00b7 ')) + ')</span>' : '') +
        '</th>');
    });
    html.push('</tr>');

    // Header row 2: which value columns sit inside each pill.
    if (showLabels) {
      html.push('<tr class="hdr-sub">');
      grid.pivotKeys.forEach(function () {
        html.push('<th class="grp-sub">' + layout.valueColumns.map(function (id) {
          return '<span class="vlabel"' + sty(styles, id, 'header') + '>' +
            esc(colName(id)) + '</span>';
        }).join('') + '</th>');
      });
      html.push('</tr>');
    }
    html.push('</thead><tbody></tbody></table></div>');

    var notes = [];
    if (!state.complete) {
      notes.push('Loading rows from Sigma\u2026 ' + (state.loaded || 0).toLocaleString() +
        (state.totalRows ? ' of ' + state.totalRows.toLocaleString() : '') +
        ' so far. The grid fills in as pages arrive.');
    }
    if (grid.truncated) {
      notes.push('Showing the first ' + grid.rows.length.toLocaleString() +
        ' of ' + grid.totalRows.toLocaleString() + ' rows. ' +
        'Raise or clear <b>Max rows</b> in the editor panel to show more.');
    }
    if (notes.length) {
      html.push('<div class="note">' + notes.join(' &nbsp;\u00b7&nbsp; ') + '</div>');
    }

    if (cfg.debug) {
      html.push('<div class="debug"><b>Detected layout</b><pre>' + esc(JSON.stringify({
        sourceRows: layout.rowCount,
        rowsLoaded: state.loaded,
        rowsReportedByHost: state.totalRows,
        loadComplete: state.complete,
        gridRows: grid.rows.length,
        totalRows: grid.totalRows,
        truncated: grid.truncated,
        rowHeightPx: rowH,
        rowKey: colName(layout.rowKey),
        leftColumns: layout.rowColumns.map(colName),
        pivotColumn: colName(layout.pivotColumn),
        pivotValues: grid.pivotKeys.length,
        columnAttributes: (layout.columnDims || []).map(colName),
        rowsSortedBy: names(grid.sortedRowsBy) + (cfg.sortRowDesc ? ' desc' : ' asc'),
        columnsSortedBy: names(grid.sortedColumnsBy) + (cfg.sortColumnDesc ? ' desc' : ' asc'),
        valueColumns: layout.valueColumns.map(colName),
        autoDetected: layout.detected,
        colorColumn: cfg.colorColumn ? colName(cfg.colorColumn) : null,
        colorDomain: domain,
        colorRulesError: compiled.error,
        /* Which of the actual values your rules cover. An empty rule list with a
           populated domain is the signature of a color-rules box that was typed
           but never saved; values under unmatchedByRules fall to the palette. */
        colorRuleKeys: Object.keys(compiled.values).length,
        unmatchedByRules: domain.filter(function (v) {
          return !compiled.values[String(v).toLowerCase()];
        }).slice(0, 20),
        columnStylesError: styles.error,
        requestedColumns: requested.length,
        populatedColumns: populated.length,
        rowValuePassed: colName(view.rowPassId),
        columnValuePassed: colName(view.colPassId),
        formats: Object.keys(state.columns).reduce(function (acc2, id) {
          acc2[state.columns[id].name] = {
            type: state.columns[id].columnType, format: state.columns[id].format || null
          };
          return acc2;
        }, {})
      }, null, 2)) + '</pre></div>');
    }

    root.innerHTML = html.join('');

    wrapEl = root.querySelector('.wrap');
    tbodyEl = root.querySelector('table.pivot tbody');
    bindGrid();
    paintWindow(true);
  }

  /* One click listener for the whole grid rather than one per pill -- at 390k
     cells the per-pill version allocated 390k closures during render. */
  function bindGrid() {
    if (!wrapEl) return;
    // innerHTML normally discards the previous wrap with its listeners, but don't
    // depend on that -- a re-bound element would fire the handler once per paint.
    if (wrapEl.__ptBound) return;
    wrapEl.__ptBound = true;
    wrapEl.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.pill') : null;
      if (!btn || !view) return;
      handleCellClick(btn.getAttribute('data-row'), btn.getAttribute('data-col'),
        view.rowPassId, view.colPassId, btn);
    });

    wrapEl.addEventListener('scroll', function () {
      if (rafPending) return;
      rafPending = true;
      var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
      raf(function () { rafPending = false; paintWindow(false); });
    });
  }

  /* Renders only the rows overlapping the viewport. Two spacer rows stand in for
     everything above and below, so the scrollbar behaves as if the full grid were
     present. */
  function paintWindow(force) {
    if (!view || !tbodyEl) return;
    var total = view.grid.rows.length;
    var rowH = view.rowH;
    var viewportH = (wrapEl && wrapEl.clientHeight) || 600;
    var scrollTop = (wrapEl && wrapEl.scrollTop) || 0;

    var start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN);
    var end = Math.min(total, Math.ceil((scrollTop + viewportH) / rowH) + OVERSCAN);
    if (!force && start === view.start && end === view.end) return;
    view.start = start;
    view.end = end;

    var html = [];
    if (start > 0) html.push(spacer(start * rowH));
    for (var i = start; i < end; i++) html.push(rowHtml(view.grid.rows[i]));
    if (end < total) html.push(spacer((total - end) * rowH));

    tbodyEl.innerHTML = html.join('');
  }

  function spacer(px) {
    return '<tr class="spacer" style="height:' + px + 'px"><td colspan="' +
      view.colCount + '"></td></tr>';
  }

  function rowHtml(row) {
    var layout = view.layout, styles = view.styles, data = view.data;
    var html = ['<tr>'];

    for (var i = 0; i < layout.rowColumns.length; i++) {
      var id = layout.rowColumns[i];
      html.push('<td class="lead c' + i + (i === 0 ? ' first' : '') +
        (i === layout.rowColumns.length - 1 ? ' last' : '') + '"' + sty(styles, id) + '>' +
        esc(fmt((data[id] || [])[row.index], id)) + '</td>');
    }

    var rowPass = blank((data[view.rowPassId] || [])[row.index]);

    for (var c = 0; c < view.grid.pivotKeys.length; c++) {
      var pk = view.grid.pivotKeys[c];
      // Cells are keyed by each column's original slot, so sorting the headers
      // cannot pair a cell with the wrong column.
      var ri = row.cells[pk.index];
      if (ri === undefined) { html.push('<td class="cell empty"></td>'); continue; }

      var hasValue = false;
      for (var v = 0; v < layout.valueColumns.length; v++) {
        var raw = (data[layout.valueColumns[v]] || [])[ri];
        if (raw !== null && raw !== undefined && raw !== '') { hasValue = true; break; }
      }
      var colorValue = view.colorArr ? view.colorArr[ri] : null;
      var hasColor = view.colorColumn && colorValue !== null &&
        colorValue !== undefined && colorValue !== '';
      // A cell with no measures but a known status still matters -- show the
      // colored pill (labelled with the status) rather than dropping it.
      if (!hasValue && !hasColor) { html.push('<td class="cell empty"></td>'); continue; }

      var style = window.PivotColors.resolve(colorValue, view.compiled, view.autoPalette, view.domain);
      var colPass = colPassValue(pk, layout, view.colPassId);
      var selKey = window.PivotDetect.key(rowPass) + '\u0001' + window.PivotDetect.key(colPass);

      var lines = '';
      if (hasValue) {
        for (var l = 0; l < layout.valueColumns.length; l++) {
          var vid = layout.valueColumns[l];
          var text = fmt((data[vid] || [])[ri], vid);
          if (!text) continue;
          lines += '<span class="line l' + l + '"' + sty(styles, vid) + '>' + esc(text) + '</span>';
        }
      } else {
        lines = '<span class="status"' + sty(styles, view.colorColumn) + '>' +
          esc(fmt(colorValue, view.colorColumn)) + '</span>';
      }

      html.push('<td class="cell">' +
        '<button type="button" class="pill' + (hasValue ? '' : ' blank') +
        (state.selected === selKey ? ' sel' : '') + '"' +
        ' style="background:' + esc(style.bg) + ';color:' + esc(style.fg) +
        ';border-color:' + esc(style.border) + '"' +
        ' data-row="' + esc(String(rowPass)) + '"' +
        ' data-col="' + esc(String(colPass)) + '">' + lines + '</button></td>');
    }

    html.push('</tr>');
    return html.join('');
  }

  // Placeholder only until the first config callback arrives; subscribe() may fire
  // synchronously, so never overwrite content that has already been rendered.
  if (!root.innerHTML.trim()) message('Initializing\u2026');
})();
