import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Real PostgreSQL engine, with minimal Supabase Auth fixtures. No Docker,
// external project, credentials, or persistent database is required.
const db = new PGlite();
const owner = '00000000-0000-4000-8000-000000000001';
const stranger = '00000000-0000-4000-8000-000000000002';
const vet = '00000000-0000-4000-8000-000000000003';
const admin = '00000000-0000-4000-8000-000000000004';
const farm = '00000000-0000-4000-8000-000000000010';

async function asUser(id, sql) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub = '${id}';`);
  try { return await db.query(sql); }
  finally { await db.exec('reset role; reset request.jwt.claim.sub;'); }
}

before(async () => {
  await db.exec(`
    create role anon nologin;
    create role authenticated nologin;
    create schema auth;
    create table auth.users (
      id uuid primary key, email text not null,
      raw_user_meta_data jsonb not null default '{}', email_confirmed_at timestamptz
    );
    create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202610110001_foundation.sql', import.meta.url), 'utf8'));
  for (const [id, role, name] of [[owner, 'FARMER', 'Owner'], [stranger, 'FARMER', 'Stranger'], [vet, 'VETERINARIAN', 'Veterinarian'], [admin, 'ADMIN', 'Admin candidate']]) {
    await db.query('insert into auth.users(id, email, raw_user_meta_data, email_confirmed_at) values ($1, $2, $3, now())', [id, `${id}@example.test`, JSON.stringify({ full_name: name, role })]);
  }
  await asUser(owner, `insert into public.farms(id, name, location, owner_id) values ('${farm}', 'Green Meadow', 'Pune', '${owner}')`);
});
after(async () => { await db.close(); });

test('signup creates profiles but ADMIN metadata never grants elevated privileges', async () => {
  assert.equal((await db.query(`select role from public.profiles where id='${admin}'`)).rows[0].role, 'FARMER');
  assert.equal((await db.query(`select role from public.profiles where id='${vet}'`)).rows[0].role, 'VETERINARIAN');
  await db.query(`update auth.users set raw_user_meta_data='{"role":"ADMIN"}' where id='${owner}'`);
  assert.equal((await db.query(`select role from public.profiles where id='${owner}'`)).rows[0].role, 'FARMER');
});

test('profile reads are isolated and only the own full name can be updated', async () => {
  assert.equal((await asUser(owner, 'select * from public.profiles')).rows.length, 1);
  await asUser(owner, `update public.profiles set full_name='Updated owner' where id='${owner}'`);
  assert.equal((await db.query(`select full_name from public.profiles where id='${owner}'`)).rows[0].full_name, 'Updated owner');
  assert.equal((await asUser(stranger, `update public.profiles set full_name='Tampered' where id='${owner}' returning id`)).rows.length, 0);
  for (const clause of ["role='ADMIN'", "email='forged@example.test'", `id='${stranger}'`, "created_at='2000-01-01'"]) {
    await assert.rejects(asUser(owner, `update public.profiles set ${clause} where id='${owner}'`));
  }
  await assert.rejects(asUser(owner, `insert into public.profiles(id,full_name,email,role) values ('${stranger}', 'Forged', 'x@example.test', 'ADMIN')`));
  await assert.rejects(asUser(owner, `delete from public.profiles where id='${owner}'`));
});

test('anonymous users cannot access any foundation table', async () => {
  await db.exec('set role anon;');
  try {
    for (const table of ['profiles', 'farms', 'farm_members']) await assert.rejects(db.query(`select * from public.${table}`));
  } finally { await db.exec('reset role;'); }
});

test('farms enforce farmer ownership, tenant isolation and immutable ownership', async () => {
  assert.equal((await asUser(owner, 'select * from public.farms')).rows.length, 1);
  assert.equal((await asUser(stranger, 'select * from public.farms')).rows.length, 0);
  await assert.rejects(asUser(stranger, `insert into public.farms(name,location,owner_id) values ('Spoof','Pune','${owner}')`));
  await assert.rejects(asUser(vet, `insert into public.farms(name,location,owner_id) values ('Vet farm','Pune','${vet}')`));
  await assert.rejects(asUser(owner, `update public.farms set owner_id='${stranger}' where id='${farm}'`));
  assert.equal((await asUser(stranger, `update public.farms set name='Tampered' where id='${farm}' returning id`)).rows.length, 0);
  assert.equal((await asUser(stranger, `delete from public.farms where id='${farm}' returning id`)).rows.length, 0);
});

test('membership must be assigned by owner and match the trusted profile role', async () => {
  await assert.rejects(asUser(vet, `insert into public.farm_members(farm_id,user_id,role) values ('${farm}','${vet}','VETERINARIAN')`));
  await assert.rejects(asUser(owner, `insert into public.farm_members(farm_id,user_id,role) values ('${farm}','${stranger}','VETERINARIAN')`));
  await asUser(owner, `insert into public.farm_members(farm_id,user_id,role) values ('${farm}','${vet}','VETERINARIAN')`);
  assert.equal((await asUser(vet, 'select * from public.farms')).rows.length, 1);
  assert.equal((await asUser(vet, 'select * from public.farm_members')).rows.length, 1);
  assert.equal((await asUser(stranger, 'select * from public.farm_members')).rows.length, 0);
  await assert.rejects(asUser(owner, `insert into public.farm_members(farm_id,user_id,role) values ('${farm}','${vet}','VETERINARIAN')`));
  assert.equal((await asUser(vet, `update public.farms set name='Tampered' where id='${farm}' returning id`)).rows.length, 0);
  await assert.rejects(asUser(vet, `update public.farm_members set role='FARMER' where user_id='${vet}'`));
  assert.equal((await asUser(vet, `delete from public.farm_members where user_id='${vet}' returning id`)).rows.length, 0);
  await asUser(owner, `delete from public.farm_members where user_id='${vet}'`);
  assert.equal((await asUser(vet, 'select * from public.farms')).rows.length, 0);
});

test('trusted provisioning is inaccessible to authenticated users, including admins', async () => {
  await assert.rejects(asUser(owner, `select private.provision_admin('${owner}')`));
  await db.query(`select private.provision_admin('${admin}')`);
  assert.equal((await asUser(admin, 'select * from public.profiles')).rows.length, 4);
  assert.equal((await asUser(admin, 'select * from public.farms')).rows.length, 1);
  await assert.rejects(asUser(admin, `select private.provision_admin('${owner}')`));
  await assert.rejects(asUser(admin, `update public.profiles set role='ADMIN' where id='${owner}'`));
});

test('Auth email changes sync the profile; metadata changes cannot overwrite name or role', async () => {
  await db.query(`update auth.users set email='updated@example.test', raw_user_meta_data='{"role":"ADMIN","full_name":"Spoofed"}' where id='${owner}'`);
  const profile = (await db.query(`select * from public.profiles where id='${owner}'`)).rows[0];
  assert.equal(profile.email, 'updated@example.test');
  assert.equal(profile.role, 'FARMER');
  assert.equal(profile.full_name, 'Updated owner');
});

test('identity guard still denies escalation if a future migration broadens update grants', async () => {
  await db.exec('grant update on public.profiles, public.farms to authenticated;');
  try {
    await assert.rejects(asUser(owner, `update public.profiles set role='ADMIN' where id='${owner}'`), /trusted database operations/);
    await assert.rejects(asUser(owner, `update public.farms set owner_id='${stranger}' where id='${farm}'`), /trusted database operations/);
  } finally {
    await db.exec('revoke update on public.profiles, public.farms from authenticated; grant update(full_name) on public.profiles to authenticated; grant update(name,location) on public.farms to authenticated;');
  }
});
