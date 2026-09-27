// ============================================================
// /api/admin/consults — 상담 신청 관리 (관리자 인증 필수)
//  GET    ?status=new&q=검색어&page=1&size=20   목록 + 상태별 건수
//  GET    ?all=1                                 CSV 내보내기용 전체 목록 (최대 5000건)
//  PATCH  ?id=123   { status, memo }             처리 상태·메모 수정
//  DELETE ?id=123                                삭제
// ============================================================
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');

const STATUSES = ['new', 'contacted', 'done', 'cancel'];
const COLUMNS = 'id, name, phone, content, status, memo, source, created_at, updated_at';

function parseId(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

async function list(req, res) {
  const status = STATUSES.includes(req.query.status) ? req.query.status : null;
  const q = String(req.query.q || '').trim().slice(0, 50);
  const all = req.query.all === '1';
  const size = all ? 5000 : Math.min(Math.max(parseInt(req.query.size, 10) || 20, 1), 100);
  const page = all ? 1 : Math.max(parseInt(req.query.page, 10) || 1, 1);

  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`status = $${params.length}`); }
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    where.push(`(name ILIKE $${params.length} OR phone ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [rows, total, counts] = await Promise.all([
    query(`SELECT ${COLUMNS} FROM public.consult_requests ${whereSql}
           ORDER BY created_at DESC LIMIT ${size} OFFSET ${(page - 1) * size}`, params),
    query(`SELECT count(*)::int AS n FROM public.consult_requests ${whereSql}`, params),
    query(`SELECT status, count(*)::int AS n,
                  count(*) FILTER (WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'Asia/Seoul')::int AS today
             FROM public.consult_requests GROUP BY status`),
  ]);

  const byStatus = Object.fromEntries(STATUSES.map(s => [s, 0]));
  let today = 0;
  counts.rows.forEach(r => { byStatus[r.status] = r.n; today += r.today; });

  return res.status(200).json({
    ok: true, items: rows.rows, total: total.rows[0].n, page, size,
    summary: { ...byStatus, all: Object.values(byStatus).reduce((a, b) => a + b, 0), today },
  });
}

async function update(req, res, id) {
  const sets = [];
  const params = [];
  if (req.body?.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ ok: false, message: '잘못된 상태값입니다.' });
    params.push(req.body.status); sets.push(`status = $${params.length}`);
  }
  if (req.body?.memo !== undefined) {
    const memo = String(req.body.memo ?? '').slice(0, 2000);
    params.push(memo || null); sets.push(`memo = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ ok: false, message: '변경할 내용이 없습니다.' });
  params.push(id);
  const { rows } = await query(
    `UPDATE public.consult_requests SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`, params);
  if (!rows[0]) return res.status(404).json({ ok: false, message: '해당 상담 신청이 없습니다.' });
  return res.status(200).json({ ok: true, item: rows[0] });
}

async function remove(req, res, id) {
  const { rowCount } = await query('DELETE FROM public.consult_requests WHERE id = $1', [id]);
  if (!rowCount) return res.status(404).json({ ok: false, message: '해당 상담 신청이 없습니다.' });
  return res.status(200).json({ ok: true });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (req.method === 'GET') return await list(req, res);

    const id = parseId(req.query.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id가 필요합니다.' });
    if (req.method === 'PATCH') return await update(req, res, id);
    if (req.method === 'DELETE') return await remove(req, res, id);

    res.setHeader('Allow', 'GET, PATCH, DELETE');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin/consults]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
