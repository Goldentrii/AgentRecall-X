/* ============================================================
   AgentRecall War Room — views: Activity, Palace, Dreams,
   Onboarding, Connect
============================================================ */
(function () {
  var AR = window.AR, H = AR.H;

  /* ============================================================
     ACTIVITY — contribution calendar + precise timeline
  ============================================================ */
  AR.views.activity = function (root) {
    var projFilter = AR._actFilter || 'all';
    var projOpts = ['all'].concat(AR.projects.map(function (p) { return p.slug; }));

    var totalSaves = AR.calendar.reduce(function (s, d) { return s + d.count; }, 0);
    var activeDays = AR.calendar.filter(function (d) { return d.count > 0; }).length;
    var best = AR.calendar.reduce(function (m, d) { return d.count > m.count ? d : m; }, { count: 0 });

    var html = '';
    html += '<h1 style="font-size:22px;color:var(--ink);margin-bottom:4px;">Activity</h1>' +
      '<div style="font-size:13px;color:var(--ink-soft);margin-bottom:18px;">Every memory write, correction and dream — the heartbeat of your agents.</div>';

    // stat strip
    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px;">' +
      statTile(totalSaves, 'saves', 'last 18 weeks') +
      statTile(activeDays, 'active days', 'of ' + AR.calendar.length) +
      statTile(best.count, 'busiest day', best.date || '—') +
      '</div>';

    // calendar panel
    html += '<div class="panel" style="margin-bottom:14px;"><div class="panel-hdr"><span class="panel-title">Save Calendar</span>' +
      '<span class="panel-sub">color deepens after 10 & 20 saves/day</span></div>' +
      '<div class="panel-body" style="padding:16px;overflow-x:auto;"><div id="act-cal"></div></div></div>';

    // timeline panel
    html += '<div class="panel"><div class="panel-hdr"><span class="panel-title">Timeline</span>' +
      '<div class="dropdown" id="act-dd"><button class="dd-trigger" id="act-dd-btn" style="padding:5px 10px;font-size:12px;">' +
        '<span id="act-dd-label" class="mono">' + (projFilter === 'all' ? 'all projects' : projFilter) + '</span>' +
        '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="dd-menu" id="act-dd-menu">' + projOpts.map(function (o) {
          return '<button class="dd-opt' + (o === projFilter ? ' sel' : '') + '" data-val="' + o + '"><span class="mono" style="font-size:12px;">' + (o === 'all' ? 'all projects' : o) + '</span></button>';
        }).join('') + '</div></div></div>' +
      '<div class="panel-body" style="overflow-y:auto;max-height:46vh;" id="act-timeline">' +
        AR.activityRows(AR.activity.filter(function (e) { return projFilter === 'all' || e.project === projFilter; }), { full: true }) +
      '</div></div>';

    root.innerHTML = html + actStyles();
    AR.renderCalendar(document.getElementById('act-cal'), { cell: 14 });

    var btn = document.getElementById('act-dd-btn'), menu = document.getElementById('act-dd-menu');
    btn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', function () { menu.classList.remove('open'); });
    menu.querySelectorAll('.dd-opt').forEach(function (o) {
      o.addEventListener('click', function () { AR._actFilter = o.getAttribute('data-val'); AR.views.activity(document.getElementById('view-inner')); });
    });
  };

  function statTile(v, k, sub) {
    return '<div class="panel" style="padding:14px 16px;gap:4px;"><div class="display" style="font-size:28px;color:var(--ink);line-height:1;">' + v + '</div>' +
      '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-soft);">' + k + '</div>' +
      '<div style="font-size:11px;color:var(--ink-faint);font-weight:700;" class="mono">' + sub + '</div></div>';
  }
  function actStyles() {
    return '<style>.cal-cell{transition:transform 80ms;}.cal-cell:hover{transform:scale(1.25);}</style>';
  }

  /* ============================================================
     PALACE GRAPH — dedicated dynamic view
  ============================================================ */
  AR.views.palace = function (root) {
    var pg = AR.palace;
    var html = '';
    html += '<div style="display:flex;align-items:flex-start;gap:14px;margin-bottom:14px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:240px;"><h1 style="font-size:22px;color:var(--ink);">Palace Graph</h1>' +
      '<div style="font-size:13px;color:var(--ink-soft);margin-top:3px;">Rooms of <span class="mono" style="color:var(--accent);">' + pg.nodes[0].project + '</span> sized by salience, colored by type, warmth by recency. Click a room to inspect.</div></div></div>';

    html += '<div style="display:grid;grid-template-columns:1fr 280px;gap:12px;align-items:stretch;height:calc(100vh - 200px);min-height:440px;">';
    // graph canvas
    html += '<div class="panel panel--dark" style="position:relative;overflow:hidden;">' +
      '<div id="palace-cy" style="position:absolute;inset:0;"></div>' +
      '<div class="palace-vignette" style="position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,transparent 38%,rgba(16,14,11,.72));pointer-events:none;"></div>' +
      '<div style="position:absolute;left:14px;top:14px;display:flex;flex-wrap:wrap;gap:6px;max-width:60%;z-index:2;" id="palace-legend"></div>' +
      '</div>';
    // detail panel
    html += '<div class="panel" id="palace-detail"><div class="panel-hdr"><span class="panel-title">Room Detail</span></div>' +
      '<div class="panel-body" style="padding:16px;" id="palace-detail-body"><div class="empty">Click a room in the graph to see its salience, recency and connections.</div></div></div>';
    html += '</div>';

    root.innerHTML = html + '<style>.pl-conn{display:flex;align-items:center;gap:7px;padding:5px 8px;border-radius:7px;font-size:12px;color:var(--ink-soft);}.pl-conn:hover{background:var(--surface-2);}</style>';

    // legend
    document.getElementById('palace-legend').innerHTML = pg.legend.map(function (l) {
      return '<span class="chip" style="background:rgba(255,255,255,.06);color:var(--canvas-ink);font-size:10px;"><span class="chip-dot" style="background:' + l.color + ';"></span>' + l.type + '</span>';
    }).join('');

    var typeColor = {}; pg.legend.forEach(function (l) { typeColor[l.type] = l.color; });
    var SAL_MIN = 0.44, SAL_MAX = 0.74;
    function size(s) { var n = Math.min(1, Math.max(0, (s - SAL_MIN) / (SAL_MAX - SAL_MIN))); return 22 + n * 52; }

    var nodes = pg.nodes.map(function (n) { return { group: 'nodes', data: { id: n.id, type: n.type, salience: n.salience, cards: n.cards, updated: n.updated, project: n.project } }; });
    var edges = pg.edges.map(function (e) { return { group: 'edges', data: { id: e[0] + '_' + e[1], source: e[0], target: e[1] } }; });

    var cy = cytoscape({
      container: document.getElementById('palace-cy'),
      elements: nodes.concat(edges),
      style: [
        { selector: 'node', style: {
          'width': function (e) { return size(e.data('salience')); },
          'height': function (e) { return size(e.data('salience')); },
          'background-color': function (e) { return typeColor[e.data('type')] || '#C9A56C'; },
          'background-opacity': function (e) { var d = H.daysSince(e.data('updated')); return d <= 1 ? 1 : d <= 3 ? 0.85 : d <= 7 ? 0.6 : 0.4; },
          'border-width': function (e) { return H.daysSince(e.data('updated')) <= 3 ? 2.5 : 1; },
          'border-color': function (e) { return H.daysSince(e.data('updated')) <= 1 ? '#fff' : 'rgba(255,255,255,.25)'; },
          'label': 'data(id)', 'color': '#E8E0D0',
          'font-size': function (e) { return Math.max(9, size(e.data('salience')) * 0.2); },
          'font-family': 'Nunito, sans-serif', 'font-weight': 700,
          'text-valign': 'center', 'text-halign': 'center', 'text-wrap': 'wrap',
          'text-max-width': function (e) { return size(e.data('salience')) - 6; }
        }},
        { selector: 'edge', style: { 'width': 1.2, 'line-color': 'rgba(201,165,108,.35)', 'curve-style': 'bezier', 'opacity': 0.6 } },
        { selector: 'node.sel', style: { 'border-width': 3, 'border-color': '#E0C088' } },
        { selector: 'node:active', style: { 'overlay-opacity': 0 } }
      ],
      layout: { name: 'cose', animate: true, animationDuration: 1600, randomize: true,
        nodeRepulsion: function () { return 14000; }, nodeOverlap: 28,
        idealEdgeLength: function () { return 95; }, edgeElasticity: function () { return 120; },
        gravity: 0.3, numIter: 1200, fit: true, padding: 40 },
      userZoomingEnabled: true, userPanningEnabled: true, minZoom: 0.4, maxZoom: 2.5,
      boxSelectionEnabled: false
    });

    function showDetail(n) {
      cy.nodes().removeClass('sel'); cy.getElementById(n.id).addClass('sel');
      var conns = cy.getElementById(n.id).connectedEdges().connectedNodes().filter(function (x) { return x.id() !== n.id; });
      var days = H.daysSince(n.updated);
      var html = '<div style="display:flex;align-items:center;gap:8px;margin-bottom:12px;">' +
        '<span style="width:14px;height:14px;border-radius:50%;background:' + (typeColor[n.type] || '#C9A56C') + ';"></span>' +
        '<span class="display" style="font-size:18px;color:var(--ink);">' + n.id + '</span></div>' +
        '<div style="display:flex;gap:18px;margin-bottom:14px;">' +
          mini(Math.round(n.salience * 100) + '%', 'salience') + mini(n.cards, 'cards') + mini(days + 'd', 'since update') +
        '</div>' +
        '<div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint);margin-bottom:6px;">Connected rooms (' + conns.length + ')</div>';
      conns.forEach(function (c) {
        html += '<button class="pl-conn" data-id="' + c.id() + '" style="width:100%;text-align:left;"><span style="width:7px;height:7px;border-radius:50%;background:' + (typeColor[c.data('type')] || '#C9A56C') + ';"></span>' + c.id() + '<span style="margin-left:auto;font-size:10px;color:var(--ink-faint);" class="mono">' + c.data('cards') + ' cards</span></button>';
      });
      html += '<a href="#/project/' + n.project + '" class="btn btn--ghost" style="margin-top:14px;width:100%;justify-content:center;">open ' + n.project + ' →</a>';
      var body = document.getElementById('palace-detail-body');
      body.innerHTML = html;
      body.querySelectorAll('.pl-conn').forEach(function (b) { b.addEventListener('click', function () { showDetail(cy.getElementById(b.getAttribute('data-id')).data()); }); });
    }
    function mini(v, k) { return '<div><div class="display" style="font-size:20px;color:var(--ink);line-height:1;">' + v + '</div><div style="font-size:9px;color:var(--ink-faint);font-weight:800;text-transform:uppercase;letter-spacing:.08em;">' + k + '</div></div>'; }

    cy.on('tap', 'node', function (evt) { showDetail(evt.target.data()); });
    cy.on('mouseover', 'node', function (evt) {
      var d = evt.target.data();
      AR.tip.show(evt.originalEvent, '<div class="tt-lbl">' + d.id + '</div><div class="tt-row">salience ' + Math.round(d.salience * 100) + '% · ' + d.cards + ' cards</div><div class="tt-note">updated ' + H.rel(d.updated) + '</div>');
    });
    cy.on('mousemove', 'node', function (evt) { AR.tip.move(evt.originalEvent); });
    cy.on('mouseout', 'node', AR.tip.hide);

    AR._destroy = function () { try { cy.destroy(); } catch (e) {} };
  };

  /* ============================================================
     DREAM HEALTH — per-night runs + file drill-down
  ============================================================ */
  AR.views.dreams = function (root) {
    var dreams = AR.dreams;            // newest first
    var fails = dreams.filter(function (d) { return d.status === 'fail'; });
    var okRate = Math.round((dreams.length - fails.length) / dreams.length * 100);

    var html = '';
    html += '<h1 style="font-size:22px;color:var(--ink);margin-bottom:4px;">Dream Health</h1>' +
      '<div style="font-size:13px;color:var(--ink-soft);margin-bottom:18px;">The nightly consolidation cron — what ran, what it touched, and what broke. Click a night to see its files.</div>';

    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:14px;">' +
      statTile(okRate + '%', 'success rate', 'last ' + dreams.length + ' nights') +
      statTile(fails.length, 'failures', fails.length ? 'last: ' + fails[0].date : 'none') +
      statTile(dreams[0].dur, 'last run', dreams[0].date) +
      '</div>';

    // night strip
    html += '<div class="panel" style="margin-bottom:14px;"><div class="panel-hdr"><span class="panel-title">Last 20 Nights</span><span class="panel-sub">× = failed run</span></div>' +
      '<div class="panel-body" style="padding:16px;"><div style="display:flex;gap:5px;flex-wrap:wrap;">';
    dreams.slice().reverse().forEach(function (d) {
      var isFail = d.status === 'fail';
      html += '<div class="night-cell" data-date="' + d.date + '" style="background:' + (isFail ? 'var(--rust)' : 'var(--ok)') + ';opacity:' + (isFail ? 1 : .8) + ';">' + (isFail ? '×' : '') + '</div>';
    });
    html += '</div><div style="font-size:10px;color:var(--ink-faint);font-weight:700;margin-top:10px;" class="mono">' + dreams[dreams.length-1].date + ' → ' + dreams[0].date + '</div></div></div>';

    if (fails.length) {
      html += '<div style="display:flex;align-items:center;gap:9px;padding:11px 15px;border-radius:11px;background:var(--warn-dim);border:1px solid var(--warn);margin-bottom:14px;">' +
        '<span style="color:var(--warn);font-size:16px;">⚠</span><span style="font-size:13px;color:var(--ink);font-weight:600;">' + fails.length + ' failed nights in window. Most recent root cause: <b>' + H.esc(fails[0].summary) + '</b></span></div>';
    }

    // run list
    html += '<div class="panel"><div class="panel-hdr"><span class="panel-title">Run Log</span></div><div class="panel-body" id="dream-list" style="overflow-y:auto;">';
    dreams.forEach(function (d, i) { html += dreamRow(d, i); });
    html += '</div></div>';

    root.innerHTML = html + dreamStyles();

    root.querySelectorAll('.dream-row-head').forEach(function (h) {
      h.addEventListener('click', function () {
        var body = h.nextElementSibling;
        var open = body.classList.toggle('open');
        h.querySelector('.dream-caret').style.transform = open ? 'rotate(90deg)' : '';
      });
    });
  };

  function dreamRow(d, i) {
    var isFail = d.status === 'fail';
    var c = isFail ? 'var(--rust)' : 'var(--ok)';
    var files = (d.files || []);
    return '<div class="dream-row">' +
      '<button class="dream-row-head">' +
        '<svg class="dream-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--ink-faint)" stroke-width="2.5" style="transition:transform 150ms;flex-shrink:0;"><path d="M9 6l6 6-6 6"/></svg>' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + c + ';flex-shrink:0;"></span>' +
        '<span class="mono" style="font-size:12px;color:var(--ink);font-weight:700;width:96px;flex-shrink:0;">' + d.date + '</span>' +
        '<span class="tag" style="flex-shrink:0;">' + d.project + '</span>' +
        '<span style="font-size:12px;color:var(--ink-soft);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + H.esc(d.summary) + '</span>' +
        '<span class="mono" style="font-size:10px;color:var(--ink-faint);flex-shrink:0;">' + d.started + ' · ' + d.dur + '</span>' +
      '</button>' +
      '<div class="dream-body">' +
        '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint);margin-bottom:8px;">Files touched (' + files.length + ')</div>' +
        (files.length ? files.map(function (f) {
          return '<div class="file-row mono"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>' +
            '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;">' + H.esc(f) + '</span>' +
            '<span class="file-open">open</span></div>';
        }).join('') : '<div style="font-size:12px;color:var(--ink-faint);">No files changed — routine pass.</div>') +
      '</div></div>';
  }
  function dreamStyles() {
    return '<style>' +
      '.night-cell{width:30px;height:30px;border-radius:6px;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:800;font-size:13px;}' +
      '.dream-row{border-bottom:1px solid var(--rule-soft);}' +
      '.dream-row-head{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:10px 14px;}' +
      '.dream-row-head:hover{background:var(--surface-2);}' +
      '.dream-body{display:none;padding:0 14px 14px 44px;}.dream-body.open{display:block;}' +
      '.file-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:7px;font-size:11px;color:var(--ink-soft);background:var(--surface-2);margin-bottom:4px;}' +
      '.file-open{color:var(--accent);font-weight:700;font-family:"Nunito",sans-serif;cursor:pointer;}' +
      '.file-open:hover{text-decoration:underline;}' +
      '</style>';
  }

  /* ============================================================
     ONBOARDING — install flow
  ============================================================ */
  AR.views.onboarding = function (root) {
    var html = '';
    html += '<div style="max-width:920px;margin:0 auto;">';
    html += '<div style="text-align:center;margin-bottom:8px;"><span class="chip" style="background:var(--accent-dim);color:var(--accent);">◷ ' + H.t('2-minute setup', '2 分钟安装') + '</span></div>';
    html += '<h1 class="display" style="font-size:38px;color:var(--ink);text-align:center;line-height:1.1;">' +
      H.t('Give your agent<br>a memory that lasts.', '为你的 agent<br>打造持久记忆') + '</h1>' +
      '<div style="font-size:15px;color:var(--ink-soft);text-align:center;max-width:560px;margin:10px auto 6px;line-height:1.6;">' +
      H.t('Persistent, accumulating memory for any AI agent. Local-first — everything lives in <span class="mono" style="color:var(--accent);">~/.agent-recall</span> and never leaves this machine unless you turn on sync.',
          '为任意 AI agent 提供持久、累积式记忆。本地优先 —— 所有数据存储在 <span class="mono" style="color:var(--accent);">~/.agent-recall</span>，除非开启同步否则不会离开本机。') + '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;margin:16px 0 28px;">' +
      '<span class="tag">' + H.t('zero-cloud', '零云端') + '</span>' +
      '<span class="tag">' + H.t('22 MCP tools', '22 个工具') + '</span>' +
      '<span class="tag">' + H.t('plain-markdown', '纯 markdown') + '</span></div>';

    // install prompt — for discovery / agent-first flow
    html += '<div class="panel panel--dark" style="margin-bottom:16px;"><div class="panel-hdr"><span class="panel-title hero" style="color:var(--accent-soft);">🤖 Found AgentRecall? Paste this to install</span>' +
      '<span class="panel-sub" style="color:var(--ink-faint);">copy → paste to your agent → it installs for you</span></div>' +
      '<div class="panel-body" style="padding:18px;">' +
      '<div style="font-size:13px;color:var(--canvas-ink);opacity:.85;line-height:1.5;margin-bottom:4px;">Your agent found this page. Have it run the command below — or copy this block and paste it as a message to your agent.</div>' +
      '<div style="font-size:11px;color:var(--canvas-ink);opacity:.6;line-height:1.5;margin-bottom:12px;">你的 agent 找到了这个页面。让它运行下面的命令 —— 或者复制这段内容粘贴给 agent。</div>' +
      '<div class="mono" id="install-box" style="font-size:11px;line-height:1.6;color:var(--canvas-ink);background:rgba(0,0,0,.25);border:1px solid var(--canvas-line);border-radius:9px;padding:14px;white-space:pre-wrap;">' + H.esc(AR.installPrompt) + '</div>' +
      '<button class="btn btn--primary" id="copy-install" style="margin-top:12px;">⧉ Copy install prompt</button></div></div>';

    // bootstrap prompt — after installation
    html += '<div class="panel panel--dark" style="margin-bottom:28px;"><div class="panel-hdr"><span class="panel-title hero" style="color:var(--accent-soft);">⚡ After installing — paste this as first message</span>' +
      '<span class="panel-sub" style="color:var(--ink-faint);">tells your agent how to use AgentRecall each session</span></div>' +
      '<div class="panel-body" style="padding:18px;">' +
      '<div style="font-size:13px;color:var(--canvas-ink);opacity:.85;line-height:1.5;margin-bottom:4px;">Once installed, paste this as the first message in any new session. Your agent will know when to call session_start, when to save corrections, and when to close.</div>' +
      '<div style="font-size:11px;color:var(--canvas-ink);opacity:.6;line-height:1.5;margin-bottom:12px;">安装完成后，把这段作为任意新会话的第一条消息。agent 会知道什么时候调用 session_start、保存纠正、以及关闭会话。</div>' +
      '<div class="mono" id="paste-box" style="font-size:11px;line-height:1.6;color:var(--canvas-ink);background:rgba(0,0,0,.25);border:1px solid var(--canvas-line);border-radius:9px;padding:14px;white-space:pre-wrap;">' + H.esc(AR.pastePrompt) + '</div>' +
      '<button class="btn btn--primary" id="copy-paste" style="margin-top:12px;">⧉ Copy bootstrap prompt</button></div></div>';

    // arstatus — verify install
    html += '<div class="panel" style="margin-bottom:28px;"><div class="panel-hdr">' +
      '<span class="panel-title">▸ ' + H.t('Verify your install', '验证安装') + '</span>' +
      '<span class="panel-sub">' + H.t('run this after installing', '安装后运行') + '</span></div>' +
      '<div class="panel-body" style="padding:14px 18px;">' +
      '<div style="font-size:13px;color:var(--ink-soft);line-height:1.6;margin-bottom:10px;">' +
      H.t('Run <code class="mono" style="color:var(--accent);">arstatus</code> to confirm AgentRecall is active. You\'ll see your workspace root, project count, and last session.',
          '运行 <code class="mono" style="color:var(--accent);">arstatus</code> 确认 AgentRecall 已激活，显示工作区路径、项目数量和最近会话。') +
      '</div>' +
      '<div class="onb-code" style="max-width:280px;">' +
        '<span class="mono" style="flex:1;">arstatus</span>' +
        '<button class="code-copy" data-code="arstatus" id="copy-arstatus">⧉</button>' +
      '</div>' +
      '<div style="font-size:11px;color:var(--ink-faint);margin-top:8px;line-height:1.4;">' +
      H.t('Expected: workspace path · X projects · last session timestamp', '预期输出：工作区路径 · X 个项目 · 最近会话时间戳') +
      '</div></div></div>';

    // client cards
    html += '<div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:var(--ink-faint);margin-bottom:6px;">' +
      H.t('Pick your client', '选择你的客户端') + '</div>';
    html += '<div style="font-size:11px;color:var(--ink-faint);text-align:center;margin:10px 0 12px;letter-spacing:.02em;">↓ ' +
      H.t('scroll for all 13 clients', '向下滚动查看全部 13 个客户端') + '</div>';
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:8px;">';
    AR.clients.forEach(function (c, i) { html += clientCard(c, i); });
    html += '</div>';

    html += '</div>';
    root.innerHTML = html + onbStyles();

    var arstatusBtn = document.getElementById('copy-arstatus');
    if (arstatusBtn) arstatusBtn.addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText('arstatus');
      this.textContent = '✓'; var b = this; setTimeout(function () { b.textContent = '⧉'; }, 1200);
    });
    document.getElementById('copy-install').addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText(AR.installPrompt);
      this.textContent = '✓ Copied'; var b = this; setTimeout(function () { b.textContent = '⧉ Copy install prompt'; }, 1500);
    });
    document.getElementById('copy-paste').addEventListener('click', function () {
      navigator.clipboard && navigator.clipboard.writeText(AR.pastePrompt);
      this.textContent = '✓ Copied'; var b = this; setTimeout(function () { b.textContent = '⧉ Copy bootstrap prompt'; }, 1500);
    });
    root.querySelectorAll('.client-head').forEach(function (h) {
      h.addEventListener('click', function () {
        var body = h.nextElementSibling, open = body.classList.toggle('open');
        h.querySelector('.client-caret').style.transform = open ? 'rotate(90deg)' : '';
      });
    });
    root.querySelectorAll('.code-copy').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        navigator.clipboard && navigator.clipboard.writeText(b.getAttribute('data-code'));
        b.textContent = '✓'; setTimeout(function () { b.textContent = '⧉'; }, 1200);
      });
    });
  };

  function compatBadge(c) {
    if (c.compat === 'verified')   return '<span class="chip" style="background:var(--ok-dim);color:var(--ok);font-size:9px;padding:1px 7px;">✓ verified</span>';
    if (c.compat === 'pattern')    return '<span class="chip" style="background:var(--warn-dim);color:var(--warn);font-size:9px;padding:1px 7px;">~ pattern</span>';
    if (c.compat === 'unverified') return '<span class="chip" style="background:var(--surface-2);color:var(--ink-faint);font-size:9px;padding:1px 7px;">? unverified</span>';
    if (c.compat === 'no-mcp')     return '<span class="chip" style="background:var(--bad-dim);color:var(--bad);font-size:9px;padding:1px 7px;">no MCP</span>';
    return '';
  }
  function clientCard(c, i) {
    var note = c.compatNote ? '<div style="font-size:10px;color:var(--warn);line-height:1.4;padding:7px 11px 0;border-top:1px solid var(--canvas-line);">' + H.esc(c.compatNote) + '</div>' : '';
    return '<div class="client-card">' +
      '<button class="client-head">' +
        '<div class="client-ico" data-fb="' + H.esc(c.brand || c.name.slice(0,2)) + '">' +
          (c.si
            ? '<img src="static/icons/' + c.si + '.svg" width="22" height="22" ' +
              'style="display:block;object-fit:contain;" ' +
              'onerror="this.style.display=\'none\';var p=this.parentElement;p.textContent=p.getAttribute(\'data-fb\')">'
            : H.esc(c.brand || c.name.slice(0,2))) +
        '</div>' +
        '<div style="flex:1;min-width:0;"><div style="display:flex;align-items:center;gap:7px;"><span style="font-weight:700;font-size:14px;color:var(--ink);white-space:nowrap;">' + H.esc(c.name) + '</span>' +
          compatBadge(c) + '</div>' +
          '<div style="font-size:10px;color:var(--ink-faint);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + H.esc(c.blurb) + '</div></div>' +
        '<svg class="client-caret" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--ink-faint)" stroke-width="2.5" style="transition:transform 150ms;flex-shrink:0;"><path d="M9 6l6 6-6 6"/></svg>' +
      '</button>' +
      '<div class="client-body">' +
        note +
        step(1, 'Prerequisite', c.pre) + step(2, 'Install', c.install) + step(3, 'Verify', c.verify) +
      '</div></div>';
  }
  function step(n, label, code) {
    var isCode = n !== 3;
    return '<div class="onb-step"><div class="onb-step-n">' + n + '</div><div style="flex:1;min-width:0;">' +
      '<div style="font-size:11px;font-weight:800;color:var(--ink);margin-bottom:5px;">' + label + '</div>' +
      (isCode
        ? '<div class="onb-code"><span class="mono" style="flex:1;overflow-x:auto;">' + H.esc(code) + '</span><button class="code-copy" data-code="' + H.esc(code) + '">⧉</button></div>'
        : '<div style="font-size:12px;color:var(--ink-soft);line-height:1.5;">' + H.esc(code) + '</div>') +
      '</div></div>';
  }
  function onbStyles() {
    return '<style>' +
      '.client-card{border:1px solid var(--rule);border-radius:10px;background:var(--surface);overflow:hidden;}' +
      '.client-head{display:flex;align-items:center;gap:9px;width:100%;text-align:left;padding:9px 11px;}' +
      '.client-head:hover{background:var(--surface-2);}' +
      '.client-ico{width:26px;height:26px;border-radius:7px;background:linear-gradient(140deg,var(--accent-soft),var(--accent));color:#fff;font-family:"Baloo 2";font-weight:800;font-size:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}' +
      '.client-body{display:none;padding:2px 11px 11px;}.client-body.open{display:block;}' +
      '.onb-step{display:flex;gap:9px;padding:7px 0;}' +
      '.onb-step-n{width:18px;height:18px;border-radius:50%;background:var(--accent-dim);color:var(--accent);font-weight:800;font-size:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}' +
      '.onb-code{display:flex;align-items:center;gap:8px;background:var(--canvas);border:1px solid var(--canvas-line);border-radius:8px;padding:8px 10px;font-size:11px;color:var(--canvas-ink);}' +
      '.code-copy{color:var(--accent-soft);font-size:13px;flex-shrink:0;}' +
      '</style>';
  }

  /* ============================================================
     CONNECT — local-first + optional Supabase + last-save path
  ============================================================ */
  AR.views.connect = function (root) {
    var s = AR.stats;
    var html = '<div style="max-width:760px;margin:0 auto;">';
    html += '<h1 style="font-size:22px;color:var(--ink);margin-bottom:4px;">Connect & Storage</h1>' +
      '<div style="font-size:13px;color:var(--ink-soft);margin-bottom:20px;">AgentRecall is local-first. Sync is opt-in.</div>';

    // local-first card
    html += '<div class="panel" style="margin-bottom:14px;"><div class="panel-hdr"><span class="panel-title">Local Storage</span>' +
      '<span class="chip" style="background:var(--ok-dim);color:var(--ok);"><span class="sdot" style="background:var(--ok);"></span>active</span></div>' +
      '<div class="panel-body" style="padding:16px;">' +
      '<div style="font-size:13px;color:var(--ink-soft);line-height:1.6;margin-bottom:14px;">All memory is written as plain markdown under your home directory. Nothing is uploaded. You can read, grep, version-control, or delete it yourself.</div>' +
      pathRow('Memory root', '~/.agent-recall') +
      pathRow('Last save', s.last_save_path, true) +
      '</div></div>';

    // supabase optional
    html += '<div class="panel" style="margin-bottom:14px;"><div class="panel-hdr"><span class="panel-title">Supabase Sync</span>' +
      '<span class="chip" id="sb-status" style="background:var(--surface-2);color:var(--ink-faint);"><span class="sdot sdot--stale"></span>not connected</span></div>' +
      '<div class="panel-body" style="padding:16px;">' +
      '<div style="font-size:13px;color:var(--ink-soft);line-height:1.6;margin-bottom:14px;">Optional. If you run a Supabase project, connect it to sync memory across machines. The app still runs entirely on <span class="mono" style="color:var(--accent);">localhost</span> — Supabase is just the backing store. No Supabase? You lose nothing; local-first stays the default.</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;max-width:520px;">' +
        field('Project URL', 'https://xxxxx.supabase.co', 'sb-url') +
        field('Anon / service key', 'eyJhbGciOi…', 'sb-key') +
        '<div style="display:flex;gap:9px;align-items:center;margin-top:4px;">' +
          '<button class="btn btn--primary" id="sb-connect">Connect Supabase</button>' +
          '<button class="btn" id="sb-skip">Stay local-only</button>' +
          '<span id="sb-msg" style="font-size:12px;color:var(--ink-faint);font-weight:700;"></span>' +
        '</div></div>' +
      '</div></div>';

    // workspace stats
    html += '<div class="panel"><div class="panel-hdr"><span class="panel-title">Workspace</span></div>' +
      '<div class="panel-body" style="padding:16px;display:grid;grid-template-columns:repeat(4,1fr);gap:14px;">' +
        wstat(s.projects, 'projects') + wstat(s.memory_layers, 'memory layers') + wstat(s.rules, 'behavior rules') + wstat(s.skills, 'skills') +
      '</div></div>';

    html += '</div>';
    root.innerHTML = html + connStyles();

    document.getElementById('sb-connect').addEventListener('click', function () {
      var url = document.getElementById('sb-url').value.trim();
      var msg = document.getElementById('sb-msg');
      if (!url) { msg.style.color = 'var(--bad)'; msg.textContent = 'enter a project URL first'; return; }
      document.getElementById('sb-status').innerHTML = '<span class="sdot" style="background:var(--ok);"></span>connected (demo)';
      document.getElementById('sb-status').style.background = 'var(--ok-dim)';
      document.getElementById('sb-status').style.color = 'var(--ok)';
      msg.style.color = 'var(--ok)'; msg.textContent = '✓ sync enabled — local files still authoritative';
    });
    document.getElementById('sb-skip').addEventListener('click', function () {
      document.getElementById('sb-msg').style.color = 'var(--ink-faint)';
      document.getElementById('sb-msg').textContent = 'staying local-only — nothing leaves this machine';
    });
    root.querySelectorAll('.path-copy').forEach(function (b) {
      b.addEventListener('click', function () { navigator.clipboard && navigator.clipboard.writeText(b.getAttribute('data-path')); b.textContent = '✓'; setTimeout(function () { b.textContent = '⧉'; }, 1200); });
    });
  };

  function pathRow(label, path, highlight) {
    return '<div class="path-row" style="' + (highlight ? 'border-color:var(--accent-soft);' : '') + '">' +
      '<div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-faint);width:90px;flex-shrink:0;">' + label + '</div>' +
      '<span class="mono" style="flex:1;font-size:12px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;">' + H.esc(path) + '</span>' +
      '<button class="path-copy" data-path="' + H.esc(path) + '">⧉</button></div>';
  }
  function field(label, ph, id) {
    return '<label style="display:flex;flex-direction:column;gap:5px;"><span style="font-size:11px;font-weight:800;color:var(--ink-soft);">' + label + '</span>' +
      '<input id="' + id + '" placeholder="' + ph + '" class="mono" style="padding:9px 12px;border-radius:9px;border:1px solid var(--rule);background:var(--surface);color:var(--ink);font-size:12px;" /></label>';
  }
  function wstat(v, k) { return '<div><div class="display" style="font-size:26px;color:var(--ink);line-height:1;">' + v + '</div><div style="font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:var(--ink-faint);margin-top:3px;">' + k + '</div></div>'; }
  function connStyles() {
    return '<style>.path-row{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:9px;background:var(--surface-2);border:1px solid var(--rule);margin-bottom:8px;}' +
      '.path-copy{color:var(--accent);font-size:13px;flex-shrink:0;}input:focus{outline:none;border-color:var(--accent-soft);}</style>';
  }
})();
