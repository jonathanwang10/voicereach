// H2-5.5: assistant replies stream through one buffer queue per item.
// audioProcessor still imports expo-av (configureAudioRecording) until Task 8 removes it
jest.mock('expo-av', () => ({ Audio: {} }));
const mockCtx: any = { currentTime: 0, sources: [] as any[] };
jest.mock('react-native-audio-api', () => ({
  AudioContext: jest.fn().mockImplementation(() => {
    mockCtx.destination = {};
    mockCtx.createBuffer = jest.fn((channels: number, length: number, rate: number) => ({
      length, duration: length / rate, copyToChannel: jest.fn(),
    }));
    mockCtx.createBufferQueueSource = jest.fn(() => {
      let n = 0;
      const source: any = {
        enqueued: [] as any[],
        enqueueBuffer: jest.fn((buffer: any) => { source.enqueued.push(buffer); return `b${++n}`; }),
        connect: jest.fn(),
        start: jest.fn(),
        stop: jest.fn(),
        clearBuffers: jest.fn(),
        onBufferEnded: null,
        // test hook: the native side finished one buffer
        fireEnded: (bufferId: string, isLastBufferInQueue = false) =>
          source.onBufferEnded?.({ bufferId, isLastBufferInQueue }),
      };
      mockCtx.sources.push(source);
      return source;
    });
    mockCtx.close = jest.fn(async () => {});
    return mockCtx;
  }),
}));

import { AudioContext } from 'react-native-audio-api';
import { createReplyPlayer } from '../replyPlayer';

const pcm = (bytes: number) => new Uint8Array(bytes);   // 4800 bytes = 2400 samples = 100 ms
const source = (i = 0) => mockCtx.sources[i];

beforeEach(() => {
  jest.clearAllMocks();
  mockCtx.currentTime = 0;
  mockCtx.sources = [];
});

it('creates one 24 kHz context lazily', () => {
  const player = createReplyPlayer();
  expect(AudioContext).not.toHaveBeenCalled();
  player.begin('a1');
  player.push('a1', pcm(4800));
  player.begin('a2');
  player.push('a2', pcm(4800));
  expect(AudioContext).toHaveBeenCalledTimes(1);
  expect(AudioContext).toHaveBeenCalledWith({ sampleRate: 24000 });
});

it('holds pushed chunks until play, then enqueues them in order and starts', () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.push('a1', pcm(4800));
  player.push('a1', pcm(2400));
  expect(mockCtx.sources).toHaveLength(0);
  player.play('a1');
  expect(source().connect).toHaveBeenCalledWith(mockCtx.destination);
  expect(source().enqueued.map((b: any) => b.length)).toEqual([2400, 1200]);
  expect(source().start).toHaveBeenCalledTimes(1);
  expect(source().enqueued[0].copyToChannel).toHaveBeenCalledWith(expect.any(Float32Array), 0);
});

it('chunks pushed after play are enqueued at once', () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.play('a1');
  player.push('a1', pcm(4800));
  expect(source().enqueueBuffer).toHaveBeenCalledTimes(1);
});

it('end runs onDone after the last buffer of the item has played', () => {
  const player = createReplyPlayer();
  const onDone = jest.fn();
  player.begin('a1');
  player.play('a1');
  player.push('a1', pcm(4800));
  player.push('a1', pcm(4800));
  player.end('a1', onDone);
  source().fireEnded('b1');
  expect(onDone).not.toHaveBeenCalled();
  source().fireEnded('b2', true);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(player.current()).toBeNull();
});

it('end with nothing queued runs onDone at once', () => {
  const player = createReplyPlayer();
  const onDone = jest.fn();
  player.begin('a1');
  player.play('a1');
  player.end('a1', onDone);
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(player.current()).toBeNull();
});

it('end before play waits for play, then for the held buffers', () => {
  const player = createReplyPlayer();
  const onDone = jest.fn();
  player.begin('a1');
  player.push('a1', pcm(4800));
  player.end('a1', onDone);
  expect(onDone).not.toHaveBeenCalled();
  player.play('a1');
  source().fireEnded('b1', true);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('end for an item that is not current runs onDone at once', () => {
  const onDone = jest.fn();
  createReplyPlayer().end('zz', onDone);
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('begin on another item stops the current one and runs its onDone', () => {
  const player = createReplyPlayer();
  const onDone = jest.fn();
  player.begin('a1');
  player.play('a1');
  player.push('a1', pcm(4800));
  player.end('a1', onDone);
  player.begin('a2');
  expect(onDone).toHaveBeenCalledTimes(1);
  expect(source().stop).toHaveBeenCalled();
  expect(source().clearBuffers).toHaveBeenCalled();
  expect(player.current()).toBe('a2');
});

it('stop returns the item and the milliseconds actually played', () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.push('a1', pcm(4800));
  player.push('a1', pcm(4800));
  player.play('a1');                    // at currentTime 0
  mockCtx.currentTime = 0.1;
  source().fireEnded('b1');
  mockCtx.currentTime = 0.15;
  expect(player.stop()).toEqual({ itemId: 'a1', playedMs: 150 });
  expect(source().stop).toHaveBeenCalled();
  expect(player.current()).toBeNull();
});

it('stop counts no more than the buffer that is playing', () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.push('a1', pcm(4800));
  player.play('a1');
  mockCtx.currentTime = 5;              // the end event is late
  expect(player.stop().playedMs).toBe(100);
});

it('stop before play has played nothing, and stop with nothing current is empty', () => {
  const player = createReplyPlayer();
  expect(player.stop()).toEqual({ itemId: null, playedMs: 0 });
  player.begin('a1');
  player.push('a1', pcm(4800));
  expect(player.stop()).toEqual({ itemId: 'a1', playedMs: 0 });
});

it('stop runs the stopped item\'s onDone', () => {
  const player = createReplyPlayer();
  const onDone = jest.fn();
  player.begin('a1');
  player.play('a1');
  player.push('a1', pcm(4800));
  player.end('a1', onDone);
  player.stop();
  expect(onDone).toHaveBeenCalledTimes(1);
});

it('ignores chunks for an item that is not current', () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.play('a1');
  player.push('a2', pcm(4800));
  player.play('a2');
  expect(source().enqueueBuffer).not.toHaveBeenCalled();
  expect(mockCtx.sources).toHaveLength(1);
});

it('carries an odd trailing byte into the next chunk', () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.play('a1');
  player.push('a1', pcm(4801));
  player.push('a1', pcm(4801));
  expect(source().enqueued.map((b: any) => b.length)).toEqual([2400, 2401]);
});

it('a stopped item\'s late buffer events change nothing', () => {
  const player = createReplyPlayer();
  const onDone = jest.fn();
  player.begin('a1');
  player.play('a1');
  player.push('a1', pcm(4800));
  const old = source();
  player.begin('a2');
  player.play('a2');
  player.push('a2', pcm(4800));
  player.end('a2', onDone);
  old.fireEnded('b1', true);
  expect(onDone).not.toHaveBeenCalled();
  expect(player.current()).toBe('a2');
});

it('close stops the reply and closes the context', async () => {
  const player = createReplyPlayer();
  player.begin('a1');
  player.push('a1', pcm(4800));
  await player.close();
  expect(mockCtx.close).toHaveBeenCalledTimes(1);
  expect(player.current()).toBeNull();
});
