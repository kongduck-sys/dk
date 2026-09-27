// ============================================================
// 관리자 인증 — JWT(HS256)를 HttpOnly 쿠키에 담는다
//  · 스크립트에서 읽을 수 없는 쿠키라 XSS로 토큰이 유출되지 않음
//  · SameSite=Strict + Origin 검사로 CSRF 차단
//  · token_version 비교로 로그아웃/비번 변경 시 즉시 무효화
// 환경변수: JWT_SECRET (32자 이상 무작위 문자열)
// ============================================================
const jwt = require('jsonwebtoken');
const { query } = require('./db');

const COOKIE_NAME = 'lineco_admin';
const TOKEN_TTL_SEC = 60 * 60 * 8; // 8시간
const ISSUER = 'lineco-admin';

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) throw new Error('JWT_SECRET must be set (32+ chars)');
  return s;
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user.id), username: user.username, tv: user.token_version },
    getSecret(),
    { algorithm: 'HS256', expiresIn: TOKEN_TTL_SEC, issuer: ISSUER }
  );
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach(part => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

// 로컬(http://localhost) 테스트에서는 Secure를 빼야 쿠키가 저장된다
function isSecureRequest(req) {
  const proto = req.headers['x-forwarded-proto'];
  const host = String(req.headers.host || '');
  return proto === 'https' || !/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
}

function cookieString(req, value, maxAge) {
  return [
    `${COOKIE_NAME}=${value}`,
    'Path=/api/admin',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
    isSecureRequest(req) ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

const setAuthCookie = (req, res, token) => res.setHeader('Set-Cookie', cookieString(req, token, TOKEN_TTL_SEC));
const clearAuthCookie = (req, res) => res.setHeader('Set-Cookie', cookieString(req, '', 0));

// 상태 변경 요청(POST/PATCH/DELETE)은 같은 출처에서 온 것만 허용
function isSameOrigin(req) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  const origin = req.headers.origin;
  if (!origin) return true; // 서버 간 호출·구형 브라우저 (SameSite=Strict가 1차 방어)
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

// 인증 확인. 성공 시 관리자 정보 반환, 실패 시 응답을 보내고 null 반환
async function requireAdmin(req, res) {
  if (!isSameOrigin(req)) {
    res.status(403).json({ ok: false, message: '허용되지 않은 요청입니다.' });
    return null;
  }
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) {
    res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    return null;
  }
  let payload;
  try {
    payload = jwt.verify(token, getSecret(), { algorithms: ['HS256'], issuer: ISSUER });
  } catch {
    clearAuthCookie(req, res);
    res.status(401).json({ ok: false, message: '로그인이 만료되었습니다.' });
    return null;
  }
  const { rows } = await query(
    'SELECT id, username, name, token_version, is_active FROM public.admin_users WHERE id = $1',
    [payload.sub]
  );
  const user = rows[0];
  if (!user || !user.is_active || user.token_version !== payload.tv) {
    clearAuthCookie(req, res);
    res.status(401).json({ ok: false, message: '다시 로그인해주세요.' });
    return null;
  }
  return { id: user.id, username: user.username, name: user.name };
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 64);
}

module.exports = {
  signToken, setAuthCookie, clearAuthCookie, requireAdmin, isSameOrigin, clientIp, parseCookies, COOKIE_NAME,
};
