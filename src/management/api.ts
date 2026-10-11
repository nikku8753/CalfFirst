import { setupMessage, supabase } from '../lib/supabase';
import type { Profile } from '../auth/AuthProvider';
import type { Animal, AnimalDraft, AnimalQuery, Farm, FarmDraft, FarmPerson, ParentOption, Summary } from './models';
import { pageSize } from './models';
import { validateAnimal, validateFarm, validatePhotoContent } from './validation';

function client() { if (!supabase) throw new Error(setupMessage || 'Supabase is not configured.'); return supabase; }
export function requestError(error: unknown): string {
  if (error instanceof Error && !('code' in error)) return error.message;
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    '23505': 'This animal ID is already registered in the farm. Use a different ID.',
    '23503': 'This record is still referenced. Remove parent links before deleting an animal, or remove animals before deleting a farm.',
    '23514': 'The record violates a database rule. Check birth dates, parent relationships, field limits, and the uploaded photo.',
    '42501': 'You do not have permission for this operation.',
    'PGRST116': 'This record is unavailable, no longer authorized, or was changed by another user. Reload and try again.',
    'PGRST205': 'Database setup is incomplete. Apply the Phase 2 and Phase 3 migrations, then retry.',
    '42P01': 'Database setup is incomplete. Apply the Phase 2 and Phase 3 migrations, then retry.',
    '42703': 'Database setup is incomplete. Apply the Phase 3 migration, then retry.',
    'PGRST202': 'Database setup is incomplete. Apply the Phase 3 migration and refresh the schema cache.',
  };
  return (code && messages[code]) || 'Unable to complete the request. Check your connection and Supabase setup, then retry.';
}
function check(error: unknown) { if (error) throw new Error(requestError(error)); }

export async function listFarms(): Promise<Farm[]> {
  const rows: Farm[] = [];
  // Avoid Supabase's default row limit silently truncating the farm selector.
  for (let start = 0; ; start += 1000) {
    const { data, error } = await client().from('farms').select('*').order('name').order('id').range(start, start + 999);
    check(error); rows.push(...((data ?? []) as Farm[])); if ((data ?? []).length < 1000) return rows;
  }
}
export async function getFarm(id: string): Promise<Farm> {
  const { data, error } = await client().from('farms').select('*').eq('id', id).single(); check(error); return data as Farm;
}
export async function getContact(farm: string): Promise<string> {
  const { data, error } = await client().from('farm_contacts').select('contact_information').eq('farm_id', farm).maybeSingle(); check(error); return data?.contact_information ?? '';
}
export async function farmPeople(farm: string): Promise<FarmPerson[]> {
  const { data, error } = await client().rpc('farm_people', { target_farm: farm }); check(error); return data as FarmPerson[];
}
export async function saveFarm(draft: FarmDraft, id?: string): Promise<string> {
  if (Object.keys(validateFarm(draft)).length) throw new Error('Correct the farm form fields before saving.');
  const { data, error } = await client().rpc('save_farm', { p_id: id ?? null, p_name: draft.name.trim(), p_location: draft.location.trim(), p_description: draft.description.trim() || null, p_contact_information: draft.contact_information.trim() || null });
  check(error); if (!data) throw new Error('No farm was saved. Reload and try again.'); return data as string;
}
export async function deleteFarm(id: string) {
  const { error } = await client().from('farms').delete().eq('id', id).select('id').single(); check(error);
}
export async function listAnimals(query: AnimalQuery): Promise<{ animals: Animal[]; count: number }> {
  let request = client().from('animals').select('*', { count: 'exact' });
  if (query.farm) request = request.eq('farm_id', query.farm);
  if (query.species) request = request.eq('species', query.species);
  if (query.category) request = request.eq('category', query.category);
  if (query.status) request = request.eq('status', query.status);
  // Strip PostgREST expression punctuation/wildcards from the user search term.
  const term = query.search.trim().replace(/[(),%_\\".]/g, ' ').slice(0, 100).trim();
  if (term) request = request.or(`name.ilike.%${term}%,animal_identifier.ilike.%${term}%,breed.ilike.%${term}%`);
  const order = { newest: 'created_at', name: 'name', identifier: 'animal_identifier', birth: 'date_of_birth' }[query.sort];
  request = request.order(order, { ascending: query.sort !== 'newest' }).order('id');
  const start = (Math.max(1, query.page) - 1) * pageSize;
  const { data, count, error } = await request.range(start, start + pageSize - 1); check(error);
  return { animals: data as Animal[], count: count ?? 0 };
}
export async function getAnimal(id: string): Promise<Animal> {
  const { data, error } = await client().from('animals').select('*').eq('id', id).single(); check(error); return data as Animal;
}
export async function parentOptions(farm: string): Promise<ParentOption[]> {
  const rows: ParentOption[] = [];
  for (let start = 0; ; start += 1000) {
    const { data, error } = await client().from('animals').select('id, farm_id, animal_identifier, name, species, sex, date_of_birth').eq('farm_id', farm).order('animal_identifier').order('id').range(start, start + 999);
    check(error); rows.push(...((data ?? []) as ParentOption[])); if ((data ?? []).length < 1000) return rows;
  }
}
export async function summary(farmIds: string[]): Promise<Summary> {
  const empty: Summary = { farms: farmIds.length, animals: 0, calves: 0, active: 0, transferred: 0, deceased: 0, recent: [] };
  if (!farmIds.length) return empty;
  const counts = await Promise.all([{}, { category: 'CALF' }, { status: 'ACTIVE' }, { status: 'TRANSFERRED' }, { status: 'DECEASED' }].map(async filter => {
    let query = client().from('animals').select('id', { count: 'exact', head: true }).in('farm_id', farmIds);
    if ('category' in filter) query = query.eq('category', filter.category);
    if ('status' in filter) query = query.eq('status', filter.status);
    const { count, error } = await query; check(error); return count ?? 0;
  }));
  const { data, error } = await client().from('animals').select('*').in('farm_id', farmIds).order('created_at', { ascending: false }).order('id').limit(5); check(error);
  return { farms: farmIds.length, animals: counts[0], calves: counts[1], active: counts[2], transferred: counts[3], deceased: counts[4], recent: data as Animal[] };
}

const bucket = 'animal-photos';
export async function signedPhoto(path: string): Promise<string> {
  const { data, error } = await client().storage.from(bucket).createSignedUrl(path, 300); check(error); if (!data) throw new Error('Photo URL unavailable. Retry.'); return data.signedUrl;
}
async function removePhoto(path: string) {
  const { error } = await client().storage.from(bucket).remove([path]); check(error);
}
export async function saveAnimal(draft: AnimalDraft, parents: ParentOption[], original?: Animal, file?: File | null, remove = false): Promise<{ animal: Animal; warning: string }> {
  if (Object.keys(validateAnimal(draft, parents, original?.id)).length) throw new Error('Correct the animal form fields before saving.');
  if (original && draft.farm_id !== original.farm_id) throw new Error('An animal cannot be moved to another farm.');
  if (file) { const error = await validatePhotoContent(file); if (error) throw new Error(error); }
  const values = { farm_id: draft.farm_id, animal_identifier: draft.animal_identifier.trim().toUpperCase(), name: draft.name.trim(), species: draft.species, breed: draft.breed.trim(), sex: draft.sex, date_of_birth: draft.date_of_birth, category: draft.category, status: draft.status, notes: draft.notes.trim() || null, mother_id: draft.mother_id || null, father_id: draft.father_id || null };
  // Farm identity is never sent in an edit. DB column grants/trigger enforce this too.
  const { farm_id, ...mutable } = values;
  const request = original
    ? client().from('animals').update({ ...mutable, ...(remove && !file ? { photo_path: null } : {}) }).eq('id', original.id).eq('updated_at', original.updated_at)
    : client().from('animals').insert({ ...values });
  const { data, error } = await request.select('*').single(); check(error);
  let animal = data as Animal;
  let warning = '';
  if (file) {
    const extension = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }[file.type];
    const path = `${farm_id}/${animal.id}/${crypto.randomUUID()}.${extension}`;
    try {
      const { error: uploadError } = await client().storage.from(bucket).upload(path, file, { contentType: file.type, upsert: false, cacheControl: '300' }); check(uploadError);
      const { data: attached, error: attachError } = await client().from('animals').update({ photo_path: path }).eq('id', animal.id).eq('updated_at', animal.updated_at).select('*').single(); check(attachError);
      animal = attached as Animal;
    } catch {
      warning = 'Animal details were saved, but the photo operation did not finish successfully. Reload the record to check which photo is attached before retrying.';
      try { await removePhoto(path); } catch { warning += ' An upload may need owner review in Storage.'; }
    }
  }
  if (original?.photo_path && animal.photo_path !== original.photo_path) {
    try { await removePhoto(original.photo_path); }
    catch { warning += ' The previous photo was unlinked, but its Storage file could not be deleted. Ask the farm owner to retry cleanup.'; }
  }
  return { animal, warning: warning.trim() };
}
export async function deleteAnimal(animal: Animal): Promise<string> {
  const { error } = await client().from('animals').delete().eq('id', animal.id).eq('updated_at', animal.updated_at).select('id').single(); check(error);
  if (animal.photo_path) { try { await removePhoto(animal.photo_path); } catch { return 'Animal deleted, but its unlinked photo file could not be removed. Ask the farm owner to clean it up in Storage.'; } }
  return '';
}
export async function dashboardSummary(profile: Profile) {
  const farms = await listFarms();
  return summary(farms.filter(farm => profile.role !== 'FARMER' || farm.owner_id === profile.id).map(farm => farm.id));
}
