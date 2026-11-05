-- 006: one-time 2FA recovery codes (T-2.3; D-65: ten codes, issued once at enrolment, each usable once).
-- Only sha256 hashes are stored; the codes are shown to the person once and never again.
alter table user_credentials add column recovery_codes text[] not null default '{}';
