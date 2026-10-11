import type { AnimalDraft, FarmDraft, ParentOption } from './models';
import { todayDate } from './models';

export type ValidationErrors = Record<string, string>;
export function validateFarm(draft: FarmDraft): ValidationErrors {
  const errors: ValidationErrors = {};
  if (draft.name.trim().length < 2 || draft.name.trim().length > 150) errors.name = 'Farm name must have 2–150 characters.';
  if (draft.location.trim().length < 2 || draft.location.trim().length > 250) errors.location = 'Location must have 2–250 characters.';
  if (draft.description.trim().length > 2000) errors.description = 'Description must be at most 2,000 characters.';
  if (draft.contact_information.trim().length > 500) errors.contact_information = 'Contact information must be at most 500 characters.';
  return errors;
}
export function validateAnimal(draft: AnimalDraft, parents: ParentOption[], id?: string): ValidationErrors {
  const errors: ValidationErrors = {};
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(draft.farm_id)) errors.farm_id = 'Select an authorized farm.';
  if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(draft.animal_identifier.trim().toUpperCase())) errors.animal_identifier = 'Use 1–40 letters, numbers, hyphens, or underscores.';
  if (!draft.name.trim() || draft.name.trim().length > 100) errors.name = 'Animal name must have 1–100 characters.';
  if (!draft.breed.trim() || draft.breed.trim().length > 100) errors.breed = 'Breed must have 1–100 characters.';
  if (!['CATTLE', 'BUFFALO'].includes(draft.species)) errors.species = 'Select cattle or buffalo.';
  if (!['FEMALE', 'MALE'].includes(draft.sex)) errors.sex = 'Select female or male.';
  if (!['CALF', 'HEIFER', 'ADULT'].includes(draft.category)) errors.category = 'Select a valid category.';
  if (!['ACTIVE', 'TRANSFERRED', 'DECEASED'].includes(draft.status)) errors.status = 'Select a valid status.';
  const date = new Date(`${draft.date_of_birth}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date_of_birth) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== draft.date_of_birth || draft.date_of_birth < '1900-01-01' || draft.date_of_birth > todayDate()) errors.date_of_birth = 'Choose a valid birth date between 1900 and today.';
  if (draft.category === 'HEIFER' && draft.sex !== 'FEMALE') errors.category = 'A heifer must be female.';
  if (draft.notes.trim().length > 5000) errors.notes = 'Notes must be at most 5,000 characters.';
  for (const [field, sex] of [['mother_id', 'FEMALE'], ['father_id', 'MALE']] as const) {
    const value = draft[field];
    if (!value) continue;
    const parent = parents.find(parent => parent.id === value);
    if (value === id || !parent || parent.farm_id !== draft.farm_id || parent.sex !== sex || parent.species !== draft.species || parent.date_of_birth >= draft.date_of_birth) errors[field] = `Choose an older ${sex.toLowerCase()} of the same species from this farm.`;
  }
  if (draft.mother_id && draft.mother_id === draft.father_id) errors.father_id = 'Mother and father must be different animals.';
  return errors;
}

export const photoLimit = 5 * 1024 * 1024;
export function validatePhoto(file: Pick<File, 'type' | 'size'>): string | null {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return 'Choose a JPEG, PNG, or WebP image.';
  if (file.size === 0 || file.size > photoLimit) return 'Photo must be nonempty and at most 5 MB.';
  return null;
}
export async function validatePhotoContent(file: File): Promise<string | null> {
  const error = validatePhoto(file); if (error) return error;
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  const webp = String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.slice(8, 12)) === 'WEBP';
  return (file.type === 'image/jpeg' && jpeg) || (file.type === 'image/png' && png) || (file.type === 'image/webp' && webp) ? null : 'The file content does not match its image type.';
}
