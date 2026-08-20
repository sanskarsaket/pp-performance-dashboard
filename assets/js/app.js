/* app.js — state, filters, uploads, view rendering */

(function () {
  const PP = window.PP;
  const A = PP.an;
  const C = PP.charts;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  /* ---------------- state ---------------- */

  const S = {
    leads: [],
    spend: [],
    view: 'overview',
    filters: { preset: 'overlap', from: null, to: null, cities: null, projects: null, platforms: null },
    groupBy: 'project',
    cplThreshold: 3000,
    minLeads: 1,
    granularity: 'day',
    metrics: ['spend', 'leads'],
    dataTab: 'daily',
    staged: []   // files waiting in the upload modal
  };
  window.PPSTATE = S;

  const VIEW_META = {
    overview: ['Overview', 'Blended performance across every platform and project in the window.'],
    platforms: ['Platforms', 'Google versus Meta — budget, pace and efficiency.'],
    campaigns: ['Campaigns & Projects', 'Where the money goes and what it returns.'],
    trends: ['Trends', 'Daily and weekly movement with period comparisons.'],
    radar: ['Pattern Radar', 'Anomalies, drift, correlation and weekday behaviour.'],
    quality: ['Lead Quality', 'Funnel, status mix, response discipline and team output.'],
    data: ['Data Tables', 'The underlying rows, searchable and exportable.']
  };

  /* ---------------- toast ---------------- */

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
  }

  /* ---------------- upload flow ---------------- */

  function stageFiles(fileList) {
    const files = [...fileList];
    if (!files.length) return;
    Promise.all(files.map(async f => {
      const text = await PP.readFile(f);
      const kind = f.name.toLowerCase().endsWith('.json') ? 'session' : PP.detectKind(text);
      let platform = 'Google';
      const n = f.name.toLowerCase();
      if (/meta|fb|facebook|insta/.test(n)) platform = 'Meta';
      else if (/google|gads|adwords|search/.test(n)) platform = 'Google';
      else platform = S.staged.filter(s => s.kind === 'spend').length === 0 ? 'Google' : 'Meta';
      return { name: f.name, size: f.size, text, kind, platform };
    })).then(items => {
      S.staged.push(...items);
      renderFileList();
    }).catch(e => toast(e.message));
  }

  function renderFileList() {
    const wrap = $('#fileList');
    wrap.innerHTML = '';
    S.staged.forEach((f, i) => {
      const row = document.createElement('div');
      row.className = 'frow';
      const label = f.kind === 'leads' ? 'CRM lead dump' : f.kind === 'spend' ? 'Day-wise spend' : f.kind === 'session' ? 'Saved session' : 'Unrecognised';
      row.innerHTML = `<div>
          <div class="fname">${esc(f.name)}</div>
          <div class="fmeta">${label} · ${(f.size / 1024).toFixed(0)} KB</div>
        </div>`;
      if (f.kind === 'spend') {
        const sel = document.createElement('select');
        ['Google', 'Meta', 'Other'].forEach(p => {
          const o = document.createElement('option');
          o.value = p; o.textContent = p + ' Ads';
          if (p === f.platform) o.selected = true;
          sel.appendChild(o);
        });
        sel.onchange = () => { f.platform = sel.value; };
        row.appendChild(sel);
      }
      const rm = document.createElement('button');
      rm.className = 'rm'; rm.innerHTML = '×'; rm.title = 'Remove';
      rm.onclick = () => { S.staged.splice(i, 1); renderFileList(); };
      if (f.kind !== 'spend') row.appendChild(Object.assign(document.createElement('span'), { style: 'margin-left:auto' }));
      row.appendChild(rm);
      wrap.appendChild(row);
    });
  }

  function applyStaged() {
    if (!S.staged.length) { toast('No files staged'); return; }
    let addedLeads = 0, addedSpend = 0;
    S.staged.forEach(f => {
      try {
        if (f.kind === 'leads') {
          const rows = PP.parseLeads(f.text, f.name);
          addedLeads += mergeLeads(rows);
        } else if (f.kind === 'spend') {
          const rows = PP.parseSpend(f.text, f.platform, f.name);
          addedSpend += mergeSpend(rows);
        } else if (f.kind === 'session') {
          const j = PP.parseSession(f.text);
          addedLeads += mergeLeads(j.leads);
          addedSpend += mergeSpend(j.spend);
        }
      } catch (e) { toast(`${f.name}: ${e.message}`); }
    });
    S.staged = [];
    renderFileList();
    closeModal();
    rebuildFilters();
    render();
    toast(`Loaded ${A.n(addedLeads)} leads and ${A.n(addedSpend)} spend rows`);
  }

  function mergeLeads(rows) {
    const seen = new Set(S.leads.map(l => l.id));
    let added = 0;
    rows.forEach(r => { if (!seen.has(r.id)) { S.leads.push(r); seen.add(r.id); added++; } });
    S.leads.sort((a, b) => (a.createdMs || 0) - (b.createdMs || 0));
    return added;
  }

  function mergeSpend(rows) {
    const key = r => `${r.date}|${r.platform}|${r.account}|${r.campaign || ''}`;
    const map = new Map(S.spend.map(r => [key(r), r]));
    let added = 0;
    rows.forEach(r => { const k = key(r); if (!map.has(k)) added++; map.set(k, r); }); // latest file wins
    S.spend = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    return added;
  }

  function openModal() { $('#uploadModal').hidden = false; }
  function closeModal() { $('#uploadModal').hidden = true; }

  /* ---------------- auto-load from repo ---------------- */

  async function autoLoad() {
    try {
      const res = await fetch('data/manifest.json', { cache: 'no-store' });
      if (!res.ok) return false;
      const man = await res.json();
      const jobs = (man.files || []).map(async f => {
        const r = await fetch('data/' + f.path, { cache: 'no-store' });
        if (!r.ok) return;
        const buf = await r.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let enc = 'utf-8';
        if (bytes[0] === 0xff && bytes[1] === 0xfe) enc = 'utf-16le';
        else if (bytes[0] === 0xfe && bytes[1] === 0xff) enc = 'utf-16be';
        const text = new TextDecoder(enc).decode(bytes).replace(/^\uFEFF/, '');
        const kind = f.kind || PP.detectKind(text);
        if (kind === 'leads') mergeLeads(PP.parseLeads(text, f.path));
        else if (kind === 'spend') mergeSpend(PP.parseSpend(text, f.platform || 'Google', f.path));
      });
      await Promise.all(jobs);
      return S.leads.length > 0 || S.spend.length > 0;
    } catch (e) { return false; }
  }

  /* ---------------- filters ---------------- */

  function dataBounds() {
    const ld = S.leads.map(l => l.date), sd = S.spend.map(s => s.date);
    const all = [...ld, ...sd].sort();
    return {
      leadFrom: ld.length ? ld.slice().sort()[0] : null,
      leadTo: ld.length ? ld.slice().sort().slice(-1)[0] : null,
      spendFrom: sd.length ? sd.slice().sort()[0] : null,
      spendTo: sd.length ? sd.slice().sort().slice(-1)[0] : null,
      from: all[0] || null,
      to: all[all.length - 1] || null
    };
  }

  function resolveRange() {
    const b = dataBounds();
    const p = S.filters.preset;
    if (p === 'custom' && S.filters.from && S.filters.to) return { from: S.filters.from, to: S.filters.to };
    if (p === 'all') return { from: b.from, to: b.to };
    if (p === 'overlap') {
      if (b.leadFrom && b.spendFrom) {
        const from = b.leadFrom > b.spendFrom ? b.leadFrom : b.spendFrom;
        const to = b.leadTo < b.spendTo ? b.leadTo : b.spendTo;
        if (from <= to) return { from, to };
      }
      return { from: b.from, to: b.to };
    }
    if (p === 'mtd') {
      const to = b.to;
      return { from: to ? to.slice(0, 8) + '01' : null, to };
    }
    const days = parseInt(p, 10);
    if (isFinite(days) && b.to) return { from: A.addDays(b.to, -(days - 1)), to: b.to };
    return { from: b.from, to: b.to };
  }

  function filteredLeads(range) {
    const f = S.filters;
    return S.leads.filter(l =>
      l.date >= range.from && l.date <= range.to &&
      (!f.cities || f.cities.has(l.city)) &&
      (!f.projects || f.projects.has(l.project)) &&
      (!f.platforms || f.platforms.has(l.platform))
    );
  }

  function filteredSpend(range) {
    const f = S.filters;
    return S.spend.filter(s =>
      s.date >= range.from && s.date <= range.to &&
      (!f.platforms || f.platforms.has(s.platform))
    );
  }

  /* multiselect control */
  function multiselect(wrap, label, options, selectedSet, onChange) {
    wrap.innerHTML = '';
    const lab = document.createElement('label'); lab.textContent = label;
    const btn = document.createElement('button'); btn.className = 'msbtn';
    const pop = document.createElement('div'); pop.className = 'mspop';
    const tools = document.createElement('div'); tools.className = 'mstools';
    const bAll = document.createElement('button'); bAll.textContent = 'Select all';
    const bNone = document.createElement('button'); bNone.textContent = 'Clear';
    tools.append(bAll, bNone);
    const list = document.createElement('div'); list.className = 'msopts';

    const sel = selectedSet ? new Set(selectedSet) : new Set(options.map(o => o.value));

    function label_() {
      if (sel.size === 0 || sel.size === options.length) return `All ${label.toLowerCase()}`;
      if (sel.size === 1) return [...sel][0];
      return `${sel.size} selected`;
    }
    function sync() {
      btn.textContent = label_();
      onChange(sel.size === options.length || sel.size === 0 ? null : new Set(sel));
    }
    options.forEach(o => {
      const row = document.createElement('label'); row.className = 'msopt';
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = sel.has(o.value);
      cb.onchange = () => { cb.checked ? sel.add(o.value) : sel.delete(o.value); sync(); };
      const sp = document.createElement('span'); sp.textContent = o.value;
      const cnt = document.createElement('span'); cnt.className = 'cnt'; cnt.textContent = A.n(o.count);
      row.append(cb, sp, cnt);
      list.appendChild(row);
    });
    bAll.onclick = () => { options.forEach(o => sel.add(o.value)); list.querySelectorAll('input').forEach(i => (i.checked = true)); sync(); };
    bNone.onclick = () => { sel.clear(); list.querySelectorAll('input').forEach(i => (i.checked = false)); sync(); };
    btn.onclick = e => {
      e.stopPropagation();
      const open = pop.classList.contains('open');
      $$('.mspop').forEach(p => p.classList.remove('open'));
      if (!open) pop.classList.add('open');
    };
    pop.onclick = e => e.stopPropagation();
    pop.append(tools, list);
    wrap.append(lab, btn, pop);
    btn.textContent = label_();
  }

  function counts(arr, keyFn) {
    const m = new Map();
    arr.forEach(x => { const k = keyFn(x) || 'Unknown'; m.set(k, (m.get(k) || 0) + 1); });
    return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count }));
  }

  function rebuildFilters() {
    multiselect($('#cityWrap'), 'Cities', counts(S.leads, l => l.city), S.filters.cities, v => { S.filters.cities = v; render(); });
    multiselect($('#projWrap'), 'Projects', counts(S.leads, l => l.project), S.filters.projects, v => { S.filters.projects = v; render(); });
    const plats = ['Google', 'Meta', 'Other'].map(p => ({
      value: p,
      count: S.leads.filter(l => l.platform === p).length
    }));
    multiselect($('#platWrap'), 'Platforms', plats, S.filters.platforms, v => { S.filters.platforms = v; render(); });
  }

  /* ---------------- table helper ---------------- */

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* cols: [{key,label,num,fmt,html,width,sortVal}] */
  function renderTable(mount, cols, rows, opts) {
    opts = opts || {};
    const el = typeof mount === 'string' ? $(mount) : mount;
    el.innerHTML = '';
    if (!rows.length) { el.innerHTML = '<div class="nodata">No rows for the current filter.</div>'; return; }

    const state = { sort: opts.sort || null, dir: opts.dir || 'desc', q: '', page: 0, size: opts.pageSize || 0 };
    const wrap = document.createElement('div'); wrap.className = 'tblwrap';

    const tools = document.createElement('div'); tools.className = 'tbltools';
    const search = document.createElement('input');
    search.type = 'search'; search.placeholder = opts.searchPlaceholder || 'Search…';
    const spacer = document.createElement('span'); spacer.className = 'spacer';
    const dl = document.createElement('button'); dl.className = 'btn btn-ghost btn-sm'; dl.textContent = 'Download CSV';
    tools.append(search, spacer, dl);

    const scroll = document.createElement('div'); scroll.className = 'tblscroll';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const tbody = document.createElement('tbody');
    table.append(thead, tbody);
    scroll.appendChild(table);

    const pager = document.createElement('div'); pager.className = 'pager';

    function view() {
      let out = rows;
      if (state.q) {
        const q = state.q.toLowerCase();
        out = out.filter(r => cols.some(c => String(r[c.key] === null || r[c.key] === undefined ? '' : r[c.key]).toLowerCase().includes(q)));
      }
      if (state.sort) {
        const c = cols.find(x => x.key === state.sort);
        const sv = r => (c.sortVal ? c.sortVal(r) : r[c.key]);
        out = out.slice().sort((a, b) => {
          const x = sv(a), y = sv(b);
          const nx = x === null || x === undefined, ny = y === null || y === undefined;
          if (nx && ny) return 0; if (nx) return 1; if (ny) return -1;
          const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
          return state.dir === 'asc' ? r : -r;
        });
      }
      return out;
    }

    function draw() {
      thead.innerHTML = '';
      const tr = document.createElement('tr');
      cols.forEach(c => {
        const th = document.createElement('th');
        th.textContent = c.label;
        if (c.num) th.classList.add('n');
        if (c.sortable === false) th.classList.add('no-sort');
        else {
          if (state.sort === c.key) {
            const s = document.createElement('span'); s.className = 'arw'; s.textContent = state.dir === 'asc' ? '▲' : '▼';
            th.appendChild(s);
          }
          th.onclick = () => {
            if (state.sort === c.key) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
            else { state.sort = c.key; state.dir = c.num ? 'desc' : 'asc'; }
            draw();
          };
        }
        tr.appendChild(th);
      });
      thead.appendChild(tr);

      const all = view();
      const pages = state.size ? Math.max(1, Math.ceil(all.length / state.size)) : 1;
      if (state.page >= pages) state.page = pages - 1;
      const slice = state.size ? all.slice(state.page * state.size, (state.page + 1) * state.size) : all;

      tbody.innerHTML = '';
      slice.forEach(r => {
        const trr = document.createElement('tr');
        cols.forEach(c => {
          const td = document.createElement('td');
          if (c.num) td.classList.add('n');
          if (c.html) td.innerHTML = c.html(r);
          else td.textContent = c.fmt ? c.fmt(r[c.key], r) : (r[c.key] === null || r[c.key] === undefined ? '—' : r[c.key]);
          trr.appendChild(td);
        });
        tbody.appendChild(trr);
      });

      pager.innerHTML = '';
      const info = document.createElement('span');
      info.className = 'muted';
      info.textContent = state.size
        ? `${A.n(all.length)} rows · page ${state.page + 1} of ${pages}`
        : `${A.n(all.length)} rows`;
      pager.appendChild(info);
      if (state.size && pages > 1) {
        const prev = document.createElement('button'); prev.textContent = 'Previous'; prev.disabled = state.page === 0;
        const next = document.createElement('button'); next.textContent = 'Next'; next.disabled = state.page >= pages - 1;
        prev.onclick = () => { state.page--; draw(); };
        next.onclick = () => { state.page++; draw(); };
        pager.append(prev, next);
      }
    }

    search.oninput = () => { state.q = search.value.trim(); state.page = 0; draw(); };
    dl.onclick = () => {
      const data = view();
      const head = cols.map(c => c.label).join(',');
      const body = data.map(r => cols.map(c => {
        const v = c.csv ? c.csv(r) : (c.fmt ? c.fmt(r[c.key], r) : r[c.key]);
        const s = String(v === null || v === undefined ? '' : v).replace(/"/g, '""');
        return /[",\n]/.test(s) ? `"${s}"` : s;
      }).join(',')).join('\n');
      downloadFile((opts.fileName || 'export') + '.csv', head + '\n' + body, 'text/csv');
    };

    wrap.append(tools, scroll, pager);
    el.appendChild(wrap);
    draw();
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type: type || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ---------------- KPI helper ---------------- */

  function kpi(label, value, sub, accent) {
    return `<div class="kpi" style="--accent:${accent || '#E4E9F2'}">
      <div class="k-label">${esc(label)}</div>
      <div class="k-val">${value}</div>
      <div class="k-sub">${sub || ''}</div>
    </div>`;
  }

  function delta(cur, prev, invert) {
    if (!isFinite(cur) || !isFinite(prev) || prev === 0) return '<span class="muted">no prior period</span>';
    const d = ((cur - prev) / prev) * 100;
    const good = invert ? d < 0 : d > 0;
    const cls = Math.abs(d) < 1 ? '' : good ? 'up' : 'down';
    return `<span class="${cls}">${d >= 0 ? '+' : ''}${d.toFixed(1)}%</span> vs previous period`;
  }

  /* ---------------- rendering ---------------- */

  function render() {
    const hasData = S.leads.length || S.spend.length;
    $('#emptyState').hidden = !!hasData;
    $$('.view').forEach(v => (v.hidden = true));
    if (!hasData) { $('#coverage').hidden = true; return; }

    const range = resolveRange();
    if (!range.from || !range.to) return;
    $('#dateFrom').value = range.from;
    $('#dateTo').value = range.to;

    const leads = filteredLeads(range);
    const spend = filteredSpend(range);
    const daily = A.buildDaily(leads, spend, range.from, range.to);
    const weekly = A.toWeekly(daily);
    const totals = A.totals(daily, leads);
    const ctx = { range, leads, spend, daily, weekly, totals, cplThreshold: S.cplThreshold };

    renderCoverage(ctx);
    $('#view-' + S.view).hidden = false;
    const meta = VIEW_META[S.view];
    $('#viewTitle').textContent = meta[0];
    $('#viewSub').textContent = `${meta[1]} ${A.dayLabel(range.from)} – ${A.dayLabel(range.to)} · ${A.n(leads.length)} leads · ${A.money(totals.spend)}`;

    ({ overview: renderOverview, platforms: renderPlatforms, campaigns: renderCampaigns,
       trends: renderTrends, radar: renderRadar, quality: renderQuality, data: renderData }[S.view])(ctx);

    $('#fsLeads').textContent = S.leads.length ? A.n(S.leads.length) : '—';
    $('#fsGoogle').textContent = S.spend.some(s => s.platform === 'Google') ? A.moneyShort(A.sum(S.spend.filter(s => s.platform === 'Google').map(s => s.cost))) : '—';
    $('#fsMeta').textContent = S.spend.some(s => s.platform === 'Meta') ? A.moneyShort(A.sum(S.spend.filter(s => s.platform === 'Meta').map(s => s.cost))) : '—';
  }

  function renderCoverage(ctx) {
    const b = dataBounds();
    const el = $('#coverage');
    const bits = [];
    if (b.spendFrom) bits.push(`<span>Spend file covers <b>${A.dayLabel(b.spendFrom)} – ${A.dayLabel(b.spendTo)}</b></span>`);
    if (b.leadFrom) bits.push(`<span>Lead file covers <b>${A.dayLabel(b.leadFrom)} – ${A.dayLabel(b.leadTo)}</b></span>`);
    bits.push(`<span>Campaign tagging on <b>${A.pct(ctx.totals.attrRate || 0, 0)}</b> of leads</span>`);
    let warn = false;
    if (b.spendFrom && b.leadFrom && (b.spendFrom !== b.leadFrom || b.spendTo !== b.leadTo)) {
      warn = true;
      bits.push('<span>The two files do not span the same dates — CPL is only meaningful inside the overlap.</span>');
    }
    el.className = 'coverage' + (warn ? ' warn' : '');
    el.innerHTML = bits.join('');
    el.hidden = false;
  }

  /* ---------- overview ---------- */

  function renderOverview(ctx) {
    const { totals, daily, weekly, leads } = ctx;
    const prev = previousPeriod(ctx);
    $('#kpiRow').innerHTML = [
      kpi('Total spend', A.moneyShort(totals.spend), delta(totals.spend, prev.spend), '#3B76F0'),
      kpi('Leads', A.n(totals.leads), delta(totals.leads, prev.leads), '#D6202F'),
      kpi('Blended CPL', A.money(totals.cpl), totals.cpl > S.cplThreshold ? '<span class="down">above red line</span>' : '<span class="up">inside red line</span>', totals.cpl > S.cplThreshold ? '#DC2626' : '#0E9F6E'),
      kpi('Platform-tagged CPL', A.money(totals.taggedCpl), `${A.n(totals.tagged)} leads tagged Google or Meta`, '#2563EB'),
      kpi('Qualified', A.n(totals.qualified), `${A.pct(totals.qualRate || 0)} of leads`, '#0E9F6E'),
      kpi('CPQL', A.money(totals.cpql), totals.qualified ? `${A.n(totals.qualified)} qualified` : 'none qualified yet', '#7C4DFF'),
      kpi('Google spend', A.moneyShort(totals.google), totals.spend ? A.pct((totals.google / totals.spend) * 100, 0) + ' of budget' : '', '#3B76F0'),
      kpi('Meta spend', A.moneyShort(totals.meta), totals.spend ? A.pct((totals.meta / totals.spend) * 100, 0) + ' of budget' : '', '#7C4DFF'),
      kpi('Avg daily spend', A.moneyShort(totals.avgDailySpend), `${totals.activeDays} of ${totals.days} days active`, '#D97706')
    ].join('');

    C.spendVsLeads(daily);
    C.donut('chPlatformDonut',
      ['Google', 'Meta', 'Other'],
      [totals.google, totals.meta, totals.other],
      [C.COL.google, C.COL.meta, C.COL.other]);
    C.cplTrend(daily);
    C.statusMix(leads);
    C.topProjects(leads);

    renderInsights('#overviewInsights', A.insights({ daily, weekly, leads, totals, cplThreshold: S.cplThreshold }).slice(0, 8));
  }

  function renderInsights(sel, list) {
    const el = $(sel);
    if (!list.length) { el.innerHTML = '<div class="nodata">Nothing unusual detected in this window.</div>'; return; }
    el.innerHTML = list.map(i => `<div class="ins">
      <span class="sev ${i.sev}">${i.sev}</span>
      <div class="txt"><b>${esc(i.title)}</b><span>${i.detail}</span></div>
    </div>`).join('');
  }

  function previousPeriod(ctx) {
    const days = ctx.daily.length;
    const to = A.addDays(ctx.range.from, -1);
    const from = A.addDays(to, -(days - 1));
    const range = { from, to };
    const leads = filteredLeads(range);
    const spend = filteredSpend(range);
    return A.totals(A.buildDaily(leads, spend, from, to), leads);
  }

  /* ---------- platforms ---------- */

  function renderPlatforms(ctx) {
    const { totals, daily, leads } = ctx;
    const attributed = leads.filter(l => l.platform !== 'Other');
    $('#platKpis').innerHTML = [
      kpi('Google spend', A.moneyShort(totals.google), `${A.pct(totals.spend ? (totals.google / totals.spend) * 100 : 0, 0)} of budget`, '#3B76F0'),
      kpi('Meta spend', A.moneyShort(totals.meta), `${A.pct(totals.spend ? (totals.meta / totals.spend) * 100 : 0, 0)} of budget`, '#7C4DFF'),
      kpi('Google leads', A.n(leads.filter(l => l.platform === 'Google').length), 'tagged in the CRM', '#3B76F0'),
      kpi('Meta leads', A.n(leads.filter(l => l.platform === 'Meta').length), 'tagged in the CRM', '#7C4DFF'),
      kpi('Untagged leads', A.n(leads.filter(l => l.platform === 'Other').length), `${A.pct(A.ratio(leads.length - attributed.length, leads.length) || 0, 0)} of volume`, '#94A3B8'),
      kpi('Blended CPL', A.money(totals.cpl), 'all spend over all leads', '#D6202F')
    ].join('');

    C.platDaily(daily);
    C.platShare(daily);
    C.platCumulative(daily);
    C.platDow(daily);

    const rows = ['Google', 'Meta', 'Other'].map(p => {
      const sp = A.sum(ctx.spend.filter(s => s.platform === p).map(s => s.cost));
      const ld = leads.filter(l => l.platform === p);
      const q = ld.filter(l => l.qualified).length;
      const activeDays = new Set(ctx.spend.filter(s => s.platform === p && s.cost > 0).map(s => s.date)).size;
      return {
        platform: p, spend: sp, share: totals.spend ? (sp / totals.spend) * 100 : 0,
        leads: ld.length, qualified: q,
        cpl: A.cost(sp, ld.length), cpql: A.cost(sp, q),
        qualRate: A.ratio(q, ld.length), activeDays,
        avgDay: activeDays ? sp / activeDays : 0
      };
    }).filter(r => r.spend > 0 || r.leads > 0);

    renderTable('#tblPlatform', [
      { key: 'platform', label: 'Platform' },
      { key: 'spend', label: 'Spend', num: true, fmt: v => A.money(v) },
      { key: 'share', label: 'Share', num: true, fmt: v => A.pct(v, 1) },
      { key: 'activeDays', label: 'Active days', num: true, fmt: v => A.n(v) },
      { key: 'avgDay', label: 'Avg / active day', num: true, fmt: v => A.money(v) },
      { key: 'leads', label: 'Tagged leads', num: true, fmt: v => A.n(v) },
      { key: 'qualified', label: 'Qualified', num: true, fmt: v => A.n(v) },
      { key: 'qualRate', label: 'Qual rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'cpl', label: 'CPL', num: true, fmt: v => A.money(v) },
      { key: 'cpql', label: 'CPQL', num: true, fmt: v => A.money(v) }
    ], rows, { sort: 'spend', fileName: 'platform_scorecard' });
  }

  /* ---------- campaigns ---------- */

  function renderCampaigns(ctx) {
    const { leads, spend } = ctx;
    const keyFns = {
      project: l => l.project,
      campaign: l => l.campaign || 'Untagged',
      city: l => l.city,
      source: l => l.source,
      adset: l => l.adset || 'Untagged',
      assignee: l => l.assignee
    };
    /* spend joins only where the export carries a campaign name */
    let spendByKey = null;
    if (S.groupBy === 'campaign') {
      spendByKey = new Map();
      spend.forEach(s => { if (s.campaign) spendByKey.set(s.campaign, (spendByKey.get(s.campaign) || 0) + s.cost); });
    }
    const groups = A.groupLeads(leads, keyFns[S.groupBy], spendByKey).filter(g => g.leads >= S.minLeads);

    const totalSpend = A.sum(spend.map(s => s.cost));
    const totalLeads = leads.length;
    const impliedCpl = A.cost(totalSpend, totalLeads);
    $('#campTableNote').textContent = spendByKey
      ? 'Spend matched on campaign name where the export provides one.'
      : `No group-level spend in the export, so cost is apportioned at the window CPL of ${A.money(impliedCpl)}.`;

    groups.forEach(g => {
      if (!spendByKey) {
        g.impliedSpend = impliedCpl ? impliedCpl * g.leads : null;
        g.effCpl = impliedCpl;
        g.effCpql = g.qualified ? (impliedCpl * g.leads) / g.qualified : null;
      } else {
        g.impliedSpend = g.spend;
        g.effCpl = g.cpl;
        g.effCpql = g.cpql;
      }
      const cplV = g.effCpl;
      g.flag = cplV === null ? 'grey' : cplV > S.cplThreshold ? 'red' : 'green';
      if (g.qualified === 0 && g.leads >= 10) g.flag = 'amber';
    });

    C.bubble(groups);
    C.qualRank(groups);

    renderTable('#tblCampaign', [
      { key: 'flag', label: 'Status', sortable: true, html: r => {
          const map = { red: ['t-red', 'Red'], green: ['t-green', 'Green'], amber: ['t-amber', 'Quality risk'], grey: ['t-grey', 'Check'] };
          const [cls, txt] = map[r.flag];
          return `<span class="tagpill ${cls}">${txt}</span>`;
        }, csv: r => r.flag },
      { key: 'key', label: S.groupBy === 'assignee' ? 'Assigned to' : S.groupBy.charAt(0).toUpperCase() + S.groupBy.slice(1) },
      { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'qualified', label: 'Qualified', num: true, fmt: v => A.n(v) },
      { key: 'qualRate', label: 'Qual rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'dead', label: 'Dead', num: true, fmt: v => A.n(v) },
      { key: 'deadRate', label: 'Dead rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'impliedSpend', label: 'Spend', num: true, fmt: v => A.money(v) },
      { key: 'effCpl', label: 'CPL', num: true, fmt: v => A.money(v) },
      { key: 'effCpql', label: 'CPQL', num: true, fmt: v => A.money(v) },
      { key: 'respMedian', label: 'Median response', num: true, fmt: v => (v === null ? '—' : v.toFixed(1) + ' h') },
      { key: 'cityList', label: 'Cities' }
    ], groups, { sort: 'leads', fileName: 'group_performance_' + S.groupBy, searchPlaceholder: 'Search groups…' });
  }

  /* ---------- trends ---------- */

  function renderTrends(ctx) {
    const isWeek = S.granularity === 'week';
    const rows = isWeek ? ctx.weekly : ctx.daily;
    $('#trendNote').textContent = isWeek
      ? `${rows.length} weeks · Monday to Sunday`
      : `${rows.length} days`;

    C.trend(rows, S.metrics.length ? S.metrics : ['spend'], isWeek);
    C.pacing(ctx.daily);

    /* week on week cards */
    const w = ctx.weekly;
    const cur = w[w.length - 1], prev = w[w.length - 2];
    const cards = [
      ['Spend', 'spend', v => A.moneyShort(v), false],
      ['Leads', 'leads', v => A.n(v), false],
      ['Qualified', 'qualified', v => A.n(v), false],
      ['CPL', 'cpl', v => A.money(v), true],
      ['CPQL', 'cpql', v => A.money(v), true],
      ['Qual rate', 'qualRate', v => A.pct(v || 0), false]
    ];
    $('#wowCards').innerHTML = cur ? cards.map(([label, k, fmt, invert]) => {
      const c = cur[k], p = prev ? prev[k] : null;
      let d = '<span class="w-d flat">no prior week</span>';
      if (p !== null && p !== undefined && isFinite(p) && p !== 0 && isFinite(c)) {
        const pc = ((c - p) / p) * 100;
        const good = invert ? pc < 0 : pc > 0;
        d = `<span class="w-d ${Math.abs(pc) < 1 ? 'flat' : good ? 'up' : 'down'}">${pc >= 0 ? '+' : ''}${pc.toFixed(1)}% vs ${fmt(p)}</span>`;
      }
      return `<div class="wow"><div class="w-l">${label}</div><div class="w-v">${fmt(c)}</div>${d}</div>`;
    }).join('') : '<div class="nodata">Not enough data for a weekly comparison.</div>';

    renderTable('#tblTrend', [
      { key: isWeek ? 'label' : 'date', label: isWeek ? 'Week' : 'Date', fmt: (v, r) => (isWeek ? r.label : A.dayLabel(r.date)), sortVal: r => r.date },
      { key: 'google', label: 'Google', num: true, fmt: v => A.money(v) },
      { key: 'meta', label: 'Meta', num: true, fmt: v => A.money(v) },
      { key: 'spend', label: 'Total spend', num: true, fmt: v => A.money(v) },
      { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'qualified', label: 'Qualified', num: true, fmt: v => A.n(v) },
      { key: 'qualRate', label: 'Qual rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'cpl', label: 'CPL', num: true, fmt: v => A.money(v) },
      { key: 'cpql', label: 'CPQL', num: true, fmt: v => A.money(v) },
      { key: 'dead', label: 'Dead', num: true, fmt: v => A.n(v) }
    ], rows, { sort: 'date', dir: 'asc', fileName: isWeek ? 'weekly_summary' : 'daily_summary' });
  }

  /* ---------- radar ---------- */

  function renderRadar(ctx) {
    const { daily, weekly, leads, totals } = ctx;
    renderInsights('#radarInsights', A.insights({ daily, weekly, leads, totals, cplThreshold: S.cplThreshold }));

    /* slope cards */
    const defs = [
      ['Spend per day', daily.map(r => r.spend), v => A.money(v), false],
      ['Leads per day', daily.map(r => r.leads), v => v.toFixed(2), false],
      ['CPL', daily.map(r => (isFinite(r.cpl) && r.cpl !== null ? r.cpl : null)).filter(v => v !== null), v => A.money(v), true],
      ['Qualification rate', daily.map(r => r.qualRate).filter(v => v !== null), v => v.toFixed(2) + ' pts', false]
    ];
    $('#slopeCards').innerHTML = defs.map(([label, arr, fmt, invert]) => {
      const s = A.slope(arr);
      if (s === null) return `<div class="wow"><div class="w-l">${label}</div><div class="w-v">—</div><div class="w-d flat">not enough days</div></div>`;
      const good = invert ? s < 0 : s > 0;
      const dir = Math.abs(s) < 1e-9 ? 'flat' : good ? 'up' : 'down';
      return `<div class="wow"><div class="w-l">${label}</div><div class="w-v">${s >= 0 ? '+' : '−'}${fmt(Math.abs(s))}</div><div class="w-d ${dir}">per day, least-squares</div></div>`;
    }).join('');

    C.lagChart(A.lagCorrelation(daily));

    /* weekday heatmap */
    const dow = A.dowIndex(daily);
    const rowsMeta = { spend: ['Spend', v => A.moneyShort(v)], leads: ['Leads', v => v.toFixed(1)], cpl: ['CPL', v => A.moneyShort(v)], qual: ['Qual rate', v => v.toFixed(1) + '%'] };
    let html = `<div class="heatrow"><span class="hl"></span>${A.DOW_NAMES.map(d => `<span class="heathead">${d}</span>`).join('')}</div>`;
    dow.rows.forEach(r => {
      const [label, fmt] = rowsMeta[r.metric];
      html += `<div class="heatrow"><span class="hl">${label}</span>` + r.cells.map(c => {
        if (c.value === null) return `<span class="heatcell" style="background:#F4F6FA;color:#94A3B8">—</span>`;
        const idx = c.index || 100;
        const t = Math.max(-1, Math.min(1, (idx - 100) / 60));
        const bg = t >= 0
          ? `rgba(14,159,110,${(0.10 + t * 0.42).toFixed(2)})`
          : `rgba(214,32,47,${(0.10 + Math.abs(t) * 0.42).toFixed(2)})`;
        return `<span class="heatcell" style="background:${bg}" title="${label} ${A.DOW_NAMES[r.cells.indexOf(c)]}: index ${Math.round(idx)}">${fmt(c.value)}<br><small style="color:#64748B">${Math.round(idx)}</small></span>`;
      }).join('') + '</div>';
    });
    $('#dowHeat').innerHTML = html;

    const anomalies = A.anomalies(daily);
    renderTable('#tblAnomaly', [
      { key: 'date', label: 'Date', fmt: v => A.dayLabel(v) },
      { key: 'metric', label: 'Metric' },
      { key: 'value', label: 'Value', num: true },
      { key: 'baseline', label: 'Window average', num: true },
      { key: 'z', label: 'Std deviations', num: true, fmt: v => (v > 0 ? '+' : '') + v.toFixed(2) }
    ], anomalies, { sort: 'z', fileName: 'anomalies' });

    const outliers = A.qualityOutliers(leads, 10);
    renderTable('#tblOutlier', [
      { key: 'key', label: 'Project' },
      { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'qualified', label: 'Qualified', num: true, fmt: v => A.n(v) },
      { key: 'qualRate', label: 'Qual rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'benchmark', label: 'Benchmark', num: true, fmt: v => A.pct(v || 0) },
      { key: 'delta', label: 'Gap', num: true, html: r => `<span class="${r.delta >= 0 ? 'up' : 'down'}" style="font-weight:600;color:${r.delta >= 0 ? '#0E9F6E' : '#DC2626'}">${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} pts</span>`, csv: r => r.delta.toFixed(1) },
      { key: 'deadRate', label: 'Dead rate', num: true, fmt: v => A.pct(v || 0) }
    ], outliers, { sort: 'delta', fileName: 'quality_outliers' });
  }

  /* ---------- quality ---------- */

  function renderQuality(ctx) {
    const { leads, totals } = ctx;
    $('#qualKpis').innerHTML = [
      kpi('Leads', A.n(totals.leads), `${totals.days} days in window`, '#3B76F0'),
      kpi('Qualified', A.n(totals.qualified), A.pct(totals.qualRate || 0) + ' of volume', '#0E9F6E'),
      kpi('Unqualified', A.n(totals.unqualified), A.pct(A.ratio(totals.unqualified, totals.leads) || 0) + ' of volume', '#94A3B8'),
      kpi('Still TBD', A.n(totals.tbd), A.pct(A.ratio(totals.tbd, totals.leads) || 0) + ' awaiting a call', '#D97706'),
      kpi('Dead', A.n(totals.dead), A.pct(totals.deadRate || 0) + ' of volume', '#D6202F'),
      kpi('Contacted', A.pct(totals.respRate || 0), `${A.n(totals.responded)} with a first follow-up`, '#7C4DFF'),
      kpi('Median response', totals.respMedian === null ? '—' : totals.respMedian.toFixed(1) + ' h', 'created to first touch', '#2563EB'),
      kpi('Site visits', A.n(totals.visits), A.pct(A.ratio(totals.visits, totals.leads) || 0) + ' of leads', '#0E9F6E')
    ].join('');

    /* funnel */
    const stages = [
      ['Leads captured', totals.leads],
      ['Contacted', totals.responded],
      ['Not dead', totals.leads - totals.dead],
      ['Qualified', totals.qualified],
      ['Site visits', totals.visits]
    ];
    const max = Math.max(1, ...stages.map(s => s[1]));
    $('#funnel').innerHTML = stages.map(([l, v]) => `
      <div class="fstage">
        <span class="flab">${l}</span>
        <span class="fbar" style="width:${Math.max(4, (v / max) * 100)}%">${A.n(v)}</span>
        <span class="fpct">${A.pct(A.ratio(v, totals.leads) || 0, 1)}</span>
      </div>`).join('');

    C.subStatus(leads);
    C.deadReasons(leads);
    C.responseTime(leads);
    C.cityQual(leads);

    const team = A.groupLeads(leads, l => l.assignee);
    renderTable('#tblTeam', [
      { key: 'key', label: 'Assigned to' },
      { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'qualified', label: 'Qualified', num: true, fmt: v => A.n(v) },
      { key: 'qualRate', label: 'Qual rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'responded', label: 'Contacted', num: true, fmt: v => A.n(v) },
      { key: 'respMedian', label: 'Median response', num: true, fmt: v => (v === null ? '—' : v.toFixed(1) + ' h') },
      { key: 'dead', label: 'Dead', num: true, fmt: v => A.n(v) },
      { key: 'cityList', label: 'Cities' }
    ], team, { sort: 'qualified', fileName: 'team_leaderboard', searchPlaceholder: 'Search team…' });
  }

  /* ---------- data ---------- */

  function renderData(ctx) {
    const t = S.dataTab;
    $('#dataTitle').textContent = { daily: 'Daily master', leads: 'Leads', spend: 'Spend' }[t];
    if (t === 'daily') {
      $('#dataNote').textContent = 'One row per day inside the current window.';
      renderTable('#tblData', [
        { key: 'date', label: 'Date', fmt: v => A.dayLabel(v) },
        { key: 'date', label: 'Weekday', fmt: v => A.DOW_NAMES[A.dow(v)], sortable: false },
        { key: 'google', label: 'Google', num: true, fmt: v => A.money(v) },
        { key: 'meta', label: 'Meta', num: true, fmt: v => A.money(v) },
        { key: 'spend', label: 'Total spend', num: true, fmt: v => A.money(v) },
        { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
        { key: 'qualified', label: 'Qualified', num: true, fmt: v => A.n(v) },
        { key: 'tbd', label: 'TBD', num: true, fmt: v => A.n(v) },
        { key: 'dead', label: 'Dead', num: true, fmt: v => A.n(v) },
        { key: 'cpl', label: 'CPL', num: true, fmt: v => A.money(v) },
        { key: 'cpql', label: 'CPQL', num: true, fmt: v => A.money(v) }
      ], ctx.daily, { sort: 'date', dir: 'asc', fileName: 'daily_master' });
    } else if (t === 'leads') {
      $('#dataNote').textContent = `${A.n(ctx.leads.length)} leads after filters.`;
      renderTable('#tblData', [
        { key: 'date', label: 'Date', fmt: v => A.dayLabel(v) },
        { key: 'customer', label: 'Customer' },
        { key: 'project', label: 'Project' },
        { key: 'city', label: 'City' },
        { key: 'platform', label: 'Platform' },
        { key: 'source', label: 'Source' },
        { key: 'campaign', label: 'Campaign', fmt: v => v || '—' },
        { key: 'status', label: 'Status' },
        { key: 'subStatus', label: 'Sub status' },
        { key: 'qual', label: 'Qualifying', html: r => {
            const cls = r.qualified ? 't-green' : r.unqualified ? 't-grey' : 't-amber';
            return `<span class="tagpill ${cls}">${esc(r.qual)}</span>`;
          }, csv: r => r.qual },
        { key: 'assignee', label: 'Assigned to' },
        { key: 'respHrs', label: 'Response', num: true, fmt: v => (v === null ? '—' : v.toFixed(1) + ' h') }
      ], ctx.leads, { sort: 'date', dir: 'desc', pageSize: 50, fileName: 'leads', searchPlaceholder: 'Search leads…' });
    } else {
      $('#dataNote').textContent = `${A.n(ctx.spend.length)} spend rows after filters.`;
      renderTable('#tblData', [
        { key: 'date', label: 'Date', fmt: v => A.dayLabel(v) },
        { key: 'platform', label: 'Platform' },
        { key: 'account', label: 'Account' },
        { key: 'campaign', label: 'Campaign', fmt: v => v || '—' },
        { key: 'cost', label: 'Cost', num: true, fmt: v => A.money(v) },
        { key: 'currency', label: 'Currency' },
        { key: 'file', label: 'Source file' }
      ], ctx.spend, { sort: 'date', dir: 'asc', pageSize: 100, fileName: 'spend_rows' });
    }
  }

  /* ---------------- events ---------------- */

  function bind() {
    $('#nav').addEventListener('click', e => {
      const b = e.target.closest('.navbtn'); if (!b) return;
      $$('.navbtn').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      S.view = b.dataset.view;
      $('#sidebar').classList.remove('open');
      render();
    });

    $('#openUpload').onclick = openModal;
    $('#openUpload2').onclick = openModal;
    $('#closeUpload').onclick = closeModal;
    $('#uploadModal').addEventListener('click', e => { if (e.target.id === 'uploadModal') closeModal(); });
    $('#applyFiles').onclick = applyStaged;
    $('#clearAll').onclick = () => { S.staged = []; renderFileList(); };
    $('#fileInput').onchange = e => stageFiles(e.target.files);

    const dz = $('#dropzone');
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('over'); }));
    dz.addEventListener('drop', e => stageFiles(e.dataTransfer.files));
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      if (e.target.closest('#dropzone')) return;
      openModal(); stageFiles(e.dataTransfer.files);
    });

    $('#rangePreset').onchange = e => { S.filters.preset = e.target.value; render(); };
    $('#dateFrom').onchange = e => { S.filters.from = e.target.value; S.filters.preset = 'custom'; $('#rangePreset').value = 'custom'; render(); };
    $('#dateTo').onchange = e => { S.filters.to = e.target.value; S.filters.preset = 'custom'; $('#rangePreset').value = 'custom'; render(); };
    $('#resetFilters').onclick = () => {
      S.filters = { preset: 'overlap', from: null, to: null, cities: null, projects: null, platforms: null };
      $('#rangePreset').value = 'overlap';
      rebuildFilters(); render();
    };

    $('#groupBy').onchange = e => { S.groupBy = e.target.value; render(); };
    $('#cplThreshold').onchange = e => { S.cplThreshold = Math.max(0, +e.target.value || 0); render(); };
    $('#minLeads').onchange = e => { S.minLeads = Math.max(1, +e.target.value || 1); render(); };

    $('#granularity').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $$('#granularity .seg').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active'); S.granularity = b.dataset.g; render();
    });
    $('#metricChips').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      b.classList.toggle('is-active');
      S.metrics = $$('#metricChips .chip.is-active').map(x => x.dataset.m);
      render();
    });
    $('#dataTabs').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $$('#dataTabs .seg').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active'); S.dataTab = b.dataset.t; render();
    });

    $('#saveSession').onclick = () => {
      if (!S.leads.length && !S.spend.length) { toast('Nothing to save yet'); return; }
      const payload = { savedAt: new Date().toISOString(), leads: S.leads, spend: S.spend };
      downloadFile(`pp_session_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload), 'application/json');
      toast('Session file downloaded');
    };
    $('#loadSessionBtn').onclick = () => $('#loadSession').click();
    $('#loadSession').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        const j = PP.parseSession(await PP.readFile(f));
        mergeLeads(j.leads); mergeSpend(j.spend);
        rebuildFilters(); render();
        toast('Session restored');
      } catch (err) { toast(err.message); }
      e.target.value = '';
    };

    $('#menuToggle').onclick = () => $('#sidebar').classList.toggle('open');
    document.addEventListener('click', () => $$('.mspop').forEach(p => p.classList.remove('open')));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); $$('.mspop').forEach(p => p.classList.remove('open')); } });
    window.addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(render, 250); });
  }

  /* ---------------- boot ---------------- */

  document.addEventListener('DOMContentLoaded', async () => {
    bind();
    const loaded = await autoLoad();
    if (loaded) { rebuildFilters(); render(); toast('Loaded files from the repo'); }
    else render();
  });
})();
