// POST /api/admin/login — 관리자 로그인 → JWT를 HttpOnly 쿠키로 발급
const bcrypt = require('bcryptjs');
const { query } = require('../../lib/db');
const { signToken, setAuthCookie, isSameOrigin, clientIp } = require('../../lib/auth');

const MAX_FAILS = 5;         // 15분 안에 5회 실패하면
const LOCK_MINUTES = 15;     // 15분 잠금
// 계정이 없을 때도 같은 시간이 걸리도록 비교할 더미 해시 (아이디 존재 여부 노출 방지)
let dummyHash;
const getDummyHash = async () => (dummyHash ||= await bcrypt.hash('never-matches-' + Math.random(), 12));

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }
  if (!isSameOrigin(req)) return res.status(403).json({ ok: false, message: '허용되지 않은 요청입니다.' });

  const username = String(req.body?.username ?? '').trim().toLowerCase();
  const password = String(req.body?.password ?? '');
  if (!username || !password) return res.status(400).json({ ok: false, message: '아이디와 비밀번호를 입력하세요.' });
  if (username.length > 40 || password.length > 200) return res.status(400).json({ ok: false, message: '입력값을 확인하세요.' });

  const ip = clientIp(req);
  try {
    const fails = await query(
      `SELECT count(*)::int AS n FROM public.admin_login_attempts
        WHERE username = $1 AND success = FALSE AND created_at > now() - make_interval(mins => $2)`,
      [username, LOCK_MINUTES]
    );
    if (fails.rows[0].n >= MAX_FAILS) {
      return res.status(429).json({ ok: false, message: `로그인 실패가 많아 ${LOCK_MINUTES}분간 잠겼습니다. 잠시 후 다시 시도하세요.` });
    }

    const { rows } = await query(
      'SELECT id, username, name, password_hash, token_version, is_active FROM public.admin_users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    const valid = await bcrypt.compare(password, user ? user.password_hash : await getDummyHash());

    if (!user || !user.is_active || !valid) {
      await query('INSERT INTO public.admin_login_attempts (username, ip, success) VALUES ($1, $2, FALSE)', [username, ip]);
      return res.status(401).json({ ok: false, message: '아이디 또는 비밀번호가 올바르지 않습니다.' });
    }

    await query('INSERT INTO public.admin_login_attempts (username, ip, success) VALUES ($1, $2, TRUE)', [username, ip]);
    await query('UPDATE public.admin_users SET last_login_at = now() WHERE id = $1', [user.id]);

    setAuthCookie(req, res, signToken(user));
    return res.status(200).json({ ok: true, user: { id: user.id, username: user.username, name: user.name } });
  } catch (e) {
    console.error('[admin/login]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류로 로그인하지 못했습니다.' });
  }
};
