-- ============================================================
-- 라인앤코한의원 · 관리자 인증 (JWT + HttpOnly 쿠키)
-- schema.sql 다음에 실행. 여러 번 실행해도 안전.
-- ============================================================

-- 관리자 계정 (비밀번호는 bcrypt 해시만 저장)
CREATE TABLE IF NOT EXISTS public.admin_users (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username       VARCHAR(40)  NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  name           VARCHAR(40)  NOT NULL DEFAULT '관리자',
  token_version  INTEGER      NOT NULL DEFAULT 0,   -- 올리면 기존 JWT 전부 무효 (로그아웃·비번 변경)
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT admin_username_chk CHECK (username ~ '^[a-zA-Z0-9_.-]{3,40}$')
);

DROP TRIGGER IF EXISTS admin_users_updated_at ON public.admin_users;
CREATE TRIGGER admin_users_updated_at
  BEFORE UPDATE ON public.admin_users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- 로그인 시도 기록 (무차별 대입 잠금 + 감사 로그)
CREATE TABLE IF NOT EXISTS public.admin_login_attempts (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  username    VARCHAR(40) NOT NULL,
  ip          VARCHAR(64),
  success     BOOLEAN     NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_login_attempts_lookup_idx
  ON public.admin_login_attempts (username, created_at DESC);

-- 공개 API(anon/authenticated) 접근 차단 — 서버(postgres 역할)만 접근
ALTER TABLE public.admin_users          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_login_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_users, public.admin_login_attempts FROM anon, authenticated;
