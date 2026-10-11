import type { Profile } from '../auth/AuthProvider';

export type Farm = { id: string; name: string; location: string; description: string | null; owner_id: string; created_at: string; updated_at: string };
export type FarmDraft = { name: string; location: string; description: string; contact_information: string };
export type FarmPerson = { user_id: string; full_name: string; role: string; is_owner: boolean; joined_at: string };
export type Animal = {
  id: string; farm_id: string; animal_identifier: string; name: string;
  species: 'CATTLE' | 'BUFFALO'; breed: string; sex: 'FEMALE' | 'MALE';
  date_of_birth: string; mother_id: string | null; father_id: string | null;
  category: 'CALF' | 'HEIFER' | 'ADULT'; status: 'ACTIVE' | 'TRANSFERRED' | 'DECEASED';
  photo_path: string | null; notes: string | null; created_at: string; updated_at: string;
};
export type AnimalDraft = Pick<Animal, 'farm_id' | 'animal_identifier' | 'name' | 'species' | 'breed' | 'sex' | 'date_of_birth' | 'category' | 'status'> & { mother_id: string; father_id: string; notes: string };
export type ParentOption = Pick<Animal, 'id' | 'farm_id' | 'animal_identifier' | 'name' | 'species' | 'sex' | 'date_of_birth'>;
export type AnimalQuery = { search: string; farm: string; species: string; category: string; status: string; sort: 'newest' | 'name' | 'identifier' | 'birth'; page: number };
export type Summary = { farms: number; animals: number; calves: number; active: number; transferred: number; deceased: number; recent: Animal[] };
export const pageSize = 10;
export function canManage(profile: Profile | null, farm?: Farm) {
  return !!profile && (profile.role === 'ADMIN' || (profile.role === 'FARMER' && farm?.owner_id === profile.id));
}
export function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}
export function displayDate(value: string) {
  return new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}
export function label(value: string) { return value.charAt(0) + value.slice(1).toLowerCase(); }
