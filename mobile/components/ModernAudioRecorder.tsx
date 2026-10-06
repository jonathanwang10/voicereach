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
import { Audio } from 'expo-av';
import * as Location from 'expo-location';
import { Ionicons } from '@expo/vector-icons';
import { ErrorHandler } from '../utils/errorHandler';
import { theme } from '../theme';

const { width } = Dimensions.get('window');

interface AudioRecorderProps {
  onRecordingComplete: (uri: string, location?: {
    location: {
      latitude: number;
      longitude: number;
      address: string;
    }
  }) => void;
  onRecordingStart?: () => void;
  onRecordingStop?: () => void;
}

export interface AudioRecorderRef {
  resetRecording: () => void;
}

export const ModernAudioRecorder = forwardRef<AudioRecorderRef, AudioRecorderProps>(({
  onRecordingComplete,
  onRecordingStart,
  onRecordingStop,
}, ref) => {
  const [recording, setRecording] = useState<Audio.Recording | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const recordingRef = useRef<Audio.Recording | null>(null);
  const durationRef = useRef(0);

  // Animations
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const rotateAnim = useRef(new Animated.Value(0)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Expose reset function to parent
  useImperativeHandle(ref, () => ({
    resetRecording: () => {
      recordingRef.current = null;
      setRecording(null);
      setIsRecording(false);
      setIsPaused(false);
      setDuration(0);
      stopAnimations();
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    }
  }));

  // Request permissions
  useEffect(() => {
    (async () => {
      try {
        const { status } = await Audio.requestPermissionsAsync();
        if (status !== 'granted') {
          const error = ErrorHandler.handleRecordingError(new Error('Recording permission denied'));
          ErrorHandler.showError(error);
        }
      } catch (error) {
        const appError = ErrorHandler.handleError(error, 'Audio Permission Request');
        ErrorHandler.showError(appError);
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

  useEffect(() => {
    durationRef.current = duration;
    if (!isRecording) return;
    if (duration === 105) {
      Alert.alert('⏱️ Time Warning', 'Recording will stop in 15 seconds', [{ text: 'OK', style: 'default' }]);
    }
    if (duration >= 120) {
      stopRecording();
    }
  }, [duration, isRecording]);

  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    recordingRef.current?.stopAndUnloadAsync().catch(() => {});
  }, []);

  // Start recording
  const startRecording = async () => {
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
      });

      // Capture location when recording starts
      let locationData: {
        location: {
          latitude: number;
          longitude: number;
          address: string;
        }
      } | undefined;

      try {
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status === 'granted') {
          const currentLocation = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.High,
          });

          const addressResponse = await Location.reverseGeocodeAsync({
            latitude: currentLocation.coords.latitude,
            longitude: currentLocation.coords.longitude,
          });

          const address = addressResponse[0];
          const addressString = address
            ? `${address.street || ''} ${address.city || ''} ${address.region || ''}`.trim()
            : 'Unknown Address';

          locationData = {
            location: {
              latitude: currentLocation.coords.latitude,
              longitude: currentLocation.coords.longitude,
              address: addressString,
            }
          };
        }
      } catch (locationErr) {
        console.log('Location capture failed, continuing without location:', locationErr);
      }

      // Start recording
      const { recording } = await Audio.Recording.createAsync({
        ...Audio.RecordingOptionsPresets.LOW_QUALITY,
        android: {
          extension: '.m4a',
          outputFormat: Audio.AndroidOutputFormat.MPEG_4,
          audioEncoder: Audio.AndroidAudioEncoder.AAC,
          sampleRate: 44100,
          numberOfChannels: 1,
          bitRate: 64000,
        },
      });
      recordingRef.current = recording;
      setRecording(recording);
      setIsRecording(true);
      setIsPaused(false);
      setDuration(0);
      onRecordingStart?.();

      // Store location data for when recording completes
      (recording as any).locationData = locationData;

      // Start animations
      startPulseAnimation();

      // Start duration timer
      intervalRef.current = setInterval(() => {
        setDuration((prev) => prev + 1);
      }, 1000);
    } catch (err) {
      console.error('Failed to start recording', err);
      const error = ErrorHandler.handleRecordingError(err);
      ErrorHandler.showError(error);
    }
  };

  // Stop recording
  const stopRecording = async () => {
    const activeRecording = recordingRef.current;
    if (!activeRecording) return;

    try {
      // Check minimum recording duration
      if (durationRef.current < 5) {
        Alert.alert(
          '⏱️ Too Short',
          `Please record at least 5 seconds (${5 - durationRef.current}s more)`,
          [{ text: 'Continue Recording', style: 'default' }]
        );
        return;
      }

      // Clear interval
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }

      stopAnimations();
      recordingRef.current = null;
      await activeRecording.stopAndUnloadAsync();
      const uri = activeRecording.getURI();
      setRecording(null);
      setIsRecording(false);
      setIsPaused(false);
      setDuration(0);
      onRecordingStop?.();

      if (uri) {
        const locationData = (activeRecording as any).locationData;
        onRecordingComplete(uri, locationData);
      }
    } catch (err) {
      console.error('Failed to stop recording', err);
      const error = ErrorHandler.handleRecordingError(err);
      ErrorHandler.showError(error);
    }
  };

  // Format duration
  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Get button color
  const getButtonColor = () => {
    if (isRecording) return theme.colors.danger[500];
    if (duration > 0) return theme.colors.success[500];
    return theme.colors.primary[600];
  };

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
          duration >= 105 && styles.timerWarning
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
          disabled={!isRecording && duration > 0 && duration < 5}
          activeOpacity={0.7}
        >
          {isRecording ? (
            <View style={styles.stopIcon} />
          ) : duration > 0 ? (
            <Ionicons name="checkmark" size={48} color={theme.colors.text.inverse} />
          ) : (
            <Ionicons name="mic" size={48} color={theme.colors.text.inverse} />
          )}
        </TouchableOpacity>
      </View>

      {/* Status Text */}
      <Text style={styles.statusText}>
        {isRecording
          ? 'Recording in progress...'
          : duration > 0
          ? duration < 5
          ? `Minimum 5 seconds (${5 - duration}s more)`
          : 'Recording complete!'
          : 'Tap to start recording'}
      </Text>

      {/* Instructions */}
      {!isRecording && duration === 0 && (
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