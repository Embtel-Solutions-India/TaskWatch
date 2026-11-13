-- 019: ADR-0015. Working time per vertical (D-159, D-160) and attendance marked by the GM (D-156…D-164). Additive.
-- Null vertical values mean "not set": the organization's workday and Mon–Fri, and each person's stored zone and
-- quiet hours until the GM sets the vertical's (no behaviour change on the day this runs, except D-160 working days).
alter table entities
  add column time_zone     text,
  add column quiet_enabled boolean,
  add column quiet_start   text,
  add column quiet_end     text,
  add column work_days     int[],     -- 0 = Sunday … 6 = Saturday
  add column work_start    text,      -- HH:MM
  add column work_end      text;      -- HH:MM; '24:00' with start '00:00' = all day; end <= start = overnight

create table attendance (
  organization_id int         not null references organizations(id),
  user_id         int         not null,
  day             date        not null,
  status          text        not null check (status in ('present', 'absent', 'half_day', 'leave', 'unmarked')),
  away_from       text,       -- half_day only, HH:MM in the vertical's zone
  away_to         text,
  marked_by       int         not null references users(id),
  marked_at       timestamptz not null,
  primary key (user_id, day),
  foreign key (user_id, organization_id) references users (id, organization_id),
  check ((status = 'half_day') = (away_from is not null and away_to is not null))
);
create index attendance_org_day_idx on attendance (organization_id, day);
