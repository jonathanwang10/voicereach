import type { LocationGeocodedAddress } from 'expo-location';

// Where a map opens when there is no GPS fix to use (Market St & 5th St, SoMa).
// Only a starting point for the map; it is never stored as anyone's location.
export const SF_DEFAULT_COORDINATE = {
  latitude: 37.7821638619815,
  longitude: -122.41033921502972,
};

// "street city region" from a reverse geocode result, or null when there is none
export const formatGeocodedAddress = (address?: LocationGeocodedAddress | null): string | null =>
  address
    ? `${address.street || ''} ${address.city || ''} ${address.region || ''}`.trim() || null
    : null;
