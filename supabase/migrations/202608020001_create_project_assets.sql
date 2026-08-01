create table if not exists public.project_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid not null,
  asset_id text not null,
  source_type text not null check (source_type in ('user_upload', 'instagram_reference')),
  storage_path text not null,
  original_filename text,
  mime_type text not null,
  description text,
  source_url text,
  source_post_url text,
  source_slide_index integer check (source_slide_index is null or source_slide_index >= 1),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, project_id, asset_id),
  unique (storage_path)
);

grant usage on schema public to authenticated;
grant select, insert, update, delete on table public.project_assets to authenticated;

alter table public.project_assets enable row level security;

drop policy if exists "Users can read their own project assets"
  on public.project_assets;
create policy "Users can read their own project assets"
  on public.project_assets for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert their own project assets"
  on public.project_assets;
create policy "Users can insert their own project assets"
  on public.project_assets for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update their own project assets"
  on public.project_assets;
create policy "Users can update their own project assets"
  on public.project_assets for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete their own project assets"
  on public.project_assets;
create policy "Users can delete their own project assets"
  on public.project_assets for delete
  using (auth.uid() = user_id);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'project-assets',
  'project-assets',
  false,
  20971520,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Users can read their own project asset objects"
  on storage.objects;
create policy "Users can read their own project asset objects"
  on storage.objects for select
  using (
    bucket_id = 'project-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can upload their own project asset objects"
  on storage.objects;
create policy "Users can upload their own project asset objects"
  on storage.objects for insert
  with check (
    bucket_id = 'project-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can update their own project asset objects"
  on storage.objects;
create policy "Users can update their own project asset objects"
  on storage.objects for update
  using (
    bucket_id = 'project-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'project-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "Users can delete their own project asset objects"
  on storage.objects;
create policy "Users can delete their own project asset objects"
  on storage.objects for delete
  using (
    bucket_id = 'project-assets'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
