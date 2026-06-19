/* ============================================================
   AgentRecall War Room — app shell: nav rail, hash router,
   theme toggle, topbar, shared helpers. Views register on AR.views.
============================================================ */
(function () {
  var AR = window.AR;
  AR.views = AR.views || {};

  /* ---------- helpers ---------- */
  var H = {
    esc: function (s) { return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); },
    t: function (en, zh) { return AR.lang === 'zh' ? zh : en; },
    pad: function (n) { return n < 10 ? '0' + n : '' + n; },
    parseTs: function (ts) { return new Date(ts.replace(' ', 'T')); },
    fmtFull: function (ts) {           // 2026-06-08 14:23:07
      var d = H.parseTs(ts);
      return d.getFullYear() + '-' + H.pad(d.getMonth() + 1) + '-' + H.pad(d.getDate()) +
        ' ' + H.pad(d.getHours()) + ':' + H.pad(d.getMinutes()) + ':' + H.pad(d.getSeconds());
    },
    fmtDate: function (ts) { var d = H.parseTs(ts); return d.getFullYear() + '-' + H.pad(d.getMonth() + 1) + '-' + H.pad(d.getDate()); },
    fmtTime: function (ts) { var d = H.parseTs(ts); return H.pad(d.getHours()) + ':' + H.pad(d.getMinutes()) + ':' + H.pad(d.getSeconds()); },
    rel: function (ts) {
      var diff = H.parseTs(AR.now) - H.parseTs(ts);
      var s = Math.max(0, Math.floor(diff / 1000));
      if (s < 60) return s + 's ago';
      var m = Math.floor(s / 60); if (m < 60) return m + 'm ago';
      var h = Math.floor(m / 60); if (h < 24) return h + 'h ago';
      var d = Math.floor(h / 24); return d + 'd ago';
    },
    daysSince: function (dateStr) {
      var base = H.parseTs(AR.now); base.setHours(0,0,0,0);
      var d = H.parseTs(dateStr); d.setHours(0,0,0,0);
      return Math.round((base - d) / 86400000);
    }
  };
  AR.H = H;

  /* ---------- tooltip ---------- */
  var _tt;
  AR.tip = {
    show: function (e, html) { _tt.innerHTML = html; _tt.classList.add('show'); AR.tip.move(e); },
    move: function (e) {
      var x = e.clientX + 14, y = e.clientY + 14;
      if (x + 290 > window.innerWidth) x = e.clientX - 294;
      if (y + 140 > window.innerHeight) y = e.clientY - 140;
      _tt.style.left = x + 'px'; _tt.style.top = y + 'px';
    },
    hide: function () { _tt.classList.remove('show'); }
  };

  /* ---------- language ---------- */
  AR.lang = 'en';
  function applyLang(l) {
    AR.lang = l;
    try { localStorage.setItem('ar-lang', l); } catch (e) {}
    var lbl = document.getElementById('lang-label');
    if (lbl) lbl.textContent = l === 'zh' ? '中文' : 'EN';
  }
  function initLang() {
    var saved = 'en';
    try { saved = localStorage.getItem('ar-lang') || 'en'; } catch (e) {}
    AR.lang = saved;
  }
  AR.toggleLang = function () {
    applyLang(AR.lang === 'zh' ? 'en' : 'zh');
    renderRail();
    navigate();
  };

  /* ---------- rail collapse ---------- */
  AR.toggleRail = function () {
    var app = document.getElementById('app');
    var collapsed = app.classList.toggle('rail-collapsed');
    try { localStorage.setItem('ar-rail-collapsed', collapsed ? '1' : '0'); } catch (e) {}
  };

  /* ---------- theme ---------- */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('ar-theme', t); } catch (e) {}
    var lbl = document.getElementById('theme-label');
    if (lbl) lbl.textContent = t === 'dark' ? 'Dark' : 'Light';
  }
  function initTheme() {
    var saved = 'light';
    try { saved = localStorage.getItem('ar-theme') || 'light'; } catch (e) {}
    applyTheme(saved);
  }
  AR.toggleTheme = function () {
    var cur = document.documentElement.getAttribute('data-theme');
    applyTheme(cur === 'dark' ? 'light' : 'dark');
    if (AR._onTheme) AR._onTheme();
  };

  /* ---------- nav definition ---------- */
  var NAV = [
    { group: 'Workspace', zh: '工作区', items: [
      { route: 'overview', label: 'Overview',    zh: '总览',   icon: 'grid' },
      { route: 'projects', label: 'Projects',    zh: '项目',   icon: 'folders', badgeKey: 'projects' },
      { route: 'activity', label: 'Activity',    zh: '活动',   icon: 'activity' },
      { route: 'dreams',   label: 'Dream Health',zh: '梦境',   icon: 'moon', alertKey: 'dreamFails' },
      { route: 'palace',   label: 'Palace Graph',zh: '宫殿图', icon: 'share' },
    ]},
    { group: 'Setup', zh: '设置', items: [
      { route: 'onboarding', label: 'Install', zh: '安装', icon: 'download' },
      { route: 'connect',    label: 'Connect', zh: '连接', icon: 'plug' },
    ]}
  ];

  var ICONS = {
    grid:    '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    folders: '<path d="M3 7a2 2 0 0 1 2-2h3l2 2h6a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    activity:'<path d="M3 12h4l2.5 7L14 4l2.5 8H21"/>',
    moon:    '<path d="M20 14.5A8 8 0 1 1 9.5 4 6.2 6.2 0 0 0 20 14.5z"/>',
    share:   '<circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.2 10.8 15.8 7.2M8.2 13.2l7.6 3.6"/>',
    download:'<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14"/>',
    plug:    '<path d="M9 3v6m6-6v6M6 9h12v3a6 6 0 0 1-12 0zM12 18v3"/>'
  };

  function renderRail() {
    var rail = document.getElementById('rail');
    var fails = AR.dreams.filter(function (d) { return d.status === 'fail'; }).length;
    var counts = { projects: AR.projects.length, dreamFails: fails };
    var html = '';
    html += '<a class="rail-brand" href="#/overview">' +
      '<div class="rail-logo">A</div>' +
      '<div class="rail-word"><b>AgentRecall</b><span>War Room</span></div></a>';
    NAV.forEach(function (g) {
      html += '<div class="rail-section">' + H.t(g.group, g.zh || g.group) + '</div>';
      g.items.forEach(function (it) {
        var badge = '';
        if (it.alertKey && counts[it.alertKey]) badge = '<span class="nav-badge alert">' + counts[it.alertKey] + '</span>';
        else if (it.badgeKey && counts[it.badgeKey]) badge = '<span class="nav-badge">' + counts[it.badgeKey] + '</span>';
        html += '<a class="nav-item" data-route="' + it.route + '" href="#/' + it.route + '">' +
          '<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">' + ICONS[it.icon] + '</svg>' +
          '<span>' + H.t(it.label, it.zh || it.label) + '</span>' + badge + '</a>';
      });
    });
    html += '<div class="rail-spacer"></div>';
    html += '<div class="rail-foot">' +
      '<button class="theme-toggle" onclick="AR.toggleLang()">' +
        '<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3.6 9h16.8M3.6 15h16.8M12 3a14.7 14.7 0 0 1 0 18M12 3a14.7 14.7 0 0 0 0 18"/></svg>' +
        '<span>' + H.t('Language', '语言') + '</span><span class="lang-badge" id="lang-label">' + (AR.lang === 'zh' ? '中文' : 'EN') + '</span></button>' +
      '<button class="theme-toggle" onclick="AR.toggleTheme()">' +
        '<svg class="nav-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>' +
        '<span>Theme</span><span class="theme-switch"></span></button>' +
      '</div>';
    rail.innerHTML = html;
  }

  function setActiveNav(route) {
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === route);
    });
  }

  /* ---------- topbar ---------- */
  function setTopbar(title, crumb) {
    document.getElementById('tb-title-h').textContent = title;
    document.getElementById('tb-crumb').textContent = crumb || '';
  }
  function tickStale() {
    // simulate liveness against the wall clock vs the data's "now"
    var diff = Date.now() - H.parseTs(AR.now).getTime();
    document.getElementById('tb-ago').textContent = H.rel(AR.now);
  }

  /* ---------- router ---------- */
  var ROUTES = {
    overview:  { title: 'Overview',      crumb: 'Workspace',  view: 'overview' },
    projects:  { title: 'Projects',      crumb: 'Workspace',  view: 'projects' },
    project:   { title: 'Project',       crumb: 'Projects',   view: 'project' },
    activity:  { title: 'Activity',      crumb: 'Workspace',  view: 'activity' },
    dreams:    { title: 'Dream Health',  crumb: 'Workspace',  view: 'dreams' },
    palace:    { title: 'Palace Graph',  crumb: 'Workspace',  view: 'palace' },
    onboarding:{ title: 'Install',       crumb: 'Setup',      view: 'onboarding' },
    connect:   { title: 'Connect',       crumb: 'Setup',      view: 'connect' },
  };

  function parseHash() {
    var h = (location.hash || '#/overview').replace(/^#\/?/, '');
    var parts = h.split('/');
    return { route: parts[0] || 'overview', param: parts[1] ? decodeURIComponent(parts[1]) : null };
  }

  AR._destroy = null;
  function navigate() {
    if (AR._destroy) { try { AR._destroy(); } catch (e) {} AR._destroy = null; }
    AR.tip.hide();
    var p = parseHash();
    var r = ROUTES[p.route] || ROUTES.overview;
    var viewFn = AR.views[r.view] || AR.views.overview;
    var container = document.getElementById('view');
    container.scrollTop = 0;
    container.innerHTML = '<div class="view-pad view-anim" id="view-inner"></div>';
    var inner = document.getElementById('view-inner');

    // project detail derives title from slug
    if (r.view === 'project') {
      var proj = AR.byslug(p.param);
      setTopbar(proj ? proj.slug : 'Project', 'Projects › War Room');
      setActiveNav('projects');
    } else {
      setTopbar(r.title, r.crumb);
      setActiveNav(p.route);
    }
    viewFn(inner, p.param);
  }

  window.addEventListener('hashchange', navigate);

  /* ---------- boot ---------- */
  document.addEventListener('DOMContentLoaded', function () {
    _tt = document.getElementById('tooltip');
    initLang();
    initTheme();
    renderRail();
    // rail collapse: restore saved state
    try {
      if (localStorage.getItem('ar-rail-collapsed') === '1') {
        document.getElementById('app').classList.add('rail-collapsed');
      }
    } catch (e) {}
    // wire hamburger
    var rToggle = document.getElementById('rail-toggle');
    if (rToggle) rToggle.addEventListener('click', AR.toggleRail);
    document.getElementById('tb-ts').textContent = H.fmtFull(AR.now) + ' · local';
    tickStale();
    setInterval(tickStale, 15000);
    document.getElementById('stale-refresh').addEventListener('click', function () { location.reload(); });
    if (!location.hash) location.hash = '#/overview';
    navigate();
  });
})();
