// أجيال — خادم Node: يقدّم التطبيق + واجهات ذكاء/اشتراك/تحليلات، مع Postgres اختياري (DATABASE_URL).
//  GET  /api/health              → حالة الخادم (db/gen/tts/events)
//  GET  /api/verify?code=        → تحقّق تفعيل (ACTIVE_CODES env ∪ جدول activations)
//  POST /api/admin/activate      → تفعيل كود دائم (header x-admin-secret) — بلا إعادة نشر
//  POST /api/generate            → توليد أسئلة من المنهج عبر Claude API (محمي بالاشتراك)
//  GET  /api/tts?code=&text=     → نطق عربي MP3 (غير محمي، محدود بالـIP + كاش)
//  POST /api/event               → تحليلات (عدّاد بالذاكرة + جدول events + لوج)
//  POST /api/score               → حفظ نتيجة جلسة (جدول scores)
//  GET  /api/leaderboard?limit=  → أعلى النتائج
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const GEN_MODEL = process.env.GEN_MODEL || 'claude-haiku-4-5';
const MAX_GEN = Number(process.env.MAX_GEN_PER_DAY || 40);
const MAX_TTS = Number(process.env.MAX_TTS_PER_DAY || 600);

// ===== Postgres (اختياري) =====
let pool = null;
if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : false,
      max: 5
    });
    pool.on('error', e => console.error('[pg pool error]', e.message));
  } catch (e) { console.error('[pg init failed]', e.message); pool = null; }
}
async function initDb() {
  if (!pool) { console.log('[db] no DATABASE_URL — running without database'); return; }
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS activations(code TEXT PRIMARY KEY, note TEXT, created_at TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS events(id BIGSERIAL PRIMARY KEY, name TEXT, mode TEXT, extra JSONB, ip TEXT, ts TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS scores(id BIGSERIAL PRIMARY KEY, name TEXT, score INT, mode TEXT, streak INT, ip TEXT, ts TIMESTAMPTZ DEFAULT now());
      CREATE TABLE IF NOT EXISTS nursery_answers(id BIGSERIAL PRIMARY KEY, code TEXT, child TEXT, topic TEXT, question TEXT, correct BOOLEAN, ts TIMESTAMPTZ DEFAULT now());
      CREATE INDEX IF NOT EXISTS idx_na_code ON nursery_answers(code);
      CREATE TABLE IF NOT EXISTS trials(ip TEXT PRIMARY KEY, last_used TIMESTAMPTZ);
    `);
    console.log('[db] connected + schema ready');
  } catch (e) { console.error('[db] init error:', e.message); }
}

// ===== الاشتراك: env ∪ DB =====
function activeSet() {
  return new Set(String(process.env.ACTIVE_CODES || '').split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean));
}
async function isActive(code) {
  if (!code) return false;
  const c = String(code).trim().toUpperCase();
  if (activeSet().has(c)) return true;
  if (pool) { try { const r = await pool.query('SELECT 1 FROM activations WHERE upper(code)=$1 LIMIT 1', [c]); return r.rowCount > 0; } catch (e) { return false; } }
  return false;
}

// ===== حدّ استخدام يومي في الذاكرة =====
const RL = {};
function rateOk(id, kind, max) {
  const day = new Date().toISOString().slice(0, 10);
  const k = String(id).toUpperCase() + '|' + day;
  RL[k] = RL[k] || {};
  if ((RL[k][kind] || 0) >= max) return false;
  RL[k][kind] = (RL[k][kind] || 0) + 1; return true;
}
function clientIp(req) { return String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'ip').split(',')[0].trim(); }
function readBody(req) { return new Promise(resolve => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => resolve(d)); }); }
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

// ===== توليد الأسئلة (Claude API) =====
function genPrompt(text, n) {
  return `أنت معلّمة روضة خبيرة. من نص المنهج التالي أنشئي ${n} أسئلة اختيار من متعدّد مناسبة لأطفال الروضة، بالعربية الفصحى المبسّطة، وبمعلومات صحيحة فقط. لكل سؤال ٤ خيارات وإجابة واحدة صحيحة ومعلومة قصيرة.
النص:
"""${text}"""
أعيدي JSON فقط: مصفوفة من عناصر بالشكل {"q":"نص السؤال","options":["أ","ب","ج","د"],"answer":0,"fact":"معلومة قصيرة"} بلا أي شرح أو نص خارج الـJSON.`;
}
function parseLoose(t) {
  if (!t) return null;
  let s = String(t).replace(/```json/gi, '').replace(/```/g, '').trim();
  const i = s.indexOf('['), j = s.lastIndexOf(']');
  if (i >= 0 && j > i) s = s.slice(i, j + 1);
  try { return JSON.parse(s); } catch (_) { return null; }
}
// ===== تجربة مجانية: توليد واحد لكل IP كل 48 ساعة (للتسويق) =====
const TRIAL_MS = 48 * 3600 * 1000;
const memTrials = {};
async function canUseTrial(ip) {
  if (pool) { try { const r = await pool.query('SELECT last_used FROM trials WHERE ip=$1', [ip]); if (!r.rowCount) return true; return (Date.now() - new Date(r.rows[0].last_used).getTime()) > TRIAL_MS; } catch (e) {} }
  return (Date.now() - (memTrials[ip] || 0)) > TRIAL_MS;
}
async function markTrial(ip) {
  memTrials[ip] = Date.now();
  if (pool) { try { await pool.query('INSERT INTO trials(ip,last_used) VALUES($1,now()) ON CONFLICT(ip) DO UPDATE SET last_used=now()', [ip]); } catch (e) {} }
}
async function handleGenerate(req, res) {
  const raw = await readBody(req);
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const code = body.code, text = String(body.text || '').trim(), n = Math.max(2, Math.min(10, parseInt(body.n, 10) || 5));
  let isTrial = false, trialKey = '';
  if (!(await isActive(code))) {
    trialKey = String(code || '').trim().toUpperCase() || clientIp(req); // كل جهاز بكوده (device id) لا بالـIP
    if (!(await canUseTrial(trialKey))) return sendJSON(res, 402, { error: 'trial_used', retryHours: 48 });
    isTrial = true;
  }
  if (text.length < 10) return sendJSON(res, 400, { error: 'short_text' });
  if (!rateOk(code, 'gen', MAX_GEN)) return sendJSON(res, 429, { error: 'rate_limited' });
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return sendJSON(res, 501, { error: 'no_api_key' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: GEN_MODEL, max_tokens: 2000, messages: [{ role: 'user', content: genPrompt(text, n) }] })
    });
    if (!r.ok) { const e = await r.text(); return sendJSON(res, 502, { error: 'gen_failed', detail: e.slice(0, 300) }); }
    const j = await r.json();
    const txt = (j.content && j.content[0] && j.content[0].text) || '';
    const arr = parseLoose(txt) || [];
    if (isTrial) await markTrial(trialKey);
    return sendJSON(res, 200, { questions: Array.isArray(arr) ? arr : [], trial: isTrial });
  } catch (e) { return sendJSON(res, 502, { error: 'gen_failed', detail: String(e && e.message || e).slice(0, 300) }); }
}

// ===== admin: تفعيل كود دائم =====
async function handleAdminActivate(req, res) {
  if (!process.env.ADMIN_SECRET || req.headers['x-admin-secret'] !== process.env.ADMIN_SECRET) return sendJSON(res, 401, { error: 'unauthorized' });
  if (!pool) return sendJSON(res, 503, { error: 'no_db' });
  const raw = await readBody(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
  const code = String(b.code || '').trim().toUpperCase();
  if (!code) return sendJSON(res, 400, { error: 'no_code' });
  try {
    await pool.query('INSERT INTO activations(code,note) VALUES($1,$2) ON CONFLICT(code) DO UPDATE SET note=EXCLUDED.note', [code, String(b.note || '')]);
    return sendJSON(res, 200, { ok: true, code });
  } catch (e) { return sendJSON(res, 500, { error: 'db', detail: String(e.message).slice(0, 150) }); }
}

// ===== تحليلات =====
const EVENTS = {};
function bumpEvent(name) { const day = new Date().toISOString().slice(0, 10); EVENTS[day] = EVENTS[day] || {}; EVENTS[day][name] = (EVENTS[day][name] || 0) + 1; }
async function handleEvent(req, res) {
  const raw = await readBody(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
  const name = String(b.name || '').slice(0, 40);
  if (!name) return sendJSON(res, 400, { error: 'no_name' });
  const ip = clientIp(req);
  bumpEvent(name);
  if (pool) pool.query('INSERT INTO events(name,mode,extra,ip) VALUES($1,$2,$3,$4)', [name, String(b.mode || '').slice(0, 20), b.extra ? JSON.stringify(b.extra) : null, ip]).catch(() => {});
  console.log('[EVENT] ' + JSON.stringify({ name, mode: b.mode, extra: b.extra, ip, ts: new Date().toISOString() }));
  return sendJSON(res, 200, { ok: true });
}

// ===== لوحة الصدارة =====
async function handleScore(req, res) {
  const raw = await readBody(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
  const name = (String(b.name || '').trim().slice(0, 40)) || 'ضيف';
  const score = Math.max(0, Math.min(99999, parseInt(b.score, 10) || 0));
  const modev = String(b.mode || '').slice(0, 20);
  const streak = Math.max(0, Math.min(999, parseInt(b.streak, 10) || 0));
  if (!pool) return sendJSON(res, 200, { ok: false, stored: false });
  try { await pool.query('INSERT INTO scores(name,score,mode,streak,ip) VALUES($1,$2,$3,$4,$5)', [name, score, modev, streak, clientIp(req)]); return sendJSON(res, 200, { ok: true }); }
  catch (e) { return sendJSON(res, 500, { error: 'db' }); }
}
async function handleLeaderboard(req, res, u) {
  if (!pool) return sendJSON(res, 200, { top: [] });
  const limit = Math.max(1, Math.min(50, parseInt(u.searchParams.get('limit'), 10) || 10));
  try { const r = await pool.query('SELECT name,score,mode,streak,ts FROM scores ORDER BY score DESC, ts ASC LIMIT $1', [limit]); return sendJSON(res, 200, { top: r.rows }); }
  catch (e) { return sendJSON(res, 500, { error: 'db' }); }
}

// ===== تقارير الحضانة =====
async function handleAnswer(req, res) {
  const raw = await readBody(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
  const code = String(b.code || '').trim().toUpperCase();
  if (!(await isActive(code))) return sendJSON(res, 402, { error: 'not_active' });
  if (!pool) return sendJSON(res, 200, { ok: false, stored: false });
  if (!rateOk(clientIp(req), 'ans', 3000)) return sendJSON(res, 429, { error: 'rate_limited' });
  const child = (String(b.child || '').trim().slice(0, 60)) || null;
  const topic = (String(b.topic || '').trim().slice(0, 80)) || null;
  const question = (String(b.question || '').trim().slice(0, 300)) || null;
  const correct = !!b.correct;
  try { await pool.query('INSERT INTO nursery_answers(code,child,topic,question,correct) VALUES($1,$2,$3,$4,$5)', [code, child, topic, question, correct]); return sendJSON(res, 200, { ok: true }); }
  catch (e) { return sendJSON(res, 500, { error: 'db' }); }
}
async function handleReport(req, res, u) {
  const code = String(u.searchParams.get('code') || '').trim().toUpperCase();
  if (!(await isActive(code))) return sendJSON(res, 402, { error: 'not_active' });
  if (!pool) return sendJSON(res, 200, { total: 0, correct: 0, accuracy: 0, topics: [], children: [] });
  try {
    const tot = await pool.query('SELECT count(*)::int n, coalesce(sum(case when correct then 1 else 0 end),0)::int c FROM nursery_answers WHERE code=$1', [code]);
    const byTopic = await pool.query(`SELECT coalesce(topic,'عام') topic, count(*)::int n, coalesce(sum(case when correct then 1 else 0 end),0)::int c FROM nursery_answers WHERE code=$1 GROUP BY topic ORDER BY n DESC LIMIT 20`, [code]);
    const byChild = await pool.query(`SELECT coalesce(child,'—') child, count(*)::int n, coalesce(sum(case when correct then 1 else 0 end),0)::int c FROM nursery_answers WHERE code=$1 GROUP BY child ORDER BY n DESC LIMIT 20`, [code]);
    const total = tot.rows[0].n || 0, corr = tot.rows[0].c || 0;
    const pct = (c, n) => n ? Math.round(c * 100 / n) : 0;
    return sendJSON(res, 200, {
      total, correct: corr, accuracy: pct(corr, total),
      topics: byTopic.rows.map(r => ({ topic: r.topic, total: r.n, correct: r.c, accuracy: pct(r.c, r.n) })),
      children: byChild.rows.map(r => ({ child: r.child, total: r.n, correct: r.c, accuracy: pct(r.c, r.n) }))
    });
  } catch (e) { return sendJSON(res, 500, { error: 'db', detail: String(e.message).slice(0, 150) }); }
}

// ===== TTS =====
const TTSCACHE = new Map();
function ttsCacheGet(k) { return TTSCACHE.get(k); }
function ttsCacheSet(k, buf) { if (TTSCACHE.size > 300) TTSCACHE.delete(TTSCACHE.keys().next().value); TTSCACHE.set(k, buf); }
async function ttsGoogle(text) {
  const KEY = process.env.GOOGLE_TTS_KEY, voice = process.env.GOOGLE_TTS_VOICE || 'ar-XA-Wavenet-B';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { text }, voice: { languageCode: 'ar-XA', name: voice }, audioConfig: { audioEncoding: 'MP3' } })
  });
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json(); return Buffer.from(j.audioContent, 'base64');
}
async function ttsAzure(text) {
  const KEY = process.env.AZURE_TTS_KEY, REGION = process.env.AZURE_TTS_REGION, voice = process.env.AZURE_TTS_VOICE || 'ar-EG-SalmaNeural';
  const ssml = `<speak version='1.0' xml:lang='ar-EG'><voice name='${voice}'>${text.replace(/[<&>]/g, '')}</voice></speak>`;
  const r = await fetch('https://' + REGION + '.tts.speech.microsoft.com/cognitiveservices/v1', {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': KEY, 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3' },
    body: ssml
  });
  if (!r.ok) throw new Error('azure ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}
async function ttsEleven(text, opts) {
  opts = opts || {};
  const KEY = process.env.ELEVENLABS_KEY, voice = process.env.ELEVENLABS_VOICE || 'EXAVITQu4vr4xnSDxMaL', model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
  const stability = opts.stab != null && opts.stab !== '' ? Number(opts.stab) : 0.5;
  const style = opts.style != null && opts.style !== '' ? Number(opts.style) : 0;
  const r = await fetch('https://api.elevenlabs.io/v1/text-to-speech/' + voice, {
    method: 'POST',
    headers: { 'xi-api-key': KEY, 'content-type': 'application/json', 'accept': 'audio/mpeg' },
    body: JSON.stringify({ text, model_id: model, voice_settings: { stability, similarity_boost: 0.75, style, use_speaker_boost: true } })
  });
  if (!r.ok) throw new Error('eleven ' + r.status + ' ' + (await r.text()).slice(0, 120));
  return Buffer.from(await r.arrayBuffer());
}
function ttsProvider() { return process.env.AZURE_TTS_KEY ? 'azure' : (process.env.GOOGLE_TTS_KEY ? 'google' : (process.env.ELEVENLABS_KEY ? 'eleven' : null)); }
async function handleTTS(req, res, u) {
  const text = String(u.searchParams.get('text') || '').slice(0, 600);
  if (!text) return sendJSON(res, 400, { error: 'no_text' });
  const ip = clientIp(req);
  const provider = ttsProvider();
  if (!provider) return sendJSON(res, 501, { error: 'no_tts' });
  const stab = u.searchParams.get('stab'), style = u.searchParams.get('style');
  const key = provider + '::' + (stab || '') + '::' + (style || '') + '::' + text;
  let buf = ttsCacheGet(key);
  if (!buf) {
    if (!rateOk(ip, 'tts', MAX_TTS)) return sendJSON(res, 429, { error: 'rate_limited' });
    try { buf = provider === 'azure' ? await ttsAzure(text) : provider === 'google' ? await ttsGoogle(text) : await ttsEleven(text, { stab, style }); ttsCacheSet(key, buf); }
    catch (e) { return sendJSON(res, 502, { error: 'tts_failed', detail: String(e && e.message || e).slice(0, 200) }); }
  }
  res.writeHead(200, { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'public, max-age=86400' });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  let u; try { u = new URL(req.url, 'http://localhost'); } catch (e) { u = { pathname: '/', searchParams: new Map() }; }
  try {
    if (u.pathname === '/api/health') {
      const today = new Date().toISOString().slice(0, 10);
      return sendJSON(res, 200, { ok: true, db: !!pool, activeCount: activeSet().size, gen: !!process.env.ANTHROPIC_API_KEY, tts: ttsProvider() || false, events: EVENTS[today] || {} });
    }
    if (u.pathname === '/api/verify') {
      const code = String((u.searchParams.get && u.searchParams.get('code')) || '').trim().toUpperCase();
      return sendJSON(res, 200, { active: await isActive(code) });
    }
    if (u.pathname === '/api/admin/activate' && req.method === 'POST') return await handleAdminActivate(req, res);
    if (u.pathname === '/api/event' && req.method === 'POST') return await handleEvent(req, res);
    if (u.pathname === '/api/score' && req.method === 'POST') return await handleScore(req, res);
    if (u.pathname === '/api/leaderboard') return await handleLeaderboard(req, res, u);
    if (u.pathname === '/api/answer' && req.method === 'POST') return await handleAnswer(req, res);
    if (u.pathname === '/api/report') return await handleReport(req, res, u);
    if (u.pathname === '/api/generate' && req.method === 'POST') return await handleGenerate(req, res);
    if (u.pathname === '/api/tts') return await handleTTS(req, res, u);
  } catch (e) { return sendJSON(res, 500, { error: 'server', detail: String(e && e.message || e).slice(0, 200) }); }

  if (u.pathname === '/mascot.png') {
    return fs.readFile(path.join(__dirname, 'mascot.png'), (err, data) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
      res.end(data);
    });
  }

  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  });
});

initDb().finally(() => server.listen(PORT, () => console.log('أجيال is running on port ' + PORT)));
