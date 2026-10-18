// Persistence layer. Uses Firestore in production (Cloud Run), in-memory when USE_MEMORY_STORE=1.
import crypto from 'node:crypto';

const useMemory = process.env.USE_MEMORY_STORE === '1';

let db = null;
let FieldValue = null;
if (!useMemory) {
  const { initializeApp } = await import('firebase-admin/app');
  const fs = await import('firebase-admin/firestore');
  initializeApp(); // Uses the Cloud Run service account automatically
  db = fs.getFirestore();
  FieldValue = fs.FieldValue;
}

const mem = { sessions: new Map(), indicators: new Map(), stats: { calls: 0, secondsWasted: 0, byType: {}, latencyMs: [] } };

const indicatorId = (type, value) =>
  crypto.createHash('sha1').update(`${type}:${String(value).toLowerCase().replace(/\s+/g, '')}`).digest('hex').slice(0, 20);

export async function createSession(data) {
  const id = crypto.randomUUID();
  const doc = { ...data, id, transcript: [], intel: null, status: 'live', createdAt: Date.now() };
  if (useMemory) mem.sessions.set(id, doc);
  else await db.collection('sessions').doc(id).set(doc);
  return doc;
}

export async function getSession(id) {
  if (useMemory) return mem.sessions.get(id) || null;
  const snap = await db.collection('sessions').doc(id).get();
  return snap.exists ? snap.data() : null;
}

export async function updateSession(id, patch) {
  if (useMemory) {
    const s = mem.sessions.get(id);
    if (s) Object.assign(s, patch);
    return;
  }
  await db.collection('sessions').doc(id).set(patch, { merge: true });
}

export async function recordLatency(ms) {
  if (useMemory) {
    mem.stats.latencyMs.push(ms);
    if (mem.stats.latencyMs.length > 200) mem.stats.latencyMs.shift();
    return;
  }
  await db.collection('stats').doc('global').set(
    { latencyTotalMs: FieldValue.increment(ms), latencyCount: FieldValue.increment(1) },
    { merge: true },
  );
}

// Called once when a call ends: aggregates stats and upserts every revealed indicator into the shared threat feed.
export async function finaliseSession(session, secondsWasted) {
  const intel = session.intel || {};
  const type = intel.scam_type || 'Other / unknown';
  const entities = intel.entities || {};
  const indicators = [];
  for (const [kind, values] of Object.entries(entities)) {
    for (const value of values || []) if (value) indicators.push({ kind, value: String(value).trim() });
  }

  if (useMemory) {
    mem.stats.calls += 1;
    mem.stats.secondsWasted += secondsWasted;
    mem.stats.byType[type] = (mem.stats.byType[type] || 0) + 1;
    for (const ind of indicators) {
      const id = indicatorId(ind.kind, ind.value);
      const cur = mem.indicators.get(id) || { ...ind, count: 0, scamTypes: [], firstSeen: Date.now() };
      cur.count += 1;
      cur.lastSeen = Date.now();
      if (!cur.scamTypes.includes(type)) cur.scamTypes.push(type);
      mem.indicators.set(id, cur);
    }
    return;
  }

  const batch = db.batch();
  batch.set(
    db.collection('stats').doc('global'),
    {
      calls: FieldValue.increment(1),
      secondsWasted: FieldValue.increment(secondsWasted),
      byType: { [type]: FieldValue.increment(1) },
    },
    { merge: true },
  );
  for (const ind of indicators) {
    batch.set(
      db.collection('indicators').doc(indicatorId(ind.kind, ind.value)),
      {
        kind: ind.kind,
        value: ind.value,
        count: FieldValue.increment(1),
        scamTypes: FieldValue.arrayUnion(type),
        lastSeen: Date.now(),
      },
      { merge: true },
    );
  }
  await batch.commit();
}

export async function getStats() {
  if (useMemory) {
    const l = mem.stats.latencyMs;
    return {
      calls: mem.stats.calls,
      secondsWasted: mem.stats.secondsWasted,
      byType: mem.stats.byType,
      avgLatencyMs: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null,
      indicators: [...mem.indicators.values()].sort((a, b) => b.lastSeen - a.lastSeen).slice(0, 30),
    };
  }
  const [statsSnap, indSnap] = await Promise.all([
    db.collection('stats').doc('global').get(),
    db.collection('indicators').orderBy('lastSeen', 'desc').limit(30).get(),
  ]);
  const s = statsSnap.exists ? statsSnap.data() : {};
  return {
    calls: s.calls || 0,
    secondsWasted: s.secondsWasted || 0,
    byType: s.byType || {},
    avgLatencyMs: s.latencyCount ? Math.round(s.latencyTotalMs / s.latencyCount) : null,
    indicators: indSnap.docs.map((d) => d.data()),
  };
}
