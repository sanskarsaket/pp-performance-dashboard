/* parse.js — file reading, encoding detection, normalisation
   Handles: UTF-16LE/BE tab-separated Google/Meta "Day Wise Spends" exports
            and UTF-8 CRM lead dumps (leads_YYYY-MM-DD.csv). */

const PP = window.PP || (window.PP = {});

/* ---------------- reading ---------------- */

PP.readFile = function (file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error('Could not read ' + file.name));
    r.onload = () => {
      const buf = new Uint8Array(r.result);
      let enc = 'utf-8';
      if (buf[0] === 0xff && buf[1] === 0xfe) enc = 'utf-16le';
      else if (buf[0] === 0xfe && buf[1] === 0xff) enc = 'utf-16be';
      else {
        // BOM-less UTF-16 shows alternating zero bytes in the first line
        let zeros = 0;
        for (let i = 1; i < Math.min(buf.length, 200); i += 2) if (buf[i] === 0) zeros++;
        if (zeros > 40) enc = 'utf-16le';
      }
      let text = new TextDecoder(enc).decode(buf);
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      resolve(text);
    };
    r.readAsArrayBuffer(file);
  });
};

/* ---------------- detection ---------------- */

PP.detectKind = function (text) {
  const head = text.slice(0, 4000);
  if (/Lead Number|Lead Qualifying Status|Lead Sub Status/i.test(head)) return 'leads';
  if (/Day Wise Spends/i.test(head)) return 'spend';
  if (/(^|\n)\s*(Day|Date)[\t,][^\n]*Cost/i.test(head)) return 'spend';
  if (/Amount spent|Ad set name/i.test(head)) return 'spend';
  return 'unknown';
};

/* ---------------- helpers ---------------- */

const NUM_RE = /[^0-9.\-]/g;
function num(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const s = String(v).replace(NUM_RE, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : 0;
}
PP.num = num;

function isoDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/); // dd/mm/yyyy
  if (m) return `${m[3]}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  const d = new Date(s);
  if (!isNaN(d)) return d.toISOString().slice(0, 10);
  return null;
}
PP.isoDate = isoDate;

function tsMs(v) {
  if (!v) return null;
  const s = String(v).trim().replace(' ', 'T');
  const d = new Date(s);
  return isNaN(d) ? null : d.getTime();
}

function clean(v) {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (!s || s === '-' || s === 'NA' || s === 'N/A' || s === 'null') return '';
  return s;
}

/* ---------------- spend ---------------- */

PP.parseSpend = function (text, platform, fileName) {
  const lines = text.replace(/\r/g, '').split('\n');
  let hi = lines.findIndex(l => /^"?(Day|Date|Reporting starts)"?[\t,;]/i.test(l));
  if (hi < 0) hi = lines.findIndex(l => /Cost|Amount spent/i.test(l));
  if (hi < 0) hi = 0;

  const body = lines.slice(hi).filter(l => l.trim() !== '').join('\n');
  const delim = (body.split('\n')[0].match(/\t/g) || []).length ? '\t' : ',';
  const res = Papa.parse(body, { header: true, delimiter: delim, skipEmptyLines: true });

  const rows = [];
  res.data.forEach(r => {
    const keys = Object.keys(r);
    const kd = keys.find(k => /^(day|date|reporting starts)$/i.test(k.trim())) || keys[0];
    const kc = keys.find(k => /^(cost|amount spent.*|spend|cost \(inr\))$/i.test(k.trim())) ||
               keys.find(k => /cost|spend|amount/i.test(k));
    const date = isoDate(r[kd]);
    if (!date) return;
    const kacc = keys.find(k => /account name|account/i.test(k));
    const kcam = keys.find(k => /^campaign( name)?$/i.test(k.trim()));
    rows.push({
      date,
      platform,
      account: clean(kacc ? r[kacc] : '') || 'Unnamed account',
      campaign: clean(kcam ? r[kcam] : ''),
      currency: clean(keys.find(k => /currency/i.test(k)) ? r[keys.find(k => /currency/i.test(k))] : '') || 'INR',
      cost: num(kc ? r[kc] : 0),
      file: fileName || ''
    });
  });
  return rows;
};

/* ---------------- comment log ---------------- */

/* CRM comments arrive as one cell holding stacked entries:
   "20-08-26 11:07 AM (Saad Sarwar Sayed) : Did not pickup call"          */
const CMT_RE = /(\d{2})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s*(AM|PM)?\s*\(([^)]*)\)\s*:\s*/gi;

PP.parseComments = function (raw) {
  const s = clean(raw);
  if (!s) return [];
  const out = [];
  const marks = [];
  let m;
  CMT_RE.lastIndex = 0;
  while ((m = CMT_RE.exec(s)) !== null) marks.push({ m, start: m.index, end: CMT_RE.lastIndex });
  if (!marks.length) return [{ ms: null, agent: '', text: s }];
  marks.forEach((mk, i) => {
    const [, dd, mm, yy, hh, mi, ap, agent] = mk.m;
    let h = parseInt(hh, 10);
    if (ap && /pm/i.test(ap) && h < 12) h += 12;
    if (ap && /am/i.test(ap) && h === 12) h = 0;
    const d = new Date(2000 + parseInt(yy, 10), parseInt(mm, 10) - 1, parseInt(dd, 10), h, parseInt(mi, 10));
    const text = s.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : s.length).trim();
    out.push({ ms: isNaN(d) ? null : d.getTime(), agent: clean(agent).replace(/\s*-\s*primary$/i, ''), text });
  });
  return out;
};

/* Outcome of a single comment line. */
const CMT_RULES = [
  ['dead', /(not looking|not interested|no requirement|wrong number|invalid number|fake|already booked|not enquired|budget issue|out of budget|do not call|dnd)/i],
  ['visit', /(site visit|\bsv\b|visit plan|will visit|visiting|come to site|sight visit)/i],
  ['engaged', /(budget|looking for|\d\s*bhk|possession|details shared|share details|shared details|resides|investment|loan|configuration|price|inventory|option)/i],
  ['callback', /(\bcb\b|call back|callback|call later|busy|on call|meeting|in a meeting|revert)/i],
  ['whatsapp', /(\bwa\b|whatsapp|msg drop|msg sent|message sent|sms)/i],
  ['noanswer', /(not pick|didn.?t pick|did not pickup|no answer|\bnp\b|ringing|unable to connect|not connected|not reachable|switch(ed)? off|out of (coverage|network)|disconnect|declined|cut the call|busy tone)/i]
];
PP.classifyComment = function (text) {
  const t = String(text || '');
  for (const [tag, re] of CMT_RULES) if (re.test(t)) return tag;
  return t.trim() ? 'other' : 'empty';
};

/* Manager chain: "Rahul Kumar,CUG,Umesh Tomer,Team Pune,Hemant Bajaj" */
PP.managerChain = function (raw) {
  return clean(raw).split(',').map(x => x.trim()).filter(Boolean);
};

const INTENT_RE = /(interested|budget|site visit|sv\b|visit|loan|possession|configuration|bhk|shortlist|details shared|revisit|meeting)/i;
const BULK_RE = /(bulk lead|bulk leads|tat miss|tat is cross|tat cross|received in bulk)/i;

/* ---------------- manager hierarchy ---------------- */

/* "Executive Manager" is a comma list mixing people, team tags and account-wide names. */
const MGR_IGNORE = /^(CUG|Hemant Bajaj|-|NA)$/i;

function managerTokens(raw) {
  return clean(raw).split(',').map(t => t.trim()).filter(t => t && !MGR_IGNORE.test(t));
}

/* ---------------- leads ---------------- */

const MAP_GOOGLE = /(google|adwords|gads|pmax|p-max|search|discovery|demandgen|demand gen|youtube|gdn|display)/i;
const MAP_META = /(meta|facebook|fb|instagram|ig|whatsapp ads)/i;

function platformOf(row) {
  const explicit = clean(row['Platform']);
  if (explicit) {
    if (MAP_META.test(explicit)) return 'Meta';
    if (MAP_GOOGLE.test(explicit)) return 'Google';
  }
  const probes = [row['utm_source'], row['Ad Strategy'], row['Source'], row['Sub Source'], row['utm_medium']];
  for (const p of probes) {
    const s = clean(p);
    if (!s) continue;
    if (MAP_META.test(s)) return 'Meta';
    if (MAP_GOOGLE.test(s)) return 'Google';
  }
  if (clean(row['Fb Leadgen Id']) || clean(row['Fb Form ID']) || clean(row['Fb Page ID'])) return 'Meta';
  if (clean(row['GClickID']) || clean(row['campaign_id']) || clean(row['ads_keyword'])) return 'Google';
  return 'Other';
}

PP.parseLeads = function (text, fileName) {
  const res = Papa.parse(text.replace(/^\uFEFF/, ''), { header: true, skipEmptyLines: true });
  const out = [];
  res.data.forEach(r => {
    const createdRaw = r['Created At'] || r['Created at'] || r['Lead Created At'];
    const date = isoDate(createdRaw);
    if (!date) return;
    const created = tsMs(createdRaw);
    const first = tsMs(r['First Followed Up Date']);
    const assigned = tsMs(r['First Assigned At']);
    const qual = clean(r['Lead Qualifying Status']) || 'TBD';
    const comments = PP.parseComments(r['Comment']);
    const cmtTags = comments.map(c => PP.classifyComment(c.text));
    const lastCmt = comments.length ? comments[comments.length - 1] : null;
    const updated = tsMs(r['Last Updated At']);
    const nextCall = isoDate(r['Next Call Date']);
    const subStatus = clean(r['Lead Sub Status']) || 'Unknown';
    const blob = [subStatus, clean(r['Sub Status Reason']), comments.map(c => c.text).join(' ')].join(' ');
    const booked = !!clean(r['Booking Date']) || /\bbooking done\b|\bbooked\b/i.test(blob);
    const eoi = /\beoi\b|expression of interest|token (paid|amount)/i.test(blob);
    out.push({
      id: clean(r['Lead Number']) || (date + '|' + clean(r['Customer']) + '|' + (created || '')),
      date,
      createdMs: created,
      hour: created ? new Date(created).getHours() : null,
      customer: clean(r['Customer']),
      platform: platformOf(r),
      source: clean(r['Source']) || 'Unknown',
      subSource: clean(r['Sub Source']),
      campaign: clean(r['Campaign Name']) || clean(r['utm_campaign']) || '',
      adset: clean(r['Ads Set Name']) || '',
      ad: clean(r['Ads Name']) || '',
      keyword: clean(r['ads_keyword']) || clean(r['utm_term']) || '',
      device: clean(r['device']),
      project: clean(r['Project Name']) || clean(r['Enquiry']) || 'Unmapped',
      city: clean(r['Project City']) || clean(r['Preferred City']) || 'Unknown',
      status: clean(r['Lead Status']) || 'Unknown',
      subStatus,
      qual,
      qualified: /^qualified$/i.test(qual),
      unqualified: /^unqualified$/i.test(qual),
      dead: /^dead$/i.test(clean(r['Lead Status'])),
      deadReason: clean(r['Dead Reason']) || clean(r['Sub Status Reason']) || '',
      visited: /^yes$/i.test(clean(r['Visited'])) || !!isoDate(r['Visited Date']),
      visitPlanned: !!isoDate(r['Tentative Visit Date']) || cmtTags.includes('visit'),
      booked,
      eoi: eoi || booked,
      managers: PP.managerChain(r['Executive Manager']),
      team: PP.managerChain(r['Executive Manager']).find(x => /^team\b/i.test(x)) || 'Unmapped',
      asm: managerTokens(r['Executive Manager']).find(x => !/^team\b/i.test(x)) || 'Unmapped',
      bulkExcuse: BULK_RE.test(blob),
      hasIntent: INTENT_RE.test(blob),
      noContactOnly: comments.length > 0 && cmtTags.every(t => ['noanswer', 'whatsapp', 'empty'].includes(t)),
      commentChars: comments.map(c => c.text).join(' ').length,
      comments,
      cmtTags,
      commentCount: comments.length,
      lastCommentMs: lastCmt ? lastCmt.ms : null,
      lastCommentText: lastCmt ? lastCmt.text : '',
      lastCommentAgent: lastCmt ? lastCmt.agent : '',
      updatedMs: updated,
      lastActivityMs: Math.max(...[created, updated, lastCmt ? lastCmt.ms : null].filter(v => v) ) || created,
      nextCall,
      hasNextCall: !!nextCall,
      connected: cmtTags.some(t => ['engaged', 'visit', 'dead', 'callback'].includes(t)),
      assignee: clean(r['Assigned To']) || 'Unassigned',
      execType: clean(r['Executive Type']),
      respHrs: created && first ? Math.max(0, (first - created) / 3600000) : null,
      assignHrs: created && assigned ? Math.max(0, (assigned - created) / 3600000) : null,
      responded: !!first,
      attributed: !!(clean(r['Campaign Name']) || clean(r['utm_campaign']) || clean(r['campaign_id'])),
      file: fileName || ''
    });
  });
  return out;
};

/* ---------------- session bundle ---------------- */

PP.parseSession = function (text) {
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.leads) || !Array.isArray(j.spend)) throw new Error('Not a dashboard session file');
  return j;
};
