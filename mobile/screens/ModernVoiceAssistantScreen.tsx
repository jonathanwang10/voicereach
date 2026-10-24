import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
  ActivityIndicator,
  SafeAreaView,
  Animated,
  AppState,
  Dimensions,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { getAuthToken } from '../services/api';
import { createReplyPlayer, ReplyPlayer } from '../services/replyPlayer';
import { acquireConversation, acquirePlayback, onChange } from '../services/audioSession';
import { MicStream, startMicStream } from '../services/micStream';
import { AudioProcessor } from '../utils/audioProcessor';
import { errorMessage } from '../utils/errorHandler';
import {
  Message,
  SPEAKING_PLACEHOLDER,
  LISTENING_PLACEHOLDER,
  PROCESSING_PLACEHOLDER,
  SPEECH_DELIVERED,
  RESPONSE_INTERRUPTED,
  FULL_DUPLEX_MIC,
  addAssistantMessage,
  addUserSpeechMessage,
  bargeInEvents,
  isIgnorableServerError,
  reconnectDelay,
  AUTH_REFUSED,
  appendAssistantText,
  audioAppendEvent,
  finalizeAssistantText,
  setMessageContent,
  setUserTranscript,
  shouldSendMicFrame,
  stopListeningEvents,
  isSocketOpen,
  userTextEvents,
  closeMessage,
  connectErrorMessage,
} from '../utils/assistantMessages';
import { API_CONFIG } from '../config/api';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { theme } from '../theme';

const { width } = Dimensions.get('window');

const toast = (text1: string, text2?: string) =>
  Toast.show({ type: 'error', text1, text2, position: 'top', visibilityTime: 3000, autoHide: true, topOffset: 50 });

// Stop a socket from calling back into the screen, then close it.
const detachAndClose = (ws: WebSocket | null) => {
  if (!ws) return;
  ws.onopen = null;
  ws.onclose = null;
  ws.onerror = null;
  ws.onmessage = null;
  ws.close();
};

// Modern Animated Recording Indicator
const ModernRecordingIndicator: React.FC = () => {
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const waveAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.2,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );

    const waveAnimation = Animated.loop(
      Animated.timing(waveAnim, {
        toValue: 1,
        duration: 2000,
        useNativeDriver: true,
      })
    );

    pulseAnimation.start();
    waveAnimation.start();

    return () => {
      pulseAnimation.stop();
      waveAnimation.stop();
    };
  }, []);

  return (
    <View style={styles.animatedContainer}>
      <Animated.View
        style={[
          styles.waveCircle,
          {
            transform: [{ scale: waveAnim }],
            opacity: waveAnim.interpolate({
              inputRange: [0, 1],
              outputRange: [0.3, 0.1],
            }),
          },
        ]}
      />
      <Animated.View
        style={[
          styles.pulseCircle,
          {
            transform: [{ scale: pulseAnim }],
          },
        ]}
      >
        <Ionicons name="mic" size={20} color={theme.colors.text.inverse} />
      </Animated.View>
      <Text style={styles.animatedText}>Recording your voice...</Text>
    </View>
  );
};

// Modern Animated Processing Indicator
const ModernProcessingIndicator: React.FC = () => {
  const rotateAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const rotateAnimation = Animated.loop(
      Animated.timing(rotateAnim, {
        toValue: 1,
        duration: 1500,
        useNativeDriver: true,
      })
    );

    rotateAnimation.start();

    return () => {
      rotateAnimation.stop();
    };
  }, []);

  const rotate = rotateAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <View style={styles.animatedContainer}>
      <Animated.View
        style={[
          styles.processingCircle,
          {
            transform: [{ rotate }],
          },
        ]}
      >
        <Ionicons name="sync" size={20} color={theme.colors.primary[600]} />
      </Animated.View>
      <Text style={styles.animatedText}>Processing your speech...</Text>
    </View>
  );
};

// Modern Animated Speaking Indicator
const ModernSpeakingIndicator: React.FC = () => {
  const wave1 = useRef(new Animated.Value(0.3)).current;
  const wave2 = useRef(new Animated.Value(0.5)).current;
  const wave3 = useRef(new Animated.Value(0.4)).current;
  const wave4 = useRef(new Animated.Value(0.6)).current;

  useEffect(() => {
    const createWaveAnimation = (animValue: Animated.Value, delay: number = 0) => {
      return Animated.loop(
        Animated.sequence([
          Animated.timing(animValue, {
            toValue: 1,
            duration: 500,
            delay,
            useNativeDriver: true,
          }),
          Animated.timing(animValue, {
            toValue: 0.3,
            duration: 500,
            useNativeDriver: true,
          }),
        ])
      );
    };

    const animations = [
      createWaveAnimation(wave1, 0),
      createWaveAnimation(wave2, 100),
      createWaveAnimation(wave3, 200),
      createWaveAnimation(wave4, 300),
    ];

    animations.forEach(anim => anim.start());

    return () => {
      animations.forEach(anim => anim.stop());
    };
  }, []);

  return (
    <View style={styles.animatedContainer}>
      <View style={styles.speakingContainer}>
        <Ionicons name="volume-high" size={20} color={theme.colors.success[600]} />
        <View style={styles.waveContainer}>
          {[wave1, wave2, wave3, wave4].map((wave, index) => (
            <Animated.View
              key={index}
              style={[
                styles.soundWave,
                {
                  transform: [{ scaleY: wave }],
                  opacity: wave,
                },
              ]}
            />
          ))}
        </View>
      </View>
      <Text style={styles.animatedText}>Assistant speaking...</Text>
    </View>
  );
};

export const ModernVoiceAssistantScreen: React.FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isListening, setIsListening] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasShownWelcome, setHasShownWelcome] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [isMuted, setIsMuted] = useState(false);

  // Streaming state lives in refs, keyed by the Realtime item id (C-25), so a socket
  // handler bound at connect time never reads stale state and chunks don't re-render.
  const playerRef = useRef<ReplyPlayer | null>(null);
  if (!playerRef.current) playerRef.current = createReplyPlayer();
  // The playback session held for the item that is playing (H2-5.5)
  const releaseRef = useRef<{ itemId: string; release: () => Promise<void> } | null>(null);
  // Items whose audio is no longer played: text only (muted, blurred, stopped, no session)
  const playbackSkippedRef = useRef<Set<string>>(new Set());
  const lastAssistantIdRef = useRef<string | null>(null); // for events that arrive without item_id
  const idCounterRef = useRef(0);
  const isMutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const isMountedRef = useRef(true);
  const scrollViewRef = useRef<ScrollView>(null);
  // The mic streaming to one socket, and the conversation session it holds (H2-5.6)
  const listeningRef = useRef<{ ws: WebSocket; mic: MicStream | null; release: () => Promise<void> } | null>(null);
  const startingListenRef = useRef(false); // a second tap while the mic starts is ignored
  // Between the server's speech_started and speech_stopped: stopping now sends what was said
  const speechItemRef = useRef<string | null>(null);
  // Reconnect (H2-5.9): the next try's index, its timer, a connect still in flight, and
  // whether the app went to the background since the socket last opened
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectingRef = useRef(false);
  const wasBackgroundedRef = useRef(false);
  // I-2: bottom tabs keep this screen mounted with its socket open. While another tab is
  // focused (e.g. Record is recording a field note), a reply shows as text only: it doesn't
  // even ask audioSession for playback, so it can't touch the shared iOS audio session.
  const isFocusedRef = useRef(true);

  const nextId = (prefix: string) => `${prefix}_${Date.now()}_${++idCounterRef.current}`;

  const scrollToEnd = () => {
    setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
  };

  // Hand back the playback session of `itemId` (any item when omitted)
  const releasePlayback = (itemId?: string) => {
    const held = releaseRef.current;
    if (!held || (itemId && held.itemId !== itemId)) return;
    releaseRef.current = null;
    held.release().catch(() => {});
  };

  // Stop the reply that is playing (C-59); its text stays. Later audio for it is skipped.
  const stopReply = () => {
    const { itemId } = playerRef.current!.stop();
    if (itemId) playbackSkippedRef.current.add(itemId);
    releasePlayback();
  };

  // The worker talked over the reply, or tapped the mic during it (H2-5.7): stop it at
  // once, then tell the model where it was cut. Nothing happens when no reply plays.
  const bargeIn = () => {
    const player = playerRef.current!;
    if (player.current() === null) return;
    const { itemId, playedMs } = player.stop();
    if (itemId) playbackSkippedRef.current.add(itemId);
    releasePlayback();
    const ws = wsRef.current;
    if (itemId && ws && isSocketOpen(ws)) {
      bargeInEvents(itemId, playedMs).forEach(event => ws.send(JSON.stringify(event)));
    }
  };

  // The first audio delta of an item: start it, and ask audioSession for playback (H2-5.5)
  const startReply = (id: string) => {
    const player = playerRef.current!;
    stopReply();                    // a new answer stops the one still playing
    player.begin(id);
    acquirePlayback('assistant').then(release => {
      if (!release) {
        // The Record tab holds the session: this reply is text only
        playbackSkippedRef.current.add(id);
        if (player.current() === id) player.stop();
        return;
      }
      // Muted, blurred, a newer reply, a recording or unmount came first: don't play
      if (player.current() !== id || !isMountedRef.current) {
        release().catch(() => {});
        return;
      }
      releaseRef.current = { itemId: id, release };
      player.play(id);
    }).catch(() => {
      playbackSkippedRef.current.add(id);
      if (player.current() === id) player.stop();
    });
  };

  // No more audio for this item: release its session once the last buffer has played
  const endReply = (id: string) => {
    playbackSkippedRef.current.add(id);
    if (playerRef.current!.current() === id) playerRef.current!.end(id, () => releasePlayback(id));
  };

  // Forget everything streamed on the old socket; text already shown stays.
  const resetStreams = () => {
    stopReply();
    playbackSkippedRef.current = new Set();
    lastAssistantIdRef.current = null;
  };

  // Leaving the tab stops the reply that is playing (its text still shows), so it never
  // plays over, or re-routes, a recording on the Record tab.
  useFocusEffect(
    useCallback(() => {
      isFocusedRef.current = true;
      return () => {
        isFocusedRef.current = false;
        stopReply();
        stopListening(false);
      };
    }, [])
  );

  useEffect(() => {
    isMountedRef.current = true;
    initializeVoiceAssistant();
    return () => {
      isMountedRef.current = false;
      detachAndClose(wsRef.current);
      wsRef.current = null;
      cancelReconnect();
      stopListening(false);
      resetStreams();
      playerRef.current?.close();
    };
  }, []);

  // The mic stops without sending when the app leaves the foreground, or when the
  // Record tab takes the audio session for a field note.
  useEffect(() => {
    const appState = AppState.addEventListener('change', state => {
      if (state === 'background' || state === 'inactive') stopListening(false);
      if (state === 'background') wasBackgroundedRef.current = true;
      // Back in the foreground with no open socket: reconnect quietly (H2-5.9)
      const ws = wsRef.current;
      const inFlight = connectingRef.current || ws?.readyState === 0;
      if (state === 'active' && !isSocketOpen(ws) && !inFlight && !reconnectTimerRef.current) {
        reconnectAttemptRef.current = 0;
        scheduleReconnect();
      }
    });
    const unsubscribe = onChange(state => {
      if (state.recordingOwner) stopListening(false);
    });
    return () => {
      appState.remove();
      unsubscribe();
    };
  }, []);

  const itemIdOf = (event: any): string | null => event.item_id || lastAssistantIdRef.current;

  const handleWebSocketEvent = (event: any) => {
    switch (event.type) {
      case 'session.created':
        setError(null);
        break;

      case 'conversation.item.created':
      case 'conversation.item.added': {
        const item = event.item;
        // Only the assistant's spoken messages get a bubble; tool calls and their
        // outputs never show.
        if (item?.type === 'message' && item.role === 'assistant' && item.id) {
          lastAssistantIdRef.current = item.id;
          setMessages(prev => addAssistantMessage(prev, item.id));
        }
        break;
      }

      case 'conversation.item.done':
        if (event.item?.role === 'assistant') scrollToEnd();
        break;

      case 'response.output_audio_transcript.delta':
      case 'response.output_text.delta': {
        // The text streams into the item's own bubble as it arrives (C-25)
        const id = itemIdOf(event);
        if (!id || !event.delta) break;
        setMessages(prev => appendAssistantText(prev, id, event.delta));
        break;
      }

      case 'response.output_audio.delta': {
        const id = itemIdOf(event);
        if (!id || !event.delta || playbackSkippedRef.current.has(id)) break;
        if (playerRef.current!.current() !== id) {
          if (isMutedRef.current || !isFocusedRef.current) {
            playbackSkippedRef.current.add(id);
            break;
          }
          startReply(id);
        }
        try {
          // C-26: decode each delta on its own; padded chunks can't be joined as text.
          playerRef.current!.push(id, AudioProcessor.base64ToArrayBuffer(event.delta));
        } catch {
          // Skip a corrupt chunk; the rest of the reply still plays.
        }
        break;
      }

      case 'response.output_audio.done': {
        const id = itemIdOf(event);
        if (id) endReply(id);
        break;
      }

      case 'response.done': {
        const status = event.response?.status;
        const fallback = !status || status === 'completed' ? SPEECH_DELIVERED : RESPONSE_INTERRUPTED;
        const outputIds: string[] = (event.response?.output || []).map((o: any) => o?.id).filter(Boolean);
        outputIds.forEach(endReply);
        // A bubble that got no text says the answer was spoken (or interrupted)
        setMessages(prev => outputIds.reduce((msgs, id) => finalizeAssistantText(msgs, id, '', fallback), prev));
        scrollToEnd();
        break;
      }

      // The worker's spoken question (H2-5.6): server VAD marks the turn, the input
      // transcription fills its bubble
      case 'input_audio_buffer.speech_started': {
        const id = event.item_id;
        if (!id) break;
        bargeIn(); // the worker started talking over the reply
        speechItemRef.current = id;
        setMessages(prev => addUserSpeechMessage(prev, id));
        scrollToEnd();
        break;
      }

      case 'input_audio_buffer.speech_stopped': {
        const id = event.item_id;
        if (speechItemRef.current === id) speechItemRef.current = null;
        if (id) setMessages(prev => setMessageContent(prev, id, PROCESSING_PLACEHOLDER));
        break;
      }

      case 'conversation.item.input_audio_transcription.completed':
      case 'conversation.item.input_audio_transcription.failed': {
        const id = event.item_id;
        if (!id) break;
        const transcript = event.type.endsWith('.completed') ? event.transcript : '';
        setMessages(prev => setUserTranscript(addUserSpeechMessage(prev, id), id, transcript));
        break;
      }

      case 'error':
        // e.g. the backend's event_not_allowed, or an upstream error: brief, not a permanent card.
        if (!isIgnorableServerError(event)) toast('Voice assistant', event.error?.message || 'Something went wrong');
        break;

      default:
        break;
    }
  };

  const toggleMute = () => {
    const next = !isMutedRef.current;
    isMutedRef.current = next;
    setIsMuted(next);
    // C-59: muting stops the reply that is playing, and keeps the text already received.
    if (next) stopReply();
  };

  const cancelReconnect = () => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    reconnectTimerRef.current = null;
  };

  // The next quiet try, after 1 s, 2 s, then 4 s; false once all three have failed.
  const scheduleReconnect = (): boolean => {
    if (reconnectTimerRef.current) return true;
    const delay = reconnectDelay(reconnectAttemptRef.current);
    if (delay === null) {
      reconnectAttemptRef.current = 0;
      return false;
    }
    reconnectAttemptRef.current += 1;
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      if (isMountedRef.current) connect({ quiet: true });
    }, delay);
    return true;
  };

  // A quiet connect (a reconnect try) shows no spinner; neither kind clears the chat.
  const connect = async ({ quiet }: { quiet: boolean }) => {
    // Detach first so a late close on the old socket can't mark the new one disconnected.
    stopListening(false);
    detachAndClose(wsRef.current);
    wsRef.current = null;
    setIsConnected(false);
    resetStreams();
    connectingRef.current = true;
    try {
      if (!quiet) {
        setIsLoading(true);
        setError(null);
      }

      const backendUrl = API_CONFIG.BASE_URL.replace(/^https?:/, (match) =>
        match === 'https:' ? 'wss:' : 'ws:'
      );
      const wsUrl = `${backendUrl}/api/voice-assistant/realtime/ws`;

      const token = await getAuthToken();
      // The screen may have unmounted during the await; don't open a socket nobody will close.
      if (!isMountedRef.current) return;
      // React Native's WebSocket accepts headers as a non-standard third argument.
      const ws: WebSocket = new (WebSocket as any)(wsUrl, null, { headers: { Authorization: `Bearer ${token}` } });
      let opened = false;
      let settled = false; // this socket's failure was already handled (error, then close)

      // A failed try schedules the next one (H2-5.9); so does a close just after a
      // resume. A refused handshake never retries; after three tries the Retry card shows.
      const fail = (message: string) => {
        stopListening(false);
        setIsConnected(false);
        if (settled) return;
        const retry = message !== AUTH_REFUSED && ((quiet && !opened) || wasBackgroundedRef.current);
        if (retry) {
          settled = true;
          if (scheduleReconnect()) return;
        }
        setError(message);
      };

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        opened = true;
        reconnectAttemptRef.current = 0;
        wasBackgroundedRef.current = false;
        setError(null);
        setIsConnected(true);
      };

      ws.onmessage = (event: any) => {
        if (wsRef.current !== ws) return;
        let data: any;
        try {
          data = JSON.parse(event.data);
        } catch {
          return;
        }
        handleWebSocketEvent(data);
      };

      // A refused handshake (bad or not-allowed token) arrives here as an HTTP 403.
      ws.onerror = (err: any) => {
        if (wsRef.current !== ws) return;
        fail(connectErrorMessage(err));
      };

      ws.onclose = (event: any) => {
        if (wsRef.current !== ws || !isMountedRef.current) return;
        fail(closeMessage(event?.code, event?.reason));
      };

      wsRef.current = ws;
    } catch (err) {
      if (!(quiet && scheduleReconnect())) {
        setError(`Couldn't connect to the voice assistant: ${errorMessage(err)}`);
      }
    } finally {
      connectingRef.current = false;
      setIsLoading(false);
    }
  };

  // Retry, the reconnect button and Clear: a fresh connect that cancels any pending try
  const initializeVoiceAssistant = () => {
    cancelReconnect();
    reconnectAttemptRef.current = 0;
    return connect({ quiet: false });
  };

  const addWelcomeMessage = () => {
    if (!hasShownWelcome) {
      const welcomeMessage: Message = {
        id: 'welcome',
        role: 'assistant',
        content: 'Quick homeless outreach assistant ready. Ask about crisis intervention, safety protocols, resources, or emergencies. Keep questions brief for fastest response.',
        timestamp: new Date(),
      };
      setMessages([welcomeMessage]);
      setHasShownWelcome(true);
    }
  };

  // Send one question: a user input_text item, then response.create (both on the backend allowlist).
  const sendQuestion = (ws: WebSocket, text: string) => {
    userTextEvents(text).forEach(event => ws.send(JSON.stringify(event)));
  };

  // Listening (H2-5.6): the mic streams 100 ms PCM16 frames to the socket that was open
  // when it started; server VAD ends the turn and starts the reply.
  const startListening = async () => {
    if (startingListenRef.current || listeningRef.current) return;
    const ws = wsRef.current;
    if (!ws || !isSocketOpen(ws) || !isConnected) {
      Alert.alert('Error', 'Voice assistant not connected');
      return;
    }
    startingListenRef.current = true;
    try {
      bargeIn(); // a tap during a reply interrupts it
      const release = await acquireConversation('assistant');
      if (!release) {
        toast('Recording on the Record tab', 'Finish that recording first.');
        return;
      }
      // The screen closed, the tab was left or the socket was replaced meanwhile
      if (!isMountedRef.current || !isFocusedRef.current || wsRef.current !== ws) {
        release().catch(() => {});
        return;
      }
      const session = { ws, mic: null as MicStream | null, release };
      listeningRef.current = session;
      try {
        const mic = await startMicStream(frame => {
          // A frame only ever goes to this session's socket
          if (listeningRef.current !== session) return;
          if (shouldSendMicFrame({
            listening: true,
            socketOpen: isSocketOpen(ws),
            replyPlaying: playerRef.current!.current() !== null,
            fullDuplex: FULL_DUPLEX_MIC,
          })) ws.send(JSON.stringify(audioAppendEvent(frame)));
        });
        if (listeningRef.current !== session) {
          mic.stop().catch(() => {}); // stopped while the mic was starting
          return;
        }
        session.mic = mic;
        setIsListening(true);
      } catch (error) {
        if (__DEV__) console.warn('Failed to start the microphone:', error);
        if (listeningRef.current === session) listeningRef.current = null;
        release().catch(() => {});
        if (isMountedRef.current) {
          Alert.alert('Microphone', 'Could not start the microphone. Check the permission in Settings.');
        }
      }
    } finally {
      startingListenRef.current = false;
    }
  };

  // The stop button sends the turn (send = true); every other stop just drops the mic.
  // Clearing listeningRef first means no frame is sent after this.
  const stopListening = (send: boolean) => {
    const session = listeningRef.current;
    if (!session) return;
    listeningRef.current = null;
    const speechItem = speechItemRef.current;
    speechItemRef.current = null;
    if (isMountedRef.current) setIsListening(false);
    session.mic?.stop().catch(() => {});
    if (send && isSocketOpen(session.ws)) {
      stopListeningEvents(speechItem !== null).forEach(event => session.ws.send(JSON.stringify(event)));
      if (speechItem && isMountedRef.current) {
        setMessages(prev => setMessageContent(prev, speechItem, PROCESSING_PLACEHOLDER));
      }
    }
    session.release().catch(() => {});
  };

  // Returns false if the question couldn't be sent, so the text box keeps it.
  const sendTextMessage = (text: string): boolean => {
    const ws = wsRef.current;
    if (!ws || !isSocketOpen(ws)) {
      Alert.alert('Error', 'Voice assistant not connected');
      return false;
    }
    setMessages(prev => [...prev, { id: nextId('user'), role: 'user', content: text, timestamp: new Date() }]);
    sendQuestion(ws, text);
    return true;
  };

  const clearConversation = () => {
    setMessages([]);
    setHasShownWelcome(false);
    // The app can't delete server-side items (not on the allowlist), so start a fresh session
    // to make the model forget the cleared conversation too.
    initializeVoiceAssistant();
  };

  const renderMessage = (message: Message) => {
    const isRecordingMessage = message.content === LISTENING_PLACEHOLDER;
    const isProcessingMessage = message.content === PROCESSING_PLACEHOLDER;
    const isSpeakingMessage = message.content === SPEAKING_PLACEHOLDER;

    return (
      <Card
        key={message.id}
        style={[
          styles.messageCard,
          message.role === 'user' ? styles.userMessageCard : styles.assistantMessageCard,
        ]}
        variant={message.role === 'user' ? 'filled' : 'elevated'}
      >
        <View style={styles.messageHeader}>
          <View style={styles.roleContainer}>
            <Ionicons
              name={message.role === 'user' ? 'person' : 'chatbubble-ellipses'}
              size={16}
              color={message.role === 'user' ? theme.colors.primary[600] : theme.colors.success[600]}
            />
            <Text style={styles.roleName}>
              {message.role === 'user' ? 'You' : 'Assistant'}
            </Text>
          </View>
          <Text style={styles.timestamp}>
            {message.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>

        {isRecordingMessage ? (
          <ModernRecordingIndicator />
        ) : isProcessingMessage ? (
          <ModernProcessingIndicator />
        ) : isSpeakingMessage ? (
          <ModernSpeakingIndicator />
        ) : (
          <Text style={styles.messageContent}>{message.content}</Text>
        )}
      </Card>
    );
  };

  const statusColor = isConnected ? theme.colors.success[600] : theme.colors.danger[600];

  if (isLoading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.loadingContainer}>
          <ActivityIndicator size="large" color={theme.colors.primary[600]} />
          <Text style={styles.loadingText}>Initializing Voice Assistant...</Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.titleContainer}>
          <Text style={styles.title}>Voice Assistant</Text>
          <Badge variant={isConnected ? 'success' : 'danger'} size="small">
            <View style={[styles.statusDot, { backgroundColor: statusColor }]} />
            <Text style={[styles.statusText, { color: statusColor }]}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </Text>
          </Badge>
        </View>

        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="small"
            icon={isMuted ? 'volume-mute' : 'volume-high'}
            accessibilityLabel={isMuted ? 'Unmute assistant voice' : 'Mute assistant voice'}
            accessibilityRole="button"
            onPress={toggleMute}
            style={styles.headerButton}
          />
          <Button
            variant="ghost"
            size="small"
            icon="refresh"
            accessibilityLabel="Reconnect voice assistant"
            accessibilityRole="button"
            onPress={initializeVoiceAssistant}
            style={styles.headerButton}
          />
          <Button
            variant="ghost"
            size="small"
            icon="trash-outline"
            accessibilityLabel="Clear conversation"
            accessibilityRole="button"
            onPress={clearConversation}
            style={styles.headerButton}
          />
        </View>
      </View>

      {/* Error Message */}
      {error && (
        <Card style={styles.errorCard} variant="outlined">
          <View style={styles.errorContent}>
            <Ionicons name="alert-circle" size={24} color={theme.colors.danger[600]} />
            <Text style={styles.errorText}>{error}</Text>
            <Button
              variant="danger"
              size="small"
              onPress={initializeVoiceAssistant}
            >
              Retry
            </Button>
          </View>
        </Card>
      )}

      {/* Messages */}
      <ScrollView
        ref={scrollViewRef}
        style={styles.messagesContainer}
        contentContainerStyle={styles.messagesContent}
        showsVerticalScrollIndicator={false}
      >
        {messages.length === 0 && !hasShownWelcome && isConnected && (
          <Card style={styles.welcomeCard} variant="filled">
            <View style={styles.welcomeContent}>
              <Ionicons name="chatbubble-ellipses" size={48} color={theme.colors.primary[600]} />
              <Text style={styles.welcomeTitle}>Fast Voice Assistant</Text>
              <Text style={styles.welcomeText}>
                Quick guidance for homeless outreach, crisis intervention, and safety protocols.
                Keep questions brief for fastest response.
              </Text>
              <Button
                variant="primary"
                onPress={addWelcomeMessage}
                style={styles.welcomeButton}
              >
                Get Started
              </Button>
            </View>
          </Card>
        )}

        {messages.map(renderMessage)}
      </ScrollView>

      {/* Controls */}
      <View style={styles.controlsContainer}>
        {/* Text Input */}
        <View style={styles.textInputContainer}>
          <Input
            placeholder="Type your question here..."
            value={textInput}
            onChangeText={setTextInput}
            multiline
            maxLength={500}
            rightIcon="send"
            rightIconAccessibilityLabel="Send question"
            onRightIconPress={textInput.trim() && isConnected ? () => { if (sendTextMessage(textInput.trim())) setTextInput(''); } : undefined}
            style={styles.textInput}
          />
        </View>

        {/* Voice Controls */}
        <View style={styles.voiceControls}>
          <TouchableOpacity
            style={[
              styles.recordButton,
              isListening && styles.recordButtonActive,
              !isConnected && styles.recordButtonDisabled,
            ]}
            onPress={() => {
              if (isListening && playerRef.current!.current() !== null) {
                bargeIn(); // during a reply the tap interrupts it and listening stays on
              } else if (isListening) {
                stopListening(true);
              } else {
                startListening();
              }
            }}
            disabled={!isConnected}
            accessibilityRole="button"
            accessibilityLabel={isListening ? 'Stop recording question' : 'Start recording question'}
            accessibilityState={{ disabled: !isConnected }}
            activeOpacity={0.7}
          >
            <Ionicons
              name={isListening ? 'stop' : 'mic'}
              size={32}
              color={isListening ? theme.colors.text.inverse : theme.colors.primary[600]}
            />
          </TouchableOpacity>

          <Text style={styles.recordButtonLabel}>
            {isListening ? 'Tap to stop' : 'Tap to record'}
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.xl,
  },
  loadingText: {
    marginTop: theme.spacing.base,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  titleContainer: {
    flex: 1,
    gap: theme.spacing.sm,
  },
  title: {
    fontSize: theme.typography.fontSize.xl,
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  statusText: {
    fontSize: theme.typography.fontSize.xs,
    marginLeft: theme.spacing.xs,
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  headerButton: {
    minWidth: 40,
  },
  errorCard: {
    margin: theme.spacing.base,
    borderColor: theme.colors.danger[200],
  },
  errorContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  errorText: {
    flex: 1,
    color: theme.colors.danger[600],
    fontSize: theme.typography.fontSize.sm,
  },
  messagesContainer: {
    flex: 1,
  },
  messagesContent: {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    gap: theme.spacing.md,
  },
  welcomeCard: {
    marginVertical: theme.spacing.xl,
  },
  welcomeContent: {
    alignItems: 'center',
    gap: theme.spacing.base,
  },
  welcomeTitle: {
    fontSize: theme.typography.fontSize.xl,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
    textAlign: 'center',
  },
  welcomeText: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    textAlign: 'center',
    lineHeight: 22,
  },
  welcomeButton: {
    marginTop: theme.spacing.sm,
  },
  messageCard: {
    maxWidth: width * 0.85,
  },
  userMessageCard: {
    alignSelf: 'flex-end',
  },
  assistantMessageCard: {
    alignSelf: 'flex-start',
  },
  messageHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  roleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  roleName: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: theme.colors.text.secondary,
  },
  timestamp: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.text.secondary,
  },
  messageContent: {
    fontSize: theme.typography.fontSize.base,
    lineHeight: 22,
    color: theme.colors.text.primary,
  },
  animatedContainer: {
    alignItems: 'center',
    paddingVertical: theme.spacing.base,
  },
  waveCircle: {
    position: 'absolute',
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: theme.colors.danger[500],
  },
  pulseCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.danger[500],
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  processingCircle: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: theme.colors.primary[100],
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  speakingContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  waveContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
    height: 20,
  },
  soundWave: {
    width: 3,
    height: 16,
    backgroundColor: theme.colors.success[500],
    borderRadius: 1.5,
  },
  animatedText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
    fontWeight: theme.typography.fontWeight.medium,
  },
  controlsContainer: {
    paddingHorizontal: theme.spacing.base,
    paddingTop: theme.spacing.md,
    paddingBottom: theme.spacing.lg,
    backgroundColor: theme.colors.background,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    gap: theme.spacing.base,
  },
  textInputContainer: {
    marginBottom: theme.spacing.sm,
  },
  textInput: {
    marginBottom: 0,
  },
  voiceControls: {
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  recordButton: {
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: theme.colors.background,
    borderWidth: 3,
    borderColor: theme.colors.primary[500],
    justifyContent: 'center',
    alignItems: 'center',
    ...theme.shadows.lg,
  },
  recordButtonActive: {
    backgroundColor: theme.colors.danger[500],
    borderColor: theme.colors.danger[600],
  },
  recordButtonDisabled: {
    borderColor: theme.colors.neutral[300],
    opacity: 0.5,
  },
  recordButtonLabel: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
});