// H2-6.3: the mic is asked for on the first Record tap; a denial offers Open Settings.
jest.mock('react-native-toast-message', () => ({ __esModule: true, default: { show: jest.fn() } }));

import { Alert, Linking } from 'react-native';
import Toast from 'react-native-toast-message';
import { ensureMicPermission } from '../micPermission';

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

it('a denial offers Open Settings, which opens the app settings (H2-6.3)', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  const open = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
  expect(await ensureMicPermission(async () => ({ granted: false }))).toBe(false);
  expect(alert.mock.calls[0][0]).toBe('Microphone access is off');
  expect(alert.mock.calls[0][1]).toBe('VoiceReach needs the microphone to record. Turn it on in Settings.');
  const buttons = alert.mock.calls[0][2]!;
  expect(buttons.map(b => b.text)).toEqual(['Cancel', 'Open Settings']);
  buttons[1].onPress!();
  expect(open).toHaveBeenCalled();
});

it('a grant returns true with no alert', async () => {
  const alert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});
  expect(await ensureMicPermission(async () => ({ granted: true }))).toBe(true);
  expect(alert).not.toHaveBeenCalled();
});

it('a failed check says so and returns false', async () => {
  expect(await ensureMicPermission(async () => { throw new Error('native'); })).toBe(false);
  expect((Toast.show as jest.Mock).mock.calls[0][0]).toMatchObject({
    text1: 'Recording failed', text2: 'Could not check microphone access. Please try again.' });
});
