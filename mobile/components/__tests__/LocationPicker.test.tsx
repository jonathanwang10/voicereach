import React from 'react';
import { render, fireEvent, waitFor } from '@testing-library/react-native';
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

// Mock react-native-maps
jest.mock('react-native-maps', () => {
  const { View } = require('react-native');
  const MapView = (props: any) => <View {...props} />;
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