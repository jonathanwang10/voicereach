import React from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
} from 'react-native';
import { Interaction } from '../types';
import { FieldCategory, fieldLabel, formatFieldValue } from '../utils/fieldValues';
import { PrivacyOverlay } from './PrivacyOverlay';

interface InteractionDetailModalProps {
  visible: boolean;
  interaction: Interaction | null;
  onClose: () => void;
  // The categories, for field labels (display_name); a key without one is title-cased.
  categories?: FieldCategory[];
}

export default function InteractionDetailModal({
  visible,
  interaction,
  onClose,
  categories = [],
}: InteractionDetailModalProps) {
  if (!interaction) return null;

  // Empty values are skipped, lists joined, a location shows its address (C-09).
  // A merge that dropped a field lists it in `_removed` (H2-2.5): it shows as
  // "removed", and the list itself is never a field.
  const data = interaction.data ?? {};
  const removed: string[] = Array.isArray(data._removed) ? data._removed : [];
  const changedFields = Object.entries(data)
    .filter(([key]) => key !== '_removed' && !removed.includes(key))
    .map(([key, value]) => [key, formatFieldValue(value)] as const)
    .filter((entry): entry is readonly [string, string] => entry[1] !== null);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatLocation = (location?: { latitude: number; longitude: number }) => {
    if (!location) return 'Location not available';
    return `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent={true}
      onRequestClose={onClose}
    >
      <View style={styles.overlay}>
        <View style={styles.container}>
          {/* Header */}
          <View style={styles.header}>
            <Text style={styles.title}>Interaction Details</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeButton}>
              <Text style={styles.closeButtonText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView style={styles.content} showsVerticalScrollIndicator={false}>
            {/* Basic Info */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Basic Information</Text>
              <View style={styles.infoRow}>
                <Text style={styles.label}>Date & Time:</Text>
                <Text style={styles.value}>{formatDate(interaction.created_at)}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.label}>Worker:</Text>
                <Text style={styles.value}>{interaction.worker_name || 'Not specified'}</Text>
              </View>
              <View style={styles.infoRow}>
                <Text style={styles.label}>Location:</Text>
                <Text style={styles.value}>{interaction.abbreviated_address || formatLocation(interaction.location)}</Text>
              </View>
            </View>

            {/* Transcription */}
            {interaction.transcription && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Transcription</Text>
                <View style={styles.transcriptionContainer}>
                  <Text style={styles.transcriptionText}>{interaction.transcription}</Text>
                </View>
              </View>
            )}

            {/* Additional Data */}
            {(changedFields.length > 0 || removed.length > 0) && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Additional Data</Text>
                {changedFields.map(([key, text]) => (
                  <View key={key} style={styles.infoRow}>
                    <Text style={styles.label}>{fieldLabel(key, categories)}:</Text>
                    <Text style={styles.value}>{text}</Text>
                  </View>
                ))}
                {removed.map(key => (
                  <View key={key} style={styles.infoRow}>
                    <Text style={styles.label}>{fieldLabel(key, categories)}:</Text>
                    <Text style={[styles.value, styles.removedValue]}>removed</Text>
                  </View>
                ))}
              </View>
            )}
          </ScrollView>
        </View>
      </View>
      {/* The modal has its own window: cover it in the app switcher too (H2-6.14) */}
      <PrivacyOverlay />
    </Modal>
  );
}

const styles = StyleSheet.create({
  removedValue: {
    color: '#888',
    fontStyle: 'italic',
  },
  overlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  container: {
    backgroundColor: '#fff',
    borderRadius: 16,
    width: '90%',
    maxHeight: '85%',
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 2,
    },
    shadowOpacity: 0.25,
    shadowRadius: 3.84,
    elevation: 5,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#111827',
  },
  closeButton: {
    padding: 4,
  },
  closeButtonText: {
    fontSize: 24,
    color: '#6B7280',
  },
  content: {
    padding: 20,
  },
  section: {
    marginBottom: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 12,
  },
  infoRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  label: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
    flex: 1,
  },
  value: {
    fontSize: 16,
    color: '#6B7280',
    flex: 2,
    textAlign: 'right',
  },
  transcriptionContainer: {
    backgroundColor: '#F9FAFB',
    borderRadius: 8,
    padding: 16,
    borderLeftWidth: 4,
    borderLeftColor: '#007AFF',
  },
  transcriptionText: {
    fontSize: 16,
    color: '#111827',
    lineHeight: 24,
  },
}); 