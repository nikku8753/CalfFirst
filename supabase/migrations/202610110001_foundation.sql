begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create type public.app_role as enum ('FARMER', 'VETERINARIAN', 'ADMIN');
create type public.farm_member_role as enum ('FARMER', 'VETERINARIAN');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 100),
  email text not null check (char_length(email) between 3 and 254),
  role public.app_role not null default 'FARMER',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.farms (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 2 and 150),
  location text not null check (char_length(btrim(location)) between 2 and 250),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.farm_members (
  id uuid primary key default gen_random_uuid(),
  farm_id uuid not null references public.farms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.farm_member_role not null,
  created_at timestamptz not null default now(),
  unique (farm_id, user_id)
);

create index profiles_role_idx on public.profiles(role);
create index farms_owner_id_idx on public.farms(owner_id);
create index farm_members_user_id_idx on public.farm_members(user_id);
-- The (farm_id, user_id) unique index already covers farm_id lookups.

create function private.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger profiles_touch_updated_at before update on public.profiles
for each row execute function private.touch_updated_at();
create trigger farms_touch_updated_at before update on public.farms
for each row execute function private.touch_updated_at();

-- Only this INSERT trigger consumes signup metadata. ADMIN or malformed roles
-- are downgraded to FARMER; later metadata changes never change authorization.
create function private.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  chosen_role public.app_role;
  chosen_name text;
begin
  chosen_role := case when new.raw_user_meta_data ->> 'role' = 'VETERINARIAN'
    then 'VETERINARIAN'::public.app_role else 'FARMER'::public.app_role end;
  chosen_name := btrim(coalesce(new.raw_user_meta_data ->> 'full_name', 'New member'));
  if char_length(chosen_name) not between 2 and 100 then
    raise exception 'Full name must contain 2 to 100 characters' using errcode = '23514';
  end if;
  insert into public.profiles(id, full_name, email, role)
  values (new.id, chosen_name, new.email, chosen_role);
  return new;
end;
$$;
create trigger calffirst_create_profile after insert on auth.users
for each row execute function private.create_profile();

-- Email is taken from Auth after a confirmed email change, never from profile input.
create function private.sync_profile_email() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;
create trigger calffirst_sync_profile_email after update of email on auth.users
for each row when (old.email is distinct from new.email)
execute function private.sync_profile_email();

-- Existing Auth users get a safe baseline. Existing metadata cannot grant ADMIN.
insert into public.profiles(id, full_name, email, role)
select id,
  case when char_length(btrim(coalesce(raw_user_meta_data ->> 'full_name', ''))) between 2 and 100
    then btrim(raw_user_meta_data ->> 'full_name') else 'New member' end,
  email,
  case when raw_user_meta_data ->> 'role' = 'VETERINARIAN'
    then 'VETERINARIAN'::public.app_role else 'FARMER'::public.app_role end
from auth.users where email is not null;

-- These helpers deliberately bypass RLS to avoid recursive policies. They use
-- auth.uid(), not caller-supplied user IDs or user-editable JWT metadata.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'ADMIN');
$$;
create function private.is_farmer() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = auth.uid() and role = 'FARMER');
$$;
create function private.owns_farm(target_farm uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.farms where id = target_farm and owner_id = auth.uid());
$$;
create function private.can_access_farm(target_farm uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select private.is_admin() or private.owns_farm(target_farm)
    or exists(select 1 from public.farm_members where farm_id = target_farm and user_id = auth.uid());
$$;
create function private.valid_member(target_user uuid, member_role public.farm_member_role) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists(select 1 from public.profiles where id = target_user and role::text = member_role::text);
$$;

alter table public.profiles enable row level security;
alter table public.farms enable row level security;
alter table public.farm_members enable row level security;

-- Explicit privileges matter: RLS does not by itself protect individual columns.
revoke all on public.profiles, public.farms, public.farm_members from public, anon, authenticated;
grant select on public.profiles to authenticated;
grant update (full_name) on public.profiles to authenticated;
grant select, insert, delete on public.farms to authenticated;
grant update (name, location) on public.farms to authenticated;
grant select, insert, delete on public.farm_members to authenticated;

create policy profiles_read on public.profiles for select to authenticated
using (id = (select auth.uid()) or (select private.is_admin()));
create policy profiles_update_name on public.profiles for update to authenticated
using (id = (select auth.uid())) with check (id = (select auth.uid()));
-- No browser INSERT or DELETE policy on profiles. Auth owns their lifecycle.

create policy farms_read on public.farms for select to authenticated
using (private.can_access_farm(id));
create policy farms_create on public.farms for insert to authenticated
with check ((owner_id = (select auth.uid()) and (select private.is_farmer())) or (select private.is_admin()));
create policy farms_update on public.farms for update to authenticated
using (private.owns_farm(id) or (select private.is_admin()))
with check (private.owns_farm(id) or (select private.is_admin()));
create policy farms_delete on public.farms for delete to authenticated
using (private.owns_farm(id) or (select private.is_admin()));

create policy farm_members_read on public.farm_members for select to authenticated
using (private.can_access_farm(farm_id));
create policy farm_members_create on public.farm_members for insert to authenticated
with check ((private.owns_farm(farm_id) or (select private.is_admin()))
  and private.valid_member(user_id, role));
create policy farm_members_delete on public.farm_members for delete to authenticated
using (private.owns_farm(farm_id) or (select private.is_admin()));
-- A member cannot join a farm, change membership, or mutate another farm.

-- Defense in depth if future migrations accidentally broaden column grants.
create function private.protect_profile_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and (
    new.id is distinct from old.id or new.role is distinct from old.role
    or new.email is distinct from old.email or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Profile identity and role are managed by trusted database operations' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger profiles_protect_identity before update on public.profiles
for each row execute function private.protect_profile_identity();

create function private.protect_farm_identity() returns trigger
language plpgsql set search_path = '' as $$
begin
  if current_user in ('anon', 'authenticated') and (
    new.id is distinct from old.id or new.owner_id is distinct from old.owner_id
    or new.created_at is distinct from old.created_at
  ) then
    raise exception 'Farm identity and ownership require trusted database operations' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger farms_protect_identity before update on public.farms
for each row execute function private.protect_farm_identity();

-- SQL-editor/DB-owner-only administrator provisioning. No public RPC exists.
create function private.provision_admin(target_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not exists(select 1 from auth.users where id = target_user and email_confirmed_at is not null) then
    raise exception 'A confirmed Auth user is required';
  end if;
  update public.profiles set role = 'ADMIN' where id = target_user;
  if not found then raise exception 'Profile not found'; end if;
end;
$$;

revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_admin(), private.is_farmer(), private.owns_farm(uuid),
  private.can_access_farm(uuid), private.valid_member(uuid, public.farm_member_role) to authenticated;
-- Do NOT grant provision_admin to authenticated or anon, or expose private schema.
commit;
