// ============================================================
// 홈페이지 팝업 · 이벤트 · 업로드 이미지 (Supabase / PostgreSQL)
//  · 테이블은 처음 호출될 때 자동으로 만든다 (db/content.sql 과 같은 내용)
//  · 테이블을 처음 만들 때만 기존 홈페이지의 팝업·이벤트를 초기 데이터로 넣는다
// ============================================================
const { getPool, query } = require('./db');

// 초기 데이터 이미지는 이 사이트 images/upload 에 보관된 사본 (기존 서버 의존 X)
const LOCAL_UPLOAD = '/images/upload';
const LINK_TYPES = ['none', 'page', 'event', 'url'];
const IMAGE_URL_PREFIX = '/api/content?img=';

const SCHEMA_SQL = `
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TABLE IF NOT EXISTS public.site_images (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mime        VARCHAR(30)  NOT NULL,
  data        BYTEA        NOT NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT site_images_mime_chk CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif'))
);

CREATE TABLE IF NOT EXISTS public.site_events (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        VARCHAR(100) NOT NULL,
  image        TEXT,
  price        INTEGER      NOT NULL DEFAULT 0,
  description  TEXT,
  start_date   DATE,
  end_date     DATE,
  visible      BOOLEAN      NOT NULL DEFAULT TRUE,
  sort         INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT site_events_price_chk CHECK (price >= 0),
  CONSTRAINT site_events_date_chk  CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);

CREATE TABLE IF NOT EXISTS public.site_popups (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  title        VARCHAR(100) NOT NULL,
  image        TEXT,
  link_type    VARCHAR(10)  NOT NULL DEFAULT 'none',
  link_target  TEXT,
  start_date   DATE,
  end_date     DATE,
  visible      BOOLEAN      NOT NULL DEFAULT TRUE,
  sort         INTEGER      NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT site_popups_link_chk CHECK (link_type IN ('none', 'page', 'event', 'url')),
  CONSTRAINT site_popups_date_chk CHECK (start_date IS NULL OR end_date IS NULL OR start_date <= end_date)
);

DROP TRIGGER IF EXISTS site_events_updated_at ON public.site_events;
CREATE TRIGGER site_events_updated_at BEFORE UPDATE ON public.site_events
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS site_popups_updated_at ON public.site_popups;
CREATE TRIGGER site_popups_updated_at BEFORE UPDATE ON public.site_popups
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 공개 API(anon/authenticated) 직접 접근 차단 — 서버(postgres 역할)만 읽고 쓴다
ALTER TABLE public.site_images ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_popups ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.site_images, public.site_events, public.site_popups FROM anon, authenticated;
  END IF;
END $$;
`;

// 기존 홈페이지(makeline.kr)의 이벤트 · 팝업 — 테이블을 처음 만들 때 한 번만 넣는다
const SEED_EVENTS = [
  ['라인앤코 여리프로그램', '/UPLOAD/BOARD/EVENT/2049731078_s9IcQVHM_E18492E185A9E186B7E18491E185A6E1848BE185B5E1848CE185B5_E1848BE185A7E18485E185B5E1848EE185B5E186B7E1848CE185A5E186A8E1848BE185ADE186BC.jpg', 0],
  ['V라인 올인원 케어', '/UPLOAD/BOARD/EVENT/1890182745_yOIlQvZg_2.png', 0],
  ['라인앤코 코프팅', '/UPLOAD/BOARD/EVENT/1890182745_4Pn1dSZX_5.png', 550000],
  ['힙프팅 특가', '/UPLOAD/BOARD/EVENT/1890182745_etlRGYXO_4.png', 580000],
  ['주름, 꺼진 부위 볼륨 채우는 볼류머샷 이벤트', '/UPLOAD/BOARD/EVENT/1890182745_x2UswoZN_3.png', 60000],
];
const popupImg = (name) => `${LOCAL_UPLOAD}/POPUP/${name}`;
const SEED_POPUPS = [
  ['라인앤코 여리프로그램', popupImg('yeori_program.jpg'), 'page', '/program/yeori'],
  ['볼류머샷', popupImg('3_177544027675759.png'), 'page', '/face/volumer'],
  ['라인앤코 코프팅', popupImg('5.png'), 'page', '/face/nose'],
];

let ready = null;

async function setup() {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    // 동시에 여러 서버 인스턴스가 처음 실행돼도 한 번만 만들도록 잠금
    await client.query('SELECT pg_advisory_xact_lock(7270114)');
    const { rows } = await client.query(`SELECT to_regclass('public.site_popups') IS NULL AS fresh`);
    await client.query(SCHEMA_SQL);
    if (rows[0].fresh) {
      for (const [i, [title, path, price]] of SEED_EVENTS.entries()) {
        await client.query('INSERT INTO public.site_events (title, image, price, sort) VALUES ($1, $2, $3, $4)', [title, LOCAL_UPLOAD + path.replace(/^\/UPLOAD/, ''), price, i]);
      }
      for (const [i, [title, image, type, target]] of SEED_POPUPS.entries()) {
        await client.query('INSERT INTO public.site_popups (title, image, link_type, link_target, sort) VALUES ($1, $2, $3, $4, $5)', [title, image, type, target, i]);
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// 인스턴스마다 한 번만 실행 (실패하면 다음 요청에서 다시 시도)
function ensureContentTables() {
  if (!ready) ready = setup().catch(e => { ready = null; throw e; });
  return ready;
}

// 날짜는 시간대 변환 없이 'YYYY-MM-DD' 문자열로 내려준다
const DATE_COLS = `to_char(start_date, 'YYYY-MM-DD') AS start_date, to_char(end_date, 'YYYY-MM-DD') AS end_date`;
const EVENT_COLS = `id, title, image, price, description, ${DATE_COLS}`;
const POPUP_COLS = `id, title, image, link_type, link_target, ${DATE_COLS}`;
const ADMIN_COLS = `visible, sort, created_at, updated_at`;

// 오늘(한국 시간) 기준으로 기간 안에 있는 항목만
const ACTIVE_SQL = `visible
  AND (start_date IS NULL OR start_date <= (now() AT TIME ZONE 'Asia/Seoul')::date)
  AND (end_date   IS NULL OR end_date   >= (now() AT TIME ZONE 'Asia/Seoul')::date)`;

// 어디서도 쓰지 않는 업로드 이미지 정리 (막 올리고 아직 저장 전인 이미지는 남기도록 하루 여유)
async function cleanupImages() {
  await query(`DELETE FROM public.site_images i
    WHERE i.created_at < now() - interval '1 day'
      AND NOT EXISTS (SELECT 1 FROM public.site_popups p WHERE p.image = '${IMAGE_URL_PREFIX}' || i.id)
      AND NOT EXISTS (SELECT 1 FROM public.site_events e WHERE e.image = '${IMAGE_URL_PREFIX}' || i.id)`);
}

module.exports = {
  ensureContentTables, cleanupImages, ACTIVE_SQL, LINK_TYPES, IMAGE_URL_PREFIX, SCHEMA_SQL,
  EVENT_COLS, POPUP_COLS, ADMIN_COLS,
};
