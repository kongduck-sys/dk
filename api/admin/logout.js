// POST /api/admin/logout — 쿠키 삭제 + token_version 증가로 발급된 토큰 즉시 무효화
const { query } = require('../../lib/db');
const { requireAdmin, clearAuthCookie } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return; // 이미 만료된 세션이면 쿠키만 지워진 상태로 응답 완료
    await query('UPDATE public.admin_users SET token_version = token_version + 1 WHERE id = $1', [admin.id]);
    clearAuthCookie(req, res);
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[admin/logout]', e.message);
    clearAuthCookie(req, res);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
