-- ============================================================
-- 라인앤코한의원 · 상담 신청 DB (Supabase / PostgreSQL)
-- 홈페이지 하단 '비대면 처방 / 진료상담 신청' 폼 저장용
-- 여러 번 실행해도 안전하도록 IF NOT EXISTS / OR REPLACE 사용
-- ============================================================

-- 상담 신청 테이블
CREATE TABLE IF NOT EXISTS public.consult_requests (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name               VARCHAR(30)  NOT NULL,                 -- 이름 (폼 maxlength 13)
  phone              VARCHAR(20)  NOT NULL,                 -- 연락처 (숫자·하이픈)
  content            TEXT,                                  -- 상담내용 (선택)
  privacy_agreed     BOOLEAN      NOT NULL DEFAULT FALSE,   -- 개인정보처리방침 동의
  privacy_agreed_at  TIMESTAMPTZ,                           -- 동의 시각
  status             VARCHAR(12)  NOT NULL DEFAULT 'new',   -- new / contacted / done / cancel
  memo               TEXT,                                  -- 관리자 메모
  source             VARCHAR(30)  NOT NULL DEFAULT 'homepage_footer', -- 유입 폼 위치
  user_agent         TEXT,                                  -- 접수 브라우저 (스팸 추적용)
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),

  CONSTRAINT consult_status_chk  CHECK (status IN ('new', 'contacted', 'done', 'cancel')),
  CONSTRAINT consult_name_chk    CHECK (char_length(btrim(name)) BETWEEN 1 AND 30),
  CONSTRAINT consult_phone_chk   CHECK (phone ~ '^0[0-9]{1,2}-?[0-9]{3,4}-?[0-9]{4}$'),
  CONSTRAINT consult_content_chk CHECK (content IS NULL OR char_length(content) <= 1000),
  -- 개인정보 동의 없이는 저장 불가
  CONSTRAINT consult_privacy_chk CHECK (privacy_agreed = TRUE AND privacy_agreed_at IS NOT NULL)
);

COMMENT ON TABLE  public.consult_requests IS '홈페이지 비대면 처방/진료상담 신청';
COMMENT ON COLUMN public.consult_requests.status IS 'new=신규, contacted=연락완료, done=상담완료, cancel=취소';

-- 관리자 목록 조회용 인덱스 (최신순 · 상태별)
CREATE INDEX IF NOT EXISTS consult_requests_created_at_idx ON public.consult_requests (created_at DESC);
CREATE INDEX IF NOT EXISTS consult_requests_status_idx     ON public.consult_requests (status, created_at DESC);

-- updated_at 자동 갱신
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS consult_requests_updated_at ON public.consult_requests;
CREATE TRIGGER consult_requests_updated_at
  BEFORE UPDATE ON public.consult_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ------------------------------------------------------------
-- 보안: Supabase는 테이블을 공개 API(anon 키)로 노출하므로 RLS를 켠다.
-- 정책(policy)을 만들지 않으면 anon/authenticated 는 읽기·쓰기 모두 차단되고,
-- 서버(/api/consult)는 postgres 역할로 접속하므로 RLS 영향을 받지 않는다.
-- → 환자 연락처가 브라우저에서 직접 조회되는 일을 막는다.
-- ------------------------------------------------------------
ALTER TABLE public.consult_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.consult_requests FROM anon, authenticated;
