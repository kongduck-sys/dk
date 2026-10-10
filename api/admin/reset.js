// ============================================================
// POST /api/admin/reset — 관리자 비밀번호를 잊었을 때 쓰는 일회용 재설정
//  · 서버 환경변수 ADMIN_RESET_TOKEN 이 있을 때만 동작 (없으면 404 — 평소에는 꺼져 있음)
//  · { token }                         → 관리자 아이디 목록 확인
//  · { token, username, password }     → 해당 계정 비밀번호 재설정 + 기존 로그인 모두 해제 + 로그인 잠금 해제
//  · 코드가 틀리면 기록 → 15분 5회 초과 시 잠금
//  · 재설정이 끝나면 ADMIN_RESET_TOKEN 을 지워서 다시 꺼 둔다
// ============================================================
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { query } = require('../../lib/db');
const { isSameOrigin, clientIp } = require('../../lib/auth');
const { checkStrength } = require('../../lib/password-rules');

const LOCK_KEY = '__reset__';
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

const sameToken = (a, b) => {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
};

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.ADMIN_RESET_TOKEN;
  if (!secret || secret.length < 32) return res.status(404).json({ ok: false, message: 'Not Found' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }
  if (!isSameOrigin(req)) return res.status(403).json({ ok: false, message: '허용되지 않은 요청입니다.' });

  const ip = clientIp(req);
  try {
    const fails = await query(
      `SELECT count(*)::int AS n FROM public.admin_login_attempts
        WHERE username = $1 AND success = FALSE AND created_at > now() - make_interval(mins => $2)`, [LOCK_KEY, LOCK_MINUTES]);
    if (fails.rows[0].n >= MAX_FAILS) return res.status(429).json({ ok: false, message: `실패가 많아 ${LOCK_MINUTES}분간 잠겼습니다.` });

    const token = String(req.body?.token ?? '').trim();
    if (!token || !sameToken(token, secret)) {
      await query('INSERT INTO public.admin_login_attempts (username, ip, success) VALUES ($1, $2, FALSE)', [LOCK_KEY, ip]);
      return res.status(401).json({ ok: false, message: '재설정 코드가 올바르지 않습니다.' });
    }

    const { rows: users } = await query('SELECT id, username, name, is_active FROM public.admin_users ORDER BY id');
    const username = String(req.body?.username ?? '').trim().toLowerCase();
    const password = String(req.body?.password ?? '');
    if (!username && !password) {
      return res.status(200).json({ ok: true, users: users.map(u => ({ username: u.username, name: u.name, active: u.is_active })) });
    }

    const user = users.find(u => u.username === username);
    if (!user) return res.status(400).json({ ok: false, message: '해당 아이디의 관리자가 없습니다.' });
    const weak = checkStrength(password, username);
    if (weak) return res.status(400).json({ ok: false, message: weak });

    const hash = await bcrypt.hash(password, 12);
    await query('UPDATE public.admin_users SET password_hash = $1, token_version = token_version + 1, is_active = TRUE WHERE id = $2', [hash, user.id]);
    // 잠금 해제 (이 계정의 최근 실패 기록 · 재설정 코드 실패 기록 삭제)
    await query(`DELETE FROM public.admin_login_attempts WHERE username = ANY($1) AND success = FALSE`, [[username, LOCK_KEY]]);
    await query('INSERT INTO public.admin_login_attempts (username, ip, success) VALUES ($1, $2, TRUE)', [LOCK_KEY, ip]);
    return res.status(200).json({ ok: true, message: '비밀번호를 재설정했습니다. 새 비밀번호로 로그인하세요.' });
  } catch (e) {
    console.error('[admin/reset]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
