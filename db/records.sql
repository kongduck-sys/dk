-- ============================================================
-- 라인앤코한의원 · 회원 / 리뷰 / 전후사진 + 기존 사이트(makeline.kr) 이관용 컬럼
-- lib/records.js 가 첫 호출 때 자동으로 실행하는 것과 같은 내용 (참고·수동 실행용)
-- content.sql 다음에 실행. 여러 번 실행해도 안전
-- ============================================================
-- 기존 데이터 식별값 (같은 건을 두 번 이관하지 않도록)
ALTER TABLE public.consult_requests ADD COLUMN IF NOT EXISTS legacy_key TEXT UNIQUE;
ALTER TABLE public.site_events      ADD COLUMN IF NOT EXISTS legacy_key TEXT UNIQUE;
ALTER TABLE public.site_popups      ADD COLUMN IF NOT EXISTS legacy_key TEXT UNIQUE;

CREATE TABLE IF NOT EXISTS public.site_members (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_key  TEXT UNIQUE,
  user_id     VARCHAR(100),
  email       VARCHAR(200),
  name        VARCHAR(60),
  phone       VARCHAR(30),
  join_ip     VARCHAR(64),
  joined_at   TIMESTAMPTZ,
  memo        TEXT,
  source      VARCHAR(30)  NOT NULL DEFAULT 'homepage',
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS site_members_joined_idx ON public.site_members (joined_at DESC NULLS LAST);

CREATE TABLE IF NOT EXISTS public.site_reviews (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_key  TEXT UNIQUE,
  product     VARCHAR(100),
  rating      SMALLINT,
  gender      VARCHAR(10),
  age_group   VARCHAR(20),
  content     TEXT,
  image       TEXT,
  visible     BOOLEAN      NOT NULL DEFAULT TRUE,
  written_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT site_reviews_rating_chk CHECK (rating IS NULL OR rating BETWEEN 0 AND 5)
);

-- 전후사진: 의료광고 기준상 홈페이지 공개는 기본 꺼짐 (visible = FALSE)
CREATE TABLE IF NOT EXISTS public.site_before_after (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  legacy_key     TEXT UNIQUE,
  title          VARCHAR(200),
  content_title  VARCHAR(200),
  gender         VARCHAR(20),
  age            VARCHAR(20),
  height         VARCHAR(20),
  area           VARCHAR(200),
  list_image     TEXT,
  images         JSONB        NOT NULL DEFAULT '[]'::jsonb,
  details        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  show_in_list   BOOLEAN      NOT NULL DEFAULT TRUE,
  visible        BOOLEAN      NOT NULL DEFAULT FALSE,
  consent        BOOLEAN      NOT NULL DEFAULT FALSE,
  written_at     DATE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS site_members_updated_at ON public.site_members;
CREATE TRIGGER site_members_updated_at BEFORE UPDATE ON public.site_members FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS site_reviews_updated_at ON public.site_reviews;
CREATE TRIGGER site_reviews_updated_at BEFORE UPDATE ON public.site_reviews FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS site_before_after_updated_at ON public.site_before_after;
CREATE TRIGGER site_before_after_updated_at BEFORE UPDATE ON public.site_before_after FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.site_members      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_reviews      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.site_before_after ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON public.site_members, public.site_reviews, public.site_before_after FROM anon, authenticated;
  END IF;
END $$;

-- 이관한 상담(legacy_key 있음)만 형식 검사 완화 (한 번만 실행)
ALTER TABLE public.consult_requests ALTER COLUMN name  TYPE VARCHAR(60);
ALTER TABLE public.consult_requests ALTER COLUMN phone TYPE VARCHAR(40);
ALTER TABLE public.consult_requests DROP CONSTRAINT IF EXISTS consult_name_chk;
ALTER TABLE public.consult_requests DROP CONSTRAINT IF EXISTS consult_phone_chk;
ALTER TABLE public.consult_requests DROP CONSTRAINT IF EXISTS consult_content_chk;
ALTER TABLE public.consult_requests ADD CONSTRAINT consult_name_chk
  CHECK (legacy_key IS NOT NULL OR char_length(btrim(name)) BETWEEN 1 AND 30);
ALTER TABLE public.consult_requests ADD CONSTRAINT consult_phone_chk
  CHECK (legacy_key IS NOT NULL OR phone ~ '^0[0-9]{1,2}-?[0-9]{3,4}-?[0-9]{4}$');
ALTER TABLE public.consult_requests ADD CONSTRAINT consult_content_chk
  CHECK (content IS NULL OR char_length(content) <= CASE WHEN legacy_key IS NULL THEN 1000 ELSE 10000 END);
