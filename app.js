/* Pivot Tracker — renders a Sigma pivot-table element as a pill grid with
   sticky left columns, inherited column formatting, rule-driven pill colours,
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
  var client = SDK.client;

  client.config.configureEditorPanel([
    { name: 'source', type: 'element' },

    { name: 'rowColumns', type: 'column', source: 'source', allowMultiple: true,
      label: 'Left columns (optional override)',
      description: 'Leave empty to auto-detect from the pivot row dimensions. The first column is the one passed to the row control.' },
    { name: 'pivotColumn', type: 'column', source: 'source', allowMultiple: false,
      label: 'Pivot column (optional override)',
      description: 'Leave empty to auto-detect the crosstab column dimension.' },
    { name: 'valueColumns', type: 'column', source: 'source', allowMultiple: true,
      label: 'Cell values (optional override)',
      description: 'Leave empty to auto-detect. Rendered stacked inside each pill, in order.' },

    { name: 'colorColumn', type: 'column', source: 'source', allowMultiple: false,
      label: 'Colour by column (optional)' },
    { name: 'colorRules', type: 'text', multiline: true,
      label: 'Colour rules JSON (optional)',
      placeholder: '{"Completed":"#1d3a5c","Pending":"#4a3c12"}',
      description: 'Overrides the auto palette. Flat value:colour map, or {"default":..,"values":{..},"rules":[{"op":">=","value":10,"color":"#..."}]}.' },
    { name: 'autoPalette', type: 'toggle', label: 'Auto palette for unmatched values',
      defaultValue: true },

    { name: 'rowVariable', type: 'variable', label: 'Control: row value (optional)' },
    { name: 'columnVariable', type: 'variable', label: 'Control: pivot column value (optional)' },
    { name: 'onCellClick', type: 'action-trigger', label: 'On cell click action (optional)' },

    { name: 'showValueLabels', type: 'toggle', label: 'Show value-column header row' },
    { name: 'compact', type: 'toggle', label: 'Compact rows' },
    { name: 'debug', type: 'toggle', label: 'Show detection diagnostics' }
  ]);

  var root = document.getElementById('root');
  var state = { config: {}, data: null, columns: null, selected: null };
  var unsubData = null, unsubCols = null, boundSource = null;

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

  function bindSource(sourceId) {
    if (boundSource === sourceId) return;
    if (unsubData) { unsubData(); unsubData = null; }
    if (unsubCols) { unsubCols(); unsubCols = null; }
    boundSource = sourceId;
    state.data = null;
    state.columns = null;
    if (!sourceId) { render(); return; }

    unsubCols = client.elements.subscribeToElementColumns(sourceId, function (cols) {
      state.columns = cols;
      render();
    });
    unsubData = client.elements.subscribeToElementData(sourceId, function (data) {
      state.data = data;
      render();
    });
  }

  client.config.subscribe(function (config) {
    state.config = config || {};
    bindSource(state.config.source);
    render();
  });

  // --- cell click -> workbook controls -------------------------------------
  function handleCellClick(rowValue, pivotValue, rowColId, pivotColId) {
    var cfg = state.config;
    if (cfg.rowVariable) {
      client.setVariable(cfg.rowVariable, rowValue === null || rowValue === undefined ? '' : String(rowValue));
    }
    if (cfg.columnVariable) {
      client.setVariable(cfg.columnVariable, pivotValue === null || pivotValue === undefined ? '' : String(pivotValue));
    }
    if (cfg.onCellClick) client.triggerAction(cfg.onCellClick);
    state.selected = window.PivotDetect.key(rowValue) + '\u0001' + window.PivotDetect.key(pivotValue);
    render();
  }

  function message(text, cls) {
    root.innerHTML = '<div class="msg ' + (cls || '') + '">' + esc(text) + '</div>';
  }

  function render() {
    var cfg = state.config;
    if (!cfg.source) return message('Select a pivot table as the data source in the editor panel.');
    if (!state.data || !state.columns) return message('Loading pivot data\u2026');

    var layout = window.PivotDetect.detect(state.data, state.columns, {
      rowColumns: asArray(cfg.rowColumns),
      pivotColumn: cfg.pivotColumn,
      valueColumns: asArray(cfg.valueColumns),
      excludeColumns: cfg.colorColumn ? [cfg.colorColumn] : []
    });

    if (!layout.rowKey || !layout.pivotColumn) {
      return message(
        'Could not auto-detect the pivot layout (' + (layout.reason || 'unknown') + '). ' +
        'Set the left columns and pivot column overrides in the editor panel.', 'error');
    }
    if (!layout.valueColumns.length) {
      return message('No value columns found for the pivot cells.', 'error');
    }

    var grid = window.PivotDetect.build(layout, cfg.colorColumn);
    var compiled = window.PivotColors.compile(cfg.colorRules);
    var autoPalette = cfg.autoPalette !== false;

    // Stable colour domain so palette assignment doesn't shift between renders.
    var domain = [];
    if (cfg.colorColumn) {
      var seen = Object.create(null);
      (state.data[cfg.colorColumn] || []).forEach(function (v) {
        if (v === null || v === undefined || v === '') return;
        var s = String(v);
        if (!seen[s]) { seen[s] = true; domain.push(s); }
      });
      domain.sort();
    }

    var showLabels = cfg.showValueLabels !== false && layout.valueColumns.length > 1;
    var html = [];

    html.push('<div class="wrap' + (cfg.compact ? ' compact' : '') + '">');
    html.push('<table class="pivot"><thead>');

    // Header row 1: left column names + one group header per pivot value.
    html.push('<tr class="hdr-main">');
    layout.rowColumns.forEach(function (id, i) {
      html.push('<th class="lead' + (i === 0 ? ' first' : '') +
        (i === layout.rowColumns.length - 1 ? ' last' : '') + '"' +
        (showLabels ? ' rowspan="2"' : '') + '>' + esc(colName(id)) + '</th>');
    });
    grid.pivotKeys.forEach(function (pk) {
      // Column-dimension attributes ride along in the header, e.g. PLATING (80).
      var attrs = (layout.columnDims || []).map(function (id) {
        var t = fmt(pk.attrs[id], id);
        return t ? t : null;
      }).filter(Boolean);
      html.push('<th class="grp" colspan="1" title="' + esc(colName(layout.pivotColumn)) + '">' +
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
          return '<span class="vlabel">' + esc(colName(id)) + '</span>';
        }).join('') + '</th>');
      });
      html.push('</tr>');
    }
    html.push('</thead><tbody>');

    grid.rows.forEach(function (row) {
      html.push('<tr>');
      layout.rowColumns.forEach(function (id, i) {
        html.push('<td class="lead' + (i === 0 ? ' first' : '') +
          (i === layout.rowColumns.length - 1 ? ' last' : '') + '">' +
          esc(fmt(row.rowValues[id], id)) + '</td>');
      });
      grid.pivotKeys.forEach(function (pk) {
        var cell = row.cells[pk.k];
        if (!cell) { html.push('<td class="cell empty"></td>'); return; }

        var hasValue = layout.valueColumns.some(function (id) {
          var v = cell.values[id];
          return v !== null && v !== undefined && v !== '';
        });
        var hasColor = cfg.colorColumn && cell.color !== null && cell.color !== undefined && cell.color !== '';
        // A cell with no measures but a known status still matters -- show the
        // coloured pill (labelled with the status) rather than dropping it.
        if (!hasValue && !hasColor) { html.push('<td class="cell empty"></td>'); return; }

        var style = window.PivotColors.resolve(cell.color, compiled, autoPalette, domain);
        var selKey = window.PivotDetect.key(row.rowValues[layout.rowKey]) + '\u0001' +
                     window.PivotDetect.key(pk.value);
        var lines;
        if (hasValue) {
          lines = layout.valueColumns.map(function (id, idx) {
            var text = fmt(cell.values[id], id);
            if (!text) return '';
            return '<span class="line l' + idx + '">' + esc(text) + '</span>';
          }).join('');
        } else {
          lines = '<span class="status">' + esc(fmt(cell.color, cfg.colorColumn)) + '</span>';
        }

        var tip = layout.valueColumns.map(function (id) {
          return colName(id) + ': ' + (fmt(cell.values[id], id) || '\u2014');
        });
        if (cfg.colorColumn && cell.color !== null && cell.color !== undefined) {
          tip.unshift(colName(cfg.colorColumn) + ': ' + fmt(cell.color, cfg.colorColumn));
        }

        html.push('<td class="cell">' +
          '<button type="button" class="pill' + (hasValue ? '' : ' blank') +
          (state.selected === selKey ? ' sel' : '') + '"' +
          ' style="background:' + esc(style.bg) + ';color:' + esc(style.fg) +
          ';border-color:' + esc(style.border) + '"' +
          ' data-row="' + esc(String(row.rowValues[layout.rowKey])) + '"' +
          ' data-col="' + esc(String(pk.value === null || pk.value === undefined ? '' : pk.value)) + '"' +
          ' title="' + esc(tip.join('\n')) + '">' + lines + '</button></td>');
      });
      html.push('</tr>');
    });

    html.push('</tbody></table></div>');

    if (cfg.debug) {
      html.push('<div class="debug"><b>Detected layout</b><pre>' + esc(JSON.stringify({
        rowCount: layout.rowCount,
        rowKey: colName(layout.rowKey),
        leftColumns: layout.rowColumns.map(colName),
        pivotColumn: colName(layout.pivotColumn),
        pivotValues: grid.pivotKeys.length,
        columnAttributes: (layout.columnDims || []).map(colName),
        valueColumns: layout.valueColumns.map(colName),
        autoDetected: layout.detected,
        colorColumn: cfg.colorColumn ? colName(cfg.colorColumn) : null,
        colorDomain: domain,
        colorRulesError: compiled.error,
        formats: Object.keys(state.columns).reduce(function (acc, id) {
          acc[state.columns[id].name] = {
            type: state.columns[id].columnType, format: state.columns[id].format || null
          };
          return acc;
        }, {})
      }, null, 2)) + '</pre></div>');
    }

    root.innerHTML = html.join('');

    pinLeftColumns(layout.rowColumns.length);

    Array.prototype.forEach.call(root.querySelectorAll('.pill'), function (btn) {
      btn.addEventListener('click', function () {
        handleCellClick(btn.getAttribute('data-row'), btn.getAttribute('data-col'),
          layout.rowKey, layout.pivotColumn);
      });
    });
  }

  /* `position: sticky` needs an explicit `left` per column, so measure the rendered
     widths of the first row's lead cells and apply cumulative offsets. */
  function pinLeftColumns(count) {
    var table = root.querySelector('table.pivot');
    if (!table || count < 1) return;
    var firstRow = table.querySelector('tbody tr');
    if (!firstRow) return;

    var leads = firstRow.querySelectorAll('td.lead');
    var offsets = [];
    var acc = 0;
    for (var i = 0; i < leads.length; i++) {
      offsets.push(acc);
      acc += leads[i].getBoundingClientRect().width;
    }

    ['thead tr', 'tbody tr'].forEach(function (sel) {
      Array.prototype.forEach.call(table.querySelectorAll(sel), function (tr) {
        var cells = tr.querySelectorAll('.lead');
        for (var i = 0; i < cells.length && i < offsets.length; i++) {
          cells[i].style.left = offsets[i] + 'px';
        }
      });
    });
  }

  // Placeholder only until the first config callback arrives; subscribe() may fire
  // synchronously, so never overwrite content that has already been rendered.
  if (!root.innerHTML.trim()) message('Initialising\u2026');
})();
