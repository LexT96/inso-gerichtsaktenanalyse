"""Test partner sidebar rendering from kanzlei.json."""
from scripts.briefkopf_lib.sidebar_render import build_sidebar_lines


def test_renders_kanzlei_header():
    data = {
        "kanzlei": {
            "website": "www.example.de",
            "partnerschaftsregister": "Amtsgericht X – PR 1",
        },
        "partner": [
            {"kategorie": "PARTNER", "name": "Anna Beispiel",
             "titel": "Fachanwältin\nNotarin"},
        ],
        "standorte": {"Trier": {"adresse": "Kornmarkt 4"}},
    }
    lines = build_sidebar_lines(data)
    texts = [t for _, t in lines]
    assert "www.example.de" in texts
    assert "Amtsgericht X – PR 1" in texts
    assert "PARTNER" in texts
    assert "Anna Beispiel" in texts
    assert "Fachanwältin" in texts
    assert "Notarin" in texts
    # Standorte appear with tab joining
    assert any("Trier" in t for t in texts)


def test_groups_partners_by_category_in_fixed_order():
    data = {
        "kanzlei": {"website": "x", "partnerschaftsregister": "y"},
        "partner": [
            {"kategorie": "OF COUNSEL", "name": "X", "titel": ""},
            {"kategorie": "PARTNER", "name": "A", "titel": ""},
            {"kategorie": "ANGESTELLTE RECHTSANWÄLTE", "name": "B", "titel": ""},
        ],
        "standorte": {},
    }
    lines = build_sidebar_lines(data)
    headers = [t for r, t in lines if r == "header"]
    # PARTNER comes before ANGESTELLTE comes before OF COUNSEL
    assert headers.index("PARTNER") < headers.index("ANGESTELLTE RECHTSANWÄLTE") < headers.index("OF COUNSEL")
