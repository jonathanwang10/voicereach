import { randomUUID } from 'expo-crypto';

// The app's one UUID helper (H2-2.4): a review session's Idempotency-Key, and later
// the device id and recording ids. A v4 UUID from the platform's secure RNG.
export const newRequestId = (): string => randomUUID();
