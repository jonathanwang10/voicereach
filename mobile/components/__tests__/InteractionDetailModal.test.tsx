// C-09: the interaction's changed fields skip empty values and never show "null"
// or [object Object].
import React from 'react';
import { render } from '@testing-library/react-native';
import InteractionDetailModal from '../InteractionDetailModal';

it('renders changes without null rows, joining lists and showing a location address', () => {
  const interaction: any = {
    id: 'i1', individual_id: 'p1', user_id: '', created_at: '2026-01-01T00:00:00Z',
    data: {
      name: 'Ann',
      behavior: null,
      notes: '',
      medical_conditions: ['Diabetes', 'Mental Health'],
      usual_spot: { latitude: 1, longitude: 2, address: '5th & Market' },
    },
  };
  const screen = render(<InteractionDetailModal visible interaction={interaction} onClose={jest.fn()} />);
  expect(screen.queryByText('null')).toBeNull();
  expect(screen.queryByText('Behavior:')).toBeNull();
  expect(screen.queryByText('Notes:')).toBeNull();
  expect(screen.queryByText('[object Object]')).toBeNull();
  expect(screen.getByText('Diabetes, Mental Health')).toBeTruthy();
  expect(screen.getByText('5th & Market')).toBeTruthy();
  expect(screen.getByText('Ann')).toBeTruthy();
});
