create table if not exists public.claim_tickets (
  id uuid primary key,
  submitted_at timestamptz not null default now(),
  discord_id text not null,
  discord_username text not null,
  item text not null,
  message_link text not null unique,
  player_id text not null,
  submitted_username text not null,
  win_location text not null check (win_location in ('Inside WSF', 'Outside WSF')),
  message text not null default '',
  status text not null default 'pending'
);

alter table public.claim_tickets enable row level security;
revoke all on public.claim_tickets from anon, authenticated;
grant usage on schema public to service_role;
grant all on public.claim_tickets to service_role;
