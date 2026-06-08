/**
 * api/visit.js  —  Vercel Serverless Function
 * POST /api/visit  → upserts unique visitor row in "Visitors" sheet
 *
 * Required Environment Variables (Vercel dashboard):
 *   GOOGLE_VISITORS_SHEET_ID  — spreadsheet ID for the Visitors sheet
 *   GOOGLE_SERVICE_ACCOUNT    — full JSON of the service account key file
 *
 * Sheet tab must be named exactly:  Visitors
 * Columns A–K: visitor_id, first_seen, last_seen, visit_count, user_agent,
 *              referrer, utm_source, utm_medium, utm_campaign, utm_term, utm_content
 */

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // ── ENV VARS ─────────────────────────────────────────────────────
  const sheetId = process.env.GOOGLE_VISITORS_SHEET_ID;
  const saRaw   = process.env.GOOGLE_SERVICE_ACCOUNT;

  if (!sheetId) {
    console.error('visit.js: GOOGLE_VISITORS_SHEET_ID env var is missing');
    return res.status(500).json({ success: false, error: 'Server misconfiguration: missing visitors sheet ID' });
  }
  if (!saRaw) {
    console.error('visit.js: GOOGLE_SERVICE_ACCOUNT env var is missing');
    return res.status(500).json({ success: false, error: 'Server misconfiguration: missing service account' });
  }

  try {
    const sa    = JSON.parse(saRaw);
    const token = await getAccessToken(sa);

    // Vercel serverless functions do not auto-parse JSON bodies.
    // Manually parse the raw body string.
    let body = {};
    try {
      const raw = await new Promise((resolve, reject) => {
        let data = '';
        req.on('data', chunk => { data += chunk; });
        req.on('end',  ()    => resolve(data));
        req.on('error', err  => reject(err));
      });
      if (raw) body = JSON.parse(raw);
    } catch (e) {
      console.warn('visit.js: body parse error', e.message);
    }

    const visitorId = (body.visitor_id || '').trim();
    if (!visitorId) {
      return res.status(400).json({ success: false, error: 'Missing visitor_id' });
    }

    const now = nowIST();

    // Read all existing rows from Visitors sheet
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Visitors!A:K`;
    const getRes = await fetch(getUrl, { headers: { 'Authorization': `Bearer ${token}` } });

    if (!getRes.ok) {
      const errText = await getRes.text();
      console.error('visit.js: GET Visitors failed:', getRes.status, errText);
      // Still try to append — sheet might just be empty / not yet initialised
      await appendNewVisitor(sheetId, token, body, visitorId, now);
      return res.status(200).json({ success: true, action: 'created' });
    }

    const { values = [] } = await getRes.json();

    // Find existing row (values[0] is header, skip it)
    let existingRowIndex = -1;
    let existingCount    = 0;

    for (let i = 1; i < values.length; i++) {
      if ((values[i][0] || '') === visitorId) {
        existingRowIndex = i + 1; // 1-indexed + 1 for header
        existingCount    = parseInt(values[i][3], 10) || 0;
        break;
      }
    }

    if (existingRowIndex === -1) {
      await appendNewVisitor(sheetId, token, body, visitorId, now);
      return res.status(200).json({ success: true, action: 'created' });
    }

    // Returning visitor — update last_seen (col C) and visit_count (col D) only
    // UTMs stay as first-touch and are never overwritten
    const updateUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
      `Visitors!C${existingRowIndex}:D${existingRowIndex}?valueInputOption=RAW`;

    const updateRes = await fetch(updateUrl, {
      method  : 'PUT',
      headers : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body    : JSON.stringify({ values: [[now, existingCount + 1]] }),
    });

    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('visit.js: update failed:', updateRes.status, errText);
      throw new Error(`Visitor update ${updateRes.status}: ${errText}`);
    }

    return res.status(200).json({ success: true, action: 'updated', visits: existingCount + 1 });

  } catch (err) {
    console.error('visit.js error:', err.message);
    // Return 200 so the page never shows an error, but log it
    return res.status(200).json({ success: false, error: err.message });
  }
}


async function appendNewVisitor(sheetId, token, body, visitorId, now) {
  const row = [
    visitorId,
    now,  // first_seen
    now,  // last_seen
    1,    // visit_count
    (body.user_agent || '').substring(0, 200),
    (body.referrer   || 'direct').substring(0, 200),
    body.utm_source   || '',
    body.utm_medium   || '',
    body.utm_campaign || '',
    body.utm_term     || '',
    body.utm_content  || '',
  ];

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/:append` +
    `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const appendRes = await fetch(appendUrl, {
    method  : 'POST',
    headers : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body    : JSON.stringify({ range: 'Visitors!A:K', values: [row] }),
  });

  if (!appendRes.ok) {
    const errText = await appendRes.text();
    console.error('visit.js: append failed:', appendRes.status, errText);
    throw new Error(`Visitor append ${appendRes.status}: ${errText}`);
  }
}


/* ── IST TIMESTAMP ───────────────────────────────────────────────────── */
function nowIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const p   = (n) => String(n).padStart(2, '0');
  return `${p(ist.getUTCDate())}/${p(ist.getUTCMonth()+1)}/${ist.getUTCFullYear()} ${p(ist.getUTCHours())}:${p(ist.getUTCMinutes())}:${p(ist.getUTCSeconds())}`;
}


/* ── GOOGLE AUTH ─────────────────────────────────────────────────────── */
async function getAccessToken(sa) {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const header       = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload      = b64url(JSON.stringify(claim));
  const signingInput = `${header}.${payload}`;
  const keyData      = pemToArrayBuffer(sa.private_key);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, new TextEncoder().encode(signingInput));
  const jwt       = `${signingInput}.${b64url(sigBuffer)}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method  : 'POST',
    headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body    : `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    throw new Error(`Token exchange failed ${tokenRes.status}: ${t}`);
  }

  const { access_token } = await tokenRes.json();
  return access_token;
}

function b64url(data) {
  const str = (typeof data === 'string')
    ? btoa(unescape(encodeURIComponent(data)))
    : btoa(String.fromCharCode(...new Uint8Array(data)));
  return str.replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

function pemToArrayBuffer(pem) {
  const b64    = pem.replace(/-----BEGIN PRIVATE KEY-----|-----END PRIVATE KEY-----|\s/g, '');
  const binary = atob(b64);
  const buf    = new ArrayBuffer(binary.length);
  const view   = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}
