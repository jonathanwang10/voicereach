import React, { useState, useRef, useEffect } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  ActivityIndicator,
  TouchableOpacity,
  SafeAreaView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { ModernAudioRecorder, RecordingLocation } from '../components/ModernAudioRecorder';
import { TranscriptionResults } from '../components/TranscriptionResults';
import { ManualEntryForm } from '../components/ManualEntryForm';
import { LocationPicker } from '../components/LocationPicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { api, TranscriptionResult } from '../services/api';
import { errorMessage } from '../utils/errors';
import { theme } from '../theme';
import Toast from 'react-native-toast-message';
import * as FileSystem from 'expo-file-system';

export const ModernRecordScreen: React.FC = () => {
  const audioRecorderRef = useRef<any>(null);

  // Recording states
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  // The recording file the screen currently holds. C-65: a file leaves the app's cache
  // once it is replaced, saved, discarded or the screen goes away; until then it is
  // kept so "Try Again" can resend it.
  const recordingUriRef = useRef<string | null>(null);
  const holdRecording = (uri: string | null) => {
    const previous = recordingUriRef.current;
    if (previous && previous !== uri) FileSystem.deleteAsync(previous, { idempotent: true }).catch(() => {});
    recordingUriRef.current = uri;
    setRecordingUri(uri);
  };
  useEffect(() => () => {
    if (recordingUriRef.current) FileSystem.deleteAsync(recordingUriRef.current, { idempotent: true }).catch(() => {});
  }, []);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);

  // UI states
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  // A location picked by hand wins; otherwise each recording uses its own GPS fix.
  // Both are cleared once a record is saved or discarded (C-02).
  const [manualLocation, setManualLocation] = useState<RecordingLocation | null>(null);
  const [autoLocation, setAutoLocation] = useState<RecordingLocation | null>(null);
  const selectedLocation = manualLocation ?? autoLocation;
  const [activeTab, setActiveTab] = useState<'record' | 'manual'>('record');

  const clearLocations = () => {
    setManualLocation(null);
    setAutoLocation(null);
  };

  const handleRecordingComplete = async (uri: string, location?: RecordingLocation) => {
    holdRecording(uri);
    setUploadError(null);
    setTranscriptionError(null);
    // This recording's own fix, or none: never the previous recording's
    setAutoLocation(location ?? null);

    await uploadAudioFile(uri);
  };

  const uploadAudioFile = async (uri: string) => {
    try {
      setIsUploading(true);
      setUploadError(null);

      Toast.show({
        type: 'info',
        text1: 'Processing Audio',
        text2: 'Transcribing your recording...',
        position: 'top',
      });

      await transcribeAudio(uri);
    } catch (error) {
      if (__DEV__) console.error('Upload failed:', error);
      setUploadError('Upload failed');
      Toast.show({
        type: 'error',
        text1: 'Upload Failed',
        text2: 'Please try again',
        position: 'top',
      });
    } finally {
      setIsUploading(false);
    }
  };

  const transcribeAudio = async (audioUrl: string) => {
    try {
      setIsTranscribing(true);
      setTranscriptionError(null);

      const result = await api.transcribe(audioUrl);

      setTranscriptionResult(result);

      Toast.show({
        type: 'success',
        text1: 'Transcription Complete',
        text2: 'Review and save the information',
        position: 'top',
      });
    } catch (error) {
      if (__DEV__) console.error('Transcription failed:', error);
      setTranscriptionError('Transcription failed');
      Toast.show({
        type: 'error',
        text1: 'Transcription Failed',
        // The backend detail, e.g. "File is not in M4A format" or a timeout (C-16)
        text2: errorMessage(error),
        position: 'top',
      });
    } finally {
      setIsTranscribing(false);
    }
  };

  // Saved or discarded: the audio has done its job, so it leaves the app's cache (C-65).
  const resetRecording = () => {
    holdRecording(null);
    setUploadError(null);
    setTranscriptionResult(null);
    setTranscriptionError(null);
    clearLocations();
    audioRecorderRef.current?.resetRecording();
  };

  // Re-send the same recording after a failure, instead of making the worker
  // narrate it again (C-38)
  const retryTranscription = () => {
    if (recordingUri) uploadAudioFile(recordingUri);
  };

  const handleLocationSelect = (location: RecordingLocation) => {
    setManualLocation(location);
    setShowLocationPicker(false);
    Toast.show({
      type: 'success',
      text1: 'Location Set',
      text2: location.location.address,
      position: 'top',
    });
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <ScrollView
          style={styles.scrollView}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}
        >
          {/* Tab Selector */}
          <View style={styles.tabContainer}>
            <TouchableOpacity
              style={[
                styles.tab,
                activeTab === 'record' && styles.activeTab,
              ]}
              onPress={() => setActiveTab('record')}
            >
              <Ionicons
                name="mic"
                size={20}
                color={activeTab === 'record' ? theme.colors.primary[600] : theme.colors.text.secondary}
              />
              <Text style={[
                styles.tabText,
                activeTab === 'record' && styles.activeTabText,
              ]}>
                Voice Recording
              </Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[
                styles.tab,
                activeTab === 'manual' && styles.activeTab,
              ]}
              onPress={() => setActiveTab('manual')}
            >
              <Ionicons
                name="create"
                size={20}
                color={activeTab === 'manual' ? theme.colors.primary[600] : theme.colors.text.secondary}
              />
              <Text style={[
                styles.tabText,
                activeTab === 'manual' && styles.activeTabText,
              ]}>
                Manual Entry
              </Text>
            </TouchableOpacity>
          </View>

          {/* Location Card */}
          {selectedLocation && (
            <Card style={styles.locationCard} variant="filled">
              <View style={styles.locationHeader}>
                <Ionicons name="location" size={20} color={theme.colors.primary[600]} />
                <Text style={styles.locationTitle}>Location Set</Text>
                <Badge variant="success" size="small">
                  <Ionicons name="checkmark" size={12} color={theme.colors.success[700]} />
                </Badge>
              </View>
              <Text style={styles.locationAddress}>
                {selectedLocation.location.address}
              </Text>
              <TouchableOpacity
                onPress={() => setShowLocationPicker(true)}
                style={styles.changeLocation}
              >
                <Text style={styles.changeLocationText}>Change location</Text>
              </TouchableOpacity>
            </Card>
          )}

          {/* Content based on active tab */}
          {activeTab === 'record' ? (
            <>
              {/* Recording Section. Hidden while a recording is being uploaded or
                  transcribed, so a second one can't race the first (C-13). */}
              {!transcriptionResult && !isUploading && !isTranscribing && (
                <Card style={styles.recorderCard} padding="large">
                  <ModernAudioRecorder
                    ref={audioRecorderRef}
                    onRecordingComplete={handleRecordingComplete}
                  />
                </Card>
              )}

              {/* Location Button */}
              {!selectedLocation && !transcriptionResult && (
                <Button
                  variant="outline"
                  icon="location"
                  onPress={() => setShowLocationPicker(true)}
                  fullWidth
                  style={styles.locationButton}
                >
                  Set Location
                </Button>
              )}

              {/* Processing States */}
              {(isUploading || isTranscribing) && (
                <Card style={styles.processingCard} variant="filled">
                  <ActivityIndicator size="large" color={theme.colors.primary[600]} />
                  <Text style={styles.processingText}>
                    {isUploading ? 'Uploading audio...' : 'Transcribing...'}
                  </Text>
                </Card>
              )}

              {/* Transcription Results */}
              {transcriptionResult && (
                <View>
                  <TranscriptionResults
                    result={transcriptionResult}
                    // The form shows the one success toast (saved / merged / created)
                    onSave={resetRecording}
                    onCancel={resetRecording}
                    location={selectedLocation?.location}
                  />
                  <Button
                    variant="secondary"
                    icon="refresh"
                    onPress={resetRecording}
                    fullWidth
                    style={styles.newRecordingButton}
                  >
                    New Recording
                  </Button>
                </View>
              )}

              {/* Error Display */}
              {(uploadError || transcriptionError) && (
                <Card style={styles.errorCard} variant="outlined">
                  <Ionicons name="alert-circle" size={24} color={theme.colors.danger[600]} />
                  <Text style={styles.errorText}>
                    {uploadError || transcriptionError}
                  </Text>
                  <Button
                    variant="danger"
                    size="small"
                    onPress={recordingUri ? retryTranscription : resetRecording}
                  >
                    Try Again
                  </Button>
                  {recordingUri && (
                    <Button
                      variant="secondary"
                      size="small"
                      onPress={resetRecording}
                      style={styles.recordAgainButton}
                    >
                      Record again
                    </Button>
                  )}
                </Card>
              )}
            </>
          ) : (
            /* Manual Entry Tab */
            <Card style={styles.manualCard} padding="large">
              <ManualEntryForm
                // The form shows the one success toast and clears itself; the
                // location belonged to that record, so it goes too (C-02),
                // unless a voice recording still needs it: resetRecording
                // clears it after that one is saved or discarded
                onSave={() => {
                  if (!recordingUri && !transcriptionResult) clearLocations();
                }}
                onCancel={() => setActiveTab('record')}
                selectedLocation={selectedLocation?.location ?? null}
              />
            </Card>
          )}
        </ScrollView>
      </KeyboardAvoidingView>

      {/* Location Picker - already has its own Modal */}
      {showLocationPicker && (
        <LocationPicker
          onLocationSelected={handleLocationSelect}
          onCancel={() => setShowLocationPicker(false)}
          initialLocation={selectedLocation?.location}
        />
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface,
  },
  keyboardView: {
    flex: 1,
  },
  scrollView: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.xl,
  },

  // Tabs
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: theme.colors.neutral[100],
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.xs,
    marginVertical: theme.spacing.base,
  },
  tab: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.md,
    borderRadius: theme.borderRadius.sm,
    gap: theme.spacing.sm,
  },
  activeTab: {
    backgroundColor: theme.colors.background,
    ...theme.shadows.sm,
  },
  tabText: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: theme.colors.text.secondary,
  },
  activeTabText: {
    color: theme.colors.primary[600],
  },

  // Cards
  recorderCard: {
    marginBottom: theme.spacing.base,
    backgroundColor: theme.colors.background,
  },
  processingCard: {
    alignItems: 'center',
    padding: theme.spacing.xl,
    marginVertical: theme.spacing.base,
  },
  processingText: {
    marginTop: theme.spacing.base,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
  },
  errorCard: {
    alignItems: 'center',
    padding: theme.spacing.lg,
    marginVertical: theme.spacing.base,
    borderColor: theme.colors.danger[200],
  },
  errorText: {
    marginVertical: theme.spacing.base,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.danger[600],
    textAlign: 'center',
  },
  manualCard: {
    marginTop: theme.spacing.base,
  },

  // Location
  locationCard: {
    marginBottom: theme.spacing.base,
  },
  locationHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    marginBottom: theme.spacing.sm,
  },
  locationTitle: {
    flex: 1,
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
  },
  locationAddress: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
    marginBottom: theme.spacing.sm,
  },
  changeLocation: {
    alignSelf: 'flex-start',
  },
  changeLocationText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.primary[600],
    fontWeight: theme.typography.fontWeight.medium,
  },
  locationButton: {
    marginBottom: theme.spacing.base,
  },

  // Buttons
  newRecordingButton: {
    marginTop: theme.spacing.base,
  },
  recordAgainButton: {
    marginTop: theme.spacing.sm,
  },
});