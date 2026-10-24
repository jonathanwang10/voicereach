// The app switcher's snapshot shows no case data (H2-6.14): while the app is inactive
// or in the background an opaque screen with the app name covers everything. React
// Native modals have their own window, so the two that show case data render it too.
import React, { useEffect, useState } from 'react';
import { AppState, AppStateStatus, StyleSheet, Text, View } from 'react-native';
import { theme } from '../theme';

export const PRIVACY_OVERLAY_TEXT = 'VoiceReach';

const covered = (state: AppStateStatus) => state === 'inactive' || state === 'background';

export function PrivacyOverlay(): React.ReactElement | null {
  const [hidden, setHidden] = useState(() => covered(AppState.currentState));

  useEffect(() => {
    const subscription = AppState.addEventListener('change', state => setHidden(covered(state)));
    return () => subscription.remove();
  }, []);

  if (!hidden) return null;
  return (
    <View
      testID="privacy-overlay"
      style={styles.cover}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={styles.name}>{PRIVACY_OVERLAY_TEXT}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  cover: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: theme.colors.background,
    zIndex: 1000,
    alignItems: 'center',
    justifyContent: 'center',
  },
  name: {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
  },
});
