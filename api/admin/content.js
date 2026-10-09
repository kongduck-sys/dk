// ============================================================
// /api/admin/content — 팝업 · 이벤트 관리 (관리자 인증 필수)
//  GET    ?type=popups|events            전체 목록 (숨김 포함)
//  POST   ?type=popups|events  {...}     등록
//  PATCH  ?type=popups|events&id=1 {...} 수정 (보낸 항목만)
//  DELETE ?type=popups|events&id=1       삭제
//  POST   ?type=image  { mime, data }    이미지 업로드 (data: base64) → { url }
// ============================================================
const { query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');
const {
  ensureContentTables, cleanupImages, LINK_TYPES, IMAGE_URL_PREFIX, EVENT_COLS, POPUP_COLS, ADMIN_COLS,
} = require('../../lib/content');

const TABLES = {
  popups: { table: 'public.site_popups', cols: `${POPUP_COLS}, ${ADMIN_COLS}`, label: '팝업' },
  events: { table: 'public.site_events', cols: `${EVENT_COLS}, ${ADMIN_COLS}`, label: '이벤트' },
};
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
// 외부 https 이미지, 원본 사이트 경로(/UPLOAD/...), 직접 올린 이미지만 허용
const isImageUrl = (v) => /^https:\/\/[^\s"'<>]+$/.test(v) || /^\/(UPLOAD|images)\/[^\s"'<>]+$/.test(v) || new RegExp(`^${IMAGE_URL_PREFIX.replace(/[?]/g, '\\?')}\\d+$`).test(v);

// 보낸 항목만 검사해 { 컬럼: 값 } 으로 돌려준다. 문제가 있으면 { error }
function pickFields(type, body, isCreate) {
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (isCreate || has('title')) {
    const title = String(body.title ?? '').trim();
    if (!title || title.length > 100) return { error: '제목을 1~100자로 입력하세요.' };
    out.title = title;
  }
  if (has('image')) {
    const image = String(body.image ?? '').trim();
    if (image && (image.length > 1000 || !isImageUrl(image))) return { error: '이미지 주소가 올바르지 않습니다. (https:// 주소 또는 업로드한 이미지)' };
    out.image = image || null;
  }
  for (const k of ['start_date', 'end_date']) {
    if (has(k)) {
      const v = String(body[k] ?? '').trim();
      if (v && !isDate(v)) return { error: '날짜 형식이 올바르지 않습니다.' };
      out[k] = v || null;
    }
  }
  if (out.start_date && out.end_date && out.start_date > out.end_date) return { error: '종료일이 시작일보다 빠릅니다.' };
  if (has('visible')) out.visible = body.visible === true;
  if (has('sort')) {
    const n = Number(body.sort);
    if (!Number.isInteger(n) || Math.abs(n) > 9999) return { error: '노출 순서는 -9999~9999 사이 숫자로 입력하세요.' };
    out.sort = n;
  }

  if (type === 'events') {
    if (has('price')) {
      const n = Number(body.price || 0);
      if (!Number.isInteger(n) || n < 0 || n > 100000000) return { error: '가격을 확인하세요.' };
      out.price = n;
    }
    if (has('description')) {
      const d = String(body.description ?? '').trim();
      if (d.length > 2000) return { error: '설명은 2000자 이내로 입력하세요.' };
      out.description = d || null;
    }
  }

  if (type === 'popups' && (isCreate || has('link_type') || has('link_target'))) {
    const lt = has('link_type') ? body.link_type : (isCreate ? 'none' : null);
    if (!LINK_TYPES.includes(lt)) return { error: '연결 방식을 선택하세요.' };
    const target = String(body.link_target ?? '').trim();
    if (lt === 'page' && !/^\/[a-z0-9_\-/]*$/.test(target)) return { error: '이동할 메뉴를 선택하세요.' };
    if (lt === 'event' && !parseId(target)) return { error: '연결할 이벤트를 선택하세요.' };
    if (lt === 'url' && !/^https?:\/\/[^\s"'<>]+$/.test(target)) return { error: '외부 링크는 http:// 또는 https:// 로 시작해야 합니다.' };
    out.link_type = lt;
    out.link_target = lt === 'none' ? null : target;
  }
  return { data: out };
}

async function list(res, t) {
  const { rows } = await query(`SELECT ${t.cols} FROM ${t.table} ORDER BY sort, id`);
  return res.status(200).json({ ok: true, items: rows });
}

async function create(req, res, type, t) {
  const { error, data } = pickFields(type, req.body || {}, true);
  if (error) return res.status(400).json({ ok: false, message: error });
  if (data.link_type === 'event') {
    const ev = await query('SELECT 1 FROM public.site_events WHERE id = $1', [data.link_target]);
    if (!ev.rowCount) return res.status(400).json({ ok: false, message: '연결할 이벤트를 찾을 수 없습니다.' });
  }
  const keys = Object.keys(data);
  const { rows } = await query(
    `INSERT INTO ${t.table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING ${t.cols}`,
    keys.map(k => data[k]));
  return res.status(201).json({ ok: true, item: rows[0] });
}

async function update(req, res, type, t, id) {
  const { error, data } = pickFields(type, req.body || {}, false);
  if (error) return res.status(400).json({ ok: false, message: error });
  const keys = Object.keys(data);
  if (!keys.length) return res.status(400).json({ ok: false, message: '변경할 내용이 없습니다.' });
  if (data.link_type === 'event') {
    const ev = await query('SELECT 1 FROM public.site_events WHERE id = $1', [data.link_target]);
    if (!ev.rowCount) return res.status(400).json({ ok: false, message: '연결할 이벤트를 찾을 수 없습니다.' });
  }
  // 기간을 한쪽만 바꿀 때도 시작일 ≤ 종료일 유지 (DB 제약 위반 → 500 대신 안내)
  const { rows } = await query(
    `UPDATE ${t.table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')}
      WHERE id = $${keys.length + 1} RETURNING ${t.cols}`,
    [...keys.map(k => data[k]), id]).catch(e => {
      if (e.code === '23514') return { rows: null };
      throw e;
    });
  if (rows === null) return res.status(400).json({ ok: false, message: '종료일이 시작일보다 빠릅니다.' });
  if (!rows[0]) return res.status(404).json({ ok: false, message: `해당 ${t.label}이(가) 없습니다.` });
  await cleanupImages().catch(() => {});
  return res.status(200).json({ ok: true, item: rows[0] });
}

async function remove(res, type, t, id) {
  if (type === 'events') {
    // 이 이벤트로 연결된 팝업은 '연결 없음'으로 바꿔 깨진 링크를 막는다
    await query(`UPDATE public.site_popups SET link_type = 'none', link_target = NULL WHERE link_type = 'event' AND link_target = $1`, [String(id)]);
  }
  const { rowCount } = await query(`DELETE FROM ${t.table} WHERE id = $1`, [id]);
  if (!rowCount) return res.status(404).json({ ok: false, message: `해당 ${t.label}이(가) 없습니다.` });
  await cleanupImages().catch(() => {});
  return res.status(200).json({ ok: true });
}

async function uploadImage(req, res) {
  const mime = String(req.body?.mime || '');
  if (!IMAGE_TYPES.includes(mime)) return res.status(400).json({ ok: false, message: 'JPG · PNG · WEBP · GIF 이미지만 올릴 수 있습니다.' });
  const b64 = String(req.body?.data || '').replace(/^data:[^;]+;base64,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) return res.status(400).json({ ok: false, message: '이미지 데이터가 비어 있습니다.' });
  if (buf.length > MAX_IMAGE_BYTES) return res.status(413).json({ ok: false, message: '이미지는 3MB 이하로 올려주세요.' });
  const { rows } = await query('INSERT INTO public.site_images (mime, data) VALUES ($1, $2) RETURNING id', [mime, buf]);
  return res.status(201).json({ ok: true, url: IMAGE_URL_PREFIX + rows[0].id });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    await ensureContentTables();

    const type = String(req.query.type || '');
    if (type === 'image') {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
      }
      return await uploadImage(req, res);
    }
    const t = TABLES[type];
    if (!t) return res.status(400).json({ ok: false, message: 'type 은 popups · events · image 중 하나여야 합니다.' });

    if (req.method === 'GET') return await list(res, t);
    if (req.method === 'POST') return await create(req, res, type, t);

    const id = parseId(req.query.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id가 필요합니다.' });
    if (req.method === 'PATCH') return await update(req, res, type, t, id);
    if (req.method === 'DELETE') return await remove(res, type, t, id);

    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin/content]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
