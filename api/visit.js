/**
 * api/visit.js  —  Vercel Serverless Function
 *
 * POST /api/visit  → upserts unique visitor row in "Visitors" sheet
 *                    (increments visit_count on return visits)
 *
 * Separated from api/submit.js so that high-traffic page-load pings
 * can never slow down or timeout actual form submissions.
 *
 * Required Environment Variables:
 *   GOOGLE_VISITORS_SHEET_ID  — spreadsheet ID for the Visitors sheet
 *   GOOGLE_SERVICE_ACCOUNT    — full JSON string of the service account key
 *
 * Body: { visitor_id, user_agent, referrer, page,
 *         utm_source, utm_medium, utm_campaign, utm_term, utm_content }
 *
 * Visitors sheet columns (A–K):
 *   visitor_id | first_seen | last_seen | visit_count | user_agent | referrer |
 *   utm_source | utm_medium | utm_campaign | utm_term | utm_content
 *
 * All timestamps are stored in IST (India Standard Time, UTC+5:30).
 */

export const config = {
  maxDuration: 8, // seconds — keep visitor pings fast and cheap
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const sheetId = process.env.GOOGLE_VISITORS_SHEET_ID;
    const saRaw   = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!sheetId || !saRaw) throw new Error('Missing GOOGLE_VISITORS_SHEET_ID or GOOGLE_SERVICE_ACCOUNT env vars');

    const sa    = JSON.parse(saRaw);
    const token = await getAccessToken(sa);
    const body  = req.body || {};

    const visitorId = (body.visitor_id || '').trim();
    if (!visitorId) {
      return res.status(400).json({ success: false, error: 'Missing visitor_id' });
    }

    const now = nowIST();

    // Read existing Visitors sheet (columns A–K)
    const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Visitors!A:K`;
    const getRes = await fetch(getUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (!getRes.ok) {
      // Sheet might not exist yet — append as new visitor anyway
      await appendNewVisitor(sheetId, token, body, visitorId, now);
      return res.status(200).json({ success: true, action: 'created' });
    }

    const { values = [] } = await getRes.json();

    // Find existing row (skip header at index 0)
    // Row format: [visitor_id, first_seen, last_seen, visit_count, user_agent, referrer, utm_source...]
    let existingRowIndex = -1;
    let existingCount    = 0;

    for (let i = 1; i < values.length; i++) {
      if ((values[i][0] || '') === visitorId) {
        existingRowIndex = i + 1; // Sheets rows are 1-indexed, +1 for header
        existingCount    = parseInt(values[i][3], 10) || 0;
        break;
      }
    }

    if (existingRowIndex === -1) {
      // New visitor — append full row
      await appendNewVisitor(sheetId, token, body, visitorId, now);
      return res.status(200).json({ success: true, action: 'created' });
    }

    // Returning visitor — only update last_seen (col C) and visit_count (col D)
    // UTMs stay as first-touch — never overwritten on return visits
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
      throw new Error(`Visitor update error: ${updateRes.status} — ${errText}`);
    }

    return res.status(200).json({ success: true, action: 'updated', visits: existingCount + 1 });

  } catch (err) {
    console.error('visit.js error:', err);
    // Always return 200 for visitor pings — never show errors to the page
    return res.status(200).json({ success: false, error: err.message });
  }
}


async function appendNewVisitor(sheetId, token, body, visitorId, now) {
  const row = [
    visitorId,
    now,                                                    // first_seen
    now,                                                    // last_seen
    1,                                                      // visit_count
    (body.user_agent || '').substring(0, 200),
    (body.referrer   || 'direct').substring(0, 200),
    body.utm_source   || '',
    body.utm_medium   || '',
    body.utm_campaign || '',
    body.utm_term     || '',
    body.utm_content  || '',
  ];

  const appendUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
    `Visitors!A:K:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

  const appendRes = await fetch(appendUrl, {
    method  : 'POST',
    headers : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body    : JSON.stringify({ values: [row] }),
  });

  if (!appendRes.ok) {
    const errText = await appendRes.text();
    throw new Error(`Visitor append error: ${appendRes.status} — ${errText}`);
  }
}


/* ── IST TIMESTAMP ───────────────────────────────────────────────────
   Format: DD/MM/YYYY HH:MM:SS  e.g. "07/06/2026 14:35:22"
────────────────────────────────────────────────────────────────────── */
function nowIST() {
  const now = new Date();
  const ist = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
  const dd   = String(ist.getUTCDate()).padStart(2, '0');
  const mm   = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = ist.getUTCFullYear();
  const HH   = String(ist.getUTCHours()).padStart(2, '0');
  const MM   = String(ist.getUTCMinutes()).padStart(2, '0');
  const SS   = String(ist.getUTCSeconds()).padStart(2, '0');
  return `${dd}/${mm}/${yyyy} ${HH}:${MM}:${SS}`;
}


/* ── JWT / OAuth helper ──────────────────────────────────────────────
   Gets a short-lived Google access token from the service account.
────────────────────────────────────────────────────────────────────── */
async function getAccessToken(sa) {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss   : sa.client_email,
    scope : 'https://www.googleapis.com/auth/spreadsheets',
    aud   : 'https://oauth2.googleapis.com/token',
    exp   : now + 3600,
    iat   : now,
  };

  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const signingInput = `${header}.${payload}`;

  const keyData   = pemToArrayBuffer(sa.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  const sigBuffer = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sig = b64url(sigBuffer);
  const jwt = `${signingInput}.${sig}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method  : 'POST',
    headers : { 'Content-Type': 'application/x-www-form-urlencoded' },
    body    : `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });

  if (!tokenRes.ok) {
    const t = await tokenRes.text();
    throw new Error(`Token exchange failed: ${tokenRes.status} — ${t}`);
  }

  const { access_token } = await tokenRes.json();
  return access_token;
}

function b64url(data) {
  let str;
  if (typeof data === 'string') {
    str = btoa(unescape(encodeURIComponent(data)));
  } else {
    str = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return str.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s/g, '');
  const binary = atob(b64);
  const buf    = new ArrayBuffer(binary.length);
  const view   = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}
