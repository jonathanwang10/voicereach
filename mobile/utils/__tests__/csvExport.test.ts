// C-44 / R-9: the export used to be thrown away (and logged). It must be written
// to a cache file and handed to the share sheet, and never logged.
jest.mock('expo-file-system', () => ({
  cacheDirectory: 'file:///cache/',
  writeAsStringAsync: jest.fn().mockResolvedValue(undefined),
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  EncodingType: { UTF8: 'utf8' },
}));
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn().mockResolvedValue(true),
  shareAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/api', () => ({
  api: { exportCSV: jest.fn() },
}));

import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api } from '../../services/api';
import { exportCsvFileName, exportWarning, shareCsvExport } from '../csvExport';

const CSV = 'Name,Urgency Score,Last Seen\nAnn Lee,40,2025-01-01\n';

beforeEach(() => {
  jest.clearAllMocks();
  (api.exportCSV as jest.Mock).mockResolvedValue(CSV);
  (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
});

const cat = (name: string): any => ({
  id: name, name, display_name: null, type: 'text', priority: 'medium', urgency_weight: 0,
  auto_trigger: false, is_required: false, is_preset: false,
});

it('names the sensitive columns (H2-6.13)', () => {
  expect(exportWarning([cat('name'), { ...cat('hiv_status'), display_name: 'HIV status', is_sensitive: true }]))
    .toBe("The file has every person's records, including these sensitive fields: HIV status. Share it only with someone allowed to see them.");
});

it('lists several sensitive columns in the given order', () => {
  expect(exportWarning([{ ...cat('b'), is_sensitive: true }, { ...cat('a'), display_name: 'A field', is_sensitive: true }]))
    .toContain('sensitive fields: B, A field.');   // categoryLabel title-cases a bare key
});

it('says nothing about sensitive fields when none are flagged', () => {
  expect(exportWarning([cat('name'), cat('notes')]))
    .toBe("The file has every person's records. Share it only with someone allowed to see them.");
});

it('deletes the cached file when writing it fails', async () => {
  (FileSystem.writeAsStringAsync as jest.Mock).mockRejectedValueOnce(new Error('disk full'));
  await expect(shareCsvExport()).rejects.toThrow('disk full');
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
  expect(Sharing.shareAsync).not.toHaveBeenCalled();
});

it('names the file with the date and time', () => {
  expect(exportCsvFileName(new Date(2025, 0, 2, 3, 4, 5))).toBe('individuals_export_20250102_030405.csv');
});

it('writes the CSV to the cache directory and opens the share sheet on that file', async () => {
  await shareCsvExport();
  const [uri, contents] = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls[0];
  expect(uri).toMatch(/^file:\/\/\/cache\/individuals_export_\d{8}_\d{6}\.csv$/);
  expect(contents).toBe(CSV);
  expect(Sharing.shareAsync).toHaveBeenCalledWith(uri, expect.objectContaining({ mimeType: 'text/csv' }));
});

it('deletes the cached file once the share sheet closes', async () => {
  await shareCsvExport();
  const [uri] = (FileSystem.writeAsStringAsync as jest.Mock).mock.calls[0];
  expect(FileSystem.deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
  const shared = (Sharing.shareAsync as jest.Mock).mock.invocationCallOrder[0];
  const deleted = (FileSystem.deleteAsync as jest.Mock).mock.invocationCallOrder[0];
  expect(deleted).toBeGreaterThan(shared);
});

it('deletes the cached file even when sharing fails, and rethrows', async () => {
  (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error('boom'));
  await expect(shareCsvExport()).rejects.toThrow('boom');
  expect(FileSystem.deleteAsync).toHaveBeenCalled();
});

it('throws a clear error when sharing is unavailable, without writing the file', async () => {
  (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(false);
  await expect(shareCsvExport()).rejects.toThrow(/sharing is not available/i);
  expect(FileSystem.writeAsStringAsync).not.toHaveBeenCalled();
});

it('never logs the CSV contents', async () => {
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(m => jest.spyOn(console, m).mockImplementation(() => {}));
  await shareCsvExport();
  for (const spy of spies) {
    for (const call of spy.mock.calls) expect(JSON.stringify(call)).not.toContain('Ann Lee');
    spy.mockRestore();
  }
});

// A dev build made before expo-sharing was added has no native module: importing it
// throws. That must surface as an export error, not crash the app on launch.
it('turns a missing native module into an export error instead of a crash', async () => {
  jest.resetModules();
  jest.doMock('expo-sharing', () => {
    throw new Error("Cannot find native module 'ExpoSharing'");
  });
  const freshApi = require('../../services/api').api;
  const mod = require('../csvExport');   // importing the module itself must not throw
  await expect(mod.shareCsvExport()).rejects.toThrow(/rebuild/i);
  expect(freshApi.exportCSV).not.toHaveBeenCalled();
});
