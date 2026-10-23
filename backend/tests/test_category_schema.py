"""The strict extraction schema built from the categories, and the evidence drop rule (H2-3.1, H2-3.3)."""
import pytest

from services.category_schema import (MAX_ENUM_VALUES, build_extraction_schema, has_evidence, number_words,
                                      parse_extraction)

# The 11 presets from supabase/schema.sql
PRESETS = [
    {"name": "name", "display_name": "Name", "type": "text"},
    {"name": "height", "display_name": "Height", "type": "number"},
    {"name": "weight", "display_name": "Weight", "type": "number"},
    {"name": "age", "display_name": "Age", "type": "number"},
    {"name": "gender", "display_name": "Gender", "type": "single_select",
     "options": [{"label": "Male", "value": 0}, {"label": "Female", "value": 0},
                 {"label": "Other", "value": 0}, {"label": "Unknown", "value": 0}]},
    {"name": "substance_abuse_history", "display_name": "Substance Abuse History", "type": "multi_select",
     "options": ["None", "Mild", "Moderate", "Severe", "In Recovery"]},
    {"name": "medical_conditions", "display_name": "Medical Conditions", "type": "multi_select",
     "options": ["Diabetes", "Heart Disease", "Mental Health", "Mobility Issues", "Chronic Pain", "None"]},
    {"name": "veteran_status", "display_name": "Veteran Status", "type": "single_select",
     "options": [{"label": "Yes", "value": 1}, {"label": "No", "value": 0}, {"label": "Unknown", "value": 0}]},
    {"name": "housing_priority", "display_name": "Housing Priority", "type": "single_select",
     "options": [{"label": "Critical", "value": 1}, {"label": "High", "value": 0.7},
                 {"label": "Medium", "value": 0.4}, {"label": "Low", "value": 0.1}]},
    {"name": "behavior", "display_name": "Behavior", "type": "single_select",
     "options": [{"label": "None", "value": 0}, {"label": "Verbal Only", "value": 0.3}, {"label": "Physical", "value": 1}]},
    {"name": "additional_information", "display_name": "Additional Information", "type": "text"},
]


def _walk(node):
    if isinstance(node, dict):
        yield node
        for v in node.values():
            yield from _walk(v)
    elif isinstance(node, list):
        for v in node:
            yield from _walk(v)


def _value(schema, key):
    return schema["properties"][key]["properties"]["value"]


def test_every_object_is_strict_and_lists_every_property_as_required():
    schema = build_extraction_schema(PRESETS)
    objects = [n for n in _walk(schema) if n.get("type") == "object"]
    assert objects and all(o["additionalProperties"] is False and set(o["required"]) == set(o["properties"])
                           for o in objects)


def test_root_is_an_object_without_anyOf():
    s = build_extraction_schema(PRESETS)
    assert s["type"] == "object" and "anyOf" not in str(s)
    assert list(s["properties"]) == [c["name"] for c in PRESETS]


def test_single_select_is_an_enum_of_labels_plus_null():
    v = _value(build_extraction_schema(PRESETS), "gender")
    assert v == {"type": ["string", "null"], "enum": ["Male", "Female", "Other", "Unknown", None]}


def test_multi_select_is_an_array_of_enums_with_one_evidence_per_item():
    wrapper = build_extraction_schema(PRESETS)["properties"]["medical_conditions"]
    assert wrapper["properties"]["value"] == {"type": "array", "items": {"type": "string", "enum": [
        "Diabetes", "Heart Disease", "Mental Health", "Mobility Issues", "Chronic Pain", "None"]}}
    assert wrapper["properties"]["evidence"] == {"type": "array", "items": {"type": "string"}}


def test_number_is_number_or_null_and_text_date_location_are_string_or_null():
    cats = PRESETS + [{"name": "seen_on", "type": "date"}, {"name": "spot", "type": "location"}]
    s = build_extraction_schema(cats)
    assert _value(s, "height") == {"type": ["number", "null"]}
    for key in ("name", "seen_on", "spot"):
        assert _value(s, key) == {"type": ["string", "null"]}
        assert s["properties"][key]["properties"]["evidence"] == {"type": ["string", "null"]}
    assert "Total inches" in s["properties"]["height"]["description"]
    assert s["properties"]["weight"]["description"].endswith("Pounds.")
    assert s["properties"]["gender"]["description"].startswith("Gender (single_select)")


def test_select_without_options_falls_back_to_free_text():
    s = build_extraction_schema([{"name": "mood", "type": "single_select", "options": []},
                                 {"name": "pets", "type": "multi_select", "options": None}])
    assert _value(s, "mood") == {"type": ["string", "null"]}
    assert _value(s, "pets") == {"type": "array", "items": {"type": "string"}}


def test_enum_values_stop_at_the_structured_outputs_limit():                 # Review Focus 2
    cats = [{"name": f"s{i}", "type": "single_select", "options": [{"label": f"o{j}", "value": 0} for j in range(50)]}
            for i in range(25)]
    schema = build_extraction_schema(cats)
    enums = sum(len(n["enum"]) for n in _walk(schema) if "enum" in n)
    assert 950 < enums <= MAX_ENUM_VALUES
    assert _value(schema, "s24") == {"type": ["string", "null"]}            # later ones carry no enum


@pytest.mark.parametrize("n,words", [(0, "zero"), (7, "seven"), (19, "nineteen"), (72, "seventy two"),
                                     (180, "one hundred eighty"), (305, "three hundred five"), (1000, None)])
def test_number_words(n, words):
    assert number_words(n) == words


@pytest.mark.parametrize("value,evidence,transcript,ok", [
    ("Dana", "dana by the  Library", "Met DANA by the library", True),
    ("Dana Smith", "Dana Smith", "Met Dana by the library", False),
    ("Male", None, "He is a man", False),
    ("Male", "  ", "He is a man", False),
    ("O'Neil", "O’Neil", "This is O'Neil", True)])                     # curly quote normalised
def test_evidence_must_be_a_substring_ignoring_case_and_whitespace(value, evidence, transcript, ok):
    assert has_evidence(value, evidence, transcript, "text") is ok


@pytest.mark.parametrize("value,evidence,transcript,ok", [
    (180, "one-eighty", "about 180 pounds", True),           # digits appear
    (180, None, "one hundred and eighty pounds", True),     # number word appears
    (72, None, "seventy-two inches", True),
    (70, "5 foot 10", "he's 5 foot 10", True),              # evidence substring
    (45, None, "in his forties", False),
    (18, None, "180 pounds", False),                        # digits inside a longer number
    (5, None, "about 5.5 feet", False),                     # touching a decimal point
    (180, None, "he weighs 180.", True)])                   # a full stop is not a decimal point
def test_number_evidence_is_lenient(value, evidence, transcript, ok):
    assert has_evidence(value, evidence, transcript, "number") is ok


def test_values_without_evidence_are_dropped_and_counted():
    reply = {"name": {"value": "Dana", "evidence": "Dana"}, "age": {"value": 40, "evidence": "about forty"},
             "gender": {"value": "Male", "evidence": "a man"}}
    ex = parse_extraction(reply, PRESETS, "This is Dana, a woman")
    assert ex.data == {"name": "Dana"} and sorted(ex.dropped) == ["age", "gender"]
    assert ex.evidence == {"name": "Dana"}


def test_multi_select_keeps_only_items_with_evidence():
    reply = {"medical_conditions": {"value": ["Diabetes", "Chronic Pain"], "evidence": ["diabetic", "back pain"]}}
    ex = parse_extraction(reply, PRESETS, "She says she is diabetic")
    assert ex.data == {"medical_conditions": ["Diabetes"]} and ex.dropped == ["medical_conditions"]
    assert ex.evidence == {"medical_conditions": ["diabetic"]}


def test_a_multi_select_with_no_supported_item_is_absent():
    reply = {"medical_conditions": {"value": ["Diabetes"], "evidence": ["diabetic"]}}
    ex = parse_extraction(reply, PRESETS, "Nothing about health")
    assert ex.data == {} and ex.dropped == ["medical_conditions"]


def test_a_small_height_is_read_as_feet():
    ex = parse_extraction({"height": {"value": 6, "evidence": "six feet"}}, PRESETS, "He is six feet tall")
    assert ex.data == {"height": 72}


def test_null_and_empty_values_are_absent_not_dropped():
    reply = {"name": {"value": None, "evidence": None}, "medical_conditions": {"value": [], "evidence": []},
             "age": {"value": None, "evidence": "forty"}}
    ex = parse_extraction(reply, PRESETS, "forty")
    assert ex.data == {} and ex.dropped == []


def test_unknown_keys_in_the_reply_are_ignored():
    ex = parse_extraction({"skin_tone": {"value": "x", "evidence": "x"}, "name": {"value": "x", "evidence": "x"}},
                          PRESETS, "x")
    assert ex.data == {"name": "x"} and ex.dropped == []


def test_a_malformed_wrapper_is_ignored_not_raised():
    ex = parse_extraction({"name": "Dana", "age": {"value": "forty"}}, PRESETS, "Dana forty")
    assert ex.data == {} and ex.dropped == ["age"]        # "name" is not a wrapper; age has no evidence
