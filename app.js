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
    /* Colors are set by clicking a swatch in the legend, not here. This entry
       stays declared because it is the slot the picker writes into -- an
       undeclared config key is not guaranteed to persist -- and because it keeps
       the advanced forms available: numeric thresholds and presence tests, which
       a swatch picker cannot express. Normally you never open it. */
    { name: 'colorRules', type: 'text', multiline: true,
      label: 'Colors (managed by the legend \u2014 advanced)',
      placeholder: '{"isnotnull":"#1d3a5c","isnull":"#f4f5f7"}',
      description: 'Click a swatch in the legend under the grid to change a color. This box holds what the legend saves, and accepts forms the legend cannot: {"default":..,"values":{..},"rules":[{"op":">=","value":10,"color":"#..."}]}, plus the presence tests "isnull" and "isnotnull" for coloring by whether a column has a value at all. Editing it by hand still works and the legend will show the result.' },
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

    { name: 'inlineLabels', type: 'toggle',
      label: 'Prefix each cell value with its field name', defaultValue: false },
    { name: 'showValueLabels', type: 'toggle',
      label: 'Show a field-name row under each column header', defaultValue: false },
    { name: 'compact', type: 'toggle', label: 'Compact rows' },
    { name: 'darkMode', type: 'toggle', label: 'Dark mode', defaultValue: false,
      description: 'Off (default) matches Sigma\'s light workbook surface. On switches the grid and pill palette to dark.' },
    { name: 'debug', type: 'toggle', label: 'Show detection diagnostics' }
  ]);

  var root = document.getElementById('root');
  var state = { config: {}, data: null, columns: null, selected: null,
    loaded: 0, totalRows: null, complete: false, dataVersion: 0, pending: null };
  var unsubData = null, unsubCols = null, boundKey = null, boundElement = null, lastConfigJson = null;
  /* `rendered` says a grid -- not a message -- is on screen, which is what makes a
     page 0 a reload rather than a first load. `buffering` means pages are landing
     in state.pending; `frozen` means the buffer was too big to keep and repaints
     are suppressed until the load finishes. */
  var rendered = false, buffering = false, frozen = false;
  // Config the host has actually emitted, and the keys it has ever mentioned.
  var emitted = {}, emittedKeys = Object.create(null);

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
      // A different element invalidates any buffered reload of the old one.
      state.pending = null;
      buffering = false;
      frozen = false;
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
  /* A shadow buffer holds a second copy of the element while it reloads. At the
     measured 2.5 GB peak for 2M rows that copy is not affordable, so past this
     many rows we give the copy back and simply stop repainting instead. */
  var BUFFER_ROW_LIMIT = 750000;
  var noProgress = 0, lastChunkPaint = 0, chunkTimer = null;
  /* Counters for the diagnostics block: they are what distinguishes the plugin
     repainting itself from Sigma re-mounting the iframe underneath it. */
  var stats = { deliveries: 0, rebuilds: 0, repaints: 0, buffered: 0, frozen: 0 };

  function setLoading(on) {
    try { client.config.setLoadingState(!!on); } catch (e) { /* older host */ }
  }

  /* Chunks arrive as { data, offset, isComplete, totalRows }. Accumulate in place
     -- rebuilding the arrays per chunk would make loading O(rows x chunks) -- and
     bump a version so the layout memo still invalidates. */
  function mergeChunk(chunk, sourceId) {
    if (!chunk || typeof chunk !== 'object') return;
    stats.deliveries++;
    var incoming = chunk.data || {};
    var offset = typeof chunk.offset === 'number' ? chunk.offset : 0;

    /* A fresh page 0 on top of a grid that is already on screen is a *refetch* --
       Sigma re-running the query after a comment was written. Accumulating it
       into state.data in place is what made the plugin thrash: rows are sorted
       globally and then capped, so every intermediate repaint showed the first N
       sorted rows *of the fraction loaded so far*, a different plate set on each
       of the ~20 pages. Load into a shadow buffer instead and swap once, so the
       user sees the old grid until the new one is complete. */
    if (offset === 0) {
      if (state.data && rendered) {
        state.pending = {};
        buffering = true;
        frozen = false;
        stats.buffered++;
      } else {
        state.data = {};
        state.pending = null;
        buffering = false;
        frozen = false;
      }
      state.loaded = 0;
    } else if (!state.data && !buffering) {
      state.data = {};
      state.loaded = 0;
    }

    var sink = buffering ? state.pending : state.data;

    Object.keys(incoming).forEach(function (id) {
      if (id === '__proto__') return;
      var target = sink[id];
      if (!Array.isArray(target)) target = sink[id] = [];
      // A re-sent page rewinds to its offset rather than duplicating rows.
      if (target.length > offset) target.length = offset;
      var src = incoming[id] || [];
      for (var i = 0; i < src.length; i++) target.push(src[i]);
    });

    var loaded = 0;
    Object.keys(sink).forEach(function (id) {
      if (sink[id].length > loaded) loaded = sink[id].length;
    });

    /* Too big to hold two copies: hand the buffer over as the live data (which
       releases the old copy, so the peak is unchanged) and keep suppressing
       repaints. The grid on screen is then stale for the rest of the load, but a
       frozen grid is what the user asked for and it beats running out of memory. */
    if (buffering && loaded > BUFFER_ROW_LIMIT) {
      state.data = state.pending;
      state.pending = null;
      buffering = false;
      frozen = true;
      stats.frozen++;
    }
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

    /* A load that is buffering or frozen paints exactly once, when it completes.
       Anything else is the first load, where showing a prefix is better than
       showing nothing. */
    if (buffering || frozen) {
      if (!state.complete) return;
      if (buffering) { state.data = state.pending; state.pending = null; }
      buffering = false;
      frozen = false;
      // Only a reload warns about a lost row: a config or layout change is
      // *expected* to move rows around, so a warning there would be noise.
      reloadPaint = true;
      lastChunkPaint = Date.now();
      if (chunkTimer) { clearTimeout(chunkTimer); chunkTimer = null; }
      render();
      return;
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

  client.config.subscribe(function (config) {
    config = config || {};
    // Remember which keys the host has emitted, so the poll below can never
    // overwrite one of them with a stale snapshot.
    Object.keys(config).forEach(function (k) { emittedKeys[k] = true; });
    emitted = config;
    applyConfig(config);
  });

  /* The host emits config once when the init handshake resolves and again on every
     edit. If the iframe is re-mounted (which Sigma does when settings change) an
     emission can land before this subscription exists, leaving the plugin parked
     on its placeholder until the workbook is refreshed. Polling the live config
     recovers from any dropped emission; applyConfig() de-dupes, so a steady state
     costs one small JSON.stringify per tick.

     But config.get() returns a snapshot of the last *message* the host sent, and
     saving a text field reaches subscribe() without always refreshing it -- a
     column picker change does refresh it, because that re-mounts the iframe.
     Re-applying the raw snapshot therefore reverted saved text within 400 ms,
     which is why the color rules JSON appeared to do nothing. Anything the host
     has emitted wins; the snapshot only fills in keys we have never been told
     about, which is what preserves the dropped-emission recovery. */
  setInterval(function () {
    var snapshot;
    try { snapshot = client.config.get(); } catch (e) { return; }   // host not ready
    if (!snapshot) return;
    var merged = {}, k;
    for (k in snapshot) if (!emittedKeys[k]) merged[k] = snapshot[k];
    for (k in emitted) merged[k] = emitted[k];
    applyConfig(merged);
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
    // No grid on screen, so the next page 0 counts as a first load, not a reload.
    rendered = false;
    wrapEl = tbodyEl = null;
  }

  /* Scroll position is restored by *row identity*, not by scrollTop. A reload can
     change the row set -- new plates appear, the Max rows cap keeps a different
     slice -- so the same pixel offset lands on a different plate, which is what
     made the clicked cell appear to move or vanish. Remember which row was where
     instead, and put that row back at the same pixel. */
  var anchor = null, anchorLost = null, reloadPaint = false;
  // Pinned column widths; see the signature check in paintShell().
  var widthCache = null;

  function captureAnchor() {
    if (!wrapEl || !view || !view.grid || !view.grid.rows.length) return;
    var rows = view.grid.rows, rowH = view.rowH;
    var scrollTop = wrapEl.scrollTop || 0;
    var viewportH = wrapEl.clientHeight || 0;
    var idx = Math.min(rows.length - 1, Math.max(0, Math.floor(scrollTop / rowH)));

    /* The clicked row is the one the user is watching, so prefer it -- but only
       while it is actually on screen, otherwise scrolling away from a selection
       would keep dragging the viewport back to it. */
    var selKey = state.selected ? String(state.selected).split('\u0001')[0] : null;
    if (selKey) {
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].key !== selKey) continue;
        var top = i * rowH;
        if (top + rowH > scrollTop && top < scrollTop + viewportH) idx = i;
        break;
      }
    }

    anchor = {
      key: rows[idx].key,
      offset: idx * rowH - scrollTop,      // that row's top, relative to viewport
      scrollLeft: wrapEl.scrollLeft || 0
    };
  }

  function restoreAnchor() {
    var a = anchor;
    anchor = null;
    if (!a || !wrapEl || !view || !view.grid) return;
    var rows = view.grid.rows, found = -1;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].key === a.key) { found = i; break; }
    }
    wrapEl.scrollLeft = a.scrollLeft;
    if (found === -1) { anchorLost = a.key; return; }
    anchorLost = null;
    var max = Math.max(0, rows.length * view.rowH - (wrapEl.clientHeight || 0));
    wrapEl.scrollTop = clamp(found * view.rowH - a.offset, 0, max);
    paintWindow(true);
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

  function measureCells(grid, layout, compact, inlineLabels) {
    var data = grid.data || {};
    var chars = 0;
    var n = Math.min(grid.rows.length, SAMPLE);
    // A "Operator: " prefix widens every line, and a cell that is too narrow wraps
    // -- which breaks virtualization, since it assumes every row is exactly rowH.
    var pad = Object.create(null);
    layout.valueColumns.forEach(function (vid) {
      pad[vid] = inlineLabels ? String(colName(vid)).length + 2 : 0;
    });
    for (var i = 0; i < n; i++) {
      var cells = grid.rows[i].cells;
      for (var c = 0; c < grid.pivotKeys.length; c++) {
        var ri = cells[grid.pivotKeys[c].index];
        if (ri === undefined) continue;
        for (var v = 0; v < layout.valueColumns.length; v++) {
          var vid = layout.valueColumns[v];
          var t = fmt((data[vid] || [])[ri], vid);
          if (t && t.length + pad[vid] > chars) chars = t.length + pad[vid];
        }
      }
    }
    // Headers share the same column, so they set the floor.
    grid.pivotKeys.forEach(function (pk) {
      var h = String(fmt(pk.value, layout.pivotColumn) || '').length + 6;
      if (h > chars) chars = h;
    });
    return clamp(textWidth(chars, 6.9) + (compact ? 18 : 24), compact ? 92 : 104,
      inlineLabels ? 400 : 260);
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
    stats.rebuilds++;
    return memo;
  }

  /* The legend is per distinct value, not per cell, so it costs nothing on a big
     grid. Colors come from the same resolve() the pills use, so it can never
     disagree with what is on screen. */
  var LEGEND_LIMIT = 24;
  var BLANK_TOKEN = '\u0000blank';

  function legendHtml(cfg, compiled, domain, hasBlank) {
    if (!cfg.colorColumn || (!domain.length && !hasBlank)) return '';
    var autoPalette = cfg.autoPalette !== false;
    var out = ['<div class="legend"><span class="lgt">' +
      esc(colName(cfg.colorColumn)) + '</span>'];

    function item(value, label, token) {
      var st = window.PivotColors.resolve(value, compiled, autoPalette, domain);
      return '<button type="button" class="lg" data-lgv="' + esc(token) + '"' +
        ' title="Click to change this color">' +
        '<span class="sw" style="background:' + esc(st.bg) +
        ';border-color:' + esc(st.border) + '"></span>' +
        '<span class="lgn">' + esc(label) + '</span></button>';
    }

    domain.slice(0, LEGEND_LIMIT).forEach(function (v) { out.push(item(v, v, v)); });
    // Blank is a real state worth a swatch -- "has no comment" is the whole point
    // of the isnull rule -- so it gets an entry whenever blanks exist.
    if (hasBlank) out.push(item(null, 'No value', BLANK_TOKEN));
    if (domain.length > LEGEND_LIMIT) {
      out.push('<span class="lgmore">+' + (domain.length - LEGEND_LIMIT) +
        ' more</span>');
    }
    out.push('</div>');
    return out.join('');
  }

  /* ---- color picker -------------------------------------------------------
     Clicking a legend swatch edits the color for that value. The choice is
     written back into the plugin's own config through config.setKey, so it is
     stored in the workbook like any other setting and survives publish. */
  var COLOR_KEY = 'colorRules';
  var PICK_PRESETS = [
    '#e3edfb', '#dff2e9', '#fdf1d4', '#fce6df', '#f3e6f7', '#eef0f3',
    '#2d6cdf', '#1e8e5a', '#d9a018', '#c4462f', '#7a4bab', '#5a6472',
    '#1b3f6b', '#14543c', '#6b4e0d', '#71301d', '#4a2358', '#2f3742'
  ];
  var pickerEl = null, pickerToken = null;

  function closePicker() {
    if (pickerEl && pickerEl.parentNode) pickerEl.parentNode.removeChild(pickerEl);
    pickerEl = null;
    pickerToken = null;
  }

  function normalizeHex(text) {
    var t = String(text == null ? '' : text).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(t)) {
      t = t[0] + t[0] + t[1] + t[1] + t[2] + t[2];   // #abc is legal CSS
    }
    return /^[0-9a-f]{6}$/i.test(t) ? '#' + t.toLowerCase() : null;
  }

  /* Rewrites one entry of the stored rules without disturbing the rest. An
     envelope ({default, values, rules}) keeps its shape, so the numeric rules and
     presence tests the JSON field supports are not destroyed by using the picker.
     A null color removes the override, returning that value to the palette. */
  function withOverride(json, token, color) {
    var parsed = null;
    if (json && String(json).trim()) {
      try { parsed = JSON.parse(json); } catch (e) { parsed = null; }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = {};
    // Blanks are stored as the presence test that already means "no value".
    var key = token === BLANK_TOKEN ? 'isnull' : token;
    var isEnvelope = parsed.values || parsed.rules || parsed['default'];
    var target = parsed;
    if (isEnvelope && token !== BLANK_TOKEN) {
      if (!parsed.values || typeof parsed.values !== 'object') parsed.values = {};
      target = parsed.values;
    }
    if (color === null) delete target[key];
    else target[key] = color;
    var empty = !Object.keys(parsed).length ||
      (isEnvelope && !Object.keys(parsed.values || {}).length &&
        !(parsed.rules || []).length && !parsed['default'] &&
        !parsed.isnull && !parsed.isnotnull);
    return empty ? '' : JSON.stringify(parsed);
  }

  function setColor(token, color) {
    var next = withOverride(state.config[COLOR_KEY], token, color);
    /* Treat our own write as a host emission. Without this the 400 ms poll would
       read a config snapshot that predates it and revert the color -- the same
       way saved text used to be lost. */
    emittedKeys[COLOR_KEY] = true;
    emitted[COLOR_KEY] = next;
    var merged = {}, k;
    for (k in state.config) merged[k] = state.config[k];
    merged[COLOR_KEY] = next;
    closePicker();
    applyConfig(merged);
    try {
      if (typeof client.config.setKey === 'function') client.config.setKey(COLOR_KEY, next);
      else if (typeof client.config.set === 'function') {
        var patch = {}; patch[COLOR_KEY] = next; client.config.set(patch);
      } else {
        colorWriteError = 'This Sigma version cannot store the color from here.';
      }
    } catch (e) {
      // A viewer without edit rights cannot write config; the color still applies
      // for this session, so say so rather than failing silently.
      colorWriteError = 'Color changed for this session only (no permission to save it).';
    }
  }
  var colorWriteError = null;

  function openPicker(anchor, token) {
    if (pickerToken === token) { closePicker(); return; }
    closePicker();
    pickerToken = token;

    var current = null;
    var swatch = anchor.querySelector ? anchor.querySelector('.sw') : null;
    if (swatch && swatch.style) current = normalizeHex(rgbToHex(swatch.style.background));

    var label = token === BLANK_TOKEN ? 'No value' : token;
    var opts = PICK_PRESETS.map(function (hex) {
      return '<button type="button" class="opt' + (hex === current ? ' on' : '') +
        '" data-hex="' + esc(hex) + '" style="background:' + esc(hex) +
        '" title="' + esc(hex) + '"></button>';
    }).join('');

    var el = document.createElement('div');
    el.className = 'pick';
    el.innerHTML = '<div class="pt">Color for <b>' + esc(label) + '</b></div>' +
      '<div class="grid">' + opts + '</div>' +
      '<div class="hexrow"><input type="text" class="hex" placeholder="#A36E1F" ' +
      'value="' + esc(current || '') + '" spellcheck="false">' +
      '<button type="button" class="act">Apply</button></div>' +
      '<button type="button" class="reset">Reset to automatic</button>';
    root.appendChild(el);
    pickerEl = el;
    positionPicker(el, anchor);

    var input = el.querySelector('.hex');
    if (input && input.focus) input.focus();
  }

  function positionPicker(el, anchor) {
    if (!anchor.getBoundingClientRect || !root.getBoundingClientRect) return;
    var a = anchor.getBoundingClientRect(), r = root.getBoundingClientRect();
    var top = (a.top - r.top) - 8;
    var left = (a.left - r.left);
    // Open upward from the legend and keep the popover inside the iframe.
    el.style.left = Math.max(6, Math.min(left, (r.width || 0) - 194)) + 'px';
    el.style.top = Math.max(6, top - 236) + 'px';
  }

  function rgbToHex(css) {
    var s = String(css == null ? '' : css).trim();
    if (/^#/.test(s)) return s;
    var m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/.exec(s);
    if (!m) return '';
    return '#' + [1, 2, 3].map(function (i) {
      return ('0' + Number(m[i]).toString(16)).slice(-2);
    }).join('');
  }

  function bindLegend() {
    if (root.__ptLegendBound) return;
    root.__ptLegendBound = true;
    root.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var preset = t.closest('.opt');
      if (preset) { setColor(pickerToken, preset.getAttribute('data-hex')); return; }

      if (t.closest('.act')) {
        var input = pickerEl && pickerEl.querySelector('.hex');
        var hex = normalizeHex(input && input.value);
        if (!hex) { if (input && input.classList) input.classList.add('bad'); return; }
        setColor(pickerToken, hex);
        return;
      }

      if (t.closest('.reset')) { setColor(pickerToken, null); return; }
      if (t.closest('.pick')) return;                       // clicks inside stay

      var chip = t.closest('.lg');
      if (chip) { openPicker(chip, chip.getAttribute('data-lgv')); return; }
      closePicker();                                        // anywhere else
    });
  }

  function paintShell(cfg, layout, grid, resolved, requested, populated) {
    /* Before anything else: the anchor has to be read while `view` still describes
       what is on screen. `view` is replaced further down, and capturing after that
       would anchor to the new row set -- which is exactly the no-op this was
       written to avoid. */
    captureAnchor();
    var compact = !!cfg.compact;
    var compiled = window.PivotColors.compile(cfg.colorRules);
    var styles = window.PivotStyles.compile(cfg.columnStyles);

    // Stable color domain so palette assignment doesn't shift between renders.
    var domain = [];
    var hasBlank = false;
    if (cfg.colorColumn) {
      var seen = Object.create(null);
      var carr = state.data[cfg.colorColumn] || [];
      for (var i = 0; i < carr.length; i++) {
        var v = carr[i];
        if (v === null || v === undefined || v === '' ||
            (typeof v === 'string' && v.trim() === '')) { hasBlank = true; continue; }
        var s = String(v);
        if (!seen[s]) { seen[s] = true; domain.push(s); }
      }
      domain.sort();
    }

    /* Widths are sampled from content, so re-measuring after a reload can shift
       every column by a few pixels -- which also invalidates the horizontal scroll
       position we just restored. Measure once per shell shape and pin the result;
       only a change of layout, of the pill contents, or of the column set remeasures. */
    var wsig = [layout.rowColumns.join(','), layout.pivotColumn,
      layout.valueColumns.join(','), grid.pivotKeys.length,
      compact ? 1 : 0, cfg.inlineLabels ? 1 : 0].join('|');
    if (!widthCache || widthCache.sig !== wsig) {
      widthCache = { sig: wsig,
        left: measureLeft(grid, layout, compact),
        cell: measureCells(grid, layout, compact, !!cfg.inlineLabels) };
    }
    var leftWidths = widthCache.left;
    var cellWidth = widthCache.cell;
    var rowH = rowHeight(layout.valueColumns.length, compact);

    // Everything paintWindow() needs, so scrolling touches no config parsing.
    view = {
      layout: layout, grid: grid, compact: compact,
      data: grid.data || {},
      compiled: compiled, styles: styles, domain: domain,
      autoPalette: cfg.autoPalette !== false,
      inlineLabels: !!cfg.inlineLabels,
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

    html.push(legendHtml(cfg, compiled, domain, hasBlank));

    var notes = [];
    /* Only the very first load fills in as it goes; a reload is buffered and
       swapped in one step, so promising otherwise would be a lie. This note is the
       plugin's only loading indicator -- setLoading() drives Sigma's own bar, so
       the plugin never adds a second progress widget beside it. */
    if (!state.complete) {
      notes.push('Loading rows from Sigma\u2026 ' + (state.loaded || 0).toLocaleString() +
        (state.totalRows ? ' of ' + state.totalRows.toLocaleString() : '') +
        ' so far.' + (rendered
          ? ' The grid below stays as it is until every page has arrived.'
          : ' The grid fills in as pages arrive.'));
    }
    if (grid.truncated) {
      notes.push('Showing the first ' + grid.rows.length.toLocaleString() +
        ' of ' + grid.totalRows.toLocaleString() + ' rows. ' +
        'Raise or clear <b>Max rows</b> in the editor panel to show more.');
    }
    if (colorWriteError) notes.push(colorWriteError);
    if (notes.length) {
      html.push('<div class="note">' + notes.join(' &nbsp;\u00b7&nbsp; ') + '</div>');
    }

    if (cfg.debug) {
      html.push('<div class="debug"><b>Detected layout</b><pre>' + esc(JSON.stringify({
        sourceRows: layout.rowCount,
        rowsLoaded: state.loaded,
        rowsReportedByHost: state.totalRows,
        loadComplete: state.complete,
        /* Reload accounting. A rebuild count that climbs while nothing was edited
           means the plugin is thrashing; deliveries climbing with rebuilds flat is
           the intended buffered reload. And repaints resetting to 1 with the others
           back at their opening values means Sigma re-mounted the iframe, which is
           outside the plugin's control. */
        deliveries: stats.deliveries,
        rebuilds: stats.rebuilds,
        repaints: stats.repaints,
        bufferedReloads: stats.buffered,
        frozenReloads: stats.frozen,
        buffering: buffering,
        frozen: frozen,
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
    stats.repaints++;
    rendered = true;

    wrapEl = root.querySelector('.wrap');
    tbodyEl = root.querySelector('table.pivot tbody');
    bindGrid();
    bindLegend();
    paintWindow(true);
    restoreAnchor();
    if (anchorLost && reloadPaint) noteAnchorLost();
    anchorLost = null;
    reloadPaint = false;
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
  /* The anchor row is gone from the reloaded data -- the plate was filtered out,
     or the Max rows cap now keeps a different slice. Scrolling somewhere arbitrary
     and saying nothing is what made cells seem to vanish, so leave the viewport at
     the top and say what happened. Appended after the paint because the note is
     only known once the new grid exists. */
  function noteAnchorLost() {
    var key = anchorLost;
    anchorLost = null;
    if (!root || typeof document.createElement !== 'function') return;
    var el = document.createElement('div');
    el.className = 'note warn';
    // Row keys are type-tagged ("string:100025"); show the value, not the tag.
    var label = String(key).replace(/^[a-z]+:/, '').replace(/^\u0000null$/, '(blank)');
    el.innerHTML = 'The row you were on (<b>' + esc(label) +
      '</b>) is not in the reloaded data, so the view is back at the top.' +
      (view && view.grid && view.grid.truncated
        ? ' It may be past the <b>Max rows</b> cap.' : '');
    root.appendChild(el);
  }

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
          // The field name is a separate span so it can be styled -- and greyed --
          // independently of the value it introduces.
          var tag = view.inlineLabels
            ? '<span class="ilbl"' + sty(styles, vid, 'header') + '>' +
              esc(colName(vid)) + ':</span> '
            : '';
          lines += '<span class="line l' + l + '"' + sty(styles, vid) + '>' +
            tag + esc(text) + '</span>';
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
