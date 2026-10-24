// The Assistant's microphone as a stream (H2-5.6): 100 ms mono frames at 24 kHz, each
// sent as base64 PCM16 in an input_audio_buffer.append. Nothing is written to disk.
//
// It never touches the audio session: the screen holds acquireConversation first.
import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import { AudioProcessor, AUDIO_SPECS, floatTo16BitPCM } from '../utils/audioProcessor';

export const MIC_FRAME_SAMPLES = 2400; // 100 ms at 24 kHz

export interface MicStream {
  stop(): Promise<void>;
}

let recorder: AudioRecorder | null = null;

export async function startMicStream(onFrame: (base64Pcm16: string) => void): Promise<MicStream> {
  if ((await AudioManager.requestRecordingPermissions()) !== 'Granted') {
    throw new Error('Microphone permission denied');
  }
  const mic = recorder ?? (recorder = new AudioRecorder());
  mic.onAudioReady(
    { sampleRate: AUDIO_SPECS.SAMPLE_RATE, bufferLength: MIC_FRAME_SAMPLES, channelCount: 1 },
    ({ buffer }) => onFrame(AudioProcessor.bytesToBase64(floatTo16BitPCM(buffer.getChannelData(0)))),
  );
  const started = await mic.start();
  if (started.status === 'error') {
    mic.clearOnAudioReady();
    throw new Error(started.message);
  }
  let stopped = false;
  return {
    async stop() {
      if (stopped) return;
      stopped = true;
      mic.clearOnAudioReady();
      await mic.stop();
    },
  };
}
