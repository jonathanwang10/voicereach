// C-69: Input spread the caller's props after its own onFocus/onBlur, so a caller
// passing either replaced the focus styling. Both must run.
import React from 'react';
import { StyleSheet } from 'react-native';
import { render, fireEvent } from '@testing-library/react-native';

jest.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));

import { Input } from '../Input';
import { theme } from '../../../theme';

it("calls the caller's onFocus/onBlur and still shows the focus border", () => {
  const onFocus = jest.fn();
  const onBlur = jest.fn();
  const screen = render(<Input placeholder="Search" onFocus={onFocus} onBlur={onBlur} />);
  const input = screen.getByPlaceholderText('Search');

  fireEvent(input, 'focus');
  expect(onFocus).toHaveBeenCalledTimes(1);
  const border = () => StyleSheet.flatten((screen.toJSON() as any).children[0].props.style).borderColor;
  expect(border()).toBe(theme.colors.primary[500]);

  fireEvent(input, 'blur');
  expect(onBlur).toHaveBeenCalledTimes(1);
  expect(border()).toBe(theme.colors.border);
});
