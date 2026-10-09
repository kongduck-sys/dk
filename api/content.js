// ============================================================
// GET /api/content — 홈페이지용 팝업 · 이벤트 (공개, 인증 없음)
//  GET                 노출 중인 팝업·이벤트 목록 (기간·노출 여부 반영)
//  GET ?event=12       이벤트 1건 (상세 페이지)
//  GET ?img=34         관리자가 업로드한 이미지 파일
//  GET ?legacy_event=23  기존 사이트 이벤트 번호 → 새 이벤트 상세로 302 이동
// ============================================================
const { query } = require('../lib/db');
const { ensureContentTables, ACTIVE_SQL, EVENT_COLS, POPUP_COLS } = require('../lib/content');

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

async function sendImage(res, id) {
  const { rows } = await query('SELECT mime, data FROM public.site_images WHERE id = $1', [id]);
  if (!rows[0]) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(404).json({ ok: false, message: 'Not Found' });
  }
  // 이미지는 새로 올리면 번호가 바뀌므로 같은 번호는 영구 캐시해도 안전
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Content-Type', rows[0].mime);
  res.statusCode = 200;
  return res.end(rows[0].data);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  }
  try {
    await ensureContentTables();

    // 기존 사이트 이벤트 주소(event_detail.php?CODE=23)로 들어온 경우 → 이관된 같은 이벤트 상세로 이동
    if (req.query.legacy_event !== undefined) {
      const code = parseId(req.query.legacy_event);
      let to = '/#/event';
      if (code) {
        const { rows } = await query(`SELECT id FROM public.site_events WHERE legacy_key = $1 AND ${ACTIVE_SQL}`, [`e:${code}`])
          .catch(() => ({ rows: [] })); // legacy_key 컬럼이 아직 없는 DB여도 목록으로
        if (rows[0]) to = `/#/event/${rows[0].id}`;
      }
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=300');
      res.statusCode = 302;
      res.setHeader('Location', to);
      return res.end();
    }

    if (req.query.img !== undefined) {
      const id = parseId(req.query.img);
      if (!id) return res.status(400).json({ ok: false, message: '잘못된 이미지 번호입니다.' });
      return await sendImage(res, id);
    }

    // 관리자에서 고친 내용은 1분 안에 반영
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');

    if (req.query.event !== undefined) {
      const id = parseId(req.query.event);
      if (!id) return res.status(400).json({ ok: false, message: '잘못된 이벤트 번호입니다.' });
      const { rows } = await query(
        `SELECT ${EVENT_COLS} FROM public.site_events WHERE id = $1 AND ${ACTIVE_SQL}`, [id]);
      if (!rows[0]) return res.status(404).json({ ok: false, message: '진행 중인 이벤트가 아닙니다.' });
      return res.status(200).json({ ok: true, event: rows[0] });
    }

    const [popups, events] = await Promise.all([
      query(`SELECT ${POPUP_COLS} FROM public.site_popups
              WHERE ${ACTIVE_SQL} AND image IS NOT NULL AND image <> '' ORDER BY sort, id`),
      query(`SELECT ${EVENT_COLS} FROM public.site_events WHERE ${ACTIVE_SQL} ORDER BY sort, id`),
    ]);
    return res.status(200).json({ ok: true, popups: popups.rows, events: events.rows });
  } catch (e) {
    console.error('[content]', e.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
