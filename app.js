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
  var client = SDK.client;

  client.config.configureEditorPanel([
    { name: 'source', type: 'element' },

    // Sigma only streams data for columns the plugin explicitly requests, so at
    // least one column entry is required. Roles are still detected automatically.
    { name: 'dataColumns', type: 'column', source: 'source', allowMultiple: true,
      label: 'Columns',
      description: 'Optional if you fill in the role overrides below. Otherwise add every column the pivot uses — row dimensions, the pivot column, the cell values and the color column — and their roles are detected automatically.' },

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
      label: 'Color by column (optional)' },
    { name: 'colorRules', type: 'text', multiline: true,
      label: 'Color rules JSON (optional)',
      placeholder: '{"Completed":"#1d3a5c","Pending":"#4a3c12"}',
      description: 'Overrides the auto palette. Flat value:color map, or {"default":..,"values":{..},"rules":[{"op":">=","value":10,"color":"#..."}]}.' },
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

  // --- which column supplies each passed value ------------------------------
  // Defaults reproduce the original behaviour (first left column / the pivot
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

  function rowPassValue(row, layout) { return blank(row.rowValues[passRowId(layout)]); }

  function colPassValue(pk, layout) {
    var id = passColId(layout);
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

  function handleCellClick(rowValue, pivotValue, rowColId, pivotColId) {
    var cfg = state.config;
    // Variables and action triggers live on client.config, not on the client root.
    if (cfg.rowVariable) {
      client.config.setVariable(cfg.rowVariable, typedValue(rowValue, rowColId));
    }
    if (cfg.columnVariable) {
      client.config.setVariable(cfg.columnVariable, typedValue(pivotValue, pivotColId));
    }
    if (cfg.onCellClick) client.config.triggerAction(cfg.onCellClick);
    state.selected = window.PivotDetect.key(rowValue) + '\u0001' + window.PivotDetect.key(pivotValue);
    render();
  }

  function message(text, cls) {
    root.innerHTML = '<div class="msg ' + (cls || '') + '">' + esc(text) + '</div>';
  }

  function render() {
    var cfg = state.config;
    if (!cfg.source) return message('Select a pivot table as the data source in the editor panel.');

    // Sigma streams data for every column referenced by any column config entry,
    // so the scope is the union of all of them -- filling in the role overrides
    // alone is sufficient, with no need to repeat them under "Columns".
    var requested = [];
    [asArray(cfg.dataColumns), asArray(cfg.rowColumns), asArray(cfg.pivotColumn),
     asArray(cfg.valueColumns), asArray(cfg.colorColumn),
     asArray(cfg.rowValueColumn), asArray(cfg.columnValueColumn)].forEach(function (group) {
      group.forEach(function (id) {
        if (requested.indexOf(id) === -1) requested.push(id);
      });
    });

    // A color column on its own carries no layout, so treat that as "not set up
    // yet" and show guidance rather than a detection failure.
    var structural = requested.filter(function (id) { return id !== cfg.colorColumn; });

    if (!structural.length) {
      return message('Add the pivot\'s columns under "Columns" in the editor panel — ' +
        'row dimensions, the pivot column, the cell values and the color column. ' +
        'Their roles are detected automatically.');
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
      excludeColumns: cfg.colorColumn ? [cfg.colorColumn] : []
    });

    if (!layout.rowKey || !layout.pivotColumn) {
      var missing = requested.filter(function (id) { return !Array.isArray(state.data[id]); });
      return message(
        'Could not auto-detect the pivot layout (' + (layout.reason || 'unknown') + '). ' +
        'Received data for ' + Object.keys(scopedData).length + ' of ' + requested.length +
        ' configured column(s)' +
        (missing.length ? '; no data for: ' + missing.map(colName).join(', ') : '') +
        '. Set the left columns and pivot column overrides in the editor panel.', 'error');
    }
    if (!layout.valueColumns.length) {
      return message('No value columns found for the pivot cells.', 'error');
    }

    var grid = window.PivotDetect.build(layout, cfg.colorColumn);
    var compiled = window.PivotColors.compile(cfg.colorRules);
    var autoPalette = cfg.autoPalette !== false;

    // Stable color domain so palette assignment doesn't shift between renders.
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
        // colored pill (labelled with the status) rather than dropping it.
        if (!hasValue && !hasColor) { html.push('<td class="cell empty"></td>'); return; }

        var style = window.PivotColors.resolve(cell.color, compiled, autoPalette, domain);
        var selKey = window.PivotDetect.key(rowPassValue(row, layout)) + '\u0001' +
                     window.PivotDetect.key(colPassValue(pk, layout));
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
          ' data-row="' + esc(String(rowPassValue(row, layout))) + '"' +
          ' data-col="' + esc(String(colPassValue(pk, layout))) + '"' +
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
        requestedColumns: requested.length,
        populatedColumns: populated.length,
        rowValuePassed: colName(passRowId(layout)),
        columnValuePassed: colName(passColId(layout)),
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
          passRowId(layout), passColId(layout));
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
