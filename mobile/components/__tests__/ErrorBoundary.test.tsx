// H2-6.7: a render error shows a Restart screen instead of a white screen.
import React from 'react';
import { Text } from 'react-native';
import { fireEvent, render } from '@testing-library/react-native';
import { ErrorBoundary } from '../ErrorBoundary';

beforeEach(() => jest.spyOn(console, 'error').mockImplementation(() => {}));
afterEach(() => jest.restoreAllMocks());

it('shows "Something went wrong." with Restart, and Restart remounts the children (H2-6.7)', () => {
  let explode = true;
  const Bomb = () => {
    if (explode) throw new Error('boom');
    return <Text>fine</Text>;
  };
  const onReset = jest.fn();
  const s = render(<ErrorBoundary onReset={onReset}><Bomb /></ErrorBoundary>);
  expect(s.getByText('Something went wrong.')).toBeTruthy();
  expect(s.getByRole('button', { name: 'Restart' })).toBeTruthy();
  explode = false;
  fireEvent.press(s.getByText('Restart'));
  expect(onReset).toHaveBeenCalled();
  expect(s.getByText('fine')).toBeTruthy();
});

it('renders the children when nothing fails', () => {
  const s = render(<ErrorBoundary><Text>ok</Text></ErrorBoundary>);
  expect(s.getByText('ok')).toBeTruthy();
});
