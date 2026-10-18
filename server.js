import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GoogleGenAI, Type } from '@google/genai';
import { GoogleAuth } from 'google-auth-library';
import {
  PERSONAS, SCENARIOS, decoySystemPrompt, scammerSystemPrompt, INTEL_PROMPT, REPORT_PROMPT,
} from './prompts.js';
import * as store from './store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';

// Gemini client: API key from AI Studio (simplest), or Vertex AI with the Cloud Run service account.
const ai = process.env.GEMINI_API_KEY
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : new GoogleGenAI({
      vertexai: true,
      project: process.env.GOOGLE_CLOUD_PROJECT,
      location: process.env.GOOGLE_CLOUD_LOCATION || 'us-central1',
    });

// Fast replies matter for a voice call: skip "thinking" on 2.5 Flash models for the spoken turns.
// Thinking makes Gemini 3 models slow for a live call. Try the configured level, then "low", then no setting.
const thinkingLevels = MODEL.includes('2.5')
  ? [{ thinkingBudget: 0 }]
  : [...new Set([process.env.GEMINI_THINKING || 'low', 'low'])].map((l) => ({ thinkingLevel: l }));
let thinkingIdx = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every Gemini call goes through here: fastest supported thinking level, a hard timeout so a slow call
// cannot stall the phone call, and short retries when Vertex AI is briefly out of capacity (429).
async function gen({ contents, config, timeoutMs = 20000 }) {
  const base = { ...config, httpOptions: { timeout: timeoutMs } };
  for (let attempt = 0; ; attempt++) {
    const thinking = thinkingLevels[thinkingIdx];
    try {
      return await ai.models.generateContent({
        model: MODEL, contents, config: thinking ? { ...base, thinkingConfig: thinking } : base,
      });
    } catch (e) {
      if (e.status === 400 && thinking) {
        console.error('thinking setting rejected, trying next option:', JSON.stringify(thinking));
        thinkingIdx += 1;
        continue;
      }
      if (e.status === 429 && attempt < 2) {
        await sleep(1200 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

const STALLS = [
  'Hello? Beta, the line is breaking. Say again slowly?',
  'One minute beta, the pressure cooker is whistling. You were saying?',
  'Arre, my glasses fell somewhere. Repeat that please?',
  'Haan haan, I am listening. Speak loudly, this phone is very soft.',
];

const SCAM_TYPES = [
  'Digital arrest', 'Bank / KYC update', 'Utility disconnection', 'Job / task scam', 'Lottery / prize',
  'Investment / trading', 'Loan app', 'Tech support', 'Other / unknown',
];

const intelSchema = {
  type: Type.OBJECT,
  properties: {
    scam_type: { type: Type.STRING, enum: SCAM_TYPES },
    risk_score: { type: Type.INTEGER },
    impersonated_entity: { type: Type.STRING },
    tactics: { type: Type.ARRAY, items: { type: Type.STRING } },
    entities: {
      type: Type.OBJECT,
      properties: {
        upi_ids: { type: Type.ARRAY, items: { type: Type.STRING } },
        phone_numbers: { type: Type.ARRAY, items: { type: Type.STRING } },
        bank_accounts: { type: Type.ARRAY, items: { type: Type.STRING } },
        links: { type: Type.ARRAY, items: { type: Type.STRING } },
        names_used: { type: Type.ARRAY, items: { type: Type.STRING } },
        amounts_demanded: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['upi_ids', 'phone_numbers', 'bank_accounts', 'links', 'names_used', 'amounts_demanded'],
    },
    red_flags: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { quote: { type: Type.STRING }, why: { type: Type.STRING } },
        required: ['quote', 'why'],
      },
    },
    summary: { type: Type.STRING },
    advice: { type: Type.STRING },
  },
  required: ['scam_type', 'risk_score', 'impersonated_entity', 'tactics', 'entities', 'red_flags', 'summary', 'advice'],
};

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const clean = (t) => String(t || '').replace(/[*_#`]/g, '').replace(/\s+/g, ' ').trim();
const transcriptText = (t) => t.map((m) => `${m.role === 'caller' ? 'CALLER' : 'DECOY'}: ${m.text}`).join('\n');

// Regex safety net: identifiers spotted deterministically are merged into Gemini's extraction.
function regexEntities(callerText) {
  const uniq = (a) => [...new Set(a)];
  return {
    upi_ids: uniq(callerText.match(/\b[a-z0-9._-]{2,}@[a-z]{2,}\b/gi) || []).filter((x) => !x.includes('.com')),
    phone_numbers: uniq(callerText.match(/(?:\+91[\s-]?)?\b[6-9]\d{9}\b/g) || []),
    bank_accounts: uniq(callerText.match(/\b\d{11,18}\b/g) || []),
    links: uniq(callerText.match(/\b(?:https?:\/\/)?(?:[a-z0-9-]+\.)+(?:in|com|net|org|xyz|me|info|online|site)(?:\/\S*)?/gi) || []),
  };
}

function mergeEntities(gem = {}, rx = {}) {
  const out = { ...gem };
  for (const k of Object.keys(rx)) {
    const seen = new Set((out[k] || []).map((v) => v.toLowerCase().replace(/\s/g, '')));
    out[k] = [...(out[k] || [])];
    for (const v of rx[k]) if (!seen.has(v.toLowerCase())) out[k].push(v);
  }
  return out;
}

async function decoyReply(session) {
  const persona = PERSONAS[session.persona];
  // Conversations must start with a user turn, so the ring of the phone is the first "user" message.
  const contents = [
    { role: 'user', parts: [{ text: '(The phone rings and you pick up.)' }] },
    ...session.transcript.map((m) => ({
      role: m.role === 'caller' ? 'user' : 'model',
      parts: [{ text: m.text }],
    })),
  ];
  const res = await gen({
    contents,
    config: { systemInstruction: decoySystemPrompt(persona), temperature: 1.0 },
    timeoutMs: 18000,
  });
  return clean(res.text) || 'Hello? Beta, the line is breaking. Say again slowly?';
}

async function extractIntel(session) {
  const res = await gen({
    timeoutMs: 45000,
    contents: [{ role: 'user', parts: [{ text: `Transcript so far:\n${transcriptText(session.transcript)}` }] }],
    config: {
      systemInstruction: INTEL_PROMPT,
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: intelSchema,
    },
  });
  const intel = JSON.parse(res.text);
  const callerText = session.transcript.filter((m) => m.role === 'caller').map((m) => m.text).join(' ');
  intel.entities = mergeEntities(intel.entities, regexEntities(callerText));
  intel.risk_score = Math.max(0, Math.min(100, intel.risk_score || 0));
  return intel;
}

// ---------- API ----------

app.get('/api/health', (_req, res) => res.json({ ok: true, model: MODEL }));

app.get('/api/config', (_req, res) => {
  res.json({
    personas: Object.values(PERSONAS).map(({ id, name, blurb, voice, opener }) => ({ id, name, blurb, voice, opener })),
    scenarios: Object.values(SCENARIOS).map(({ id, label }) => ({ id, label })),
  });
});

app.post('/api/sessions', async (req, res) => {
  try {
    const persona = PERSONAS[req.body.persona] ? req.body.persona : 'kamala';
    const scenario = SCENARIOS[req.body.scenario] ? req.body.scenario : null;
    const mode = ['voice', 'text', 'demo'].includes(req.body.mode) ? req.body.mode : 'text';
    const session = await store.createSession({ persona, scenario, mode });
    const opener = PERSONAS[persona].opener;
    session.transcript.push({ role: 'decoy', text: opener, at: Date.now() });
    await store.updateSession(session.id, { transcript: session.transcript });
    res.json({ id: session.id, opener });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not start the call. Check Firestore setup and try again.' });
  }
});

// The caller (scammer) said something: decoy replies AND intel is extracted, in parallel.
// The caller (scammer) said something. The decoy reply is returned as soon as it is ready; the fraud-intel
// analysis runs in parallel and is collected by the browser from /intel, so analysis never delays the voice.
const pendingIntel = new Map();

app.post('/api/sessions/:id/turn', async (req, res) => {
  const t0 = Date.now();
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Call not found. Start a new call.' });
    const text = clean(req.body.text).slice(0, 1000);
    if (!text) return res.status(400).json({ error: 'Nothing was heard from the caller.' });

    session.transcript.push({ role: 'caller', text, at: Date.now() });

    const intelJob = extractIntel(session)
      .then(async (intel) => {
        await store.updateSession(session.id, { intel });
        console.log(`intel ${session.id.slice(0, 8)} ready in ${Date.now() - t0}ms`);
        return intel;
      })
      .catch((e) => { console.error('intel', e.message); return null; });
    pendingIntel.set(session.id, intelJob);
    setTimeout(() => { if (pendingIntel.get(session.id) === intelJob) pendingIntel.delete(session.id); }, 120000);

    const reply = await decoyReply(session).catch((e) => {
      console.error('decoy', e.status || '', e.message);
      return STALLS[Math.floor(Math.random() * STALLS.length)];
    });
    session.transcript.push({ role: 'decoy', text: reply, at: Date.now() });
    await store.updateSession(session.id, { transcript: session.transcript });

    const latencyMs = Date.now() - t0;
    console.log(`turn ${session.id.slice(0, 8)} answered in ${latencyMs}ms`);
    store.recordLatency(latencyMs).catch(() => {});
    res.json({ reply, latencyMs });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Gemini did not respond. Check the model settings and try again.' });
  }
});

app.get('/api/sessions/:id/intel', async (req, res) => {
  try {
    const job = pendingIntel.get(req.params.id);
    if (job) {
      const intel = await job;
      if (intel) return res.json({ intel });
    }
    const session = await store.getSession(req.params.id);
    res.json({ intel: session?.intel || null });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load the analysis.' });
  }
});

// Demo mode: a second Gemini agent plays the scammer so judges can watch AI vs AI without a phone.
// Gemini rewrites the next scripted beat naturally; refusals or rambling fall back to the scripted line.
const REFUSAL = /\b(i cannot|i can't|i can not|i won't|i'm unable|i am unable|i'm not able|role-?play|as an ai|simulat|fraudulent|i must decline)\b/i;

app.post('/api/sessions/:id/caller', async (req, res) => {
  try {
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Call not found.' });
    const scenario = SCENARIOS[session.scenario] || SCENARIOS.digital_arrest;
    const callerTurns = session.transcript.filter((m) => m.role === 'caller').length;
    const beat = scenario.fallback[callerTurns % scenario.fallback.length];
    let text = '';
    try {
      const r = await gen({
        timeoutMs: 15000,
        contents: [{
          role: 'user',
          parts: [{ text: `Conversation so far:\n${transcriptText(session.transcript)}\n\nNEXT SCRIPT BEAT: ${beat}` }],
        }],
        config: { systemInstruction: scammerSystemPrompt(scenario), temperature: 0.8 },
      });
      text = clean(r.text);
    } catch (e) {
      console.error('caller agent', e.message);
    }
    if (!text || text.length > 260 || REFUSAL.test(text)) text = beat;
    res.json({ text });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not generate the caller line.' });
  }
});

// Natural voices: Google Cloud Text-to-Speech (Chirp 3 HD, then Neural2). The browser voice is only a last resort.
const ttsAuth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const ttsCache = new Map();
const NEURAL2 = { 'en-IN': { female: 'en-IN-Neural2-A', male: 'en-IN-Neural2-B' }, 'hi-IN': { female: 'hi-IN-Neural2-A', male: 'hi-IN-Neural2-B' } };
const FEMALE = new Set(['Leda', 'Kore', 'Aoede', 'Zephyr', 'Achernar', 'Despina', 'Gacrux', 'Vindemiatrix', 'Sulafat']);
async function synthesize(text, voiceName, languageCode) {
  const client = await ttsAuth.getClient();
  const r = await client.request({
    url: 'https://texttospeech.googleapis.com/v1/text:synthesize',
    method: 'POST',
    timeout: 12000,
    data: { input: { text }, voice: { languageCode, name: voiceName }, audioConfig: { audioEncoding: 'MP3' } },
  });
  return r.data.audioContent;
}

app.post('/api/tts', async (req, res) => {
  const text = clean(req.body.text).slice(0, 600);
  const lang = req.body.lang === 'hi-IN' ? 'hi-IN' : 'en-IN';
  const persona = PERSONAS[req.body.persona] || PERSONAS.kamala;
  const short = req.body.role === 'caller' ? persona.tts.caller : persona.tts.decoy;
  if (!text) return res.status(400).json({ error: 'No text to speak.' });
  const key = `${lang}|${short}|${text}`;
  try {
    let audio = ttsCache.get(key);
    if (!audio) {
      try {
        audio = await synthesize(text, `${lang}-Chirp3-HD-${short}`, lang);
      } catch (e) {
        console.error('chirp tts', e.message);
        audio = await synthesize(text, NEURAL2[lang][FEMALE.has(short) ? 'female' : 'male'], lang);
      }
      ttsCache.set(key, audio);
      if (ttsCache.size > 300) ttsCache.delete(ttsCache.keys().next().value);
    }
    res.set('Content-Type', 'audio/mpeg').send(Buffer.from(audio, 'base64'));
  } catch (e) {
    console.error('tts', e.message);
    res.status(502).json({ error: 'Voice service unavailable.' });
  }
});

app.post('/api/sessions/:id/end', async (req, res) => {
  try {
    const job = pendingIntel.get(req.params.id);
    if (job) await job;
    const session = await store.getSession(req.params.id);
    if (!session) return res.status(404).json({ error: 'Call not found.' });
    if (session.status === 'ended') return res.json({ report: session.report, secondsWasted: session.secondsWasted });

    const secondsWasted = Math.round((Date.now() - session.createdAt) / 1000);
    let report = '';
    if (session.transcript.some((m) => m.role === 'caller')) {
      const r = await gen({
        timeoutMs: 30000,
        contents: [{
          role: 'user',
          parts: [{ text: `Intelligence JSON:\n${JSON.stringify(session.intel || {})}\n\nTranscript:\n${transcriptText(session.transcript)}` }],
        }],
        config: { systemInstruction: REPORT_PROMPT, temperature: 0.2 },
      });
      report = String(r.text || '').trim();
    }
    await store.updateSession(session.id, { status: 'ended', report, secondsWasted, endedAt: Date.now() });
    if (session.intel) await store.finaliseSession(session, secondsWasted);
    res.json({ report, secondsWasted });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not write the report. The call data is still saved.' });
  }
});

app.get('/api/stats', async (_req, res) => {
  try {
    res.json(await store.getStats());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not load the threat feed.' });
  }
});

app.listen(PORT, () => console.log(`ScamBait listening on ${PORT} with model ${MODEL}`));
