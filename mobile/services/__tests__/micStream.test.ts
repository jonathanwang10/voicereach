// H2-5.6: the Assistant's mic streams 100 ms PCM16 frames at 24 kHz over the proxy.
import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import { MIC_FRAME_SAMPLES, startMicStream } from '../micStream';

const proto = AudioRecorder.prototype as any;

beforeEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
  (AudioManager.requestRecordingPermissions as jest.Mock).mockResolvedValue('Granted');
});

it('asks the recorder for 100 ms mono frames at 24 kHz', async () => {
  const onAudioReady = jest.spyOn(proto, 'onAudioReady');
  const start = jest.spyOn(proto, 'start');
  await startMicStream(jest.fn());
  expect(MIC_FRAME_SAMPLES).toBe(2400);
  expect(onAudioReady).toHaveBeenCalledWith({ sampleRate: 24000, bufferLength: 2400, channelCount: 1 }, expect.any(Function));
  expect(start).toHaveBeenCalledTimes(1);
  expect(onAudioReady.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]);
});

it('hands each frame on as base64 PCM16', async () => {
  const onAudioReady = jest.spyOn(proto, 'onAudioReady');
  const onFrame = jest.fn();
  await startMicStream(onFrame);
  const callback = onAudioReady.mock.calls[0][1] as (e: any) => void;
  callback({ buffer: { getChannelData: () => new Float32Array([0, 1, -1]) }, numFrames: 3, when: 0 });
  expect(onFrame).toHaveBeenCalledWith('AAD/fwCA');   // 00 00 ff 7f 00 80
});

it('refuses to start without the microphone permission', async () => {
  (AudioManager.requestRecordingPermissions as jest.Mock).mockResolvedValue('Denied');
  const start = jest.spyOn(proto, 'start');
  await expect(startMicStream(jest.fn())).rejects.toThrow('Microphone permission denied');
  expect(start).not.toHaveBeenCalled();
});

it('a recorder that fails to start rejects and clears its callback', async () => {
  jest.spyOn(proto, 'start').mockResolvedValue({ status: 'error', message: 'busy' });
  const clear = jest.spyOn(proto, 'clearOnAudioReady');
  await expect(startMicStream(jest.fn())).rejects.toThrow('busy');
  expect(clear).toHaveBeenCalled();
});

it('stop clears the frame callback and stops, and is safe twice', async () => {
  const clear = jest.spyOn(proto, 'clearOnAudioReady');
  const stop = jest.spyOn(proto, 'stop');
  const mic = await startMicStream(jest.fn());
  await mic.stop();
  await mic.stop();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(clear.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);
});
