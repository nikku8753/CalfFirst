begin;

alter table public.farms add column description text
  check (description is null or char_length(description) <= 2000);
grant update(description) on public.farms to authenticated;

-- Separate row-level permissions keep contacts private even from assigned vets.
create table public.farm_contacts (
  farm_id uuid primary key references public.farms(id) on delete cascade,
  contact_information text not null check (char_length(btrim(contact_information)) between 1 and 500)
);
alter table public.farm_contacts enable row level security;
revoke all on public.farm_contacts from public, anon, authenticated;
grant select, insert, delete on public.farm_contacts to authenticated;
grant update(contact_information) on public.farm_contacts to authenticated;

create function private.can_manage_farm(target_farm uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin() or (private.is_farmer() and private.owns_farm(target_farm));
$$;
revoke all on function private.can_manage_farm(uuid) from public, anon, authenticated;
grant execute on function private.can_manage_farm(uuid) to authenticated;

drop policy farms_update on public.farms;
create policy farms_update on public.farms for update to authenticated
using (private.can_manage_farm(id)) with check (private.can_manage_farm(id));
drop policy farms_delete on public.farms;
create policy farms_delete on public.farms for delete to authenticated
using (private.can_manage_farm(id));

create policy farm_contacts_read on public.farm_contacts for select to authenticated
using (private.can_manage_farm(farm_id));
create policy farm_contacts_insert on public.farm_contacts for insert to authenticated
with check (private.can_manage_farm(farm_id));
create policy farm_contacts_update on public.farm_contacts for update to authenticated
using (private.can_manage_farm(farm_id)) with check (private.can_manage_farm(farm_id));
create policy farm_contacts_delete on public.farm_contacts for delete to authenticated
using (private.can_manage_farm(farm_id));

-- Atomic form save, with the caller's normal RLS/column permissions throughout.
create function public.save_farm(p_id uuid, p_name text, p_location text,
  p_description text, p_contact_information text) returns uuid
language plpgsql security invoker set search_path = '' as $$
declare saved_id uuid;
begin
  if p_id is null then
    insert into public.farms(name, location, description, owner_id)
    values (btrim(p_name), btrim(p_location), nullif(btrim(p_description), ''), auth.uid())
    returning id into saved_id;
  else
    update public.farms set name = btrim(p_name), location = btrim(p_location),
      description = nullif(btrim(p_description), '') where id = p_id returning id into saved_id;
    if saved_id is null then raise exception 'Farm unavailable or not authorized' using errcode = '42501'; end if;
  end if;
  if nullif(btrim(p_contact_information), '') is null then
    delete from public.farm_contacts where farm_id = saved_id;
  else
    insert into public.farm_contacts(farm_id, contact_information)
    values (saved_id, btrim(p_contact_information)) on conflict(farm_id)
    do update set contact_information = excluded.contact_information;
  end if;
  return saved_id;
end;
$$;
revoke all on function public.save_farm(uuid,text,text,text,text) from public, anon;
grant execute on function public.save_farm(uuid,text,text,text,text) to authenticated;

-- A narrowly scoped directory: no email/contact fields and no global profiles access.
create function public.farm_people(target_farm uuid)
returns table(user_id uuid, full_name text, role text, is_owner boolean, joined_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not private.can_access_farm(target_farm) then
    raise exception 'Farm unavailable or not authorized' using errcode = '42501';
  end if;
  return query
    select p.id, p.full_name, p.role::text, true, f.created_at
    from public.farms f join public.profiles p on p.id = f.owner_id where f.id = target_farm
    union all
    select p.id, p.full_name, m.role::text, false, m.created_at
    from public.farm_members m join public.profiles p on p.id = m.user_id
    join public.farms f on f.id = m.farm_id
    where m.farm_id = target_farm and m.user_id <> f.owner_id;
end;
$$;
revoke all on function public.farm_people(uuid) from public, anon;
grant execute on function public.farm_people(uuid) to authenticated;

create table public.animals (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete restrict,
  animal_identifier text not null check (animal_identifier ~ '^[A-Z0-9][A-Z0-9_-]{0,39}$'),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  species text not null check (species in ('CATTLE', 'BUFFALO')),
  breed text not null check (char_length(btrim(breed)) between 1 and 100),
  sex text not null check (sex in ('FEMALE', 'MALE')),
  date_of_birth date not null,
  mother_id uuid,
  father_id uuid,
  category text not null check (category in ('CALF', 'HEIFER', 'ADULT')),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'TRANSFERRED', 'DECEASED')),
  photo_path text,
  notes text check (notes is null or char_length(notes) <= 5000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(farm_id, animal_identifier),
  unique(farm_id, id),
  foreign key (farm_id, mother_id) references public.animals(farm_id, id) on delete restrict,
  foreign key (farm_id, father_id) references public.animals(farm_id, id) on delete restrict,
  check (mother_id is null or mother_id <> id),
  check (father_id is null or father_id <> id),
  check (mother_id is null or father_id is null or mother_id <> father_id),
  check (category <> 'HEIFER' or sex = 'FEMALE')
);
create index animals_farm_status_idx on public.animals(farm_id, status);
create index animals_farm_category_idx on public.animals(farm_id, category);
create index animals_farm_created_idx on public.animals(farm_id, created_at desc);
create index animals_mother_idx on public.animals(mother_id) where mother_id is not null;
create index animals_father_idx on public.animals(father_id) where father_id is not null;

create function private.protect_animal_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.id is distinct from old.id or new.farm_id is distinct from old.farm_id
    or new.created_at is distinct from old.created_at then
    raise exception 'Animal identity and farm cannot be changed; transfers need a future trusted workflow' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger animals_protect_identity before update on public.animals
for each row execute function private.protect_animal_identity();

create function private.validate_animal() returns trigger
language plpgsql security definer set search_path = '' as $$
declare parent public.animals;
begin
  -- Serialize relationships within a farm, including concurrent edits to parents.
  perform 1 from public.farms where id = new.farm_id for update;
  if new.date_of_birth > current_date or new.date_of_birth < date '1900-01-01' then
    raise exception 'Birth date must be between 1900-01-01 and today' using errcode = '23514';
  end if;
  if new.mother_id is not null then
    select * into parent from public.animals where id = new.mother_id and farm_id = new.farm_id;
    if not found or parent.sex <> 'FEMALE' or parent.species <> new.species
      or parent.date_of_birth >= new.date_of_birth or parent.id = new.id then
      raise exception 'Mother must be an older female of the same species in the same farm' using errcode = '23514';
    end if;
  end if;
  if new.father_id is not null then
    select * into parent from public.animals where id = new.father_id and farm_id = new.farm_id;
    if not found or parent.sex <> 'MALE' or parent.species <> new.species
      or parent.date_of_birth >= new.date_of_birth or parent.id = new.id then
      raise exception 'Father must be an older male of the same species in the same farm' using errcode = '23514';
    end if;
  end if;
  -- Parent edits must preserve relationships already recorded for their children.
  if exists(select 1 from public.animals c where c.farm_id = new.farm_id and (
    (c.mother_id = new.id and (new.sex <> 'FEMALE' or new.species <> c.species or new.date_of_birth >= c.date_of_birth))
    or (c.father_id = new.id and (new.sex <> 'MALE' or new.species <> c.species or new.date_of_birth >= c.date_of_birth))
  )) then
    raise exception 'This change would invalidate an existing offspring relationship' using errcode = '23514';
  end if;
  -- Older-parent ordering also makes ancestry cycles impossible.
  if new.photo_path is not null then
    if new.photo_path !~ ('^' || new.farm_id::text || '/' || new.id::text || '/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$') then
      raise exception 'Photo path must belong to this farm and animal' using errcode = '23514';
    end if;
    if not exists(select 1 from storage.objects where bucket_id = 'animal-photos' and name = new.photo_path) then
      raise exception 'Upload the photo before attaching it to an animal' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger animals_validate before insert or update on public.animals
for each row execute function private.validate_animal();
create trigger animals_touch_updated_at before update on public.animals
for each row execute function private.touch_updated_at();

alter table public.animals enable row level security;
revoke all on public.animals from public, anon, authenticated;
grant select, insert, delete on public.animals to authenticated;
grant update(animal_identifier, name, species, breed, sex, date_of_birth, mother_id,
  father_id, category, status, photo_path, notes) on public.animals to authenticated;
create policy animals_read on public.animals for select to authenticated
using (private.can_access_farm(farm_id));
create policy animals_create on public.animals for insert to authenticated
with check (private.can_manage_farm(farm_id));
create policy animals_update on public.animals for update to authenticated
using (private.can_manage_farm(farm_id)) with check (private.can_manage_farm(farm_id));
create policy animals_delete on public.animals for delete to authenticated
using (private.can_manage_farm(farm_id));

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('animal-photos', 'animal-photos', false, 5242880, array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- Reject malformed paths without unsafe UUID casts in policies.
create function private.photo_farm(path text) returns uuid
language sql immutable set search_path = '' as $$
  select case when path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f-]{36}\.(jpg|jpeg|png|webp)$'
    then split_part(path, '/', 1)::uuid else null end;
$$;
create function private.can_read_photo(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_manage_farm(private.photo_farm(path)) or exists(
    select 1 from public.animals a where a.photo_path = path and private.can_access_farm(a.farm_id));
$$;
create function private.can_upload_photo(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_manage_farm(private.photo_farm(path)) and exists(
    select 1 from public.animals a where a.farm_id = private.photo_farm(path)
    and a.id::text = split_part(path, '/', 2));
$$;
create function private.can_delete_photo(path text) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.can_manage_farm(private.photo_farm(path))
    and not exists(select 1 from public.animals where photo_path = path);
$$;
revoke all on function private.protect_animal_identity(), private.validate_animal(),
  private.photo_farm(text), private.can_read_photo(text), private.can_upload_photo(text),
  private.can_delete_photo(text) from public, anon, authenticated;
grant execute on function private.can_read_photo(text), private.can_upload_photo(text),
  private.can_delete_photo(text) to authenticated;

-- No UPDATE/upsert permission: replacements use a new object name.
create policy calffirst_photos_read on storage.objects for select to authenticated
using (bucket_id = 'animal-photos' and private.can_read_photo(name));
create policy calffirst_photos_upload on storage.objects for insert to authenticated
with check (bucket_id = 'animal-photos' and private.can_upload_photo(name));
create policy calffirst_photos_delete on storage.objects for delete to authenticated
using (bucket_id = 'animal-photos' and private.can_delete_photo(name));

commit;
