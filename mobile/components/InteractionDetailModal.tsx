import React from 'react';
import {
  View,
  Text,
  Modal,
  StyleSheet,
  TouchableOpacity,
  ScrollView,
  Alert,
} from 'react-native';
import { Interaction } from '../types';

interface InteractionDetailModalProps {
  visible: boolean;
  interaction: Interaction | null;
  onClose: () => void;
}

export default function InteractionDetailModal({
  visible,
  interaction,
  onClose,
}: InteractionDetailModalProps) {
  if (!interaction) return null;

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

  const handleShare = () => {
    // Mock share functionality
    Alert.alert('Share', 'Share functionality would be implemented here');
  };

  const handleExport = () => {
    // Mock export functionality
    Alert.alert('Export', 'Export functionality would be implemented here');
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
            {Object.keys(interaction.data ?? {}).length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Additional Data</Text>
                {Object.entries(interaction.data ?? {}).map(([key, value]) => (
                  <View key={key} style={styles.infoRow}>
                    <Text style={styles.label}>
                      {key.split('_').map(word => 
                        word.charAt(0).toUpperCase() + word.slice(1)
                      ).join(' ')}:
                    </Text>
                    <Text style={styles.value}>
                      {typeof value === 'boolean' 
                        ? (value ? 'Yes' : 'No')
                        : String(value)
                      }
                    </Text>
                  </View>
                ))}
              </View>
            )}

            {/* Actions */}
            <View style={styles.section}>
              <Text style={styles.sectionTitle}>Actions</Text>
              <View style={styles.actionButtons}>
                <TouchableOpacity style={styles.actionButton} onPress={handleShare}>
                  <Text style={styles.actionButtonText}>Share</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.actionButton} onPress={handleExport}>
                  <Text style={styles.actionButtonText}>Export</Text>
                </TouchableOpacity>
              </View>
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
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
  actionButtons: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginTop: 8,
  },
  actionButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 20,
    paddingVertical: 12,
    borderRadius: 8,
    minWidth: 100,
    alignItems: 'center',
  },
  actionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
}); 