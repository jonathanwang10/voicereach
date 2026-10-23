"""
San Francisco neighbourhoods for "most urgent near the Mission" (H2-4.7).

A static table of approximate centroids and radii (the owner may refine them) with
common aliases. Matching is exact on a normalised name, never fuzzy, so an unknown
area is None rather than a wrong guess.
"""
import math
import re
from typing import Dict, NamedTuple, Optional, Tuple


class Neighborhood(NamedTuple):
    lat: float
    lng: float
    radius_m: int
    aliases: Tuple[str, ...]


NEIGHBORHOODS: Dict[str, Neighborhood] = {
    "Mission": Neighborhood(37.7599, -122.4148, 1200, ("mission district",)),
    "Tenderloin": Neighborhood(37.7847, -122.4145, 500, ("tl", "the tl")),
    "SoMa": Neighborhood(37.7785, -122.4056, 1200, ("south of market", "soma")),
    "Civic Center": Neighborhood(37.7793, -122.4176, 450, ("civic centre", "city hall")),
    "Mid-Market": Neighborhood(37.7810, -122.4120, 400, ("mid market",)),
    "Union Square": Neighborhood(37.7880, -122.4075, 400, ()),
    "Financial District": Neighborhood(37.7946, -122.3999, 700, ("fidi",)),
    "Chinatown": Neighborhood(37.7941, -122.4078, 400, ()),
    "North Beach": Neighborhood(37.8061, -122.4103, 600, ()),
    "Nob Hill": Neighborhood(37.7930, -122.4161, 500, ()),
    "Russian Hill": Neighborhood(37.8011, -122.4194, 600, ()),
    "Embarcadero": Neighborhood(37.7955, -122.3937, 800, ()),
    "Hayes Valley": Neighborhood(37.7759, -122.4245, 500, ()),
    "Western Addition": Neighborhood(37.7816, -122.4339, 900, ("fillmore", "the fillmore")),
    "Japantown": Neighborhood(37.7854, -122.4294, 350, ()),
    "Lower Haight": Neighborhood(37.7720, -122.4310, 500, ()),
    "Haight-Ashbury": Neighborhood(37.7692, -122.4481, 700, ("haight", "upper haight", "haight ashbury")),
    "Duboce Triangle": Neighborhood(37.7669, -122.4330, 350, ()),
    "Castro": Neighborhood(37.7609, -122.4350, 600, ()),
    "Noe Valley": Neighborhood(37.7502, -122.4337, 900, ()),
    "Twin Peaks": Neighborhood(37.7544, -122.4477, 700, ()),
    "Glen Park": Neighborhood(37.7340, -122.4336, 600, ()),
    "Bernal Heights": Neighborhood(37.7389, -122.4152, 900, ("bernal",)),
    "Potrero Hill": Neighborhood(37.7605, -122.4009, 900, ("potrero",)),
    "Dogpatch": Neighborhood(37.7577, -122.3880, 600, ()),
    "Mission Bay": Neighborhood(37.7706, -122.3915, 800, ()),
    "Bayview-Hunters Point": Neighborhood(37.7290, -122.3920, 1800, ("bayview", "hunters point")),
    "Excelsior": Neighborhood(37.7244, -122.4256, 1100, ()),
    "Outer Mission": Neighborhood(37.7206, -122.4420, 900, ()),
    "Portola": Neighborhood(37.7284, -122.4067, 700, ()),
    "Visitacion Valley": Neighborhood(37.7131, -122.4057, 900, ("vis valley",)),
    "Oceanview-Ingleside": Neighborhood(37.7200, -122.4560, 900, ("ingleside", "oceanview", "omi")),
    "Lakeshore": Neighborhood(37.7190, -122.4850, 1200, ("lake merced",)),
    "Inner Sunset": Neighborhood(37.7602, -122.4690, 900, ()),
    "Outer Sunset": Neighborhood(37.7550, -122.4940, 1500, ("sunset",)),
    "Golden Gate Park": Neighborhood(37.7694, -122.4862, 2000, ("the park", "ggp")),
    "Inner Richmond": Neighborhood(37.7802, -122.4645, 1000, ()),
    "Outer Richmond": Neighborhood(37.7775, -122.4950, 1300, ("richmond",)),
    "Marina": Neighborhood(37.8030, -122.4370, 700, ()),
    "Pacific Heights": Neighborhood(37.7925, -122.4382, 800, ("pac heights",)),
    "Presidio": Neighborhood(37.7989, -122.4662, 1500, ()),
    "Treasure Island": Neighborhood(37.8235, -122.3706, 900, ()),
}

EARTH_RADIUS_M = 6_371_000


def _normalize(name: str) -> str:
    """casefold; & -> and; non-alphanumerics -> space; a leading "the " and a trailing
    district / neighborhood / neighbourhood / area dropped."""
    text = str(name or "").casefold().replace("&", " and ")
    text = " ".join(re.sub(r"[^0-9a-z]+", " ", text).split())
    text = re.sub(r"^the ", "", text)
    return re.sub(r" (district|neighborhood|neighbourhood|area)$", "", text)


_LOOKUP: Dict[str, str] = {}
for _display, _hood in NEIGHBORHOODS.items():
    for _alias in (_display,) + _hood.aliases:
        _LOOKUP.setdefault(_normalize(_alias), _display)


def resolve_area(name: str) -> Optional[Tuple[float, float, float]]:
    """(lat, lng, radius_m) of a neighbourhood or alias, or None (blank or unknown)."""
    display = _LOOKUP.get(_normalize(name))
    if not display:
        return None
    hood = NEIGHBORHOODS[display]
    return (hood.lat, hood.lng, hood.radius_m)


def haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in metres."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def area_name(lat: float, lng: float) -> Optional[str]:
    """The neighbourhood whose circle holds the point, the closest relative to its
    radius when circles overlap; None outside them all."""
    best, best_ratio = None, None
    for display, hood in NEIGHBORHOODS.items():
        ratio = haversine_m(lat, lng, hood.lat, hood.lng) / hood.radius_m
        if ratio <= 1 and (best_ratio is None or ratio < best_ratio):
            best, best_ratio = display, ratio
    return best
