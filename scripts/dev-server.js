// ============================================================
// 로컬 개발 서버 (vercel dev 대용) — npm run dev
//  · 정적 파일(index.html, admin.html) + /api/*.js 서버리스 함수 실행
//  · 환경변수: 프로젝트 루트의 .env 파일이 있으면 읽음 (DATABASE_URL, JWT_SECRET)
//    .env 는 .gitignore 에 포함되어 있으며 절대 커밋하지 마세요.
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3000);
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
};

// .env 로드 (이미 설정된 환경변수가 우선)
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
// 로컬 전용: JWT_SECRET 이 없으면 실행할 때마다 임시 키 생성 (재시작하면 다시 로그인)
if (!process.env.JWT_SECRET) {
  process.env.JWT_SECRET = crypto.randomBytes(48).toString('base64url');
  console.log('ℹ JWT_SECRET 미설정 → 임시 키 사용 (서버 재시작 시 관리자 재로그인 필요)');
}
if (!process.env.DATABASE_URL) {
  console.warn('⚠ DATABASE_URL 미설정 → 상담 저장·관리자 로그인이 동작하지 않습니다. .env 를 만들어주세요 (.env.example 참고)');
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (o) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(o)); };

  // API: /api/admin/login → api/admin/login.js
  if (url.pathname.startsWith('/api/')) {
    const file = path.join(ROOT, url.pathname + '.js');
    if (!file.startsWith(path.join(ROOT, 'api') + path.sep) || !fs.existsSync(file)) {
      return res.status(404).json({ ok: false, message: 'Not Found' });
    }
    // 조각(chunk)을 바이트로 모은 뒤 한 번에 UTF-8 변환 — 문자열로 이어 붙이면 경계에 걸린 한글이 깨진다
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    req.query = Object.fromEntries(url.searchParams);
    try {
      await require(file)(req, res);
    } catch (e) {
      console.error(`[${url.pathname}]`, e);
      if (!res.headersSent) res.status(500).json({ ok: false, message: 'dev server error' });
    }
    console.log(`${req.method} ${url.pathname} → ${res.statusCode}`);
    return;
  }

  // 정적 파일
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, rel);
  // 서버 코드·설정·숨김 파일은 브라우저로 내려주지 않음
  const blocked = /(^|[\\/])\./.test(rel) || /^(node_modules|lib|api|scripts|db)([\\/]|$)/.test(rel) || /^package(-lock)?\.json$/.test(rel);
  if (blocked || !file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.statusCode = 404;
    return res.end('Not Found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => {
  console.log(`\n  홈페이지   http://localhost:${PORT}/`);
  console.log(`  관리자     http://localhost:${PORT}/admin.html\n`);
});
