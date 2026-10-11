// CSV export (R-9 / C-44): fetch the CSV, write it to a cache file and open the
// share sheet so the worker chooses where it goes (Save to Files, AirDrop, Mail...).
// The file is deleted once the sheet closes, and the contents are never logged:
// every row is personal and medical data.
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { api } from '../services/api';

const pad = (n: number) => String(n).padStart(2, '0');

// individuals_export_YYYYMMDD_HHMMSS.csv (local time), like the backend's filename
export const exportCsvFileName = (now: Date = new Date()): string =>
  `individuals_export_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
  `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;

// Resolves when the share sheet closes (shared or cancelled). Throws ApiError if the
// export request fails, or an Error if sharing is unavailable or fails.
export const shareCsvExport = async (): Promise<void> => {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  const csv = await api.exportCSV();
  const uri = `${FileSystem.cacheDirectory}${exportCsvFileName()}`;
  await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
  try {
    await Sharing.shareAsync(uri, {
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: 'Export CSV',
    });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
};
