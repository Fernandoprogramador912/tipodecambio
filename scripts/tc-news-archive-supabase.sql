-- Tabla para archivo de noticias de alto impacto por día de rueda.
-- Ejecutar en Supabase SQL Editor una sola vez.

create table if not exists public.tc_day_news (
  session_date date primary key,
  items jsonb not null default '[]'::jsonb,
  item_count integer not null default 0,
  archived_at timestamptz not null default now()
);

create index if not exists tc_day_news_archived_idx
  on public.tc_day_news (archived_at desc);

alter table public.tc_day_news enable row level security;
