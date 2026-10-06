import React, { useState, useRef } from 'react';
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
import { ModernAudioRecorder } from '../components/ModernAudioRecorder';
import { TranscriptionResults } from '../components/TranscriptionResults';
import { ManualEntryForm } from '../components/ManualEntryForm';
import { LocationPicker } from '../components/LocationPicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../services/supabase';
import { api, TranscriptionResult } from '../services/api';
import { ErrorHandler } from '../utils/errorHandler';
import { theme } from '../theme';
import Toast from 'react-native-toast-message';

export const ModernRecordScreen: React.FC = () => {
  const { user, loading } = useAuth();
  const audioRecorderRef = useRef<any>(null);

  // Recording states
  const [recordingUri, setRecordingUri] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionResult, setTranscriptionResult] = useState<TranscriptionResult | null>(null);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);

  // UI states
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  const [selectedLocation, setSelectedLocation] = useState<{
    location: {
      latitude: number;
      longitude: number;
      address: string;
    }
  } | null>(null);
  const [activeTab, setActiveTab] = useState<'record' | 'manual'>('record');

  const handleRecordingComplete = async (uri: string, location?: {
    location: {
      latitude: number;
      longitude: number;
      address: string;
    }
  }) => {
    console.log('Recording completed:', uri, location);
    setRecordingUri(uri);
    setUploadError(null);
    setTranscriptionError(null);

    if (location && !selectedLocation) {
      setSelectedLocation(location);
    }

    await uploadAudioFile(uri);
  };

  const uploadAudioFile = async (uri: string) => {
    try {
      setIsUploading(true);
      setUploadError(null);

      console.log('🎤 Starting real voice transcription...');
      Toast.show({
        type: 'info',
        text1: 'Processing Audio',
        text2: 'Transcribing your recording...',
        position: 'top',
      });

      await transcribeAudio(uri);
    } catch (error) {
      console.error('❌ Upload error:', error);
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

      console.log('✅ Transcription completed!');
      setTranscriptionResult(result);

      Toast.show({
        type: 'success',
        text1: 'Transcription Complete',
        text2: 'Review and save the information',
        position: 'top',
      });
    } catch (error) {
      console.error('❌ Transcription error:', error);
      setTranscriptionError('Transcription failed');
      Toast.show({
        type: 'error',
        text1: 'Transcription Failed',
        text2: 'Please try again',
        position: 'top',
      });
    } finally {
      setIsTranscribing(false);
    }
  };

  const resetRecording = () => {
    setRecordingUri(null);
    setUploadError(null);
    setTranscriptionResult(null);
    setTranscriptionError(null);
    audioRecorderRef.current?.resetRecording();
  };

  const handleLocationSelect = (location: any) => {
    setSelectedLocation(location);
    setShowLocationPicker(false);
    Toast.show({
      type: 'success',
      text1: 'Location Set',
      text2: location.location.address,
      position: 'top',
    });
  };

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary[600]} />
      </View>
    );
  }

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
              {/* Recording Section */}
              {!transcriptionResult && (
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
                    onSave={(data) => {
                      console.log('Transcription saved:', data);
                      Toast.show({
                        type: 'success',
                        text1: 'Success',
                        text2: 'Individual information has been saved',
                        position: 'top',
                      });
                      resetRecording();
                    }}
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
                    onPress={resetRecording}
                  >
                    Try Again
                  </Button>
                </Card>
              )}
            </>
          ) : (
            /* Manual Entry Tab */
            <Card style={styles.manualCard} padding="large">
              <ManualEntryForm
                onSave={() => {
                  Toast.show({
                    type: 'success',
                    text1: 'Entry Saved',
                    text2: 'Individual information has been recorded',
                    position: 'top',
                  });
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
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
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
});