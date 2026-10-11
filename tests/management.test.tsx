// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { FarmForm, AnimalForm, FarmList, FarmDetails, AnimalDetails, FarmerOverview, AnimalList } from '../src/management/Management';
import { validateAnimal, validateFarm, validatePhoto, validatePhotoContent } from '../src/management/validation';
import type { Animal, AnimalDraft, Farm, ParentOption } from '../src/management/models';
import { canManage } from '../src/management/models';

const farmId = '20000000-0000-4000-8000-000000000001';
const animalId = '30000000-0000-4000-8000-000000000001';
const farm: Farm = { id: farmId, name: 'Real farm', location: 'Pune', description: 'Our farm', owner_id: 'owner', created_at: '2026-01-01', updated_at: '2026-01-01' };
const animal: Animal = { id: animalId, farm_id: farmId, animal_identifier: 'CF-001', name: 'Daisy', species: 'CATTLE', breed: 'Gir', sex: 'FEMALE', date_of_birth: '2025-01-01', mother_id: null, father_id: null, category: 'CALF', status: 'ACTIVE', photo_path: null, notes: '', created_at: '2026-01-01', updated_at: '2026-01-01' };
const mocks = vi.hoisted(() => ({
  profile: { id: 'owner', full_name: 'Owner', email: 'owner@example.test', role: 'FARMER' } as any,
  listFarms: vi.fn(), getFarm: vi.fn(), getContact: vi.fn(), saveFarm: vi.fn(), farmPeople: vi.fn(), summary: vi.fn(), dashboardSummary: vi.fn(), deleteFarm: vi.fn(),
  listAnimals: vi.fn(), getAnimal: vi.fn(), parentOptions: vi.fn(), saveAnimal: vi.fn(), deleteAnimal: vi.fn(), signedPhoto: vi.fn(),
}));
vi.mock('../src/auth/AuthProvider', () => ({ useAuth: () => ({ profile: mocks.profile }), dashboardPath: (role: string) => `/dashboard/${role.toLowerCase()}` }));
vi.mock('../src/auth/AuthPages', () => ({ LogoutButton: () => <button>Log out</button> }));
vi.mock('../src/management/api', () => ({ ...mocks, requestError: (error: any) => error?.message ?? 'Request failed' }));

function mount(element: React.ReactNode, path = '/', route = '/') {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path={route} element={element}/><Route path="/manage/farms/:farmId" element={<p>Saved farm destination</p>}/><Route path="/manage/animals/:animalId" element={<p>Saved animal destination</p>}/><Route path="/manage/animals" element={<p>Animal list destination</p>}/></Routes></MemoryRouter>);
}
function fill(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
beforeEach(() => {
  vi.clearAllMocks();
  mocks.profile = { id: 'owner', full_name: 'Owner', email: 'owner@example.test', role: 'FARMER' };
  mocks.listFarms.mockResolvedValue([farm]); mocks.getFarm.mockResolvedValue(farm); mocks.getContact.mockResolvedValue('private phone'); mocks.saveFarm.mockResolvedValue(farmId);
  mocks.parentOptions.mockResolvedValue([]); mocks.getAnimal.mockResolvedValue(animal); mocks.saveAnimal.mockResolvedValue({ animal, warning: '' });
  mocks.listAnimals.mockResolvedValue({ animals: [animal], count: 1 });
  const summary = { farms: 1, animals: 1, calves: 1, active: 1, transferred: 0, deceased: 0, recent: [animal] };
  mocks.summary.mockResolvedValue(summary); mocks.dashboardSummary.mockResolvedValue(summary);
  mocks.farmPeople.mockResolvedValue([{ user_id: 'owner', full_name: 'Owner', role: 'FARMER', is_owner: true, joined_at: '2026-01-01' }]);
  mocks.deleteFarm.mockResolvedValue(undefined); mocks.deleteAnimal.mockResolvedValue('');
  mocks.signedPhoto.mockResolvedValue('https://example.test/private-photo');
});
afterEach(cleanup);

describe('farm and animal validation', () => {
  const draft: AnimalDraft = { ...animal, mother_id: '', father_id: '', notes: '' };
  it('validates farm field lengths and optional contacts', () => {
    expect(validateFarm({ name: 'Farm', location: 'Pune', description: '', contact_information: '' })).toEqual({});
    expect(Object.keys(validateFarm({ name: ' ', location: 'P', description: 'a'.repeat(2001), contact_information: 'a'.repeat(501) }))).toHaveLength(4);
  });
  it('validates identifiers, required fields, calendar dates, and future birth dates', () => {
    expect(validateAnimal(draft, [])).toEqual({});
    expect(validateAnimal({ ...draft, animal_identifier: 'bad id' }, []).animal_identifier).toBeTruthy();
    expect(validateAnimal({ ...draft, date_of_birth: '2099-01-01' }, []).date_of_birth).toBeTruthy();
    expect(validateAnimal({ ...draft, date_of_birth: '2025-02-30' }, []).date_of_birth).toBeTruthy();
    expect(validateAnimal({ ...draft, breed: '', name: '', farm_id: '' }, [])).toMatchObject({ breed: expect.any(String), name: expect.any(String), farm_id: expect.any(String) });
  });
  it('checks same-farm, older, same-species, correct-sex parents and self-parent prevention', () => {
    const parent: ParentOption = { ...animal, id: 'parent', date_of_birth: '2020-01-01' };
    expect(validateAnimal({ ...draft, mother_id: 'parent' }, [parent]).mother_id).toBeUndefined();
    for (const invalid of [{ ...parent, farm_id: 'another-farm' }, { ...parent, date_of_birth: '2025-01-01' }, { ...parent, species: 'BUFFALO' as const }, { ...parent, sex: 'MALE' as const }]) expect(validateAnimal({ ...draft, mother_id: 'parent' }, [invalid]).mother_id).toBeTruthy();
    expect(validateAnimal({ ...draft, mother_id: animalId }, [animal], animalId).mother_id).toBeTruthy();
    expect(validateAnimal({ ...draft, sex: 'MALE', category: 'HEIFER' }, []).category).toBeTruthy();
  });
  it('validates image type, size and content signature', async () => {
    expect(validatePhoto({ type: 'image/svg+xml', size: 100 })).toBeTruthy();
    expect(validatePhoto({ type: 'image/png', size: 5242881 })).toBeTruthy();
    const image = { type: 'image/png', size: 12, slice: () => ({ arrayBuffer: async () => new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]).buffer }) } as unknown as File;
    expect(await validatePhotoContent(image)).toBeNull();
    expect(await validatePhotoContent({ ...image, type: 'image/jpeg' } as File)).toMatch(/does not match/);
  });
  it('client controls use owner/database roles and keep veterinarians read-only', () => {
    expect(canManage(mocks.profile, farm)).toBe(true);
    expect(canManage({ ...mocks.profile, id: 'other-owner' }, farm)).toBe(false);
    expect(canManage({ ...mocks.profile, role: 'VETERINARIAN' }, farm)).toBe(false);
    expect(canManage({ ...mocks.profile, role: 'ADMIN' }, farm)).toBe(true);
  });
});

describe('live management pages with mocked Supabase operations', () => {
  it('validates the farm form and saves actual entered information', async () => {
    mount(<FarmForm/>); await screen.findByLabelText('Farm name *');
    fireEvent.click(screen.getByRole('button', { name: 'Create farm' }));
    expect(mocks.saveFarm).not.toHaveBeenCalled(); expect(screen.getByText(/Farm name must/)).toBeTruthy();
    fill('Farm name *', 'My new farm'); fill('Location *', 'Pune'); fill('Private contact information (optional)', 'private@example.test');
    fireEvent.click(screen.getByRole('button', { name: 'Create farm' }));
    expect(await screen.findByText('Saved farm destination')).toBeTruthy();
    expect(mocks.saveFarm).toHaveBeenCalledWith({ name: 'My new farm', location: 'Pune', description: '', contact_information: 'private@example.test' }, undefined);
  });
  it('validates animal registration before saving and uses an authorized farm', async () => {
    mount(<AnimalForm/>); await screen.findByLabelText('Animal ID *');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Register animal' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Register animal' }));
    expect(mocks.saveAnimal).not.toHaveBeenCalled();
    fill('Animal ID *', 'NEW-1'); fill('Animal name *', 'Clover'); fill('Breed *', 'Gir'); fill('Date of birth *', '2025-01-01');
    fireEvent.click(screen.getByRole('button', { name: 'Register animal' }));
    expect(await screen.findByText('Saved animal destination')).toBeTruthy();
    expect(mocks.saveAnimal.mock.calls[0][0]).toMatchObject({ farm_id: farmId, animal_identifier: 'NEW-1', name: 'Clover' });
  });
  it('shows loading, network failure, and retry without hardcoded records', async () => {
    mocks.listFarms.mockRejectedValueOnce(new Error('Network unavailable'));
    mount(<FarmList/>);
    expect(screen.getByText('Loading records…')).toBeTruthy();
    expect(await screen.findByText('Network unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Real farm')).toBeTruthy();
    expect(screen.queryByText('Green Meadow Farm')).toBeNull();
  });
  it('searches farms and shows an empty result', async () => {
    mount(<FarmList/>); await screen.findByText('Real farm');
    fill('Search farms', 'not-present'); expect(screen.getByText('No matching farms.')).toBeTruthy();
  });
  it('keeps assigned vets read-only and never requests private contacts', async () => {
    mocks.profile = { ...mocks.profile, id: 'vet', role: 'VETERINARIAN' };
    mount(<FarmDetails/>, `/farm/${farmId}`, '/farm/:farmId');
    await screen.findByText('Farm information');
    expect(mocks.getContact).not.toHaveBeenCalled(); expect(screen.queryByText('Private contact')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit farm' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Delete farm' })).toBeNull();
  });
  it('requires explicit confirmation before deleting an animal', async () => {
    mount(<AnimalDetails/>, `/animal/${animalId}`, '/animal/:animalId'); await screen.findByText('Identification & birth');
    fireEvent.click(screen.getByRole('button', { name: 'Delete animal' }));
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(mocks.deleteAnimal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete animal' })); fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByText('Animal list destination')).toBeTruthy(); expect(mocks.deleteAnimal).toHaveBeenCalledWith(animal);
  });
  it('confirms photo removal and commits it only when saving the animal', async () => {
    const withPhoto = { ...animal, photo_path: `${farmId}/${animalId}/40000000-0000-4000-8000-000000000001.png` };
    mocks.getAnimal.mockResolvedValue(withPhoto);
    mount(<AnimalForm/>, `/edit/${animalId}`, '/edit/:animalId');
    await screen.findByRole('button', { name: 'Remove photo' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove photo' }));
    expect(screen.getByRole('dialog')).toBeTruthy(); expect(mocks.saveAnimal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove on save' }));
    expect(screen.getByText('Photo will be removed when you save.')).toBeTruthy(); expect(mocks.saveAnimal).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Saved animal destination')).toBeTruthy();
    expect(mocks.saveAnimal.mock.calls[0].slice(2)).toEqual([withPhoto, null, true]);
  });
  it('farmer dashboard uses real counts and marks future modules as unimplemented', async () => {
    mount(<FarmerOverview/>); expect(await screen.findByText('Daisy')).toBeTruthy();
    expect(mocks.dashboardSummary).toHaveBeenCalledWith(mocks.profile);
    expect(screen.getAllByText(/Not yet implemented/)).toHaveLength(2);
    expect(screen.queryByText('48')).toBeNull();
  });
  it('paginates and filters animal requests', async () => {
    mocks.listAnimals.mockResolvedValue({ animals: [animal], count: 21 });
    mount(<AnimalList/>); await screen.findByText('Daisy');
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(mocks.listAnimals).toHaveBeenLastCalledWith(expect.objectContaining({ page: 2 })));
    fill('Filter by species', 'BUFFALO');
    await waitFor(() => expect(mocks.listAnimals).toHaveBeenLastCalledWith(expect.objectContaining({ species: 'BUFFALO', page: 1 })));
  });
  it('denies editing another farmer’s animal even through a manipulated route', async () => {
    mocks.listFarms.mockResolvedValue([{ ...farm, owner_id: 'someone-else' }]);
    mount(<AnimalForm/>, `/edit/${animalId}`, '/edit/:animalId');
    expect(await screen.findByText('You do not have permission to edit this animal.')).toBeTruthy(); expect(screen.queryByLabelText('Animal ID *')).toBeNull();
  });
});
