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
    uploadLog: [],
    drillMode: 'estimated',
    drillOpen: new Set(),
    drillSearch: '',
    asmLevel: 'asm',
    asmMinLeads: 5,
    audit: { firstResponseHrs: 2, staleDays: 2, tbdDays: 3, minAttempts: 3 },
    auditOwnerBy: 'assignee',
    auditSev: new Set(['critical', 'major'])
  };
  window.PPSTATE = S;

  const VIEW_META = {
    overview: ['Overview', 'Blended performance across every platform and project in the window.'],
    platforms: ['Platforms', 'Google versus Meta — budget, pace and efficiency.'],
    campaigns: ['Campaigns & Projects', 'Where the money goes and what it returns.'],
    trends: ['Trends', 'Daily and weekly movement with period comparisons.'],
    radar: ['Pattern Radar', 'Anomalies, drift, correlation and weekday behaviour.'],
    quality: ['Lead Quality', 'Funnel, status mix, response discipline and team output.'],
    data: ['Data Tables', 'The underlying rows, searchable and exportable.'],
    drilldown: ['Spend Drill-Down', 'Project into platform into campaign, with leads, QL, TBD, CPL and CPQL on every level.'],
    asm: ['ASM Dashboard', 'Lead to QL, QL to visit and visit to EOI or booking, by owner.'],
    audit: ['Lead Audit', 'Follow-up discipline read straight off the CRM comment log.'],
    uploads: ['Uploads & Log', 'One drop zone per file type, with a record of everything loaded.']
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

  const SLOTS = {
    leads:   { label: 'CRM lead dump', kind: 'leads', accept: '.csv,.tsv,.txt,text/csv,text/plain' },
    google:  { label: 'Google Ads spend', kind: 'spend', platform: 'Google', accept: '.csv,.tsv,.txt,text/csv,text/plain' },
    meta:    { label: 'Meta Ads spend', kind: 'spend', platform: 'Meta', accept: '.csv,.tsv,.txt,text/csv,text/plain' },
    session: { label: 'Saved session', kind: 'session', accept: '.json,application/json' }
  };

  /* Everything the Diagnostics card reports, so a silent failure cannot stay silent. */
  const DIAG = { lastEvent: 'none yet', lastError: '', wired: false, picks: 0, drops: 0, reads: 0 };

  function setZoneStatus(slot, text, kind) {
    const el = document.querySelector(`.zonestatus[data-status="${slot}"]`);
    if (!el) return;
    el.textContent = text;
    el.className = 'zonestatus' + (kind ? ' is-' + kind : '');
  }

  function showError(msg) {
    DIAG.lastError = msg;
    const el = $('#errBanner');
    if (el) { el.textContent = msg; el.hidden = false; }
    toast(msg.length > 90 ? msg.slice(0, 88) + '…' : msg);
  }

  function clearError() {
    const el = $('#errBanner');
    if (el) { el.hidden = true; el.textContent = ''; }
    DIAG.lastError = '';
  }

  function logUpload(entry) {
    S.uploadLog.unshift(Object.assign({
      at: new Date().toISOString(),
      slot: '', file: '', size: 0, rows: 0, added: 0, from: '', to: '', status: 'Loaded', note: ''
    }, entry));
  }

  /* One hidden input per slot, created in script and clicked directly.
     No <label> wrapping — that was the part that could silently do nothing. */
  const pickers = {};
  function picker(slot) {
    if (pickers[slot]) return pickers[slot];
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = SLOTS[slot].accept;
    inp.multiple = slot !== 'session';
    inp.style.cssText = 'position:fixed;left:-10000px;top:0;width:1px;height:1px;opacity:0';
    inp.addEventListener('change', () => {
      DIAG.lastEvent = `file chosen for ${slot} (${inp.files.length})`;
      const files = [...inp.files];
      inp.value = '';
      if (files.length) loadFiles(slot, files);
    });
    document.body.appendChild(inp);
    pickers[slot] = inp;
    return inp;
  }

  function openPicker(slot) {
    DIAG.picks++;
    DIAG.lastEvent = 'picker opened for ' + slot;
    try { picker(slot).click(); }
    catch (e) { showError('Could not open the file picker: ' + e.message); }
    if (S.view === 'uploads') { try { renderDiagnostics(); } catch (e) { /* diagnostics are best effort */ } }
  }

  /* Read one file. Falls back to text() if FileReader is unavailable. */
  async function readOne(file) {
    DIAG.reads++;
    try { return await PP.readFile(file); }
    catch (e) {
      if (file.text) return await file.text();
      throw e;
    }
  }

  async function loadFiles(slot, fileList) {
    const cfg = SLOTS[slot];
    const files = [...(fileList || [])];
    if (!cfg) { showError('Unknown upload slot: ' + slot); return; }
    if (!files.length) { setZoneStatus(slot, 'No file received', 'bad'); return; }
    clearError();

    if (typeof Papa === 'undefined') {
      const msg = 'The CSV library did not load. Check the network — the page pulls PapaParse and Chart.js from cdn.jsdelivr.net.';
      files.forEach(f => logUpload({ slot: cfg.label, file: f.name, size: f.size, status: 'Failed', note: msg }));
      setZoneStatus(slot, 'Failed — CSV library missing', 'bad');
      showError(msg);
      safeRender();
      return;
    }

    for (const f of files) {
      const base = { slot: cfg.label, file: f.name, size: f.size };
      setZoneStatus(slot, `Reading ${f.name}…`, 'busy');
      try {
        const text = await readOne(f);
        if (!text || !text.trim()) throw new Error('The file is empty');
        const detected = /\.json$/i.test(f.name) ? 'session' : PP.detectKind(text);

        if (detected !== 'unknown' && detected !== cfg.kind) {
          const note = `This looks like a ${detected === 'leads' ? 'CRM lead dump' : 'spend export'}, not a ${cfg.label} file. Use the matching box.`;
          logUpload(Object.assign(base, { status: 'Rejected', note }));
          setZoneStatus(slot, 'Rejected — wrong file for this box', 'bad');
          toast(note);
          continue;
        }

        if (cfg.kind === 'leads') {
          const rows = PP.parseLeads(text, f.name);
          if (!rows.length) throw new Error('No rows with a readable Created At date');
          const added = mergeLeads(rows);
          const dates = rows.map(r => r.date).sort();
          logUpload(Object.assign(base, {
            rows: rows.length, added, from: dates[0], to: dates[dates.length - 1],
            note: added < rows.length ? `${rows.length - added} already in memory, skipped` : 'All rows new'
          }));
          setZoneStatus(slot, `Loaded ${A.n(rows.length)} leads · ${A.n(added)} new`, 'ok');
        } else if (cfg.kind === 'spend') {
          const rows = PP.parseSpend(text, cfg.platform, f.name);
          if (!rows.length) throw new Error('No rows with a readable date and cost');
          const added = mergeSpend(rows);
          const dates = rows.map(r => r.date).sort();
          const total = A.sum(rows.map(r => r.cost));
          logUpload(Object.assign(base, {
            rows: rows.length, added, from: dates[0], to: dates[dates.length - 1],
            note: `${A.money(total)} tagged ${cfg.platform}`
          }));
          setZoneStatus(slot, `Loaded ${A.n(rows.length)} days · ${A.money(total)}`, 'ok');
        } else {
          const j = PP.parseSession(text);
          const added = mergeLeads(j.leads) + mergeSpend(j.spend);
          if (Array.isArray(j.uploadLog)) S.uploadLog = S.uploadLog.concat(j.uploadLog);
          logUpload(Object.assign(base, {
            rows: j.leads.length + j.spend.length, added,
            note: `Session saved ${j.savedAt ? j.savedAt.slice(0, 10) : 'earlier'}`
          }));
          setZoneStatus(slot, `Restored ${A.n(j.leads.length)} leads and ${A.n(j.spend.length)} spend rows`, 'ok');
        }
        toast(`${f.name} loaded`);
      } catch (e) {
        logUpload(Object.assign(base, { status: 'Failed', note: e.message }));
        setZoneStatus(slot, 'Failed — ' + e.message, 'bad');
        showError(`${f.name}: ${e.message}`);
      }
    }

    try { rebuildFilters(); } catch (e) { showError('Filters could not rebuild: ' + e.message); }
    safeRender();
  }

  /* A rendering fault must never hide a load that actually worked. */
  function safeRender() {
    try { render(); }
    catch (e) {
      showError('The view failed to draw: ' + e.message);
      try { renderUploads(); } catch (e2) { /* nothing more to do */ }
    }
  }

  function wireUploads() {
    let zones = 0;
    $$('.dropzone[data-slot]').forEach(dz => {
      const slot = dz.dataset.slot;
      zones++;
      ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.add('over');
        DIAG.lastEvent = 'dragging over ' + slot;
      }));
      ['dragleave', 'dragend'].forEach(ev => dz.addEventListener(ev, e => {
        e.preventDefault(); e.stopPropagation(); dz.classList.remove('over');
      }));
      dz.addEventListener('drop', e => {
        e.preventDefault(); e.stopPropagation();
        dz.classList.remove('over');
        DIAG.drops++;
        DIAG.lastEvent = `drop on ${slot} (${e.dataTransfer ? e.dataTransfer.files.length : 0} files)`;
        loadFiles(slot, e.dataTransfer ? e.dataTransfer.files : []);
      });
      /* click anywhere in the box opens the picker */
      dz.addEventListener('click', e => {
        if (e.target.closest('[data-pick]')) return;
        openPicker(slot);
      });
    });
    $$('[data-pick]').forEach(btn => btn.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      openPicker(btn.dataset.pick);
    }));
    DIAG.wired = zones > 0;
    return zones;
  }

  function renderDiagnostics() {
    const el = $('#diagBody');
    if (!el) return;
    const rows = [
      { item: 'CSV library (PapaParse)', value: typeof Papa !== 'undefined' ? 'Loaded' : 'MISSING — check network access to cdn.jsdelivr.net' },
      { item: 'Chart library (Chart.js)', value: typeof Chart !== 'undefined' ? 'Loaded' : 'MISSING — charts will not draw' },
      { item: 'Drop zones wired', value: DIAG.wired ? 'Yes, all four' : 'NO — reload the page' },
      { item: 'File pickers opened', value: A.n(DIAG.picks) },
      { item: 'Files dropped', value: A.n(DIAG.drops) },
      { item: 'Files read', value: A.n(DIAG.reads) },
      { item: 'Last event seen', value: DIAG.lastEvent },
      { item: 'Last error', value: DIAG.lastError || 'None' },
      { item: 'Leads in memory', value: A.n(S.leads.length) },
      { item: 'Spend rows in memory', value: A.n(S.spend.length) }
    ];
    renderTable('#diagBody', [
      { key: 'item', label: 'Check' },
      { key: 'value', label: 'Result', html: r => {
          const bad = /MISSING|^NO\b/.test(r.value);
          return `<span class="${bad ? 'diagbad' : ''}">${esc(r.value)}</span>`;
        }, csv: r => r.value }
    ], rows, { fileName: 'diagnostics' });
  }

  function goUploads() {
    S.view = 'uploads';
    $$('.navbtn').forEach(x => x.classList.toggle('is-active', x.dataset.view === 'uploads'));
    safeRender();
  }

  /* de-duplicating merges — leads on lead number, spend on date + platform + account */
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
    rows.forEach(r => { if (!map.has(key(r))) added++; map.set(key(r), r); });  // newest file wins
    S.spend = [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
    return added;
  }

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
    $('#emptyState').hidden = !!hasData || S.view === 'uploads';
    $$('.view').forEach(v => (v.hidden = true));
    sidebarStatus();
    $('#filters').hidden = (S.view === 'uploads');

    if (!hasData || S.view === 'uploads') {
      $('#coverage').hidden = true;
      if (S.view === 'uploads') {
        $('#view-uploads').hidden = false;
        $('#viewTitle').textContent = VIEW_META.uploads[0];
        $('#viewSub').textContent = VIEW_META.uploads[1];
        renderUploads();
      }
      if (!hasData) return;
      return;
    }

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
       trends: renderTrends, radar: renderRadar, quality: renderQuality, data: renderData,
       drilldown: renderDrilldown, asm: renderAsm, audit: renderAudit }[S.view])(ctx);
  }

  function sidebarStatus() {
    $('#fsLeads').textContent = S.leads.length ? A.n(S.leads.length) : '—';
    const g = S.spend.filter(s => s.platform === 'Google'), m = S.spend.filter(s => s.platform === 'Meta');
    $('#fsGoogle').textContent = g.length ? A.moneyShort(A.sum(g.map(s => s.cost))) : '—';
    $('#fsMeta').textContent = m.length ? A.moneyShort(A.sum(m.map(s => s.cost))) : '—';
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

  /* ---------- uploads ---------- */

  function renderUploads() {
    const b = dataBounds();
    const note = (sel, rows, extra) => {
      const el = $(sel);
      if (!el) return;
      el.textContent = rows.length ? extra : 'Nothing loaded';
    };
    note('#upLeadsNote', S.leads, `${A.n(S.leads.length)} leads · ${b.leadFrom ? A.dayLabel(b.leadFrom) + ' – ' + A.dayLabel(b.leadTo) : ''}`);
    const g = S.spend.filter(x => x.platform === 'Google');
    const m = S.spend.filter(x => x.platform === 'Meta');
    note('#upGoogleNote', g, `${A.money(A.sum(g.map(x => x.cost)))} across ${g.length} days`);
    note('#upMetaNote', m, `${A.money(A.sum(m.map(x => x.cost)))} across ${m.length} days`);

    renderTable('#tblUploadLog', [
      { key: 'at', label: 'Loaded at', fmt: v => new Date(v).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) },
      { key: 'slot', label: 'Slot' },
      { key: 'file', label: 'File' },
      { key: 'status', label: 'Status', html: r => {
          const cls = r.status === 'Loaded' ? 't-green' : r.status === 'Rejected' ? 't-amber' : 't-red';
          return `<span class="tagpill ${cls}">${esc(r.status)}</span>`;
        }, csv: r => r.status },
      { key: 'rows', label: 'Rows in file', num: true, fmt: v => (v ? A.n(v) : '—') },
      { key: 'added', label: 'New rows', num: true, fmt: v => (v ? A.n(v) : '0') },
      { key: 'from', label: 'Covers', fmt: (v, r) => (r.from ? `${A.dayLabel(r.from)} – ${A.dayLabel(r.to)}` : '—'), sortable: false },
      { key: 'size', label: 'Size', num: true, fmt: v => (v / 1024).toFixed(0) + ' KB' },
      { key: 'note', label: 'Note', html: r => `<span class="logline">${esc(r.note)}</span>`, csv: r => r.note }
    ], S.uploadLog, { sort: 'at', dir: 'desc', fileName: 'upload_log', searchPlaceholder: 'Search the log…' });

    const state = [
      { what: 'CRM leads', rows: S.leads.length, from: b.leadFrom, to: b.leadTo, detail: `${new Set(S.leads.map(l => l.project)).size} projects · ${new Set(S.leads.map(l => l.city)).size} cities` },
      { what: 'Google spend', rows: g.length, from: g.length ? g.map(x => x.date).sort()[0] : null, to: g.length ? g.map(x => x.date).sort().slice(-1)[0] : null, detail: A.money(A.sum(g.map(x => x.cost))) },
      { what: 'Meta spend', rows: m.length, from: m.length ? m.map(x => x.date).sort()[0] : null, to: m.length ? m.map(x => x.date).sort().slice(-1)[0] : null, detail: A.money(A.sum(m.map(x => x.cost))) }
    ];
    renderDiagnostics();
    renderTable('#tblLoadState', [
      { key: 'what', label: 'Dataset' },
      { key: 'rows', label: 'Rows', num: true, fmt: v => A.n(v) },
      { key: 'from', label: 'Covers', fmt: (v, r) => (r.from ? `${A.dayLabel(r.from)} – ${A.dayLabel(r.to)}` : '—'), sortable: false },
      { key: 'detail', label: 'Detail' }
    ], state, { fileName: 'load_state' });
  }

  /* ---------- drill-down ---------- */

  function renderDrilldown(ctx) {
    const dd = A.buildDrilldown(ctx.leads, ctx.spend, S.drillMode);
    const t = ctx.totals;

    $('#drillKpis').innerHTML = [
      kpi('Spend in window', A.moneyShort(dd.totalSpend), `${A.n(dd.tree.length)} projects with leads`, '#3B76F0'),
      kpi('Matched to campaigns', A.pct(dd.matchShare, 0), dd.matchShare > 0 ? 'exact campaign-name matches' : 'export carries no campaign column', dd.matchShare > 0 ? '#0E9F6E' : '#D97706'),
      kpi('Unallocated spend', A.moneyShort(dd.unallocated), dd.unallocated > 0 ? 'no leads to attach it to' : 'everything placed', dd.unallocated > 0 ? '#D6202F' : '#0E9F6E'),
      kpi('Leads', A.n(t.leads), `${A.n(t.qualified)} QL · ${A.n(t.tbd)} TBD`, '#7C4DFF'),
      kpi('Blended CPL', A.money(t.cpl), 'window spend over window leads', '#D6202F'),
      kpi('Blended CPQL', A.money(t.cpql), t.qualified ? `${A.n(t.qualified)} qualified` : 'none qualified yet', '#D97706')
    ].join('');

    $('#drillNote').textContent = S.drillMode === 'strict'
      ? 'Strict mode: only spend the export ties to a campaign name is shown against a row.'
      : 'Spend is matched on campaign name where possible, then apportioned by lead share. Every row states which.';

    drawDrillTable(dd);
    C.drillSpend(dd.tree);
    C.drillEfficiency(dd.tree);
  }

  function drawDrillTable(dd) {
    const el = $('#tblDrill');
    el.innerHTML = '';
    let tree = dd.tree;
    const q = S.drillSearch.trim().toLowerCase();
    if (q) {
      tree = tree.map(p => {
        const hitP = p.key.toLowerCase().includes(q);
        const kids = p.children.map(pl => {
          const hitPl = pl.key.toLowerCase().includes(q);
          const gk = pl.children.filter(c => c.key.toLowerCase().includes(q));
          return hitP || hitPl ? pl : (gk.length ? Object.assign({}, pl, { children: gk }) : null);
        }).filter(Boolean);
        return hitP || kids.length ? Object.assign({}, p, { children: kids }) : null;
      }).filter(Boolean);
      tree.forEach(p => { S.drillOpen.add(p.key); p.children.forEach(pl => S.drillOpen.add(p.key + '||' + pl.key)); });
    }
    if (!tree.length) { el.innerHTML = '<div class="nodata">Nothing matches that search.</div>'; return; }

    const rows = A.flattenTree(tree, S.drillOpen);
    const wrap = document.createElement('div'); wrap.className = 'tblwrap';
    const tools = document.createElement('div'); tools.className = 'tbltools';
    const info = document.createElement('span'); info.className = 'muted';
    info.textContent = `${A.n(tree.length)} projects · ${A.n(rows.length)} rows shown`;
    const spacer = document.createElement('span'); spacer.className = 'spacer';
    const dl = document.createElement('button'); dl.className = 'btn btn-ghost btn-sm'; dl.textContent = 'Download CSV';
    tools.append(info, spacer, dl);

    const scroll = document.createElement('div'); scroll.className = 'tblscroll';
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr>
      <th class="no-sort">Project / platform / campaign</th>
      <th class="n no-sort">Spend</th>
      <th class="n no-sort">Leads</th>
      <th class="n no-sort">QL</th>
      <th class="n no-sort">TBD</th>
      <th class="n no-sort">Unqualified</th>
      <th class="n no-sort">QL rate</th>
      <th class="n no-sort">CPL</th>
      <th class="n no-sort">CPQL</th>
      <th class="n no-sort">Visits</th>
      <th class="n no-sort">EOI / booked</th>
    </tr></thead>`;
    const tb = document.createElement('tbody');
    rows.forEach(r => {
      const n = r.node;
      const tr = document.createElement('tr');
      tr.className = 'lvl-' + r.depth;
      const first = document.createElement('td');
      if (r.hasKids) {
        const btn = document.createElement('button');
        btn.className = 'treebtn';
        btn.textContent = S.drillOpen.has(r.path) ? '▾' : '▸';
        btn.onclick = () => {
          S.drillOpen.has(r.path) ? S.drillOpen.delete(r.path) : S.drillOpen.add(r.path);
          drawDrillTable(dd);
        };
        first.appendChild(btn);
      } else {
        first.appendChild(Object.assign(document.createElement('span'), { className: 'treebtn', textContent: ' ' }));
      }
      first.appendChild(document.createTextNode(' ' + n.key));
      if (n.method) {
        const pill = document.createElement('span');
        pill.className = 'methodpill ' + n.method.split(' ')[0];
        pill.textContent = n.method;
        first.appendChild(pill);
      }
      tr.appendChild(first);
      const cells = [
        A.money(n.spend), A.n(n.leads), A.n(n.qualified), A.n(n.tbd), A.n(n.unqualified),
        A.pct(n.qualRate || 0), A.money(n.cpl), A.money(n.cpql), A.n(n.visits), A.n(n.eoi)
      ];
      cells.forEach(v => {
        const td = document.createElement('td'); td.className = 'n'; td.textContent = v;
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    });
    table.appendChild(tb);
    scroll.appendChild(table);
    wrap.append(tools, scroll);
    el.appendChild(wrap);

    dl.onclick = () => {
      const head = 'Level,Project,Platform,Campaign,Spend,Leads,QL,TBD,Unqualified,QL rate %,CPL,CPQL,Visits,EOI,Method';
      const lines = [];
      dd.tree.forEach(p => {
        const push = (lvl, proj, plat, camp, n) => lines.push([lvl, proj, plat, camp,
          n.spend.toFixed(2), n.leads, n.qualified, n.tbd, n.unqualified,
          (n.qualRate || 0).toFixed(1), n.cpl === null ? '' : n.cpl.toFixed(2), n.cpql === null ? '' : n.cpql.toFixed(2),
          n.visits, n.eoi, n.method || ''
        ].map(v => { const t = String(v); return /[",]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; }).join(','));
        push('Project', p.key, '', '', p);
        p.children.forEach(pl => {
          push('Platform', p.key, pl.key, '', pl);
          pl.children.forEach(c => push('Campaign', p.key, pl.key, c.key, c));
        });
      });
      downloadFile('spend_drilldown.csv', head + '\n' + lines.join('\n'), 'text/csv');
    };
  }

  /* ---------- ASM dashboard ---------- */

  function renderAsm(ctx) {
    const keyFns = {
      asm: l => l.asm,
      team: l => l.team,
      chain: l => l.managers.filter(m => !/^(cug|hemant bajaj)$/i.test(m) && !/^team\b/i.test(m)),
      assignee: l => l.assignee,
      city: l => l.city
    };
    const rows = A.rollup(ctx.leads, keyFns[S.asmLevel]).filter(r => r.leads >= S.asmMinLeads);
    const f = A.funnel(ctx.leads);

    $('#asmKpis').innerHTML = [
      kpi('Leads', A.n(f.leads), `${A.n(rows.length)} owners above the volume floor`, '#3B76F0'),
      kpi('Qualified', A.n(f.qualified), A.pct(f.leadToQl || 0) + ' of leads', '#0E9F6E'),
      kpi('Site visits', A.n(f.visits), f.qualified ? A.pct(f.qlToVisit || 0) + ' of QL' : 'no QL yet', '#0891B2'),
      kpi('EOI', A.n(f.eoi), f.visits ? A.pct(f.visitToEoi || 0) + ' of visits' : 'no visits logged', '#7C4DFF'),
      kpi('Bookings', A.n(f.booked), A.pct(f.leadToBooking || 0) + ' of leads', '#D6202F'),
      kpi('Dead', A.n(f.dead), A.pct(A.ratio(f.dead, f.leads) || 0) + ' of leads', '#94A3B8')
    ].join('');

    const stages = [['Leads', f.leads], ['Contacted', f.contacted], ['Qualified', f.qualified], ['Site visit', f.visits], ['EOI', f.eoi], ['Booked', f.booked]];
    const max = Math.max(1, ...stages.map(x => x[1]));
    $('#asmFunnel').innerHTML = stages.map(([l, v]) => `
      <div class="fstage">
        <span class="flab">${l}</span>
        <span class="fbar" style="width:${Math.max(4, (v / max) * 100)}%">${A.n(v)}</span>
        <span class="fpct">${A.pct(A.ratio(v, f.leads) || 0, 1)}</span>
      </div>`).join('');

    const ratioCard = (label, num, den, denLabel) => {
      const v = A.ratio(num, den);
      const sub = den > 0 ? `${A.n(num)} of ${A.n(den)}` : `no ${denLabel} in this window`;
      return `<div class="ratio"><div class="r-l">${label}</div><div class="r-v">${v === null ? '—' : A.pct(v)}</div><div class="r-s">${sub}</div></div>`;
    };
    $('#asmRatios').innerHTML = [
      ratioCard('Lead to QL', f.qualified, f.leads, 'leads'),
      ratioCard('QL to visit', f.visits, f.qualified, 'qualified leads'),
      ratioCard('Visit to EOI', f.eoi, f.visits, 'site visits'),
      ratioCard('Lead to booking', f.booked, f.leads, 'leads')
    ].join('');

    $('#asmNote').textContent = `${A.n(rows.length)} rows with ${S.asmMinLeads}+ leads`;

    C.asmRatios(rows);
    C.asmVolume(rows);

    renderTable('#tblAsm', [
      { key: 'key', label: { asm: 'ASM', team: 'Team', chain: 'Manager', assignee: 'Owner', city: 'City' }[S.asmLevel] },
      { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'contacted', label: 'Contacted', num: true, fmt: v => A.n(v) },
      { key: 'qualified', label: 'QL', num: true, fmt: v => A.n(v) },
      { key: 'tbd', label: 'TBD', num: true, fmt: v => A.n(v) },
      { key: 'leadToQl', label: 'Lead → QL', num: true, fmt: v => A.pct(v || 0) },
      { key: 'visits', label: 'Visits', num: true, fmt: v => A.n(v) },
      { key: 'qlToVisit', label: 'QL → visit', num: true, fmt: v => (v === null ? '—' : A.pct(v)) },
      { key: 'eoi', label: 'EOI', num: true, fmt: v => A.n(v) },
      { key: 'visitToEoi', label: 'Visit → EOI', num: true, fmt: v => (v === null ? '—' : A.pct(v)) },
      { key: 'booked', label: 'Booked', num: true, fmt: v => A.n(v) },
      { key: 'deadRate', label: 'Dead rate', num: true, fmt: v => A.pct(v || 0) },
      { key: 'respMedian', label: 'Median response', num: true, fmt: v => (v === null ? '—' : v.toFixed(1) + ' h') },
      { key: 'projects', label: 'Projects', num: true, fmt: v => A.n(v) }
    ], rows, { sort: 'leads', fileName: 'asm_scorecard_' + S.asmLevel, searchPlaceholder: 'Search owners…' });
  }

  /* ---------- lead audit ---------- */

  function renderAudit(ctx) {
    const asOf = Math.max(...ctx.leads.map(l => l.lastActivityMs || l.createdMs || 0).filter(Boolean), 0) || Date.now();
    const res = PP.audit.run(ctx.leads, S.audit, asOf);
    const ownerFns = { assignee: l => l.assignee, asm: l => l.asm, team: l => l.team, project: l => l.project };
    const owners = PP.audit.byOwner(res, ownerFns[S.auditOwnerBy]);
    const mix = PP.audit.contactMix(ctx.leads);
    const sum = res.summary;

    $('#auditKpis').innerHTML = [
      kpi('Audit score', sum.score.toFixed(0), 'weighted across every open finding', sum.score >= 80 ? '#0E9F6E' : sum.score >= 60 ? '#D97706' : '#D6202F'),
      kpi('Leads audited', A.n(sum.leads), `as of ${new Date(res.now).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}`, '#3B76F0'),
      kpi('Critical', A.n(sum.critical), 'need action today', '#D6202F'),
      kpi('Major', A.n(sum.major), 'need action this week', '#D97706'),
      kpi('Clean records', A.n(sum.clean), A.pct(sum.cleanRate, 0) + ' of the book', '#0E9F6E'),
      kpi('Total breaches', A.n(sum.breaches), `${(sum.breaches / Math.max(1, sum.flagged)).toFixed(1)} per flagged lead`, '#7C4DFF'),
      kpi('Touches logged', A.n(mix.entries), `${mix.avgTouches.toFixed(1)} per lead · ${A.n(mix.connected)} connected`, '#2563EB'),
      kpi('No log at all', A.n(sum.leads - mix.logged), A.pct(A.ratio(sum.leads - mix.logged, sum.leads) || 0, 0) + ' of leads', '#94A3B8')
    ].join('');

    C.auditRules(res.byRule);
    C.contactMix(mix, PP.audit.TAG_LABEL);
    C.auditOwners(owners);

    renderTable('#tblAuditRules', [
      { key: 'sev', label: 'Severity', html: r => `<span class="tagpill ${r.sev === 'critical' ? 't-red' : r.sev === 'major' ? 't-amber' : 't-grey'}">${r.sev}</span>`, csv: r => r.sev },
      { key: 'label', label: 'Finding' },
      { key: 'count', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'share', label: 'Share of book', num: true, fmt: v => A.pct(v, 1) },
      { key: 'owners', label: 'Concentrated with' },
      { key: 'hint', label: 'What it means', html: r => `<span class="logline">${esc(r.hint)}</span>`, csv: r => r.hint }
    ], res.byRule, { sort: 'count', fileName: 'audit_rules' });

    renderTable('#tblAuditOwners', [
      { key: 'key', label: { assignee: 'Owner', asm: 'ASM', team: 'Team', project: 'Project' }[S.auditOwnerBy] },
      { key: 'score', label: 'Audit score', num: true, fmt: v => v.toFixed(0) },
      { key: 'leads', label: 'Leads', num: true, fmt: v => A.n(v) },
      { key: 'flagged', label: 'Flagged', num: true, fmt: v => A.n(v) },
      { key: 'flagRate', label: 'Flag rate', num: true, fmt: v => A.pct(v) },
      { key: 'critical', label: 'Critical', num: true, fmt: v => A.n(v) },
      { key: 'respRate', label: 'Contacted', num: true, fmt: v => A.pct(v) },
      { key: 'respMedian', label: 'Median response', num: true, fmt: v => (v === null ? '—' : v.toFixed(1) + ' h') },
      { key: 'qualRate', label: 'QL rate', num: true, fmt: v => A.pct(v) },
      { key: 'topIssue', label: 'Biggest issue' }
    ], owners, { sort: 'score', dir: 'asc', fileName: 'audit_by_' + S.auditOwnerBy, searchPlaceholder: 'Search…' });

    const list = res.rows.filter(x => S.auditSev.has(x.worst));
    $('#auditListNote').textContent = `${A.n(list.length)} leads in the selected severities`;
    renderTable('#tblAuditLeads', [
      { key: 'worst', label: 'Severity', html: r => `<span class="tagpill ${r.worst === 'critical' ? 't-red' : r.worst === 'major' ? 't-amber' : r.worst === 'minor' ? 't-grey' : 't-green'}">${r.worst}</span>`, csv: r => r.worst, sortVal: r => PP.audit.SEV_WEIGHT[r.worst] || 0 },
      { key: 'flagLabels', label: 'Findings', html: r => `<span class="logline">${esc(r.flagLabels || 'Clean')}</span>`, csv: r => r.flagLabels },
      { key: 'customer', label: 'Lead', fmt: (v, r) => r.lead.customer || r.lead.id, sortVal: r => r.lead.customer },
      { key: 'project', label: 'Project', fmt: (v, r) => r.lead.project, sortVal: r => r.lead.project },
      { key: 'owner', label: 'Owner', fmt: (v, r) => r.lead.assignee, sortVal: r => r.lead.assignee },
      { key: 'asm', label: 'ASM', fmt: (v, r) => r.lead.asm, sortVal: r => r.lead.asm },
      { key: 'status', label: 'Status', fmt: (v, r) => `${r.lead.status} · ${r.lead.qual}`, sortVal: r => r.lead.status },
      { key: 'created', label: 'Created', fmt: (v, r) => A.dayLabel(r.lead.date), sortVal: r => r.lead.createdMs },
      { key: 'resp', label: 'First response', num: true, fmt: (v, r) => (r.lead.respHrs === null ? 'none' : r.lead.respHrs.toFixed(1) + ' h'), sortVal: r => (r.lead.respHrs === null ? 1e9 : r.lead.respHrs) },
      { key: 'touches', label: 'Touches', num: true, fmt: (v, r) => A.n(r.lead.commentCount), sortVal: r => r.lead.commentCount },
      { key: 'nextCall', label: 'Next call', fmt: (v, r) => (r.lead.nextCall ? A.dayLabel(r.lead.nextCall) : '—'), sortVal: r => r.lead.nextCall || '' },
      { key: 'lastComment', label: 'Last comment', html: r => `<span class="cmtcell">${esc(r.lead.lastCommentText || '—')}</span>`, csv: r => r.lead.lastCommentText },
      { key: 'score', label: 'Score', num: true, fmt: v => v.toFixed(0) }
    ], list, { sort: 'worst', dir: 'desc', pageSize: 40, fileName: 'lead_audit_actions', searchPlaceholder: 'Search leads, owners, comments…' });
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

    $('#openUpload').onclick = goUploads;
    $('#openUpload2').onclick = goUploads;

    wireUploads();

    /* a file dropped anywhere else is routed to the right box by detection */
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', async e => {
      if (e.target.closest('.dropzone')) return;
      e.preventDefault();
      const files = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      if (!files.length) return;
      goUploads();
      for (const f of files) {
        if (/\.json$/i.test(f.name)) { await loadFiles('session', [f]); continue; }
        let text = '';
        try { text = await readOne(f); } catch (err) { showError(`${f.name}: ${err.message}`); continue; }
        if (PP.detectKind(text) === 'leads') { await loadFiles('leads', [f]); continue; }
        const n = f.name.toLowerCase();
        const slot = /meta|fb|facebook|insta/.test(n) ? 'meta' : /google|gads|adwords|search/.test(n) ? 'google' : null;
        if (slot) await loadFiles(slot, [f]);
        else toast(`${f.name}: drop spend files on the Google or Meta box so the platform is recorded`);
      }
    });

    $('#clearLeads').onclick = () => {
      S.leads = []; logUpload({ slot: 'CRM lead dump', file: '—', status: 'Cleared', note: 'Leads removed from memory' });
      rebuildFilters(); render();
    };
    $('#clearSpend').onclick = () => {
      S.spend = []; logUpload({ slot: 'Spend', file: '—', status: 'Cleared', note: 'Spend rows removed from memory' });
      render();
    };
    $('#clearEverything').onclick = () => {
      S.leads = []; S.spend = [];
      logUpload({ slot: 'All', file: '—', status: 'Cleared', note: 'Session emptied' });
      rebuildFilters(); render();
    };

    /* drill-down */
    $('#drillMode').onchange = e => { S.drillMode = e.target.value; render(); };
    $('#drillSearch').oninput = e => { S.drillSearch = e.target.value; render(); };
    $('#drillExpand').addEventListener('click', e => {
      const b = e.target.closest('.seg'); if (!b) return;
      $$('#drillExpand .seg').forEach(x => x.classList.remove('is-active'));
      b.classList.add('is-active');
      S.drillOpen = new Set();
      if (b.dataset.x === 'all') {
        A.buildDrilldown(filteredLeads(resolveRange()), filteredSpend(resolveRange()), S.drillMode)
          .tree.forEach(p => { S.drillOpen.add(p.key); p.children.forEach(pl => S.drillOpen.add(p.key + '||' + pl.key)); });
      }
      render();
    });

    /* ASM */
    $('#asmLevel').onchange = e => { S.asmLevel = e.target.value; render(); };
    $('#asmMinLeads').onchange = e => { S.asmMinLeads = Math.max(1, +e.target.value || 1); render(); };

    /* audit */
    const auditNum = (sel, key, min) => {
      $(sel).onchange = e => { S.audit[key] = Math.max(min, +e.target.value || min); render(); };
    };
    auditNum('#auSla', 'firstResponseHrs', 0.25);
    auditNum('#auStale', 'staleDays', 1);
    auditNum('#auTbd', 'tbdDays', 1);
    auditNum('#auAttempts', 'minAttempts', 1);
    $('#auOwner').onchange = e => { S.auditOwnerBy = e.target.value; render(); };
    $('#auditSevChips').addEventListener('click', e => {
      const b = e.target.closest('.chip'); if (!b) return;
      b.classList.toggle('is-active');
      S.auditSev = new Set($$('#auditSevChips .chip.is-active').map(x => x.dataset.s));
      render();
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
      const payload = { savedAt: new Date().toISOString(), leads: S.leads, spend: S.spend, uploadLog: S.uploadLog };
      downloadFile(`pp_session_${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload), 'application/json');
      toast('Session file downloaded');
    };
    $('#loadSessionBtn').onclick = () => $('#loadSession').click();
    $('#loadSession').onchange = async e => {
      await loadFiles('session', e.target.files);
      e.target.value = '';
    };

    $('#menuToggle').onclick = () => $('#sidebar').classList.toggle('open');
    document.addEventListener('click', () => $$('.mspop').forEach(p => p.classList.remove('open')));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.mspop').forEach(p => p.classList.remove('open')); });
    window.addEventListener('resize', () => { clearTimeout(window.__rz); window.__rz = setTimeout(render, 250); });
  }

  /* ---------------- boot ---------------- */

  document.addEventListener('DOMContentLoaded', async () => {
    window.addEventListener('error', e => showError('Script error: ' + (e.message || 'unknown')));
    window.addEventListener('unhandledrejection', e => showError('Unhandled failure: ' + ((e.reason && e.reason.message) || e.reason || 'unknown')));
    try { bind(); }
    catch (e) {
      showError('Setup failed: ' + e.message);
      try { wireUploads(); } catch (e2) { /* zones are the last thing worth saving */ }
    }
    const loaded = await autoLoad();
    if (loaded) { rebuildFilters(); toast('Loaded files from the repo'); }
    safeRender();
  });
})();
