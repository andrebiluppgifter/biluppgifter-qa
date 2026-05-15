# Biluppgifter Prospect Chatbot

Guidad discovery-chatbot för biluppgifters API. Inte teknisk Q&A — den ställer frågor, kvalificerar prospekt, mappar deras behov till våra datapunkter, och samlar in kontaktuppgifter så ert team kan skicka ett test-token manuellt via email.

## Hur det funkar

1. Besökare landar på sidan → bot öppnar med en discovery-fråga
2. Botten ställer frågor om bransch, problem, land, volym, timeline (3-5 turer)
3. Botten sammanfattar use caset och mappar mot konkreta datapunkter i ert API
4. Botten ber om email, namn, roll
5. När all info finns: ett mail skickas automatiskt till `LEAD_TO_EMAIL` med leadets info
6. Botten bekräftar till besökaren att teamet hör av sig inom 24h
7. Ni manuellt issuar test-token och mailar det till leaden

## Filer

| Fil | Roll |
|---|---|
| `index.html` | Frontend — discovery-chat-UI med lead-bekräftelsekort |
| `api/chat.js` | Edge function — discovery-konversation (Anthropic) |
| `api/lead.js` | Edge function — skickar lead-info till er inkorg via Resend |
| `vercel.json` | Vercel-config (tom — defaults räcker) |
| `.env.example` | Mall för miljövariabler |
| `.gitignore` | Skyddar hemligheter från att hamna i repot |

## Deploy-guide

### Steg 1 — Skaffa Resend-konto för mail

1. Gå till [resend.com](https://resend.com) → **Sign Up** (gratis)
2. Verifiera din email
3. Vänster meny: **API Keys** → **Create API Key**
4. Namnge t.ex. `biluppgifter-prospect`, permission: **Sending access**
5. Kopiera nyckeln (börjar med `re_...`) — du klistrar in den i Vercel senare

*Senare när allt funkar:* gå till **Domains** → **Add Domain** → `biluppgifter.se` → följ DNS-instruktionerna. När domänen är verifierad kan du sätta `LEAD_FROM_EMAIL=noreply@biluppgifter.se` så mailen kommer "från Biluppgifter" istället för Resend.

### Steg 2 — Skapa GitHub-repo

Samma flöde som tekniska assistenten:

1. [github.com/new](https://github.com/new) — namn t.ex. `biluppgifter-prospect`
2. **Public** eller **Private** (båda funkar)
3. Lämna allt omarkerat → **Create repository**
4. På den tomma reposidan: klicka **"uploading an existing file"**
5. I Finder, gå till `~/Documents/Claude/Projects/Bot/prospect`
6. Markera alla filer + `api/`-mappen (Cmd+A i Finder), dra in i webbläsaren
7. **OBS:** `.env.example` är en gömd fil — i Finder, tryck `Cmd+Shift+.` för att se gömda filer. Den ska med. Den hemliga `.env`-filen ska INTE med.
8. Commit changes

### Steg 3 — Importera till Vercel

1. [vercel.com/new](https://vercel.com/new) → hitta `biluppgifter-prospect` → **Import**
2. **VIKTIGT — innan Deploy**: expandera **Environment Variables** och lägg till tre:
   - **`ANTHROPIC_API_KEY`** = din `sk-ant-...` från Anthropic
   - **`RESEND_API_KEY`** = din `re_...` från Resend
   - **`LEAD_TO_EMAIL`** = `info@biluppgifter.se` (eller annan address)
   - **`LEAD_FROM_EMAIL`** = `onboarding@resend.dev` (tills ni verifierat egen domän hos Resend)
3. Klicka **Deploy**

### Steg 4 — Testa

Öppna URL:en (t.ex. `https://biluppgifter-prospect.vercel.app`). Botten ska öppna med en discovery-fråga. Kör genom hela flödet — låtsas vara en kund från ett försäkringsbolag som vill prissätta bilförsäkringar. Mata in en testbar email i slutet. Kolla att mail landar i `LEAD_TO_EMAIL`-inkorgen.

**Om mailet inte kommer:** kolla Vercel → Project → Functions → `api/lead.js` → Logs. Vanligaste felen:
- `RESEND_API_KEY` fel → kolla att den är rätt kopierad i Vercel env
- `LEAD_FROM_EMAIL` är inte verifierad → använd `onboarding@resend.dev` tills domänen är verifierad
- Spamfilter → kolla skräp-mappen

## Iterera

System prompten med discovery-flödet ligger i `api/chat.js` (`SYSTEM_PROMPT`-konstanten). Vill du ändra ton, lägga till frågor, eller mappa nya use cases — ändra där och commita. Vercel auto-deployar.

Lead-mailets format ligger i `api/lead.js`. Vill ni ha det till HubSpot/Pipedrive/Slack istället — säg till så bygger jag det.

## Kontakt

Frågor: info@biluppgifter.se
