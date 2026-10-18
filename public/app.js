const $ = (id) => document.getElementById(id);

// Reads an API response; turns HTML error pages (timeouts, gateway errors) into a clear message.
async function readJson(res) {
  const body = await res.text();
  try { return JSON.parse(body); } catch {
    return { error: res.status === 504 || res.status === 503
      ? 'The server took too long to answer. Press Answer the call to try again.'
      : `The server returned an unexpected response (${res.status}). Try again in a moment.` };
  }
}
const MAX_DEMO_TURNS = 10;

const state = {
  cfg: null, sessionId: null, running: false, busy: false, startedAt: 0, timer: null,
  recognition: null, callerTurns: 0, seenEntities: new Set(),
};

const ENTITY_LABELS = {
  upi_ids: 'UPI ID', phone_numbers: 'Phone', bank_accounts: 'Account', links: 'Link',
  names_used: 'Name used', amounts_demanded: 'Amount',
};

// ---------- setup ----------
async function init() {
  const res = await fetch('/api/config');
  state.cfg = await readJson(res);
  $('persona').innerHTML = state.cfg.personas.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('scenario').innerHTML = state.cfg.scenarios.map((s) => `<option value="${s.id}">${s.label}</option>`).join('');
  updatePersona();
  updateMode();
  $('persona').addEventListener('change', updatePersona);
  $('mode').addEventListener('change', updateMode);
  $('start').addEventListener('click', startCall);
  $('end').addEventListener('click', endCall);
  $('typed').addEventListener('submit', (e) => {
    e.preventDefault();
    const text = $('typed-input').value.trim();
    if (!text || !state.running || state.busy) return;
    $('typed-input').value = '';
    handleCaller(text);
  });
  $('copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('report-text').textContent);
    $('copy').textContent = 'Copied';
  });
  $('close').addEventListener('click', () => $('report').close());
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  if ('speechSynthesis' in window) speechSynthesis.getVoices();
}

const persona = () => state.cfg.personas.find((p) => p.id === $('persona').value);

function updatePersona() {
  const p = persona();
  $('persona-blurb').textContent = p.blurb;
  $('avatar').textContent = p.name.replace('Mr. ', '')[0];
}

function updateMode() {
  const mode = $('mode').value;
  $('scenario-field').hidden = mode !== 'demo';
  $('typed').hidden = mode !== 'text';
  if (mode === 'voice' && !getRecognition()) {
    setStatus('Voice input needs Chrome or Edge. Switch to typing, or let Gemini play the scammer.');
  }
}

function showTab(tab) {
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  $('view-call').hidden = tab !== 'call';
  $('view-feed').hidden = tab !== 'feed';
  if (tab === 'feed') loadFeed();
}

const setStatus = (t) => { $('status').textContent = t; };

// ---------- speech ----------
function pickVoice(gender, lang) {
  const voices = speechSynthesis.getVoices();
  const inLang = voices.filter((v) => v.lang.replace('_', '-').startsWith(lang.slice(0, 2)));
  const pool = inLang.length ? inLang : voices;
  const femaleHint = /female|woman|veena|lekha|heera|kalpana|swara|zira|samantha|google हिन्दी|neerja/i;
  const match = pool.find((v) => (gender === 'female' ? femaleHint.test(v.name) : !femaleHint.test(v.name)));
  return match || pool[0] || null;
}

// Natural voice from Google Cloud Text-to-Speech; falls back to the browser voice if the service fails.
let currentAudio = null;
async function speak(text, who) {
  if (!$('sound').checked) return new Promise((r) => setTimeout(r, 600));
  if (who === 'decoy') $('avatar').classList.add('talking');
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('/api/tts', {
      signal: ctrl.signal,
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, role: who, persona: $('persona').value, lang: $('lang').value }),
    });
    clearTimeout(t);
    if (!res.ok) throw new Error('tts');
    const url = URL.createObjectURL(await res.blob());
    await new Promise((resolve) => {
      const audio = new Audio(url);
      currentAudio = audio;
      const done = () => { clearTimeout(guard); URL.revokeObjectURL(url); currentAudio = null; resolve(); };
      const guard = setTimeout(done, 6000 + text.length * 120);
      audio.onended = done; audio.onerror = done;
      audio.play().catch(done);
    });
  } catch {
    await browserSpeak(text, who);
  }
  $('avatar').classList.remove('talking');
}

function browserSpeak(text, who) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return setTimeout(resolve, 600);
    const u = new SpeechSynthesisUtterance(text);
    const lang = $('lang').value;
    u.lang = lang;
    if (who === 'decoy') {
      const v = persona().voice;
      u.rate = v.rate; u.pitch = v.pitch; u.voice = pickVoice(v.gender, lang);
    } else {
      u.rate = 1.08; u.pitch = 0.75; u.voice = pickVoice(persona().voice.gender === 'female' ? 'male' : 'female', lang);
    }
    const done = () => { clearTimeout(guard); resolve(); };
    const guard = setTimeout(done, 4000 + text.length * 110);
    u.onend = done; u.onerror = done;
    speechSynthesis.speak(u);
  });
}

function getRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  if (!state.recognition) {
    const r = new SR();
    r.interimResults = false;
    r.continuous = false;
    r.onresult = (e) => {
      const text = Array.from(e.results).map((x) => x[0].transcript).join(' ').trim();
      if (text) handleCaller(text);
    };
    r.onend = () => { if (state.running && !state.busy && $('mode').value === 'voice') listen(); };
    r.onerror = (e) => { if (e.error === 'not-allowed') setStatus('Microphone blocked. Allow mic access in the address bar and try again.'); };
    state.recognition = r;
  }
  return state.recognition;
}

function listen() {
  const r = getRecognition();
  if (!r || !state.running) return;
  r.lang = $('lang').value;
  try { r.start(); setStatus('Listening to the scammer…'); } catch { /* already listening */ }
}

// ---------- call flow ----------
async function startCall() {
  resetIntel();
  $('transcript').innerHTML = '';
  state.callerTurns = 0;
  state.seenEntities.clear();
  $('start').disabled = true;
  ['persona', 'mode', 'scenario', 'lang'].forEach((id) => { $(id).disabled = true; });
  setStatus('Connecting…');
  try {
    const res = await fetch('/api/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: $('persona').value, scenario: $('scenario').value, mode: $('mode').value }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error);
    state.sessionId = data.id;
    state.running = true;
    state.startedAt = Date.now();
    state.timer = setInterval(tick, 500);
    $('end').disabled = false;
    addBubble('decoy', data.opener);
    await speak(data.opener, 'decoy');
    nextStep();
  } catch (e) {
    setStatus(e.message || 'Could not start the call.');
    resetControls();
  }
}

function nextStep() {
  if (!state.running) return;
  const mode = $('mode').value;
  if (mode === 'voice') listen();
  else if (mode === 'text') { setStatus('Type the scammer\u2019s next line.'); $('typed-input').focus(); }
  else demoCallerTurn();
}

async function demoCallerTurn() {
  if (!state.running) return;
  if (state.callerTurns >= MAX_DEMO_TURNS) { setStatus('Demo finished. Hanging up and filing the report.'); return endCall(); }
  setStatus('Gemini is playing the scammer…');
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/caller`, { method: 'POST' });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error);
    if (!state.running) return;
    addBubble('caller', data.text);
    await speak(data.text, 'caller');
    handleCaller(data.text, true);
  } catch (e) {
    setStatus(e.message || 'The scammer agent stopped responding.');
  }
}

async function handleCaller(text, alreadyShown = false) {
  if (!state.running || state.busy) return;
  state.busy = true;
  state.callerTurns += 1;
  if (state.recognition) try { state.recognition.stop(); } catch { /* idle */ }
  if (!alreadyShown) addBubble('caller', text);
  const p = persona();
  const thinking = addBubble('decoy', `${p.name} is looking for ${p.voice.gender === 'female' ? 'her' : 'his'} glasses…`, true);
  setStatus('Gemini is answering and analysing the caller…');
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/turn`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error);
    thinking.remove();
    fetchIntel(state.sessionId);
    addBubble('decoy', data.reply);
    setStatus(`Replied in ${(data.latencyMs / 1000).toFixed(1)}s`);
    state.busy = false;
    await speak(data.reply, 'decoy');
    nextStep();
  } catch (e) {
    thinking.remove();
    state.busy = false;
    setStatus(e.message || 'Something went wrong. Try again.');
  }
}

// Analysis arrives separately so the decoy can speak straight away.
async function fetchIntel(id) {
  try {
    const res = await fetch(`/api/sessions/${id}/intel`);
    const data = await readJson(res);
    if (res.ok && data.intel && id === state.sessionId) renderIntel(data.intel);
  } catch { /* the next turn will refresh the panel */ }
}

async function endCall() {
  if (!state.sessionId) return;
  state.running = false;
  clearInterval(state.timer);
  if (state.recognition) try { state.recognition.abort(); } catch { /* idle */ }
  if ('speechSynthesis' in window) speechSynthesis.cancel();
  if (currentAudio) { currentAudio.pause(); currentAudio = null; }
  $('end').disabled = true;
  setStatus('Writing the complaint draft…');
  try {
    const res = await fetch(`/api/sessions/${state.sessionId}/end`, { method: 'POST' });
    const data = await readJson(res);
    if (!res.ok) throw new Error(data.error);
    setStatus(`Call ended. Scammer kept busy for ${fmt(data.secondsWasted)}. Evidence added to the threat feed.`);
    if (data.report) {
      $('report-text').textContent = data.report;
      $('copy').textContent = 'Copy complaint';
      $('report').showModal();
    }
  } catch (e) {
    setStatus(e.message);
  }
  state.sessionId = null;
  resetControls();
}

function resetControls() {
  $('start').disabled = false;
  $('end').disabled = true;
  ['persona', 'mode', 'scenario', 'lang'].forEach((id) => { $(id).disabled = false; });
}

// ---------- rendering ----------
const fmt = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
function tick() { $('timer').textContent = fmt(Math.floor((Date.now() - state.startedAt) / 1000)); }

function addBubble(role, text, thinking = false) {
  const li = document.createElement('li');
  li.className = role + (thinking ? ' thinking' : '');
  const who = document.createElement('b');
  who.textContent = role === 'caller' ? 'Scammer' : persona().name;
  li.append(who, document.createTextNode(text));
  $('transcript').append(li);
  $('transcript').scrollTop = $('transcript').scrollHeight;
  return li;
}

function resetIntel() {
  $('risk-num').textContent = '0';
  $('risk-fill').style.width = '0';
  $('risk-fill').className = '';
  $('scam-type').textContent = 'Waiting for the caller';
  $('imp').textContent = 'Not yet clear';
  $('entities').innerHTML = '<li class="empty">Identifiers the scammer reveals will appear here.</li>';
  $('tactics').innerHTML = '';
  $('flags').innerHTML = '';
  $('summary').textContent = '';
  $('timer').textContent = '00:00';
}

function renderIntel(intel) {
  $('risk-num').textContent = intel.risk_score;
  $('risk-fill').style.width = `${intel.risk_score}%`;
  $('risk-fill').className = intel.risk_score >= 70 ? 'high' : intel.risk_score >= 40 ? 'mid' : '';
  $('scam-type').textContent = intel.scam_type;
  $('imp').textContent = intel.impersonated_entity || 'Not yet clear';

  const items = [];
  for (const [kind, values] of Object.entries(intel.entities || {})) {
    for (const v of values || []) items.push({ kind, v });
  }
  const list = $('entities');
  list.innerHTML = '';
  if (!items.length) list.innerHTML = '<li class="empty">Nothing revealed yet. The decoy keeps asking.</li>';
  for (const { kind, v } of items) {
    const key = `${kind}:${v}`;
    const li = document.createElement('li');
    if (!state.seenEntities.has(key)) { li.classList.add('new'); state.seenEntities.add(key); }
    const strong = document.createElement('strong'); strong.textContent = v;
    const span = document.createElement('span'); span.textContent = ENTITY_LABELS[kind] || kind;
    li.append(strong, span);
    list.append(li);
  }

  $('tactics').innerHTML = '';
  for (const t of intel.tactics || []) {
    const li = document.createElement('li'); li.textContent = t; $('tactics').append(li);
  }
  $('flags').innerHTML = '';
  for (const f of intel.red_flags || []) {
    const li = document.createElement('li');
    const q = document.createElement('q'); q.textContent = f.quote;
    const s = document.createElement('small'); s.textContent = f.why;
    li.append(q, s); $('flags').append(li);
  }
  $('summary').textContent = [intel.summary, intel.advice].filter(Boolean).join(' ');
}

async function loadFeed() {
  try {
    const res = await fetch('/api/stats');
    const s = await readJson(res);
    if (!res.ok) throw new Error(s.error);
    $('f-calls').textContent = s.calls;
    $('f-time').textContent = s.secondsWasted >= 3600 ? `${(s.secondsWasted / 3600).toFixed(1)}h` : `${Math.round(s.secondsWasted / 60)}m`;
    $('f-ind').textContent = s.indicators.length;
    $('f-lat').textContent = s.avgLatencyMs ? `${(s.avgLatencyMs / 1000).toFixed(1)}s` : '–';

    const types = Object.entries(s.byType).sort((a, b) => b[1] - a[1]);
    const max = Math.max(1, ...types.map((t) => t[1]));
    $('f-types').innerHTML = types.length ? '' : '<li class="muted">No calls yet.</li>';
    for (const [name, n] of types) {
      const li = document.createElement('li');
      li.innerHTML = `<div>${escapeHtml(name)} <span class="muted">(${n})</span></div><div class="bar" style="width:${(n / max) * 100}%"></div>`;
      $('f-types').append(li);
    }
    const tbody = $('f-table');
    tbody.innerHTML = s.indicators.length ? '' : '<tr><td colspan="4" class="muted">Finish a call to add the first identifiers.</td></tr>';
    for (const ind of s.indicators) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${escapeHtml(ind.value)}</td><td>${ENTITY_LABELS[ind.kind] || ind.kind}</td><td>${ind.count}×</td><td>${escapeHtml((ind.scamTypes || []).join(', '))}</td>`;
      tbody.append(tr);
    }
  } catch (e) {
    $('f-table').innerHTML = `<tr><td colspan="4">${escapeHtml(e.message || 'Could not load the feed.')}</td></tr>`;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

init();
