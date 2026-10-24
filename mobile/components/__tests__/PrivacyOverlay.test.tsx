// H2-6.14: the app switcher's snapshot never shows case data.
import React from 'react';
import { AppState, StyleSheet } from 'react-native';
import { act, render } from '@testing-library/react-native';

// The overlay is hidden from VoiceOver on purpose, so queries must include hidden elements
const HIDDEN = { includeHiddenElements: true };
import { PrivacyOverlay, PRIVACY_OVERLAY_TEXT } from '../PrivacyOverlay';

let emit: (s: string) => void = () => {};
const remove = jest.fn();
beforeEach(() => {
  jest.spyOn(AppState, 'addEventListener').mockImplementation(((_t: string, h: any) => {
    emit = h;
    return { remove };
  }) as any);
});
afterEach(() => jest.restoreAllMocks());

it('covers the screen with the app name when the app is inactive or in the background (H2-6.14)', () => {
  const s = render(<PrivacyOverlay />);
  expect(PRIVACY_OVERLAY_TEXT).toBe('VoiceReach');
  expect(s.queryByText('VoiceReach', HIDDEN)).toBeNull();
  act(() => emit('inactive'));
  expect(s.getByText('VoiceReach', HIDDEN)).toBeTruthy();
  act(() => emit('background'));
  expect(s.getByText('VoiceReach', HIDDEN)).toBeTruthy();
  act(() => emit('active'));
  expect(s.queryByText('VoiceReach', HIDDEN)).toBeNull();
});

it('stays hidden for "unknown"', () => {
  const s = render(<PrivacyOverlay />);
  act(() => emit('unknown'));
  expect(s.queryByText('VoiceReach', HIDDEN)).toBeNull();
});

it('is opaque, on top, and ignored by touches and VoiceOver', () => {
  const s = render(<PrivacyOverlay />);
  act(() => emit('background'));
  const cover = s.getByTestId('privacy-overlay', HIDDEN);
  const style = StyleSheet.flatten(cover.props.style);
  expect(style).toMatchObject({ position: 'absolute', zIndex: 1000 });
  expect(style.backgroundColor).toBeTruthy();
  expect(cover.props.pointerEvents).toBe('none');
  expect(cover.props.importantForAccessibility).toBe('no-hide-descendants');
});

it('stops listening on unmount', () => {
  render(<PrivacyOverlay />).unmount();
  expect(remove).toHaveBeenCalled();
});
