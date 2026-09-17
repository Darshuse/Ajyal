// أجيال — zero-dependency server: يقدّم التطبيق + واجهة تحقّق تفعيل «وضع الروضة»
// مصدر الحقيقة للتفعيل: متغيّر البيئة ACTIVE_CODES (قائمة أكواد مفصولة بفواصل/مسافات).
// التفعيل يدوي: العميل يدفع عبر InstaPay ويرسل كود جهازه، فيضيفه المالك إلى ACTIVE_CODES.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const INDEX = path.join(__dirname, 'index.html');

function activeSet() {
  return new Set(
    String(process.env.ACTIVE_CODES || '')
      .split(/[\s,;]+/)
      .map(s => s.trim().toUpperCase())
      .filter(Boolean)
  );
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, 'http://localhost'); } catch (e) { u = { pathname: '/' , searchParams: new Map() }; }

  if (u.pathname === '/api/verify') {
    const code = String((u.searchParams.get && u.searchParams.get('code')) || '').trim().toUpperCase();
    const active = !!code && activeSet().has(code);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ active }));
    return;
  }
  if (u.pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, activeCount: activeSet().size }));
    return;
  }

  // SPA: أي مسار آخر يقدّم index.html
  fs.readFile(INDEX, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Server error');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log('أجيال is running on port ' + PORT));
