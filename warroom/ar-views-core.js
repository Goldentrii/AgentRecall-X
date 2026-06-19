/* ============================================================
   AgentRecall War Room — core views: Overview, Projects, Project
============================================================ */
(function () {
  var AR = window.AR, H = AR.H;

  function zoneMeta(z) {
    return ({
      blocked: { label: 'Needs You', cls: 'blocked' },
      active:  { label: 'Active',    cls: 'active' },
      stale:   { label: 'Stale',     cls: 'stale' }
    })[z];
  }

  /* ---------- shared: contribution calendar ---------- */
  AR.renderCalendar = function (mountEl, opts) {
    opts = opts || {};
    var cal = AR.calendar;            // oldest → newest
    var cols = [];                    // weeks
    var col = [];
    // pad start so first column aligns to Sunday
    var firstDow = cal[0].dow;
    for (var p = 0; p < firstDow; p++) col.push(null);
    cal.forEach(function (d) {
      col.push(d);
      if (d.dow === 6) { cols.push(col); col = []; }
    });
    if (col.length) cols.push(col);

    function bucket(c) {
      if (c === 0) return 0; if (c <= 3) return 1; if (c <= 9) return 2; if (c <= 19) return 3; return 4;
    }
    var cell = opts.cell || 13, gap = 3;
    var html = '<div class="cal-grid" style="display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,' + cell + 'px);gap:' + gap + 'px;">';
    cols.forEach(function (week) {
      for (var r = 0; r < 7; r++) {
        var d = week[r];
        if (!d) { html += '<div style="width:' + cell + 'px;height:' + cell + 'px;"></div>'; continue; }
        var b = bucket(d.count);
        html += '<div class="cal-cell" data-date="' + d.date + '" data-count="' + d.count + '" ' +
          'style="width:' + cell + 'px;height:' + cell + 'px;border-radius:3px;background:var(--heat-' + b + ');"></div>';
      }
    });
    html += '</div>';

    var legend = '<div style="display:flex;align-items:center;gap:6px;font-size:10px;color:var(--ink-faint);margin-top:10px;font-weight:700;">' +
      '<span>Less</span>' +
      [0,1,2,3,4].map(function (b) { return '<span style="width:11px;height:11px;border-radius:3px;background:var(--heat-' + b + ');display:inline-block;"></span>'; }).join('') +
      '<span>More</span><span style="margin-left:auto;color:var(--ink-faint);">color deepens after 10 & 20 saves/day</span></div>';

    mountEl.innerHTML = html + (opts.legend === false ? '' : legend);

    mountEl.querySelectorAll('.cal-cell').forEach(function (c) {
      c.addEventListener('mouseenter', function (e) {
        var n = +c.getAttribute('data-count');
        AR.tip.show(e, '<div class="tt-lbl">' + c.getAttribute('data-date') + '</div>' +
          '<div class="tt-row">' + (n === 0 ? 'no saves' : n + ' save' + (n > 1 ? 's' : '')) + '</div>');
      });
      c.addEventListener('mousemove', AR.tip.move);
      c.addEventListener('mouseleave', AR.tip.hide);
    });
  };

  /* ============================================================
     OVERVIEW
  ============================================================ */
  AR.views.overview = function (root) {
    var hour = H.parseTs(AR.now).getHours();
    var greet = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    var blocked = AR.projects.filter(function (p) { return p.zone === 'blocked'; });
    var active = AR.projects.filter(function (p) { return p.zone === 'active'; });
    var fails = AR.dreams.filter(function (d) { return d.status === 'fail'; }).length;
    var savesToday = AR.activity.length;

    var tiles = [
      { k: 'Active projects', v: active.length, sub: AR.projects.length + ' total', to: '#/projects' },
      { k: 'Saves today',     v: savesToday,    sub: 'across ' + new Set(AR.activity.map(function(a){return a.project;})).size + ' projects', to: '#/activity' },
      { k: 'Corrections heeded', v: AR.precision.aggregate_pct + '%', sub: '↑ ' + AR.precision.delta_pts + ' pts / 30 saves', to: '#/activity', soft: true },
      { k: 'Dream health', v: fails ? fails + ' fails' : 'healthy', sub: 'last 20 nights', to: '#/dreams', alert: fails > 0 },
    ];

    var html = '';
    html += '<div style="display:flex;align-items:flex-end;justify-content:space-between;gap:16px;margin-bottom:18px;flex-wrap:wrap;">' +
      '<div><h1 style="font-size:26px;color:var(--ink);">' + greet + '</h1>' +
      '<div style="font-size:13px;color:var(--ink-soft);margin-top:2px;">16 projects · 5 memory layers · everything local in <span class="mono">~/.agent-recall</span></div>' +
      '<div style="margin-top:10px;"><a href="#/onboarding" class="btn btn--primary" style="font-size:12px;">Set up in one click →</a></div></div>' +
      '<a href="#/connect" class="chip" style="background:var(--surface);border:1px solid var(--rule);color:var(--ink-soft);flex-shrink:0;"><span class="sdot sdot--active"></span>last save <span class="mono" style="color:var(--ink);">' + AR.stats.last_save + '</span></a>' +
      '</div>';

    // stat tiles
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:14px;">';
    tiles.forEach(function (t) {
      html += '<a href="' + t.to + '" class="panel" style="padding:14px 16px;gap:6px;' + (t.alert ? 'border-color:var(--amber-red);' : '') + '">' +
        '<div class="panel-title" style="border:none;padding:0;height:auto;">' + t.k + '</div>' +
        '<div class="display" style="font-size:30px;color:' + (t.alert ? 'var(--amber-red)' : t.soft ? 'var(--ink-soft)' : 'var(--ink)') + ';line-height:1;">' + t.v + '</div>' +
        '<div style="font-size:11px;color:var(--ink-faint);font-weight:700;">' + t.sub + '</div></a>';
    });
    html += '</div>';

    // main grid
    html += '<div style="display:grid;grid-template-columns:1.4fr 1fr;gap:12px;align-items:start;">';

    // Needs You
    html += '<div class="panel" style="grid-row:span 2;">' +
      '<div class="panel-hdr"><span class="panel-title">⛔ Needs You</span><a class="panel-sub" href="#/projects">all projects →</a></div>' +
      '<div class="panel-body" style="overflow-y:auto;padding:8px;">';
    if (!blocked.length) html += '<div class="empty">Nothing blocked. Nice.</div>';
    blocked.forEach(function (p) {
      html += '<a href="#/project/' + p.slug + '" class="ov-block">' +
        '<div style="display:flex;align-items:center;gap:8px;margin-bottom:4px;"><span class="sdot sdot--blocked sdot--pulse"></span>' +
        '<span class="mono" style="font-weight:700;font-size:13px;color:var(--ink);white-space:nowrap;">' + p.slug + '</span>' +
        '<span style="margin-left:auto;font-size:10px;color:var(--ink-faint);" class="mono">' + H.rel(p.last) + '</span></div>' +
        '<div style="font-size:12px;color:var(--amber-red);font-weight:700;line-height:1.4;padding-left:16px;">' + H.esc(p.blocker || '') + '</div>' +
        '<div style="font-size:11px;color:var(--ink-faint);padding-left:16px;margin-top:3px;">' + p.rooms + ' rooms · ' + p.cards + ' cards</div></a>';
    });
    html += '</div></div>';

    // Recent activity
    html += '<div class="panel">' +
      '<div class="panel-hdr"><span class="panel-title">Recent Activity</span><a class="panel-sub" href="#/activity">timeline →</a></div>' +
      '<div class="panel-body" style="overflow-y:auto;max-height:300px;">' + activityRows(AR.activity.slice(0, 9)) + '</div></div>';

    // Activity calendar mini
    html += '<div class="panel">' +
      '<div class="panel-hdr"><span class="panel-title">Activity</span><a class="panel-sub" href="#/activity">18 weeks →</a></div>' +
      '<div class="panel-body" style="padding:14px;"><div id="ov-cal"></div></div></div>';

    html += '</div>'; // grid

    root.innerHTML = html + ovStyles();
    AR.renderCalendar(document.getElementById('ov-cal'), { cell: 11 });
  };

  function ovStyles() {
    return '<style>' +
      '.ov-block{display:block;padding:10px 12px;border-radius:10px;margin-bottom:4px;transition:background 120ms;}' +
      '.ov-block:hover{background:var(--surface-2);}' +
      '</style>';
  }

  var ACT_ICON = {
    session_end: { i: '✓', c: 'var(--ok)' }, correction: { i: '⚠', c: 'var(--warn)' },
    phase_open: { i: '▶', c: '#5B8DB8' }, phase_close: { i: '■', c: '#5B8DB8' },
    skill_write: { i: '✦', c: '#8B5CB8' }, insight: { i: '+', c: '#3A9B8A' },
    recurrence: { i: '↻', c: 'var(--accent)' }
  };
  function activityRows(list, opts) {
    opts = opts || {};
    return list.map(function (e) {
      var m = ACT_ICON[e.kind] || { i: '·', c: 'var(--ink-faint)' };
      var cls = 'act-row' + (e.kind === 'recurrence' ? ' act-row--recurrence' : '');
      var ts = opts.full ? H.fmtFull(e.ts) : H.fmtTime(e.ts);
      return '<div class="' + cls + '">' +
        '<span class="act-ts">' + ts + '</span>' +
        '<span class="act-ico" style="color:' + m.c + '">' + m.i + '</span>' +
        '<div class="act-main"><div class="act-desc">' + H.esc(e.desc) + '</div>' +
        '<div class="act-proj">' + e.project + '</div></div></div>';
    }).join('');
  }
  AR.activityRows = activityRows;

  /* ============================================================
     PROJECTS  (dropdown + square cards)
  ============================================================ */
  AR.views.projects = function (root, param) {
    var filter = AR._projFilter || 'all';
    var html = '';
    html += '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;">' +
      '<h1 style="font-size:22px;color:var(--ink);">Projects</h1>' +
      '<div class="dropdown" id="proj-dd"><button class="dd-trigger" id="proj-dd-btn">' +
        '<span id="proj-dd-label">' + ddLabel(filter) + '</span>' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg></button>' +
        '<div class="dd-menu" id="proj-dd-menu">' +
          ddOpt('all', 'All projects', filter) +
          ddOpt('blocked', 'Needs You', filter) +
          ddOpt('active', 'Active', filter) +
          ddOpt('stale', 'Stale', filter) +
        '</div></div>' +
      '<div style="margin-left:auto;font-size:12px;color:var(--ink-faint);font-weight:700;">Click a card to open its war room</div>' +
      '</div>';

    var list = AR.projects.filter(function (p) { return filter === 'all' || p.zone === filter; });
    html += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(232px,1fr));gap:14px;">';
    list.forEach(function (p) { html += projectCard(p); });
    html += '</div>';

    root.innerHTML = html + projStyles();
    wireDropdown();
  };

  function ddLabel(f) { return ({ all: 'All projects', blocked: 'Needs You', active: 'Active', stale: 'Stale' })[f]; }
  function ddOpt(val, label, cur) {
    return '<button class="dd-opt' + (val === cur ? ' sel' : '') + '" data-val="' + val + '">' +
      (val === 'all' ? '' : '<span class="sdot sdot--' + (val === 'blocked' ? 'blocked' : val === 'active' ? 'active' : 'stale') + '"></span>') +
      label + '</button>';
  }
  function wireDropdown() {
    var btn = document.getElementById('proj-dd-btn'), menu = document.getElementById('proj-dd-menu');
    if (!btn) return;
    btn.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.toggle('open'); });
    document.addEventListener('click', function () { menu.classList.remove('open'); });
    menu.querySelectorAll('.dd-opt').forEach(function (o) {
      o.addEventListener('click', function () { AR._projFilter = o.getAttribute('data-val'); AR.views.projects(document.getElementById('view-inner')); });
    });
  }

  function projectCard(p) {
    var zm = zoneMeta(p.zone);
    return '<a href="#/project/' + p.slug + '" class="pcard">' +
      '<div class="pcard-top">' +
        '<span class="chip" style="background:var(--surface-2);"><span class="sdot sdot--' + zm.cls + (p.zone === 'blocked' ? ' sdot--pulse' : '') + '"></span>' + zm.label + '</span>' +
        '<span class="mono" style="font-size:10px;color:var(--ink-faint);">' + H.rel(p.last) + '</span>' +
      '</div>' +
      '<div class="pcard-name mono">' + p.slug + '</div>' +
      '<div class="pcard-why">' + H.esc(p.why || '') + '</div>' +
      '<div class="pcard-stats">' +
        statMini(p.rooms, 'rooms') + statMini(p.cards, 'cards') + statMini(p.sessions, 'sessions') +
      '</div>' +
      '<div class="pcard-foot">' + (p.blocker
        ? '<span style="color:var(--amber-red);font-weight:700;">⛔ ' + H.esc(trunc(p.blocker, 46)) + '</span>'
        : p.next ? '<span style="color:var(--ink-soft);">→ ' + H.esc(trunc(p.next, 48)) + '</span>'
        : '<span style="color:var(--ink-faint);">' + (p.note ? H.esc(trunc(p.note, 48)) : 'no pending action') + '</span>') +
      '</div></a>';
  }
  function statMini(v, k) { return '<div><div class="display" style="font-size:18px;color:var(--ink);line-height:1;">' + v + '</div><div style="font-size:9px;color:var(--ink-faint);font-weight:800;text-transform:uppercase;letter-spacing:.08em;">' + k + '</div></div>'; }
  function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  function projStyles() {
    return '<style>' +
      '.pcard{display:flex;flex-direction:column;gap:9px;padding:15px;border-radius:14px;background:var(--surface);border:1px solid var(--rule);min-height:200px;transition:transform 120ms,border-color 120ms,box-shadow 120ms;}' +
      '.pcard:hover{transform:translateY(-2px);border-color:var(--accent-soft);box-shadow:var(--shadow-lift);}' +
      '.pcard-top{display:flex;align-items:center;justify-content:space-between;}' +
      '.pcard-name{font-size:15px;font-weight:700;color:var(--ink);}' +
      '.pcard-why{font-size:12px;color:var(--ink-soft);line-height:1.45;flex:1;}' +
      '.pcard-stats{display:flex;gap:18px;padding-top:9px;border-top:1px solid var(--rule-soft);}' +
      '.pcard-foot{font-size:11px;line-height:1.4;}' +
      '</style>';
  }

  /* ============================================================
     PROJECT WAR ROOM (detail)
  ============================================================ */
  AR.views.project = function (root, slug) {
    var p = AR.byslug(slug);
    if (!p) { root.innerHTML = '<div class="empty">Unknown project. <a href="#/projects" style="color:var(--accent);">Back to projects</a></div>'; return; }
    var rooms = AR.rooms[slug] || synthRooms(p);
    var cards = AR.cards[slug] || [];
    var miles = AR.milestones[slug] || [];
    var zm = zoneMeta(p.zone);

    var html = '';
    // breadcrumb + header
    html += '<a href="#/projects" style="font-size:12px;color:var(--accent);font-weight:700;">← Projects</a>';
    html += '<div style="display:flex;align-items:flex-start;gap:14px;margin:10px 0 18px;flex-wrap:wrap;">' +
      '<div style="flex:1;min-width:260px;">' +
        '<div style="display:flex;align-items:center;gap:10px;"><h1 class="mono" style="font-size:24px;color:var(--ink);">' + p.slug + '</h1>' +
          '<span class="chip" style="background:var(--surface-2);"><span class="sdot sdot--' + zm.cls + (p.zone === 'blocked' ? ' sdot--pulse' : '') + '"></span>' + zm.label + '</span></div>' +
        '<div style="font-size:13px;color:var(--ink-soft);margin-top:5px;line-height:1.5;">' + H.esc(p.why || '') + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:22px;">' +
        statMini(p.rooms, 'rooms') + statMini(p.cards, 'cards') + statMini(p.sessions, 'sessions') + statMini(p.rules, 'rules') +
      '</div></div>';

    // action banner
    if (p.blocker) html += banner('blocked', '⛔ Blocked', p.blocker);
    else if (p.next) html += banner('next', '→ Next', p.next);

    // two columns
    html += '<div style="display:grid;grid-template-columns:1.5fr 1fr;gap:12px;align-items:start;margin-top:14px;">';

    // LEFT: milestones
    html += '<div class="panel"><div class="panel-hdr"><span class="panel-title">Milestones</span>' +
      '<span class="panel-sub">what changed · errors vs improvements</span></div>' +
      '<div class="panel-body" style="overflow-y:auto;padding:6px 0;">';
    if (!miles.length) html += '<div class="empty">No milestones recorded yet for this project.</div>';
    miles.forEach(function (m) { html += milestoneRow(m); });
    html += '</div></div>';

    // RIGHT column stack
    html += '<div style="display:flex;flex-direction:column;gap:12px;">';

    // Agent prompt
    html += '<div class="panel panel--dark"><div class="panel-hdr"><span class="panel-title">Agent Prompt</span>' +
      '<button class="panel-sub" id="copy-prompt" style="cursor:pointer;">⧉ copy</button></div>' +
      '<div class="panel-body" style="padding:14px;"><div class="mono" id="prompt-text" style="font-size:11px;line-height:1.6;color:var(--canvas-ink);white-space:pre-wrap;">' +
      (p.prompt ? H.esc(p.prompt) : 'No custom preamble — using the global AgentRecall prompt.') + '</div></div></div>';

    // What the agent learned
    html += '<div class="panel"><div class="panel-hdr"><span class="panel-title">What the agent learned</span><span class="panel-sub">' + (p.learned ? p.learned.length : 0) + ' insights</span></div>' +
      '<div class="panel-body" style="padding:6px;">';
    if (p.learned && p.learned.length) p.learned.forEach(function (l) {
      html += '<div style="display:flex;gap:8px;padding:8px 10px;font-size:12px;color:var(--ink);line-height:1.45;"><span style="color:#3A9B8A;font-weight:800;">+</span><span>' + H.esc(l) + '</span></div>';
    }); else html += '<div class="empty">Nothing promoted to insights yet.</div>';
    html += '</div></div>';

    html += '</div></div>'; // right col + grid

    // Rooms grid
    html += '<div class="panel" style="margin-top:12px;"><div class="panel-hdr"><span class="panel-title">Memory Rooms</span>' +
      '<a class="panel-sub" href="#/palace">open in palace →</a></div>' +
      '<div class="panel-body" style="padding:12px;"><div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px;">';
    rooms.forEach(function (r) {
      var days = H.daysSince(r.updated);
      var heat = days <= 1 ? 'var(--accent)' : days <= 3 ? 'var(--accent-soft)' : days <= 7 ? 'var(--ink-faint)' : 'var(--rule)';
      html += '<div class="room-card" data-room="' + r.id + '">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;"><span style="font-weight:700;font-size:13px;color:var(--ink);">' + r.id + '</span>' +
        '<span style="width:9px;height:9px;border-radius:50%;background:' + heat + ';"></span></div>' +
        '<div style="display:flex;align-items:baseline;gap:6px;margin-top:6px;"><span class="display" style="font-size:22px;color:var(--ink);line-height:1;">' + r.cards + '</span><span style="font-size:10px;color:var(--ink-faint);font-weight:700;">cards</span></div>' +
        '<div style="height:4px;border-radius:3px;background:var(--surface-3);margin-top:8px;overflow:hidden;"><div style="height:100%;width:' + Math.round(r.salience * 100) + '%;background:var(--accent-soft);"></div></div>' +
        '<div style="font-size:9px;color:var(--ink-faint);font-weight:700;margin-top:5px;font-family:\'JetBrains Mono\',monospace;">sal ' + Math.round(r.salience * 100) + '% · ' + H.rel(r.updated) + '</div></div>';
    });
    html += '</div></div></div>';

    // Memory cards sample
    html += '<div class="panel" style="margin-top:12px;"><div class="panel-hdr"><span class="panel-title">Memory Cards</span><span class="panel-sub mono">~/.agent-recall/' + p.slug + '/</span></div>' +
      '<div class="panel-body" style="padding:12px;display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;">';
    if (cards.length) cards.forEach(function (c) {
      html += '<div class="mem-card"><div style="display:flex;align-items:center;gap:7px;margin-bottom:6px;">' +
        '<span class="tag">' + c.room + '</span><span style="margin-left:auto;font-size:9px;color:var(--ink-faint);" class="mono">' + H.fmtDate(c.created) + '</span></div>' +
        '<div style="font-weight:700;font-size:13px;color:var(--ink);margin-bottom:4px;">' + H.esc(c.title) + '</div>' +
        '<div style="font-size:12px;color:var(--ink-soft);line-height:1.5;">' + H.esc(c.body) + '</div></div>';
    });
    else html += '<div class="empty" style="grid-column:1/-1;">' + p.cards + ' cards stored. Open the markdown in <span class="mono">~/.agent-recall/' + p.slug + '/</span> to read them.</div>';
    html += '</div></div>';

    root.innerHTML = html + projDetailStyles();

    var cp = document.getElementById('copy-prompt');
    if (cp) cp.addEventListener('click', function () {
      var t = document.getElementById('prompt-text').textContent;
      navigator.clipboard && navigator.clipboard.writeText(t);
      cp.textContent = '✓ copied'; setTimeout(function () { cp.textContent = '⧉ copy'; }, 1400);
    });
  };

  function banner(kind, label, text) {
    var c = kind === 'blocked' ? 'var(--amber-red)' : 'var(--accent)';
    var bg = kind === 'blocked' ? 'var(--amber-dim)' : 'var(--accent-dim)';
    return '<div style="display:flex;align-items:center;gap:10px;padding:11px 15px;border-radius:11px;background:' + bg + ';border:1px solid ' + c + ';">' +
      '<span style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.1em;color:' + c + ';white-space:nowrap;">' + label + '</span>' +
      '<span style="font-size:13px;color:var(--ink);font-weight:600;">' + H.esc(text) + '</span></div>';
  }

  var MILE_META = {
    error:       { i: '✕', c: 'var(--bad)',  lbl: 'Error' },
    improvement: { i: '↗', c: 'var(--ok)',   lbl: 'Improvement' },
    change:      { i: '◆', c: 'var(--accent)', lbl: 'Change' }
  };
  function milestoneRow(m) {
    var mm = MILE_META[m.kind] || MILE_META.change;
    var actor = m.actor === 'you' ? 'you' : 'agent';
    return '<div class="mile-row">' +
      '<div class="mile-rail"><span class="mile-dot" style="background:' + mm.c + ';">' + mm.i + '</span></div>' +
      '<div style="flex:1;min-width:0;padding-bottom:14px;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span style="font-weight:700;font-size:13px;color:var(--ink);">' + H.esc(m.title) + '</span>' +
          '<span class="tag" style="color:' + mm.c + ';background:transparent;border:1px solid ' + mm.c + ';">' + mm.lbl + '</span>' +
          '<span class="tag" style="background:' + (actor === 'you' ? 'var(--accent-dim)' : 'var(--surface-2)') + ';color:' + (actor === 'you' ? 'var(--accent)' : 'var(--ink-soft)') + ';">' + actor + '</span>' +
          '<span style="margin-left:auto;font-size:10px;color:var(--ink-faint);" class="mono">' + H.fmtFull(m.ts) + '</span></div>' +
        '<div style="font-size:12px;color:var(--ink-soft);line-height:1.5;margin-top:4px;">' + H.esc(m.detail) + '</div>' +
      '</div></div>';
  }

  function synthRooms(p) {
    var names = ['Architecture', 'Goals', 'Knowledge', 'Decisions', 'Blockers', 'Alignment', 'Predictions', 'Identity', 'Patterns'];
    var out = [];
    for (var i = 0; i < p.rooms; i++) out.push({ id: names[i] || ('Room ' + (i + 1)), salience: 0.4 + (p.rooms - i) / (p.rooms * 1.6), cards: Math.max(1, Math.round(p.cards / p.rooms) + (i % 2)), updated: p.last });
    return out;
  }

  function projDetailStyles() {
    return '<style>' +
      '.mile-row{display:flex;gap:12px;padding:4px 16px 0;}' +
      '.mile-rail{display:flex;flex-direction:column;align-items:center;flex-shrink:0;}' +
      '.mile-dot{width:22px;height:22px;border-radius:50%;color:#fff;font-size:11px;font-weight:800;display:flex;align-items:center;justify-content:center;}' +
      '.mile-row:not(:last-child) .mile-rail::after{content:"";flex:1;width:2px;background:var(--rule);margin-top:2px;}' +
      '.room-card{padding:12px;border-radius:11px;background:var(--surface-2);border:1px solid var(--rule);}' +
      '.mem-card{padding:13px;border-radius:11px;background:var(--surface-2);border:1px solid var(--rule);}' +
      '</style>';
  }
})();
