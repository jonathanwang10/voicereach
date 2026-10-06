/**
 * Audio Processing Utility for GPT Realtime API
 * Converts recorded audio to exact PCM format required by OpenAI Realtime API
 */

import { Audio } from 'expo-av';

// Audio format specifications for GPT Realtime API
export const AUDIO_SPECS = {
  SAMPLE_RATE: 24000, // 24kHz as specified in GPT Realtime docs
  CHANNELS: 1,        // Mono
  BIT_DEPTH: 16,      // 16-bit
  BYTES_PER_SAMPLE: 2 // 16-bit = 2 bytes per sample
};

export interface AudioProcessingResult {
  success: boolean;
  pcmData?: Uint8Array;
  base64Data?: string;
  error?: string;
  duration?: number;
  sampleRate?: number;
}

/**
 * Convert recorded audio file to PCM format for GPT Realtime API
 */
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
   * Create WAV file from PCM data for audio playback
   */
  static createWavFile(pcmData: Uint8Array, sampleRate: number = AUDIO_SPECS.SAMPLE_RATE): ArrayBuffer {
    const dataLength = pcmData.length;
    const buffer = new ArrayBuffer(44 + dataLength);
    const view = new DataView(buffer);
    
    // WAV header
    const writeString = (offset: number, string: string) => {
      for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
      }
    };
    
    // RIFF header
    writeString(0, 'RIFF');
    view.setUint32(4, 36 + dataLength, true);
    writeString(8, 'WAVE');
    
    // fmt chunk
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true);  // audio format (PCM)
    view.setUint16(22, 1, true);  // number of channels (mono)
    view.setUint32(24, sampleRate, true); // sample rate
    view.setUint32(28, sampleRate * AUDIO_SPECS.BYTES_PER_SAMPLE, true); // byte rate
    view.setUint16(32, AUDIO_SPECS.BYTES_PER_SAMPLE, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    
    // data chunk
    writeString(36, 'data');
    view.setUint32(40, dataLength, true);
    
    // Copy PCM data
    const dataView = new Uint8Array(buffer, 44);
    dataView.set(pcmData);
    
    return buffer;
  }

  /**
   * Validate PCM data format
   */
  static validatePCMData(data: Uint8Array): boolean {
    // Check if data length meets GPT Realtime minimum requirements
    const minRequiredSize = Math.floor(0.1 * AUDIO_SPECS.SAMPLE_RATE * AUDIO_SPECS.BYTES_PER_SAMPLE); // 100ms minimum
    const maxSize = 50 * 1024 * 1024; // Maximum 50MB for audio data
    
    const isValid = data.length >= minRequiredSize && data.length <= maxSize;
    
    if (!isValid) {
      console.log('❌ PCM data validation failed:', {
        dataLength: data.length,
        minRequired: minRequiredSize,
        maxAllowed: maxSize,
        durationMs: (data.length / (AUDIO_SPECS.SAMPLE_RATE * AUDIO_SPECS.BYTES_PER_SAMPLE)) * 1000
      });
    }
    
    return isValid;
  }
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

    console.log('✅ Audio recording configured successfully');
  } catch (error) {
    console.error('❌ Failed to configure audio recording:', error);
    throw error;
  }
};
