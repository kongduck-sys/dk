// GET /api/admin/me — 현재 로그인한 관리자 확인 (관리자 화면 첫 진입 시 호출)
const { requireAdmin } = require('../../lib/auth');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    return res.status(200).json({ ok: true, user: admin });
  } catch (e) {
    console.error('[admin/me]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
