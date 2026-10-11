import React, { useState, useEffect, useRef } from 'react';
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
  Dimensions,
} from 'react-native';
import Toast from 'react-native-toast-message';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import { api, getAuthToken } from '../services/api';
import { AudioProcessor, configureAudioPlayback, configureAudioRecording } from '../utils/audioProcessor';
import { errorMessage, showApiError } from '../utils/errorHandler';
import {
  Message,
  TextBuffers,
  SPEAKING_PLACEHOLDER,
  RECORDING_PLACEHOLDER,
  PROCESSING_PLACEHOLDER,
  SPEECH_DELIVERED,
  RESPONSE_INTERRUPTED,
  TRANSCRIBE_FAILED,
  addAssistantMessage,
  appendAssistantText,
  finalizeAssistantText,
  setMessageContent,
  removeMessage,
  bufferText,
  takeText,
  cleanTranscript,
  isContextItem,
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
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasShownWelcome, setHasShownWelcome] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  // Streaming state lives in refs, keyed by the Realtime item id (C-25), so a socket
  // handler bound at connect time never reads stale state and chunks don't re-render.
  const textBuffersRef = useRef<TextBuffers>({}); // text held until that item's audio has played
  const audioChunksRef = useRef<Record<string, Uint8Array[]>>({}); // decoded audio per item (C-26)
  const awaitingPlaybackRef = useRef<Set<string>>(new Set());
  const lastAssistantIdRef = useRef<string | null>(null); // for events that arrive without item_id
  const playbackRef = useRef<{ sound: Audio.Sound; fileUri: string; onDone: () => void } | null>(null);
  const playbackGenRef = useRef(0); // bumped by stopPlayback to cancel a playback still being set up
  const pendingUserIdRef = useRef<string | null>(null); // the bubble of the question being recorded
  const idCounterRef = useRef(0);
  const isMutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const isMountedRef = useRef(true);
  const scrollViewRef = useRef<ScrollView>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  // True while startRecording sets up the recorder (before recordingRef is set), so a reply
  // that arrives then can't switch the audio mode to playback mid-start.
  const startingRecordingRef = useRef(false);

  const nextId = (prefix: string) => `${prefix}_${Date.now()}_${++idCounterRef.current}`;

  const scrollToEnd = () => {
    setTimeout(() => scrollViewRef.current?.scrollToEnd({ animated: true }), 100);
  };

  // Show an item's buffered text in that item's own bubble (C-25).
  const flushItem = (id: string, fallback: string = SPEECH_DELIVERED) => {
    const { text, rest } = takeText(textBuffersRef.current, id);
    textBuffersRef.current = rest;
    if (!isMountedRef.current) return;
    setMessages(prev => finalizeAssistantText(prev, id, text, fallback));
  };

  const flushAllText = () => {
    Object.keys(textBuffersRef.current).forEach(id => flushItem(id));
  };

  // Stop and unload the reply that is playing (C-59). Its completion callback runs, so its
  // text still shows; unmount passes notify=false.
  const stopPlayback = async (notify: boolean = true) => {
    playbackGenRef.current += 1;
    const current = playbackRef.current;
    playbackRef.current = null;
    if (!current) return;
    current.sound.setOnPlaybackStatusUpdate(null);
    await current.sound.unloadAsync().catch(() => {});
    FileSystem.deleteAsync(current.fileUri, { idempotent: true }).catch(() => {});
    if (notify) current.onDone();
  };

  // Play one reply. Any reply already playing is stopped first; onDone runs exactly once,
  // whether the reply finished, failed, or was cancelled by mute, recording or unmount.
  const playReply = async (pcm: Uint8Array, onDone: () => void) => {
    let finished = false;
    const done = () => {
      if (!finished) {
        finished = true;
        onDone();
      }
    };
    await stopPlayback();
    const gen = ++playbackGenRef.current;
    const cancelled = () =>
      gen !== playbackGenRef.current || !isMountedRef.current || isMutedRef.current ||
      !!recordingRef.current || startingRecordingRef.current;
    let fileUri: string | null = null;
    try {
      if (!AudioProcessor.validatePCMData(pcm)) throw new Error('Invalid PCM data');
      const wav = new Uint8Array(AudioProcessor.createWavFile(pcm));
      fileUri = `${FileSystem.cacheDirectory}gpt_audio_${Date.now()}.wav`;
      await FileSystem.writeAsStringAsync(fileUri, AudioProcessor.bytesToBase64(wav), {
        encoding: FileSystem.EncodingType.Base64,
      });
      if (cancelled()) throw new Error('cancelled');
      // C-24 (R-7): leave record mode so iOS plays through the speaker, not the earpiece.
      await configureAudioPlayback();
      const { sound } = await Audio.Sound.createAsync({ uri: fileUri });
      if (cancelled()) {
        await sound.unloadAsync().catch(() => {});
        throw new Error('cancelled');
      }
      playbackRef.current = { sound, fileUri, onDone: done };
      sound.setOnPlaybackStatusUpdate(status => {
        if (playbackRef.current?.sound !== sound) return;
        if (status.isLoaded ? status.didJustFinish : !!status.error) stopPlayback();
      });
      await sound.playAsync();
    } catch (e) {
      if (__DEV__ && (e as Error)?.message !== 'cancelled') console.warn('Assistant playback failed:', e);
      if (fileUri && playbackRef.current?.fileUri === fileUri) {
        await stopPlayback();
      } else if (fileUri) {
        FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
      }
      done(); // the transcript text still shows
    }
  };

  // Forget everything streamed on the old socket, showing any text it already held.
  const resetStreams = (notify: boolean) => {
    if (notify) flushAllText();
    stopPlayback(notify);
    textBuffersRef.current = {};
    audioChunksRef.current = {};
    awaitingPlaybackRef.current = new Set();
    lastAssistantIdRef.current = null;
  };

  useEffect(() => {
    isMountedRef.current = true;
    initializeVoiceAssistant();
    return () => {
      isMountedRef.current = false;
      detachAndClose(wsRef.current);
      wsRef.current = null;
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
      resetStreams(false);
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
        // The backend's ctx_ item is case-database reference data, not something the worker said.
        if (isContextItem(item)) break;
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
        const id = itemIdOf(event);
        if (!id || !event.delta) break;
        if (isMutedRef.current) {
          setMessages(prev => appendAssistantText(prev, id, event.delta));
        } else {
          textBuffersRef.current = bufferText(textBuffersRef.current, id, event.delta);
        }
        break;
      }

      case 'response.output_audio.delta': {
        const id = itemIdOf(event);
        if (!id || !event.delta || isMutedRef.current) break;
        try {
          // C-26: decode each delta on its own; padded chunks can't be joined as text.
          const chunks = audioChunksRef.current[id] || (audioChunksRef.current[id] = []);
          chunks.push(AudioProcessor.base64ToArrayBuffer(event.delta));
        } catch {
          // Skip a corrupt chunk; the rest of the reply still plays.
        }
        break;
      }

      case 'response.output_audio.done': {
        const id = itemIdOf(event);
        if (!id) break;
        const chunks = audioChunksRef.current[id] || [];
        delete audioChunksRef.current[id];
        if (chunks.length && !isMutedRef.current && !recordingRef.current && !startingRecordingRef.current) {
          awaitingPlaybackRef.current.add(id);
          playReply(AudioProcessor.concatChunks(chunks), () => {
            awaitingPlaybackRef.current.delete(id);
            flushItem(id);
            scrollToEnd();
          });
        } else {
          flushItem(id);
        }
        break;
      }

      case 'response.done': {
        const status = event.response?.status;
        const fallback = !status || status === 'completed' ? SPEECH_DELIVERED : RESPONSE_INTERRUPTED;
        const outputIds: string[] = (event.response?.output || []).map((o: any) => o?.id).filter(Boolean);
        const ids = new Set([...outputIds, ...Object.keys(textBuffersRef.current)]);
        ids.forEach(id => {
          // An interrupted item never gets output_audio.done: drop its buffered audio.
          delete audioChunksRef.current[id];
          if (!awaitingPlaybackRef.current.has(id)) flushItem(id, fallback);
        });
        break;
      }

      case 'error':
        // e.g. the backend's event_not_allowed, or an upstream error: brief, not a permanent card.
        toast('Voice assistant', event.error?.message || 'Something went wrong');
        break;

      default:
        break;
    }
  };

  const toggleMute = () => {
    const next = !isMutedRef.current;
    isMutedRef.current = next;
    setIsMuted(next);
    if (next) {
      // C-59: muting stops the reply that is playing, and keeps the text already received.
      audioChunksRef.current = {};
      flushAllText();
      stopPlayback();
    }
  };

  const initializeVoiceAssistant = async () => {
    // Detach first so a late close on the old socket can't mark the new one disconnected.
    detachAndClose(wsRef.current);
    wsRef.current = null;
    setIsConnected(false);
    resetStreams(true);
    try {
      setIsLoading(true);
      setError(null);

      const backendUrl = API_CONFIG.BASE_URL.replace(/^https?:/, (match) =>
        match === 'https:' ? 'wss:' : 'ws:'
      );
      const wsUrl = `${backendUrl}/api/voice-assistant/realtime/ws`;

      const token = await getAuthToken();
      // The screen may have unmounted during the await; don't open a socket nobody will close.
      if (!isMountedRef.current) return;
      // React Native's WebSocket accepts headers as a non-standard third argument.
      const ws: WebSocket = new (WebSocket as any)(wsUrl, null, { headers: { Authorization: `Bearer ${token}` } });

      ws.onopen = () => {
        if (wsRef.current === ws) setIsConnected(true);
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
        setError(connectErrorMessage(err));
        setIsConnected(false);
      };

      // No auto-reconnect: explain the close and let the worker tap Retry.
      ws.onclose = (event: any) => {
        if (wsRef.current !== ws || !isMountedRef.current) return;
        setIsConnected(false);
        setError(closeMessage(event?.code, event?.reason));
      };

      wsRef.current = ws;
    } catch (err) {
      setError(`Couldn't connect to the voice assistant: ${errorMessage(err)}`);
    } finally {
      setIsLoading(false);
    }
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

  const startRecording = async () => {
    if (startingRecordingRef.current) return;
    if (!isSocketOpen(wsRef.current) || !isConnected) {
      Alert.alert('Error', 'Voice assistant not connected');
      return;
    }

    startingRecordingRef.current = true;
    try {
      await stopPlayback(); // don't record over a reply
      await configureAudioRecording(); // R-7: recording mode back on

      const recording = new Audio.Recording();

      // Optimized audio settings for faster transcription
      const recordingOptions = {
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 16000, // Lower sample rate for faster processing
          numberOfChannels: 1, // Mono for efficiency
          bitRate: 64000, // Lower bitrate
        },
        ios: {
          extension: '.m4a',
          outputFormat: Audio.IOSOutputFormat.MPEG4AAC,
          audioQuality: Audio.IOSAudioQuality.MEDIUM, // Medium quality for speed
          sampleRate: 16000, // Optimized for Whisper
          numberOfChannels: 1, // Mono
          bitRate: 64000,
          linearPCMBitDepth: 16,
          linearPCMIsBigEndian: false,
          linearPCMIsFloat: false,
        },
        web: {
          mimeType: 'audio/webm;codecs=opus',
          bitsPerSecond: 64000,
        },
      };

      try {
        await recording.prepareToRecordAsync(recordingOptions);
      } catch {
        await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.LOW_QUALITY);
      }
      await recording.startAsync();

      recordingRef.current = recording;
      setIsRecording(true);

      const id = nextId('user');
      pendingUserIdRef.current = id;
      setMessages(prev => [...prev, { id, role: 'user', content: RECORDING_PLACEHOLDER, timestamp: new Date() }]);
    } catch (error) {
      if (__DEV__) console.warn('Failed to start recording:', error);
      Alert.alert('Recording Error', 'Failed to start recording. Please try again.');
    } finally {
      startingRecordingRef.current = false;
    }
  };

  const stopRecording = async () => {
    const recording = recordingRef.current;
    if (!recording || !isRecording) {
      return;
    }
    const bubbleId = pendingUserIdRef.current;
    pendingUserIdRef.current = null;
    const dropBubble = () => {
      if (bubbleId) setMessages(prev => removeMessage(prev, bubbleId));
    };
    // The question belongs to this socket's conversation; Clear or Retry replaces it.
    const startWs = wsRef.current;

    setIsProcessingAudio(true);
    recordingRef.current = null;
    setIsRecording(false);
    try {
      let uri: string | null = null;
      try {
        await recording.stopAndUnloadAsync();
        uri = recording.getURI();
      } catch (error) {
        if (__DEV__) console.warn('Failed to stop recording:', error);
      }
      if (!uri) {
        dropBubble();
        Alert.alert('Recording Error', 'Failed to stop recording. Please try again.');
        return;
      }

      if (bubbleId) setMessages(prev => setMessageContent(prev, bubbleId, PROCESSING_PLACEHOLDER));

      // C-23: a failed or empty transcription sends nothing; never invent a question.
      let transcript = '';
      let failure: unknown = null;
      try {
        transcript = cleanTranscript(await api.transcribeForAssistant(uri));
      } catch (e) {
        failure = e;
      } finally {
        // C-65: the recorded question doesn't stay in the cache once it's been used.
        FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      }
      // The screen closed while transcribing: nothing to update, nothing to send.
      if (!isMountedRef.current) return;
      if (failure) {
        dropBubble();
        showApiError(failure, TRANSCRIBE_FAILED);
        return;
      }
      if (!transcript) {
        dropBubble();
        toast(TRANSCRIBE_FAILED);
        return;
      }

      const ws = wsRef.current;
      if (!ws || ws !== startWs || !isSocketOpen(ws)) {
        // The socket closed or was replaced while transcribing: keep the question so it
        // can be sent (after Retry if needed), but never into a different conversation.
        dropBubble();
        setTextInput(transcript);
        toast('Not sent', ws && ws !== startWs && isSocketOpen(ws)
          ? 'The conversation was restarted. Send your question again.'
          : 'Voice assistant disconnected. Tap Retry, then send your question.');
        return;
      }

      if (bubbleId) setMessages(prev => setMessageContent(prev, bubbleId, transcript));
      sendQuestion(ws, transcript);
    } finally {
      if (isMountedRef.current) setIsProcessingAudio(false);
    }
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
    const isRecordingMessage = message.content === RECORDING_PLACEHOLDER;
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
              isRecording && styles.recordButtonActive,
              isProcessingAudio && styles.recordButtonProcessing,
              (!isConnected || isProcessingAudio) && styles.recordButtonDisabled,
            ]}
            onPress={() => {
              if (isRecording) {
                stopRecording();
              } else {
                startRecording();
              }
            }}
            disabled={!isConnected || isProcessingAudio}
            accessibilityRole="button"
            accessibilityLabel={
              isProcessingAudio ? 'Processing question' : isRecording ? 'Stop recording question' : 'Start recording question'
            }
            accessibilityState={{ disabled: !isConnected || isProcessingAudio, busy: isProcessingAudio }}
            activeOpacity={0.7}
          >
            {isProcessingAudio ? (
              <ActivityIndicator size="large" color={theme.colors.text.inverse} />
            ) : (
              <Ionicons
                name={isRecording ? 'stop' : 'mic'}
                size={32}
                color={isRecording ? theme.colors.text.inverse : theme.colors.primary[600]}
              />
            )}
          </TouchableOpacity>

          <Text style={styles.recordButtonLabel}>
            {isProcessingAudio ? 'Processing...' : isRecording ? 'Tap to stop' : 'Tap to record'}
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
  recordButtonProcessing: {
    backgroundColor: theme.colors.warning[500],
    borderColor: theme.colors.warning[600],
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