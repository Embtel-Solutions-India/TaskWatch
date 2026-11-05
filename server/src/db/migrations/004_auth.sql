-- 004: sign-in tables (T-1.8; ADR-0002; DATABASE_DESIGN §3.11). Additive: the current server never reads them.
-- Password sign-in, TOTP (manager / CoS / CEO, D-21), password reset and the sign-in rate-limit counter.

-- Kept out of "users" so directory reads never load secrets.
create table user_credentials (
  user_id             int primary key references users(id),
  password_hash       text,                    -- 'scrypt$N$r$p$<salt b64>$<hash b64>' (Node crypto.scrypt)
  password_changed_at timestamptz,
  totp_secret_enc     bytea,                   -- AES-256-GCM: iv || tag || ciphertext; key from env, never stored here
  totp_enabled_at     timestamptz,
  totp_last_step      bigint,                  -- last accepted RFC 6238 time step (replay guard)
  check ((totp_enabled_at is null) or (totp_secret_enc is not null))
);

-- Only a hash of each token is stored; the token itself goes to the user once.
create table password_reset_tokens (
  token_hash bytea primary key,                -- sha256(token)
  user_id    int not null references users(id),
  created_at timestamptz not null,
  expires_at timestamptz not null,             -- created_at + 1 h (AUTH-04)
  used_at    timestamptz,
  created_by int references users(id),         -- set when an admin issues it (AUTH-05)
  check (expires_at > created_at)
);
create index password_reset_tokens_user_idx on password_reset_tokens (user_id);

-- Every sign-in, TOTP, reset attempt; doubles as the rate-limit counter (SECURITY_ARCHITECTURE §6).
create table login_attempts (
  id          bigserial primary key,
  at          timestamptz not null,
  email_lower text,
  user_id     int references users(id),
  ip          inet,
  method      text not null check (method in ('password','totp','google','dev','reset_request','reset')),
  ok          boolean not null,
  reason      text
);
create index login_attempts_email_idx on login_attempts (email_lower, at desc);
create index login_attempts_ip_idx    on login_attempts (ip, at desc);
