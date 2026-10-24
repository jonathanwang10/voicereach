import React from 'react';
import { Alert } from 'react-native';
import { render, fireEvent, waitFor, act } from '@testing-library/react-native';
import { LocationPicker } from '../LocationPicker';

// Mock expo-location
jest.mock('expo-location', () => ({
  Accuracy: { High: 4, Balanced: 3 },
  requestForegroundPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
  getCurrentPositionAsync: jest.fn(() => Promise.resolve({
    coords: {
      latitude: 37.80808794862037,
      longitude: -122.43016054168524,
    }
  })),
  reverseGeocodeAsync: jest.fn(() => Promise.resolve([{
    street: 'Market Street',
    city: 'San Francisco',
    region: 'CA'
  }])),
}));

// Mock react-native-maps: the map exposes animateToRegion through its ref
const mockAnimateToRegion = jest.fn();
jest.mock('react-native-maps', () => {
  const ReactActual = require('react');
  const { View } = require('react-native');
  const MapView = ReactActual.forwardRef((props: any, ref: any) => {
    ReactActual.useImperativeHandle(ref, () => ({ animateToRegion: mockAnimateToRegion }));
    return ReactActual.createElement(View, { testID: 'map', ...props });
  });
  return { __esModule: true, default: MapView, MapView, Marker: View };
});

describe('LocationPicker', () => {
  const mockOnLocationSelected = jest.fn();
  const mockOnCancel = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('renders correctly', async () => {
    const { getByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(getByText('Select Location')).toBeTruthy();
      expect(getByText('Tap and drag the pin to adjust the location')).toBeTruthy();
    });
  });

  it('shows loading state initially', () => {
    const { getByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );

    expect(getByText('Getting your location...')).toBeTruthy();
  });

  // C-04: the picker still opens on the map when permission is denied, at the SF default
  it('shows the map at the SF default when permission is denied', async () => {
    const expoLocation = require('expo-location');
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    const { getByText, queryByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => expect(getByText('Select Location')).toBeTruthy());
    expect(getByText(/Location permission denied/)).toBeTruthy();
    expect(queryByText('Try Again')).toBeNull();
    fireEvent.press(getByText('Confirm Location'));
    await waitFor(() => expect(mockOnLocationSelected).toHaveBeenCalledWith({
      location: { latitude: 37.7821638619815, longitude: -122.41033921502972, address: 'Market Street San Francisco CA' },
    }));
  });

  // C-04: with a GPS fix and no initial location, the pin starts at the fix
  it('defaults the pin to the current GPS fix', async () => {
    const { getByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => expect(getByText('Select Location')).toBeTruthy());
    fireEvent.press(getByText('Confirm Location'));
    await waitFor(() => expect(mockOnLocationSelected).toHaveBeenCalledWith({
      location: { latitude: 37.80808794862037, longitude: -122.43016054168524, address: 'Market Street San Francisco CA' },
    }));
  });

  // C-04: a location the screen already has wins over the fix
  it('starts at the initial location when one is passed', async () => {
    const { getByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
        initialLocation={{ latitude: 37.75, longitude: -122.41 }}
      />
    );

    await waitFor(() => expect(getByText('Select Location')).toBeTruthy());
    fireEvent.press(getByText('Confirm Location'));
    await waitFor(() => expect(mockOnLocationSelected).toHaveBeenCalledWith({
      location: { latitude: 37.75, longitude: -122.41, address: 'Market Street San Francisco CA' },
    }));
  });

  // Fix round 1 (#3): an older geocode that resolves late must not overwrite the newer pin's address
  it('ignores a stale address lookup after the pin moves again', async () => {
    const expoLocation = require('expo-location');
    const { getByText, findByText, UNSAFE_getByProps } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );
    await findByText(/Address: Market Street/);

    let finishOld: (v: any) => void = () => {};
    expoLocation.reverseGeocodeAsync
      .mockReturnValueOnce(new Promise(r => { finishOld = r; }))
      .mockResolvedValueOnce([{ street: 'New St', city: 'San Francisco', region: 'CA' }]);
    const drag = (latitude: number, longitude: number) =>
      fireEvent(UNSAFE_getByProps({ draggable: true }), 'dragEnd', { nativeEvent: { coordinate: { latitude, longitude } } });

    drag(37.71, -122.41);
    drag(37.72, -122.42);
    await findByText(/Address: New St/);
    await act(async () => finishOld([{ street: 'Old St', city: 'San Francisco', region: 'CA' }]));
    expect(getByText(/Address: New St/)).toBeTruthy();

    fireEvent.press(getByText('Confirm Location'));
    await waitFor(() => expect(mockOnLocationSelected).toHaveBeenCalledWith({
      location: { latitude: 37.72, longitude: -122.42, address: 'New St San Francisco CA' },
    }));
  });

  it('confirms coordinates without an address (H2-6.2)', async () => {
    const expoLocation = require('expo-location');
    expoLocation.reverseGeocodeAsync.mockRejectedValue(new Error('offline'));
    const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
    try {
      const { getByText } = render(
        <LocationPicker onLocationSelected={mockOnLocationSelected} onCancel={mockOnCancel} />
      );
      await waitFor(() => expect(getByText('Confirm Location')).toBeTruthy());
      fireEvent.press(getByText('Confirm Location'));
      await waitFor(() => expect(mockOnLocationSelected).toHaveBeenCalledWith({
        location: expect.objectContaining({ address: 'Unknown Address' }) }));
      expect(alert).not.toHaveBeenCalled();
    } finally {
      expoLocation.reverseGeocodeAsync.mockReset();
      expoLocation.reverseGeocodeAsync.mockImplementation(() => Promise.resolve([{
        street: 'Market Street', city: 'San Francisco', region: 'CA' }]));
      alert.mockRestore();
    }
  });

  it('gives the map an initialRegion and animates to a newly picked point instead of a controlled region', async () => {
    const { getByTestId } = render(
      <LocationPicker onLocationSelected={mockOnLocationSelected} onCancel={mockOnCancel} />
    );
    await waitFor(() => expect(getByTestId('map')).toBeTruthy());
    const map = getByTestId('map');
    expect(map.props.region).toBeUndefined();
    expect(map.props.initialRegion).toMatchObject({ latitude: 37.80808794862037, longitude: -122.43016054168524 });
    fireEvent(map, 'press', { nativeEvent: { coordinate: { latitude: 37.7, longitude: -122.4 } } });
    await waitFor(() => expect(mockAnimateToRegion).toHaveBeenCalledWith(
      expect.objectContaining({ latitude: 37.7, longitude: -122.4 }), expect.any(Number)));
  });

  it('calls onCancel when cancel button is pressed', async () => {
    const { getByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      const cancelButton = getByText('Cancel');
      fireEvent.press(cancelButton);
      expect(mockOnCancel).toHaveBeenCalled();
    });
  });
}); 