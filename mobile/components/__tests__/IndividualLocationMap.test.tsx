// C-03: the profile map shows the person's own last location, and no pin without one.
import React from 'react';
import { render } from '@testing-library/react-native';

jest.mock('react-native-maps', () => {
  const React = require('react');
  const { View } = require('react-native');
  const MapView = (props: any) => <View testID="map" {...props} />;
  const Marker = (props: any) => <View testID="marker" {...props} />;
  return { __esModule: true, default: MapView, MapView, Marker };
});

import IndividualLocationMap from '../IndividualLocationMap';

const profile = (last_location: any) => ({
  id: 'p1', name: 'Ann', urgency_score: 0, data: {}, created_at: '', updated_at: '',
  interactions: [], total_interactions: 0, last_seen: '', last_location,
}) as any;

it('pins and centres the map on the stored location', () => {
  const screen = render(<IndividualLocationMap profile={profile({
    latitude: 37.7599, longitude: -122.4148, address: '2400 Mission St San Francisco CA',
  })} />);
  expect(screen.getByTestId('marker').props.coordinate).toEqual({ latitude: 37.7599, longitude: -122.4148 });
  const map = screen.getByTestId('map');
  expect(map.props.initialRegion).toMatchObject({ latitude: 37.7599, longitude: -122.4148 });
  expect(map.props.region).toBeUndefined();
  expect(screen.getByText('37.7599, -122.4148')).toBeTruthy();
});

it('shows no pin and says so when there is no stored location', () => {
  const screen = render(<IndividualLocationMap profile={profile(null)} />);
  expect(screen.queryByTestId('marker')).toBeNull();
  expect(screen.getByText('No stored location for this individual.')).toBeTruthy();
  expect(screen.queryByText(/37\.7821/)).toBeNull();
});
