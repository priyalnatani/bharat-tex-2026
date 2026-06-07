/**
 * api/submit.js  —  Vercel Serverless Function
 *
 * POST /api/submit
 * Receives form data → appends a row to Google Sheet (Sheet2: "Form Responses")
 * via Google Sheets API using a Service Account.
 *
 * Required Environment Variables (set in Vercel dashboard):
 *   GOOGLE_SHEET_ID          — the spreadsheet ID from the URL
 *   GOOGLE_SERVICE_ACCOUNT   — full JSON string of the service account key
 */

export default async function handler(req, res) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  // CORS headers (in case you ever call from a different domain)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  try {
    const body = req.body;

    // ── 1. Validate required env vars ──────────────────────────────
    const sheetId = process.env.GOOGLE_SHEET_ID;
    const saRaw   = process.env.GOOGLE_SERVICE_ACCOUNT;
    if (!sheetId || !saRaw) {
      throw new Error('Missing GOOGLE_SHEET_ID or GOOGLE_SERVICE_ACCOUNT env vars');
    }

    const sa = JSON.parse(saRaw); // service account JSON

    // ── 2. Get a Google access token via JWT ───────────────────────
    const token = await getAccessToken(sa);

    // ── 3. Append row to Sheet2 ("Form Responses") ─────────────────
    // Column order — keep in sync with your sheet headers (row 1)
    const row = [
      body.submittedAt  || new Date().toISOString(),
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
    ];

    const appendUrl =
      `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/` +
      `Form%20Responses!A:M:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;

    const appendRes = await fetch(appendUrl, {
      method  : 'POST',
      headers : {
        'Authorization': `Bearer ${token}`,
        'Content-Type' : 'application/json',
      },
      body: JSON.stringify({ values: [row] }),
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

/* ────────────────────────────────────────────────────────────────────
   JWT / OAuth helper — gets a short-lived access token from Google
   using the service account credentials (no extra npm packages needed)
──────────────────────────────────────────────────────────────────── */
async function getAccessToken(sa) {
  const now   = Math.floor(Date.now() / 1000);
  const claim = {
    iss   : sa.client_email,
    scope : 'https://www.googleapis.com/auth/spreadsheets',
    aud   : 'https://oauth2.googleapis.com/token',
    exp   : now + 3600,
    iat   : now,
  };

  // Build JWT header.payload
  const header  = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claim));
  const signingInput = `${header}.${payload}`;

  // Import the private key
  const keyData = pemToArrayBuffer(sa.private_key);
  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8', keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false, ['sign']
  );

  // Sign
  const sigBuffer  = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5', cryptoKey,
    new TextEncoder().encode(signingInput)
  );
  const sig = b64url(sigBuffer);

  const jwt = `${signingInput}.${sig}`;

  // Exchange JWT for access token
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
    // ArrayBuffer
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
  const buf = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return buf;
}
