// ============================================================
// /api/admin/records — 회원 · 리뷰 · 전후사진 관리 + 기존 사이트 데이터 이관 (관리자 인증 필수)
//  GET    ?type=members|reviews|photos&q=&page=&size=   목록
//  PATCH  ?type=…&id=1 {…}                               수정 (회원 메모 · 리뷰 공개 · 사진 공개/동의/목록표시)
//  DELETE ?type=…&id=1                                   삭제
//  POST   ?action=import&type=consults|members|reviews|photos|events|popups { items: [...] }
//         기존 makeline.kr 데이터 일괄 이관 (legacy_key 기준, 다시 실행해도 중복 없음)
//  GET    ?action=legacy                                 이관 검수용: 종류별 이관 건수와 legacy_key 목록
// ============================================================
const { getPool, query } = require('../../lib/db');
const { requireAdmin } = require('../../lib/auth');
const { ensureRecordTables, LEGACY_SOURCE } = require('../../lib/records');
const { IMAGE_URL_PREFIX } = require('../../lib/content');

const LIST = {
  members: { table: 'public.site_members', cols: 'id, legacy_key, user_id, email, name, phone, join_ip, joined_at, memo, source, created_at', search: ['user_id', 'email', 'name', 'phone'], order: 'joined_at DESC NULLS LAST, id DESC' },
  reviews: { table: 'public.site_reviews', cols: 'id, legacy_key, product, rating, gender, age_group, content, image, visible, written_at, created_at', search: ['product', 'content'], order: 'written_at DESC NULLS LAST, id DESC' },
  // written_at 은 날짜(DATE) 컬럼이라 시간대 변환 없이 문자열로
  photos: { table: 'public.site_before_after', cols: "id, legacy_key, title, content_title, gender, age, height, area, list_image, images, details, show_in_list, visible, consent, to_char(written_at, 'YYYY-MM-DD') AS written_at, created_at", search: ['title', 'content_title', 'area'], order: 'written_at DESC NULLS LAST, id DESC' },
};
const MAX_BATCH = 300;

const parseId = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };
const str = (v, max) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
// 기존 사이트 시각은 한국 시간. 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY-MM-DD HH:MM(:SS)' 모두 처리
const ts = (v) => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (/[zZ]|[+-]\d\d:?\d\d$/.test(s)) { const d = new Date(s); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }
  const m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const p = (x, n = 2) => String(x || 0).padStart(n, '0');
  const d = new Date(`${m[1]}-${p(m[2])}-${p(m[3])}T${p(m[4])}:${p(m[5])}:${p(m[6])}+09:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
// 'YYYY-MM-DD', 'YYYY.MM.DD', 'YYYY/M/D' 모두 'YYYY-MM-DD' 로
const day = (v) => { const m = String(v ?? '').trim().match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/); return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : null; };
const isImg = (v) => typeof v === 'string' && (/^https:\/\/[^\s"'<>]+$/.test(v) || new RegExp(`^${IMAGE_URL_PREFIX.replace('?', '\\?')}\\d+$`).test(v));
const img = (v) => (isImg(v) ? v.slice(0, 1000) : null);

// ── 목록 · 수정 · 삭제 ──────────────────────────────────────
async function list(req, res, type) {
  const t = LIST[type];
  const q = String(req.query.q || '').trim().slice(0, 50);
  const size = Math.min(Math.max(parseInt(req.query.size, 10) || 50, 1), 200);
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${q.replace(/[%_\\]/g, '\\$&')}%`);
    where = `WHERE ${t.search.map(c => `${c} ILIKE $1`).join(' OR ')}`;
  }
  const [rows, total] = await Promise.all([
    query(`SELECT ${t.cols} FROM ${t.table} ${where} ORDER BY ${t.order} LIMIT ${size} OFFSET ${(page - 1) * size}`, params),
    query(`SELECT count(*)::int AS n FROM ${t.table} ${where}`, params),
  ]);
  return res.status(200).json({ ok: true, items: rows.rows, total: total.rows[0].n, page, size });
}

async function update(req, res, type, id) {
  const b = req.body || {};
  const sets = {};
  if (type === 'members' && b.memo !== undefined) sets.memo = str(b.memo, 2000);
  if (type === 'reviews' && b.visible !== undefined) sets.visible = b.visible === true;
  if (type === 'photos') {
    if (b.consent !== undefined) sets.consent = b.consent === true;
    if (b.show_in_list !== undefined) sets.show_in_list = b.show_in_list === true;
    if (b.visible !== undefined) sets.visible = b.visible === true;
    if (sets.visible) {
      const cur = await query('SELECT consent FROM public.site_before_after WHERE id = $1', [id]);
      const consent = sets.consent ?? cur.rows[0]?.consent;
      if (!consent) return res.status(400).json({ ok: false, message: '환자 동의를 확인한 사진만 공개할 수 있습니다.' });
    }
  }
  const keys = Object.keys(sets);
  if (!keys.length) return res.status(400).json({ ok: false, message: '변경할 내용이 없습니다.' });
  const t = LIST[type];
  const { rows } = await query(`UPDATE ${t.table} SET ${keys.map((k, i) => `${k} = $${i + 1}`).join(', ')} WHERE id = $${keys.length + 1} RETURNING ${t.cols}`, [...keys.map(k => sets[k]), id]);
  if (!rows[0]) return res.status(404).json({ ok: false, message: '해당 항목이 없습니다.' });
  return res.status(200).json({ ok: true, item: rows[0] });
}

async function remove(res, type, id) {
  const { rowCount } = await query(`DELETE FROM ${LIST[type].table} WHERE id = $1`, [id]);
  if (!rowCount) return res.status(404).json({ ok: false, message: '해당 항목이 없습니다.' });
  return res.status(200).json({ ok: true });
}

// ── 이관 ────────────────────────────────────────────────────
// 상담·회원·리뷰·전후사진은 건수가 많아 한 번의 INSERT … SELECT FROM jsonb_to_recordset 로 묶어서 저장한다
// (서버리스 실행 시간 제한 안에서 끝나도록). 결과는 (xmax = 0) 으로 신규/갱신을 구분한다.
const BULK = {
  consults: {
    clean: (it) => ({
      legacy_key: it.legacy_key, name: str(it.name, 60) || '(이름 없음)', phone: str(it.phone, 40) || '-',
      content: str(it.content, 10000), created_at: ts(it.created_at) || new Date().toISOString(),
    }),
    sql: `INSERT INTO public.consult_requests
            (legacy_key, name, phone, content, privacy_agreed, privacy_agreed_at, status, source, created_at, updated_at)
          SELECT legacy_key, name, phone, content, TRUE, created_at, 'done', '${LEGACY_SOURCE}', created_at, created_at
            FROM jsonb_to_recordset($1::jsonb) AS x(legacy_key text, name text, phone text, content text, created_at timestamptz)
          ON CONFLICT (legacy_key) DO UPDATE SET name = EXCLUDED.name, phone = EXCLUDED.phone, content = EXCLUDED.content, created_at = EXCLUDED.created_at
          RETURNING (xmax = 0) AS inserted`,
  },
  members: {
    clean: (it) => ({
      legacy_key: it.legacy_key, user_id: str(it.user_id, 100), email: str(it.email, 200), name: str(it.name, 60),
      phone: str(it.phone, 30), join_ip: str(it.join_ip, 64), joined_at: ts(it.joined_at),
    }),
    sql: `INSERT INTO public.site_members (legacy_key, user_id, email, name, phone, join_ip, joined_at, source)
          SELECT legacy_key, user_id, email, name, phone, join_ip, joined_at, '${LEGACY_SOURCE}'
            FROM jsonb_to_recordset($1::jsonb) AS x(legacy_key text, user_id text, email text, name text, phone text, join_ip text, joined_at timestamptz)
          ON CONFLICT (legacy_key) DO UPDATE SET user_id = EXCLUDED.user_id, email = EXCLUDED.email, name = EXCLUDED.name,
            phone = EXCLUDED.phone, join_ip = EXCLUDED.join_ip, joined_at = EXCLUDED.joined_at
          RETURNING (xmax = 0) AS inserted`,
  },
  reviews: {
    clean: (it) => ({
      legacy_key: it.legacy_key, product: str(it.product, 100),
      rating: Number.isInteger(+it.rating) && +it.rating >= 0 && +it.rating <= 5 && String(it.rating ?? '') !== '' ? +it.rating : null,
      gender: str(it.gender, 10), age_group: str(it.age_group, 20), content: str(it.content, 10000), image: img(it.image), written_at: ts(it.written_at),
    }),
    sql: `INSERT INTO public.site_reviews (legacy_key, product, rating, gender, age_group, content, image, written_at)
          SELECT legacy_key, product, rating, gender, age_group, content, image, written_at
            FROM jsonb_to_recordset($1::jsonb) AS x(legacy_key text, product text, rating smallint, gender text, age_group text, content text, image text, written_at timestamptz)
          ON CONFLICT (legacy_key) DO UPDATE SET product = EXCLUDED.product, rating = EXCLUDED.rating, gender = EXCLUDED.gender,
            age_group = EXCLUDED.age_group, content = EXCLUDED.content, image = COALESCE(EXCLUDED.image, site_reviews.image), written_at = EXCLUDED.written_at
          RETURNING (xmax = 0) AS inserted`,
  },
  photos: {
    clean: (it) => ({
      legacy_key: it.legacy_key, title: str(it.title, 200), content_title: str(it.content_title, 200), gender: str(it.gender, 20),
      age: str(it.age, 20), height: str(it.height, 20), area: str(it.area, 200), list_image: img(it.list_image),
      images: (Array.isArray(it.images) ? it.images : []).filter(x => x && isImg(x.url)).slice(0, 8).map(x => ({ url: x.url, label: str(x.label, 40) })),
      details: it.details && typeof it.details === 'object' && !Array.isArray(it.details) ? it.details : {},
      show_in_list: it.show_in_list !== false, written_at: day(it.written_at),
    }),
    sql: `INSERT INTO public.site_before_after (legacy_key, title, content_title, gender, age, height, area, list_image, images, details, show_in_list, written_at)
          SELECT legacy_key, title, content_title, gender, age, height, area, list_image, images, details, show_in_list, written_at
            FROM jsonb_to_recordset($1::jsonb) AS x(legacy_key text, title text, content_title text, gender text, age text, height text, area text,
                 list_image text, images jsonb, details jsonb, show_in_list boolean, written_at date)
          ON CONFLICT (legacy_key) DO UPDATE SET title = EXCLUDED.title, content_title = EXCLUDED.content_title, gender = EXCLUDED.gender,
            age = EXCLUDED.age, height = EXCLUDED.height, area = EXCLUDED.area, list_image = COALESCE(EXCLUDED.list_image, site_before_after.list_image),
            images = CASE WHEN jsonb_array_length(EXCLUDED.images) > 0 THEN EXCLUDED.images ELSE site_before_after.images END,
            details = EXCLUDED.details, show_in_list = EXCLUDED.show_in_list, written_at = EXCLUDED.written_at
          RETURNING (xmax = 0) AS inserted`,
  },
};

// 이벤트·팝업은 건수가 적고, 초기 데이터와 연결하는 판단이 필요해 한 건씩 처리한다
const SINGLE = {
  async events(c, it) {
    const title = str(it.title, 100) || '(제목 없음)';
    const image = img(it.image);
    const desc = str(it.description, 2000);
    // 이미 초기 데이터로 들어가 있는 같은 이벤트는 새로 만들지 않고 연결만 한다 (노출 설정은 그대로 유지)
    const link = await c.query(
      `UPDATE public.site_events SET legacy_key = $1, image = COALESCE($2, image), description = COALESCE(description, $3)
        WHERE id = (SELECT id FROM public.site_events WHERE legacy_key IS NULL AND title = $4 ORDER BY id LIMIT 1)`,
      [it.legacy_key, image, desc, title]);
    if (link.rowCount) return 'linked';
    const price = Number.isInteger(+it.price) && +it.price >= 0 ? +it.price : 0;
    const { rows } = await c.query(
      `INSERT INTO public.site_events (legacy_key, title, image, price, description, visible, sort, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8::timestamptz, now()))
       ON CONFLICT (legacy_key) DO UPDATE SET title = EXCLUDED.title, image = COALESCE(EXCLUDED.image, site_events.image),
         description = COALESCE(EXCLUDED.description, site_events.description)
       RETURNING (xmax = 0) AS inserted`,
      [it.legacy_key, title, image, price, desc, it.visible === true, 100 + (parseInt(it.sort, 10) || 0), ts(it.created_at)]);
    return rows[0].inserted ? 'inserted' : 'updated';
  },
  async popups(c, it) {
    const image = img(it.image);
    // 초기 데이터로 들어간 팝업(원본 이미지 파일명이 같은 것)은 연결만 하고, 클릭 연결·노출은 지금 설정 유지
    if (it.match_file) {
      const seeds = await c.query('SELECT id, image FROM public.site_popups WHERE legacy_key IS NULL');
      const norm = (u) => { try { return decodeURIComponent(String(u).split('/').pop()).normalize('NFC'); } catch { return ''; } };
      const hit = seeds.rows.find(r => norm(r.image) === String(it.match_file).normalize('NFC'));
      if (hit) {
        await c.query('UPDATE public.site_popups SET legacy_key = $1, image = COALESCE($2, image) WHERE id = $3', [it.legacy_key, image, hit.id]);
        return 'linked';
      }
    }
    // 기존 팝업 링크가 기존 이벤트 상세였다면 → 이관된 이벤트로 연결, 없으면 원래 주소로
    let linkType = 'none', target = null;
    if (it.link_event_key) {
      const ev = await c.query('SELECT id FROM public.site_events WHERE legacy_key = $1', [it.link_event_key]);
      if (ev.rows[0]) { linkType = 'event'; target = String(ev.rows[0].id); }
    }
    // 기존 사이트의 다른 페이지 링크는 새 사이트의 같은 메뉴로 (이관 스크립트가 link_page 로 바꿔서 보냄)
    if (linkType === 'none' && /^\/[a-z0-9_\-/]*$/.test(it.link_page || '')) { linkType = 'page'; target = it.link_page; }
    if (linkType === 'none' && /^https?:\/\/[^\s"'<>]+$/.test(it.link_url || '')) { linkType = 'url'; target = it.link_url.slice(0, 1000); }
    let start = day(it.start_date), end = day(it.end_date);
    if (start && end && end < start) end = null;
    const { rows } = await c.query(
      `INSERT INTO public.site_popups (legacy_key, title, image, link_type, link_target, start_date, end_date, visible, sort)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (legacy_key) DO UPDATE SET title = EXCLUDED.title, image = COALESCE(EXCLUDED.image, site_popups.image),
         start_date = EXCLUDED.start_date, end_date = EXCLUDED.end_date
       RETURNING (xmax = 0) AS inserted`,
      [it.legacy_key, str(it.title, 100) || '(제목 없음)', image, linkType, target, start, end, it.visible === true, 100 + (parseInt(it.sort, 10) || 0)]);
    return rows[0].inserted ? 'inserted' : 'updated';
  },
};

async function importBatch(req, res, type) {
  const raw = Array.isArray(req.body?.items) ? req.body.items : null;
  if (!raw || !raw.length) return res.status(400).json({ ok: false, message: 'items가 비어 있습니다.' });
  if (raw.length > MAX_BATCH) return res.status(400).json({ ok: false, message: `한 번에 ${MAX_BATCH}건까지 보낼 수 있습니다.` });
  const items = raw.map(it => ({ ...it, legacy_key: str(it?.legacy_key, 300) })).filter(it => it.legacy_key);
  const result = { received: raw.length, inserted: 0, updated: 0, linked: 0, failed: raw.length - items.length };

  if (BULK[type]) {
    // 같은 배치 안에 같은 legacy_key 가 두 번 있으면 마지막 것만 사용
    const uniq = [...new Map(items.map(it => [it.legacy_key, BULK[type].clean(it)])).values()];
    result.failed += items.length - uniq.length;
    const { rows } = await query(BULK[type].sql, [JSON.stringify(uniq)]);
    rows.forEach(r => (r.inserted ? result.inserted++ : result.updated++));
    return res.status(200).json({ ok: true, ...result });
  }

  const client = await getPool().connect();
  try {
    for (const it of items) {
      try { result[await SINGLE[type](client, it)]++; } catch (e) { result.failed++; console.error('[import]', type, e.message); }
    }
  } finally {
    client.release();
  }
  return res.status(200).json({ ok: true, ...result });
}


async function legacySummary(res) {
  const pick = async (table, extra = '') => (await query(`SELECT legacy_key FROM ${table} WHERE legacy_key IS NOT NULL ${extra} ORDER BY legacy_key`)).rows.map(r => r.legacy_key);
  const keys = {
    consults: await pick('public.consult_requests'),
    members: await pick('public.site_members'),
    reviews: await pick('public.site_reviews'),
    photos: await pick('public.site_before_after'),
    events: await pick('public.site_events'),
    popups: await pick('public.site_popups'),
  };
  const counts = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v.length]));
  return res.status(200).json({ ok: true, counts, keys });
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    await ensureRecordTables();

    const action = String(req.query.action || '');
    const type = String(req.query.type || '');
    if (action === 'import') {
      if (req.method !== 'POST') return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
      if (!BULK[type] && !SINGLE[type]) return res.status(400).json({ ok: false, message: '이관 type 이 올바르지 않습니다.' });
      return await importBatch(req, res, type);
    }
    if (action === 'legacy') return await legacySummary(res);

    if (!LIST[type]) return res.status(400).json({ ok: false, message: 'type 은 members · reviews · photos 중 하나여야 합니다.' });
    if (req.method === 'GET') return await list(req, res, type);
    const id = parseId(req.query.id);
    if (!id) return res.status(400).json({ ok: false, message: 'id가 필요합니다.' });
    if (req.method === 'PATCH') return await update(req, res, type, id);
    if (req.method === 'DELETE') return await remove(res, type, id);
    res.setHeader('Allow', 'GET, PATCH, DELETE, POST');
    return res.status(405).json({ ok: false, message: 'Method Not Allowed' });
  } catch (e) {
    console.error('[admin/records]', e.message);
    return res.status(500).json({ ok: false, message: '서버 오류' });
  }
};
