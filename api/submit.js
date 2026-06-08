/**
 * api/submit.js  —  Vercel Serverless Function
 * POST /api/submit  → validates → duplicate-checks → appends to "Form Responses" sheet
 *
 * Required Environment Variables (Vercel dashboard):
 *   GOOGLE_SHEET_ID         — spreadsheet ID for the Form Responses sheet
 *   GOOGLE_SERVICE_ACCOUNT  — full JSON of the service account key file
 *
 * Sheet tab must be named exactly:  Form Responses
 * Columns A–R: submitted_at, visitor_type, full_name, phone, email, company,
 *              designation, sector, city, state, interest, consent, source,
 *              utm_source, utm_medium, utm_campaign, utm_term, utm_content
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
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const saRaw   = process.env.GOOGLE_SERVICE_ACCOUNT;

  if (!sheetId) {
    console.error('submit.js: GOOGLE_SHEET_ID env var is missing');
    return res.status(500).json({ success: false, error: 'Server misconfiguration: missing sheet ID' });
  }
  if (!saRaw) {
    console.error('submit.js: GOOGLE_SERVICE_ACCOUNT env var is missing');
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
      // If parsing fails, body stays {}
      console.warn('submit.js: body parse error', e.message);
    }

    // 1. Validate
    const validationError = validatePayload(body);
    if (validationError) {
      return res.status(400).json({ success: false, error: validationError });
    }

    // 2. Duplicate check
    const isDuplicate = await checkDuplicate(sheetId, token, body);
    if (isDuplicate) {
      return res.status(200).json({ success: false, duplicate: true });
    }

    // 3. Append — RAW prevents Sheets from mangling +91 numbers or dates
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
  `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Form%20Responses!A:R:append` +
  `?valueInputOption=RAW&insertDataOption=INSERT_ROWS`;

    // NOTE: range is specified in the request body, not the URL,
    // to avoid issues with URL-encoding of sheet tab names with spaces.

    const appendRes = await fetch(appendUrl, {
      method  : 'POST',
      headers : { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body    : JSON.stringify({ range: 'Form Responses!A:R', values: [row] }),
    });

    if (!appendRes.ok) {
      const errText = await appendRes.text();
      console.error('submit.js: Sheets append failed:', appendRes.status, errText);
      throw new Error(`Sheets API ${appendRes.status}: ${errText}`);
    }

    console.log('submit.js: row appended for', body.email);
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('submit.js error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
}


/* ── VALIDATION ──────────────────────────────────────────────────────── */
function validatePayload(body) {
  const name  = (body.fullName  || '').trim();
  const phone = (body.phone     || '').replace(/^\+91/, '').trim();
  const email = (body.email     || '').trim().toLowerCase();
  const co    = (body.company   || '').trim();
  const city  = (body.city      || '').trim();
  const state = (body.state     || '').trim();

  if (name.length < 4)                          return 'Full name must be at least 4 characters.';
  if (/\d/.test(name))                          return 'Full name cannot contain numbers.';
  if (!/[a-zA-Z\u0900-\u097F]/.test(name))     return 'Please enter a valid name.';
  if (/^(.)\1+$/.test(name.replace(/\s/g,''))) return 'Please enter your real full name.';

  if (!/^\d{10}$/.test(phone))                  return 'Phone must be exactly 10 digits.';
  if (/^[0-4]/.test(phone))                     return 'Enter a valid Indian mobile number (starts 5–9).';
  if (/^(\d)\1{9}$/.test(phone))               return 'Please enter a real mobile number.';

  if (!/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) return 'Invalid email address.';

  const dummyEmails = ['test@test.com','abc@abc.com','test@gmail.com','dummy@dummy.com','example@example.com'];
  if (dummyEmails.includes(email))              return 'Please use a real email address.';

  if (co.length < 3)                            return 'Company name must be at least 3 characters.';
  if (!/[a-zA-Z]/.test(co))                    return 'Company name must contain letters.';
  const fakeCompanies = ['abc','xyz','test','asdf','qwerty','company','mycompany','na','n/a','none','nil','abcd','aaa','bbb','ccc','xxx','yyy','zzz','temp','fake'];
  const coKey = co.toLowerCase().replace(/[^a-z0-9]/g,'');
  if (fakeCompanies.includes(coKey) || /^(.)\1+$/.test(coKey)) return 'Please enter your actual company name.';

  if (city.length < 2)  return 'City must be at least 2 characters.';
  if (!state)           return 'Please select a state.';

  const desig = (body.designation || '').trim();
  if (desig.length > 0 && desig.length < 2) return 'Designation must be at least 2 characters if provided.';

  return null;
}


/* ── DUPLICATE CHECK ─────────────────────────────────────────────────── */
async function checkDuplicate(sheetId, token, body) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${sheetId}/values/Form%20Responses!A:E`;
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });

  if (!res.ok) {
    console.warn('submit.js: duplicate check read failed, letting submission through:', res.status);
    return false;
  }

  const { values = [] } = await res.json();

  const inName  = (body.fullName || '').trim().toLowerCase();
  const inPhone = (body.phone    || '').trim();
  const inEmail = (body.email    || '').trim().toLowerCase();

  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (
      (r[2] || '').trim().toLowerCase() === inName  &&
      (r[3] || '').trim()               === inPhone &&
      (r[4] || '').trim().toLowerCase() === inEmail
    ) return true;
  }
  return false;
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
