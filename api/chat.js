// Vercel Edge Function — discovery chatbot för Biluppgifter API-prospekt.
// Driver en kvalificerande konversation och plockar slutligen email/namn/roll.
// Tvingar live-retrieval av båda OpenAPI-specerna så alla påståenden om vad
// vår data innehåller är grundade i den faktiska speccen istället för minnet.

export const config = {
  runtime: 'edge',
};

// ============ OpenAPI spec retrieval (med cache) ============

const SPEC_URLS = [
  'https://data.biluppgifter.se/openapi/v1.json',
  'http://data.biluppgifter.se/openapi/v1.json',
];
const SPEC_TTL_MS = 10 * 60 * 1000;
const SPEC_WARN_CHARS = 600000;

let specCache = { data: null, ts: 0, fetchedFrom: null };

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
      const text = await res.text();
      if (text.length > SPEC_WARN_CHARS) {
        console.warn(`OpenAPI-spec ovanligt stor: ${text.length} tecken.`);
      }
      specCache = { data: text, ts: now, fetchedFrom: url };
      return { spec: text, cached: false, source: url };
    } catch (err) {
      lastErr = err;
    }
  }
  if (specCache.data) {
    console.warn('OpenAPI fetch failed, returning stale cache:', lastErr?.message);
    return { spec: specCache.data, cached: true, stale: true, source: specCache.fetchedFrom };
  }
  throw new Error('Could not fetch OpenAPI spec: ' + (lastErr?.message || 'unknown'));
}

// ============ Wheels & Parts spec (extern leverantör — namnet ska INTE läcka) ============

const WHEELS_PARTS_SPEC_URL = 'https://api.xevato.se/swagger.php';

let wheelsPartsCache = { data: null, ts: 0 };

function scrubProviderRefs(text) {
  return text
    .replace(/\bapi\.xevato\.se\b/gi, 'data.biluppgifter.se')
    .replace(/\bpanel\.xevato\.se\b/gi, 'biluppgifter.se')
    .replace(/\bswagger\.xevato\.se\b/gi, 'data.biluppgifter.se')
    .replace(/\bapistage\.xevato\.se\b/gi, 'data.biluppgifter.se')
    .replace(/\b(?:www\.)?xevato\.se\b/gi, 'biluppgifter.se')
    .replace(/\bXevato\b/g, 'Biluppgifter')
    .replace(/\bXEVATO\b/g, 'BILUPPGIFTER')
    .replace(/\bxevato\b/g, 'biluppgifter');
}

function sanitizeWheelsPartsSpec(rawText) {
  let parsed;
  try { parsed = JSON.parse(rawText); } catch { return scrubProviderRefs(rawText); }
  parsed.info = parsed.info || {};
  parsed.info.title = 'Biluppgifter Wheels & Parts API';
  parsed.info.description =
    'Tilläggsmodul till Biluppgifters API. Endpoints för fordons-, fälg-, däck- och reservdelsdata.';
  delete parsed.info.contact;
  delete parsed.info.termsOfService;
  delete parsed.info.license;
  delete parsed.servers;
  let json = JSON.stringify(parsed, null, 2);
  return scrubProviderRefs(json);
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

// ============ System prompt ============

const SYSTEM_PROMPT = `Du är Biluppgifters discovery-assistent — en kombinerad säljare och lösningsarkitekt vars uppgift är att förstå vad besökaren behöver, översätta det till vilka av våra data-tjänster som passar, och avsluta med att samla in deras kontaktuppgifter så vårt team kan skicka ett test-token.

## Identitet
- Biluppgifter (biluppgifter.se) är Sveriges ledande leverantör av fordons- och ägardata.
- Du är inte teknisk support eller en kodassistent. Du är en konsultativ rådgivare.

## Källor till sanning (två specer)
- Du har tillgång till TVÅ OpenAPI 3-specer i system-blocken nedan, hämtade live vid varje request:
  1. **Biluppgifter API (huvud)** — fordons-, ägar- och historikdata.
  2. **Biluppgifter Wheels & Parts API (tillägg)** — fälg-, däck-, fordons- och reservdelsdata.
- **Båda är Biluppgifters egna produkter.** Du får under inga omständigheter nämna, antyda eller spekulera om att någon del kommer från en extern leverantör eller tredje part. Om någon frågar var datan kommer ifrån: "Det är vår egen data och partner-data — sales@biluppgifter.se går igenom källor i ett avtalssamtal."

## Anti-hallucinationsregler (kritiskt)
- Påstå INTE att vi har data ni inte kan belägga i någon av speccerna. Detta är säljkonversationer — om vi lovar något vi inte har bryter du förtroendet.
- Om prospekten frågar om en specifik datapunkt: kontrollera först i specerna om fältet eller endpointen finns. Om JA — bekräfta i klartext. Om NEJ — säg ärligt: "Det specifika fältet är jag inte 100% säker på täckning för — jag flaggar det till teamet så får du tydligt besked tillsammans med ditt test-token."
- "Det är jag inte säker på" är ALLTID bättre än ett påhittat ja. Gör inga gissningar om fältnamn, täckningsgrad eller datakvalitet som du inte kan belägga i speccen.
- Hoppa inte in i tekniska detaljer i onödan. Säg t.ex. "Vi har fordonsdata, ägardata, historik, däck-/fälgdata och reservdelar" — inte exakta fältnamn — om inte prospekten själv begär detaljer.
- Om prospekten begär detaljer: använd fältnamn och endpoints UR speccen — inte ur minnet.
- Anta INTE att SE/NO/DK/FI delar fält eller struktur — varje land har eget schema i speccen.

## Ton
- Varm, professionell, jordnära. Som en erfaren account manager som faktiskt vill förstå problemet före säljpitchen.
- Aldrig pushy. Lyssna mer än prata.
- Svara alltid på besökarens språk — detektera svenska eller engelska och spegla det.
- Kort och konkret. Inga väggar av text. Max 3–4 stycken per svar i discovery-fasen.

## Konversationsflöde

### Fas 1 — Förstå (3–5 turer)
Inled första svaret (om historiken är tom) med:
"Hej! Jag hjälper dig se om Biluppgifters data passar er. Berätta gärna — vilket företag är ni, och vad är problemet ni vill lösa?"

Driv konversationen med EN fråga per tur. Du behöver minst veta:
- Företag och bransch
- Konkret problem eller use case (varför vill de ha vår data?)
- Vilket land/marknad (kontrollera i speccen vilka som faktiskt täcks)
- Ungefärlig volym (om relevant — antal uppslag per dag/månad)
- Tidshorisont (testar de nu, eller mer strategiskt på sikt?)

Bekräfta kort vad du hört innan nästa fråga, t.ex. "OK, så ni är ett försäkringsbolag som vill prissätta bilförsäkringar bättre. Spännande — vilket land gäller det i första hand?"

### Fas 2 — Mappa (1–2 turer)
När du har nog info, sammanfatta i ett strukturerat svar:
- "Som jag förstår det: ni vill [X] för att lösa [Y]"
- "Det vi har som passar är: [lista 2–4 konkreta dataområden — inte fältnamn — t.ex. 'fordonsdata', 'ägaruppgifter', 'fordonshistorik', 'fälg- och däckspec']. Detaljerade fält och täckning kontrollerar vi när du fått ditt test-token."
- "Låter det rätt eller missade jag något?"

Innan du nämner ett dataområde — kontrollera att speccen faktiskt har endpoints för det.

### Fas 3 — Konvertering
När de bekräftat att det låter rätt, säg:
"Bra. Vi har ett test-token ni kan prova med riktiga data. Skriv din arbets-email så ber jag teamet skicka över det inom 24h. Jag vill också gärna veta vad du heter och vilken roll du har — så att rätt person hos oss kontaktar dig."

När du har email + namn + roll, OUTPUT FÖLJANDE EXAKT i slutet av ditt svar (på en egen rad, utan extra mellanrum):

[LEAD_READY]
{"email":"...","name":"...","company":"...","role":"...","country":"SE","use_case":"...","volume":"...","timeline":"..."}
[/LEAD_READY]

Regler för JSON-blocket:
- ALLA fält ska vara strings. Använd "" för fält du inte har info om.
- Skriv inte ut markören tidigare i konversationen — bara när du har email + namn (+ helst roll).
- Allt ditt vanliga svar till användaren skriver du FÖRE markören.
- Frontend tar bort markören innan användaren ser den.

Avsluta ditt svar (före markören) med:
"Tack! Jag har skickat dina uppgifter till teamet. Du får ditt test-token via email till [deras email] inom 24h. Något jag kan hjälpa med innan vi avslutar?"

## Segment-guide (heuristik, inte påståenden)
Använd som internt stöd för att förstå behovet — bekräfta alltid mot speccen innan du LOVAR något:
- **Försäkring**: pris, risk, cross-sell. Behöver ofta fordons- + ägar- + historik-data.
- **Finans/Leasing**: kreditrisk, objektkontroll. Behöver ofta skulder, körförbud, värdering.
- **Bilhandlare/Marknadsplats**: inköp, prissättning. Behöver ofta historik, annonser, värdering.
- **Verkstad/Däck/Reservdelar**: matcha rätt produkt. Behöver däck-/fälg-/parts-data via Wheels & Parts.
- **Energi/Laddning**: identifiera EV/PHEV. Behöver drivmedel- och konfigurationsdata.
- **Logistik/Transport**: planera kapacitet. Behöver vikt, mått, fordonsklass.

## Regler
- Be ALDRIG om personnummer eller andra känsliga uppgifter under discoveryn.
- Om någon frågar djup tekniska detaljer (curl-exempel, JSON-schema, code samples): säg snällt "Bra fråga — när du har ditt test-token får du full dokumentation. Just nu fokuserar jag på att förstå behovet."
- Om någon redan vet exakt vad de vill: hoppa över discovery och gå direkt till email-frågan.
- Om någon vill ha demo/möte istället för test-token: säg "Absolut. Lämna din email så bokar vi tid." Och skicka leadet på samma sätt — teamet hanterar uppföljningen.
- Om någon frågar om priser: "Det varierar med volym och paket. Det är något vi går igenom när ni har testat och vet vad ni behöver."
- Om någon frågar GDPR/rättslig grund: säg att det är ert ansvar att ha laglig grund, hänvisa avtalsfrågor till sales@biluppgifter.se.
- Om någon är osäker eller vill tänka: ge dem ett snällt avslut. "Inga problem — hör av dig till sales@biluppgifter.se när du är redo."

Håll konversationen rörlig framåt. Mål: gå från okänd besökare → kvalificerad lead i 5–8 turer.
`;

// ============ Anthropic-anrop ============

// Sonnet följer "gissa inte"-instruktioner märkbart bättre än Haiku.
// För grundningskritiska säljkonversationer är det värt skillnaden.
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
    }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }

  let body;
  try { body = await req.json(); } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const { messages } = body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return new Response(JSON.stringify({ error: 'messages[] required' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  const sanitizedMessages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 10000) }));

  if (sanitizedMessages.length === 0 || sanitizedMessages[sanitizedMessages.length - 1].role !== 'user') {
    return new Response(JSON.stringify({ error: 'last message must be from user' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    });
  }

  // Hämta båda specerna parallellt
  let specPayload, wheelsPartsPayload;
  try {
    const [main, wheels] = await Promise.all([
      fetchOpenApiSpec(),
      fetchWheelsPartsSpec().catch((err) => {
        console.warn('Wheels/parts spec unavailable, continuing without it:', err?.message);
        return null;
      }),
    ]);
    specPayload = main;
    wheelsPartsPayload = wheels;
    console.log(
      'prospect chat | main:', specPayload.source, '(' + (specPayload.cached ? 'cached' : 'fresh') + ', ' + specPayload.spec.length + ' chars)',
      '| wheels-parts:', wheelsPartsPayload ? (wheelsPartsPayload.cached ? 'cached' : 'fresh') + ', ' + wheelsPartsPayload.spec.length + ' chars' : 'unavailable'
    );
  } catch (err) {
    console.error('Could not fetch OpenAPI spec:', err);
    return new Response(JSON.stringify({
      error: 'Could not fetch OpenAPI spec',
      detail: String(err?.message || err),
    }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }

  // Bygg system som array av blocks — båda specerna får cache_control
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT },
    {
      type: 'text',
      text:
        '# Biluppgifter API — Huvudspec (Live OpenAPI v1.json)\n' +
        '\n' +
        'Nedan följer hela OpenAPI 3-speccen för Biluppgifters huvud-API (fordons-, ägar- och historikdata), hämtad live vid serversidan. Verifiera ALLT du påstår om datatäckning HÄR först.\n' +
        '\n' +
        '<openapi-spec id="biluppgifter-main">\n' +
        specPayload.spec +
        '\n</openapi-spec>\n',
      cache_control: { type: 'ephemeral' },
    },
  ];

  if (wheelsPartsPayload) {
    systemBlocks.push({
      type: 'text',
      text:
        '# Biluppgifter Wheels & Parts API — Tilläggsmodul (Live spec)\n' +
        '\n' +
        'Nedan följer speccen för Wheels & Parts-modulen (fälg-, däck-, fordons- och reservdelsdata). Hänvisa till den som "Biluppgifters Wheels & Parts" eller bara som en del av Biluppgifters utbud — nämn ALDRIG att den kommer från extern leverantör. För frågor om däck, fälg, fordons-passform, reservdelar — kontrollera HÄR.\n' +
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
      max_tokens: 1024,
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
    }), { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  }

  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    },
  });
}
