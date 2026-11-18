-- Per-user profile holding the candidate's CV/resume, used to tailor mock
-- interviews. The uploaded file is extracted to plain text (by the coach
-- function) so it can be dropped cheaply into the interviewer's system prompt.
create table public.profiles (
  user_id     uuid primary key default auth.uid() references auth.users on delete cascade,
  cv_text     text,                       -- extracted plain text of the CV
  cv_name     text,                       -- original file name, shown in the UI
  updated_at  timestamptz not null default now()
);

alter table public.profiles enable row level security;

create policy "own profile" on public.profiles
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

alter publication supabase_realtime add table public.profiles;
