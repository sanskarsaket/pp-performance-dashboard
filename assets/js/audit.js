/* audit.js — lead audit rules driven by comment logs and CRM timestamps */

const PP = window.PP || (window.PP = {});
const AU = (PP.audit = {});
const A = PP.an;

const HOUR = 3600000, DAY = 86400000;

/* Default thresholds. All editable from the Lead Audit tab. */
AU.defaults = {
  firstResponseHrs: 2,      // SLA from lead creation to first logged touch
  staleDays: 2,             // no activity on an open lead
  tbdDays: 3,               // qualifying status still TBD
  minAttempts: 3,           // attempts before an unreachable lead must be escalated
  quickDeathMins: 30        // dead this fast, with barely any log, needs review
};

/* Rule catalogue. Each returns true when the lead breaches it.
   `sev` drives the score weight: critical 3, major 2, minor 1. */
AU.rules = [
  {
    id: 'no_touch', label: 'Never contacted', sev: 'critical', weight: 3,
    hint: 'No follow-up logged and the response window has passed.',
    test: (l, t, now) => !l.responded && l.commentCount === 0 && l.createdMs && (now - l.createdMs) > t.firstResponseHrs * HOUR
  },
  {
    id: 'sla_breach', label: 'First response SLA breached', sev: 'major', weight: 2,
    hint: 'First touch took longer than the agreed response window.',
    test: (l, t) => l.respHrs !== null && l.respHrs > t.firstResponseHrs
  },
  {
    id: 'overdue_call', label: 'Callback date missed', sev: 'critical', weight: 3,
    hint: 'The next call date has passed with no activity since.',
    test: (l, t, now) => {
      if (!l.nextCall || l.dead || l.booked) return false;
      const due = new Date(l.nextCall + 'T23:59:59').getTime();
      return due < now && (!l.lastActivityMs || l.lastActivityMs < due);
    }
  },
  {
    id: 'no_next_call', label: 'No next call scheduled', sev: 'major', weight: 2,
    hint: 'An open lead with no callback date on the record.',
    test: l => !l.hasNextCall && !l.dead && !l.booked && !l.unqualified
  },
  {
    id: 'stale', label: 'Gone quiet', sev: 'major', weight: 2,
    hint: 'No comment or update for longer than the stale threshold.',
    test: (l, t, now) => !l.dead && !l.booked && l.lastActivityMs && (now - l.lastActivityMs) > t.staleDays * DAY
  },
  {
    id: 'never_connected', label: 'Repeated attempts, never connected', sev: 'major', weight: 2,
    hint: 'Enough attempts logged without a single conversation — change the channel or the number is bad.',
    test: (l, t) => !l.connected && l.commentCount >= t.minAttempts && !l.dead
  },
  {
    id: 'whatsapp_only', label: 'WhatsApp only, no call connect', sev: 'minor', weight: 1,
    hint: 'Every logged touch is a message drop.',
    test: l => l.commentCount >= 2 && l.cmtTags.every(x => x === 'whatsapp' || x === 'noanswer') && l.cmtTags.includes('whatsapp')
  },
  {
    id: 'dead_no_reason', label: 'Dead without a reason', sev: 'critical', weight: 3,
    hint: 'Marked dead with no reason recorded.',
    test: l => l.dead && !l.deadReason
  },
  {
    id: 'quick_death', label: 'Killed too fast', sev: 'critical', weight: 3,
    hint: 'Marked dead almost immediately with little or no call log.',
    test: (l, t) => l.dead && l.commentCount <= 1 &&
      (l.lastActivityMs && l.createdMs ? (l.lastActivityMs - l.createdMs) < t.quickDeathMins * 60000 : true)
  },
  {
    id: 'intent_ignored', label: 'Buying signal not actioned', sev: 'critical', weight: 3,
    hint: 'The log shows real interest or a visit intent, but the lead is still sitting in New or Attempted.',
    test: l => (l.cmtTags.includes('engaged') || l.cmtTags.includes('visit')) &&
      /^(new|attempted)$/i.test(l.status) && !l.dead
  },
  {
    id: 'status_mismatch', label: 'Log says dead, status does not', sev: 'major', weight: 2,
    hint: 'The last comment reads as a rejection while the lead is still open.',
    test: l => l.cmtTags.length > 0 && l.cmtTags[l.cmtTags.length - 1] === 'dead' && !l.dead && !l.unqualified
  },
  {
    id: 'tbd_ageing', label: 'Qualification overdue', sev: 'major', weight: 2,
    hint: 'Still TBD well past the qualification window.',
    test: (l, t, now) => !l.qualified && !l.unqualified && !l.dead && l.createdMs && (now - l.createdMs) > t.tbdDays * DAY
  },
  {
    id: 'qualified_no_visit', label: 'Qualified with no visit plan', sev: 'major', weight: 2,
    hint: 'A qualified lead with no site visit planned or logged.',
    test: l => l.qualified && !l.visited && !l.visitPlanned
  },
  {
    id: 'unassigned', label: 'Not assigned', sev: 'critical', weight: 3,
    hint: 'No owner on the lead.',
    test: l => !l.assignee || /^unassigned$/i.test(l.assignee)
  },
  {
    id: 'slow_assign', label: 'Slow to assign', sev: 'minor', weight: 1,
    hint: 'Took over an hour to reach an owner.',
    test: l => l.assignHrs !== null && l.assignHrs > 1
  },
  {
    id: 'empty_log', label: 'Contacted but nothing written', sev: 'minor', weight: 1,
    hint: 'A follow-up is stamped on the lead with no comment explaining it.',
    test: l => l.responded && l.commentCount === 0
  }
];

AU.SEV_WEIGHT = { critical: 3, major: 2, minor: 1, clean: 0 };

/* Run the catalogue over a set of leads. */
AU.run = function (leads, thresholds, nowMs) {
  const t = Object.assign({}, AU.defaults, thresholds || {});
  const now = nowMs || Date.now();
  const rows = leads.map(l => {
    const flags = AU.rules.filter(r => {
      try { return r.test(l, t, now); } catch (e) { return false; }
    });
    const penalty = A.sum(flags.map(f => f.weight));
    return {
      lead: l,
      flags,
      flagIds: flags.map(f => f.id),
      flagLabels: flags.map(f => f.label).join(' · '),
      worst: flags.reduce((acc, f) => (AU.SEV_WEIGHT[f.sev] > AU.SEV_WEIGHT[acc] ? f.sev : acc), 'clean'),
      penalty,
      /* per-lead health, 100 is a clean record */
      score: Math.max(0, 100 - penalty * 12)
    };
  });

  const byRule = AU.rules.map(r => {
    const hit = rows.filter(x => x.flagIds.includes(r.id));
    return {
      id: r.id, label: r.label, sev: r.sev, hint: r.hint,
      count: hit.length,
      share: A.ratio(hit.length, leads.length) || 0,
      owners: A.groupLeads(hit.map(x => x.lead), l => l.assignee).slice(0, 3).map(g => `${g.key} (${g.leads})`).join(', ')
    };
  }).filter(r => r.count > 0).sort((a, b) => (AU.SEV_WEIGHT[b.sev] - AU.SEV_WEIGHT[a.sev]) || (b.count - a.count));

  const flagged = rows.filter(x => x.flags.length > 0);
  const totalPenalty = A.sum(rows.map(x => x.penalty));
  const summary = {
    leads: leads.length,
    flagged: flagged.length,
    clean: leads.length - flagged.length,
    cleanRate: A.ratio(leads.length - flagged.length, leads.length) || 0,
    critical: rows.filter(x => x.worst === 'critical').length,
    major: rows.filter(x => x.worst === 'major').length,
    minor: rows.filter(x => x.worst === 'minor').length,
    breaches: A.sum(rows.map(x => x.flags.length)),
    score: leads.length ? Math.max(0, 100 - (totalPenalty / leads.length) * 12) : 100
  };

  return { rows, byRule, summary, thresholds: t, now };
};

/* Audit rolled up by owner, so the conversation is with a person, not a spreadsheet. */
AU.byOwner = function (result, keyFn) {
  const fn = keyFn || (l => l.assignee);
  const map = new Map();
  result.rows.forEach(x => {
    const k = fn(x.lead) || 'Unassigned';
    if (!map.has(k)) map.set(k, { key: k, leads: 0, flagged: 0, critical: 0, penalty: 0, qualified: 0, responded: 0, resp: [], counts: {} });
    const g = map.get(k);
    g.leads++;
    g.penalty += x.penalty;
    if (x.flags.length) g.flagged++;
    if (x.worst === 'critical') g.critical++;
    if (x.lead.qualified) g.qualified++;
    if (x.lead.responded) g.responded++;
    if (x.lead.respHrs !== null) g.resp.push(x.lead.respHrs);
    x.flagIds.forEach(id => { g.counts[id] = (g.counts[id] || 0) + 1; });
  });
  return [...map.values()].map(g => {
    g.score = Math.max(0, 100 - (g.penalty / g.leads) * 12);
    g.flagRate = A.ratio(g.flagged, g.leads) || 0;
    g.qualRate = A.ratio(g.qualified, g.leads) || 0;
    g.respRate = A.ratio(g.responded, g.leads) || 0;
    g.respMedian = A.median(g.resp);
    const top = Object.entries(g.counts).sort((a, b) => b[1] - a[1])[0];
    const rule = top ? AU.rules.find(r => r.id === top[0]) : null;
    g.topIssue = rule ? `${rule.label} (${top[1]})` : '—';
    return g;
  }).sort((a, b) => a.score - b.score);
};

/* Contact-attempt behaviour read straight off the comment log. */
AU.contactMix = function (leads) {
  const tags = ['engaged', 'visit', 'callback', 'noanswer', 'whatsapp', 'dead', 'other'];
  const counts = Object.fromEntries(tags.map(t => [t, 0]));
  let entries = 0;
  leads.forEach(l => l.cmtTags.forEach(t => { if (counts[t] !== undefined) counts[t]++; entries++; }));
  return {
    entries,
    logged: leads.filter(l => l.commentCount > 0).length,
    avgTouches: leads.length ? A.mean(leads.map(l => l.commentCount)) : 0,
    connected: leads.filter(l => l.connected).length,
    rows: tags.map(t => ({ tag: t, count: counts[t], share: A.ratio(counts[t], entries) || 0 }))
  };
};

AU.TAG_LABEL = {
  engaged: 'Real conversation', visit: 'Visit discussed', callback: 'Callback requested',
  noanswer: 'No answer', whatsapp: 'Message dropped', dead: 'Rejection', other: 'Other note', empty: 'Blank'
};
