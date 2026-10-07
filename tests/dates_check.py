"""Capture-time rules: filename stamp > EXIF > video tags > modified (never the upload time when something better exists)."""
import pathlib, sys, tempfile
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))
from PIL import Image
from engine import media, cutter

t = lambda *a: media._wall(*a)
assert media.capture_time("20260221_160833.jpg", {}, 5) == t(2026, 2, 21, 16, 8, 33)
assert media.capture_time("PXL_20251022_161544947.jpg", {}, 5) == t(2025, 10, 22, 16, 15, 44)
assert media.capture_time("dji_fly_20260330_114652_00_x.mp4", {}, 5) == t(2026, 3, 30, 11, 46, 52)
assert media.capture_time("IMG-20260105-WA0007.jpg", {}, 5) == t(2026, 1, 5)
assert media.capture_time("holiday.jpg", {"exif": 123.0}, 5) == 123.0              # no stamp in the name -> EXIF
assert media.capture_time("clip.mp4", {"qt": 77.0, "created": 99999999}, 5) == 77.0  # QuickTime local date beats UTC creation_time
assert media.capture_time("clip.mp4", {"created": 0.0}, 5) == 5                      # bogus 1970 creation_time -> fall back
d = pathlib.Path(tempfile.mkdtemp()); f = d / "x.jpg"
im = Image.new("RGB", (40, 30)); ex = im.getexif(); ex.get_ifd(0x8769)[36867] = "2026:02:21 16:08:33"
ex_ifd = ex.get_ifd(0x8769); ex_ifd[36867] = "2026:02:21 16:08:33"; im.save(f, exif=ex)
assert media._exif_wall(str(f)) == t(2026, 2, 21, 16, 8, 33), media._exif_wall(str(f))
# ordering: photos and videos interleave by capture time, not by upload time
items = [{"id": "a", "taken": t(2026, 3, 1), "modified": 1e9, "name": "a"}, {"id": "b", "taken": t(2026, 1, 1), "modified": 9e9, "name": "b"},
         {"id": "c", "taken": t(2026, 2, 1), "modified": 5e9, "name": "c"}]
for m in items: m["status"] = "ready"
assert [m["id"] for m in cutter.order_items(items, "chrono", 1)] == ["b", "c", "a"]
print("dates ok")
