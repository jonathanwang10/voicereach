"""SF neighbourhood lookup for "most urgent near <area>" (H2-4.7)."""
import pytest

from services.sf_neighborhoods import NEIGHBORHOODS, area_name, haversine_m, resolve_area


def test_names_and_aliases_resolve_to_the_same_centre():
    assert resolve_area("Mission") == resolve_area("the Mission District") == resolve_area("MISSION ") == (37.7599, -122.4148, 1200)
    assert resolve_area("south of market") == resolve_area("SoMa")
    assert resolve_area("the TL") == resolve_area("Tenderloin")

@pytest.mark.parametrize("name", ["", "   ", "Atlantis", "Mission St", "Oakland"])
def test_unknown_areas_are_none(name):
    assert resolve_area(name) is None

def test_about_forty_neighbourhoods_all_inside_sf():
    assert 38 <= len(NEIGHBORHOODS) <= 45
    assert all(37.70 <= n.lat <= 37.84 and -122.52 <= n.lng <= -122.35 and 200 <= n.radius_m <= 2500
               for n in NEIGHBORHOODS.values())

def test_haversine_one_hundredth_of_a_degree_of_latitude():
    assert haversine_m(37.7749, -122.4194, 37.7849, -122.4194) == pytest.approx(1112, abs=2)

def test_area_name_picks_the_containing_neighbourhood():
    assert area_name(37.7847, -122.4145) == "Tenderloin"
    assert area_name(37.0, -122.0) is None
