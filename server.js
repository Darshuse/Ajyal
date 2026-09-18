// أجيال — خادم Node بلا اعتماديات: يقدّم التطبيق + واجهات ذكاء سحابية للنسخة المنشورة
//  GET  /api/verify?code=      → تحقّق من تفعيل الاشتراك (ACTIVE_CODES)
//  POST /api/generate          → توليد أسئلة من المنهج عبر Claude API (Haiku)
//  GET  /api/tts?code=&text=   → نطق عربي (Google أو Azure) يرجّع MP3 (بكاش)
// كل واجهات الذكاء محميّة بالاشتراك (كود الجهاز في ACTIVE_CODES) + حدّ استخدام يومي.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');
const GEN_MODEL = process.env.GEN_MODEL || 'claude-haiku-4-5';
const MAX_GEN = Number(process.env.MAX_GEN_PER_DAY || 40);
const MAX_TTS = Number(process.env.MAX_TTS_PER_DAY || 600);

function activeSet() {
  return new Set(String(process.env.ACTIVE_CODES || '').split(/[\s,;]+/).map(s => s.trim().toUpperCase()).filter(Boolean));
}
function isActive(code) { return !!code && activeSet().has(String(code).trim().toUpperCase()); }

// حدّ استخدام يومي في الذاكرة (تقريبي — يُعاد ضبطه عند إعادة النشر)
const RL = {};
function rateOk(code, kind, max) {
  const day = new Date().toISOString().slice(0, 10);
  const k = String(code).toUpperCase() + '|' + day;
  RL[k] = RL[k] || { gen: 0, tts: 0 };
  if (RL[k][kind] >= max) return false;
  RL[k][kind]++; return true;
}

function readBody(req) {
  return new Promise(resolve => { let d = ''; req.on('data', c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on('end', () => resolve(d)); });
}
function sendJSON(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }

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

async function handleGenerate(req, res) {
  const raw = await readBody(req);
  let body = {}; try { body = JSON.parse(raw || '{}'); } catch (_) {}
  const code = body.code, text = String(body.text || '').trim(), n = Math.max(2, Math.min(10, parseInt(body.n, 10) || 5));
  if (!isActive(code)) return sendJSON(res, 402, { error: 'not_active' });
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
    return sendJSON(res, 200, { questions: Array.isArray(arr) ? arr : [] });
  } catch (e) { return sendJSON(res, 502, { error: 'gen_failed', detail: String(e && e.message || e).slice(0, 300) }); }
}

// تحليلات خفيفة: عدّادات يومية في الذاكرة + سطر لوج لكل حدث (يظهر في Railway logs)
const EVENTS = {};
function bumpEvent(name) { const day = new Date().toISOString().slice(0, 10); EVENTS[day] = EVENTS[day] || {}; EVENTS[day][name] = (EVENTS[day][name] || 0) + 1; }
async function handleEvent(req, res) {
  const raw = await readBody(req); let b = {}; try { b = JSON.parse(raw || '{}'); } catch (_) {}
  const name = String(b.name || '').slice(0, 40);
  if (!name) return sendJSON(res, 400, { error: 'no_name' });
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || '').split(',')[0].trim();
  bumpEvent(name);
  console.log('[EVENT] ' + JSON.stringify({ name, mode: b.mode, extra: b.extra, ip, ts: new Date().toISOString() }));
  return sendJSON(res, 200, { ok: true });
}

// كاش TTS في الذاكرة
const TTSCACHE = new Map();
function ttsCacheGet(k) { return TTSCACHE.get(k); }
function ttsCacheSet(k, buf) { if (TTSCACHE.size > 300) TTSCACHE.delete(TTSCACHE.keys().next().value); TTSCACHE.set(k, buf); }

async function ttsGoogle(text) {
  const KEY = process.env.GOOGLE_TTS_KEY;
  const voice = process.env.GOOGLE_TTS_VOICE || 'ar-XA-Wavenet-B';
  const r = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + KEY, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: { text }, voice: { languageCode: 'ar-XA', name: voice }, audioConfig: { audioEncoding: 'MP3' } })
  });
  if (!r.ok) throw new Error('google ' + r.status);
  const j = await r.json();
  return Buffer.from(j.audioContent, 'base64');
}
async function ttsAzure(text) {
  const KEY = process.env.AZURE_TTS_KEY, REGION = process.env.AZURE_TTS_REGION;
  const voice = process.env.AZURE_TTS_VOICE || 'ar-EG-SalmaNeural';
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
  const KEY = process.env.ELEVENLABS_KEY;
  const voice = process.env.ELEVENLABS_VOICE || 'EXAVITQu4vr4xnSDxMaL';
  const model = process.env.ELEVENLABS_MODEL || 'eleven_multilingual_v2';
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
function ttsProvider() {
  return process.env.AZURE_TTS_KEY ? 'azure' : (process.env.GOOGLE_TTS_KEY ? 'google' : (process.env.ELEVENLABS_KEY ? 'eleven' : null));
}
async function handleTTS(req, res, u) {
  // الصوت غير محمي بالاشتراك (يعمل في وضع الأطفال المجاني)؛ الحماية بحدّ استخدام حسب IP + كاش.
  const text = String(u.searchParams.get('text') || '').slice(0, 600);
  if (!text) return sendJSON(res, 400, { error: 'no_text' });
  const ip = String(req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'ip').split(',')[0].trim();
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
    if (u.pathname === '/api/verify') {
      const code = String((u.searchParams.get && u.searchParams.get('code')) || '').trim().toUpperCase();
      return sendJSON(res, 200, { active: isActive(code) });
    }
    if (u.pathname === '/api/health') {
      return sendJSON(res, 200, { ok: true, activeCount: activeSet().size, gen: !!process.env.ANTHROPIC_API_KEY, tts: ttsProvider() || false, events: EVENTS[new Date().toISOString().slice(0, 10)] || {} });
    }
    if (u.pathname === '/api/event' && req.method === 'POST') return await handleEvent(req, res);
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

  // SPA: أي مسار آخر يقدّم index.html
  fs.readFile(INDEX, (err, data) => {
    if (err) { res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Server error'); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('أجيال is running on port ' + PORT));
