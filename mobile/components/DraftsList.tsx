// Drafts (H2-7.7): recordings still on the phone or on the server, until each is
// reviewed or discarded. A row shows the time, the length, the extracted name (never
// the transcript) and where the recording is.
import React from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useNetInfo } from '@react-native-community/netinfo';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../services/api';
import { isOnlineState, removeQueued } from '../services/recordingQueue';
import { recordingKeys, useQueuedRecordings, useRecordingsList } from '../services/recordingQueries';
import { recordingStatusView, StatusView } from '../utils/recordingStatus';
import { showApiError } from '../utils/errors';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { theme } from '../theme';

interface DraftsListProps {
  // The recording the status card already shows
  excludeIds: string[];
  onReview: (recordingId: string) => void;
}

type Row = {
  key: string;
  createdAt: string;
  durationMs: number | null;
  name: string | null;
  status: StatusView;
  onReview?: () => void;
  onDiscard?: () => void;
};

const minutesSeconds = (ms: number | null) => {
  if (ms == null) return '';
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
};

export const DraftsList: React.FC<DraftsListProps> = ({ excludeIds, onReview }) => {
  const queryClient = useQueryClient();
  const online = isOnlineState(useNetInfo());
  const queued = useQueuedRecordings();
  const { data: recordings = [] } = useRecordingsList();

  const discardOnServer = async (id: string) => {
    try {
      await api.deleteRecording(id);
    } catch (error) {
      showApiError(error, "Couldn't discard the recording");
    }
    queryClient.invalidateQueries({ queryKey: recordingKeys.all });
  };

  const rows: Row[] = [
    // On the phone first: not uploaded yet
    ...queued.map(item => {
      const status = recordingStatusView(item, online, null);
      return {
        key: item.clientRecordingId,
        createdAt: item.createdAt,
        durationMs: item.durationMs,
        name: null,
        status,
        onDiscard: status.tone === 'error' ? () => { void removeQueued(item.clientRecordingId); } : undefined,
      };
    }).reverse(),
    ...recordings
      .filter(r => !excludeIds.includes(r.id))
      .map(r => {
        const status = recordingStatusView(null, online, { status: r.status, error: r.error });
        return {
          key: r.id,
          createdAt: r.created_at,
          durationMs: r.duration_ms,
          name: r.name,
          status,
          onReview: r.status === 'ready' ? () => onReview(r.id) : undefined,
          onDiscard: status.tone === 'error' ? () => { void discardOnServer(r.id); } : undefined,
        };
      }),
  ];

  if (rows.length === 0) return null;

  return (
    <Card style={styles.card} variant="outlined">
      <Text style={styles.header} accessibilityRole="header">Drafts ({rows.length})</Text>
      {rows.map(row => {
        const body = (
          <View style={styles.rowText}>
            <Text style={styles.name}>{row.name || 'Recording'}</Text>
            <View style={styles.meta}>
              <Text style={styles.metaText}>{new Date(row.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</Text>
              <Text style={styles.metaText}>{minutesSeconds(row.durationMs)}</Text>
              <Text style={[styles.metaText, row.status.tone === 'error' && styles.error]}>{row.status.label}</Text>
            </View>
          </View>
        );
        return (
          <View key={row.key} style={styles.row}>
            {row.onReview ? (
              <TouchableOpacity
                style={styles.rowButton}
                onPress={row.onReview}
                accessibilityRole="button"
                accessibilityLabel={`${row.name || 'Recording'}, ${row.status.label}. Review`}
              >
                {body}
              </TouchableOpacity>
            ) : body}
            {row.onDiscard && (
              <Button variant="secondary" size="small" onPress={row.onDiscard} accessibilityRole="button">
                Discard
              </Button>
            )}
          </View>
        );
      })}
    </Card>
  );
};

const styles = StyleSheet.create({
  card: {
    marginTop: theme.spacing.md,
    padding: theme.spacing.md,
  },
  header: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
    marginBottom: theme.spacing.sm,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.sm,
    paddingVertical: theme.spacing.sm,
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
  },
  rowButton: {
    flex: 1,
  },
  rowText: {
    flex: 1,
  },
  name: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.primary,
  },
  meta: {
    flexDirection: 'row',
    gap: theme.spacing.sm,
    marginTop: 2,
  },
  metaText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
  },
  error: {
    color: theme.colors.danger[600],
  },
});
