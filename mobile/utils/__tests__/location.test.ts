// H2-6.1: a recording's location. A recent cached fix is used at once; a failed address
// lookup keeps the coordinates.
jest.mock('expo-location', () => ({
  Accuracy: { High: 4 },
  requestForegroundPermissionsAsync: jest.fn(),
  getLastKnownPositionAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
  reverseGeocodeAsync: jest.fn(),
}));

import * as Location from 'expo-location';
import { addressFor, awaitLocation, captureLocation, LOCATION_WAIT_MS, UNKNOWN_ADDRESS } from '../location';

const permission = Location.requestForegroundPermissionsAsync as jest.Mock;
const last = Location.getLastKnownPositionAsync as jest.Mock;
const current = Location.getCurrentPositionAsync as jest.Mock;
const geocode = Location.reverseGeocodeAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  permission.mockResolvedValue({ status: 'granted' });
  last.mockResolvedValue(null);
  current.mockResolvedValue({ coords: { latitude: 37.7, longitude: -122.4 } });
  geocode.mockResolvedValue([{ street: '5th St', city: 'San Francisco', region: 'CA' }]);
});

it('uses a last-known fix under 2 minutes old without waiting for GPS (H2-6.1)', async () => {
  last.mockResolvedValue({ coords: { latitude: 37.78, longitude: -122.41 } });
  const r = await captureLocation();
  expect(last).toHaveBeenCalledWith({ maxAge: 120000, requiredAccuracy: 100 });
  expect(current).not.toHaveBeenCalled();
  expect(r?.location).toMatchObject({ latitude: 37.78, longitude: -122.41 });
});

it('falls back to a fresh fix when there is no recent one', async () => {
  const r = await captureLocation();
  expect(current).toHaveBeenCalledWith({ accuracy: Location.Accuracy.High });
  expect(r).toEqual({ location: { latitude: 37.7, longitude: -122.4, address: '5th St San Francisco CA' } });
});

it('keeps the coordinates with "Unknown Address" when reverse geocoding throws', async () => {
  last.mockResolvedValue({ coords: { latitude: 1, longitude: 2 } });
  geocode.mockRejectedValue(new Error('offline'));
  expect(await captureLocation()).toEqual({ location: { latitude: 1, longitude: 2, address: 'Unknown Address' } });
});

it('uses "Unknown Address" when the geocoder returns nothing', async () => {
  geocode.mockResolvedValue([]);
  expect((await captureLocation())?.location.address).toBe(UNKNOWN_ADDRESS);
});

it('returns undefined when permission is denied', async () => {
  permission.mockResolvedValue({ status: 'denied' });
  expect(await captureLocation()).toBeUndefined();
  expect(current).not.toHaveBeenCalled();
});

it('still gets a fresh fix when getLastKnownPositionAsync throws', async () => {
  last.mockRejectedValue(new Error('no cache'));
  expect((await captureLocation())?.location).toMatchObject({ latitude: 37.7, longitude: -122.4 });
});

it('returns undefined when there are no coordinates at all', async () => {
  current.mockRejectedValue(new Error('no GPS'));
  expect(await captureLocation()).toBeUndefined();
});

it('addressFor never throws', async () => {
  geocode.mockRejectedValue(new Error('offline'));
  await expect(addressFor(1, 2)).resolves.toBe(UNKNOWN_ADDRESS);
});

it('awaitLocation gives up after LOCATION_WAIT_MS', async () => {
  jest.useFakeTimers();
  try {
    const waiting = awaitLocation(new Promise(() => {}));
    jest.advanceTimersByTime(LOCATION_WAIT_MS);
    await expect(waiting).resolves.toBeUndefined();
    await expect(awaitLocation(null)).resolves.toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});
