/* analytics.js — aggregation, statistics and pattern detection */

const PP = window.PP || (window.PP = {});
const A = (PP.an = {});

/* ---------------- formatting ---------------- */

const inr = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
const inr1 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });

A.money = v => (v === null || v === undefined || !isFinite(v) ? '—' : '₹' + inr.format(Math.round(v)));
A.moneyShort = v => {
  if (!isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e7) return '₹' + inr1.format(v / 1e7) + ' Cr';
  if (a >= 1e5) return '₹' + inr1.format(v / 1e5) + ' L';
  if (a >= 1e3) return '₹' + inr1.format(v / 1e3) + 'K';
  return '₹' + inr.format(Math.round(v));
};
A.n = v => (isFinite(v) ? inr.format(Math.round(v)) : '—');
A.pct = (v, d = 1) => (isFinite(v) ? v.toFixed(d) + '%' : '—');
A.ratio = (a, b) => (b > 0 ? (a / b) * 100 : null);
A.cost = (spend, count) => (count > 0 ? spend / count : null);
A.dayLabel = iso => {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
};
A.dow = iso => new Date(iso + 'T00:00:00').getDay();
A.DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/* ---------------- date helpers ---------------- */

A.addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
A.dateRange = (from, to) => {
  const out = [];
  if (!from || !to || from > to) return out;
  let c = from;
  let guard = 0;
  while (c <= to && guard++ < 2000) { out.push(c); c = A.addDays(c, 1); }
  return out;
};
A.weekKey = iso => {
  const d = new Date(iso + 'T00:00:00');
  const day = (d.getDay() + 6) % 7;          // Monday = 0
  d.setDate(d.getDate() - day);
  return d.toISOString().slice(0, 10);        // Monday of that week
};
A.weekLabel = mondayIso => {
  const end = A.addDays(mondayIso, 6);
  return A.dayLabel(mondayIso) + ' – ' + A.dayLabel(end);
};

/* ---------------- statistics ---------------- */

A.sum = arr => arr.reduce((a, b) => a + (isFinite(b) ? b : 0), 0);
A.mean = arr => (arr.length ? A.sum(arr) / arr.length : 0);
A.median = arr => {
  const v = arr.filter(isFinite).slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
A.stdev = arr => {
  if (arr.length < 2) return 0;
  const m = A.mean(arr);
  return Math.sqrt(A.sum(arr.map(v => (v - m) ** 2)) / (arr.length - 1));
};
A.zScores = arr => {
  const m = A.mean(arr), s = A.stdev(arr);
  return arr.map(v => (s > 0 ? (v - m) / s : 0));
};
A.rolling = (arr, w) => arr.map((_, i) => {
  const s = Math.max(0, i - w + 1);
  const win = arr.slice(s, i + 1).filter(isFinite);
  return win.length ? A.mean(win) : null;
});
A.pearson = (x, y) => {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const xs = x.slice(0, n), ys = y.slice(0, n);
  const mx = A.mean(xs), my = A.mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : null;
};
A.slope = arr => {
  const n = arr.length;
  if (n < 3) return null;
  const xs = arr.map((_, i) => i);
  const mx = A.mean(xs), my = A.mean(arr);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (arr[i] - my); den += (xs[i] - mx) ** 2; }
  return den > 0 ? num / den : null;
};

/* ---------------- core aggregation ---------------- */

/* Build one row per calendar day inside the window. */
A.buildDaily = function (leads, spend, from, to) {
  const days = A.dateRange(from, to);
  const map = new Map();
  days.forEach(d => map.set(d, {
    date: d, google: 0, meta: 0, other: 0, spend: 0,
    leads: 0, qualified: 0, unqualified: 0, tbd: 0, dead: 0,
    gLeads: 0, mLeads: 0, oLeads: 0, responded: 0, visits: 0
  }));

  spend.forEach(s => {
    const r = map.get(s.date); if (!r) return;
    if (s.platform === 'Google') r.google += s.cost;
    else if (s.platform === 'Meta') r.meta += s.cost;
    else r.other += s.cost;
    r.spend += s.cost;
  });

  leads.forEach(l => {
    const r = map.get(l.date); if (!r) return;
    r.leads++;
    if (l.qualified) r.qualified++;
    else if (l.unqualified) r.unqualified++;
    else r.tbd++;
    if (l.dead) r.dead++;
    if (l.responded) r.responded++;
    if (l.visited) r.visits++;
    if (l.platform === 'Google') r.gLeads++;
    else if (l.platform === 'Meta') r.mLeads++;
    else r.oLeads++;
  });

  const rows = days.map(d => {
    const r = map.get(d);
    r.cpl = r.spend > 0 ? A.cost(r.spend, r.leads) : null;
    r.cpql = r.spend > 0 ? A.cost(r.spend, r.qualified) : null;
    r.qualRate = A.ratio(r.qualified, r.leads);
    r.taggedLeads = r.gLeads + r.mLeads;
    return r;
  });
  return rows;
};

/* Roll daily rows into ISO weeks. */
A.toWeekly = function (daily) {
  const map = new Map();
  daily.forEach(r => {
    const k = A.weekKey(r.date);
    if (!map.has(k)) map.set(k, {
      date: k, label: A.weekLabel(k), days: 0,
      google: 0, meta: 0, other: 0, spend: 0,
      leads: 0, qualified: 0, unqualified: 0, tbd: 0, dead: 0, responded: 0, visits: 0
    });
    const w = map.get(k);
    w.days++;
    ['google', 'meta', 'other', 'spend', 'leads', 'qualified', 'unqualified', 'tbd', 'dead', 'responded', 'visits']
      .forEach(k2 => { w[k2] += r[k2]; });
  });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date)).map(w => {
    w.cpl = w.spend > 0 ? A.cost(w.spend, w.leads) : null;
    w.cpql = w.spend > 0 ? A.cost(w.spend, w.qualified) : null;
    w.qualRate = A.ratio(w.qualified, w.leads);
    return w;
  });
};

/* Group leads by any dimension; spend joins only where attributable. */
A.groupLeads = function (leads, keyFn, spendByKey) {
  const map = new Map();
  leads.forEach(l => {
    const k = keyFn(l) || 'Unmapped';
    if (!map.has(k)) map.set(k, {
      key: k, leads: 0, qualified: 0, unqualified: 0, tbd: 0, dead: 0,
      visits: 0, responded: 0, resp: [], platforms: new Set(), cities: new Set()
    });
    const g = map.get(k);
    g.leads++;
    if (l.qualified) g.qualified++; else if (l.unqualified) g.unqualified++; else g.tbd++;
    if (l.dead) g.dead++;
    if (l.visited) g.visits++;
    if (l.responded) g.responded++;
    if (l.respHrs !== null) g.resp.push(l.respHrs);
    g.platforms.add(l.platform);
    g.cities.add(l.city);
  });
  return [...map.values()].map(g => {
    g.spend = spendByKey ? (spendByKey.get(g.key) || 0) : 0;
    g.cpl = A.cost(g.spend, g.leads);
    g.cpql = A.cost(g.spend, g.qualified);
    g.qualRate = A.ratio(g.qualified, g.leads);
    g.deadRate = A.ratio(g.dead, g.leads);
    g.respMedian = A.median(g.resp);
    g.platformList = [...g.platforms].join(', ');
    g.cityList = [...g.cities].slice(0, 3).join(', ');
    return g;
  }).sort((a, b) => b.leads - a.leads);
};

/* Totals for the current window. */
A.totals = function (daily, leads) {
  const t = {
    spend: A.sum(daily.map(r => r.spend)),
    google: A.sum(daily.map(r => r.google)),
    meta: A.sum(daily.map(r => r.meta)),
    other: A.sum(daily.map(r => r.other)),
    leads: leads.length,
    qualified: leads.filter(l => l.qualified).length,
    unqualified: leads.filter(l => l.unqualified).length,
    dead: leads.filter(l => l.dead).length,
    visits: leads.filter(l => l.visited).length,
    responded: leads.filter(l => l.responded).length,
    attributed: leads.filter(l => l.attributed).length,
    activeDays: daily.filter(r => r.spend > 0).length,
    days: daily.length
  };
  t.tbd = t.leads - t.qualified - t.unqualified;
  t.cpl = A.cost(t.spend, t.leads);
  t.cpql = A.cost(t.spend, t.qualified);
  t.qualRate = A.ratio(t.qualified, t.leads);
  t.deadRate = A.ratio(t.dead, t.leads);
  t.respRate = A.ratio(t.responded, t.leads);
  t.attrRate = A.ratio(t.attributed, t.leads);
  t.tagged = leads.filter(l => l.platform === 'Google' || l.platform === 'Meta').length;
  t.taggedQualified = leads.filter(l => (l.platform === 'Google' || l.platform === 'Meta') && l.qualified).length;
  t.taggedCpl = A.cost(t.spend, t.tagged);
  t.taggedRate = A.ratio(t.tagged, t.leads);
  t.respMedian = A.median(leads.map(l => l.respHrs).filter(v => v !== null));
  t.avgDailySpend = t.days ? t.spend / t.days : 0;
  return t;
};

/* ---------------- pattern detection ---------------- */

A.anomalies = function (daily) {
  const out = [];
  const metrics = [
    { k: 'spend', label: 'Spend', fmt: A.money },
    { k: 'leads', label: 'Leads', fmt: A.n },
    { k: 'cpl', label: 'CPL', fmt: A.money }
  ];
  metrics.forEach(m => {
    const rows = daily.filter(r => (m.k === 'cpl' ? r.cpl !== null && isFinite(r.cpl) : true));
    const vals = rows.map(r => r[m.k] || 0);
    if (vals.length < 5) return;
    const z = A.zScores(vals);
    const avg = A.mean(vals);
    rows.forEach((r, i) => {
      if (Math.abs(z[i]) >= 2) {
        out.push({
          date: r.date, metric: m.label, value: m.fmt(r[m.k]),
          baseline: m.fmt(avg), z: z[i], direction: z[i] > 0 ? 'above' : 'below'
        });
      }
    });
  });
  return out.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));
};

A.lagCorrelation = function (daily) {
  const spend = daily.map(r => r.spend);
  const leads = daily.map(r => r.leads);
  const out = [];
  for (let lag = 0; lag <= 3; lag++) {
    const s = spend.slice(0, spend.length - lag);
    const l = leads.slice(lag);
    out.push({ lag, r: A.pearson(s, l) });
  }
  return out;
};

A.dowIndex = function (daily) {
  const buckets = A.DOW_NAMES.map(() => ({ spend: [], leads: [], cpl: [], qual: [] }));
  daily.forEach(r => {
    const b = buckets[A.dow(r.date)];
    b.spend.push(r.spend);
    b.leads.push(r.leads);
    if (r.cpl !== null && isFinite(r.cpl)) b.cpl.push(r.cpl);
    if (r.qualRate !== null) b.qual.push(r.qualRate);
  });
  const avg = k => A.mean(buckets.flatMap(b => b[k]));
  const base = { spend: avg('spend'), leads: avg('leads'), cpl: avg('cpl'), qual: avg('qual') };
  return {
    base,
    rows: ['spend', 'leads', 'cpl', 'qual'].map(k => ({
      metric: k,
      cells: buckets.map(b => {
        const v = b[k].length ? A.mean(b[k]) : null;
        return { value: v, index: v !== null && base[k] > 0 ? (v / base[k]) * 100 : null, n: b[k].length };
      })
    }))
  };
};

A.qualityOutliers = function (leads, minLeads = 10) {
  const groups = A.groupLeads(leads, l => l.project);
  const overall = A.ratio(leads.filter(l => l.qualified).length, leads.length) || 0;
  return groups
    .filter(g => g.leads >= minLeads)
    .map(g => ({ ...g, delta: (g.qualRate || 0) - overall, benchmark: overall }))
    .sort((a, b) => b.delta - a.delta);
};

/* Narrative insight feed. */
A.insights = function (ctx) {
  const { daily, weekly, leads, totals, cplThreshold } = ctx;
  const out = [];
  const push = (sev, title, detail) => out.push({ sev, title, detail });

  if (!daily.length) return out;

  /* CPL against the red line */
  if (totals.leads > 0 && totals.spend > 0) {
    if (totals.cpl > cplThreshold) {
      push('critical', 'Blended CPL is above the red line',
        `Window CPL is <em>${A.money(totals.cpl)}</em> against a <em>${A.money(cplThreshold)}</em> threshold on ${A.n(totals.leads)} leads.`);
    } else {
      push('good', 'Blended CPL is inside the red line',
        `Window CPL is <em>${A.money(totals.cpl)}</em> against a <em>${A.money(cplThreshold)}</em> threshold.`);
    }
  }

  /* Cost per qualified lead */
  if (totals.qualified > 0) {
    push(totals.cpql > cplThreshold * 3 ? 'watch' : 'info', 'Cost per qualified lead',
      `<em>${A.money(totals.cpql)}</em> across ${A.n(totals.qualified)} qualified leads — a ${A.pct(totals.qualRate)} qualification rate.`);
  } else if (totals.spend > 0 && totals.leads > 0) {
    push('critical', 'No qualified leads in this window',
      `${A.money(totals.spend)} spent and ${A.n(totals.leads)} leads captured, but none marked qualified yet. Most are still TBD.`);
  }

  /* attribution coverage */
  if (totals.leads > 0 && totals.attrRate < 60) {
    push('watch', 'Campaign attribution is thin',
      `Only <em>${A.pct(totals.attrRate)}</em> of leads carry a campaign tag, so platform-level CPL covers a fraction of volume. Blended CPL is the reliable number here.`);
  }

  /* dominant untagged source */
  if (totals.leads > 0 && totals.taggedRate < 40) {
    const bySource = A.groupLeads(leads.filter(l => l.platform === 'Other'), l => l.source);
    if (bySource.length) {
      const top = bySource[0];
      const share = A.ratio(top.leads, totals.leads);
      if (share >= 40) {
        push('watch', `${top.key} is the dominant lead source`,
          `<em>${A.pct(share, 0)}</em> of leads in this window come from ${top.key}, which carries no platform tag. Blended CPL spreads ad spend across leads the ads did not produce — treat it as directional, and use the platform filter to isolate paid volume.`);
      }
    }
  }

  /* zero-spend days */
  const zeroDays = daily.filter(r => r.spend === 0);
  if (zeroDays.length) {
    push('watch', `${zeroDays.length} day${zeroDays.length > 1 ? 's' : ''} with zero spend`,
      `No spend recorded on ${zeroDays.slice(0, 5).map(r => A.dayLabel(r.date)).join(', ')}${zeroDays.length > 5 ? ' and others' : ''}. Check for budget exhaustion or paused campaigns.`);
  }

  /* spend without leads */
  const dryDays = daily.filter(r => r.spend > 0 && r.leads === 0);
  if (dryDays.length) {
    const wasted = A.sum(dryDays.map(r => r.spend));
    push('critical', 'Spend on days with no leads',
      `<em>${A.money(wasted)}</em> across ${dryDays.length} day${dryDays.length > 1 ? 's' : ''} produced nothing in the CRM. Either the lead file is short of those dates or delivery is broken.`);
  }

  /* week on week */
  if (weekly.length >= 2) {
    const cur = weekly[weekly.length - 1], prev = weekly[weekly.length - 2];
    const dSpend = prev.spend > 0 ? ((cur.spend - prev.spend) / prev.spend) * 100 : null;
    const dLeads = prev.leads > 0 ? ((cur.leads - prev.leads) / prev.leads) * 100 : null;
    if (dLeads !== null && Math.abs(dLeads) >= 15) {
      push(dLeads < 0 ? 'critical' : 'good', `Lead volume ${dLeads < 0 ? 'dropped' : 'rose'} week on week`,
        `${A.n(cur.leads)} leads this week versus ${A.n(prev.leads)} last — a <em>${A.pct(Math.abs(dLeads), 0)}</em> ${dLeads < 0 ? 'fall' : 'rise'}${dSpend !== null ? ` on ${A.pct(Math.abs(dSpend), 0)} ${dSpend < 0 ? 'lower' : 'higher'} spend` : ''}.`);
    }
    if (cur.cpl && prev.cpl) {
      const dCpl = ((cur.cpl - prev.cpl) / prev.cpl) * 100;
      if (Math.abs(dCpl) >= 15) {
        push(dCpl > 0 ? 'watch' : 'good', `CPL moved ${dCpl > 0 ? 'up' : 'down'} ${A.pct(Math.abs(dCpl), 0)} week on week`,
          `Now <em>${A.money(cur.cpl)}</em> against ${A.money(prev.cpl)} in the previous week.`);
      }
    }
  }

  /* platform share shift */
  if (totals.spend > 0) {
    const gShare = (totals.google / totals.spend) * 100;
    const mShare = (totals.meta / totals.spend) * 100;
    push('info', 'Budget split',
      `Google <em>${A.pct(gShare, 0)}</em> (${A.moneyShort(totals.google)}) · Meta <em>${A.pct(mShare, 0)}</em> (${A.moneyShort(totals.meta)}) over ${totals.days} days.`);
  }

  /* correlation */
  const lag = A.lagCorrelation(daily);
  const best = lag.filter(l => l.r !== null).sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
  if (best) {
    if (Math.abs(best.r) < 0.25) {
      push('watch', 'Spend and lead volume barely move together',
        `Strongest correlation is <em>${best.r.toFixed(2)}</em> at a ${best.lag}-day lag. Lead flow in this window is driven by something other than daily budget — check source mix and CRM lag.`);
    } else {
      push('info', 'Spend to lead response',
        `Correlation peaks at <em>${best.r.toFixed(2)}</em> with a ${best.lag}-day lag, so budget changes show up in the CRM ${best.lag === 0 ? 'the same day' : `about ${best.lag} day${best.lag > 1 ? 's' : ''} later`}.`);
    }
  }

  /* anomalies */
  const an = A.anomalies(daily);
  if (an.length) {
    const a = an[0];
    push('watch', `${a.metric} outlier on ${A.dayLabel(a.date)}`,
      `${a.metric} of <em>${a.value}</em> sits ${Math.abs(a.z).toFixed(1)} standard deviations ${a.direction} the window average of ${a.baseline}.`);
  }

  /* response discipline */
  if (totals.leads >= 20 && totals.respRate < 70) {
    push('critical', 'First response is lagging',
      `<em>${A.pct(100 - totals.respRate)}</em> of leads have no first follow-up logged${totals.respMedian !== null ? `, and the median first touch takes ${totals.respMedian.toFixed(1)} hours` : ''}.`);
  } else if (totals.respMedian !== null && totals.leads >= 20) {
    push('good', 'Response time looks healthy',
      `Median first touch is <em>${totals.respMedian.toFixed(1)} hours</em> with ${A.pct(totals.respRate)} of leads contacted.`);
  }

  /* project outliers */
  const outliers = A.qualityOutliers(leads, 10);
  if (outliers.length >= 2) {
    const top = outliers[0], bottom = outliers[outliers.length - 1];
    if (top.qualRate > 0) {
      push('good', `${top.key} is the strongest source of quality`,
        `<em>${A.pct(top.qualRate)}</em> qualification on ${A.n(top.leads)} leads against a ${A.pct(top.benchmark)} benchmark.`);
    }
    if (bottom.leads >= 15 && bottom.delta < -2) {
      push('watch', `${bottom.key} is dragging quality down`,
        `<em>${A.pct(bottom.qualRate)}</em> qualification on ${A.n(bottom.leads)} leads, ${Math.abs(bottom.delta).toFixed(1)} points below the benchmark.`);
    }
  }

  /* dead reasons */
  if (totals.dead > 0) {
    const reasons = A.groupLeads(leads.filter(l => l.dead), l => l.subStatus || l.deadReason || 'Unspecified');
    if (reasons.length) {
      push('info', 'Leading reason leads go dead',
        `${reasons[0].key} accounts for <em>${A.n(reasons[0].leads)}</em> of ${A.n(totals.dead)} dead leads (${A.pct(totals.deadRate)} of all leads are dead).`);
    }
  }

  /* weekday pattern */
  const dow = A.dowIndex(daily);
  const leadRow = dow.rows.find(r => r.metric === 'leads');
  if (leadRow) {
    const withVals = leadRow.cells.map((c, i) => ({ ...c, i })).filter(c => c.index !== null && c.n >= 2);
    if (withVals.length >= 4) {
      const best2 = withVals.slice().sort((a, b) => b.index - a.index)[0];
      const worst = withVals.slice().sort((a, b) => a.index - b.index)[0];
      if (best2.index - worst.index > 40) {
        push('info', 'Weekday pattern is strong',
          `${A.DOW_NAMES[best2.i]} runs at <em>${Math.round(best2.index)}</em> on the lead index while ${A.DOW_NAMES[worst.i]} sits at ${Math.round(worst.index)} (100 is the window average).`);
      }
    }
  }

  const order = { critical: 0, watch: 1, good: 2, info: 3 };
  return out.sort((a, b) => order[a.sev] - order[b.sev]);
};

/* ---------------- spend attribution & drill-down ---------------- */

const normKey = s => String(s || '').toLowerCase().replace(/&/g, 'n').replace(/[^a-z0-9]/g, '');

function blankNode(key, level) {
  return {
    key, level, leads: 0, qualified: 0, unqualified: 0, tbd: 0, dead: 0,
    visits: 0, eoi: 0, booked: 0, spend: 0, matchedSpend: 0, method: '', children: new Map()
  };
}
function addLead(n, l) {
  n.leads++;
  if (l.qualified) n.qualified++; else if (l.unqualified) n.unqualified++; else n.tbd++;
  if (l.dead) n.dead++;
  if (l.visited) n.visits++;
  if (l.eoi) n.eoi++;
  if (l.booked) n.booked++;
}
function finish(n) {
  n.cpl = n.spend > 0 ? A.cost(n.spend, n.leads) : null;
  n.cpql = n.spend > 0 ? A.cost(n.spend, n.qualified) : null;
  n.qualRate = A.ratio(n.qualified, n.leads);
  n.visitRate = A.ratio(n.visits, n.qualified);
  n.eoiRate = A.ratio(n.eoi, n.visits);
  n.children = [...n.children.values()];
  n.children.forEach(finish);
  n.children.sort((a, b) => b.leads - a.leads || b.spend - a.spend);
  return n;
}

/* Project → Platform → Campaign, with spend pushed down as far as the data honestly allows.
   mode 'strict'   : only spend the export ties to a campaign name is allocated.
   mode 'estimated': the rest is spread across leads, and every row says how it got its number. */
A.buildDrilldown = function (leads, spend, mode) {
  mode = mode || 'estimated';
  const roots = new Map();
  const leaves = [];

  leads.forEach(l => {
    const pk = l.project || 'Unmapped';
    if (!roots.has(pk)) roots.set(pk, blankNode(pk, 'project'));
    const proj = roots.get(pk);
    addLead(proj, l);

    const plk = l.platform || 'Other';
    if (!proj.children.has(plk)) proj.children.set(plk, blankNode(plk, 'platform'));
    const plat = proj.children.get(plk);
    plat.platform = plk;
    addLead(plat, l);

    const ck = l.campaign || (l.source ? l.source + ' (untagged)' : 'Untagged');
    if (!plat.children.has(ck)) {
      const leaf = blankNode(ck, 'campaign');
      leaf.platform = plk;
      leaf.campaignRaw = l.campaign || '';
      plat.children.set(ck, leaf);
      leaves.push(leaf);
    }
    addLead(plat.children.get(ck), l);
  });

  /* spend by platform, and by campaign name inside each platform */
  const platTotal = {}, campByPlat = {};
  spend.forEach(s => {
    const p = s.platform || 'Other';
    platTotal[p] = (platTotal[p] || 0) + s.cost;
    if (s.campaign) {
      campByPlat[p] = campByPlat[p] || new Map();
      const k = normKey(s.campaign);
      campByPlat[p].set(k, (campByPlat[p].get(k) || 0) + s.cost);
    }
  });

  /* 1. exact campaign matches, split by lead share when a campaign spans projects */
  let matchedTotal = 0;
  Object.keys(campByPlat).forEach(p => {
    campByPlat[p].forEach((cost, k) => {
      const hits = leaves.filter(lf => lf.platform === p && normKey(lf.campaignRaw) === k && lf.campaignRaw);
      if (!hits.length) return;
      const tot = A.sum(hits.map(h => h.leads)) || hits.length;
      hits.forEach(h => {
        const share = (h.leads || 1) / tot;
        h.matchedSpend += cost * share;
        h.spend += cost * share;
        h.method = 'matched';
      });
      matchedTotal += cost;
    });
  });

  /* 2. residual per platform, spread by lead share of that platform */
  let unallocated = 0;
  Object.keys(platTotal).forEach(p => {
    const matchedHere = A.sum(leaves.filter(lf => lf.platform === p).map(lf => lf.matchedSpend));
    const residual = platTotal[p] - matchedHere;
    if (residual <= 0.5) return;
    const pool = leaves.filter(lf => lf.platform === p);
    const poolLeads = A.sum(pool.map(lf => lf.leads));
    if (mode === 'strict' || !poolLeads) {
      if (mode === 'estimated' && !poolLeads) {
        /* platform has spend but no tagged leads — spread across everything, clearly labelled */
        const allLeads = A.sum(leaves.map(lf => lf.leads));
        if (allLeads) {
          leaves.forEach(lf => {
            const cut = residual * (lf.leads / allLeads);
            lf.spend += cut;
            lf.crossSpend = (lf.crossSpend || 0) + cut;
            lf.method = lf.method === 'matched' ? 'matched + estimated' : 'estimated';
          });
          return;
        }
      }
      unallocated += residual;
      return;
    }
    pool.forEach(lf => {
      lf.spend += residual * (lf.leads / poolLeads);
      lf.method = lf.method === 'matched' ? 'matched + apportioned' : 'apportioned';
    });
  });

  /* 3. roll leaf spend up the tree */
  const tree = [...roots.values()];
  tree.forEach(proj => {
    proj.spend = 0; proj.matchedSpend = 0;
    proj.children.forEach(plat => {
      plat.spend = 0; plat.matchedSpend = 0;
      plat.children.forEach(leaf => {
        plat.spend += leaf.spend; plat.matchedSpend += leaf.matchedSpend;
      });
      plat.method = [...plat.children.values()].some(l => l.method === 'matched') ? 'matched' :
                    [...plat.children.values()].some(l => (l.method || '').includes('estimated')) ? 'estimated' : 'apportioned';
      proj.spend += plat.spend; proj.matchedSpend += plat.matchedSpend;
    });
    proj.method = proj.matchedSpend > 0 ? (proj.matchedSpend >= proj.spend - 0.5 ? 'matched' : 'mixed') : 'apportioned';
  });

  const totalSpend = A.sum(Object.values(platTotal));
  return {
    tree: tree.map(finish).sort((a, b) => b.spend - a.spend || b.leads - a.leads),
    unallocated,
    totalSpend,
    matchedTotal,
    matchShare: A.ratio(matchedTotal, totalSpend) || 0,
    mode
  };
};

/* Flatten the tree into display rows, honouring which branches are open. */
A.flattenTree = function (tree, openSet) {
  const out = [];
  tree.forEach(p => {
    out.push({ node: p, depth: 0, path: p.key, hasKids: p.children.length > 0 });
    if (!openSet.has(p.key)) return;
    p.children.forEach(pl => {
      const pth = p.key + '||' + pl.key;
      out.push({ node: pl, depth: 1, path: pth, hasKids: pl.children.length > 0 });
      if (!openSet.has(pth)) return;
      pl.children.forEach(c => out.push({ node: c, depth: 2, path: pth + '||' + c.key, hasKids: false }));
    });
  });
  return out;
};

/* ---------------- funnel & manager rollup ---------------- */

A.funnel = function (leads) {
  const f = {
    leads: leads.length,
    contacted: leads.filter(l => l.responded || l.commentCount > 0).length,
    qualified: leads.filter(l => l.qualified).length,
    visits: leads.filter(l => l.visited).length,
    eoi: leads.filter(l => l.eoi).length,
    booked: leads.filter(l => l.booked).length,
    dead: leads.filter(l => l.dead).length
  };
  f.leadToQl = A.ratio(f.qualified, f.leads);
  f.qlToVisit = A.ratio(f.visits, f.qualified);
  f.visitToEoi = A.ratio(f.eoi, f.visits);
  f.leadToBooking = A.ratio(f.booked, f.leads);
  return f;
};

/* keyFn may return a string or an array — managers are chains, so a lead
   legitimately counts under every manager above it. */
A.rollup = function (leads, keyFn) {
  const map = new Map();
  leads.forEach(l => {
    let keys = keyFn(l);
    if (!Array.isArray(keys)) keys = [keys];
    keys.filter(Boolean).forEach(k => {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(l);
    });
  });
  return [...map.entries()].map(([key, ls]) => {
    const f = A.funnel(ls);
    return Object.assign({ key, members: ls }, f, {
      tbd: ls.filter(l => !l.qualified && !l.unqualified).length,
      unqualified: ls.filter(l => l.unqualified).length,
      responded: ls.filter(l => l.responded).length,
      respMedian: A.median(ls.map(l => l.respHrs).filter(v => v !== null)),
      respRate: A.ratio(ls.filter(l => l.responded).length, ls.length),
      deadRate: A.ratio(f.dead, f.leads),
      owners: new Set(ls.map(l => l.assignee)).size,
      projects: new Set(ls.map(l => l.project)).size
    });
  }).sort((a, b) => b.leads - a.leads);
};

/* Names that appear on nearly every lead are org-level, not an ASM. */
A.managerOptions = function (leads) {
  const counts = new Map();
  leads.forEach(l => new Set(l.managers).forEach(m => counts.set(m, (counts.get(m) || 0) + 1)));
  const n = leads.length || 1;
  return [...counts.entries()].map(([name, count]) => ({
    name, count,
    generic: /^cug$/i.test(name) || /^team\b/i.test(name),
    orgLevel: count / n >= 0.9
  })).sort((a, b) => b.count - a.count);
};
