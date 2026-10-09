// POST /api/admin/password — 관리자 비밀번호 변경 (로그인 필수)
//  { current, next }  현재 비밀번호 확인 → 새 비밀번호 저장(bcrypt)
//  · token_version 을 올려 다른 기기·브라우저의 로그인은 모두 끊고, 지금 창에는 새 쿠키를 발급
//  · 현재 비밀번호를 틀리면 로그인 실패와 같이 기록 → 15분 5회 초과 시 잠금
const bcrypt = require('bcryptjs');
const { query } = require('../../lib/db');
const { requireAdmin, signToken, setAuthCookie, clientIp } = require('../../lib/auth');

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;
// 너무 흔하거나 추측하기 쉬운 비밀번호
const WEAK = ['1234', '12345', '123456', '1234567', '12345678', '123456789', '1234567890', 'password', 'qwerty', 'admin', 'lineco', 'makeline', '00000000', '11111111'];

function checkStrength(pw, username) {
  if (pw.length < 10) return '새 비밀번호는 10자 이상이어야 합니다.';
  if (pw.length > 72) return '새 비밀번호는 72자 이하로 입력하세요.';
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(r => r.test(pw)).length;
  if (kinds < 3) return '영문 대문자·소문자·숫자·특수문자 중 3가지 이상을 섞어 주세요.';
  const low = pw.toLowerCase();
  if (WEAK.some(w => low.includes(w))) return '흔하거나 추측하기 쉬운 단어(1234, admin, makeline 등)는 넣을 수 없습니다.';
  if (username && low.includes(String(username).toLowerCase())) return '아이디가 들어간 비밀번호는 쓸 수 없습니다.';
  if (/(.)\1\1\1/.test(pw)) return '같은 문자를 4번 이상 연달아 쓸 수 없습니다.';
  return null;
}

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
