import { supabase, autoLogin } from './supabase';
import { API_CONFIG, getApiUrl } from '../config/api';
import { ErrorHandler } from '../utils/errorHandler';
import { SearchResult, IndividualProfile } from '../types';


// Every backend route and every RLS-protected table needs a signed-in session.
export const getAuthToken = async (): Promise<string> => {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session) {
    await autoLogin();
    ({ data: { session } } = await supabase.auth.getSession());
  }
  if (!session) {
    throw new Error('Not signed in. Check that the demo user exists in Supabase (see README setup).');
  }
  return session.access_token;
};

// Generic API request function with retry logic
const apiRequest = async (
  endpoint: string,
  options: RequestInit = {},
  retries: number = 1
): Promise<any> => {
  // Skip real API calls if disabled
  if (!API_CONFIG.USE_REAL_API) {
    const error = ErrorHandler.handleApiError(new Error('Real API disabled for demo'));
    ErrorHandler.showError(error);
    throw error;
  }

  // Get fresh token for each attempt
  const token = await getAuthToken();

  const config: RequestInit = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...options.headers,
    },
    ...options,
  };

  try {
    const fullUrl = getApiUrl(endpoint);
    console.log(`Making API request to: ${fullUrl}`);
    const response = await fetch(fullUrl, config);

    if (!response.ok) {
      // If we get 401/403 and have retries left, refresh token and retry
      if ((response.status === 401 || response.status === 403) && retries > 0) {
        console.log('Auth error, refreshing session and retrying...');
        // Force refresh session
        const { data: { session }, error } = await supabase.auth.refreshSession();
        if (!error && session) {
          // Retry with fresh token
          return apiRequest(endpoint, options, retries - 1);
        }
      }

      const errorText = await response.text();
      console.error(`API Error ${response.status}:`, errorText);
      const error = ErrorHandler.handleApiError(new Error(`API request failed: ${response.status} ${response.statusText}`));
      ErrorHandler.showError(error);
      throw error;
    }

    const result = await response.json();
    return result;
  } catch (error: any) {
    // Retry on network failures if we have retries left
    if (error.message?.includes('Network request failed') && retries > 0) {
      console.log('Network error, retrying...');
      // Wait a bit before retry
      await new Promise(resolve => setTimeout(resolve, 1000));
      return apiRequest(endpoint, options, retries - 1);
    }

    const appError = ErrorHandler.handleError(error, `API Request to ${endpoint}`);
    ErrorHandler.showError(appError);
    throw appError;
  }
};

// Helper function to calculate days ago
const calculateDaysAgo = (dateString: string): number => {
  const lastSeen = new Date(dateString);
  const now = new Date();
  const diffTime = Math.abs(now.getTime() - lastSeen.getTime());
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays;
};

// Transcription response types
export interface TranscriptionResult {
  transcription: string;
  categorized_data: Record<string, any>;
  missing_required: string[];
  potential_matches: Array<{
    id: string;
    confidence: number;
    name: string;
  }>;
}

// Mock transcription function removed - app now uses real API only

// API functions for your app
export const api = {
  // TASK 3: Audio Recording & Transcription APIs
  
  // Transcribe audio - NEW FUNCTION
  transcribe: async (audioUrl: string): Promise<TranscriptionResult> => {
    try {
      console.log('🎤 Starting real OpenAI Whisper transcription...');
      
      // Convert audio file to base64 for sending
      const response = await fetch(audioUrl);
      const blob = await response.blob();
      const base64Audio = await new Promise<string>((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.readAsDataURL(blob);
      });
      
      console.log('📤 Sending audio to OpenAI Whisper...');
      
      // Send to backend
      const result = await apiRequest('/api/transcribe', {
        method: 'POST',
        body: JSON.stringify({ 
          audio_data: base64Audio,
        }),
      });
      
      console.log('✅ Real transcription completed by OpenAI Whisper');
      return result;
    } catch (error) {
      console.error('❌ Transcription error:', error);
      throw error; // Don't fallback to mock - show real error
    }
  },

  // Save individual (create new or update existing)
  saveIndividual: async (data: any) => {
    try {
      console.log('💾 Saving individual via backend API...');

      // Extract merge-related fields and location
      const {
        existing_individual_id,  // Old field name for backward compatibility
        merge_with_id,            // New field name expected by backend
        location,
        transcription,
        audio_url,
        // These should not be in the categorized data
        id,
        urgency_score,
        urgency_override,
        data: existingData,
        ...categorizedData
      } = data;

      // Determine the merge ID (support both field names)
      const mergeId = merge_with_id || existing_individual_id || null;

      // Build the request body according to backend expectations
      const requestBody: any = {
        data: categorizedData,  // All the categorized fields
        ...(location && { location }),  // Add location if present
        ...(transcription && { transcription }),  // Add transcription if present
        ...(audio_url && { audio_url }),  // Add audio_url if present
      };

      // Add merge_with_id at root level if merging
      if (mergeId) {
        requestBody.merge_with_id = mergeId;
      } else {
        console.log('➕ Creating new individual');
      }


      // Call the backend API endpoint
      const response = await apiRequest('/api/individuals', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });


      // Extract the individual ID from the response
      const individualId = response.individual?.id || response.id;

      if (!individualId) {
        throw new Error('No ID returned from backend');
      }

      return {
        id: individualId,
        success: true,
        message: mergeId
          ? 'Individual data merged successfully'
          : 'New individual saved successfully',
        data: response.individual
      };
    } catch (error: any) {
      console.error('❌ Save individual error:', error);

      // Extract error message from backend response if available
      let errorMessage = 'Failed to save individual';
      if (error.message) {
        errorMessage = error.message;
      } else if (error.response?.data?.detail) {
        errorMessage = error.response.data.detail;
      } else if (error.detail) {
        errorMessage = error.detail;
      }

      throw new Error(errorMessage);
    }
  },

  // TASK 4: Search & Category Management APIs
  
  // Search individuals
  searchIndividuals: async (query: string): Promise<SearchResult[]> => {
    await getAuthToken();
    try {
      console.log('🔍 Searching individuals in database...');
      
      // Use direct Supabase query for real database
      let supabaseQuery = supabase
        .from('individuals')
        .select('*')
        .order('created_at', { ascending: false });

      // Only apply search filter if query is not empty
      if (query.trim()) {
        supabaseQuery = supabaseQuery.or(`name.ilike.%${query}%,data->>'name'.ilike.%${query}%`);
      } else {
        console.log('🔍 No search query, fetching all individuals');
      }

      console.log('🔍 Executing Supabase query...');
      const { data: individuals, error } = await supabaseQuery;

      if (error) {
        console.error('❌ Search error:', error);
        return [];
      }

      
      // Convert to SearchResult format
      const searchResults: SearchResult[] = individuals.map(individual => {
        // Calculate display score (override or calculated)
                const displayScore = individual.urgency_override !== null && individual.urgency_override !== undefined
          ? individual.urgency_override
          : individual.urgency_score;
        
        return {
          id: individual.id,
          name: individual.name,
          urgency_score: displayScore,
          last_seen: individual.updated_at,
          last_seen_days: calculateDaysAgo(individual.updated_at),
          last_interaction_date: individual.updated_at,
          abbreviated_address: "Market St & 5th" // Mock address for now
        };
      });

      return searchResults;
    } catch (error) {
      console.error('❌ Search individuals error:', error);
      return [];
    }
  },

  // Semantic search using embeddings
  semanticSearchIndividuals: async (query: string): Promise<SearchResult[]> => {
    try {
      console.log('🧠 Performing semantic search with embeddings...');
      
      // Call the embedding search endpoint
              const result = await apiRequest('/api/embeddings/search', {
          method: 'POST',
          body: JSON.stringify({ 
            query: query,
            top_k: 20,
            similarity_threshold: 0.15  // Lower threshold for better semantic matching
          }),
        });
      
      
      if (!result.results || !Array.isArray(result.results)) {
        console.log('⚠️ No semantic search results, falling back to regular search');
        return api.searchIndividuals(query);
      }
      
      // Convert hybrid search results to SearchResult format
      const searchResults: SearchResult[] = result.results.map((item: any) => {
        // Calculate display score (override or calculated)
        const displayScore = item.urgency_override !== null && item.urgency_override !== undefined
          ? item.urgency_override
          : item.urgency_score;
        
        return {
          id: item.id,
          name: item.name,
          urgency_score: displayScore,
          last_seen: new Date().toISOString(), // We don't have this in embedding results
          last_seen_days: 0, // We don't have this in embedding results
          last_interaction_date: new Date().toISOString(), // We don't have this in embedding results
          abbreviated_address: "Market St & 5th", // Mock address for now
          similarity_score: item.similarity_score, // Add similarity score for display
          search_type: item.search_type // Add search type (exact/semantic)
        };
      });
      
      return searchResults;
      
    } catch (error) {
      console.error('❌ Semantic search error:', error);
      console.log('🔄 Falling back to regular search...');
      // Fall back to regular search if embedding search fails
      return api.searchIndividuals(query);
    }
  },

  // Get individual profile
  getIndividualProfile: async (individualId: string): Promise<IndividualProfile | null> => {
    try {
      console.log('👤 Fetching individual profile from backend API...');
      
      // Use backend API instead of direct Supabase query
      const result = await apiRequest(`/api/individuals/${individualId}`);

      if (!result || !result.individual) {
        console.error('❌ Profile fetch error: No data returned');
        return null;
      }

      
      // Convert to IndividualProfile format
      const individual = result.individual;
      const interactions = await api.getInteractions(individualId).catch(() => []);
      const profile: IndividualProfile = {
        id: individual.id,
        name: individual.name,
        urgency_score: individual.urgency_score,
        urgency_override: individual.urgency_override,
        data: individual.data || {},
        created_at: individual.created_at,
        updated_at: individual.updated_at,
        last_location: individual.last_location || null,
        interactions,
        total_interactions: interactions.length
      };

      return profile;
    } catch (error) {
      console.error('❌ Get individual profile error:', error);
      return null;
    }
  },

  // Update urgency override
  updateUrgencyOverride: async (individualId: string, overrideValue: number | null): Promise<boolean> => {
    await getAuthToken();
    try {
      console.log('⚠️ Updating urgency override in database...');

      // Use direct Supabase update for real database
      const { data, error } = await supabase
        .from('individuals')
        .update({
          urgency_override: overrideValue,
          updated_at: new Date().toISOString()
        })
        .eq('id', individualId)
        .select()
        .single();

      if (error) {
        console.error('❌ Urgency override update error:', error);
        return false;
      }

      return true;
    } catch (error) {
      console.error('❌ Update urgency override error:', error);
      return false;
    }
  },

  // Delete individual
  deleteIndividual: async (individualId: string): Promise<boolean> => {
    await getAuthToken();
    try {
      console.log('🗑️ Deleting individual from database...');

      // First attempt: delete the individual directly
      let { error } = await supabase
        .from('individuals')
        .delete()
        .eq('id', individualId);

      // If there is a foreign key constraint (23503), delete dependent interactions then retry
      if (error && (error as any).code === '23503') {
        console.warn('⚠️ FK constraint, deleting dependent interactions first...');
        const { error: interactionsError } = await supabase
          .from('interactions')
          .delete()
          .eq('individual_id', individualId);

        if (interactionsError) {
          console.error('❌ Failed to delete dependent interactions:', interactionsError);
          return false;
        }

        // Retry deleting the individual
        const retry = await supabase
          .from('individuals')
          .delete()
          .eq('id', individualId);
        error = retry.error as any;
      }

      if (error) {
        console.error('❌ Delete individual error:', error);
        return false;
      }

      console.log('✅ Successfully deleted individual');
      return true;
    } catch (error) {
      console.error('❌ Delete individual exception:', error);
      return false;
    }
  },

  // Get categories
  getCategories: async (): Promise<any[]> => {
    try {
      // Always use real API - no mock data

      const result = await apiRequest('/api/categories');
      return result.categories || [];
    } catch (error) {
      console.error('Error fetching categories:', error);
      throw error; // Don't fallback to mock data - show real error
    }
  },

  // Export CSV
  exportCSV: async (): Promise<string> => {
    const token = await getAuthToken();
    const response = await fetch(getApiUrl('/api/export'), {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Export failed: ${response.status}`);
    return response.text();
  },

  // Whisper-only transcription for the voice assistant
  transcribeForAssistant: async (uri: string): Promise<string> => {
    const token = await getAuthToken();
    const form = new FormData();
    form.append('audio', { uri, name: 'question.m4a', type: 'audio/m4a' } as any);
    const response = await fetch(getApiUrl('/api/voice-assistant/transcribe'), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    });
    if (!response.ok) throw new Error(`Transcription failed: ${response.status}`);
    return (await response.json()).transcription ?? '';
  },

  // Interaction history for one individual (backend returns `changes`; the app's Interaction type uses `data`)
  getInteractions: async (individualId: string) => {
    const result = await apiRequest(`/api/individuals/${individualId}/interactions`);
    return (result?.interactions ?? []).map((i: any) => ({
      id: i.id,
      individual_id: individualId,
      user_id: '',
      transcription: i.transcription ?? undefined,
      data: i.changes ?? {},
      location: i.location ?? undefined,
      created_at: i.created_at,
      worker_name: i.user_name,
      abbreviated_address: i.location?.address,
    }));
  },

  // Create category
  createCategory: async (data: any) => {
    return apiRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Check for potential duplicates using sophisticated matching
  checkDuplicates: async (data: Record<string, any>): Promise<Array<{id: string, name: string, confidence: number, data: any}>> => {
    try {
      console.log('🔍 API: Making POST request to /api/individuals/check-duplicates');
      
      const result = await apiRequest('/api/individuals/check-duplicates', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      
      const matches = result.potential_matches || [];
      return matches;
    } catch (error) {
      console.error('❌ API: Duplicate check error:', error);
      console.error('❌ API: Error details:', error instanceof Error ? error.message : error);
      return [];
    }
  },
}; 
