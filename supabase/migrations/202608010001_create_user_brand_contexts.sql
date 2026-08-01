create table if not exists public.user_brand_contexts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users(id) on delete cascade,
  account_name text not null,
  instagram_handle text not null,
  answers jsonb not null,
  context jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.user_brand_contexts enable row level security;

create policy "Users can read their own brand context"
  on public.user_brand_contexts
  for select
  using (auth.uid() = user_id);

create policy "Users can insert their own brand context"
  on public.user_brand_contexts
  for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own brand context"
  on public.user_brand_contexts
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
