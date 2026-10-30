"""End-to-end test of the editor in a real browser (headless Firefox).

Drives the mouse the way a person would: draws two shapes, generates terrain,
moves, resizes and rotates a shape, uses sliders, inserts points, locks,
renames, hides, zooms, exports a PNG and deletes a shape.

Needs Firefox, geckodriver and Selenium (`pip install selenium`). Build the
app first (`npm run build`), then from web/:  python3 tests/ui-test.py
Set FIREFOX and GECKODRIVER if they aren't on your PATH.
"""
import time, os, glob, shutil, tempfile
from pathlib import Path
from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.action_chains import ActionChains
from selenium.webdriver.common.actions.action_builder import ActionBuilder
from selenium.webdriver.common.actions.pointer_input import PointerInput
from selenium.webdriver.common.actions import interaction
from selenium.webdriver.common.by import By
from selenium.webdriver.common.keys import Keys

opts = Options()
opts.binary_location = os.environ.get("FIREFOX") or shutil.which("firefox") or "firefox"
DOWNLOADS = tempfile.mkdtemp()
SHOTS = Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)
PAGE = (Path(__file__).resolve().parent.parent.parent / "dist" / "index.html").as_uri()
opts.add_argument("-headless")
opts.set_preference("browser.download.folderList", 2)
opts.set_preference("browser.download.dir", DOWNLOADS)
opts.set_preference("browser.helperApps.neverAsk.saveToDisk", "image/png")
opts.set_preference("browser.download.useDownloadDir", True)
d = webdriver.Firefox(options=opts, service=Service(os.environ.get("GECKODRIVER") or shutil.which("geckodriver") or "geckodriver"))
d.set_window_size(1440, 960)
d.get(PAGE)
d.execute_script("window.__errors=[];window.addEventListener('error',e=>__errors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));")
time.sleep(1.5)

results = []
def check(name, ok, info=""):
    results.append((name, bool(ok), info)); print(("PASS " if ok else "FAIL ") + name + (f"  ({info})" if info else ""))
def shot(name): d.save_screenshot(str(SHOTS / f"{name}.png"))
def text(id): return d.find_element(By.ID, id).text
def hidden(id): return d.execute_script(f"return document.getElementById('{id}').hidden")

overlay = d.find_element(By.ID, "overlay")
def view():
    r = d.execute_script("const s=document.getElementById('stage').getBoundingClientRect();return [s.left,s.top,s.width,s.height]")
    return r
def km_to_offset(x, y, zoom=1):
    # Offsets relative to the overlay's centre (Selenium moves relative to element centre).
    _, _, w, h = view()
    size = (min(w, h) - 48) * zoom
    left = w/2 - size/2; top = h/2 - size/2
    return (left + x/1600*size - w/2, top + y/1600*size - h/2)

def mouse():
    return ActionChains(d, duration=20)
def click_km(x, y, button="left"):
    ox, oy = km_to_offset(x, y)
    a = mouse().move_to_element_with_offset(overlay, ox, oy)
    (a.context_click() if button == "right" else a.click()).perform()
    time.sleep(0.12)
def drag_km(x0, y0, x1, y1, steps=8, hold=None):
    ox, oy = km_to_offset(x0, y0); tx, ty = km_to_offset(x1, y1)
    a = mouse().move_to_element_with_offset(overlay, ox, oy)
    if hold: a.key_down(hold)
    a.click_and_hold()
    for i in range(1, steps + 1):
        a.move_to_element_with_offset(overlay, ox + (tx-ox)*i/steps, oy + (ty-oy)*i/steps)
    a.release()
    if hold: a.key_up(hold)
    a.perform(); time.sleep(0.2)
def wait_frames(t=2.5): time.sleep(t)

check("page loads without an error banner", hidden("problem"))
check("starts in drawing mode", "first point" in text("guidance"), text("guidance"))

A = [(250,300),(650,250),(760,560),(520,780),(220,640)]
for p in A: click_km(*p)
click_km(*A[0])
check("first shape closes", "Landmass 1" in text("shape-list"), text("shape-list").replace("\n"," | "))
gen = d.find_element(By.ID, "generate")
check("generate enabled after closing", gen.is_enabled())
gen.click(); wait_frames(3)
t = text("timing")
check("terrain generates", "Last update took" in t, t + " / " + text("timing-detail"))
check("engine runs on the background thread", "background thread" in text("timing-detail"), text("timing-detail"))
shot("01-first-shape")

d.find_element(By.ID, "new-shape").click(); time.sleep(0.2)
B = [(1000,850),(1350,820),(1420,1150),(1150,1350),(950,1120)]
for p in B[:3]: click_km(*p)
g3 = text("guidance")
click_km(1200, 1000, "right")
g2 = text("guidance")
check("right-click removes the last point while drawing", "Click the first point" in g3 and "Keep clicking" in g2, f"{g3[:30]}... -> {g2[:30]}...")
click_km(*B[2])
for p in B[3:]: click_km(*p)
click_km(*B[0]); wait_frames()
rows = d.find_elements(By.CSS_SELECTOR, ".shape-row")
check("two shapes listed", len(rows) == 2, " | ".join(r.text.replace("\n"," ") for r in rows))
check("new shape generates without pressing Generate again", "Last update took" in text("timing"))
check("closing selects the new shape (shape panel shown)", not hidden("shape-panel"))
shot("02-two-shapes")

# Move shape B by dragging inside its box.
before = d.execute_script("return document.getElementById('map').toDataURL().length")
drag_km(1180, 1080, 1080, 980); wait_frames()
pts_label = d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-kind")[1].text
after = d.execute_script("return document.getElementById('map').toDataURL().length")
check("dragging inside the selected shape moves it (map changed)", before != after)
shot("03-moved")

# Resize from bottom-right corner (box padding is a few px; aim at the handle).
def corner_px(shape_pts, dx, dy):
    xs=[p[0] for p in shape_pts]; ys=[p[1] for p in shape_pts]
    return max(xs)+dx, max(ys)+dy
moved_B=[(x-100,y-100) for x,y in B]
cx, cy = corner_px(moved_B, 0, 0)
_,_,w,h=view(); pad_km = 6*1600/(min(w,h)-48)
drag_km(cx+pad_km, cy+pad_km, cx+pad_km+120, cy+pad_km+60); wait_frames()
check("still two shapes after resize", len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) == 2)
shot("04-resized")

# Rotate with the round handle above the box.
xs=[p[0] for p in moved_B]; ys=[p[1] for p in moved_B]
# Approximate box after resize (anchor top-left): width grows ~ (120/(max-min))
x0, y0 = min(xs)-pad_km, min(ys)-pad_km
x1 = max(xs)+pad_km+120; topmid = ((x0+x1)/2, y0)
rot_km = 26*1600/(min(w,h)-48)
drag_km(topmid[0], topmid[1]-rot_km, topmid[0]+250, topmid[1]+60, steps=10); wait_frames()
shot("05-rotated")

# Select a segment of shape A and use a slider.
mid = ((A[0][0]+A[1][0])/2, (A[0][1]+A[1][1])/2)
click_km(*mid)
check("clicking a segment shows its sliders", not hidden("segment-panel"), text("segment-title"))
slider = d.find_element(By.ID, "coves")
d.execute_script("arguments[0].value=100;arguments[0].dispatchEvent(new Event('input'))", slider); wait_frames(1.5)
check("slider edit updates terrain", "Last update took" in text("timing"), text("timing") + " / " + text("timing-detail"))
shot("06-segment-slider")

# Double-click the segment to insert a point.
before_pts = d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-kind")[0].text
ox, oy = km_to_offset(*mid)
mouse().move_to_element_with_offset(overlay, ox, oy).double_click().perform(); time.sleep(0.4)
after_pts = d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-kind")[0].text
check("double-click inserts a point", before_pts != after_pts, f"{before_pts} -> {after_pts}")

# Lock shape A, then clicking its fill must not select it.
lock_btn = d.find_elements(By.CSS_SELECTOR, ".shape-row")[0].find_elements(By.CSS_SELECTOR, ".icon-btn")[1]
lock_btn.click(); time.sleep(0.2)
click_km(900, 900)  # empty sea, deselect
click_km(480, 500)  # inside shape A
check("locked shape can't be selected on the map", hidden("shape-panel") and hidden("segment-panel"))
lock_btn = d.find_elements(By.CSS_SELECTOR, ".shape-row")[0].find_elements(By.CSS_SELECTOR, ".icon-btn")[1]
lock_btn.click(); time.sleep(0.2)
click_km(480, 500)
check("unlocked shape selects by clicking its fill", not hidden("shape-panel"))

# Rename.
name = d.find_element(By.ID, "shape-name"); name.clear(); name.send_keys("Avalon", Keys.ENTER); time.sleep(0.2)
check("renaming updates the list", "Avalon" in text("shape-list"))

# Hide shape B: terrain changes.
before = d.execute_script("return document.getElementById('map').toDataURL().length")
d.find_elements(By.CSS_SELECTOR, ".shape-row")[1].find_elements(By.CSS_SELECTOR, ".icon-btn")[0].click(); wait_frames()
after = d.execute_script("return document.getElementById('map').toDataURL().length")
check("hiding a shape removes it from the terrain", before != after)
shot("07-hidden")
d.find_elements(By.CSS_SELECTOR, ".shape-row")[1].find_elements(By.CSS_SELECTOR, ".icon-btn")[0].click(); wait_frames()

# Zoom in with the wheel and check the detail view sharpens.
ox, oy = km_to_offset(650, 250)
ActionChains(d).scroll_from_origin(__import__('selenium.webdriver.common.actions.wheel_input', fromlist=['ScrollOrigin']).ScrollOrigin.from_element(overlay, int(ox), int(oy)), 0, -600).perform()
time.sleep(4)
check("wheel zooms in", text("zoom-level") != "1.0×", text("zoom-level"))
check("zoomed detail finishes sharpening", d.execute_script("return document.getElementById('detail-badge').hidden"))
shot("08-zoomed")
d.find_element(By.ID, "zoom-fit").click(); time.sleep(0.5)

# Export PNG.
d.find_element(By.ID, "export").click(); time.sleep(3)
files = glob.glob(os.path.join(DOWNLOADS, "*.png"))
check("Export PNG downloads a file", len(files) == 1, ", ".join(os.path.basename(f) + f" {os.path.getsize(f)//1024} KB" for f in files))

# Delete shape B with the two-step confirmation.
d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-pick")[1].click(); time.sleep(0.2)
btn = d.find_element(By.ID, "delete-shape"); btn.click(); time.sleep(0.2)
check("delete asks for confirmation", "again" in btn.text and len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) == 2, btn.text)
btn.click(); wait_frames()
check("second click deletes the shape", len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) == 1)
shot("09-deleted")

errs = d.execute_script("return window.__errors")
check("no JavaScript errors", not errs, "; ".join(errs))
d.quit()
passed = sum(r[1] for r in results)
print(f"\n{passed}/{len(results)} checks passed. Screenshots in {SHOTS}")
raise SystemExit(0 if passed == len(results) else 1)
