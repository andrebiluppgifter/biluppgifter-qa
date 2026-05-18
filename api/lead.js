// Vercel Edge Function — receives a captured lead from the chatbot and notifies Biluppgifter's inbox via Ortto.
// Uses Ortto's EU transactional email API. Region: eu.ortto.app.

export const config = {
  runtime: 'edge',
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Trimma bort eventuell whitespace/newline (vanlig copy-paste-gotcha)
  const orttoKey = (process.env.ORTTO_API_KEY || '').trim();
  const leadTo = (process.env.LEAD_TO_EMAIL || '').trim();
  const leadFrom = (process.env.LEAD_FROM_EMAIL || '').trim();
  const leadFromName = (process.env.LEAD_FROM_NAME || 'Biluppgifter Lead Bot').trim();

  if (!orttoKey || !leadTo || !leadFrom) {
    return new Response(JSON.stringify({
      error: 'Server missing ORTTO_API_KEY, LEAD_TO_EMAIL, or LEAD_FROM_EMAIL env vars',
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let lead;
  try {
    lead = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!lead || typeof lead !== 'object') {
    return new Response(JSON.stringify({ error: 'lead object required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!isValidEmail(lead.email)) {
    return new Response(JSON.stringify({ error: 'valid email required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Validera och cappa input
  const safe = {
    email: String(lead.email).slice(0, 200),
    name: String(lead.name || '').slice(0, 200),
    company: String(lead.company || '').slice(0, 200),
    role: String(lead.role || '').slice(0, 200),
    country: String(lead.country || '').slice(0, 50),
    use_case: String(lead.use_case || '').slice(0, 2000),
    volume: String(lead.volume || '').slice(0, 200),
    timeline: String(lead.timeline || '').slice(0, 200),
  };

  const subject = `Ny lead från API-discovery: ${safe.name || safe.email}${safe.company ? ' (' + safe.company + ')' : ''}`;

  const textBody = [
    'Ny API-trial-förfrågan från prospect-chattbotten.',
    '',
    `Email:       ${safe.email}`,
    `Namn:        ${safe.name || '(inte angivet)'}`,
    `Företag:     ${safe.company || '(inte angivet)'}`,
    `Roll:        ${safe.role || '(inte angivet)'}`,
    `Land:        ${safe.country || '(inte angivet)'}`,
    `Volym:       ${safe.volume || '(inte angivet)'}`,
    `Timeline:    ${safe.timeline || '(inte angivet)'}`,
    '',
    'Use case:',
    safe.use_case || '(inte angivet)',
    '',
    '—',
    'Skickat automatiskt från biluppgifter-prospect-chatbotten.',
    'Skicka test-token till email-adressen ovan inom 24h.',
  ].join('\n');

  const htmlBody = `
    <!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;max-width:600px">
      <h2 style="color:#1a1a1a;border-bottom:2px solid #ff7a1a;padding-bottom:8px">Ny lead från API-discovery</h2>
      <table style="border-collapse:collapse;margin:16px 0;font-size:14px">
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Email</td><td style="padding:6px 12px"><a href="mailto:${escapeHtml(safe.email)}">${escapeHtml(safe.email)}</a></td></tr>
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Namn</td><td style="padding:6px 12px">${escapeHtml(safe.name) || '<em style="color:#888">inte angivet</em>'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Företag</td><td style="padding:6px 12px">${escapeHtml(safe.company) || '<em style="color:#888">inte angivet</em>'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Roll</td><td style="padding:6px 12px">${escapeHtml(safe.role) || '<em style="color:#888">inte angivet</em>'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Land</td><td style="padding:6px 12px">${escapeHtml(safe.country) || '<em style="color:#888">inte angivet</em>'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Volym</td><td style="padding:6px 12px">${escapeHtml(safe.volume) || '<em style="color:#888">inte angivet</em>'}</td></tr>
        <tr><td style="padding:6px 12px;background:#fff4e8;font-weight:600">Timeline</td><td style="padding:6px 12px">${escapeHtml(safe.timeline) || '<em style="color:#888">inte angivet</em>'}</td></tr>
      </table>
      <h3 style="margin-top:24px">Use case</h3>
      <div style="padding:12px;background:#fff4e8;border-left:3px solid #ff7a1a;white-space:pre-wrap">${escapeHtml(safe.use_case) || '<em style="color:#888">inte angivet</em>'}</div>
      <p style="margin-top:24px;color:#666;font-size:12px;border-top:1px solid #ddd;padding-top:12px">
        Skickat automatiskt från biluppgifter-prospect-chatbotten.<br>
        <strong>Action:</strong> skicka test-token till <a href="mailto:${escapeHtml(safe.email)}">${escapeHtml(safe.email)}</a> inom 24h.
      </p>
    </body></html>`;

  // Ortto EU transactional email API.
  // OBS: om felmeddelandet kommer som 4xx — kolla att din Ortto-nyckel har "Transactional Email"-permission
  // och att avsändaradressen (LEAD_FROM_EMAIL) är verifierad i ert Ortto-konto under
  // Settings → Email → Sender authentication.
  let orttoRes;
  try {
    orttoRes = await fetch('https://api.eu.ortto.app/v1/email/single', {
      method: 'POST',
      headers: {
        'X-Api-Key': orttoKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        // Mottagare som kontakt-array. Vi använder en placeholder-identitet eftersom mottagaren
        // är internt (Biluppgifter), inte leadets faktiska person.
        contacts: [{
          email: leadTo,
          first_name: 'Lead',
          last_name: 'Notifiering',
        }],
        // Ämnesrad
        subject,
        // Email-innehåll inline
        html_body: htmlBody,
        text_body: textBody,
        // Avsändare — måste vara verifierad i Ortto under "Sender authentication"
        from_email: leadFrom,
        from_name: leadFromName,
        // Reply-to går till leadets email så ett ev. svar går rätt
        reply_to: safe.email,
      }),
    });
  } catch (err) {
    console.error('Ortto fetch threw:', err);
    return new Response(JSON.stringify({
      error: 'Could not call Ortto',
      detail: String(err && err.message ? err.message : err),
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  if (!orttoRes.ok) {
    let errText = '';
    try { errText = await orttoRes.text(); } catch {}
    console.error(`Ortto ${orttoRes.status}:`, errText);
    return new Response(JSON.stringify({
      error: `Ortto API ${orttoRes.status}`,
      detail: errText,
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' },
  });
}
