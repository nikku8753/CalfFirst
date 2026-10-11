import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Actual migration SQL and PostgreSQL RLS in PGlite. Auth/Storage service tables
// are fixtures; no hosted Auth, Storage HTTP server, or end-to-end project test.
const db = new PGlite();
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const vet = '10000000-0000-4000-8000-000000000003';
const admin = '10000000-0000-4000-8000-000000000004';
const farmA = '20000000-0000-4000-8000-000000000001';
const farmB = '20000000-0000-4000-8000-000000000002';
const mother = '30000000-0000-4000-8000-000000000001';
const father = '30000000-0000-4000-8000-000000000002';
const calf = '30000000-0000-4000-8000-000000000003';
const other = '30000000-0000-4000-8000-000000000004';
const photo = `${farmA}/${calf}/40000000-0000-4000-8000-000000000001.jpg`;
const otherPhoto = `${farmB}/${other}/40000000-0000-4000-8000-000000000002.png`;

async function user(id, sql) {
  await db.exec(`set role authenticated; set request.jwt.claim.sub='${id}';`);
  try { return await db.query(sql); } finally { await db.exec('reset role; reset request.jwt.claim.sub;'); }
}
function insert(id, farm, identifier, sex = 'FEMALE', birth = '2020-01-01', extra = '') {
  return `insert into public.animals(id,farm_id,animal_identifier,name,species,breed,sex,date_of_birth,category${extra ? ',mother_id,father_id' : ''}) values ('${id}','${farm}','${identifier}','Animal ${identifier}','CATTLE','Gir','${sex}','${birth}','${birth === '2025-01-01' ? 'CALF' : 'ADULT'}'${extra ? ',' + extra : ''})`;
}
before(async () => {
  await db.exec(`create role anon nologin; create role authenticated nologin;
    create schema auth; create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}',email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to authenticated,anon; grant execute on function auth.uid() to authenticated,anon;
    create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text, unique(bucket_id,name));
    alter table storage.objects enable row level security;
    grant usage on schema storage to authenticated,anon; grant select,insert,update,delete on storage.objects to authenticated;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/202610110001_foundation.sql', import.meta.url), 'utf8'));
  for (const [id, role] of [[a,'FARMER'],[b,'FARMER'],[vet,'VETERINARIAN'],[admin,'FARMER']]) await db.query('insert into auth.users(id,email,raw_user_meta_data,email_confirmed_at) values($1,$2,$3,now())', [id, `${id}@example.test`, JSON.stringify({ full_name: `User ${role}`, role })]);
  await user(a, `insert into public.farms(id,name,location,owner_id) values('${farmA}','Farm A','Pune','${a}')`);
  await user(b, `insert into public.farms(id,name,location,owner_id) values('${farmB}','Farm B','Satara','${b}')`);
  await db.exec(await readFile(new URL('../supabase/migrations/202610110002_farm_animals.sql', import.meta.url), 'utf8'));
  await db.query(`select private.provision_admin('${admin}')`);
  await user(a, `insert into public.farm_members(farm_id,user_id,role) values('${farmA}','${vet}','VETERINARIAN')`);
  await user(a, insert(mother,farmA,'MOTHER'));
  await user(a, insert(father,farmA,'FATHER','MALE','2019-01-01'));
  await user(a, insert(calf,farmA,'CALF','FEMALE','2025-01-01',`'${mother}','${father}'`));
  await user(b, insert(other,farmB,'CALF'));
});
after(async () => db.close());

test('Phase 3 preserves pre-existing profiles, farms, membership and admin provisioning', async () => {
  assert.equal((await db.query('select * from public.profiles')).rows.length,4);
  assert.equal((await db.query('select * from public.farms')).rows.length,2);
  assert.equal((await user(vet,'select * from public.farms')).rows.length,1);
  await assert.rejects(user(a, `select private.provision_admin('${a}')`));
});
test('farm save is atomic and contact data is owner/admin-only', async () => {
  await user(a, `select public.save_farm('${farmA}','Farm A updated','Pune','Responsible farming','owner@example.test')`);
  assert.equal((await user(a,'select * from public.farm_contacts')).rows.length,1);
  assert.equal((await user(vet,'select * from public.farm_contacts')).rows.length,0);
  assert.equal((await user(b,'select * from public.farm_contacts')).rows.length,0);
  assert.equal((await user(admin,'select * from public.farm_contacts')).rows.length,1);
  await assert.rejects(user(a,`select public.save_farm('${farmA}','Should roll back','Pune','',repeat('x',501))`));
  assert.equal((await user(a,`select name from public.farms where id='${farmA}'`)).rows[0].name,'Farm A updated');
  await assert.rejects(user(vet,`select public.save_farm('${farmA}','Tampered','Pune','','')`));
  await assert.rejects(user(b,`select public.save_farm('${farmA}','Tampered','Pune','','')`));
});
test('farm people lists assigned names without widening global profiles or contact access', async () => {
  const people = (await user(vet,`select * from public.farm_people('${farmA}')`)).rows;
  assert.equal(people.length,2); assert.ok(people.some(p=>p.is_owner));
  assert.equal('email' in people[0],false); assert.equal('contact_information' in people[0],false);
  assert.equal((await user(vet,'select * from public.profiles')).rows.length,1);
  await assert.rejects(user(vet,`select * from public.farm_people('${farmB}')`));
});
test('animal IDs are unique per farm but can be reused in another farm', async () => {
  await assert.rejects(user(a, insert('30000000-0000-4000-8000-000000000011',farmA,'CALF')),/duplicate key/);
  assert.equal((await user(b,`select animal_identifier from public.animals where id='${other}'`)).rows[0].animal_identifier,'CALF');
});
test('unrelated users cannot read, register, edit, or delete another farm’s animals', async () => {
  assert.equal((await user(b,`select * from public.animals where farm_id='${farmA}'`)).rows.length,0);
  await assert.rejects(user(b,insert('30000000-0000-4000-8000-000000000012',farmA,'FORGED')));
  assert.equal((await user(b,`update public.animals set name='Tampered' where id='${calf}' returning id`)).rows.length,0);
  assert.equal((await user(b,`delete from public.animals where id='${calf}' returning id`)).rows.length,0);
});
test('assigned veterinarians can read but cannot register, edit, or delete animals', async () => {
  assert.equal((await user(vet,'select * from public.animals')).rows.length,3);
  await assert.rejects(user(vet,insert('30000000-0000-4000-8000-000000000013',farmA,'VET')));
  assert.equal((await user(vet,`update public.animals set notes='Tampered' where id='${calf}' returning id`)).rows.length,0);
  assert.equal((await user(vet,`delete from public.animals where id='${calf}' returning id`)).rows.length,0);
});
test('a farmer membership grants reads but does not confer farm-owner write privileges', async () => {
  await user(a,`insert into public.farm_members(farm_id,user_id,role) values('${farmA}','${b}','FARMER')`);
  assert.equal((await user(b,`select * from public.animals where farm_id='${farmA}'`)).rows.length,3);
  assert.equal((await user(b,`update public.animals set name='Tampered' where id='${calf}' returning id`)).rows.length,0);
  assert.equal((await user(b,`select * from public.farm_contacts where farm_id='${farmA}'`)).rows.length,0);
  await user(a,`delete from public.farm_members where user_id='${b}'`);
});
test('birth dates, species, categories and identifier constraints are enforced in SQL', async () => {
  await assert.rejects(user(a,`update public.animals set date_of_birth=current_date+1 where id='${calf}'`),/Birth date/);
  await assert.rejects(user(a,`update public.animals set date_of_birth='1899-01-01' where id='${calf}'`));
  await assert.rejects(user(a,`update public.animals set species='GOAT' where id='${calf}'`));
  await assert.rejects(user(a,`update public.animals set category='HEIFER',sex='MALE',mother_id=null,father_id=null where id='${calf}'`));
  await assert.rejects(user(a,`update public.animals set animal_identifier='invalid id' where id='${calf}'`));
});
test('parent relationships reject cross-farm, self, wrong-sex, same-parent and age-invalid references', async () => {
  for (const expression of [`mother_id='${other}'`,`mother_id='${calf}'`,`mother_id='${father}'`,`father_id='${mother}'`,`mother_id='${mother}',father_id='${mother}'`,`mother_id='${calf}'`]) await assert.rejects(user(a,`update public.animals set ${expression} where id='${calf}'`));
  await assert.rejects(user(a,`update public.animals set mother_id='${calf}' where id='${mother}'`));
});
test('editing a parent cannot invalidate existing children or create ancestry cycles', async () => {
  await assert.rejects(user(a,`update public.animals set sex='MALE' where id='${mother}'`),/offspring relationship/);
  await assert.rejects(user(a,`update public.animals set species='BUFFALO' where id='${mother}'`),/offspring relationship/);
  await assert.rejects(user(a,`update public.animals set date_of_birth='2025-01-01' where id='${mother}'`),/offspring relationship/);
  await assert.rejects(user(a,`update public.animals set mother_id='${calf}' where id='${mother}'`));
});
test('animal farm/identity are immutable even if both target farms are authorized', async () => {
  await assert.rejects(user(admin,`update public.animals set farm_id='${farmB}' where id='${calf}'`));
  await db.exec('grant update(farm_id) on public.animals to authenticated;');
  try { await assert.rejects(user(admin,`update public.animals set farm_id='${farmB}' where id='${calf}'`),/identity and farm/); }
  finally { await db.exec('revoke update(farm_id) on public.animals from authenticated;'); }
});
test('trusted admin can manage authorized records through the established profile-based model', async () => {
  assert.equal((await user(admin,'select * from public.animals')).rows.length,4);
  await user(admin,`update public.animals set notes='Administrator-reviewed' where id='${other}'`);
  assert.equal((await user(b,`select notes from public.animals where id='${other}'`)).rows[0].notes,'Administrator-reviewed');
});
test('referenced parent animals and farms with animals cannot be deleted accidentally', async () => {
  await assert.rejects(user(a,`delete from public.animals where id='${mother}'`),/foreign key/);
  await assert.rejects(user(a,`delete from public.farms where id='${farmA}'`),/foreign key/);
});
test('private photo bucket has MIME and 5 MB restrictions', async () => {
  const bucket = (await db.query("select * from storage.buckets where id='animal-photos'")).rows[0];
  assert.equal(bucket.public,false); assert.equal(Number(bucket.file_size_limit),5242880);
  assert.deepEqual(bucket.allowed_mime_types,['image/jpeg','image/png','image/webp']);
});
test('photo upload requires an owned animal path and cannot target another farm or arbitrary files', async () => {
  await assert.rejects(user(b,`insert into storage.objects(bucket_id,name) values('animal-photos','${photo}')`));
  await assert.rejects(user(vet,`insert into storage.objects(bucket_id,name) values('animal-photos','${photo}')`));
  await assert.rejects(user(a,"insert into storage.objects(bucket_id,name) values('animal-photos','not-a-farm/file.svg')"));
  await assert.rejects(user(a,`insert into storage.objects(bucket_id,name) values('animal-photos','${farmA}/99999999-0000-4000-8000-000000000000/40000000-0000-4000-8000-000000000000.jpg')`));
  await user(a,`insert into storage.objects(bucket_id,name) values('animal-photos','${photo}')`);
  await user(b,`insert into storage.objects(bucket_id,name) values('animal-photos','${otherPhoto}')`);
});
test('photo attachment cannot point to a different animal, farm, or missing object', async () => {
  await assert.rejects(user(a,`update public.animals set photo_path='${otherPhoto}' where id='${calf}'`),/Photo path/);
  await assert.rejects(user(a,`update public.animals set photo_path='${farmA}/${calf}/40000000-0000-4000-8000-000000000099.jpg' where id='${calf}'`),/Upload the photo/);
  await user(a,`update public.animals set photo_path='${photo}' where id='${calf}'`);
  await user(b,`update public.animals set photo_path='${otherPhoto}' where id='${other}'`);
});
test('private photo RLS allows owner and assigned vet, denies unrelated reads and destructive vet writes', async () => {
  assert.equal((await user(vet,'select * from storage.objects')).rows.length,1);
  assert.equal((await user(b,`select * from storage.objects where name='${photo}'`)).rows.length,0);
  assert.equal((await user(vet,`delete from storage.objects where name='${photo}' returning id`)).rows.length,0);
  assert.equal((await user(a,`delete from storage.objects where name='${photo}' returning id`)).rows.length,0);
  assert.equal((await user(a,`update storage.objects set name='overwritten' where name='${photo}' returning id`)).rows.length,0);
  await user(a,`update public.animals set photo_path=null where id='${calf}'`);
  assert.equal((await user(vet,`select * from storage.objects where name='${photo}'`)).rows.length,0);
  assert.equal((await user(a,`delete from storage.objects where name='${photo}' returning id`)).rows.length,1);
});
test('anonymous users cannot access animals, private contacts or farm RPCs', async () => {
  await db.exec('set role anon;');
  try {
    for (const table of ['animals','farm_contacts']) await assert.rejects(db.query(`select * from public.${table}`));
    await assert.rejects(db.query(`select * from public.farm_people('${farmA}')`));
    await assert.rejects(db.query("select public.save_farm(null,'Forged','Pune',null,null)"));
  } finally { await db.exec('reset role;'); }
});
test('membership removal immediately revokes animal and private photo reads', async () => {
  await user(a,`delete from public.farm_members where user_id='${vet}'`);
  assert.equal((await user(vet,'select * from public.animals')).rows.length,0);
  assert.equal((await user(vet,'select * from storage.objects')).rows.length,0);
});
