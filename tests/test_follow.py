"""Run with: python3 tests/test_follow.py  (no extras needed)"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
from follow import Follower  # noqa: E402

TRACKS = [{"number": f"A{i + 1}", "length": n} for i, n in enumerate(["4:00", "3:00", "5:00", "3:30"])]
S = 1000.0


def run(segments, end, follower=None):
    """segments: (start, end, level). Sampled 10 times a second, like the real thing."""
    f = follower or Follower(TRACKS, S)
    t = S
    while t < end:
        level = next((lv for a, b, lv in segments if a <= t < b), 0.0005)
        f.feed(level, t)
        f.tick(t)
        t += 0.1
    return f


def test_gaps_keep_it_in_step():
    segs = [(S + 8, S + 246, 0.3), (S + 248.5, S + 426.5, 0.3), (S + 429, S + 727, 0.3), (S + 729.5, S + 930, 0.3)]
    assert run(segs, S + 800).number == "A4"


def test_quiet_passage_is_not_a_gap():
    segs = [(S + 8, S + 108, 0.3), (S + 109.5, S + 246, 0.3)]
    assert run(segs, S + 200).number == "A1"


def test_no_gaps_falls_back_to_timing():
    assert run([(S + 8, S + 900, 0.3)], S + 800).number == "A4"


def test_missed_gap_is_caught_up():
    segs = [(S + 8, S + 246, 0.3), (S + 248.5, S + 730, 0.3)]
    assert run(segs, S + 700).number == "A3"


def test_tap_corrects_it():
    f = Follower(TRACKS, S)
    assert f.sync("A3", S + 50) and f.number == "A3"
    assert not f.sync("Z9", S + 50)


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
