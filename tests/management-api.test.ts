// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { saveFarm, saveAnimal, deleteAnimal, listAnimals } from '../src/management/api';
import type { Animal, AnimalDraft } from '../src/management/models';

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn(), storageFrom: vi.fn(), upload: vi.fn(), remove: vi.fn(), results: [] as any[], builders: [] as any[] }));
vi.mock('../src/lib/supabase', () => ({ setupMessage: null, supabase: { from: mocks.from, rpc: mocks.rpc, storage: { from: mocks.storageFrom } } }));
const draft: AnimalDraft = { farm_id: '20000000-0000-4000-8000-000000000001', animal_identifier: 'NEW-1', name: 'Clover', species: 'CATTLE', breed: 'Gir', sex: 'FEMALE', date_of_birth: '2025-01-01', mother_id: '', father_id: '', category: 'CALF', status: 'ACTIVE', notes: '' };
const animal: Animal = { ...draft, id: '30000000-0000-4000-8000-000000000001', mother_id: null, father_id: null, notes: null, photo_path: null, created_at: '2026-01-01', updated_at: '2026-01-01' };
const file = { type: 'image/png', size: 12, slice: () => ({ arrayBuffer: async () => new Uint8Array([137,80,78,71,13,10,26,10,0,0,0,0]).buffer }) } as unknown as File;

beforeEach(() => {
  vi.clearAllMocks(); mocks.results = []; mocks.builders = [];
  mocks.from.mockImplementation(() => {
    const builder: any = {};
    for (const method of ['insert','update','delete','select','eq','in','order','or','range']) builder[method] = vi.fn(() => builder);
    builder.single = vi.fn(async () => mocks.results.shift() ?? { data: animal, error: null });
    builder.then = (resolve: any) => resolve(mocks.results.shift() ?? { data: [], count: 0, error: null });
    mocks.builders.push(builder); return builder;
  });
  mocks.storageFrom.mockReturnValue({ upload: mocks.upload, remove: mocks.remove });
  mocks.upload.mockResolvedValue({ error: null }); mocks.remove.mockResolvedValue({ error: null });
  mocks.rpc.mockResolvedValue({ data: draft.farm_id, error: null });
});

it('farm save uses the atomic RPC with trimmed fields and no client-selected owner', async () => {
  await saveFarm({ name: ' Farm ', location: ' Pune ', description: '', contact_information: 'private' });
  expect(mocks.rpc).toHaveBeenCalledWith('save_farm', { p_id: null, p_name: 'Farm', p_location: 'Pune', p_description: null, p_contact_information: 'private' });
});
it('invalid farm forms and failed writes cannot produce fake success', async () => {
  await expect(saveFarm({ name: '', location: '', description: '', contact_information: '' })).rejects.toThrow(/Correct/);
  expect(mocks.rpc).not.toHaveBeenCalled();
  mocks.rpc.mockResolvedValue({ data: null, error: { code: '42501' } });
  await expect(saveFarm({ name: 'Farm', location: 'Pune', description: '', contact_information: '' })).rejects.toThrow(/permission/);
});
it('edit submits only writable fields, excluding farm, UUID, creation and update timestamps', async () => {
  await saveAnimal({ ...animal, mother_id: '', father_id: '', notes: '' }, [], animal);
  const values = mocks.builders[0].update.mock.calls[0][0];
  for (const field of ['id','farm_id','created_at','updated_at','photo_path']) expect(values).not.toHaveProperty(field);
  expect(mocks.builders[0].eq).toHaveBeenCalledWith('updated_at', animal.updated_at);
});
it('rejects a cross-farm edit before any request', async () => {
  await expect(saveAnimal({ ...draft, farm_id: '20000000-0000-4000-8000-000000000002' }, [], animal)).rejects.toThrow(/cannot be moved/);
  expect(mocks.from).not.toHaveBeenCalled();
});
it('duplicate identifiers are reported as errors and do not upload a photo', async () => {
  mocks.results = [{ data: null, error: { code: '23505' } }];
  await expect(saveAnimal(draft, [], undefined, file)).rejects.toThrow(/already registered/);
  expect(mocks.upload).not.toHaveBeenCalled();
});
it('replaces a photo by uploading a new private object, attaching it, then cleaning the old one', async () => {
  const original = { ...animal, photo_path: `${animal.farm_id}/${animal.id}/old.png` };
  const newPath = `${animal.farm_id}/${animal.id}/new.png`;
  mocks.results = [{ data: original, error: null }, { data: { ...animal, photo_path: newPath }, error: null }];
  const result = await saveAnimal(draft, [], original, file);
  expect(mocks.upload.mock.calls[0][0]).toMatch(new RegExp(`^${animal.farm_id}/${animal.id}/[0-9a-f-]+\\.png$`));
  expect(mocks.upload.mock.calls[0][2].upsert).toBe(false);
  expect(mocks.builders[1].update).toHaveBeenCalledWith({ photo_path: mocks.upload.mock.calls[0][0] });
  expect(mocks.remove).toHaveBeenCalledWith([original.photo_path]); expect(result.warning).toBe('');
});
it('reports partial photo failure while keeping saved fields and the previous photo', async () => {
  const original = { ...animal, photo_path: `${animal.farm_id}/${animal.id}/old.png` };
  mocks.results = [{ data: original, error: null }]; mocks.upload.mockResolvedValue({ error: { message: 'network' } });
  const result = await saveAnimal(draft, [], original, file);
  expect(result.warning).toMatch(/details were saved, but the photo/); expect(result.warning).toMatch(/check which photo/); expect(result.animal.photo_path).toBe(original.photo_path);
  expect(mocks.remove).not.toHaveBeenCalledWith([original.photo_path]);
});
it('removes the photo only after the database link has been cleared', async () => {
  const original = { ...animal, photo_path: `${animal.farm_id}/${animal.id}/old.png` };
  mocks.results = [{ data: animal, error: null }];
  await saveAnimal(draft, [], original, null, true);
  expect(mocks.builders[0].update.mock.calls[0][0]).toHaveProperty('photo_path', null);
  expect(mocks.remove).toHaveBeenCalledWith([original.photo_path]);
});
it('reports cleanup failures after a real deletion instead of reporting full cleanup success', async () => {
  mocks.remove.mockResolvedValue({ error: { message: 'network' } });
  expect(await deleteAnimal({ ...animal, photo_path: 'private-path' })).toMatch(/deleted, but/);
});
it('applies server pagination and strips expression punctuation from searches', async () => {
  await listAnimals({ search: 'Daisy),status.eq.ACTIVE', farm: '', species: 'CATTLE', category: '', status: '', sort: 'name', page: 2 });
  expect(mocks.builders[0].range).toHaveBeenCalledWith(10,19);
  expect(mocks.builders[0].eq).toHaveBeenCalledWith('species','CATTLE');
  expect(mocks.builders[0].or.mock.calls[0][0]).not.toContain('status.eq.');
});
