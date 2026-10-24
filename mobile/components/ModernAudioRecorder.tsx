import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Alert,
  Animated,
  Dimensions,
} from 'react-native';
import {
  AudioQuality,
  IOSOutputFormat,
  RecordingOptions,
  requestRecordingPermissionsAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from 'expo-audio';
import * as FileSystem from 'expo-file-system';
import { Ionicons } from '@expo/vector-icons';
import { acquireRecording } from '../services/audioSession';
import { RECORDING_FAILED, showApiError } from '../utils/errors';
import { awaitLocation, captureLocation, RecordingLocation } from '../utils/location';
import { theme } from '../theme';

// Re-exported: callers of the recorder import them from here
export { LOCATION_WAIT_MS } from '../utils/location';
export type { RecordingLocation } from '../utils/location';

const { width } = Dimensions.get('window');

interface AudioRecorderProps {
  onRecordingComplete: (uri: string, location?: RecordingLocation) => void;
}

export interface AudioRecorderRef {
  resetRecording: () => void;
}

// The field note: 16 kHz mono AAC at 32 kbps, about 4 KB a second (H2-5.4)
export const FIELD_NOTE_RECORDING: RecordingOptions = {
  extension: '.m4a',
  sampleRate: 16000,
  numberOfChannels: 1,
  bitRate: 32000,
  ios: { outputFormat: IOSOutputFormat.MPEG4AAC, audioQuality: AudioQuality.MEDIUM },
  android: { outputFormat: 'mpeg4', audioEncoder: 'aac' },
  web: { mimeType: 'audio/webm', bitsPerSecond: 32000 },
};

export const INTERRUPTED_MESSAGE = (at: string) =>
  `Recording was interrupted at ${at}. You can keep what was recorded or record again.`;

// m:ss
const formatDuration = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
};

export const ModernAudioRecorder = forwardRef<AudioRecorderRef, AudioRecorderProps>(({
  onRecordingComplete,
}, ref) => {
  const recorder = useAudioRecorder(FIELD_NOTE_RECORDING);
  const recorderState = useAudioRecorderState(recorder, 250);
  const [isRecording, setIsRecording] = useState(false);
  // Whole seconds recorded, from the recorder's own status (H2-5.3)
  const [duration, setDuration] = useState(0);
  // Between the stop tap and the hand-over, while the location is awaited
  const [isFinishing, setIsFinishing] = useState(false);
  // False after unmount, so a start that finishes late releases the mic
  const mountedRef = useRef(true);
  // True from record() until the worker stops or the recording is interrupted
  const activeRef = useRef(false);
  // The recorder's status has said "recording" since this start, so a later
  // "not recording" is an interruption and not the status lagging behind
  const sawRecordingRef = useRef(false);
  const warnedRef = useRef(false);
  const durationRef = useRef(0);
  const releaseRef = useRef<(() => Promise<void>) | null>(null);
  // Set from the first tap until the recording has started: later taps are ignored (C-39)
  const startingRef = useRef(false);
  // The location being captured alongside the current recording (C-39)
  const locationRef = useRef<Promise<RecordingLocation | undefined> | null>(null);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Hands the audio session back; safe to call more than once
  const releaseSession = async () => {
    const release = releaseRef.current;
    releaseRef.current = null;
    await release?.().catch(() => {});
  };

  // Back to the idle "Tap to start recording" state
  const resetState = () => {
    activeRef.current = false;
    locationRef.current = null;
    durationRef.current = 0;
    stopAnimations();
    setIsRecording(false);
    setIsFinishing(false);
    setDuration(0);
  };

  // Expose reset function to parent
  useImperativeHandle(ref, () => ({
    resetRecording: resetState,
  }));

  // Request permissions
  useEffect(() => {
    (async () => {
      try {
        const { granted } = await requestRecordingPermissionsAsync();
        if (!granted) showApiError('Allow microphone access to record.', 'Microphone');
      } catch {
        showApiError('Allow microphone access to record.', 'Microphone');
      }
    })();
  }, []);

  // Start animations
  const startPulseAnimation = () => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.3,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    ).start();
  };

  const stopAnimations = () => {
    pulseAnim.stopAnimation();
    pulseAnim.setValue(1);
    progressAnim.setValue(0);
  };

  // Update progress animation
  useEffect(() => {
    Animated.timing(progressAnim, {
      toValue: duration / 120,
      duration: 200,
      useNativeDriver: false,
    }).start();
  }, [duration]);

  // Each status poll: interruption, the 1:45 warning, the 2:00 auto-stop
  useEffect(() => {
    if (!activeRef.current) return;
    if (recorderState.isRecording) sawRecordingRef.current = true;
    if (!sawRecordingRef.current && !recorderState.mediaServicesDidReset) return;
    // A call or Siri stopped the recorder, or the media services reset (H2-5.3)
    if (!recorderState.isRecording || recorderState.mediaServicesDidReset) {
      handleInterruption();
      return;
    }
    const seconds = Math.floor((recorderState.durationMillis ?? 0) / 1000);
    durationRef.current = seconds;
    setDuration(seconds);
    if (seconds >= 120) {
      stopRecording();
    } else if (seconds >= 105 && !warnedRef.current) {
      warnedRef.current = true;
      Alert.alert('⏱️ Time Warning', 'Recording will stop in 15 seconds', [{ text: 'OK', style: 'default' }]);
    }
  }, [recorderState.isRecording, recorderState.durationMillis, recorderState.mediaServicesDidReset, isRecording]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (activeRef.current) {
        activeRef.current = false;
        Promise.resolve().then(() => recorder.stop()).catch(() => {});
      }
      releaseSession();
    };
  }, []);

  // Start recording first; the location is captured alongside it (C-39)
  const startRecording = async () => {
    if (startingRef.current || activeRef.current) return;
    startingRef.current = true;
    try {
      releaseRef.current = await acquireRecording('record-tab');
      await recorder.prepareToRecordAsync();
      if (!mountedRef.current) {
        // Unmounted while starting: release the mic and start nothing else
        await releaseSession();
        return;
      }
      recorder.record();
      activeRef.current = true;
      sawRecordingRef.current = false;
      warnedRef.current = false;
      durationRef.current = 0;
      locationRef.current = captureLocation();
      setIsRecording(true);
      setDuration(0);

      // Start animations
      startPulseAnimation();
    } catch (err) {
      if (__DEV__) console.error('Failed to start recording', err);
      await releaseSession();
      showApiError(RECORDING_FAILED, 'Recording failed');
    } finally {
      startingRef.current = false;
    }
  };

  // Stop recording
  const stopRecording = async () => {
    if (!activeRef.current) return;

    // Check minimum recording duration
    if (durationRef.current < 5) {
      Alert.alert(
        '⏱️ Too Short',
        `Please record at least 5 seconds (${5 - durationRef.current}s more)`,
        [{ text: 'Continue Recording', style: 'default' }]
      );
      return;
    }

    // Taken first, so a second tap or the 2:00 auto-stop is a no-op from here on
    activeRef.current = false;
    const pendingLocation = locationRef.current;
    stopAnimations();
    setIsFinishing(true);

    try {
      await recorder.stop();
      const uri = recorder.uri;
      await releaseSession();
      const location = await awaitLocation(pendingLocation);
      resetState();
      if (uri) {
        onRecordingComplete(uri, location);
      }
    } catch (err) {
      if (__DEV__) console.error('Failed to stop recording', err);
      // One more best-effort stop, so the next start isn't blocked
      Promise.resolve().then(() => recorder.stop()).catch(() => {});
      await releaseSession();
      // Never leave the UI stuck on the stop button (C-61)
      resetState();
      showApiError(RECORDING_FAILED, 'Recording failed');
    }
  };

  // The recording stopped without the worker: keep what was recorded or start over (H2-5.3)
  const handleInterruption = async () => {
    activeRef.current = false;
    const seconds = durationRef.current;
    const pendingLocation = locationRef.current;
    stopAnimations();
    setIsFinishing(true);
    await Promise.resolve().then(() => recorder.stop()).catch(() => {});
    const uri = recorder.uri;
    await releaseSession();
    const location = await awaitLocation(pendingLocation);
    resetState();
    const recordAgain = {
      text: 'Record again',
      onPress: () => {
        if (uri) FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
        resetState();
      },
    };
    const keep = {
      text: 'Keep',
      onPress: () => {
        if (uri) onRecordingComplete(uri, location);
      },
    };
    Alert.alert('Recording interrupted', INTERRUPTED_MESSAGE(formatDuration(seconds)),
      seconds >= 5 && uri ? [recordAgain, keep] : [recordAgain]);
  };

  // Get button color
  const getButtonColor = () =>
    isRecording ? theme.colors.danger[500] : theme.colors.primary[600];

  // Get progress color
  const getProgressColor = () => {
    if (duration >= 105) return theme.colors.danger[500];
    if (duration >= 90) return theme.colors.warning[500];
    return theme.colors.primary[500];
  };

  const progressWidth = progressAnim.interpolate({
    inputRange: [0, 1],
    outputRange: ['0%', '100%'],
  });

  return (
    <View style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <Ionicons name="mic-outline" size={24} color={theme.colors.primary[600]} />
        <Text style={styles.title}>Voice Recording</Text>
      </View>
      <Text style={styles.subtitle}>
        Record your observations about the individual
      </Text>

      {/* Timer Display */}
      <View style={styles.timerSection}>
        <Text style={[
          styles.timer,
          // Red from 1:30 (PRD); the warning alert comes at 1:45 (C-61)
          duration >= 90 && styles.timerWarning
        ]}>
          {formatDuration(duration)}
        </Text>
        <Text style={styles.timerMax}>/ 2:00</Text>
      </View>

      {/* Progress Bar */}
      <View style={styles.progressContainer}>
        <Animated.View
          style={[
            styles.progressBar,
            {
              width: progressWidth,
              backgroundColor: getProgressColor(),
            }
          ]}
        />
      </View>

      {/* Recording Button */}
      <View style={styles.recordSection}>
        <Animated.View
          style={[
            styles.pulseCircle,
            {
              transform: [{ scale: pulseAnim }],
              opacity: isRecording ? 0.2 : 0,
              backgroundColor: getButtonColor(),
            }
          ]}
        />
        <TouchableOpacity
          style={[
            styles.recordButton,
            { backgroundColor: getButtonColor() },
            isRecording && styles.recordingButton,
          ]}
          testID="record-button"
          onPress={isRecording ? stopRecording : startRecording}
          disabled={isFinishing}
          activeOpacity={0.7}
        >
          {isRecording ? (
            <View style={styles.stopIcon} />
          ) : (
            <Ionicons name="mic" size={48} color={theme.colors.text.inverse} />
          )}
        </TouchableOpacity>
      </View>

      {/* Status Text */}
      <Text style={styles.statusText}>
        {isFinishing
          ? 'Saving location...'
          : isRecording
          ? 'Recording in progress...'
          : 'Tap to start recording'}
      </Text>

      {/* Instructions */}
      {!isRecording && (
        <View style={styles.instructions}>
          <View style={styles.instructionItem}>
            <Ionicons name="time-outline" size={16} color={theme.colors.text.secondary} />
            <Text style={styles.instructionText}>Minimum 5 seconds</Text>
          </View>
          <View style={styles.instructionItem}>
            <Ionicons name="timer-outline" size={16} color={theme.colors.text.secondary} />
            <Text style={styles.instructionText}>Maximum 2 minutes</Text>
          </View>
        </View>
      )}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: theme.spacing.lg,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  title: {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
    marginLeft: theme.spacing.sm,
  },
  subtitle: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    marginBottom: theme.spacing.xl,
    textAlign: 'center',
  },
  timerSection: {
    flexDirection: 'row',
    alignItems: 'baseline',
    marginBottom: theme.spacing.md,
  },
  timer: {
    fontSize: 48,
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
  },
  timerWarning: {
    color: theme.colors.danger[600],
  },
  timerMax: {
    fontSize: theme.typography.fontSize.xl,
    color: theme.colors.text.secondary,
    marginLeft: theme.spacing.sm,
  },
  progressContainer: {
    width: width - theme.spacing.lg * 2,
    height: 6,
    backgroundColor: theme.colors.neutral[200],
    borderRadius: theme.borderRadius.full,
    overflow: 'hidden',
    marginBottom: theme.spacing['2xl'],
  },
  progressBar: {
    height: '100%',
    borderRadius: theme.borderRadius.full,
  },
  recordSection: {
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: theme.spacing.xl,
    width: 160,
    height: 160,
  },
  pulseCircle: {
    position: 'absolute',
    width: 160,
    height: 160,
    borderRadius: 80,
  },
  recordButton: {
    width: 120,
    height: 120,
    borderRadius: 60,
    alignItems: 'center',
    justifyContent: 'center',
    ...theme.shadows.lg,
  },
  recordingButton: {
    ...theme.shadows.xl,
  },
  stopIcon: {
    width: 32,
    height: 32,
    backgroundColor: theme.colors.text.inverse,
    borderRadius: theme.borderRadius.sm,
  },
  statusText: {
    fontSize: theme.typography.fontSize.lg,
    color: theme.colors.text.primary,
    fontWeight: theme.typography.fontWeight.medium,
    textAlign: 'center',
    marginTop: theme.spacing.md,
  },
  instructions: {
    flexDirection: 'row',
    marginTop: theme.spacing.xl,
    gap: theme.spacing.xl,
  },
  instructionItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.xs,
  },
  instructionText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
  },
});