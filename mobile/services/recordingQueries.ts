// TanStack hooks for uploaded recordings and the phone's queue (H2-7.7)
import { useEffect, useState } from 'react';
import { useQuery, UseQueryResult } from '@tanstack/react-query';
import { api, RecordingDetail, RecordingSummary } from './api';
import { listQueued, subscribe } from './recordingQueue';
import { QueuedRecording } from './recordingQueueStore';
import { recordingPollInterval } from '../utils/recordingStatus';

export const recordingKeys = {
  all: ['recordings'] as const,
  list: () => ['recordings', 'list'] as const,
  detail: (id: string) => ['recordings', 'detail', id] as const,
};

// One recording, polled every 2 s until it is ready or failed (paused in the background)
export function useRecording(id: string | null): UseQueryResult<RecordingDetail> {
  return useQuery({
    queryKey: recordingKeys.detail(id ?? ''),
    queryFn: () => api.getRecording(id as string),
    enabled: !!id,
    refetchInterval: query => recordingPollInterval(query.state.data?.status),
  });
}

export function useRecordingsList(): UseQueryResult<RecordingSummary[]> {
  return useQuery({
    queryKey: recordingKeys.list(),
    queryFn: () => api.listRecordings(),
    refetchInterval: 30_000,
  });
}

export function useReadyDraftCount(): number {
  const { data } = useRecordingsList();
  return (data ?? []).filter(r => r.status === 'ready').length;
}

// The recordings still on the phone, kept current by the queue's events
export function useQueuedRecordings(): QueuedRecording[] {
  const [items, setItems] = useState<QueuedRecording[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => listQueued().then(next => { if (alive) setItems(next); }).catch(() => {});
    load();
    const unsubscribe = subscribe(load);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);
  return items;
}
