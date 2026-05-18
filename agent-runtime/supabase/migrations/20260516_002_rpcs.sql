-- Auto-update updated_at on row modification
create function set_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

create trigger trg_memories_updated before update on memories
  for each row execute function set_updated_at();
create trigger trg_agent_config_updated before update on agent_config
  for each row execute function set_updated_at();
create trigger trg_skills_updated before update on skills
  for each row execute function set_updated_at();

-- Memory: find recent (pinned-first, LRU order)
create function find_memories_recent(p_user_id text, p_limit int)
returns table(id bigint, title text, body text, updated_at timestamptz,
              use_count int, pinned boolean)
language sql stable security definer as $$
  select id, title, body, updated_at, use_count, pinned
  from memories
  where user_id = p_user_id and state = 'active'
  order by pinned desc, last_used_at desc nulls last
  limit p_limit;
$$;

-- Memory: full-text search
create function find_memories_fts(p_user_id text, p_query text, p_limit int)
returns table(id bigint, title text, body text, updated_at timestamptz,
              use_count int, pinned boolean, rank real)
language sql stable security definer as $$
  select m.id, m.title, m.body, m.updated_at, m.use_count, m.pinned,
         ts_rank_cd(m.fts, q) as rank
  from memories m, plainto_tsquery('simple', p_query) q
  where m.user_id = p_user_id and m.state = 'active' and m.fts @@ q
  order by rank desc
  limit p_limit;
$$;

-- Memory: atomic increment use_count + touch last_used_at
create function memories_mark_used(p_ids bigint[])
returns void language sql security definer as $$
  update memories
  set use_count = use_count + 1, last_used_at = now()
  where id = any(p_ids);
$$;

-- Gate check: memory extraction stats for a user
create function memory_extraction_stats(p_user_id text)
returns table(since_last_success float, since_last_attempt float, new_sessions bigint)
language sql stable security definer as $$
  select
    coalesce(extract(epoch from (now() - max(case when phase='extract-success' then started_at end))), 1e9),
    coalesce(extract(epoch from (now() - max(case when phase='extract-attempt' then started_at end))), 1e9),
    count(*) filter (where phase='session-end' and started_at > now() - interval '30 days')
  from curator_runs where user_id = p_user_id;
$$;

-- Advisory locks (session-level)
create function try_advisory_lock(lock_key text)
returns boolean language sql security definer as $$
  select pg_try_advisory_lock(hashtextextended(lock_key, 0));
$$;

create function advisory_unlock(lock_key text)
returns boolean language sql security definer as $$
  select pg_advisory_unlock(hashtextextended(lock_key, 0));
$$;

-- Curator: state transitions + hard cap
create function curator_mark_stale(days int) returns void language plpgsql security definer as $$
begin
  update skills set state = 'stale'
    where state = 'active' and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
  update memories set state = 'stale'
    where state = 'active' and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
end $$;

create function curator_archive(days int) returns void language plpgsql security definer as $$
begin
  update skills set state = 'archived'
    where state in ('active','stale') and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
  update memories set state = 'archived'
    where state in ('active','stale') and not pinned
      and coalesce(last_used_at, created_at) < now() - (days || ' days')::interval;
end $$;

create function curator_hard_cap(max_active int) returns void language plpgsql security definer as $$
begin
  with ranked as (
    select id, row_number() over (
      partition by user_id order by pinned desc, last_used_at desc nulls last
    ) as rn from skills where state = 'active'
  )
  update skills set state = 'archived' where id in (select id from ranked where rn > max_active);

  with ranked as (
    select id, row_number() over (
      partition by user_id order by pinned desc, last_used_at desc nulls last
    ) as rn from memories where state = 'active'
  )
  update memories set state = 'archived' where id in (select id from ranked where rn > max_active);
end $$;
