// C-62: an undefined override is "no override" (the old `!== null` check showed
// "Manual Override" and a Clear link for it), and the colour follows the bands.
import React from 'react';
import { StyleSheet } from 'react-native';
import { render } from '@testing-library/react-native';

jest.mock('@react-native-community/slider', () => () => null);

import UrgencyScore from '../UrgencyScore';

it('an undefined override shows no Manual Override label or Clear link', () => {
  const screen = render(
    <UrgencyScore individual={{ id: 'p1', urgency_score: 40, urgency_override: undefined }} onOverrideChange={jest.fn()} />);
  expect(screen.queryByText('Manual Override')).toBeNull();
  expect(screen.queryByText('Clear')).toBeNull();
});

it('a real override (even 0) shows the label and Clear', () => {
  const screen = render(
    <UrgencyScore individual={{ id: 'p1', urgency_score: 40, urgency_override: 0 }} onOverrideChange={jest.fn()} />);
  expect(screen.getByText('Manual Override')).toBeTruthy();
  expect(screen.getByText('Clear')).toBeTruthy();
});

it('a score of 66.5 is yellow, not red', () => {
  const screen = render(
    <UrgencyScore individual={{ id: 'p1', urgency_score: 66.5, urgency_override: null }} onOverrideChange={jest.fn()} />);
  const box = (screen.toJSON() as any).children[0];
  expect(StyleSheet.flatten(box.props.style).backgroundColor).toBe('#F59E0B');
});
