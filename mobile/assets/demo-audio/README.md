# Demo Audio Files for Voice Transcription App

## Instructions for Creating Demo Audio Files

These are sample recordings for testing `/api/transcribe` manually, for example by playing one near the simulator mic. The three demo scripts to record:

### 1. john-market-street.m4a
**Script:** "Met John near Market Street. About 45 years old, 6 feet tall, maybe 180 pounds. Shows signs of moderate substance abuse, been on streets 3 months. Needs diabetes medication."

**Expected Categorization:**
- name: "John"
- age: 45
- height: 72 (6 feet = 72 inches)
- weight: 180
- substance_abuse_history: "Moderate"
- medical_conditions: "Diabetes"
- location: "Market Street"

### 2. sarah-library.m4a
**Script:** "Sarah by the library, approximately 35, 5 foot 4, 120 pounds. Says she's in recovery, looking for shelter. Has two children staying with relatives."

**Expected Categorization:**
- name: "Sarah"
- age: 35
- height: 64 (5 foot 4 = 64 inches)
- weight: 120
- substance_abuse_history: "In Recovery"
- housing_status: "Looking for shelter"
- family_info: "Two children staying with relatives"

### 3. robert-golden-gate.m4a
**Script:** "Robert at Golden Gate Park. 55 years old, 5 foot 10, 200 pounds. Veteran, mild substance issues. Applied for housing last week."

**Expected Categorization:**
- name: "Robert"
- age: 55
- height: 70 (5 foot 10 = 70 inches)
- weight: 200
- substance_abuse_history: "Mild"
- veteran_status: "Veteran"
- housing_status: "Applied for housing last week"
- location: "Golden Gate Park"

## How to Create These Audio Files

1. **Using Text-to-Speech (Recommended for Demo):**
   - Use macOS: say -o john-market-street.m4a "Met John near Market Street..."
   - Use online TTS services like Google Text-to-Speech
   - Use iOS Voice Memos app and read the scripts

2. **Manual Recording:**
   - Use the app's recording feature to record these scripts
   - Speak clearly and naturally
   - Ensure good audio quality

3. **File Requirements:**
   - Format: M4A with AAC codec
   - Duration: each script reads in roughly 10-20 seconds, comfortably inside
     the recorder's limits (5 s minimum, 2 min maximum)
   - Quality: Clear, understandable speech

## Manual Testing

These clips are for testing by hand, for example by playing one near the
simulator's microphone while recording, or by posting it to `/api/transcribe`.
They exercise:
- Audio upload functionality
- Transcription accuracy
- AI categorization
- Required field validation
- Duplicate detection
- Save flow completion

## File Locations

Place the generated .m4a files in:
`mobile/assets/demo-audio/`

The app does not load these files; nothing in the code references them.
