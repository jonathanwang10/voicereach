"""The transcription prompt: SF places, streets and outreach terms, never person names (H2-3.4)."""
from services.transcribe_vocab import OUTREACH_TERMS, SF_PLACES, SF_STREETS, build_transcribe_prompt

DEMO_NAMES = ("Sarah Smith", "Michael Chen", "John Doe", "Maria Garcia", "Robert Johnson", "James Brown")


def test_prompt_names_places_and_fits_whisper_1s_224_tokens():
    p = build_transcribe_prompt()
    assert "Tenderloin" in p and "SoMa" in p and len(p.split()) <= 150
    assert "\n" not in p and p.startswith("San Francisco street outreach notes.")


def test_prompt_has_no_person_names():
    p = build_transcribe_prompt().lower()
    assert not any(part.lower() in p.split() for n in DEMO_NAMES for part in n.split()[:1])  # no demo first names
    assert not any(n.lower() in p for n in DEMO_NAMES)


def test_the_lists_are_the_planned_size():
    assert 35 <= len(SF_PLACES) <= 45 and 20 <= len(SF_STREETS) <= 30 and OUTREACH_TERMS
    assert "Narcan" in OUTREACH_TERMS and "Market Street" in SF_STREETS
