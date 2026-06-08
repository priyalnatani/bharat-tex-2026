/**
 * api/submit.js  —  Vercel Serverless Function
 *
 * POST /api/submit          → validates → duplicate-checks → appends to "Form Responses" sheet (RAW, no formatting)
 * POST /api/submit?t=visit  → upserts unique visitor row in "Visitors" sheet (increments visit_count on return visits)
 *
 * Required Environment Variables (set in Vercel dashboard):
 *   GOOGLE_SHEET_ID           — spreadsheet ID for the Form Responses sheet
 *   GOOGLE_VISITORS_SHEET_ID  — spreadsheet ID for the Visitors sheet (can be a different Google Sheet)
 *   GOOGLE_SERVICE_ACCOUNT    — full JSON string of the service account key
 *
 * Note: Share BOTH spreadsheets with the service account email (Editor access).
 * All timestamps are stored in IST (India Standard Time, UTC+5:30).
 */

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
    const sheetId         = process.env.GOOGLE_SHEET_ID;
    const visitorsSheetId = process.env.GOOGLE_VISITORS_SHEET_ID || process.env.GOOGLE_SHEET_ID; // fallback to same sheet
    const saRaw           = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!sheetId || !saRaw) throw new Error('Missing GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT env vars');

    const sa    = JSON.parse(saRaw);
    const token = await getAccessToken(sa);
    const body  = req.body || {};

    // ── VISITOR UPSERT (called with ?t=visit) ─────────────────────
    if (req.query && req.query.t === 'visit') {
      return await handleVisitorUpsert(req, res, visitorsSheetId, token, body);
    }

    // ── FORM SUBMISSION ───────────────────────────────────────────

    // 1. Server-side validation
    const validationError = validatePayload(body);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    // 2. Duplicate check — read existing Form Responses rows
    const isDuplicate = await checkDuplicate(sheetId, token, body);
    if (isDuplicate) {
      return res.status(200).json({ success: false, duplicate: true });
    }

    // 3. Append new row — RAW mode prevents Google Sheets from
    //    auto-interpreting +91 phone numbers, dates, etc. as formulas or special types
    const row = [
      body.submittedAt  || nowIST(),
      body.visitorType  || '',
      body.fullName     || '',
      body.phone        || '',
      body.email        || '',
      body.company      || '',
      body.designation  || '',
      body.sector       || '',
      body.city         || '',
      body.state        || '',
      body.interest     || '',
      body.consent      || 'No',
      body.source       || '',
      body.utm_source   || '',
      body.utm_medium   || '',
      body.utm_campaign || '',
      body.utm_term     || '',
      body.utm_content  || '',
    ];

    const appendUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
      `Form%20Responses!A:R:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

    const appendRes = await fetch(appendUrl, {
      method  : 'POST',
      headers : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body    : JSON.stringify({ values: [row] }),
    });

    if (!appendRes.ok) {
      const errText = await appendRes.text();
      throw new Error(`Sheets API error: ${appendRes.status} — ${errText}`);
    }

    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('submit.js error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}


/* ── SERVER-SIDE VALIDATION ──────────────────────────────────────────
   Mirrors the frontend V validators — protects against direct API calls
   that bypass the browser form entirely.
────────────────────────────────────────────────────────────────────── */
function validatePayload(body) {
  const name  = (body.fullName  || '').trim();
  const phone = (body.phone     || '').replace(/^\+91/, '').trim(); // strip prefix if present
  const email = (body.email     || '').trim().toLowerCase();
  const co    = (body.company   || '').trim();
  const city  = (body.city      || '').trim();
  const state = (body.state     || '').trim();

  // Full name: min 4 chars, no digits, not all-same chars
  if (name.length < 4)
    return 'Full name must be at least 4 characters.';
  if (/\d/.test(name))
    return 'Full name cannot contain numbers.';
  if (!/[a-zA-Z\u0900-\u097F]/.test(name))
    return 'Please enter a valid name.';
  if (/^(.)\1+$/.test(name.replace(/\s/g, '')))
    return 'Please enter your real full name.';

  // Phone: 10 digits, starts 5-9, not all same digit
  if (!/^\d{10}$/.test(phone))
    return 'Phone must be exactly 10 digits.';
  if (/^[0-4]/.test(phone))
    return 'Phone must be a valid Indian mobile number (starts with 5–9).';
  if (/^(\d)\1{9}$/.test(phone))
    return 'Please enter a real mobile number.';

  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email))
    return 'Invalid email address.';

  // Block obvious dummy emails
  const dummyEmails = ['test@test.com', 'abc@abc.com', 'test@gmail.com', 'dummy@dummy.com', 'example@example.com'];
  if (dummyEmails.includes(email))
    return 'Please use a real email address.';

  // Company: min 3 chars, has letters, not a fake name
  if (co.length < 3)
    return 'Company name must be at least 3 characters.';
  if (!/[a-zA-Z]/.test(co))
    return 'Company name must contain letters.';
  const fakeCompanies = ['abc','xyz','test','asdf','qwerty','company','mycompany','na','n/a','none','nil','abcd','aaa','bbb','ccc','xxx','yyy','zzz','temp','fake'];
  const coKey = co.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (fakeCompanies.includes(coKey) || /^(.)\1+$/.test(coKey))
    return 'Please enter your actual company name.';

  if (city.length < 2)
    return 'City must be at least 2 characters.';

  if (!state)
    return 'Please select a state.';

  // Designation is optional but if provided must be meaningful
  const desig = (body.designation || '').trim();
  if (desig.length > 0 && desig.length < 2)
    return 'Designation must be at least 2 characters if provided.';

  return null; // all good
}


/* ── DUPLICATE CHECK ─────────────────────────────────────────────────
   Reads all existing Form Responses rows and checks if the combination
   of fullName + phone + email already exists. Case-insensitive email.
   Returns true if a duplicate is found.
────────────────────────────────────────────────────────────────────── */
async function checkDuplicate(sheetId, token, body) {
  const getUrl =
    `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Form%20Responses!A:E`;

  const getRes = await fetch(getUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!getRes.ok) return false; // if we can't read, let it through rather than blocking everyone

  const { values = [] } = await getRes.json();

  // Row structure: [submittedAt, visitorType, fullName, phone, email, ...]
  // Skip header row (index 0)
  const incoming = {
    name  : (body.fullName || '').trim().toLowerCase(),
    phone : (body.phone    || '').trim(),
    email : (body.email    || '').trim().toLowerCase(),
  };

  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const existingName  = (row[2] || '').trim().toLowerCase();
    const existingPhone = (row[3] || '').trim();
    const existingEmail = (row[4] || '').trim().toLowerCase();

    if (
      existingName  === incoming.name  &&
      existingPhone === incoming.phone &&
      existingEmail === incoming.email
    ) {
      return true; // duplicate found
    }
  }

  return false;
}


/* ── VISITOR UPSERT ──────────────────────────────────────────────────
   Called when ?t=visit is in the query string.
   Body must contain: { visitor_id, user_agent, referrer, page }

   Sheet "Visitors" columns (A–F):
     visitor_id | first_seen | last_seen | visit_count | user_agent | referrer

   Logic:
     - Read all rows, find the one matching visitor_id
     - If found → PATCH last_seen and increment visit_count
     - If not found → append a new row with visit_count = 1
────────────────────────────────────────────────────────────────────── */
async function handleVisitorUpsert(req, res, sheetId, token, body) {
  const visitorId = (body.visitor_id || '').trim();
  if (!visitorId) {
    return res.status(400).json({ success: false, error: 'Missing visitor_id' });
  }

  const now = nowIST();

  // Read existing Visitors sheet
  const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Visitors!A:F`;
  const getRes = await fetch(getUrl, {
    headers: { 'Authorization': `Bearer ${token}` },
  });

  if (!getRes.ok) {
    // Sheet might not exist yet — append anyway
    await appendNewVisitor(sheetId, token, body, visitorId, now);
    return res.status(200).json({ success: true, action: 'created' });
  }

  const { values = [] } = await getRes.json();

  // Find existing row (skip header at index 0)
  // Row format: [visitor_id, first_seen, last_seen, visit_count, user_agent, referrer]
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
    // New visitor — append
    await appendNewVisitor(sheetId, token, body, visitorId, now);
    return res.status(200).json({ success: true, action: 'created' });
  }

  // Returning visitor — update last_seen (col C = index 3) and visit_count (col D = index 4)
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
}

async function appendNewVisitor(sheetId, token, body, visitorId, now) {
  const row = [
    visitorId,
    now,                              // first_seen
    now,                              // last_seen
    1,                                // visit_count
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


/* ── IST TIMESTAMP HELPER ────────────────────────────────────────────
   Returns current date-time as a human-readable string in IST (UTC+5:30).
   Format: DD/MM/YYYY HH:MM:SS  e.g. "07/06/2025 14:35:22"
   Stored as plain text (RAW mode) so Sheets won't reformat it.
────────────────────────────────────────────────────────────────────── */
function nowIST() {
  const now = new Date();
  // IST = UTC + 5 hours 30 minutes
  const istOffset = 5.5 * 60 * 60 * 1000;
  const ist = new Date(now.getTime() + istOffset);

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
   No extra npm packages needed — uses Web Crypto API.
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

  const keyData  = pemToArrayBuffer(sa.private_key);
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
