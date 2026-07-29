-- Ziolo — Supabase schema (v2: multi-user)
-- Run this once in your Supabase project's SQL editor (Project -> SQL Editor -> New query).
--
-- If you already ran the v1 schema and have no real data in it yet, easiest is
-- to drop the old tables first:
--   drop table if exists ratings;
--   drop table if exists strains;
-- then run everything below.

create extension if not exists "pgcrypto";

-- 1) Catalog of strains/products scraped from budcare.pl.
--    Shared: every signed-in user sees the same catalog.
create table if not exists strains (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,               -- budcare.pl url slug, e.g. "blood-orange-kush-canopy-growth-29"
  source_url text,
  name text not null,
  manufacturer text,
  genetics text,                            -- Indica / Sativa / Hybryda / Hybryda/Indica / Hybryda/Sativa
  thc_percent numeric,
  cbd_percent numeric,
  availability text,                        -- Wysoka / Niska / Brak / Wycofana
  packaging text,                           -- e.g. "5, 15g"
  aroma_tags text[],                        -- e.g. {Cytrusowy, Ziemisty}
  possible_effect text,                     -- Relaksujące / Pobudzające / Zrównoważone
  dominant_terpenes text[],                 -- e.g. {Mircen, Limonen}
  country_growth text,
  country_packaging text,
  parents text,                             -- e.g. "Lemon Kush x Guava Kush"
  description text,
  image_url text,
  added_by uuid references auth.users(id),  -- who added it, if manually added (null for scraped rows)
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- 2) Personal tracking data — one row per (strain, user). Each friend gets
--    their own private tested/tier/price/ratings for the same shared strain.
create table if not exists ratings (
  id uuid primary key default gen_random_uuid(),
  strain_id uuid references strains(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  tested boolean default false,
  tier text check (tier in ('reggie','mid','top')),
  price numeric,
  currency text default 'PLN',
  vendor text,
  rating_taste smallint check (rating_taste between 1 and 5),
  rating_smell smallint check (rating_smell between 1 and 5),
  rating_look smallint check (rating_look between 1 and 5),
  rating_power smallint check (rating_power between 1 and 5),
  rating_experience smallint check (rating_experience between 1 and 5),
  rating_allergic smallint check (rating_allergic between 1 and 3),
  rating_body_high smallint check (rating_body_high between 1 and 3),
  rating_head_high smallint check (rating_head_high between 1 and 3),
  rating_creativity smallint check (rating_creativity between 1 and 3),
  notes text,
  tested_at date,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (strain_id, user_id)
);

-- Keep updated_at fresh
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_strains_updated on strains;
create trigger trg_strains_updated before update on strains
for each row execute function set_updated_at();

drop trigger if exists trg_ratings_updated on ratings;
create trigger trg_ratings_updated before update on ratings
for each row execute function set_updated_at();

-- Row Level Security
alter table strains enable row level security;
alter table ratings enable row level security;

-- Strains: the scraped/shared catalog. Anyone signed in can read it, and can
-- add new strains (e.g. via the "+ Dodaj" button) — but not edit/delete
-- others' entries. If you'd rather each friend keep a totally separate
-- catalog instead of a shared one, add a `user_id` column here too and
-- restrict select/insert the same way as `ratings` below.
drop policy if exists "signed-in users can read strains" on strains;
create policy "signed-in users can read strains" on strains
  for select using (auth.role() = 'authenticated');

drop policy if exists "signed-in users can add strains" on strains;
create policy "signed-in users can add strains" on strains
  for insert with check (auth.role() = 'authenticated');

-- Ratings: strictly private per person.
drop policy if exists "users read own ratings" on ratings;
create policy "users read own ratings" on ratings
  for select using (auth.uid() = user_id);

drop policy if exists "users insert own ratings" on ratings;
create policy "users insert own ratings" on ratings
  for insert with check (auth.uid() = user_id);

drop policy if exists "users update own ratings" on ratings;
create policy "users update own ratings" on ratings
  for update using (auth.uid() = user_id);

drop policy if exists "users delete own ratings" on ratings;
create policy "users delete own ratings" on ratings
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- Migration for existing deployments: safe to re-run this whole file even on
-- a database that already has these tables — everything above uses
-- `if not exists` / `or replace` / `drop ... if exists` so it won't touch
-- your friends' existing accounts or ratings. This line specifically adds the
-- "reakcja alergiczna" (allergic reaction, 1-3) field if you deployed before
-- it existed:
alter table ratings add column if not exists rating_allergic smallint check (rating_allergic between 1 and 3);
alter table ratings add column if not exists rating_body_high smallint check (rating_body_high between 1 and 3);
alter table ratings add column if not exists rating_head_high smallint check (rating_head_high between 1 and 3);
alter table ratings add column if not exists rating_creativity smallint check (rating_creativity between 1 and 3);
