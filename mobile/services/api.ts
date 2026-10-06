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
    console.log(`API response from ${endpoint}:`, result);
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

// Mock data for development (until backend is deployed)
const mockIndividuals: SearchResult[] = [
  {
    id: '1',
    name: 'John Doe',
    urgency_score: 75,
    urgency_override: null,
    last_seen_days: calculateDaysAgo('2024-01-15T10:30:00Z'),
    last_interaction_date: '2024-01-15T10:30:00Z',
  },
  {
    id: '2',
    name: 'Sarah Smith',
    urgency_score: 20,
    urgency_override: 40,
    last_seen_days: calculateDaysAgo('2024-01-12T14:20:00Z'),
    last_interaction_date: '2024-01-12T14:20:00Z',
  },
  {
    id: '3',
    name: 'Robert Johnson',
    urgency_score: 90,
    urgency_override: null,
    last_seen_days: calculateDaysAgo('2024-01-16T09:15:00Z'),
    last_interaction_date: '2024-01-16T09:15:00Z',
  },
  {
    id: '4',
    name: 'Maria Garcia',
    urgency_score: 15,
    urgency_override: null,
    last_seen_days: calculateDaysAgo('2024-01-10T16:45:00Z'),
    last_interaction_date: '2024-01-10T16:45:00Z',
  },
  {
    id: '5',
    name: 'David Wilson',
    urgency_score: 60,
    urgency_override: null,
    last_seen_days: calculateDaysAgo('2024-01-14T11:30:00Z'),
    last_interaction_date: '2024-01-14T11:30:00Z',
  },
];

// Mock individual profile data
const mockIndividualProfiles: Record<string, IndividualProfile> = {
  '1': {
    id: '1',
    name: 'John Doe',
    urgency_score: 75,
    urgency_override: null,
    data: {
      name: 'John Doe',
      height: 72,
      weight: 180,
      gender: 'Male',
      substance_abuse_history: ['Moderate'],
    },
    created_at: '2024-01-10T10:00:00Z',
    updated_at: '2024-01-15T10:30:00Z',
    total_interactions: 3,
    last_interaction_date: '2024-01-15T10:30:00Z',
    last_location: {
      latitude: 37.7821638619815,
      longitude: -122.41033921502972,
      address: 'Fort Mason, San Francisco, CA 94123'
    },
    interactions: [
      {
        id: 'int1',
        individual_id: '1',
        user_id: 'user1',
        transcription: 'Met John near Fort Mason. About 45 years old, 6 feet tall, maybe 180 pounds. Light skin. Shows signs of moderate substance abuse, been on streets 3 months. Needs diabetes medication.',
        location: { lat: 37.7821638619815, lng: -122.41033921502972 },
        created_at: '2024-01-15T10:30:00Z',
        worker_name: 'Officer Smith',
        abbreviated_address: 'Fort Mason',
      },
      {
        id: 'int2',
        individual_id: '1',
        user_id: 'user2',
        data: { substance_abuse_history: ['Moderate'] },
        location: { lat: 37.7821638619815, lng: -122.41033921502972 },
        created_at: '2024-01-12T14:20:00Z',
        worker_name: 'Officer Johnson',
        abbreviated_address: 'Fort Mason',
      },
      {
        id: 'int3',
        individual_id: '1',
        user_id: 'user3',
        data: { medical_conditions: ['Diabetes'] },
        location: { lat: 37.7821638619815, lng: -122.41033921502972 },
        created_at: '2024-01-10T10:00:00Z',
        worker_name: 'Officer Davis',
        abbreviated_address: 'Fort Mason',
      },
    ],
  },
  '2': {
    id: '2',
    name: 'Sarah Smith',
    urgency_score: 20,
    urgency_override: 40,
    data: {
      name: 'Sarah Smith',
      height: 65,
      weight: 140,
      gender: 'Female',
      substance_abuse_history: ['None'],
    },
    created_at: '2024-01-08T09:00:00Z',
    updated_at: '2024-01-12T14:20:00Z',
    total_interactions: 2,
    last_interaction_date: '2024-01-12T14:20:00Z',
    last_location: {
      latitude: 37.7821638619815,
      longitude: -122.41033921502972,
      address: 'Fort Mason, San Francisco, CA 94123'
    },
    interactions: [
      {
        id: 'int4',
        individual_id: '2',
        user_id: 'user1',
        transcription: 'Met Sarah at the library. She is 35 years old, 5\'5", about 140 pounds. Medium skin tone. No signs of substance abuse. She is looking for housing assistance.',
        location: { lat: 37.7821638619815, lng: -122.41033921502972 },
        created_at: '2024-01-12T14:20:00Z',
        worker_name: 'Officer Smith',
        abbreviated_address: 'Public Library',
      },
      {
        id: 'int5',
        individual_id: '2',
        user_id: 'user2',
        data: { housing_status: 'Seeking Assistance' },
        location: { lat: 37.7821638619815, lng: -122.41033921502972 },
        created_at: '2024-01-08T09:00:00Z',
        worker_name: 'Officer Johnson',
        abbreviated_address: 'City Hall',
      },
    ],
  },
};

// Mock data store for persistence - All 20 individuals from demo data
const mockDataStore = {
  individuals: {
    "550e8400-e29b-41d4-a716-446655440001": {
      id: "550e8400-e29b-41d4-a716-446655440001",
      name: "Sarah Smith",
      urgency_score: 15,
      urgency_override: null,
      data: { age: 32, height: 65, weight: 140, gender: "Female", substance_abuse_history: ["None"], veteran_status: "No", medical_conditions: ["None"], housing_priority: "Low" },
      created_at: "2024-01-10T09:00:00Z",
      updated_at: "2024-01-15T14:30:00Z",
      total_interactions: 2,
      last_interaction_date: "2024-01-15T14:30:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440002": {
      id: "550e8400-e29b-41d4-a716-446655440002",
      name: "Michael Chen",
      urgency_score: 25,
      urgency_override: null,
      data: { age: 28, height: 68, weight: 155, gender: "Male", substance_abuse_history: ["None"], veteran_status: "No", medical_conditions: ["None"], housing_priority: "Medium" },
      created_at: "2024-01-11T10:15:00Z",
      updated_at: "2024-01-16T11:45:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-16T11:45:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440003": {
      id: "550e8400-e29b-41d4-a716-446655440003",
      name: "Emily Rodriguez",
      urgency_score: 30,
      urgency_override: null,
      data: { age: 35, height: 62, weight: 130, gender: "Female", substance_abuse_history: ["Mild"], veteran_status: "No", medical_conditions: ["Mental Health"], housing_priority: "Medium" },
      created_at: "2024-01-12T08:30:00Z",
      updated_at: "2024-01-17T16:20:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-17T16:20:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440004": {
      id: "550e8400-e29b-41d4-a716-446655440004",
      name: "David Wilson",
      urgency_score: 20,
      urgency_override: null,
      data: { age: 45, height: 70, weight: 175, gender: "Male", substance_abuse_history: ["None"], veteran_status: "Yes", medical_conditions: ["None"], housing_priority: "High" },
      created_at: "2024-01-13T12:00:00Z",
      updated_at: "2024-01-18T09:15:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-18T09:15:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440005": {
      id: "550e8400-e29b-41d4-a716-446655440005",
      name: "Lisa Thompson",
      urgency_score: 18,
      urgency_override: null,
      data: { age: 29, height: 64, weight: 145, gender: "Female", substance_abuse_history: ["Mild"], veteran_status: "No", medical_conditions: ["None"], housing_priority: "Low" },
      created_at: "2024-01-14T14:45:00Z",
      updated_at: "2024-01-19T13:30:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-19T13:30:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440006": {
      id: "550e8400-e29b-41d4-a716-446655440006",
      name: "James Brown",
      urgency_score: 32,
      urgency_override: null,
      data: { age: 52, height: 72, weight: 185, gender: "Male", substance_abuse_history: ["None"], veteran_status: "Yes", medical_conditions: ["Heart Disease"], housing_priority: "High" },
      created_at: "2024-01-15T11:20:00Z",
      updated_at: "2024-01-20T10:45:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-20T10:45:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440007": {
      id: "550e8400-e29b-41d4-a716-446655440007",
      name: "John Doe",
      urgency_score: 75,
      urgency_override: null,
      data: { age: 45, height: 72, weight: 180, gender: "Male", substance_abuse_history: ["Moderate"], veteran_status: "No", medical_conditions: ["Diabetes"], housing_priority: "High" },
      created_at: "2024-01-10T08:00:00Z",
      updated_at: "2024-01-15T15:30:00Z",
      total_interactions: 2,
      last_interaction_date: "2024-01-15T15:30:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440008": {
      id: "550e8400-e29b-41d4-a716-446655440008",
      name: "Maria Garcia",
      urgency_score: 55,
      urgency_override: null,
      data: { age: 38, height: 63, weight: 150, gender: "Female", substance_abuse_history: ["Moderate"], veteran_status: "No", medical_conditions: ["Mental Health"], housing_priority: "Critical" },
      created_at: "2024-01-11T09:30:00Z",
      updated_at: "2024-01-16T12:15:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-16T12:15:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440009": {
      id: "550e8400-e29b-41d4-a716-446655440009",
      name: "Robert Johnson",
      urgency_score: 90,
      urgency_override: null,
      data: { age: 58, height: 70, weight: 200, gender: "Male", substance_abuse_history: ["Severe"], veteran_status: "Yes", medical_conditions: ["Chronic Pain"], housing_priority: "Critical" },
      created_at: "2024-01-12T10:45:00Z",
      updated_at: "2024-01-17T14:20:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-17T14:20:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440010": {
      id: "550e8400-e29b-41d4-a716-446655440010",
      name: "Jennifer Lee",
      urgency_score: 45,
      urgency_override: null,
      data: { age: 42, height: 66, weight: 160, gender: "Female", substance_abuse_history: ["Mild"], veteran_status: "No", medical_conditions: ["Mobility Issues"], housing_priority: "High" },
      created_at: "2024-01-13T13:15:00Z",
      updated_at: "2024-01-18T11:45:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-18T11:45:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440011": {
      id: "550e8400-e29b-41d4-a716-446655440011",
      name: "Thomas Anderson",
      urgency_score: 60,
      urgency_override: null,
      data: { age: 49, height: 71, weight: 190, gender: "Male", substance_abuse_history: ["Moderate"], veteran_status: "Yes", medical_conditions: ["Heart Disease"], housing_priority: "High" },
      created_at: "2024-01-14T15:00:00Z",
      updated_at: "2024-01-19T16:30:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-19T16:30:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440012": {
      id: "550e8400-e29b-41d4-a716-446655440012",
      name: "Amanda White",
      urgency_score: 50,
      urgency_override: null,
      data: { age: 33, height: 65, weight: 145, gender: "Female", substance_abuse_history: ["Severe"], veteran_status: "No", medical_conditions: ["Mental Health"], housing_priority: "Critical" },
      created_at: "2024-01-15T12:30:00Z",
      updated_at: "2024-01-20T13:15:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-20T13:15:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440013": {
      id: "550e8400-e29b-41d4-a716-446655440013",
      name: "Christopher Davis",
      urgency_score: 40,
      urgency_override: null,
      data: { age: 47, height: 69, weight: 175, gender: "Male", substance_abuse_history: ["Moderate"], veteran_status: "No", medical_conditions: ["Diabetes"], housing_priority: "High" },
      created_at: "2024-01-16T09:45:00Z",
      updated_at: "2024-01-21T10:20:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-21T10:20:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440014": {
      id: "550e8400-e29b-41d4-a716-446655440014",
      name: "Jessica Martinez",
      urgency_score: 35,
      urgency_override: null,
      data: { age: 36, height: 64, weight: 155, gender: "Female", substance_abuse_history: ["Mild"], veteran_status: "No", medical_conditions: ["None"], housing_priority: "Medium" },
      created_at: "2024-01-17T11:00:00Z",
      updated_at: "2024-01-22T14:45:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-22T14:45:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440015": {
      id: "550e8400-e29b-41d4-a716-446655440015",
      name: "Daniel Taylor",
      urgency_score: 100,
      urgency_override: null,
      data: { age: 55, height: 73, weight: 210, gender: "Male", substance_abuse_history: ["Severe"], veteran_status: "Yes", medical_conditions: ["Chronic Pain"], housing_priority: "Critical", behavior: "Physical" },
      created_at: "2024-01-10T07:30:00Z",
      updated_at: "2024-01-15T16:45:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-15T16:45:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440016": {
      id: "550e8400-e29b-41d4-a716-446655440016",
      name: "Nicole Clark",
      urgency_score: 100,
      urgency_override: null,
      data: { age: 41, height: 67, weight: 170, gender: "Female", substance_abuse_history: ["Severe"], veteran_status: "No", medical_conditions: ["Mental Health"], housing_priority: "Critical", behavior: "Physical" },
      created_at: "2024-01-11T08:45:00Z",
      updated_at: "2024-01-16T17:20:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-16T17:20:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440017": {
      id: "550e8400-e29b-41d4-a716-446655440017",
      name: "Kevin Lewis",
      urgency_score: 100,
      urgency_override: null,
      data: { age: 44, height: 70, weight: 185, gender: "Male", substance_abuse_history: ["Moderate"], veteran_status: "Yes", medical_conditions: ["Heart Disease"], housing_priority: "Critical", behavior: "Physical" },
      created_at: "2024-01-12T10:15:00Z",
      updated_at: "2024-01-17T18:30:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-17T18:30:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440018": {
      id: "550e8400-e29b-41d4-a716-446655440018",
      name: "Rachel Green",
      urgency_score: 85,
      urgency_override: null,
      data: { age: 39, height: 65, weight: 160, gender: "Female", substance_abuse_history: ["Severe"], veteran_status: "No", medical_conditions: ["Mental Health"], housing_priority: "Critical" },
      created_at: "2024-01-13T12:45:00Z",
      updated_at: "2024-01-18T19:15:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-18T19:15:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440019": {
      id: "550e8400-e29b-41d4-a716-446655440019",
      name: "Steven Hall",
      urgency_score: 80,
      urgency_override: null,
      data: { age: 51, height: 71, weight: 195, gender: "Male", substance_abuse_history: ["Severe"], veteran_status: "Yes", medical_conditions: ["Chronic Pain"], housing_priority: "Critical" },
      created_at: "2024-01-14T14:00:00Z",
      updated_at: "2024-01-19T20:45:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-19T20:45:00Z",
      interactions: []
    },
    "550e8400-e29b-41d4-a716-446655440020": {
      id: "550e8400-e29b-41d4-a716-446655440020",
      name: "Michelle Adams",
      urgency_score: 70,
      urgency_override: null,
      data: { age: 37, height: 66, weight: 165, gender: "Female", substance_abuse_history: ["Moderate"], veteran_status: "No", medical_conditions: ["Mobility Issues"], housing_priority: "High" },
      created_at: "2024-01-15T15:30:00Z",
      updated_at: "2024-01-20T21:30:00Z",
      total_interactions: 1,
      last_interaction_date: "2024-01-20T21:30:00Z",
      interactions: []
    }
  }
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
      console.log('📝 Transcription:', result.transcription);
      console.log('🏷️  Categorized data:', result.categorized_data);
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
      console.log('Data to save:', data);

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
        console.log('🔄 Merging with existing individual:', mergeId);
      } else {
        console.log('➕ Creating new individual');
      }

      console.log('📤 Request body:', requestBody);

      // Call the backend API endpoint
      const response = await apiRequest('/api/individuals', {
        method: 'POST',
        body: JSON.stringify(requestBody),
      });

      console.log('✅ Backend API response:', response);

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
      console.log('Query:', query);
      console.log('Query trimmed:', query.trim());
      console.log('Query length:', query.length);
      
      // Use direct Supabase query for real database
      let supabaseQuery = supabase
        .from('individuals')
        .select('*')
        .order('created_at', { ascending: false });

      // Only apply search filter if query is not empty
      if (query.trim()) {
        console.log('🔍 Applying search filter for query:', query);
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

      console.log('✅ Found individuals:', individuals);
      console.log('✅ Number of individuals found:', individuals?.length || 0);
      
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

      console.log('📋 Search results:', searchResults);
      console.log('📋 Final results count:', searchResults.length);
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
      console.log('Query:', query);
      
      // Call the embedding search endpoint
              const result = await apiRequest('/api/embeddings/search', {
          method: 'POST',
          body: JSON.stringify({ 
            query: query,
            top_k: 20,
            similarity_threshold: 0.15  // Lower threshold for better semantic matching
          }),
        });
      
      console.log('✅ Semantic search results:', result);
      
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
      
      console.log('📋 Hybrid search results converted:', searchResults);
      console.log(`📊 Found ${result.normal_results || 0} exact matches and ${result.semantic_results || 0} semantic matches`);
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
      console.log('Individual ID:', individualId);
      
      // Use backend API instead of direct Supabase query
      const result = await apiRequest(`/api/individuals/${individualId}`);

      if (!result || !result.individual) {
        console.error('❌ Profile fetch error: No data returned');
        return null;
      }

      console.log('✅ Found individual profile:', result.individual);
      
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
      console.log('Individual ID:', individualId);
      console.log('Override value:', overrideValue);

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

      console.log('✅ Successfully updated urgency override:', data);
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
      console.log('Individual ID:', individualId);

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

  // Export data
  exportData: async () => {
    try {
      const result = await apiRequest('/api/export');
      return result;
    } catch (error) {
      console.log('Using mock export');
      // Return mock URL
      return 'mock-csv-export-url';
    }
  },

  // Legacy functions for backward compatibility
  uploadAudio: async (audioUri: string) => {
    try {
      // Always use real API - no mock data

      const token = await getAuthToken();
      const formData = new FormData();
      formData.append('file', {
        uri: audioUri,
        type: 'audio/m4a',
        name: 'recording.m4a',
      } as any);

      const response = await fetch(getApiUrl('/api/upload-audio'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      });

      if (!response.ok) {
        throw new Error('Upload failed');
      }

      return response.json();
    } catch (error) {
      console.error('Upload error:', error);
      return {
        url: null,
        error: 'Upload failed'
      };
    }
  },

  // Create new individual (legacy)
  createIndividual: async (data: any) => {
    return apiRequest('/api/individuals', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Update individual
  updateIndividual: async (id: string, data: any) => {
    return apiRequest(`/api/individuals/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
  },

  // Create interaction
  createInteraction: async (data: any) => {
    return apiRequest('/api/interactions', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Create category
  createCategory: async (data: any) => {
    return apiRequest('/api/categories', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Get all individuals (NEW METHOD)
  getAllIndividuals: async (): Promise<SearchResult[]> => {
    await getAuthToken();
    try {
      console.log('📋 Fetching all individuals from database...');
      
      // Use direct Supabase query for real database
      const { data: individuals, error } = await supabase
        .from('individuals')
        .select('*')
        .order('created_at', { ascending: false });

      if (error) {
        console.error('❌ Get all individuals error:', error);
        return [];
      }

      console.log('✅ Found individuals:', individuals);
      
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

      console.log('📋 All individuals results:', searchResults);
      return searchResults;
    } catch (error) {
      console.error('❌ Get all individuals error:', error);
      return [];
    }
  },

  // Check for potential duplicates using sophisticated matching
  checkDuplicates: async (data: Record<string, any>): Promise<Array<{id: string, name: string, confidence: number, data: any}>> => {
    try {
      console.log('🔍 API: Checking for duplicates with data:', data);
      console.log('🔍 API: Making POST request to /api/individuals/check-duplicates');
      
      const result = await apiRequest('/api/individuals/check-duplicates', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      
      console.log('🔍 API: Raw response from backend:', result);
      const matches = result.potential_matches || [];
      console.log('🔍 API: Found', matches.length, 'potential matches:', matches);
      return matches;
    } catch (error) {
      console.error('❌ API: Duplicate check error:', error);
      console.error('❌ API: Error details:', error.message);
      return [];
    }
  },
}; 
