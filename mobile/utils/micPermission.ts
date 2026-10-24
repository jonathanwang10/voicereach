// The mic is asked for on the first Record tap, not when the tab opens (H2-6.3). A
// denial can't be asked again by iOS, so it points the worker at Settings.
import { Alert, Linking } from 'react-native';
import { showApiError } from './errors';

export const ensureMicPermission = async (
  request: () => Promise<{ granted: boolean }>,
): Promise<boolean> => {
  try {
    const { granted } = await request();
    if (granted) return true;
    Alert.alert(
      'Microphone access is off',
      'VoiceReach needs the microphone to record. Turn it on in Settings.',
      [{ text: 'Cancel', style: 'cancel' }, { text: 'Open Settings', onPress: () => Linking.openSettings() }],
    );
    return false;
  } catch {
    showApiError('Could not check microphone access. Please try again.', 'Recording failed');
    return false;
  }
};
