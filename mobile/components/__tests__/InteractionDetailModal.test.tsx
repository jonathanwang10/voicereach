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

// R-10 (C-62): the Share/Export buttons only showed "would be implemented here".
it('has no placeholder Share or Export actions', () => {
  const interaction: any = { id: 'i1', individual_id: 'p1', user_id: '', created_at: '2026-01-01T00:00:00Z', data: {} };
  const screen = render(<InteractionDetailModal visible interaction={interaction} onClose={jest.fn()} />);
  expect(screen.queryByText('Share')).toBeNull();
  expect(screen.queryByText('Export')).toBeNull();
  expect(screen.queryByText('Actions')).toBeNull();
});

// Minor 1: changed fields are labelled with the category's display_name.
it('labels changed fields with the category display_name', () => {
  const interaction: any = {
    id: 'i1', individual_id: 'p1', user_id: '', created_at: '2026-01-01T00:00:00Z',
    data: { hiv_status: 'Unknown', shoe_size: 9 },
  };
  const screen = render(
    <InteractionDetailModal visible interaction={interaction} onClose={jest.fn()}
      categories={[{ name: 'hiv_status', display_name: 'HIV status', type: 'text' }]} />
  );
  expect(screen.getByText('HIV status:')).toBeTruthy();
  expect(screen.queryByText('Hiv Status:')).toBeNull();
  expect(screen.getByText('Shoe Size:')).toBeTruthy(); // no category: the key title-cased
});


// H2-2.5: a merge that drops a field records it in `_removed`
it('shows each removed field as "removed" and never the _removed list itself', () => {
  const interaction: any = { id: 'i1', individual_id: 'p1', user_id: '', created_at: '2026-01-01T00:00:00Z',
    data: { age: 41, notes: null, hiv_status: null, _removed: ['hiv_status', 'notes'] } };
  const screen = render(<InteractionDetailModal visible interaction={interaction} onClose={jest.fn()}
    categories={[{ name: 'hiv_status', display_name: 'HIV status', type: 'text' }]} />);
  expect(screen.getByText('HIV status:')).toBeTruthy();
  expect(screen.getByText('Notes:')).toBeTruthy();
  expect(screen.getAllByText('removed')).toHaveLength(2);
  expect(screen.queryByText('Removed:')).toBeNull();
  expect(screen.queryByText('hiv_status, notes')).toBeNull();
});
