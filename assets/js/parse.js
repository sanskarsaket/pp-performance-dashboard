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
      subStatus: clean(r['Lead Sub Status']) || 'Unknown',
      qual,
      qualified: /^qualified$/i.test(qual),
      unqualified: /^unqualified$/i.test(qual),
      dead: /^dead$/i.test(clean(r['Lead Status'])),
      deadReason: clean(r['Dead Reason']) || clean(r['Sub Status Reason']) || '',
      visited: /^yes$/i.test(clean(r['Visited'])),
      booked: !!clean(r['Booking Date']),
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
