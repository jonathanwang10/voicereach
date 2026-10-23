"""
Vocabulary for the transcription prompt (H2-3.4): San Francisco places, streets and
outreach terms, so "Tenderloin" or "Narcan" isn't heard as something else.

Never person names: the prompt goes to OpenAI with every recording, and a name list
would leak who is in the database.
"""

SF_PLACES = (
    "Tenderloin", "SoMa", "Mission", "Civic Center", "Haight", "Bayview", "Hunters Point",
    "Hayes Valley", "Embarcadero", "Union Square", "Nob Hill", "Polk Gulch", "Lower Haight",
    "Western Addition", "Fillmore", "Japantown", "Chinatown", "North Beach",
    "Financial District", "Dogpatch", "Potrero Hill", "Bernal Heights", "Excelsior",
    "Glen Park", "Castro", "Noe Valley", "Golden Gate Park", "Panhandle", "Richmond", "Sunset",
    "Presidio", "Marina", "Treasure Island", "Bayshore", "UN Plaza", "16th and Mission BART",
)

SF_STREETS = (
    "Market Street", "Mission Street", "Van Ness", "Geary", "Turk", "Eddy", "Ellis",
    "Leavenworth", "Hyde", "Polk", "Larkin", "Octavia", "Divisadero", "Golden Gate Avenue",
    "McAllister", "Jones", "Taylor", "Howard", "Folsom", "Valencia", "Cesar Chavez",
    "Third Street", "Sixth Street", "Seventh Street", "Fell", "Haight Street",
)

OUTREACH_TERMS = (
    "Navigation Center", "SRO", "encampment", "shelter bed", "Narcan", "naloxone", "fentanyl",
    "HSH", "VA", "SF General", "HOT team", "SFHOT", "Coordinated Entry", "CalFresh",
    "General Assistance", "Medi-Cal", "detox", "sobering center",
)


def build_transcribe_prompt() -> str:
    """One line of vocabulary for the transcription model's `prompt` (whisper-1 reads at
    most 224 tokens of it)."""
    return ("San Francisco street outreach notes. Places: " + ", ".join(SF_PLACES)
            + "; streets: " + ", ".join(SF_STREETS) + "; terms: " + ", ".join(OUTREACH_TERMS) + ".")
