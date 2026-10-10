// POST /api/admin/password — 관리자 비밀번호 변경 (로그인 필수)
//  { current, next }  현재 비밀번호 확인 → 새 비밀번호 저장(bcrypt)
//  · token_version 을 올려 다른 기기·브라우저의 로그인은 모두 끊고, 지금 창에는 새 쿠키를 발급
//  · 현재 비밀번호를 틀리면 로그인 실패와 같이 기록 → 15분 5회 초과 시 잠금
const bcrypt = require('bcryptjs');
const { query } = require('../../lib/db');
const { requireAdmin, signToken, setAuthCookie, clientIp } = require('../../lib/auth');
const { checkStrength } = require('../../lib/password-rules');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const current = String(req.body?.current ?? '');
    const next = String(req.body?.next ?? '');
    if (!current || !next) return res.status(400).json({ ok: false, message: '현재 비밀번호와 새 비밀번호를 입력하세요.' });
    if (current.length > 200) return res.status(400).json({ ok: false, message: '입력값을 확인하세요.' });

    const fails = await query(
      `SELECT count(*)::int AS n FROM public.admin_login_attempts
        WHERE username = $1 AND success = FALSE AND created_at > now() - make_interval(mins => $2)`,
      [admin.username, LOCK_MINUTES]);
    if (fails.rows[0].n >= MAX_FAILS) {
      return res.status(429).json({ ok: false, message: `비밀번호 확인 실패가 많아 ${LOCK_MINUTES}분간 잠겼습니다. 잠시 후 다시 시도하세요.` });
    }

    const { rows } = await query('SELECT password_hash FROM public.admin_users WHERE id = $1', [admin.id]);
    if (!rows[0] || !(await bcrypt.compare(current, rows[0].password_hash))) {
      await query('INSERT INTO public.admin_login_attempts (username, ip, success) VALUES ($1, $2, FALSE)', [admin.username, clientIp(req)]);
      return res.status(400).json({ ok: false, message: '현재 비밀번호가 올바르지 않습니다.' });
    }
    if (current === next) return res.status(400).json({ ok: false, message: '지금과 다른 비밀번호를 입력하세요.' });
    const weak = checkStrength(next, admin.username);
    if (weak) return res.status(400).json({ ok: false, message: weak });

    const hash = await bcrypt.hash(next, 12);
    const upd = await query(
      `UPDATE public.admin_users SET password_hash = $1, token_version = token_version + 1
        WHERE id = $2 RETURNING id, username, name, token_version`,
      [hash, admin.id]);
    // 다른 곳의 로그인은 끊기고(token_version 증가), 지금 창은 새 토큰으로 계속 사용
    setAuthCookie(req, res, signToken(upd.rows[0]));
    return res.status(200).json({ ok: true, message: '비밀번호를 변경했습니다. 다른 기기·브라우저의 로그인은 모두 해제됐습니다.' });
  } catch (e) {
    console.error('[admin/password]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
