-- 010: comments get their own rows (T-4.10; DATABASE_DESIGN §3.7, D-12). Until now a comment lived only as an
-- activity_log row; each one is copied here, linked to that row, which stays the unchanged evidence.
insert into comments (task_id, author_id, body, created_at, log_id)
select l.task_id, l.actor_id, coalesce(l.body, ''), l.at, l.id
  from activity_log l
 where l.kind = 'comment' and l.actor_id is not null
   and not exists (select 1 from comments c where c.log_id = l.id)
 order by l.id;
