// C-24: playback switches the iOS audio session out of record mode (speaker, not earpiece).
// C-26: assistant audio deltas are decoded one by one and joined as bytes.
jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ status: 'granted' }),
  },
}));

import { Audio } from 'expo-av';
import { AudioProcessor, configureAudioPlayback, configureAudioRecording } from '../audioProcessor';

beforeEach(() => jest.clearAllMocks());

describe('C-26 audio chunks', () => {
  // Two deltas whose byte lengths aren't multiples of 3, so each ends in '=' padding.
  const chunks = ['AQ==', 'AgM='];

  it('joining the base64 strings (the old way) is not valid base64', () => {
    expect(() => AudioProcessor.base64ToArrayBuffer(chunks.join(''))).toThrow();
  });

  it('decodes each chunk and concatenates the bytes', () => {
    const bytes = AudioProcessor.concatChunks(chunks.map(c => AudioProcessor.base64ToArrayBuffer(c)));
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it('concatChunks of nothing is empty', () => {
    expect(AudioProcessor.concatChunks([]).length).toBe(0);
  });

  it('bytesToBase64 round-trips through base64ToArrayBuffer, including large buffers', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    const back = AudioProcessor.base64ToArrayBuffer(AudioProcessor.bytesToBase64(big));
    expect(back.length).toBe(big.length);
    expect(Array.from(back.subarray(0, 300))).toEqual(Array.from(big.subarray(0, 300)));
    expect(back[99_999]).toBe(big[99_999]);
  });
});

describe('C-24 audio session mode', () => {
  it('playback mode turns iOS recording off and plays in silent mode', async () => {
    await configureAudioPlayback();
    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecordingIOS: false, playsInSilentModeIOS: true })
    );
  });

  it('recording mode turns iOS recording back on', async () => {
    await configureAudioRecording();
    expect(Audio.setAudioModeAsync).toHaveBeenCalledWith(
      expect.objectContaining({ allowsRecordingIOS: true, playsInSilentModeIOS: true })
    );
  });
});
