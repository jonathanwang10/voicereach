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
import { useNetInfo } from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { ModernAudioRecorder, RecordingLocation } from '../components/ModernAudioRecorder';
import { TranscriptionResults } from '../components/TranscriptionResults';
import { ManualEntryForm } from '../components/ManualEntryForm';
import { LocationPicker } from '../components/LocationPicker';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { api, RecordingDetail } from '../services/api';
import { enqueueRecording, flushQueue, isOnlineState, removeQueued, subscribe } from '../services/recordingQueue';
import { recordingKeys, useQueuedRecordings, useRecording } from '../services/recordingQueries';
import { recordingStatusView } from '../utils/recordingStatus';
import { showApiError } from '../utils/errors';
import { theme } from '../theme';
import Toast from 'react-native-toast-message';

// The recording being followed on this tab: queued on the phone (no recordingId yet),
// then on the server once its upload got a 202 (H2-7.7)
type Current = { clientRecordingId: string; recordingId: string | null };

export const ModernRecordScreen: React.FC = () => {
  const audioRecorderRef = useRef<any>(null);
  const queryClient = useQueryClient();
  const online = isOnlineState(useNetInfo());
  const queued = useQueuedRecordings();

  // A finished recording is queued and uploaded in the background; the recorder is
  // free again at once. The status card follows it until it is ready to review.
  const [current, setCurrentState] = useState<Current | null>(null);
  const currentRef = useRef<Current | null>(null);
  const setCurrent = (next: Current | null) => {
    currentRef.current = next;
    setCurrentState(next);
  };
  const recording = useRecording(current?.recordingId ?? null);
  // The draft open for review (its stored result)
  const [review, setReview] = useState<RecordingDetail | null>(null);

  // UI states
  const [showLocationPicker, setShowLocationPicker] = useState(false);
  // A location picked by hand wins over the recording's own GPS fix, and belongs to
  // the next recording (or the open review) only (C-02)
  const [manualLocation, setManualLocation] = useState<RecordingLocation | null>(null);
  const reviewLocation = review?.location ? { location: review.location } : null;
  const selectedLocation = manualLocation ?? reviewLocation;
  const [activeTab, setActiveTab] = useState<'record' | 'manual'>('record');

  // The current recording's upload got its server id: follow it there
  useEffect(() => subscribe(event => {
    const followed = currentRef.current;
    if (event.type === 'uploaded' && followed?.clientRecordingId === event.clientRecordingId) {
      setCurrent({ ...followed, recordingId: event.recordingId });
    }
  }), []);

  const handleRecordingComplete = async (uri: string, fix: RecordingLocation | undefined, durationMs: number) => {
    try {
      const item = await enqueueRecording(uri, durationMs, (manualLocation ?? fix)?.location ?? null);
      setCurrent({ clientRecordingId: item.clientRecordingId, recordingId: null });
      setManualLocation(null); // it belonged to this recording
      void flushQueue();
    } catch (error) {
      if (__DEV__) console.error('Could not queue the recording:', error);
      showApiError(error, "Couldn't keep the recording");
    }
  };

  const localItem = current ? queued.find(q => q.clientRecordingId === current.clientRecordingId) ?? null : null;
  const serverState = recording.data
    ? { status: recording.data.status, error: recording.data.error }
    : current?.recordingId ? { status: 'queued' as const, error: null } : null;
  const status = current ? recordingStatusView(localItem, online, serverState) : null;

  // Saved or discarded: the draft and its follow-up are done
  const closeAll = () => {
    queryClient.invalidateQueries({ queryKey: recordingKeys.all });
    setReview(null);
    setCurrent(null);
    setManualLocation(null);
    audioRecorderRef.current?.resetRecording();
  };

  // Saved: the server's draft goes (a second save of it is idempotent, so a failed
  // delete only leaves it in Drafts)
  const finish = async (recordingId: string) => {
    try {
      await api.deleteRecording(recordingId);
    } catch (error) {
      if (__DEV__) console.error('Could not remove the draft:', error);
      Toast.show({ type: 'info', text1: "Saved. Couldn't remove the draft.", position: 'top' });
    }
    closeAll();
  };

  const deleteRecording = async (recordingId: string) => {
    try {
      await api.deleteRecording(recordingId);
      closeAll();
    } catch (error) {
      showApiError(error, "Couldn't discard the recording");
    }
  };

  const confirmDiscard = (recordingId: string) => {
    Alert.alert('Discard this recording?', 'The audio and its transcript will be deleted.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => { void deleteRecording(recordingId); } },
    ]);
  };

  const discardRejected = async (clientRecordingId: string) => {
    await removeQueued(clientRecordingId).catch(() => {});
    closeAll();
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

  const renderStatus = () => {
    if (!current || !status) return null;
    return (
      <Card style={styles.statusCard} variant={status.tone === 'error' ? 'outlined' : 'filled'}>
        <View style={styles.statusHeader}>
          {status.tone === 'progress' && <ActivityIndicator color={theme.colors.primary[600]} />}
          {status.tone === 'ready' && <Ionicons name="checkmark-circle" size={22} color={theme.colors.success[600]} />}
          {status.tone === 'error' && <Ionicons name="alert-circle" size={22} color={theme.colors.danger[600]} />}
          <Text style={styles.statusText} accessibilityLiveRegion="polite">{status.label}</Text>
        </View>
        {status.detail ? <Text style={styles.errorText}>{status.detail}</Text> : null}
        {status.tone === 'ready' && recording.data && (
          <View style={styles.statusButtons}>
            <Button variant="primary" size="small" onPress={() => setReview(recording.data!)} accessibilityRole="button">
              Review now
            </Button>
            <Button variant="secondary" size="small" onPress={() => setCurrent(null)} accessibilityRole="button">
              Later
            </Button>
          </View>
        )}
        {status.tone === 'error' && (
          <Button
            variant="danger"
            size="small"
            accessibilityRole="button"
            onPress={() => (current.recordingId
              ? deleteRecording(current.recordingId)
              : discardRejected(current.clientRecordingId))}
          >
            Discard
          </Button>
        )}
      </Card>
    );
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
              {review?.result ? (
                /* The draft open for review: its stored result (H2-7.7) */
                <TranscriptionResults
                  result={review.result}
                  // The form shows the one success toast (saved / merged / created)
                  onSave={() => finish(review.id)}
                  onCancel={() => confirmDiscard(review.id)}
                  location={manualLocation?.location ?? review.location ?? undefined}
                  idempotencyKey={review.id}
                  recheckDuplicates
                />
              ) : (
                <>
                  {/* The recorder is free again as soon as a recording is queued */}
                  <Card style={styles.recorderCard} padding="large">
                    <ModernAudioRecorder
                      ref={audioRecorderRef}
                      onRecordingComplete={handleRecordingComplete}
                    />
                  </Card>

                  {/* Location Button */}
                  {!selectedLocation && (
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

                  {renderStatus()}
                </>
              )}
            </>
          ) : (
            /* Manual Entry Tab */
            <Card style={styles.manualCard} padding="large">
              <ManualEntryForm
                // The form shows the one success toast and clears itself; the
                // location belonged to that record, so it goes too (C-02),
                // unless an open review still needs it
                onSave={() => {
                  if (!review) setManualLocation(null);
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
  statusCard: {
    marginTop: theme.spacing.md,
    padding: theme.spacing.md,
    gap: theme.spacing.sm,
  },
  statusHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
  },
  statusText: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.medium,
    color: theme.colors.text.primary,
  },
  statusButtons: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
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
});