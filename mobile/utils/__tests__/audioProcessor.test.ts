// C-26: assistant audio deltas are decoded one by one, never joined as base64 text.
// H2-5.5: replies are PCM16 at 24 kHz, turned into float samples for the buffer queue.
// configureAudioRecording still imports expo-av until Task 8 removes it
jest.mock('expo-av', () => ({ Audio: {} }));

import { AudioProcessor, floatTo16BitPCM, pcm16ToFloat32 } from '../audioProcessor';

describe('C-26 audio chunks', () => {
  // Two deltas whose byte lengths aren't multiples of 3, so each ends in '=' padding.
  const chunks = ['AQ==', 'AgM='];

  it('joining the base64 strings (the old way) is not valid base64', () => {
    expect(() => AudioProcessor.base64ToArrayBuffer(chunks.join(''))).toThrow();
  });

  it('decodes each padded chunk on its own', () => {
    expect(chunks.map(c => Array.from(AudioProcessor.base64ToArrayBuffer(c)))).toEqual([[1], [2, 3]]);
  });

  it('bytesToBase64 round-trips through base64ToArrayBuffer, including large buffers', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 256);
    const back = AudioProcessor.base64ToArrayBuffer(AudioProcessor.bytesToBase64(big));
    expect(back.length).toBe(big.length);
    expect(Array.from(back.subarray(0, 300))).toEqual(Array.from(big.subarray(0, 300)));
    expect(back[99_999]).toBe(big[99_999]);
  });
});

describe('H2-5.5 PCM16 helpers', () => {
  it('pcm16ToFloat32 decodes little-endian samples', () => {
    expect(Array.from(pcm16ToFloat32(new Uint8Array([0x00, 0x80, 0xff, 0x7f, 0, 0, 9]))))
      .toEqual([-1, 32767 / 32768, 0]);
  });

  it('floatTo16BitPCM clamps and encodes little-endian', () => {
    expect(Array.from(floatTo16BitPCM(new Float32Array([-1.5, 1.5, 0])))).toEqual([0x00, 0x80, 0xff, 0x7f, 0, 0]);
  });

  it('a PCM16 round trip is lossless for in-range samples', () => {
    const bytes = floatTo16BitPCM(new Float32Array([-1, -0.5, -0.25, 0, 0.25, 0.5]));
    expect(Array.from(floatTo16BitPCM(pcm16ToFloat32(bytes)))).toEqual(Array.from(bytes));
  });
});
