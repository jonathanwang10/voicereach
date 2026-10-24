// H2-7.8: every file the app writes (queued audio, Expo's upload copy, the queue's
// SQLite database) is unreadable while the phone is locked.
import appJson from '../app.json';

it('gives every app file iOS Data Protection Complete (H2-7.8)', () => {
  expect((appJson.expo.ios as any).entitlements).toEqual({ 'com.apple.developer.default-data-protection': 'NSFileProtectionComplete' });
});
