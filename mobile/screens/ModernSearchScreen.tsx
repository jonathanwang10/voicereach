import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  SafeAreaView,
  ScrollView,
  TouchableOpacity,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { FlashList } from '@shopify/flash-list';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import type { SearchStackParamList } from '../navigation/types';
import { SearchResult } from '../types';
import { useIndividualSearch, useIndividualsList, useRefreshOnFocus } from '../services/queries';
import { useDebouncedValue } from '../utils/useDebouncedValue';
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
const NO_RESULTS: SearchResult[] = [];
// Rows fade in one after another; cap the stagger so row 100 does not wait 5 s (C-60)
const MAX_FADE_DELAY_MS = 500;

// One row, memoised: FlashList re-renders it only when its own props change
const SearchResultRow = React.memo(({ item, index, isHighlighted, onPress }: {
  item: SearchResult;
  index: number;
  isHighlighted: boolean;
  onPress: (item: SearchResult) => void;
}) => {
  const urgencyScore = scoreOf(item);
  const urgencyLevel = getUrgencyLevel(urgencyScore);

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
        onPress={() => onPress(item)}
        testID={`search-result-${index}`}
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
});

export const ModernSearchScreen: React.FC<NativeStackScreenProps<SearchStackParamList, 'SearchMain'>> = ({
  navigation,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const query = searchQuery.trim();
  const hasQuery = query !== '';
  // One search per pause in typing (C-06, H2-4.5); every query has its own cache entry
  const debounced = useDebouncedValue(query, debounceFor(query));
  // The default list (pages by cursor) and the current query's results are kept apart
  // (H2-6.6), so a background list refresh never replaces search results.
  const list = useIndividualsList();
  const search = useIndividualSearch(hasQuery ? debounced : '');
  const isSearching = hasQuery && (debounced !== query || search.isPending);
  const listRef = useRef<FlashList<SearchResult>>(null);
  // A row that came back (Undo, or a failed delete): scroll to it once it is present
  const [scrollTargetId, setScrollTargetId] = useState<string | null>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const clearHighlightTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Re-render when a delete is scheduled, undone or fails (OD-3)
  const [pendingVersion, setPendingVersion] = useState(0);

  // Rows across the loaded pages, each person once
  const listRows = useMemo(() => {
    const seen = new Set<string>();
    return (list.data?.pages ?? []).flatMap(page => page.items).filter(r => !seen.has(r.id) && !!seen.add(r.id));
  }, [list.data]);
  const shownResults = hasQuery ? search.data ?? NO_RESULTS : listRows;
  const visibleResults = useMemo(
    () => shownResults.filter(r => !isPendingDelete(r.id)),
    [shownResults, pendingVersion]
  );
  // The full-screen error only when there is nothing good to show (C-17)
  const active = hasQuery ? search : list;
  const loadError = !isSearching && active.isError && !active.data ? errorMessage(active.error) : null;
  const isLoadingList = !hasQuery && list.isPending;

  useEffect(() => {
    const unsubscribe = subscribePendingDeletes(({ id, type }) => {
      // A committed delete leaves the cache (useEvictCommittedDeletes, mounted by App)
      if (type === 'cancelled' || type === 'failed') {
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

  // A failed background refresh keeps what is shown and toasts once, unless a delete's
  // "Tap to undo" is showing (one toast at a time, Minor 5)
  const toastedAt = useRef({ list: 0, search: 0 });
  useEffect(() => {
    if (!list.isRefetchError || toastedAt.current.list === list.errorUpdatedAt) return;
    toastedAt.current.list = list.errorUpdatedAt;
    if (!hasPendingDeletes()) showApiError(list.error, "Couldn't refresh the list");
  }, [list.isRefetchError, list.errorUpdatedAt]);
  useEffect(() => {
    if (!search.isRefetchError || toastedAt.current.search === search.errorUpdatedAt) return;
    toastedAt.current.search = search.errorUpdatedAt;
    if (!hasPendingDeletes()) showApiError(search.error, "Couldn't refresh the search results");
  }, [search.isRefetchError, search.errorUpdatedAt]);

  // Coming back to the screen (e.g. from a profile) refreshes in the background (C-60).
  // One stable callback reading the latest state: useFocusEffect re-runs a callback
  // that changes, which would refetch on every keystroke.
  const refreshLatest = useRef(() => {});
  refreshLatest.current = () => {
    list.refetch();
    if (hasQuery && debounced) search.refetch();
  };
  const refreshShown = useCallback(() => refreshLatest.current(), []);
  useRefreshOnFocus(refreshShown);

  // The list is only mounted when no spinner or error view replaces it
  const listMounted = !isSearching && !isLoadingList && !loadError;

  useEffect(() => {
    if (!scrollTargetId || !listMounted) return; // keep the target until the list is back
    const index = visibleResults.findIndex(item => item.id === scrollTargetId);
    if (index < 0) return; // not shown yet: try again when the list changes
    setScrollTargetId(null);
    listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0.2 });
  }, [scrollTargetId, visibleResults, listMounted]);

  const handleRetry = () => {
    if (hasQuery) search.refetch();
    else list.refetch();
  };

  // The next page, for the default list only
  const handleEndReached = () => {
    if (!hasQuery && list.hasNextPage && !list.isFetchingNextPage) list.fetchNextPage();
  };

  const handleResultPress = useCallback((result: SearchResult) => {
    navigation.navigate('IndividualProfile', { individualId: result.id });
  }, [navigation]);

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
    if (isLoadingList || loadError || visibleResults.length === 0) return null;

    // The list's Total is the server's, less the loaded rows hidden as pending deletes;
    // a search counts what it shows. The urgency counts cover the loaded rows.
    const serverTotal = list.data?.pages[0]?.total ?? listRows.length;
    const totalResults = hasQuery
      ? visibleResults.length
      : serverTotal - (listRows.length - visibleResults.length);
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
          testID="search-input"
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
        {isLoadingList ? (
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
          <FlashList
            ref={listRef}
            data={visibleResults}
            renderItem={({ item, index }) => (
              <SearchResultRow
                item={item}
                index={index}
                isHighlighted={highlightedId === item.id}
                onPress={handleResultPress}
              />
            )}
            keyExtractor={(item) => item.id}
            estimatedItemSize={104}
            extraData={highlightedId}
            onEndReached={handleEndReached}
            onEndReachedThreshold={0.5}
            ListFooterComponent={list.isFetchingNextPage && !hasQuery
              ? <ActivityIndicator style={styles.footer} color={theme.colors.primary[600]} />
              : null}
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
  footer: {
    paddingVertical: theme.spacing.md,
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