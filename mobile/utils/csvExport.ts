// CSV export (R-9 / C-44): fetch the CSV, write it to a cache file and open the
// share sheet so the worker chooses where it goes (Save to Files, AirDrop, Mail...).
// The file is deleted once the sheet closes, and the contents are never logged:
// every row is personal and medical data.
import { api } from '../services/api';
import { Category, categoryLabel } from './categoryPayload';

type FileSystemModule = typeof import('expo-file-system');
type SharingModule = typeof import('expo-sharing');

const pad = (n: number) => String(n).padStart(2, '0');

// individuals_export_YYYYMMDD_HHMMSS.csv (local time), like the backend's filename
export const exportCsvFileName = (now: Date = new Date()): string =>
  `individuals_export_${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
  `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.csv`;

// The confirmation before an export (H2-6.13): the file holds everyone, so it names
// the fields marked sensitive
export const exportWarning = (categories: Category[]): string => {
  const labels = categories.filter(c => c.is_sensitive).map(categoryLabel);
  return labels.length
    ? `The file has every person's records, including these sensitive fields: ${labels.join(', ')}. Share it only with someone allowed to see them.`
    : "The file has every person's records. Share it only with someone allowed to see them.";
};

// expo-sharing is a native module that resolves its native half when imported. A
// dev build made before it was added has no such half, and a top-level import
// would crash the app at launch. Loading it here turns that into an export error.
const loadNativeModules = (): { FileSystem: FileSystemModule; Sharing: SharingModule } => {
  try {
    return {
      FileSystem: require('expo-file-system') as FileSystemModule,
      Sharing: require('expo-sharing') as SharingModule,
    };
  } catch {
    throw new Error('Sharing is not available in this build of the app. Rebuild it (npx expo run:ios).');
  }
};

// Resolves when the share sheet closes (shared or cancelled). Throws ApiError if the
// export request fails, or an Error if sharing is unavailable or fails.
export const shareCsvExport = async (): Promise<void> => {
  const { FileSystem, Sharing } = loadNativeModules();
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is not available on this device');
  }
  const csv = await api.exportCSV();
  const uri = `${FileSystem.cacheDirectory}${exportCsvFileName()}`;
  try {
    // Inside the try: a failed write can leave a partial file behind
    await FileSystem.writeAsStringAsync(uri, csv, { encoding: FileSystem.EncodingType.UTF8 });
    await Sharing.shareAsync(uri, {
      mimeType: 'text/csv',
      UTI: 'public.comma-separated-values-text',
      dialogTitle: 'Export CSV',
    });
  } finally {
    await FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
  }
};
