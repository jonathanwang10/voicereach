// A GPS fix with its geocoded address (backend `LocationData`; address is required)
export interface LocationData {
  latitude: number;
  longitude: number;
  address: string;
}

// One per-field problem from the backend normaliser (POST /api/transcribe `validation_errors`)
export interface FieldError {
  field: string;
  message: string;
}

export interface SearchResult {
  id: string;
  name: string;
  urgency_score: number;
  urgency_override?: number | null;
  display_score?: number; // backend: override if set, else the calculated score
  last_seen: string; // ISO, from the backend: latest interaction, else created_at
  last_seen_days: number; // whole days since last_seen (floor; 0 = today)
  last_interaction_date: string; // compat alias of last_seen
  abbreviated_address?: string;
  similarity_score?: number; // Optional field for embedding search results
  search_type?: 'exact' | 'value' | 'semantic'; // Type of search match
}

export interface Interaction {
  id: string;
  individual_id: string;
  user_id: string;
  transcription?: string; // NULL for manual entries
  data: Record<string, any>; // Only changed fields
  location?: {
    latitude: number;
    longitude: number;
    address: string;
  };
  created_at: string;
  worker_name?: string; // We'll add this for display
  abbreviated_address?: string; // We'll add this for display
}

export interface IndividualProfile {
  id: string;
  name: string;
  urgency_score: number;
  urgency_override?: number | null;
  data: Record<string, any>; // All current field values
  created_at: string;
  updated_at: string;
  interactions: Interaction[];
  total_interactions: number;
  last_seen: string; // latest interaction, else created_at (same rule as the list)
  last_location?: {
    latitude: number;
    longitude: number;
    address: string;
  };
}
