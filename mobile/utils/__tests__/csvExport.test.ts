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
import { exportCsvFileName, shareCsvExport } from '../csvExport';

const CSV = 'Name,Urgency Score,Last Seen\nAnn Lee,40,2025-01-01\n';

beforeEach(() => {
  jest.clearAllMocks();
  (api.exportCSV as jest.Mock).mockResolvedValue(CSV);
  (Sharing.isAvailableAsync as jest.Mock).mockResolvedValue(true);
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
