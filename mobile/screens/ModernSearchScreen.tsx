import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  FlatList,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
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
import { formatLastSeen, getUrgencyLevel, UrgencyLevel, URGENCY_BADGE_VARIANT, URGENCY_LABELS } from '../utils/urgencyScore';
import { errorMessage, showApiError } from '../utils/errors';
import { hasPendingDeletes, isPendingDelete, subscribePendingDeletes } from '../utils/delayedDelete';

// The backend's display score: the override if set, else the calculated score
const scoreOf = (r: SearchResult): number => r.display_score ?? r.urgency_override ?? r.urgency_score ?? 0;

// One search per pause in typing. A query of SEMANTIC_MIN_CHARS or more gets a semantic
// leg (an embeddings call) on the server, so it waits for a longer pause (H2-4.5).
export const TEXT_DEBOUNCE_MS = 300;
export const SEMANTIC_DEBOUNCE_MS = 600;
export const SEMANTIC_MIN_CHARS = 3;
export const debounceFor = (query: string): number =>
  query.trim().split(/\s+/).join(' ').length >= SEMANTIC_MIN_CHARS ? SEMANTIC_DEBOUNCE_MS : TEXT_DEBOUNCE_MS;
const HIGHLIGHT_MS = 2500;
// Rows fade in one after another; cap the stagger so row 100 does not wait 5 s (C-60)
const MAX_FADE_DELAY_MS = 500;

export const ModernSearchScreen: React.FC<{ navigation: any; route: any }> = ({
  navigation,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  // The default list (empty query) and the results for the current query are kept
  // apart, so a background list refresh never replaces search results.
  const [allIndividuals, setAllIndividuals] = useState<SearchResult[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  // Set when a load (list) or search failed with nothing good to show: shown instead
  // of "no results" (C-17). A failed background refresh keeps the list and toasts.
  const [listError, setListError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  const hasQuery = searchQuery.trim() !== '';
  const loadError = hasQuery ? searchError : listError;
  const listRef = useRef<FlatList<SearchResult>>(null);
  // A row that came back (Undo, or a failed delete): scroll to it once it is present
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const clearHighlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-render when a delete is scheduled, undone or fails (OD-3)
  const [pendingVersion, setPendingVersion] = useState(0);
  const shownResults = hasQuery ? searchResults : allIndividuals;
  const visibleResults = shownResults.filter(r => !isPendingDelete(r.id));

  // Request sequencing (C-06): only the newest list load / search may touch state,
  // so a slow response for "v" can never overwrite the one for "veteran".
  const listSeq = useRef(0);
  const searchSeq = useRef(0);
  const listLoaded = useRef(false);
  const queryRef = useRef(searchQuery);
  queryRef.current = searchQuery;

  useEffect(() => {
    const unsubscribe = subscribePendingDeletes(({ id, type }) => {
      if (type === 'committed') {
        // Gone from the backend: drop it locally instead of reloading
        setAllIndividuals(list => list.filter(r => r.id !== id));
        setSearchResults(list => list.filter(r => r.id !== id));
      } else if (type === 'cancelled' || type === 'failed') {
        // The person is back in the list: bring their row into view (C-60)
        setScrollTargetId(id);
        setHighlightedId(id);
        if (clearHighlightTimeout.current) clearTimeout(clearHighlightTimeout.current);
        clearHighlightTimeout.current = setTimeout(() => {
          setHighlightedId(null);
          setScrollTargetId(null); // give up if the row never showed (e.g. filtered out)
        }, HIGHLIGHT_MS);
      }
      setPendingVersion(v => v + 1);
    });
    return () => {
      unsubscribe();
      if (clearHighlightTimeout.current) clearTimeout(clearHighlightTimeout.current);
    };
  }, []);

  // The first load shows the spinner (and the retry state if it fails). Later loads
  // run in the background: the last good list stays, and a failure is a toast.
  const loadAllIndividuals = async () => {
    const reqId = ++listSeq.current;
    const background = listLoaded.current;
    if (!background) setIsLoading(true);
    try {
      const results = await api.searchIndividuals('');
      if (reqId !== listSeq.current) return;
      listLoaded.current = true;
      setListError(null);
      setAllIndividuals(results);
    } catch (error) {
      if (reqId !== listSeq.current) return;
      if (background) {
        // One toast at a time: never replace a delete's "Tap to undo" (Minor 5)
        if (!hasPendingDeletes()) showApiError(error, "Couldn't refresh the list");
      } else {
        setListError(errorMessage(error));
      }
    } finally {
      if (reqId === listSeq.current) setIsLoading(false);
    }
  };

  const performSearch = async (query: string, background = false) => {
    const reqId = ++searchSeq.current;
    const isCurrent = () => reqId === searchSeq.current;
    if (!background) setIsSearching(true);
    try {
      let results: SearchResult[];
      try {
        results = await api.semanticSearchIndividuals(query);
      } catch {
        if (!isCurrent()) return;
        // Semantic search failed: fall back to the backend's text search
        results = await api.searchIndividuals(query);
      }
      if (!isCurrent()) return;
      setSearchError(null);
      setSearchResults(results);
    } catch (error) {
      if (!isCurrent()) return;
      if (background) {
        if (!hasPendingDeletes()) showApiError(error, "Couldn't refresh the search results");
      } else {
        setSearchError(errorMessage(error));
      }
    } finally {
      if (isCurrent()) setIsSearching(false);
    }
  };

  // The only load trigger: every focus, including the first (C-60). On a return
  // from a profile it refreshes in the background.
  useFocusEffect(
    React.useCallback(() => {
      loadAllIndividuals();
      const query = queryRef.current.trim();
      if (query) performSearch(query, true);
    }, [])
  );

  // One debounced search per pause in typing (C-06)
  useEffect(() => {
    searchSeq.current++; // drop any in-flight response for an older query
    const query = searchQuery.trim();
    if (!query) {
      setIsSearching(false);
      setSearchError(null);
      return;
    }
    setIsSearching(true); // never show the previous query's results under the new text
    const timeoutId = setTimeout(() => performSearch(query), debounceFor(query));
    return () => clearTimeout(timeoutId);
  }, [searchQuery]);

  // The FlatList is only mounted when no spinner or error view replaces it
  const listMounted = !isSearching && !(isLoading && !hasQuery) && !loadError;
  const scrollRetries = useRef(0);
  const scrollRetryTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (scrollRetryTimeout.current) clearTimeout(scrollRetryTimeout.current);
  }, []);

  useEffect(() => {
    if (!scrollTargetId || !listMounted) return; // keep the target until the list is back
    const index = visibleResults.findIndex(item => item.id === scrollTargetId);
    if (index < 0) return; // not shown yet: try again when the list changes
    setScrollTargetId(null);
    scrollRetries.current = 0;
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
  }, [scrollTargetId, shownResults, pendingVersion, listMounted]);

  // scrollToIndex needs the row's layout; if it is not measured yet, scroll near it
  // first and try once more (only once).
  const handleScrollToIndexFailed = (info: { index: number; averageItemLength: number }) => {
    listRef.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: true });
    if (scrollRetries.current >= 1) return;
    scrollRetries.current += 1;
    if (scrollRetryTimeout.current) clearTimeout(scrollRetryTimeout.current);
    scrollRetryTimeout.current = setTimeout(() => {
      scrollRetryTimeout.current = null;
      listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.2 });
    }, 250);
  };

  const handleRetry = () => {
    if (hasQuery) {
      performSearch(searchQuery.trim());
    } else {
      loadAllIndividuals();
    }
  };

  const handleResultPress = (result: SearchResult) => {
    navigation.navigate('IndividualProfile', { individualId: result.id });
  };

  const renderSearchResult = ({ item, index }: { item: SearchResult; index: number }) => {
    const urgencyScore = scoreOf(item);
    const urgencyLevel = getUrgencyLevel(urgencyScore);
    const isHighlighted = highlightedId === item.id;

    return (
      <FadeInView
        delay={Math.min(index * 50, MAX_FADE_DELAY_MS)}
        duration={300}
      >
        <Card
          style={[
            styles.resultCard,
            isHighlighted && styles.highlightedCard,
          ]}
          variant={isHighlighted ? 'filled' : 'elevated'}
          onPress={() => handleResultPress(item)}
          accessibilityLabel={`${item.name}, urgency ${Math.round(urgencyScore)}, last seen ${formatLastSeen(item.last_seen_days)}`}
        >
        <View style={styles.resultHeader}>
          <View style={styles.nameContainer}>
            <Text style={styles.resultName}>{item.name}</Text>
            {item.search_type != null && (
              <Badge
                variant={item.search_type === 'semantic' ? 'secondary' : 'primary'}
                size="small"
                style={styles.matchBadge}
              >
                <Ionicons
                  name={item.search_type === 'semantic' ? 'bulb-outline' : 'search'}
                  size={10}
                  color={theme.colors.text.inverse}
                />
                <Text style={styles.matchText}>
                  {item.search_type === 'exact' ? 'Exact'
                    : item.search_type === 'name' ? 'Name'
                    : item.search_type === 'value' ? 'Details'
                    : `${Math.round((item.similarity_score ?? 0) * 100)}%`}
                </Text>
              </Badge>
            )}
          </View>
          <Badge variant={URGENCY_BADGE_VARIANT[urgencyLevel]} size="medium">
            {Math.round(urgencyScore)}
          </Badge>
        </View>

        <View style={styles.resultDetails}>
          <View style={styles.detailRow}>
            <Ionicons name="time-outline" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.detailText}>
              Last seen {formatLastSeen(item.last_seen_days)}
            </Text>
          </View>
          <View style={styles.detailRow}>
            <Ionicons name="alert-circle-outline" size={14} color={theme.colors.text.secondary} />
            <Text style={styles.detailText}>
              {URGENCY_LABELS[urgencyLevel]}
            </Text>
          </View>
        </View>
        </Card>
      </FadeInView>
    );
  };

  const renderErrorState = () => (
    <TouchableOpacity
      style={styles.emptyState}
      onPress={handleRetry}
      accessibilityRole="button"
      accessibilityLabel="Couldn't load. Tap to retry"
    >
      <Ionicons name="cloud-offline-outline" size={64} color={theme.colors.neutral[400]} />
      <Text style={styles.emptyTitle}>Couldn't load — tap to retry</Text>
      {loadError ? <Text style={styles.emptySubtitle}>{loadError}</Text> : null}
    </TouchableOpacity>
  );

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
    if ((!hasQuery && isLoading) || loadError || visibleResults.length === 0) return null;

    const totalResults = visibleResults.length;
    const countAt = (level: UrgencyLevel) => visibleResults.filter(r => getUrgencyLevel(scoreOf(r)) === level).length;
    const highUrgency = countAt('high');
    const mediumUrgency = countAt('medium');
    const lowUrgency = countAt('low');

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
        {!hasQuery && isLoading ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary[600]} />
            <Text style={styles.loadingText}>Loading individuals...</Text>
          </View>
        ) : isSearching ? (
          <View style={styles.loadingContainer}>
            <ActivityIndicator size="large" color={theme.colors.primary[600]} />
            <Text style={styles.loadingText}>Searching...</Text>
          </View>
        ) : loadError ? (
          renderErrorState()
        ) : visibleResults.length > 0 ? (
          <FlatList
            ref={listRef}
            data={visibleResults}
            renderItem={({ item, index }) => renderSearchResult({ item, index })}
            keyExtractor={(item) => item.id}
            onScrollToIndexFailed={handleScrollToIndexFailed}
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