import React, { useState, useEffect, useLayoutEffect } from 'react';
import {
  View,
  Text,
  ScrollView,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  RefreshControl,
  TouchableOpacity,
  SafeAreaView,
  Dimensions,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { IndividualProfile } from '../types';
import { api } from '../services/api';
import { errorMessage, showApiError } from '../utils/errorHandler';
import { getUrgencyScoreColor, getDisplayUrgencyScore, daysSince } from '../utils/urgencyScore';
import { scheduleDelete, DELETE_UNDO_MS } from '../utils/delayedDelete';
import { formatFieldValue } from '../utils/fieldValues';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { theme } from '../theme';
import InteractionHistoryItem from '../components/InteractionHistoryItem';
import UrgencyScore from '../components/UrgencyScore';
import InteractionDetailModal from '../components/InteractionDetailModal';
import IndividualLocationMap from '../components/IndividualLocationMap';

const { width } = Dimensions.get('window');

export const ModernIndividualProfileScreen: React.FC<{ navigation: any; route: any }> = ({
  navigation,
  route,
}) => {
  const [profile, setProfile] = useState<IndividualProfile | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  // Set when the first load failed for a reason other than "not found" (C-17)
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedInteraction, setSelectedInteraction] = useState<any>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'history' | 'map'>('overview');

  const { individualId } = route.params;

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          accessibilityLabel="Delete profile"
          onPress={() => confirmDelete()}
          style={styles.headerButton}
        >
          <Ionicons name="trash" size={22} color={theme.colors.danger[500]} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, individualId, profile]);

  useEffect(() => {
    loadProfile();
  }, [individualId]);

  // A refresh keeps the current profile on screen (no full-screen spinner). Only a
  // 404 means the person is gone; any other failure keeps the screen and offers a retry.
  const loadProfile = async ({ refresh = false }: { refresh?: boolean } = {}) => {
    try {
      if (!refresh) setIsLoading(true);
      const profileData = await api.getIndividualProfile(individualId);
      setProfile(profileData);
      setLoadError(null);
    } catch (error: any) {
      console.error('Error loading profile:', error);
      if (error?.status === 404) {
        Toast.show({ type: 'error', text1: 'Individual not found' });
        navigation.goBack();
      } else if (refresh && profile) {
        showApiError(error, "Couldn't refresh profile");
      } else {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!refresh) setIsLoading(false);
    }
  };

  // Delayed delete (OD-3): hide now and go back; the real DELETE runs only after
  // the undo window. Undo cancels it. A failed DELETE brings the person back and
  // utils/delayedDelete tells the user.
  const confirmDelete = () => {
    if (!profile) return;
    const { id, name } = profile;
    Alert.alert(
      'Delete Profile',
      `Delete ${name}? You can undo for a few seconds. After that, the profile and its interaction history are permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            const { cancel } = scheduleDelete(id);
            Toast.show({
              type: 'success',
              text1: `${name} deleted`,
              text2: 'Tap to undo',
              visibilityTime: DELETE_UNDO_MS,
              onPress: () => {
                Toast.hide();
                if (cancel()) {
                  Toast.show({ type: 'success', text1: 'Delete undone', text2: `${name} was kept` });
                } else {
                  Toast.show({ type: 'info', text1: 'Too late to undo', text2: `${name} was already deleted` });
                }
              },
            });
            navigation.goBack();
          },
        },
      ]
    );
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    await loadProfile({ refresh: true });
    setIsRefreshing(false);
  };

  const handleInteractionPress = (interaction: any) => {
    setSelectedInteraction(interaction);
    setModalVisible(true);
  };

  const handleCloseModal = () => {
    setModalVisible(false);
    setSelectedInteraction(null);
  };

  const handleUrgencyOverrideChange = async (overrideValue: number | null) => {
    if (!profile) return;

    const previous = profile;
    setProfile({ ...profile, urgency_override: overrideValue });

    try {
      const scores = await api.updateUrgencyOverride(profile.id, overrideValue);
      setProfile(current => current && {
        ...current,
        urgency_score: scores.urgency_score,
        urgency_override: scores.urgency_override,
      });
    } catch (error) {
      setProfile(previous);
      showApiError(error, 'Update failed');
    }
  };

  const getDangerBadgeVariant = (score: number) => {
    if (score >= 67) return 'danger';
    if (score >= 34) return 'warning';
    return 'success';
  };

  const getDangerLabel = (score: number) => {
    if (score >= 67) return 'High Urgency';
    if (score >= 34) return 'Medium Urgency';
    return 'Low Urgency';
  };

  const renderField = (key: string, value: any, isRequired: boolean = false) => {
    if (key === 'name') return null;
    // Empty values are skipped, not shown as "null" (C-09)
    const text = formatFieldValue(value);
    if (text === null) return null;

    const label = key.split('_').map(word =>
      word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');

    return (
      <View key={key} style={styles.fieldItem}>
        <Text style={styles.fieldLabel}>{label}{isRequired && ' *'}</Text>
        <Text style={styles.fieldValue}>
          {text}
        </Text>
      </View>
    );
  };

  const renderInteractionItem = ({ item }: { item: any }) => (
    <InteractionHistoryItem
      interaction={item}
      onPress={handleInteractionPress}
    />
  );

  const renderTabContent = () => {
    if (!profile) return null;

    switch (activeTab) {
      case 'overview':
        return (
          <View style={styles.tabContent}>
            <Card style={styles.infoCard}>
              <View style={styles.cardHeader}>
                <Ionicons name="person-outline" size={20} color={theme.colors.primary[600]} />
                <Text style={styles.cardTitle}>Current Information</Text>
              </View>
              <View style={styles.fieldsGrid}>
                {Object.entries(profile.data).map(([key, value]) =>
                  renderField(key, value, ['height', 'weight'].includes(key))
                )}
              </View>
            </Card>

            <Card style={styles.statsCard}>
              <View style={styles.cardHeader}>
                <Ionicons name="analytics-outline" size={20} color={theme.colors.primary[600]} />
                <Text style={styles.cardTitle}>Profile Statistics</Text>
              </View>
              <View style={styles.statsGrid}>
                <View style={styles.statItem}>
                  <Text style={styles.statNumber}>{profile.total_interactions}</Text>
                  <Text style={styles.statLabel}>Interactions</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={styles.statNumber}>
                    {daysSince(profile.last_seen)}
                  </Text>
                  <Text style={styles.statLabel}>Days Since Last</Text>
                </View>
                <View style={styles.statItem}>
                  <Text style={[
                    styles.statNumber,
                    { color: getUrgencyScoreColor(getDisplayUrgencyScore(profile)) }
                  ]}>
                    {Math.round(getDisplayUrgencyScore(profile))}
                  </Text>
                  <Text style={styles.statLabel}>Urgency Score</Text>
                </View>
              </View>
            </Card>
          </View>
        );

      case 'history':
        return (
          <View style={styles.tabContent}>
            <Card style={styles.historyCard}>
              <View style={styles.cardHeader}>
                <Ionicons name="time-outline" size={20} color={theme.colors.primary[600]} />
                <Text style={styles.cardTitle}>Interaction History</Text>
                <Badge variant="secondary" size="small">
                  {profile.total_interactions}
                </Badge>
              </View>
              {profile.interactions.length > 0 ? (
                <FlatList
                  data={profile.interactions}
                  renderItem={renderInteractionItem}
                  keyExtractor={(item) => item.id}
                  scrollEnabled={false}
                  showsVerticalScrollIndicator={false}
                />
              ) : (
                <View style={styles.emptyState}>
                  <Ionicons name="document-outline" size={48} color={theme.colors.neutral[400]} />
                  <Text style={styles.emptyText}>No interactions recorded</Text>
                </View>
              )}
            </Card>
          </View>
        );

      case 'map':
        return (
          <View style={styles.tabContent}>
            <Card style={styles.mapCard}>
              <View style={styles.cardHeader}>
                <Ionicons name="location-outline" size={20} color={theme.colors.primary[600]} />
                <Text style={styles.cardTitle}>Location History</Text>
              </View>
              <IndividualLocationMap profile={profile} />
            </Card>
          </View>
        );

      default:
        return null;
    }
  };

  if (isLoading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color={theme.colors.primary[600]} />
        <Text style={styles.loadingText}>Loading profile...</Text>
      </View>
    );
  }

  if (!profile) {
    return (
      <View style={styles.errorContainer}>
        <Ionicons name="alert-circle-outline" size={64} color={theme.colors.neutral[400]} />
        <Text style={styles.errorTitle}>{loadError ? "Couldn't load profile" : 'Profile not found'}</Text>
        <Text style={styles.errorText}>{loadError || "This individual's profile could not be loaded"}</Text>
        {loadError ? (
          <Button variant="primary" onPress={() => loadProfile()} style={styles.retryButton}>
            Retry
          </Button>
        ) : null}
        <Button variant={loadError ? 'outline' : 'primary'} onPress={() => navigation.goBack()}>
          Go Back
        </Button>
      </View>
    );
  }

  const displayScore = getDisplayUrgencyScore(profile);

  return (
    <SafeAreaView style={styles.container}>
      <ScrollView
        refreshControl={
          <RefreshControl refreshing={isRefreshing} onRefresh={handleRefresh} />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* Profile Header */}
        <Card style={styles.headerCard} variant="filled">
          <View style={styles.profileHeader}>
            <View style={styles.nameSection}>
              <Text style={styles.profileName}>{profile.name}</Text>
              <Badge variant={getDangerBadgeVariant(displayScore)} size="medium">
                {getDangerLabel(displayScore)}
              </Badge>
            </View>

            <View style={styles.dangerSection}>
              <UrgencyScore
                individual={profile}
                onOverrideChange={handleUrgencyOverrideChange}
                showSlider={true}
              />
            </View>
          </View>
        </Card>

        {/* Tab Navigation */}
        <View style={styles.tabContainer}>
          <TouchableOpacity
            style={[styles.tab, activeTab === 'overview' && styles.activeTab]}
            onPress={() => setActiveTab('overview')}
          >
            <Ionicons
              name="person-outline"
              size={20}
              color={activeTab === 'overview' ? theme.colors.primary[600] : theme.colors.text.secondary}
            />
            <Text style={[
              styles.tabText,
              activeTab === 'overview' && styles.activeTabText,
            ]}>
              Overview
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === 'history' && styles.activeTab]}
            onPress={() => setActiveTab('history')}
          >
            <Ionicons
              name="time-outline"
              size={20}
              color={activeTab === 'history' ? theme.colors.primary[600] : theme.colors.text.secondary}
            />
            <Text style={[
              styles.tabText,
              activeTab === 'history' && styles.activeTabText,
            ]}>
              History
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={[styles.tab, activeTab === 'map' && styles.activeTab]}
            onPress={() => setActiveTab('map')}
          >
            <Ionicons
              name="location-outline"
              size={20}
              color={activeTab === 'map' ? theme.colors.primary[600] : theme.colors.text.secondary}
            />
            <Text style={[
              styles.tabText,
              activeTab === 'map' && styles.activeTabText,
            ]}>
              Map
            </Text>
          </TouchableOpacity>
        </View>

        {/* Tab Content */}
        {renderTabContent()}
      </ScrollView>

      {/* Interaction Detail Modal */}
      <InteractionDetailModal
        visible={modalVisible}
        interaction={selectedInteraction}
        onClose={handleCloseModal}
      />
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
    backgroundColor: theme.colors.surface,
  },
  loadingText: {
    marginTop: theme.spacing.base,
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.surface,
    paddingHorizontal: theme.spacing.xl,
  },
  errorTitle: {
    fontSize: theme.typography.fontSize.xl,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
    marginTop: theme.spacing.base,
    marginBottom: theme.spacing.sm,
  },
  errorText: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    textAlign: 'center',
    marginBottom: theme.spacing.xl,
  },
  retryButton: {
    marginBottom: theme.spacing.md,
  },
  headerButton: {
    paddingHorizontal: theme.spacing.sm,
  },
  headerCard: {
    margin: theme.spacing.base,
    marginBottom: theme.spacing.sm,
  },
  profileHeader: {
    gap: theme.spacing.lg,
  },
  nameSection: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  profileName: {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
    flex: 1,
  },
  dangerSection: {
    marginTop: theme.spacing.sm,
  },
  tabContainer: {
    flexDirection: 'row',
    backgroundColor: theme.colors.neutral[100],
    borderRadius: theme.borderRadius.md,
    padding: theme.spacing.xs,
    marginHorizontal: theme.spacing.base,
    marginBottom: theme.spacing.base,
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
  tabContent: {
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.xl,
  },
  infoCard: {
    marginBottom: theme.spacing.base,
  },
  statsCard: {
    marginBottom: theme.spacing.base,
  },
  historyCard: {
    marginBottom: theme.spacing.base,
  },
  mapCard: {
    marginBottom: theme.spacing.base,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.base,
  },
  cardTitle: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
    marginLeft: theme.spacing.sm,
    flex: 1,
  },
  fieldsGrid: {
    gap: theme.spacing.md,
  },
  fieldItem: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: theme.spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  fieldLabel: {
    fontSize: theme.typography.fontSize.sm,
    fontWeight: theme.typography.fontWeight.medium,
    color: theme.colors.text.secondary,
    flex: 1,
  },
  fieldValue: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.primary,
    textAlign: 'right',
    flex: 1,
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
  },
  statLabel: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.text.secondary,
    marginTop: theme.spacing.xs,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: theme.spacing.xl,
  },
  emptyText: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    marginTop: theme.spacing.base,
  },
});