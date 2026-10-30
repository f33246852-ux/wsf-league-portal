create table if not exists public.claim_tickets (
  id uuid primary key,
  submitted_at timestamptz not null default now(),
  discord_id text not null,
  discord_username text not null,
  item text not null,
  message_link text not null,
  player_id text not null,
  submitted_username text not null,
  win_location text not null check (win_location in ('Inside WSF', 'Outside WSF')),
  message text not null default '',
  status text not null default 'pending'
);

-- Existing installs: allow multiple claims to reference the same Discord post.
alter table public.claim_tickets drop constraint if exists claim_tickets_message_link_key;

alter table public.claim_tickets enable row level security;
revoke all on public.claim_tickets from anon, authenticated;
grant usage on schema public to service_role;
grant all on public.claim_tickets to service_role;

alter table public.claim_tickets add column if not exists updated_at timestamptz not null default now();
alter table public.claim_tickets add column if not exists reviewed_at timestamptz;
alter table public.claim_tickets add column if not exists reviewed_by text;
alter table public.claim_tickets add column if not exists staff_note text not null default '';

create table if not exists public.support_tickets (
  id uuid primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  discord_id text not null,
  discord_username text not null,
  subject text not null,
  category text not null check (category in ('Account', 'League question', 'Technical issue', 'Other')),
  message text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  staff_reply text not null default ''
);

create table if not exists public.staff_access (
  discord_id text primary key,
  discord_username text not null,
  added_by text not null,
  created_at timestamptz not null default now()
);

alter table public.support_tickets enable row level security;
alter table public.staff_access enable row level security;
revoke all on public.support_tickets, public.staff_access from anon, authenticated;
grant all on public.support_tickets, public.staff_access to service_role;
