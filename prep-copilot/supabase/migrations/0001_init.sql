-- Study items: a screenshot or typed question captured on the laptop or phone,
-- plus the AI explanation. Synced to every signed-in device via Realtime.
create table public.items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  source      text not null check (source in ('desktop', 'mobile')),
  prompt      text,
  image_path  text,                       -- path inside the "captures" storage bucket
  answer      text,
  status      text not null default 'pending' check (status in ('pending', 'done', 'error')),
  created_at  timestamptz not null default now()
);

-- Mock interview sessions: the whole transcript lives in one jsonb array of
-- { role: 'user' | 'assistant', content: string }.
create table public.mock_sessions (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users on delete cascade,
  role_title  text not null,              -- e.g. "Virtual Assistant", "Frontend Engineer"
  messages    jsonb not null default '[]'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.items enable row level security;
alter table public.mock_sessions enable row level security;

create policy "own items" on public.items
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "own mock sessions" on public.mock_sessions
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table public.items, public.mock_sessions;

-- Private bucket; each user writes under a folder named after their user id.
insert into storage.buckets (id, name, public) values ('captures', 'captures', false);

create policy "own captures read" on storage.objects for select
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own captures write" on storage.objects for insert
  with check (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "own captures delete" on storage.objects for delete
  using (bucket_id = 'captures' and (storage.foldername(name))[1] = auth.uid()::text);
