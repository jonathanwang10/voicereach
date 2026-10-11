// C-62: the "secondary" badge had no colours, so the semantic-match percentage
// (white text) was invisible on a white card.
import React from 'react';
import { StyleSheet, Text } from 'react-native';
import { render } from '@testing-library/react-native';
import { Badge } from '../Badge';
import { theme } from '../../../theme';

it('secondary has a solid background that white text can be read on', () => {
  const screen = render(<Badge variant="secondary"><Text>73%</Text></Badge>);
  const bg = StyleSheet.flatten((screen.toJSON() as any).props.style).backgroundColor;
  expect(bg).toBe(theme.colors.neutral[600]);
});

it('primary (used for exact/details matches with white text) is a solid colour too', () => {
  const screen = render(<Badge variant="primary"><Text>Exact</Text></Badge>);
  expect(StyleSheet.flatten((screen.toJSON() as any).props.style).backgroundColor).toBe(theme.colors.primary[600]);
});
