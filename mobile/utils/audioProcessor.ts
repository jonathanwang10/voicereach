/**
 * Audio helpers for the Realtime API: base64 <-> bytes, and PCM16 <-> float samples.
 */

import { Audio } from 'expo-av';

// Audio format specifications for GPT Realtime API
export const AUDIO_SPECS = {
  SAMPLE_RATE: 24000, // 24kHz as specified in GPT Realtime docs
  CHANNELS: 1,        // Mono
  BIT_DEPTH: 16,      // 16-bit
  BYTES_PER_SAMPLE: 2 // 16-bit = 2 bytes per sample
};

export class AudioProcessor {
  /**
   * Convert Base64 to ArrayBuffer
   */
  static base64ToArrayBuffer(base64: string): Uint8Array {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    
    return bytes;
  }

  /**
   * Encode bytes as base64 (built in slices so large buffers don't overflow the call stack).
   */
  static bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const slice = 0x8000;
    for (let i = 0; i < bytes.length; i += slice) {
      binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + slice)));
    }
    return btoa(binary);
  }
}

/**
 * PCM16 little-endian bytes to float samples in [-1, 1) (H2-5.5). A trailing odd byte
 * is ignored; the caller carries it into the next chunk.
 */
export function pcm16ToFloat32(bytes: Uint8Array): Float32Array {
  const count = bytes.length >> 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset, count * 2);
  const out = new Float32Array(count);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** Float samples to PCM16 little-endian bytes, clamped to [-1, 1]. */
export function floatTo16BitPCM(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return out;
}

/**
 * Helper function to configure audio recording for optimal results
 */
export const configureAudioRecording = async (): Promise<void> => {
  try {
    // Request audio permissions
    const { status } = await Audio.requestPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('Audio recording permission not granted');
    }

    // Configure audio mode for recording
    await Audio.setAudioModeAsync({
      allowsRecordingIOS: true,
      playsInSilentModeIOS: true,
      shouldDuckAndroid: true,
      playThroughEarpieceAndroid: false,
      staysActiveInBackground: false,
    });
  } catch (error) {
    if (__DEV__) console.warn('Failed to configure audio recording:', error);
    throw error;
  }
};
