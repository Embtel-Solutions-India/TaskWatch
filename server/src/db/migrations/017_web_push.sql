-- 017: Web Push (ADR-0012, owner 2026-11-11). Additive. One row per browser a person enabled; never deleted, revoked.
create table push_subscriptions (
  id              serial primary key,
  user_id         int not null references users(id),
  organization_id int not null references organizations(id),
  endpoint        text not null unique check (char_length(endpoint) <= 1000),
  p256dh          text not null check (char_length(p256dh) <= 200),
  auth            text not null check (char_length(auth) <= 100),
  user_agent      text check (char_length(user_agent) <= 300),
  created_at      timestamptz not null,
  last_used_at    timestamptz,
  revoked_at      timestamptz
);
create index push_subscriptions_user_idx on push_subscriptions (user_id) where revoked_at is null;

-- A fourth delivery channel next to in-app, email and WhatsApp.
alter table notifications drop constraint notifications_channel_check;
alter table notifications add constraint notifications_channel_check check (channel in ('inapp', 'whatsapp', 'email', 'push'));
