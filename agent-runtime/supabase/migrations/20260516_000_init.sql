-- FEAT-4 initial schema: users, messages, memories, skills, agent_config, curator_runs
-- See documents/FEAT-4/plans/design-decisions.md §3

create table users (
  user_id text primary key,
  display_name text,
  created_at timestamptz default now(),
  last_active_at timestamptz default now()
);

create table messages (
  id bigserial primary key,
  user_id text references users(user_id),
  session_id text not null,
  role text check (role in ('user','assistant','tool','system')),
  content jsonb not null,
  tool_calls jsonb,
  tool_results jsonb,
  langfuse_trace_id text,
  created_at timestamptz default now()
);
create index on messages (user_id, session_id, created_at);

create table memories (
  id bigserial primary key,
  user_id text references users(user_id),
  slug text not null,
  category text check (category in ('user','feedback','project','reference')),
  title text not null,
  body text not null,
  frontmatter jsonb default '{}'::jsonb,
  state text check (state in ('active','stale','archived')) default 'active',
  pinned boolean default false,
  use_count int default 0,
  last_used_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  fts tsvector generated always as
    (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(body,'')))
    stored,
  unique (user_id, slug)
);
create index on memories using gin (fts);
create index on memories (user_id, state, pinned desc, last_used_at desc);

create table skills (
  id bigserial primary key,
  user_id text references users(user_id),
  slug text not null,
  body text not null,
  frontmatter jsonb not null,
  created_by text check (created_by in ('agent','user')) default 'agent',
  state text check (state in ('active','stale','archived')) default 'active',
  pinned boolean default false,
  use_count int default 0,
  view_count int default 0,
  patch_count int default 0,
  last_used_at timestamptz,
  last_viewed_at timestamptz,
  last_patched_at timestamptz,
  created_at timestamptz default now(),
  fts tsvector generated always as
    (to_tsvector('simple', coalesce(body,''))) stored,
  unique (user_id, slug)
);
create index on skills using gin (fts);

create table agent_config (
  key text primary key,
  value text not null,
  updated_at timestamptz default now()
);

create table curator_runs (
  id bigserial primary key,
  user_id text,
  phase text,
  started_at timestamptz default now(),
  finished_at timestamptz,
  archived_count int,
  staled_count int,
  consolidated_count int,
  report jsonb
);
