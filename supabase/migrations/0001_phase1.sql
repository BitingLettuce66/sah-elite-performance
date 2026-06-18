-- SAH Elite Performance — Phase 1 schema (identity + Row-Level Security).
-- Run ONCE in the Supabase SQL editor (Dashboard → SQL Editor → New query → paste → Run).
-- Safe to re-run. No secrets here. Tables mirror the local IndexedDB shapes so
-- Phase 2 (sync) can move records as-is. Every athlete sees ONLY their own rows.

-- 1) profiles — one row per authenticated user
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  role         text not null default 'athlete',  -- 'athlete' | 'coach' (coach arrives in Phase 3)
  display_name text,
  created_at   timestamptz not null default now()
);

-- auto-create a profile row when a user signs up
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2) logs — one row per (athlete, session); mirrors IndexedDB `logs`
create table if not exists public.logs (
  athlete_id          uuid not null references auth.users(id) on delete cascade,
  session_id          text not null,
  plan_id             text,
  done                boolean,
  rpe                 int,
  sleep               int,
  readiness           int,
  niggle              text,
  note                text,
  squat_kg            numeric,
  hip_thrust_kg       numeric,
  sprints             jsonb,
  prescribed_snapshot jsonb,
  date                text,
  updated_at          timestamptz not null default now(),
  deleted             boolean not null default false,
  primary key (athlete_id, session_id)
);

-- 3) settings — key/value per athlete (targets, assignment, bodyweight); mirrors IndexedDB `settings`
create table if not exists public.settings (
  athlete_id uuid not null references auth.users(id) on delete cascade,
  key        text not null,
  value      jsonb,
  updated_at timestamptz not null default now(),
  primary key (athlete_id, key)
);

-- 4) assignments — binds a plan template to an athlete with a start date
create table if not exists public.assignments (
  id           uuid primary key default gen_random_uuid(),
  athlete_id   uuid not null references auth.users(id) on delete cascade,
  template_id  text,
  start_date   date,
  plan_version int default 1,
  status       text default 'active',
  updated_at   timestamptz not null default now()
);

-- Row-Level Security — the multi-tenant boundary. ON for every table.
alter table public.profiles    enable row level security;
alter table public.logs        enable row level security;
alter table public.settings    enable row level security;
alter table public.assignments enable row level security;

drop policy if exists "own profile"     on public.profiles;
drop policy if exists "own logs"        on public.logs;
drop policy if exists "own settings"    on public.settings;
drop policy if exists "own assignments" on public.assignments;

create policy "own profile"     on public.profiles    for all using (id = auth.uid())         with check (id = auth.uid());
create policy "own logs"        on public.logs        for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "own settings"    on public.settings    for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
create policy "own assignments" on public.assignments for all using (athlete_id = auth.uid()) with check (athlete_id = auth.uid());
