import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Alert,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useAuth } from '../contexts/AuthContext';
import { errorMessage } from '../utils/errors';

// The signed-in Supabase account (OD-4). There is no worker profile behind it, so
// nothing else (name, role, organisation) is shown.
const formatSignInTime = (iso?: string | null): string => {
  if (!iso) return 'Not available';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
};

export default function UserProfileScreen() {
  const { user, signOut } = useAuth();
  const email = user?.email ?? 'Unknown account';

  // A real sign-out. The app then shows a "Signed out" screen; it signs in again
  // automatically the next time it starts (or when the worker taps Sign In).
  const handleSignOut = () => {
    Alert.alert(
      'Sign Out',
      'Sign out of this device? The app signs in again automatically the next time the app starts.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Sign Out',
          style: 'destructive',
          onPress: async () => {
            try {
              await signOut();
            } catch (error) {
              Alert.alert("Couldn't sign out", errorMessage(error));
            }
          },
        },
      ]
    );
  };

  const handleAboutApp = () => {
    Alert.alert(
      'About App',
      'SF Homeless Outreach Voice Transcription App\nVersion 1.0.0\n\nThis app helps street workers document interactions with homeless individuals through voice recording and data management.',
      [{ text: 'OK' }]
    );
  };

  return (
    <ScrollView style={styles.container}>
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.avatarContainer}>
          <Ionicons name="person-circle" size={80} color="#007AFF" />
        </View>
        <Text style={styles.userName}>{email}</Text>
        <Text style={styles.userRole}>Signed in automatically when the app starts</Text>
      </View>

      {/* User Information */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account Information</Text>
        
        <View style={styles.infoRow}>
          <Ionicons name="mail" size={20} color="#6B7280" />
          <Text style={styles.infoLabel}>Email:</Text>
          <Text style={styles.infoValue}>{email}</Text>
        </View>
        
        <View style={styles.infoRow}>
          <Ionicons name="time" size={20} color="#6B7280" />
          <Text style={styles.infoLabel}>Last sign-in:</Text>
          <Text style={styles.infoValue}>{formatSignInTime(user?.last_sign_in_at)}</Text>
        </View>
      </View>

      {/* Actions */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Account Actions</Text>
        
        <TouchableOpacity style={styles.actionButton} onPress={handleAboutApp}>
          <Ionicons name="information-circle" size={20} color="#007AFF" />
          <Text style={styles.actionButtonText}>About App</Text>
          <Ionicons name="chevron-forward" size={20} color="#6B7280" />
        </TouchableOpacity>
      </View>

      {/* Sign Out */}
      <View style={styles.section}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleSignOut}>
          <Ionicons name="log-out" size={20} color="#EF4444" />
          <Text style={styles.logoutButtonText}>Sign Out</Text>
        </TouchableOpacity>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F9FAFB',
  },
  header: {
    alignItems: 'center',
    padding: 30,
    backgroundColor: '#fff',
    borderBottomWidth: 1,
    borderBottomColor: '#E5E7EB',
  },
  avatarContainer: {
    marginBottom: 16,
  },
  userName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#111827',
    marginBottom: 4,
  },
  userRole: {
    fontSize: 16,
    color: '#6B7280',
  },
  section: {
    backgroundColor: '#fff',
    margin: 20,
    borderRadius: 12,
    padding: 20,
    shadowColor: '#000',
    shadowOffset: {
      width: 0,
      height: 1,
    },
    shadowOpacity: 0.1,
    shadowRadius: 2,
    elevation: 2,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: '600',
    color: '#374151',
    marginBottom: 16,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  infoLabel: {
    fontSize: 16,
    fontWeight: '500',
    color: '#374151',
    marginLeft: 12,
    width: 100,
  },
  infoValue: {
    fontSize: 16,
    color: '#6B7280',
    flex: 1,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#F3F4F6',
  },
  actionButtonText: {
    fontSize: 16,
    color: '#111827',
    marginLeft: 12,
    flex: 1,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    backgroundColor: '#FEF2F2',
    borderRadius: 8,
    borderWidth: 1,
    borderColor: '#FECACA',
  },
  logoutButtonText: {
    fontSize: 16,
    fontWeight: '600',
    color: '#EF4444',
    marginLeft: 8,
  },
}); 