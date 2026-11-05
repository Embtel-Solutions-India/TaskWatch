-- 012: notifications phase (T-6.3, T-6.4). Additive: no row changes.
-- D-105: a person may have their own quiet window (e.g. a night team 08:00–20:00); null = the organization's.
alter table users
  add column quiet_start text check (quiet_start ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  add column quiet_end   text check (quiet_end ~ '^([01]\d|2[0-3]):[0-5]\d$'),
  add constraint users_quiet_pair check ((quiet_start is null) = (quiet_end is null));

-- T-6.3: when the dispatcher claimed a row, so a row left in 'sending' by a crash can be picked up again.
alter table notifications add column claimed_at timestamptz;
