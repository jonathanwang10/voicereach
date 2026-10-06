> **Note (2026):** This is the original hackathon spec, kept as written. The code
> differs in places: skin color was removed as a field; the recording minimum is
> 5 s, not 10 s; embeddings use `text-embedding-3-large` stored as JSONB, not
> `-3-small` with pgvector; there is no ≥ 95% auto-merge (every match ≥ 60 opens
> the merge UI); and several listed endpoints (auth, upload-audio, POST
> interactions, PUT/DELETE individuals) were never built. See the [README](../README.md).

# Comprehensive Product Requirements Document
## Voice Transcription App for SF Homeless Outreach
*Version 4.0 - Complete System Architecture and Implementation Details*

---

## Executive Summary

A mobile voice transcription application designed for San Francisco social workers conducting homeless outreach. The app enables field workers to document interactions through voice recordings or manual entry, with AI-powered transcription and categorization. Built as a 36-hour hackathon MVP demonstrating core functionality with real AI integration.

### Key Capabilities
- **Voice-to-Database**: Record observations, automatically transcribe and categorize into structured data
- **AI-Powered Processing**: OpenAI Whisper for transcription, GPT-4o for categorization
- **Duplicate Detection**: LLM-based similarity matching with confidence scoring
- **Real-time Voice Assistant**: GPT-realtime integration for instant guidance
- **Semantic Search**: Embedding-based search for finding individuals
- **Danger Assessment**: Automated scoring with manual override capability
- **Location Tracking**: GPS capture with address resolution

---

## System Architecture

### Technology Stack

#### Backend (FastAPI)
- **Framework**: FastAPI with Python 3.9+
- **Database**: PostgreSQL via Supabase
- **AI Services**:
  - OpenAI Whisper API (transcription)
  - GPT-4o (categorization)
  - GPT-realtime (voice assistant)
  - text-embedding-3-small (semantic search)
- **Authentication**: Supabase Auth with JWT
- **Storage**: Supabase Storage for audio files
- **Deployment**: Railway.app with CORS for Expo

#### Frontend (React Native)
- **Framework**: React Native with Expo SDK 53
- **Navigation**: React Navigation (Bottom Tabs + Stack)
- **State Management**: React Context API
- **Audio**: expo-av for recording (M4A format, AAC codec)
- **Maps**: react-native-maps with Google Maps
- **Location**: expo-location for GPS
- **UI Components**: Custom components with StyleSheet

#### Database Schema
```sql
-- Core Tables
individuals (
  id UUID PRIMARY KEY,
  name TEXT NOT NULL,
  data JSONB,  -- Flexible field storage
  urgency_score INTEGER,
  urgency_override INTEGER,
  last_location JSONB,
  created_at TIMESTAMP,
  updated_at TIMESTAMP
)

interactions (
  id UUID PRIMARY KEY,
  individual_id UUID REFERENCES individuals,
  user_id UUID REFERENCES auth.users,
  transcription TEXT,
  data JSONB,  -- Changed fields only
  location JSONB,
  created_at TIMESTAMP
)

categories (
  id UUID PRIMARY KEY,
  name TEXT UNIQUE,
  type TEXT,  -- text/number/single_select/multi_select/date/location
  options JSONB,
  priority TEXT,
  danger_weight INTEGER,
  auto_trigger BOOLEAN,
  is_preset BOOLEAN,
  is_required BOOLEAN
)

embeddings (
  id UUID PRIMARY KEY,
  individual_id UUID REFERENCES individuals,
  embedding vector(1536),
  metadata JSONB,
  created_at TIMESTAMP
)
```

---

## Core Features

### 1. Voice Recording & Transcription

#### Recording Specifications
- **Format**: M4A with AAC codec, 64kbps
- **Duration**: 10 seconds minimum, 2 minutes maximum
- **Size**: ~1MB for 2 minutes
- **UI Feedback**:
  - Live duration counter
  - Red text after 1:30
  - Warning modal at 1:45
  - Auto-stop at 2:00

#### Transcription Pipeline
1. **Audio Capture**: expo-av records in M4A format
2. **Upload**: Direct to Supabase Storage (public bucket)
3. **Transcription**: OpenAI Whisper API processes audio
4. **Categorization**: GPT-4o extracts structured data
5. **Validation**: Check required fields (Name, Height, Weight, Skin Color)
6. **Duplicate Check**: LLM compares against existing records

#### API Flow
```javascript
// Frontend
const audioBlob = await recordAudio();
const transcription = await api.transcribe(audioBlob);

// Backend
POST /api/transcribe
- Receives: audio_data (base64) or audio_url
- Returns: {
    transcription: string,
    categorized_data: object,
    missing_required: string[],
    potential_matches: array
  }
```

### 2. Manual Entry System

#### Form Components
- **Text Fields**: Name, additional notes
- **Number Fields**: Height (inches), Weight (pounds), Age
- **Single Select**: Gender, Skin Color, Housing Priority
- **Multi Select**: Medical Conditions, Substance History
- **Location**: GPS with map adjustment

#### Validation Rules
- **Required Fields**: Name, Height, Weight, Skin Color (hardcoded for demo)
- **Number Limits**: 0-300 for height/weight
- **Select Options**: Must match predefined values
- **GPS Capture**: Automatic on form open with manual override

### 3. AI Integration

#### OpenAI Services

**Whisper Transcription**
```python
async def transcribe_audio(audio_url: str) -> str:
    # Uses whisper-1 model
    # Handles M4A, MP3, WAV formats
    # Returns raw transcription text
```

**GPT-4o Categorization**
```python
async def categorize_transcription(text: str, categories: list) -> dict:
    # Custom prompt with category definitions
    # Returns structured JSON matching schema
    # Handles required field extraction
```

**Duplicate Detection**
```python
async def find_duplicates(data: dict) -> list:
    # LLM compares all attributes
    # Returns confidence scores 0-100%
    # Thresholds: ≥95% auto-merge, <95% manual review
```

**Real-time Voice Assistant**
- WebSocket connection to GPT-realtime
- Specialized instructions for homeless outreach
- Audio input/output at 24kHz PCM
- Semantic VAD for turn detection

### 4. Semantic Search

#### Embedding System
- **Model**: text-embedding-3-small (1536 dimensions)
- **Storage**: pgvector extension in PostgreSQL
- **Generation**: Automatic on individual creation/update
- **Search**: Cosine similarity with threshold 0.15

#### Search Flow
```python
POST /api/embeddings/search
{
  "query": "veteran with diabetes near market street",
  "top_k": 10,
  "similarity_threshold": 0.15
}
```

### 5. Danger Assessment

#### Calculation Formula
```javascript
// For number fields
score = (value / 300) * weight

// For single-select fields
score = option_value * weight

// Final calculation
urgency_score = (sum(scores) / sum(weights)) * 100
```

#### Display Logic
- **Green (0-33)**: #10B981
- **Yellow (34-66)**: #F59E0B
- **Red (67-100)**: #EF4444
- **Manual Override**: Slider sets urgency_override field
- **Auto-trigger**: Immediately sets score to 100

### 6. Location Services

#### GPS Pipeline
1. **Permission Request**: On first use
2. **Capture**: When recording/form starts
3. **Display**: Interactive map with draggable pin
4. **Geocoding**: Google Maps API for address
5. **Storage**: {latitude, longitude, address}

#### Address Display
- **List View**: Abbreviated (e.g., "Market St & 5th")
- **Detail View**: Full address
- **Map View**: Pin with info window

---

## User Interface

### Navigation Structure
```
Bottom Tab Navigator
├── Record (default)
│   ├── Voice Recording
│   ├── Manual Entry
│   └── Transcription Results
├── Search
│   ├── Search Bar
│   ├── Results List
│   └── Individual Profile (stack)
├── Voice Assistant
│   ├── Real-time Audio
│   └── Transcript Display
├── Categories
│   ├── Category List
│   └── Add Category
└── Profile
    └── User Info & Logout
```

### Key Screens

#### Record Screen
- **Primary Actions**: Record Audio, Manual Entry
- **Location Display**: Current GPS with address
- **Audio Controls**: Start/Stop, Duration, Playback
- **Results View**: Transcription text, categorized fields
- **Save Options**: Edit before save, discard

#### Search Screen
- **Search Bar**: Real-time filtering
- **Results**: Name, danger score, last seen
- **Semantic Search**: AI-powered relevance
- **Navigation**: Tap to view profile

#### Individual Profile
- **Header**: Name, danger score with color
- **Data Fields**: All current values
- **Location Map**: Last known position
- **History**: Interaction timeline
- **Actions**: Manual danger override, delete

#### Categories Screen
- **List View**: All categories with type/priority
- **Add Category**: Form with type selection
- **Danger Config**: Weight slider for applicable types
- **Presets**: Non-deletable system categories

---

## API Endpoints

### Core APIs

#### Authentication
```
POST /api/auth/login
POST /api/auth/logout
GET  /api/auth/user
```

#### Transcription
```
POST /api/transcribe
POST /api/upload-audio
```

#### Individuals
```
GET  /api/individuals?search=query
GET  /api/individuals/{id}
POST /api/individuals
PUT  /api/individuals/{id}
PUT  /api/individuals/{id}/danger-override
DELETE /api/individuals/{id}
```

#### Interactions
```
GET  /api/individuals/{id}/interactions
POST /api/interactions
```

#### Categories
```
GET  /api/categories
POST /api/categories
```

#### Embeddings
```
POST /api/embeddings/search
POST /api/embeddings/generate/{individual_id}
GET  /api/embeddings/status
```

#### Voice Assistant
```
WS   /api/voice-assistant/realtime/ws
POST /api/voice-assistant/transcribe
```

#### Export
```
GET  /api/export/csv
```

---

## Data Models

### Individual Model
```typescript
interface Individual {
  id: string;
  name: string;
  data: {
    height?: number;
    weight?: number;
    age?: number;
    age?: 'Light' | 'Medium' | 'Dark';
    gender?: string;
    [key: string]: any;  // Dynamic fields
  };
  urgency_score: number;
  urgency_override?: number;
  last_location?: {
    latitude: number;
    longitude: number;
    address: string;
  };
  created_at: string;
  updated_at: string;
}
```

### Category Model
```typescript
interface Category {
  id: string;
  name: string;
  type: 'text' | 'number' | 'single_select' | 'multi_select' | 'date' | 'location';
  options?: Array<{label: string; value: number}> | string[];
  priority: 'high' | 'medium' | 'low';
  danger_weight?: number;  // 0-100, only for number/single_select
  auto_trigger?: boolean;
  is_required: boolean;
  is_preset: boolean;
}
```

### Interaction Model
```typescript
interface Interaction {
  id: string;
  individual_id: string;
  user_id: string;
  transcription?: string;
  data: object;  // Changed fields only
  location?: {
    latitude: number;
    longitude: number;
    address?: string;
  };
  created_at: string;
}
```

---

## Business Logic

### Duplicate Detection Algorithm
1. **Name Matching**: Fuzzy string comparison
2. **Attribute Comparison**: All available fields
3. **Confidence Scoring**:
   - 95-100%: High confidence (streamlined UI)
   - 60-94%: Medium confidence (full comparison)
   - <60%: No match shown
4. **User Decision**: Merge, Create New, or Cancel

### Merge Logic
- **Frontend Controlled**: UI sends complete merged data
- **Field Selection**: User picks value for each field
- **Backend Processing**: Simple update with provided data
- **History Preservation**: Original interactions unchanged

### Required Field Validation
**Hardcoded for Demo:**
- Name (text) - cannot be empty
- Height (number) - 0-300 inches
- Weight (number) - 0-300 pounds
- Skin Color (single_select) - Light/Medium/Dark

### Category Restrictions
- **Danger Weights**: Only for number and single_select types
- **Auto-trigger**: Only for number and single_select types
- **Multi-select**: Cannot have danger values
- **Text/Date/Location**: Cannot affect danger score

---

## Performance Requirements

### Response Times
- **Search**: <500ms for 10,000+ records
- **Transcription**: <5 seconds for 2-minute audio
- **Profile Load**: <1 second
- **Save Operation**: <2 seconds

### Scalability
- **Records**: Support 10,000+ individuals
- **Concurrent Users**: 50+ field workers
- **Audio Storage**: Auto-cleanup after 24 hours
- **Database**: Indexed JSONB queries

### Reliability
- **Offline Handling**: Error messages, no offline mode
- **Session Persistence**: JWT with 24-hour expiry
- **Error Recovery**: Retry logic for API calls
- **Data Validation**: Frontend and backend checks

---

## Security & Privacy

### Authentication
- **Method**: Supabase Auth with JWT
- **Demo Credentials**: demo@sfgov.org / demo123456
- **Token Storage**: Secure storage on device
- **Auto-login**: For hackathon demo only

### Data Protection
- **HTTPS**: All API communications
- **CORS**: Configured for Expo client
- **Audio Files**: Temporary storage only
- **PII Handling**: JSONB encryption at rest

### Access Control
- **User Roles**: Single role for MVP
- **API Protection**: Bearer token required
- **Delete Permission**: User can delete any record (MVP)

---

## Demo Configuration

### Environment Variables
```bash
# Backend (.env)
OPENAI_API_KEY=sk-...
SUPABASE_URL=https://....supabase.co
SUPABASE_SERVICE_KEY=eyJ...
SUPABASE_ANON_KEY=eyJ...

# Frontend (config/api.ts)
API_URL=https://api.railway.app
SUPABASE_URL=https://....supabase.co
SUPABASE_ANON_KEY=eyJ...
```

### Demo Data
- **20 Individuals**: Varied profiles and danger scores
- **Categories**: 10+ including custom fields
- **Interactions**: 3-10 per individual
- **Locations**: Across SF neighborhoods

### Hackathon Shortcuts
- **No Email Verification**: Skip for speed
- **Simple JWT**: No signature verification
- **CORS Allow All**: Development only
- **Mock Fallbacks**: When APIs unavailable
- **Hardcoded Requirements**: Demo fields only

---

## Known Limitations (MVP)

### Features Not Implemented
- Offline mode
- User management
- Role-based access
- Email notifications
- Data analytics dashboard
- Bulk operations
- File attachments
- Multi-language support

### Technical Debt
- No comprehensive error logging
- Limited input validation
- No rate limiting
- Simple duplicate detection
- Basic search (no filters)
- No pagination optimization
- Audio files not deleted after save

### UI/UX Limitations
- No dark mode
- Limited accessibility features
- Basic error messages
- No onboarding flow
- Simple navigation
- No gesture controls
- Fixed English language

---

## Development Guidelines

### Code Organization
```
/backend
  /api         - Route handlers
  /services    - Business logic
  /db          - Database models
  /tests       - Integration tests

/mobile
  /screens     - Page components
  /components  - Reusable UI
  /services    - API clients
  /contexts    - State management
  /utils       - Helper functions
```

### Testing Strategy
- **Backend**: pytest for API endpoints
- **Frontend**: Jest for critical paths
- **Integration**: End-to-end user flows
- **Manual**: Demo script walkthrough

### Deployment Process
1. **Backend**: Railway auto-deploy from main
2. **Frontend**: Expo build for iOS
3. **Database**: Supabase migrations
4. **Monitoring**: Railway logs

---

## Future Enhancements

### Phase 2 Features
- Offline sync with conflict resolution
- Advanced duplicate detection with ML
- Photo capture and storage
- Team collaboration features
- Automated report generation
- Integration with city databases

### Technical Improvements
- GraphQL API migration
- Real-time updates via WebSocket
- Elasticsearch for advanced search
- Redis caching layer
- Kubernetes deployment
- Comprehensive monitoring

### AI Enhancements
- Custom fine-tuned models
- Predictive analytics
- Anomaly detection
- Natural language querying
- Automated insights generation

---

## Conclusion

This Voice Transcription App represents a significant advancement in homeless outreach documentation, reducing hours of manual work to minutes while improving data quality and accessibility. The MVP successfully demonstrates core functionality with real AI integration, providing a foundation for future development and city-wide deployment.

The system architecture balances rapid development needs with production considerations, using modern technologies and best practices where possible within hackathon constraints. The modular design allows for incremental improvements and feature additions based on user feedback and operational requirements.

---

*Document Version: 4.0*
*Last Updated: 2025*
*Status: Active Development*
*Contact: SF Homeless Outreach Team*