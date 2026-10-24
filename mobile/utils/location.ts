import * as Location from 'expo-location';
import type { LocationGeocodedAddress } from 'expo-location';
import type { LocationData } from '../types';

// Where a map opens when there is no GPS fix to use (Market St & 5th St, SoMa).
// Only a starting point for the map; it is never stored as anyone's location.
export const SF_DEFAULT_COORDINATE = {
  latitude: 37.7821638619815,
  longitude: -122.41033921502972,
};

export const UNKNOWN_ADDRESS = 'Unknown Address';
// How long stopping a recording waits for a GPS fix that is still on its way (C-39)
export const LOCATION_WAIT_MS = 3000;
// A cached fix this recent and this accurate is used at once (H2-6.1)
export const LAST_KNOWN_MAX_AGE_MS = 120_000;
export const LAST_KNOWN_MAX_ACCURACY_M = 100;

export interface RecordingLocation {
  location: LocationData;
}

// "street city region" from a reverse geocode result, or null when there is none
export const formatGeocodedAddress = (address?: LocationGeocodedAddress | null): string | null =>
  address
    ? `${address.street || ''} ${address.city || ''} ${address.region || ''}`.trim() || null
    : null;

// The address for a point, else UNKNOWN_ADDRESS (offline, or nothing found). Never throws.
export const addressFor = async (latitude: number, longitude: number): Promise<string> => {
  try {
    const [address] = await Location.reverseGeocodeAsync({ latitude, longitude });
    return formatGeocodedAddress(address) ?? UNKNOWN_ADDRESS;
  } catch (err) {
    if (__DEV__) console.warn('Reverse geocoding failed, keeping the coordinates:', err);
    return UNKNOWN_ADDRESS;
  }
};

const lastKnownFix = async (): Promise<Location.LocationObject | null> => {
  try {
    return await Location.getLastKnownPositionAsync({
      maxAge: LAST_KNOWN_MAX_AGE_MS,
      requiredAccuracy: LAST_KNOWN_MAX_ACCURACY_M,
    });
  } catch {
    return null;
  }
};

// The fix and its address, or undefined when there are no coordinates at all. A failed
// address lookup keeps the coordinates (H2-6.1). Never throws.
export const captureLocation = async (): Promise<RecordingLocation | undefined> => {
  try {
    const { status } = await Location.requestForegroundPermissionsAsync();
    if (status !== 'granted') return undefined;
    const fix = (await lastKnownFix()) ?? (await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }));
    const { latitude, longitude } = fix.coords;
    return { location: { latitude, longitude, address: await addressFor(latitude, longitude) } };
  } catch (err) {
    if (__DEV__) console.warn('Location capture failed, continuing without location:', err);
    return undefined;
  }
};

// The fix if it arrives within waitMs, else undefined
export const awaitLocation = async (
  pending: Promise<RecordingLocation | undefined> | null,
  waitMs: number = LOCATION_WAIT_MS,
): Promise<RecordingLocation | undefined> => {
  if (!pending) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), waitMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
};
