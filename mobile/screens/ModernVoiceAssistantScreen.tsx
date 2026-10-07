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
  TextInput,
  Platform,
  Animated,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system';
import * as Location from 'expo-location';
import { api, getAuthToken } from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { AudioProcessor, configureAudioRecording } from '../utils/audioProcessor';
import { API_CONFIG } from '../config/api';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { theme } from '../theme';

const { width } = Dimensions.get('window');

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  isAudio?: boolean;
}

const SPEAKING_PLACEHOLDER = '[Speaking...]';

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
  const { user } = useAuth();
  const [messages, setMessages] = useState<Message[]>([]);
  const [isConnected, setIsConnected] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasShownWelcome, setHasShownWelcome] = useState(false);
  const [textInput, setTextInput] = useState('');
  const [isProcessingAudio, setIsProcessingAudio] = useState(false);
  const [currentLocation, setCurrentLocation] = useState<{
    latitude: number;
    longitude: number;
  } | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [currentAudioData, setCurrentAudioData] = useState<string>('');

  const audioBufferRef = useRef<string>('');
  const pendingAssistantTextRef = useRef<string>('');
  const awaitingPlaybackRef = useRef(false);
  const isMutedRef = useRef(false);
  const wsRef = useRef<WebSocket | null>(null);
  const isMountedRef = useRef(true);
  const scrollViewRef = useRef<ScrollView>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);

  const flushPendingAssistantText = (fallback?: string) => {
    const finalText = pendingAssistantTextRef.current;
    const hasContent = finalText && finalText.trim().length > 0;
    const fallbackText = fallback || '[Speech response delivered]';

    if (!hasContent && !fallback) {
      return;
    }

    setMessages(prev => {
      const newMessages = [...prev];
      const lastMessage = newMessages[newMessages.length - 1];
      if (lastMessage && lastMessage.role === 'assistant') {
        const isPlaceholder = lastMessage.content === SPEAKING_PLACEHOLDER || !lastMessage.content || lastMessage.content === '[Processing your speech...]';
        if (hasContent) {
          lastMessage.content = finalText;
        } else if (isPlaceholder) {
          lastMessage.content = fallbackText;
        }
      }
      return newMessages;
    });

    pendingAssistantTextRef.current = '';
  };

  useEffect(() => {
    isMountedRef.current = true;
    initializeVoiceAssistant();
    return () => {
      isMountedRef.current = false;
      if (wsRef.current) {
        wsRef.current.close();
      }
      recordingRef.current?.stopAndUnloadAsync().catch(() => {});
    };
  }, []);

  const getCurrentLocation = async () => {
    try {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') {
        console.log('Location permission denied');
        return null;
      }

      const location = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
        timeInterval: 5000,
        distanceInterval: 10,
      });

      const coords = {
        latitude: location.coords.latitude,
        longitude: location.coords.longitude,
      };

      setCurrentLocation(coords);
      console.log('📍 Current location:', coords);
      return coords;
    } catch (error) {
      console.error('Error getting location:', error);
      return null;
    }
  };

  const handleWebSocketEvent = (event: any) => {
    console.log('🔍 Processing WebSocket event:', event.type);

    switch (event.type) {
      case 'session.created':
        console.log('✅ Session created successfully');
        break;

      case 'session.updated':
        console.log('✅ Session updated successfully');
        break;

      case 'conversation.item.created':
      case 'conversation.item.added':
        if (event.item?.type === 'message' && event.item?.role === 'assistant') {
          console.log('📝 Assistant message created/added');
          const assistantMessage: Message = {
            id: event.item.id || Date.now().toString(),
            role: 'assistant',
            content: SPEAKING_PLACEHOLDER,
            timestamp: new Date(),
          };
          setMessages(prev => [...prev, assistantMessage]);
          pendingAssistantTextRef.current = '';
        }
        break;

      case 'conversation.item.updated':
        if (event.item?.type === 'message' && event.item?.role === 'assistant') {
          console.log('📝 Assistant message updated');
          const updatedText = event.item.content?.[0]?.text || '';
          if (isMutedRef.current) {
            setMessages(prev => {
              const newMessages = [...prev];
              const lastMessage = newMessages[newMessages.length - 1];
              if (lastMessage && lastMessage.role === 'assistant') {
                lastMessage.content = updatedText;
              }
              return newMessages;
            });
            pendingAssistantTextRef.current = '';
          } else if (updatedText) {
            pendingAssistantTextRef.current = updatedText;
          }
        }
        break;

      case 'conversation.item.done':
        if (event.item?.type === 'message' && event.item?.role === 'assistant') {
          console.log('✅ Assistant message completed');
          setTimeout(() => {
            scrollViewRef.current?.scrollToEnd({ animated: true });
          }, 100);
        }
        break;

      case 'response.output_audio_transcript.delta':
        console.log('📝 Audio transcript delta:', event.delta);
        if (isMutedRef.current) {
          setMessages(prev => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
              const baseContent = lastMessage.content === SPEAKING_PLACEHOLDER ? '' : lastMessage.content;
              const buffered = pendingAssistantTextRef.current;
              const combinedBase = buffered ? `${baseContent}${buffered}` : baseContent;
              lastMessage.content = `${combinedBase}${event.delta || ''}`;
            }
            return newMessages;
          });
          pendingAssistantTextRef.current = '';
        } else {
          pendingAssistantTextRef.current += event.delta || '';
        }
        break;

      case 'response.output_text.delta':
        console.log('📝 Text delta:', event.delta);
        if (isMutedRef.current) {
          setMessages(prev => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'assistant') {
              const baseContent = lastMessage.content === SPEAKING_PLACEHOLDER ? '' : lastMessage.content;
              const buffered = pendingAssistantTextRef.current;
              const combinedBase = buffered ? `${baseContent}${buffered}` : baseContent;
              lastMessage.content = `${combinedBase}${event.delta || ''}`;
            }
            return newMessages;
          });
          pendingAssistantTextRef.current = '';
        } else {
          pendingAssistantTextRef.current += event.delta || '';
        }
        break;

      case 'response.output_text.done':
        console.log('✅ Text output completed');
        break;

      case 'response.output_audio_transcript.done':
        console.log('✅ Audio transcript completed');
        break;

      case 'response.output_audio.delta':
        console.log('🎵 Audio delta received');
        if (event.delta) {
          setCurrentAudioData(prev => prev + event.delta);
          audioBufferRef.current += event.delta;
        }
        break;

      case 'response.output_audio.done':
        console.log('✅ Audio output completed');
        {
          const buffered = audioBufferRef.current || currentAudioData;
          if (buffered && !isMutedRef.current) {
            awaitingPlaybackRef.current = true;
            playAudioData(buffered, () => {
              awaitingPlaybackRef.current = false;
              flushPendingAssistantText('[Speech response delivered]');
            });
          } else {
            awaitingPlaybackRef.current = false;
            flushPendingAssistantText('[Speech response delivered]');
          }
          audioBufferRef.current = '';
          setCurrentAudioData('');
        }
        break;

      case 'input_audio_buffer.speech_started':
        console.log('🎤 Speech started detected');
        break;

      case 'input_audio_buffer.speech_stopped':
        console.log('🎤 Speech stopped detected');
        break;

      case 'input_audio_buffer.committed':
        console.log('✅ Audio buffer committed');
        break;

      case 'response.done':
        console.log('✅ Response completed');
        if (!awaitingPlaybackRef.current && pendingAssistantTextRef.current) {
          flushPendingAssistantText('[Speech response delivered]');
        }
        break;

      case 'error':
        console.error('❌ Server error:', event.error);
        setError(event.error?.message || 'Server error occurred');
        break;

      case 'echo':
        console.log('🔍 Echo event received (testing mode)');
        break;

      default:
        console.log('🔍 Unhandled event type:', event.type);
    }
  };

  const playAudioData = async (audioData: string, onPlaybackComplete?: () => void) => {
    try {
      console.log('🎵 Playing audio data...');
      console.log('🎵 Audio data length:', audioData.length);

      const pcmBytes = AudioProcessor.base64ToArrayBuffer(audioData);
      if (!AudioProcessor.validatePCMData(pcmBytes)) {
        throw new Error('Invalid PCM data format');
      }

      const wavBuffer = AudioProcessor.createWavFile(pcmBytes);

      const wavBytes = new Uint8Array(wavBuffer);
      let binary = '';
      const chunk = 0x8000;
      for (let i = 0; i < wavBytes.length; i += chunk) {
        const slice = wavBytes.subarray(i, i + chunk);
        binary += String.fromCharCode.apply(null, Array.from(slice));
      }
      const base64Wav = btoa(binary);

      const fileUri = `${FileSystem.cacheDirectory}gpt_audio_${Date.now()}.wav`;
      await FileSystem.writeAsStringAsync(fileUri, base64Wav, { encoding: FileSystem.EncodingType.Base64 });

      const { sound } = await Audio.Sound.createAsync({ uri: fileUri }, { shouldPlay: true });
      console.log('🎵 Audio playback started');

      sound.setOnPlaybackStatusUpdate(async (status) => {
        if (status.isLoaded && status.didJustFinish) {
          console.log('🎵 Audio playback completed');
          try {
            await sound.unloadAsync();
          } catch (err) {
            console.log('⚠️ Failed to unload sound:', err);
          }
          FileSystem.deleteAsync(fileUri, { idempotent: true }).catch(() => {});
          onPlaybackComplete?.();
        }
      });
    } catch (error) {
      console.error('❌ Error playing audio:', error);
      console.log('🎵 Audio playback failed; transcript text is still shown');
      onPlaybackComplete?.();
    }
  };

  const toggleMute = async () => {
    setIsMuted(m => { isMutedRef.current = !m; return !m; });
    if (!isMuted) {
      console.log('🔇 Muted - Audio output disabled');
    } else {
      console.log('🔊 Unmuted - Audio output enabled');
    }
  };

  const initializeVoiceAssistant = async () => {
    const oldWs = wsRef.current;
    if (oldWs) {
      // Detach handlers so a late close on the old socket can't mark the new one disconnected.
      oldWs.onopen = null;
      oldWs.onclose = null;
      oldWs.onerror = null;
      oldWs.onmessage = null;
      oldWs.close();
    }
    wsRef.current = null;
    try {
      setIsLoading(true);
      setError(null);

      await getCurrentLocation();

      console.log('🔌 Connecting to backend WebSocket proxy...');

      // Properly convert HTTP/HTTPS to WS/WSS
      const backendUrl = API_CONFIG.BASE_URL.replace(/^https?:/, (match) =>
        match === 'https:' ? 'wss:' : 'ws:'
      );
      const wsUrl = `${backendUrl}/api/voice-assistant/realtime/ws`;

      console.log('🔌 WebSocket URL:', wsUrl);
      console.log('🔌 Backend URL:', backendUrl);

      const token = await getAuthToken();
      // The screen may have unmounted during the awaits above; don't open a socket nobody will close.
      if (!isMountedRef.current) return;
      // React Native's WebSocket accepts headers as a non-standard third argument.
      const ws = new (WebSocket as any)(wsUrl, null, { headers: { Authorization: `Bearer ${token}` } });

      ws.onopen = () => {
        console.log('✅ Connected to OpenAI Realtime API');
        setIsConnected(true);
        console.log('🔌 WebSocket connection state:', ws.readyState);
        console.log('🔧 Session already configured via ephemeral token');
      };

      ws.onmessage = (event: any) => {
        try {
          const data = JSON.parse(event.data);
          console.log('📨 Received WebSocket message:', data);
          handleWebSocketEvent(data);
        } catch (error) {
          console.error('❌ Error parsing WebSocket message:', error);
        }
      };

      ws.onerror = (err: any) => {
        console.error('❌ WebSocket error:', err);
        console.error('❌ Error details:', JSON.stringify(err, null, 2));
        setError(`WebSocket connection error: ${err.message || 'Unknown error'}`);
        setIsConnected(false);
        console.log('🔌 Connection state set to false due to error');
      };

      ws.onclose = (event: any) => {
        console.log('🔌 WebSocket connection closed');
        console.log('🔌 Close event details:', JSON.stringify(event, null, 2));
        setIsConnected(false);
        console.log('🔌 Connection state set to false due to close');
      };

      wsRef.current = ws;
      if (!isMountedRef.current) {
        ws.close();
        wsRef.current = null;
      }

    } catch (err) {
      console.error('Failed to initialize voice assistant:', err);
      setError(err instanceof Error ? err.message : 'Failed to initialize voice assistant');
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
      console.log('👋 Welcome message added');
    }
  };

  const startRecording = async () => {
    if (!wsRef.current || !isConnected) {
      Alert.alert('Error', 'Voice assistant not connected');
      return;
    }

    try {
      await configureAudioRecording();

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
        console.log('🎤 Using optimized audio settings for fast transcription');
      } catch (error) {
        console.log('⚠️ Optimized settings failed, trying LOW_QUALITY preset...');
        await recording.prepareToRecordAsync(Audio.RecordingOptionsPresets.LOW_QUALITY);
      }
      await recording.startAsync();

      recordingRef.current = recording;
      setIsRecording(true);

      const userMessage: Message = {
        id: Date.now().toString(),
        role: 'user',
        content: '[Recording... Speak now]',
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, userMessage]);

      console.log('🎤 Started recording audio with optimized settings');
    } catch (error) {
      console.error('Failed to start recording:', error);
      Alert.alert('Recording Error', 'Failed to start recording. Please try again.');
    }
  };

  const stopRecording = async () => {
    if (!recordingRef.current || !isRecording) {
      return;
    }

    try {
      setIsProcessingAudio(true);
      await recordingRef.current.stopAndUnloadAsync();
      const uri = recordingRef.current.getURI();
      recordingRef.current = null;
      setIsRecording(false);

      if (uri && wsRef.current) {
        console.log('🎤 Stopped recording, processing audio:', uri);

        setMessages(prev => {
          const newMessages = [...prev];
          const lastMessage = newMessages[newMessages.length - 1];
          if (lastMessage && lastMessage.role === 'user' && lastMessage.content === '[Recording... Speak now]') {
            lastMessage.content = '[Processing your speech...]';
          }
          return newMessages;
        });

        try {
          console.log('🎤 Fast transcribing recorded audio via backend...');
          const startTime = Date.now();
          const transcription = await api.transcribeForAssistant(uri);
          const transcriptionTime = Date.now() - startTime;
          console.log(`⚡ Transcription completed in ${transcriptionTime}ms`);

          // Optimize for speed - skip if too short
          if (!transcription || transcription.length < 3) {
            console.log('⚠️ Transcription too short, using fallback');
            throw new Error('Transcription too short');
          }

          console.log('🎤 Transcription result:', transcription);

          setMessages(prev => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'user' && lastMessage.content === '[Processing your speech...]') {
              lastMessage.content = transcription || '[Unrecognized speech]';
            }
            return newMessages;
          });

          const messageEvent = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [
                { type: 'input_text', text: transcription || 'Please assist with homeless outreach guidance' },
              ],
            },
          };

          wsRef.current.send(JSON.stringify(messageEvent));
          console.log('✅ Sent transcribed text to Realtime');

          // Immediate response trigger for faster interaction
          const responseEvent = { type: 'response.create' };
          wsRef.current.send(JSON.stringify(responseEvent));
          console.log('🎯 Triggered immediate assistant response');

        } catch (audioError) {
          console.error('Transcription failed:', audioError);

          setMessages(prev => {
            const newMessages = [...prev];
            const lastMessage = newMessages[newMessages.length - 1];
            if (lastMessage && lastMessage.role === 'user' && lastMessage.content === '[Processing your speech...]') {
              lastMessage.content = 'I need help with homeless outreach guidance';
            }
            return newMessages;
          });

          const fallbackEvent = {
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'user',
              content: [ { type: 'input_text', text: 'I need help with homeless outreach guidance' } ],
            },
          };
          wsRef.current.send(JSON.stringify(fallbackEvent));
          console.log('🎯 Sent fallback text message');
        }
      }
    } catch (error) {
      console.error('Failed to stop recording:', error);
      Alert.alert('Recording Error', 'Failed to stop recording. Please try again.');
    } finally {
      setIsProcessingAudio(false);
    }
  };

  const sendTextMessage = async (text: string) => {
    if (!wsRef.current || !isConnected) {
      Alert.alert('Error', 'Voice assistant not connected');
      return;
    }

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: text,
      timestamp: new Date(),
    };
    setMessages(prev => [...prev, userMessage]);

    console.log('📤 Sending text message to GPT Realtime via WebSocket');
    console.log('📤 Message content:', text);

    const messageEvent = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: text,
          },
        ],
      },
    };

    if (wsRef.current) {
      wsRef.current.send(JSON.stringify(messageEvent));
      console.log('✅ Text message sent successfully via WebSocket');

      // Immediate response for text messages
    const responseEvent = {
      type: "response.create",
    };
    wsRef.current.send(JSON.stringify(responseEvent));
    console.log('🎯 Triggered immediate text response');
    }
  };

  const clearConversation = () => {
    setMessages([]);
    setHasShownWelcome(false);
  };

  const renderMessage = (message: Message) => {
    const isRecordingMessage = message.content === '[Recording... Speak now]';
    const isProcessingMessage = message.content === '[Processing your speech...]';
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
            <View style={styles.statusDot} />
            <Text style={styles.statusText}>
              {isConnected ? 'Connected' : 'Disconnected'}
            </Text>
          </Badge>
        </View>

        <View style={styles.headerActions}>
          <Button
            variant="ghost"
            size="small"
            icon={isMuted ? 'volume-mute' : 'volume-high'}
            onPress={toggleMute}
            style={styles.headerButton}
          />
          <Button
            variant="ghost"
            size="small"
            icon="refresh"
            onPress={initializeVoiceAssistant}
            style={styles.headerButton}
          />
          <Button
            variant="ghost"
            size="small"
            icon="trash-outline"
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
            onRightIconPress={textInput.trim() && isConnected ? () => { sendTextMessage(textInput.trim()); setTextInput(''); } : undefined}
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
              console.log('🎤 Record button pressed:', {
                isRecording,
                isConnected,
                isProcessingAudio,
                disabled: !isConnected || isProcessingAudio
              });
              if (isRecording) {
                stopRecording();
              } else {
                startRecording();
              }
            }}
            disabled={!isConnected || isProcessingAudio}
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
    backgroundColor: 'currentColor',
  },
  statusText: {
    fontSize: theme.typography.fontSize.xs,
    color: 'currentColor',
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