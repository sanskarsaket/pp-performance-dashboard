/* charts.js — Chart.js defaults and reusable builders */

const PP = window.PP || (window.PP = {});
const C = (PP.charts = {});
const A = PP.an;

const COL = {
  google: '#3B76F0',
  meta: '#7C4DFF',
  other: '#94A3B8',
  brand: '#D6202F',
  ink: '#0E1726',
  ok: '#0E9F6E',
  warn: '#D97706',
  info: '#2563EB',
  line: '#E4E9F2',
  muted: '#64748B'
};
C.COL = COL;
C.SERIES = ['#3B76F0', '#7C4DFF', '#0E9F6E', '#D97706', '#D6202F', '#0891B2', '#DB2777', '#65A30D', '#475569', '#F97316'];

Chart.defaults.font.family = "Inter, system-ui, sans-serif";
Chart.defaults.font.size = 11;
Chart.defaults.color = COL.muted;
Chart.defaults.plugins.legend.labels.usePointStyle = true;
Chart.defaults.plugins.legend.labels.boxWidth = 7;
Chart.defaults.plugins.legend.labels.boxHeight = 7;
Chart.defaults.plugins.legend.labels.padding = 14;
Chart.defaults.plugins.tooltip.backgroundColor = 'rgba(14,23,38,.94)';
Chart.defaults.plugins.tooltip.padding = 10;
Chart.defaults.plugins.tooltip.cornerRadius = 8;
Chart.defaults.plugins.tooltip.titleFont = { size: 12, weight: '600' };
Chart.defaults.plugins.tooltip.bodyFont = { size: 12 };
Chart.defaults.maintainAspectRatio = false;

const registry = {};
C.render = function (id, config) {
  const el = document.getElementById(id);
  if (!el) return null;
  if (registry[id]) { registry[id].destroy(); delete registry[id]; }
  registry[id] = new Chart(el.getContext('2d'), config);
  return registry[id];
};
C.destroyAll = function () {
  Object.keys(registry).forEach(k => { registry[k].destroy(); delete registry[k]; });
};

const gridX = { grid: { display: false }, ticks: { maxRotation: 0, autoSkipPadding: 12 } };
const gridY = v => ({
  grid: { color: COL.line, drawBorder: false },
  border: { display: false },
  ticks: { callback: v || (x => A.n(x)) },
  beginAtZero: true
});
C.gridX = gridX;
C.gridY = gridY;

/* ---------- builders ---------- */

C.spendVsLeads = function (daily) {
  const labels = daily.map(r => A.dayLabel(r.date));
  return C.render('chSpendLeads', {
    data: {
      labels,
      datasets: [
        { type: 'bar', label: 'Google spend', data: daily.map(r => r.google), backgroundColor: COL.google, stack: 's', borderRadius: 3, yAxisID: 'y' },
        { type: 'bar', label: 'Meta spend', data: daily.map(r => r.meta), backgroundColor: COL.meta, stack: 's', borderRadius: 3, yAxisID: 'y' },
        { type: 'bar', label: 'Other spend', data: daily.map(r => r.other), backgroundColor: COL.other, stack: 's', borderRadius: 3, yAxisID: 'y', hidden: A.sum(daily.map(r => r.other)) === 0 },
        { type: 'line', label: 'Leads', data: daily.map(r => r.leads), borderColor: COL.brand, backgroundColor: COL.brand, tension: .35, borderWidth: 2.4, pointRadius: 2, pointHoverRadius: 5, yAxisID: 'y1' }
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: gridX,
        y: { ...gridY(v => A.moneyShort(v)), stacked: true, title: { display: true, text: 'Spend' } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, title: { display: true, text: 'Leads' } }
      },
      plugins: {
        tooltip: {
          callbacks: {
            label: c => c.dataset.yAxisID === 'y1'
              ? `${c.dataset.label}: ${A.n(c.parsed.y)}`
              : `${c.dataset.label}: ${A.money(c.parsed.y)}`
          }
        }
      }
    }
  });
};

C.donut = function (id, labels, values, colors) {
  return C.render(id, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderWidth: 2, borderColor: '#fff', hoverOffset: 6 }] },
    options: {
      cutout: '62%',
      plugins: {
        legend: { position: 'bottom' },
        tooltip: {
          callbacks: {
            label: c => {
              const tot = c.dataset.data.reduce((a, b) => a + b, 0);
              return `${c.label}: ${A.money(c.parsed)} (${tot ? ((c.parsed / tot) * 100).toFixed(1) : 0}%)`;
            }
          }
        }
      }
    }
  });
};

C.cplTrend = function (daily) {
  const labels = daily.map(r => A.dayLabel(r.date));
  const cpl = daily.map(r => (r.cpl !== null && isFinite(r.cpl) ? r.cpl : null));
  const roll = A.rolling(cpl.map(v => (v === null ? NaN : v)).map(v => (isNaN(v) ? null : v)).map(v => v), 7);
  return C.render('chCPL', {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Daily CPL', data: cpl, borderColor: COL.brand, backgroundColor: 'rgba(214,32,47,.08)', fill: true, tension: .3, borderWidth: 2, pointRadius: 2, spanGaps: true },
        { label: '7-day average', data: roll, borderColor: COL.ink, borderDash: [5, 4], borderWidth: 1.6, pointRadius: 0, tension: .3, spanGaps: true }
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: gridX, y: gridY(v => A.moneyShort(v)) },
      plugins: { tooltip: { callbacks: { label: c => `${c.dataset.label}: ${A.money(c.parsed.y)}` } } }
    }
  });
};

C.statusMix = function (leads) {
  const g = A.groupLeads(leads, l => l.status);
  return C.render('chStatusMix', {
    type: 'bar',
    data: {
      labels: g.map(x => x.key),
      datasets: [
        { label: 'Qualified', data: g.map(x => x.qualified), backgroundColor: COL.ok, stack: 'a', borderRadius: 3 },
        { label: 'TBD', data: g.map(x => x.tbd), backgroundColor: COL.google, stack: 'a', borderRadius: 3 },
        { label: 'Unqualified', data: g.map(x => x.unqualified), backgroundColor: COL.other, stack: 'a', borderRadius: 3 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: { ...gridY(), stacked: true }, y: { stacked: true, grid: { display: false }, border: { display: false } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
};

C.topProjects = function (leads, n = 8) {
  const g = A.groupLeads(leads, l => l.project).slice(0, n);
  return C.render('chTopProjects', {
    type: 'bar',
    data: {
      labels: g.map(x => (x.key.length > 30 ? x.key.slice(0, 29) + '…' : x.key)),
      datasets: [
        { label: 'Leads', data: g.map(x => x.leads), backgroundColor: COL.google, borderRadius: 3 },
        { label: 'Qualified', data: g.map(x => x.qualified), backgroundColor: COL.ok, borderRadius: 3 }
      ]
    },
    options: {
      indexAxis: 'y',
      scales: { x: gridY(), y: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10.5 } } } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
};

C.platDaily = function (daily) {
  return C.render('chPlatDaily', {
    type: 'bar',
    data: {
      labels: daily.map(r => A.dayLabel(r.date)),
      datasets: [
        { label: 'Google', data: daily.map(r => r.google), backgroundColor: COL.google, borderRadius: 3 },
        { label: 'Meta', data: daily.map(r => r.meta), backgroundColor: COL.meta, borderRadius: 3 },
        { label: 'Other', data: daily.map(r => r.other), backgroundColor: COL.other, borderRadius: 3, hidden: A.sum(daily.map(r => r.other)) === 0 }
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: gridX, y: gridY(v => A.moneyShort(v)) },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${A.money(c.parsed.y)}` } } }
    }
  });
};

C.platShare = function (daily) {
  const share = (a, t) => (t > 0 ? (a / t) * 100 : 0);
  return C.render('chPlatShare', {
    type: 'line',
    data: {
      labels: daily.map(r => A.dayLabel(r.date)),
      datasets: [
        { label: 'Google', data: daily.map(r => share(r.google, r.spend)), borderColor: COL.google, backgroundColor: 'rgba(59,118,240,.55)', fill: 'origin', stack: 'a', tension: .3, pointRadius: 0, borderWidth: 1.5 },
        { label: 'Meta', data: daily.map(r => share(r.meta, r.spend)), borderColor: COL.meta, backgroundColor: 'rgba(124,77,255,.55)', fill: '-1', stack: 'a', tension: .3, pointRadius: 0, borderWidth: 1.5 }
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: gridX, y: { ...gridY(v => v + '%'), max: 100, stacked: true } },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${c.parsed.y.toFixed(1)}%` } } }
    }
  });
};

C.platCumulative = function (daily) {
  let g = 0, m = 0;
  const gc = [], mc = [];
  daily.forEach(r => { g += r.google; m += r.meta; gc.push(g); mc.push(m); });
  return C.render('chPlatCum', {
    type: 'line',
    data: {
      labels: daily.map(r => A.dayLabel(r.date)),
      datasets: [
        { label: 'Google', data: gc, borderColor: COL.google, backgroundColor: 'rgba(59,118,240,.10)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 },
        { label: 'Meta', data: mc, borderColor: COL.meta, backgroundColor: 'rgba(124,77,255,.10)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2 }
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: gridX, y: gridY(v => A.moneyShort(v)) },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${A.money(c.parsed.y)}` } } }
    }
  });
};

C.platDow = function (daily) {
  const buckets = A.DOW_NAMES.map(() => ({ g: [], m: [] }));
  daily.forEach(r => { const b = buckets[A.dow(r.date)]; b.g.push(r.google); b.m.push(r.meta); });
  return C.render('chPlatDow', {
    type: 'bar',
    data: {
      labels: A.DOW_NAMES,
      datasets: [
        { label: 'Google', data: buckets.map(b => A.mean(b.g)), backgroundColor: COL.google, borderRadius: 3 },
        { label: 'Meta', data: buckets.map(b => A.mean(b.m)), backgroundColor: COL.meta, borderRadius: 3 }
      ]
    },
    options: {
      scales: { x: gridX, y: gridY(v => A.moneyShort(v)) },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${A.money(c.parsed.y)}` } } }
    }
  });
};

C.bubble = function (groups) {
  const top = groups.slice(0, 14);
  const maxQ = Math.max(1, ...top.map(g => g.qualified));
  return C.render('chBubble', {
    type: 'bubble',
    data: {
      datasets: top.map((g, i) => ({
        label: g.key.length > 26 ? g.key.slice(0, 25) + '…' : g.key,
        data: [{ x: g.leads, y: g.qualRate || 0, r: 6 + (g.qualified / maxQ) * 18 }],
        backgroundColor: C.SERIES[i % C.SERIES.length] + 'CC',
        borderColor: C.SERIES[i % C.SERIES.length]
      }))
    },
    options: {
      scales: {
        x: { ...gridY(), title: { display: true, text: 'Leads' } },
        y: { ...gridY(v => v + '%'), title: { display: true, text: 'Qualification rate' } }
      },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${A.n(c.parsed.x)} leads · ${c.parsed.y.toFixed(1)}% qualified` } }
      }
    }
  });
};

C.qualRank = function (groups) {
  const g = groups.filter(x => x.leads >= 5).sort((a, b) => (b.qualRate || 0) - (a.qualRate || 0)).slice(0, 12);
  return C.render('chQualRank', {
    type: 'bar',
    data: {
      labels: g.map(x => (x.key.length > 28 ? x.key.slice(0, 27) + '…' : x.key)),
      datasets: [{
        label: 'Qualification rate',
        data: g.map(x => x.qualRate || 0),
        backgroundColor: g.map(x => ((x.qualRate || 0) >= 10 ? COL.ok : (x.qualRate || 0) >= 5 ? COL.warn : COL.other)),
        borderRadius: 3
      }]
    },
    options: {
      indexAxis: 'y',
      scales: { x: gridY(v => v + '%'), y: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10.5 } } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `${c.parsed.x.toFixed(1)}% qualified` } } }
    }
  });
};

C.trend = function (rows, metrics, isWeek) {
  const defs = {
    spend: { label: 'Spend', color: COL.google, axis: 'y', fmt: A.money },
    leads: { label: 'Leads', color: COL.brand, axis: 'y1', fmt: A.n },
    qualified: { label: 'Qualified', color: COL.ok, axis: 'y1', fmt: A.n },
    cpl: { label: 'CPL', color: COL.warn, axis: 'y', fmt: A.money },
    cpql: { label: 'CPQL', color: COL.meta, axis: 'y', fmt: A.money }
  };
  const ds = metrics.map(m => {
    const d = defs[m];
    return {
      label: d.label, data: rows.map(r => (r[m] === null || !isFinite(r[m]) ? null : r[m])),
      borderColor: d.color, backgroundColor: d.color, yAxisID: d.axis,
      tension: .3, borderWidth: 2.2, pointRadius: 2.5, pointHoverRadius: 5, spanGaps: true
    };
  });
  return C.render('chTrend', {
    type: 'line',
    data: { labels: rows.map(r => (isWeek ? r.label : A.dayLabel(r.date))), datasets: ds },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: gridX,
        y: { ...gridY(v => A.moneyShort(v)), position: 'left', title: { display: true, text: 'Rupees' } },
        y1: { position: 'right', beginAtZero: true, grid: { display: false }, border: { display: false }, title: { display: true, text: 'Count' } }
      },
      plugins: {
        legend: { position: 'bottom' },
        tooltip: { callbacks: { label: c => `${c.dataset.label}: ${defs[metrics[c.datasetIndex]].fmt(c.parsed.y)}` } }
      }
    }
  });
};

C.pacing = function (daily) {
  let cum = 0;
  const cumSpend = daily.map(r => (cum += r.spend));
  const avg = daily.length ? cum / daily.length : 0;
  const straight = daily.map((_, i) => avg * (i + 1));
  return C.render('chPacing', {
    type: 'line',
    data: {
      labels: daily.map(r => A.dayLabel(r.date)),
      datasets: [
        { label: 'Cumulative spend', data: cumSpend, borderColor: COL.google, backgroundColor: 'rgba(59,118,240,.10)', fill: true, tension: .25, pointRadius: 0, borderWidth: 2.2 },
        { label: 'Even pace', data: straight, borderColor: COL.muted, borderDash: [5, 4], pointRadius: 0, borderWidth: 1.5 }
      ]
    },
    options: {
      interaction: { mode: 'index', intersect: false },
      scales: { x: gridX, y: gridY(v => A.moneyShort(v)) },
      plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: c => `${c.dataset.label}: ${A.money(c.parsed.y)}` } } }
    }
  });
};

C.lagChart = function (lags) {
  return C.render('chLag', {
    type: 'bar',
    data: {
      labels: lags.map(l => (l.lag === 0 ? 'Same day' : `+${l.lag} day${l.lag > 1 ? 's' : ''}`)),
      datasets: [{
        label: 'Correlation',
        data: lags.map(l => (l.r === null ? 0 : l.r)),
        backgroundColor: lags.map(l => (l.r === null ? COL.other : l.r >= .5 ? COL.ok : l.r >= .25 ? COL.warn : COL.other)),
        borderRadius: 4
      }]
    },
    options: {
      scales: { x: gridX, y: { grid: { color: COL.line }, border: { display: false }, min: -1, max: 1, ticks: { callback: v => v.toFixed(1) } } },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => `r = ${c.parsed.y.toFixed(2)}` } } }
    }
  });
};

C.subStatus = function (leads) {
  const g = A.groupLeads(leads, l => l.subStatus).slice(0, 12);
  return C.render('chSubStatus', {
    type: 'bar',
    data: {
      labels: g.map(x => (x.key.length > 26 ? x.key.slice(0, 25) + '…' : x.key)),
      datasets: [{ label: 'Leads', data: g.map(x => x.leads), backgroundColor: COL.google, borderRadius: 3 }]
    },
    options: {
      indexAxis: 'y',
      scales: { x: gridY(), y: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10.5 } } } },
      plugins: { legend: { display: false } }
    }
  });
};

C.deadReasons = function (leads) {
  const dead = leads.filter(l => l.dead);
  const g = A.groupLeads(dead, l => l.deadReason || l.subStatus || 'Unspecified').slice(0, 10);
  return C.render('chDead', {
    type: 'bar',
    data: {
      labels: g.map(x => (x.key.length > 26 ? x.key.slice(0, 25) + '…' : x.key)),
      datasets: [{ label: 'Dead leads', data: g.map(x => x.leads), backgroundColor: COL.brand, borderRadius: 3 }]
    },
    options: {
      indexAxis: 'y',
      scales: { x: gridY(), y: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10.5 } } } },
      plugins: { legend: { display: false } }
    }
  });
};

C.responseTime = function (leads) {
  const buckets = [
    { label: 'Under 15 min', test: h => h < .25 },
    { label: '15–60 min', test: h => h >= .25 && h < 1 },
    { label: '1–4 hours', test: h => h >= 1 && h < 4 },
    { label: '4–24 hours', test: h => h >= 4 && h < 24 },
    { label: 'Over 24 hours', test: h => h >= 24 }
  ];
  const vals = buckets.map(b => leads.filter(l => l.respHrs !== null && b.test(l.respHrs)).length);
  const none = leads.filter(l => !l.responded).length;
  return C.render('chResponse', {
    type: 'bar',
    data: {
      labels: [...buckets.map(b => b.label), 'No follow-up yet'],
      datasets: [{
        label: 'Leads',
        data: [...vals, none],
        backgroundColor: [COL.ok, COL.ok, COL.google, COL.warn, COL.brand, COL.other],
        borderRadius: 3
      }]
    },
    options: { scales: { x: gridX, y: gridY() }, plugins: { legend: { display: false } } }
  });
};

C.cityQual = function (leads) {
  const g = A.groupLeads(leads, l => l.city).slice(0, 10);
  return C.render('chCityQual', {
    type: 'bar',
    data: {
      labels: g.map(x => x.key),
      datasets: [
        { label: 'Qualified', data: g.map(x => x.qualified), backgroundColor: COL.ok, stack: 'a', borderRadius: 3 },
        { label: 'TBD', data: g.map(x => x.tbd), backgroundColor: COL.google, stack: 'a', borderRadius: 3 },
        { label: 'Unqualified', data: g.map(x => x.unqualified), backgroundColor: COL.other, stack: 'a', borderRadius: 3 }
      ]
    },
    options: {
      scales: { x: { ...gridX, stacked: true }, y: { ...gridY(), stacked: true } },
      plugins: { legend: { position: 'bottom' } }
    }
  });
};
