// Streams the assistant's spoken reply as it arrives (H2-5.5): each Realtime audio
// delta (PCM16, 24 kHz mono) becomes one AudioBuffer on a buffer queue, so playback
// starts with the first chunk and no file is written. One item plays at a time.
//
// The player never touches the audio session: the screen asks services/audioSession
// for playback and calls play() once it has it.
import { AudioContext } from 'react-native-audio-api';
import { AUDIO_SPECS, pcm16ToFloat32 } from '../utils/audioProcessor';

export interface ReplyPlayer {
  begin(itemId: string): void;                  // stops any other item (running its onDone); holds chunks until play()
  push(itemId: string, pcm: Uint8Array): void;  // ignored unless itemId is current; an odd byte carries to the next chunk
  play(itemId: string): void;                   // the session is ready: enqueue what's held and start
  end(itemId: string, onDone: () => void): void; // no more chunks; onDone once the last buffer has played (at once if none)
  stop(): { itemId: string | null; playedMs: number }; // immediate; runs the stopped item's onDone
  current(): string | null;
  close(): Promise<void>;
}

const RATE = AUDIO_SPECS.SAMPLE_RATE;

type Item = {
  id: string;
  source: any | null;          // the item's buffer queue, from play() on
  held: any[];                 // buffers pushed before play()
  queued: { bufferId: string; ms: number }[];
  carry: Uint8Array | null;    // an odd trailing byte
  ended: boolean;
  onDone: (() => void) | null;
  endedMs: number;             // durations of the buffers that have finished
  lastBoundary: number;        // ctx.currentTime at start or at the last finished buffer
};

export function createReplyPlayer(): ReplyPlayer {
  let ctx: AudioContext | null = null;
  let item: Item | null = null;

  const context = () => ctx ?? (ctx = new AudioContext({ sampleRate: RATE }));

  // Drop the item without stopping native playback; returns its onDone
  const detach = (): (() => void) | null => {
    if (!item) return null;
    const { source, onDone } = item;
    if (source) source.onBufferEnded = null;
    item = null;
    return onDone;
  };

  const finishIfDrained = () => {
    if (!item || !item.ended) return;
    // After play(): everything queued has played. Before it: nothing is held.
    if (item.source ? item.queued.length === 0 : item.held.length === 0) detach()?.();
  };

  const enqueue = (current: Item, buffer: any) => {
    const bufferId = current.source.enqueueBuffer(buffer);
    current.queued.push({ bufferId, ms: buffer.duration * 1000 });
  };

  const toBuffer = (bytes: Uint8Array) => {
    const audio = context();
    const samples = pcm16ToFloat32(bytes);
    const buffer = audio.createBuffer(1, samples.length, RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    return buffer;
  };

  const stop = () => {
    if (!item) return { itemId: null, playedMs: 0 };
    const current = item;
    let playedMs = 0;
    if (current.source) {
      const playing = current.queued[0]?.ms ?? 0;
      const sinceBoundary = Math.max(0, (context().currentTime - current.lastBoundary) * 1000);
      playedMs = Math.floor(current.endedMs + Math.min(sinceBoundary, playing));
      try {
        current.source.clearBuffers();
        current.source.stop();
      } catch {
        // already stopped
      }
    }
    detach()?.();
    return { itemId: current.id, playedMs };
  };

  return {
    begin(itemId) {
      if (item?.id === itemId) return;
      stop();
      item = {
        id: itemId, source: null, held: [], queued: [], carry: null,
        ended: false, onDone: null, endedMs: 0, lastBoundary: 0,
      };
    },

    push(itemId, pcm) {
      const current = item;
      if (!current || current.id !== itemId || current.ended) return;
      let bytes = pcm;
      if (current.carry) {
        bytes = new Uint8Array(current.carry.length + pcm.length);
        bytes.set(current.carry);
        bytes.set(pcm, current.carry.length);
        current.carry = null;
      }
      if (bytes.length % 2) {
        current.carry = bytes.slice(bytes.length - 1);
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) return;
      const buffer = toBuffer(bytes);
      if (current.source) enqueue(current, buffer);
      else current.held.push(buffer);
    },

    play(itemId) {
      const current = item;
      if (!current || current.id !== itemId || current.source) return;
      const audio = context();
      const source = audio.createBufferQueueSource();
      source.connect(audio.destination);
      source.onBufferEnded = ({ bufferId }: { bufferId: string }) => {
        if (item !== current) return;
        const index = current.queued.findIndex(b => b.bufferId === bufferId);
        if (index < 0) return;
        const [done] = current.queued.splice(index, 1);
        current.endedMs += done.ms;
        current.lastBoundary = audio.currentTime;
        finishIfDrained();
      };
      current.source = source;
      current.held.splice(0).forEach(buffer => enqueue(current, buffer));
      current.lastBoundary = audio.currentTime;
      source.start();
      finishIfDrained();
    },

    end(itemId, onDone) {
      if (!item || item.id !== itemId) {
        onDone();
        return;
      }
      item.ended = true;
      item.onDone = onDone;
      finishIfDrained();
    },

    stop,

    current: () => item?.id ?? null,

    async close() {
      stop();
      const audio = ctx;
      ctx = null;
      await audio?.close().catch(() => {});
    },
  };
}
