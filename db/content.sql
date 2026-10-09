-- ============================================================
-- 라인앤코한의원 · 홈페이지 팝업 / 이벤트 / 업로드 이미지
-- lib/content.js 가 첫 호출 때 자동으로 실행하는 것과 같은 내용 (참고·수동 실행용)
-- 여러 번 실행해도 안전. 초기 데이터(기존 팝업·이벤트)는 lib/content.js 가 최초 1회만 넣음
-- ============================================================
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
