// Vercel Edge Function — tar emot lead från discovery-botten och proxar till Apps Script,
// som skriver raden i "Prospect-leads"-fliken i Google Sheet och skickar notif-mail.

export const config = {
  runtime: 'edge',
};

// Apps Script Web App URL — samma som API-assistant använder för att skriva till samma Sheet
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbwBvJtuuFHRIGNDT3CcjeqIrgaDmYEfOPMifPWlzVRQToFFIAno6SQtpR5Fdo-ZzBzv/exec';

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  let lead;
  try {
    lead = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!lead || typeof lead !== 'object' || !isValidEmail(lead.email)) {
    return new Response(JSON.stringify({ error: 'valid email required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Cappa fältlängder för säkerhets skull
  const safeLead = {
    email: String(lead.email).slice(0, 200),
    name: String(lead.name || '').slice(0, 200),
    company: String(lead.company || '').slice(0, 200),
    role: String(lead.role || '').slice(0, 200),
    country: String(lead.country || '').slice(0, 50),
    use_case: String(lead.use_case || '').slice(0, 2000),
    volume: String(lead.volume || '').slice(0, 200),
    timeline: String(lead.timeline || '').slice(0, 200),
  };

  // Proxa till Apps Script (server-to-server, ingen CORS-issue)
  let scriptRes;
  try {
    scriptRes = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({
        action: 'prospect_lead',
        lead: safeLead,
        user_agent: req.headers.get('user-agent') || '',
        referrer: req.headers.get('referer') || '',
      }),
      redirect: 'follow',
    });
  } catch (err) {
    console.error('Apps Script fetch failed:', err);
    return new Response(JSON.stringify({
      error: 'Could not reach lead service',
      detail: String(err && err.message ? err.message : err),
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  if (!scriptRes.ok) {
    let errText = '';
    try { errText = await scriptRes.text(); } catch {}
    return new Response(JSON.stringify({
      error: 'Apps Script error',
      status: scriptRes.status,
      detail: errText.slice(0, 500),
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  let scriptData;
  try {
    const text = await scriptRes.text();
    scriptData = JSON.parse(text);
  } catch {
    return new Response(JSON.stringify({
      error: 'Invalid response from lead service',
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify(scriptData), {
    status: scriptData.ok ? 200 : 400,
    headers: { 'Content-Type': 'application/json' },
  });
}
