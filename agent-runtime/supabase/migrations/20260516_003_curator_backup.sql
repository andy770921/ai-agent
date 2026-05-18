create table curator_backups (
  id bigserial primary key,
  created_at timestamptz default now(),
  affected_table text check (affected_table in ('memories','skills')),
  snapshot jsonb not null,
  row_count int not null
);
create index on curator_backups (affected_table, created_at desc);

create function curator_backup_retain(keep int) returns void language sql security definer as $$
  delete from curator_backups where id in (
    select id from (
      select id, row_number() over (
        partition by affected_table order by created_at desc) as rn
      from curator_backups
    ) t where rn > keep
  );
$$;
