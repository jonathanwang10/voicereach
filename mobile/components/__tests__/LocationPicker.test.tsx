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
  const MapView = (props) => <View {...props} />;
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

  it('handles location permission denied', async () => {
    // Mock permission denied (before mount, which requests permission)
    const expoLocation = require('expo-location');
    expoLocation.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: 'denied' });

    const { getByText } = render(
      <LocationPicker
        onLocationSelected={mockOnLocationSelected}
        onCancel={mockOnCancel}
      />
    );

    await waitFor(() => {
      expect(getByText('Location permission denied')).toBeTruthy();
    });
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