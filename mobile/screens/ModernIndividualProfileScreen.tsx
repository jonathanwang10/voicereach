import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SearchStackParamList } from '../navigation/types';
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
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Toast from 'react-native-toast-message';
import { useIndividualProfile, useUrgencyOverride } from '../services/queries';
import { errorMessage, showApiError } from '../utils/errors';
import {
  getUrgencyScoreColor,
  getDisplayUrgencyScore,
  getUrgencyLevel,
  daysSince,
  URGENCY_BADGE_VARIANT,
  URGENCY_LABELS,
} from '../utils/urgencyScore';
import { scheduleDelete, DELETE_UNDO_MS } from '../utils/delayedDelete';
import { fieldLabel, formatFieldValue } from '../utils/fieldValues';
import { useCategories } from '../contexts/CategoryContext';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { theme } from '../theme';
import InteractionHistoryItem from '../components/InteractionHistoryItem';
import UrgencyScore from '../components/UrgencyScore';
import InteractionDetailModal from '../components/InteractionDetailModal';
import IndividualLocationMap from '../components/IndividualLocationMap';

export const ModernIndividualProfileScreen: React.FC<NativeStackScreenProps<SearchStackParamList, 'IndividualProfile'>> = ({
  navigation,
  route,
}) => {
  const { categories } = useCategories(); // for field labels (display_name)
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedInteraction, setSelectedInteraction] = useState<any>(null);
  const [modalVisible, setModalVisible] = useState(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'history' | 'map'>('overview');

  const { individualId } = route.params;
  const query = useIndividualProfile(individualId);
  const profile = query.data ?? null;
  // A failure other than "not found" with nothing to show offers a retry (C-17)
  const loadError = !profile && query.isError && (query.error as any)?.status !== 404
    ? errorMessage(query.error) : null;
  const override = useUrgencyOverride(individualId);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerRight: () => (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Delete profile"
          onPress={() => confirmDelete()}
          style={styles.headerButton}
        >
          <Ionicons name="trash" size={22} color={theme.colors.danger[500]} />
        </TouchableOpacity>
      ),
    });
  }, [navigation, individualId, profile]);

  // Only a 404 means the person is gone (deleted elsewhere too, on a background
  // refetch): say so and go back, once
  const wentBack = useRef(false);
  useEffect(() => {
    if ((query.error as any)?.status !== 404 || wentBack.current) return;
    wentBack.current = true;
    Toast.show({ type: 'error', text1: 'Individual not found' });
    navigation.goBack();
  }, [query.error, query.errorUpdatedAt]);

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
                  Toast.show({ type: 'info', text1: 'Too late to undo', text2: `The delete of ${name} is already in progress` });
                }
              },
            });
            navigation.goBack();
          },
        },
      ]
    );
  };

  // A refresh keeps the current profile on screen (no full-screen spinner)
  const handleRefresh = async () => {
    setIsRefreshing(true);
    const result = await query.refetch();
    setIsRefreshing(false);
    if (result.isError && profile && (result.error as any)?.status !== 404) {
      showApiError(result.error, "Couldn't refresh profile");
    }
  };

  const handleInteractionPress = (interaction: any) => {
    setSelectedInteraction(interaction);
    setModalVisible(true);
  };

  const handleCloseModal = () => {
    setModalVisible(false);
    setSelectedInteraction(null);
  };

  const handleUrgencyOverrideChange = (overrideValue: number | null) => {
    if (profile) override.mutate(overrideValue);
  };

  const renderField = (key: string, value: any, isRequired: boolean = false) => {
    if (key === 'name') return null;
    // Empty values are skipped, not shown as "null" (C-09)
    const text = formatFieldValue(value);
    if (text === null) return null;

    const label = fieldLabel(key, categories);

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

  if (query.isPending) {
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
          <Button variant="primary" onPress={() => query.refetch()} style={styles.retryButton}>
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
              <Badge variant={URGENCY_BADGE_VARIANT[getUrgencyLevel(displayScore)]} size="medium">
                {URGENCY_LABELS[getUrgencyLevel(displayScore)]}
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
        categories={categories}
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