import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  Alert,
  SafeAreaView,
  ScrollView,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useFocusEffect } from '@react-navigation/native';
import { SearchResult } from '../types';
import { api } from '../services/api';
import { Button } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { Badge } from '../components/ui/Badge';
import { Input } from '../components/ui/Input';
import { FadeInView } from '../components/ui/AnimatedView';
import { theme } from '../theme';
import { getUrgencyScoreColor, calculateDaysAgo } from '../utils/urgencyScore';

export const ModernSearchScreen: React.FC<{ navigation: any; route: any }> = ({
  navigation,
  route,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [allIndividuals, setAllIndividuals] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const listRef = useRef<FlatList<SearchResult>>(null);
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const clearHighlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadAllIndividuals = async () => {
    try {
      setIsLoading(true);
      console.log('🔄 Loading all individuals...');

      const results = await api.searchIndividuals('');
      console.log('✅ Loaded all individuals:', results);
      setAllIndividuals(results);
      setSearchResults(results);
    } catch (error) {
      console.error('Error loading all individuals:', error);
      Alert.alert('Error', 'Failed to load all individuals. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadAllIndividuals();
  }, []);

  useEffect(() => {
    if (route?.params?.refreshKey) {
      loadAllIndividuals();
    }
  }, [route?.params?.refreshKey]);

  useEffect(() => {
    if (route?.params?.restoredId) {
      setScrollTargetId(route.params.restoredId);
      setHighlightedId(route.params.restoredId);
      if (clearHighlightTimeout.current) {
        clearTimeout(clearHighlightTimeout.current);
      }
      clearHighlightTimeout.current = setTimeout(() => {
        setHighlightedId(null);
      }, 2500);
    }
  }, [route?.params?.restoredId]);

  useEffect(() => {
    if (!scrollTargetId || searchResults.length === 0) return;
    const index = searchResults.findIndex(item => item.id === scrollTargetId);
    if (index >= 0) {
      setTimeout(() => {
        try {
          listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
        } catch (e) {
          // ignore scroll errors
        }
      }, 150);
    }
    setScrollTargetId(null);
  }, [scrollTargetId, searchResults]);

  useFocusEffect(
    React.useCallback(() => {
      loadAllIndividuals();
    }, [])
  );

  useFocusEffect(
    React.useCallback(() => {
      if (searchQuery.trim()) {
        performSearch();
      } else {
        setSearchResults(allIndividuals);
      }
    }, [searchQuery, allIndividuals])
  );

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (searchQuery.trim()) {
        performSearch();
      } else {
        setSearchResults(allIndividuals);
      }
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [searchQuery, allIndividuals]);

  const performSearch = async () => {
    try {
      setIsSearching(true);
      console.log('🔍 Performing search for:', searchQuery);

      let results;
      try {
        console.log('🧠 Attempting semantic search...');
        results = await api.semanticSearchIndividuals(searchQuery);
        console.log('✅ Semantic search successful:', results);
      } catch (semanticError) {
        console.log('⚠️ Semantic search failed, using regular search:', semanticError);
        results = await api.searchIndividuals(searchQuery);
        console.log('✅ Regular search successful:', results);
      }

      console.log('✅ Final search results:', results);
      setSearchResults(results);
    } catch (error) {
      console.error('Error searching individuals:', error);
      Alert.alert('Error', 'Failed to search individuals. Please try again.');
    } finally {
      setIsSearching(false);
    }
  };

  const handleResultPress = (result: SearchResult) => {
    navigation.navigate('IndividualProfile', { individualId: result.id });
  };

  const getUrgencyBadgeVariant = (score: number) => {
    if (score >= 67) return 'danger';
    if (score >= 34) return 'warning';
    return 'success';
  };

  const getUrgencyLabel = (score: number) => {
    if (score >= 67) return 'High Urgency';
    if (score >= 34) return 'Medium Urgency';
    return 'Low Urgency';
  };

  const renderSearchResult = ({ item, index }: { item: SearchResult; index: number }) => {
    const daysAgo = calculateDaysAgo(item.last_interaction_date);
    const urgencyScore = item.urgency_override ?? item.urgency_score ?? 0;
    const isHighlighted = highlightedId === item.id;

    return (
      <FadeInView
        delay={index * 50}
        duration={300}
      >
        <Card
          style={[
            styles.resultCard,
            isHighlighted && styles.highlightedCard,
          ]}
          variant={isHighlighted ? 'filled' : 'elevated'}
          onPress={() => handleResultPress(item)}
        >
        <View style={styles.resultHeader}>
          <View style={styles.nameContainer}>
            <Text style={styles.resultName}>{item.name}</Text>
            {item.similarity_score && (
              <Badge
                variant={item.search_type === 'exact' ? 'primary' : 'secondary'}
                size="small"
                style={styles.matchBadge}
              >
                <Ionicons
                  name={item.search_type === 'exact' ? 'search' : 'bulb-outline'}
                  size={10}
                  color={theme.colors.text.inverse}
                />
                <Text style={styles.matchText}>
                  {item.search_type === 'exact' ? 'Exact' : `${Math.round(item.similarity_score * 100)}%`}
                </Text>
              </Badge>
            )}
          </View>
          <Badge variant={getUrgencyBadgeVariant(urgencyScore)} size="medium">
            {Math.round(urgencyScore)}
          </Badge>
        </View>

        <View style={styles.resultDetails}>
          <View style={styles.detailRow}>
            <Ionicons name="time-outline" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.detailText}>
              Last seen {daysAgo} {daysAgo === 1 ? 'day' : 'days'} ago
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Ionicons name="alert-circle-outline" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.detailText}>
              {getUrgencyLabel(urgencyScore)}
            </Text>
          </View>
        </View>
        </Card>
      </FadeInView>
    );
  };

  const renderEmptyState = () => (
    <View style={styles.emptyState}>
      <Ionicons
        name={searchQuery.trim() ? 'search-outline' : 'people-outline'}
        size={64}
        color={theme.colors.neutral[400]}
      />
      <Text style={styles.emptyTitle}>
        {searchQuery.trim() ? 'No Results Found' : 'No Individuals'}
      </Text>
      <Text style={styles.emptySubtitle}>
        {searchQuery.trim()
          ? 'Try adjusting your search terms'
          : 'No individuals have been recorded yet'}
      </Text>
    </View>
  );

  const renderStats = () => {
    if (isLoading || searchResults.length === 0) return null;

    const totalResults = searchResults.length;
    const highUrgency = searchResults.filter(r => (r.urgency_override ?? r.urgency_score ?? 0) >= 67).length;
    const mediumUrgency = searchResults.filter(r => {
      const score = r.urgency_override ?? r.urgency_score ?? 0;
      return score >= 34 && score < 67;
    }).length;
    const lowUrgency = searchResults.filter(r => (r.urgency_override ?? r.urgency_score ?? 0) < 34).length;

    return (
      <Card style={styles.statsCard} variant="filled">
        <View style={styles.statsHeader}>
          <Ionicons name="analytics-outline" size={20} color={theme.colors.primary[600]} />
          <Text style={styles.statsTitle}>
            {searchQuery.trim() ? 'Search Results' : 'All Individuals'}
          </Text>
        </View>
        <View style={styles.statsGrid}>
          <View style={styles.statItem}>
            <Text style={styles.statNumber}>{totalResults}</Text>
            <Text style={styles.statLabel}>Total</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.colors.danger[600] }]}>{highUrgency}</Text>
            <Text style={styles.statLabel}>High Urgency</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.colors.warning[600] }]}>{mediumUrgency}</Text>
            <Text style={styles.statLabel}>Medium Urgency</Text>
          </View>
          <View style={styles.statItem}>
            <Text style={[styles.statNumber, { color: theme.colors.success[600] }]}>{lowUrgency}</Text>
            <Text style={styles.statLabel}>Low Urgency</Text>
          </View>
        </View>
      </Card>
    );
  };

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.header}>
        <Text style={styles.title}>Search Individuals</Text>
        <Text style={styles.subtitle}>Find and view individual profiles</Text>
      </View>

      <View style={styles.searchSection}>
        <Input
          placeholder="Search by name, description, or details..."
          value={searchQuery}
          onChangeText={setSearchQuery}
          leftIcon="search-outline"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.searchInput}
        />
      </View>

      {renderStats()}

      <View style={styles.resultsContainer}>
        {isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary[600]} />
            <Text style={styles.loadingText}>Loading individuals...</Text>
          </View>
        ) : isSearching ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary[600]} />
            <Text style={styles.loadingText}>Searching...</Text>
          </View>
        ) : searchResults.length > 0 ? (
          <FlatList
            ref={listRef}
            data={searchResults}
            renderItem={({ item, index }) => renderSearchResult({ item, index })}
            keyExtractor={(item) => item.id}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={styles.listContent}
          />
        ) : (
          renderEmptyState()
        )}
      </View>
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface,
  },
  header: {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
  },
  title: {
    fontSize: theme.typography.fontSize['2xl'],
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
    marginBottom: theme.spacing.xs,
  },
  subtitle: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
  },
  searchSection: {
    paddingHorizontal: theme.spacing.base,
    paddingVertical: theme.spacing.md,
    backgroundColor: theme.colors.background,
  },
  searchInput: {
    marginBottom: 0,
  },
  statsCard: {
    marginHorizontal: theme.spacing.base,
    marginBottom: theme.spacing.md,
  },
  statsHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: theme.spacing.sm,
  },
  statsTitle: {
    fontSize: theme.typography.fontSize.base,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
    marginLeft: theme.spacing.sm,
  },
  statsGrid: {
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  statItem: {
    alignItems: 'center',
  },
  statNumber: {
    fontSize: theme.typography.fontSize.xl,
    fontWeight: theme.typography.fontWeight.bold,
    color: theme.colors.text.primary,
  },
  statLabel: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.text.secondary,
    marginTop: theme.spacing.xs,
  },
  resultsContainer: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing.base,
    paddingBottom: theme.spacing.xl,
  },
  resultCard: {
    marginBottom: theme.spacing.md,
  },
  highlightedCard: {
    borderColor: theme.colors.primary[300],
    borderWidth: 2,
  },
  resultHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: theme.spacing.sm,
  },
  nameContainer: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    marginRight: theme.spacing.sm,
  },
  resultName: {
    fontSize: theme.typography.fontSize.lg,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
    marginRight: theme.spacing.sm,
  },
  matchBadge: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  matchText: {
    fontSize: theme.typography.fontSize.xs,
    color: theme.colors.text.inverse,
    marginLeft: theme.spacing.xs,
  },
  resultDetails: {
    gap: theme.spacing.xs,
  },
  detailRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  detailText: {
    fontSize: theme.typography.fontSize.sm,
    color: theme.colors.text.secondary,
    marginLeft: theme.spacing.sm,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingVertical: theme.spacing['2xl'],
  },
  loadingText: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    marginTop: theme.spacing.md,
  },
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: theme.spacing.xl,
  },
  emptyTitle: {
    fontSize: theme.typography.fontSize.xl,
    fontWeight: theme.typography.fontWeight.semibold,
    color: theme.colors.text.primary,
    marginTop: theme.spacing.base,
    marginBottom: theme.spacing.sm,
  },
  emptySubtitle: {
    fontSize: theme.typography.fontSize.base,
    color: theme.colors.text.secondary,
    textAlign: 'center',
  },
});