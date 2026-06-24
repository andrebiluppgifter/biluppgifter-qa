// Vercel Edge Function — proxar Anthropic API och tvingar live-retrieval av OpenAPI-speccen.
// Varje request hämtar OpenAPI v1.json (cachad i ~10 min) och skickar den som system-context
// med Anthropic prompt caching, så svaret bygger på den faktiska speccen istället för minnet.
// Deploy: place in `/api/chat.js`. Set ANTHROPIC_API_KEY in Vercel env vars.

export const config = {
  runtime: 'edge',
};

// ============ OpenAPI spec retrieval (med cache) ============

const SPEC_URLS = [
  'https://data.biluppgifter.se/openapi/v1.json',
  'http://data.biluppgifter.se/openapi/v1.json',
];
const SPEC_TTL_MS = 10 * 60 * 1000; // 10 min cache
// VIKTIGT: tidigare kapades speccen vid 350k tecken. De svenska schemana
// (VehicleResponse, OwnerDto, besiktnings-DTO) ligger sist i filen och föll
// då bort — vilket var huvudorsaken till hallucinerade fältnamn.
// Vi kapar inte längre; vi loggar om speccen är ovanligt stor.
const SPEC_WARN_CHARS = 600000;      // logga varning, men kapa INTE

// Module-level cache — överlever mellan invocations i samma Edge worker.
let specCache = { data: null, ts: 0, fetchedFrom: null };

// ============ Wheels & Parts spec (extern leverantör — namnet ska INTE läcka) ============
// Speccen kommer från en underleverantör. Vi paketerar den som "Biluppgifter Wheels & Parts API"
// och tvättar bort leverantörens namn/domän/portal-länkar runtime. Source-URL:en loggas bara
// server-side så att vi vet vad cachen baseras på — den exponeras aldrig till modellen.

const WHEELS_PARTS_SPEC_URL = 'https://api.xevato.se/swagger.php';

let wheelsPartsCache = { data: null, ts: 0 };

// Sanering: parsa JSON, byt ut title/description, ta bort servers, regex-rensa text-fält.
function sanitizeWheelsPartsSpec(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    // Om JSON-parse failar — gör textbaserad rensning som bästa effort
    return scrubProviderRefs(rawText);
  }

  // Skriv om identitet
  parsed.info = parsed.info || {};
  parsed.info.title = 'Biluppgifter Wheels & Parts API';
  parsed.info.description =
    'Tilläggsmodul till Biluppgifters API. Endpoints för fordons-, fälg-, däck- och reservdelsdata ' +
    'baserade på registreringsnummer eller fordons-ID. Kräver separat aktivering — kontakta sales@biluppgifter.se.';
  delete parsed.info.contact;
  delete parsed.info.termsOfService;
  delete parsed.info.license;

  // Ta bort servers helt — kunden ska inte se leverantörens domän
  delete parsed.servers;

  // Stringify, sedan regex-pass över text-fält för att rensa kvarvarande referenser
  let json = JSON.stringify(parsed, null, 2);
  json = scrubProviderRefs(json);
  return json;
}

function scrubProviderRefs(text) {
  return text
    // Domän-referenser → vår egen
    .replace(/\bapi\.xevato\.se\b/gi, 'data.biluppgifter.se')
    .replace(/\bpanel\.xevato\.se\b/gi, 'biluppgifter.se')
    .replace(/\bswagger\.xevato\.se\b/gi, 'data.biluppgifter.se')
    .replace(/\bapistage\.xevato\.se\b/gi, 'data.biluppgifter.se')
    .replace(/\b(?:www\.)?xevato\.se\b/gi, 'biluppgifter.se')
    // Bara ordet — varianter
    .replace(/\bXevato\b/g, 'Biluppgifter')
    .replace(/\bXEVATO\b/g, 'BILUPPGIFTER')
    .replace(/\bxevato\b/g, 'biluppgifter');
}

async function fetchWheelsPartsSpec() {
  const now = Date.now();
  if (wheelsPartsCache.data && (now - wheelsPartsCache.ts) < SPEC_TTL_MS) {
    return { spec: wheelsPartsCache.data, cached: true };
  }
  try {
    const res = await fetch(WHEELS_PARTS_SPEC_URL, {
      headers: { 'Accept': 'application/json' },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const raw = await res.text();
    const sanitized = sanitizeWheelsPartsSpec(raw);
    wheelsPartsCache = { data: sanitized, ts: now };
    return { spec: sanitized, cached: false };
  } catch (err) {
    if (wheelsPartsCache.data) {
      console.warn('Wheels/Parts spec fetch failed, returning stale cache:', err?.message);
      return { spec: wheelsPartsCache.data, cached: true, stale: true };
    }
    throw new Error('Could not fetch wheels/parts spec: ' + (err?.message || 'unknown'));
  }
}

async function fetchOpenApiSpec() {
  const now = Date.now();
  if (specCache.data && (now - specCache.ts) < SPEC_TTL_MS) {
    return { spec: specCache.data, cached: true, source: specCache.fetchedFrom };
  }
  let lastErr = null;
  for (const url of SPEC_URLS) {
    try {
      const res = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        cf: { cacheTtl: 300 },
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status} from ${url}`);
        continue;
      }
      let text = await res.text();
      // Kapa INTE — det tog bort de svenska schemana sist i filen.
      if (text.length > SPEC_WARN_CHARS) {
        console.warn(`OpenAPI-spec ovanligt stor: ${text.length} tecken. Skickas ändå hel.`);
      }
      specCache = { data: text, ts: now, fetchedFrom: url };
      return { spec: text, cached: false, source: url };
    } catch (err) {
      lastErr = err;
    }
  }
  // Om båda URL:erna failar — returnera gammal cache om vi har den
  if (specCache.data) {
    console.warn('OpenAPI fetch failed, returning stale cache:', lastErr?.message);
    return { spec: specCache.data, cached: true, stale: true, source: specCache.fetchedFrom };
  }
  throw new Error('Could not fetch OpenAPI spec: ' + (lastErr?.message || 'unknown'));
}

// ============ System prompt (meta-instruktioner — INTE API-data) ============

const SYSTEM_PROMPT = `Du är Biluppgifter API-assistenten — en sakkunnig hjälpreda för utvecklare, säljare och beslutsfattare som vill förstå eller använda Biluppgifters API.

## Källor till sanning (två specer)
- Du har TVÅ OpenAPI 3-specer som auktoritativ källa i system-blocken nedan, hämtade live vid varje request:
  1. **Biluppgifter API (huvud)** — fordons-, ägar- och historikdata. Bas: \`data.biluppgifter.se\`.
  2. **Biluppgifter Wheels & Parts API (tillägg)** — fälg-, däck-, fordons- och reservdelsdata. Bas: samma, kräver separat aktivering.
- **Båda är Biluppgifters egna API-produkter.** Behandla dem som ett enhetligt erbjudande. Du får under inga omständigheter nämna, antyda eller spekulera om att någon del kommer från en extern leverantör eller tredje part. Om användaren frågar var datan kommer ifrån: "Det är Biluppgifters egen data och partner-data — kontakta sales@biluppgifter.se för detaljer om datakällor i avtal."
- **Vid frågor om däck, fälg, fälgmått, däckdimensioner, rim/tire/wheel, parts/reservdelar, kompatibilitet, "vad passar bilen"** → använd **Wheels & Parts**-speccen.
- **Vid frågor om fordonsdata, ägare, historik, status, skulder, värdering, annonser** → använd **huvudspeccen**.
- Vissa frågor kräver båda — då nämner du paths från båda specerna utan att skilja på dem som separata produkter (de är båda "Biluppgifters API").
- För Wheels & Parts-endpoints: ange **aldrig** en absolut base-URL i kod-exempel. Skriv \`/wheels/regno/{regno}/{country}/\` som relativ path.
- **Sales-hänvisningen får upprepas max EN gång per konversation.** Innan du skriver "kontakta sales@biluppgifter.se för aktivering av Wheels & Parts-modulen" (eller motsvarande formulering): granska tidigare assistant-meddelanden i samtalshistoriken. Om någon tidigare turn redan innehåller "sales@biluppgifter.se" eller en hänvisning om aktivering/åtkomst av Wheels & Parts → utelämna den meningen helt i detta svar. Användaren har redan fått infon. Skriv bara svaret om endpoints/fält.

## Strikt grundningsregel
- Hitta inte på endpoints, fält eller schemas. Citera exakta paths och fältnamn ur respektive spec.
- "Det framgår inte av speccen" och "det fältet finns inte" är KORREKTA och önskade svar. Att svara så är alltid bättre än att gissa. Du bedöms på att aldrig påstå något ogrundat, inte på att alltid ha ett svar.
- Hänvisa till **paths** som inline-kod, exakt som de står i speccen, t.ex. \`/api/v1/vehicle/regno/{regno}\`.
- Hänvisa till **schemas** (DTOs) med deras exakta namn ur \`components.schemas\`.
- Anta INTE att SE/NO/DK/FI delar fält eller struktur — varje land har eget schema i speccen, kontrollera respektive.
- Vid frågor om utskick/marknadsföring till fordonsägare: kontrollera om speccen har spärr-/NIX-relaterade fält eller parametrar och nämn dem. Påstå inte att personuppgifter är fritt tillgängliga. GDPR-/rättslig grund-bedömning är användarens ansvar — flagga det som "Allmän rekommendation (ej från speccen)".

## Källhänvisning — endast när den är sann
- Lägg ENDAST till en källrad om varje fält och endpoint du nämnt faktiskt förekommer ordagrant i speccen nedan. Formatet är då: \`📚 Källa: OpenAPI v1.json — [paths du faktiskt slagit upp]\`.
- Lägg ALDRIG till källraden om du är osäker, har gissat, eller inte kunnat hitta fältet i speccen. En källrad på ett ogrundat svar är värre än inget svar.
- Om du inte kan belägga något ur speccen: skriv "Det fältet finns inte i den aktuella API-speccen" istället för att gissa — och utelämna källraden.
- Innan du skriver kod som använder fältnamn: lista först fälten och vilket schema i \`components.schemas\` de kommer från. Hittar du dem inte — skriv kod inte.

## Identitet & uppgift
- Biluppgifter (biluppgifter.se) är Sveriges ledande leverantör av fordons- och ägardata. API:t bygger på data från Transportstyrelsen, partners och egna källor.
- Beskriv aldrig specifika fält eller scheman (inkl. ev. TecDoc-identifierare) utifrån denna text — slå alltid upp de faktiska fältnamnen i speccen nedan. Denna instruktion innehåller medvetet inga fältnamn, eftersom de ska läsas ur speccen.
- Din uppgift: svara korrekt och konkret på frågor om vårt API och om hur olika kundsegment bör använda det.

## Språkregel
- Detektera språket i användarens fråga (svenska eller engelska) och svara på SAMMA språk.
- Tekniska begrepp som "endpoint", "rate limit", "regno" behåller engelsk skrivning även i svenska svar.

## Målgruppsanpassning
Klassa frågan och anpassa svar:
- **Utvecklare / teknisk integration**: visa endpoint-path verbatim ur speccen, headers, query-/body-params (från parameters/requestBody i speccen), exempelanrop (curl + lämpligt SDK-språk), responsexempel byggda från response-schemat, felhantering, schemafält.
- **Säljare / AM**: ge bullet-svar med vad API:t kan/inte kan, kopplat till affärsvärde. Föreslå nästa steg (demo, prisförfrågan).
- **Beslutsfattare hos prospekt**: fokus på use case, vilka datapunkter löser deras problem, ROI-argument. Undvik djup teknisk jargong men nämn rätt endpoints så de kan ge vidare till utvecklare.
Om frågan är otydlig kring målgrupp — gör ett rimligt antagande utifrån formuleringen och svara därefter.

## Stilregler
- Var konkret. Visa endpoint-paths som inline-kod.
- Använd tabeller när du jämför endpoints eller datapunkter.
- Vid kod-exempel: använd kodblock med rätt språk-tagg (\`bash\`, \`python\`, \`javascript\`).
- Bygg exempel-responses från response-schemat i speccen, inte från fantasin.
- För landspecifika frågor (NO/DK/FI): nämn att utbud och fält skiljer sig från Sverige och referera till respektive paths i speccen.

## Eskaleringsregel
För frågor om priser, API-nyckel-utlämning, sekretess-/GDPR-policy, eller avtalsdetaljer → hänvisa till sales@biluppgifter.se. Du svarar gärna på allt tekniskt och om vilka data som finns att hämta.

## Allmänt om Biluppgifter
- Webbplats: https://www.biluppgifter.se
- API-info för prospekt: https://biluppgifter.se/api
- API-docs (samma som speccen nedan): https://data.biluppgifter.se/openapi/v1.json
- Kontakt: sales@biluppgifter.se
`;

// ============ Session-token verifiering (HMAC-SHA256) ============
// Klienten skickar en session_token som mintats av Apps Script efter lyckad
// magic link-verifiering. Vi verifierar HMAC-signaturen lokalt mot samma
// SESSION_SECRET som Apps Script använder — ingen round-trip behövs.

function base64UrlEncodeBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeUtf8(b64u) {
  let b64 = b64u.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

async function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return { ok: false, error: 'no token' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, error: 'malformed token' };
  const [payloadB64, sigB64] = parts;

  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    console.error('SESSION_SECRET env var missing');
    return { ok: false, error: 'server config error' };
  }

  const encoder = new TextEncoder();
  let key;
  try {
    key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch (err) {
    console.error('crypto.subtle.importKey failed:', err);
    return { ok: false, error: 'crypto error' };
  }

  const sigBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(payloadB64));
  const expectedSigB64 = base64UrlEncodeBuffer(sigBuffer);

  // Constant-time compare
  if (expectedSigB64.length !== sigB64.length) return { ok: false, error: 'bad signature' };
  let diff = 0;
  for (let i = 0; i < expectedSigB64.length; i++) {
    diff |= expectedSigB64.charCodeAt(i) ^ sigB64.charCodeAt(i);
  }
  if (diff !== 0) return { ok: false, error: 'bad signature' };

  // Decode payload och kolla giltighet
  let payload;
  try {
    const payloadJson = base64UrlDecodeUtf8(payloadB64);
    payload = JSON.parse(payloadJson);
  } catch {
    return { ok: false, error: 'corrupt payload' };
  }

  if (!payload.email || !payload.exp) return { ok: false, error: 'incomplete payload' };
  if (Date.now() > payload.exp) return { ok: false, error: 'session expired' };

  return { ok: true, email: payload.email, name: payload.name || '' };
}

// ============ Anthropic-anrop ============

// Sonnet följer "gissa inte"-instruktioner märkbart bättre än Haiku, som
// är mest benägen att fylla luckor med träningsdata. För grundningskritiska
// svar är det värt skillnaden. Bekräfta strängen mot ditt konto.
const MODEL = 'claude-sonnet-4-6';

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({
      error: 'Server missing ANTHROPIC_API_KEY env variable',
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { messages, session_token } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages[] required' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Verifiera HMAC-signerad session-token (mintad av Apps Script vid magic
  // link-verify). Detta ersätter den gamla user_email-kontrollen som var
  // klient-kontrollerad och därmed enkel att förfalska via DevTools.
  const session = await verifySessionToken(session_token);
  if (!session.ok) {
    console.warn('chat request rejected:', session.error);
    return new Response(JSON.stringify({
      error: 'Invalid session: ' + session.error,
      code: 'invalid_session',
    }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  const user_email = session.email;
  const user_name = session.name;
  console.log('chat request from', user_name || '(no name)', '<' + String(user_email).slice(0, 200) + '>');

  // Hämta båda specerna parallellt så latensen inte ökar
  let specPayload, wheelsPartsPayload;
  try {
    const [main, wheels] = await Promise.all([
      fetchOpenApiSpec(),
      fetchWheelsPartsSpec().catch((err) => {
        // Om wheels/parts failar — kör vidare utan den, logga warning
        console.warn('Wheels/parts spec unavailable, continuing without it:', err?.message);
        return null;
      }),
    ]);
    specPayload = main;
    wheelsPartsPayload = wheels;
    console.log(
      'main spec:', specPayload.source, '| cached:', specPayload.cached, '| chars:', specPayload.spec.length,
      '| wheels-parts:', wheelsPartsPayload ? (wheelsPartsPayload.cached ? 'cached' : 'fresh') + ', ' + wheelsPartsPayload.spec.length + ' chars' : 'unavailable'
    );
  } catch (err) {
    console.error('Could not fetch OpenAPI spec:', err);
    return new Response(JSON.stringify({
      error: 'Could not fetch OpenAPI spec',
      detail: String(err?.message || err),
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  const sanitizedMessages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 20000) }));

  if (sanitizedMessages.length === 0 || sanitizedMessages[sanitizedMessages.length - 1].role !== 'user') {
    return new Response(JSON.stringify({ error: 'last message must be from user' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Bygg system som array av blocks — varje spec får cache_control så Anthropic cachar dem
  // (90% billigare på cache hits, ~5 min TTL hos Anthropic).
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT },
    {
      type: 'text',
      text:
        '# Biluppgifter API — Huvudspec (Live OpenAPI v1.json)\n' +
        '\n' +
        'Nedan följer hela OpenAPI 3-speccen för Biluppgifters huvud-API (fordons-, ägar- och historikdata), hämtad live vid serversidan (' + (specPayload.cached ? 'cached' : 'fresh') + (specPayload.stale ? ', stale' : '') + '). Använd ENDAST denna spec som källa för fordons-/ägar-frågor — referera till paths verbatim och citera fältnamn ur components.schemas.\n' +
        '\n' +
        '<openapi-spec id="biluppgifter-main">\n' +
        specPayload.spec +
        '\n</openapi-spec>\n',
      cache_control: { type: 'ephemeral' },
    },
  ];

  // Tredje blocket: Wheels & Parts-speccen, sanerad. Endast om hämtning lyckades.
  if (wheelsPartsPayload) {
    systemBlocks.push({
      type: 'text',
      text:
        '# Biluppgifter Wheels & Parts API — Tilläggsmodul (Live spec)\n' +
        '\n' +
        'Nedan följer OpenAPI 3-speccen för Biluppgifters Wheels & Parts-modul (fälg-, däck-, fordons- och reservdelsdata), hämtad live vid serversidan (' + (wheelsPartsPayload.cached ? 'cached' : 'fresh') + (wheelsPartsPayload.stale ? ', stale' : '') + '). Använd denna spec för alla frågor om däck, fälg, fälgmått, däckdimensioner, kompatibilitet, parts/reservdelar och "vad passar bilen". Hänvisa till den som "Biluppgifters Wheels & Parts API" — nämn aldrig att den kommer från extern leverantör.\n' +
        '\n' +
        '<openapi-spec id="biluppgifter-wheels-parts">\n' +
        wheelsPartsPayload.spec +
        '\n</openapi-spec>\n',
      cache_control: { type: 'ephemeral' },
    });
  }

  const upstream = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: systemBlocks,
      stream: true,
      messages: sanitizedMessages,
    }),
  });

  if (!upstream.ok) {
    const errText = await upstream.text();
    return new Response(JSON.stringify({
      error: `Anthropic API ${upstream.status}`,
      detail: errText,
    }), {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}