"""End-to-end test of the editor in a real browser (headless Firefox).

Drives the mouse the way a person would: draws two shapes, generates terrain,
moves, resizes and rotates a shape, uses sliders, inserts points, locks,
renames, hides, zooms, exports a PNG and deletes a shape.

Needs Firefox and Selenium 4.6 or later (`pip install selenium`). Selenium
downloads the matching geckodriver by itself. Build the app first
(`npm run build`), then from web/:  python3 tests/ui-test.py
Set FIREFOX or GECKODRIVER only if Selenium can't find them.
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
if os.environ.get("FIREFOX"):
    opts.binary_location = os.environ["FIREFOX"]
DOWNLOADS = tempfile.mkdtemp()
SHOTS = Path(__file__).parent / "screenshots"
SHOTS.mkdir(exist_ok=True)
PAGE = (Path(__file__).resolve().parent.parent.parent / "dist" / "index.html").as_uri()
opts.add_argument("-headless")
opts.set_preference("browser.download.folderList", 2)
opts.set_preference("browser.download.dir", DOWNLOADS)
opts.set_preference("browser.helperApps.neverAsk.saveToDisk", "image/png")
opts.set_preference("dom.dialog_element.enabled", True)
opts.set_preference("browser.download.useDownloadDir", True)
d = webdriver.Firefox(options=opts, service=Service(os.environ.get("GECKODRIVER") or shutil.which("geckodriver")))
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
slider = d.find_element(By.ID, "segment-coves")
d.execute_script("arguments[0].value=100;arguments[0].dispatchEvent(new Event('input'))", slider); wait_frames(1.5)
check("slider edit updates terrain", "Last update took" in text("timing"), text("timing") + " / " + text("timing-detail"))
shot("06-segment-slider")

# Double-click the segment to insert a point.
before_pts = d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-kind")[0].text
ox, oy = km_to_offset(*mid)
mouse().move_to_element_with_offset(overlay, ox, oy).double_click().perform(); time.sleep(0.4)
after_pts = d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-kind")[0].text
check("double-click inserts a point", before_pts != after_pts, f"{before_pts} -> {after_pts}")

# Coast reach slider updates terrain (select a segment first: the insertion
# above left a point selected).
click_km((A[1][0]+A[2][0])/2, (A[1][1]+A[2][1])/2)
before = d.execute_script("return document.getElementById('map').toDataURL().length")
reach = d.find_element(By.ID, "segment-reach")
d.execute_script("arguments[0].value=60;arguments[0].dispatchEvent(new Event('input'))", reach); wait_frames(1.5)
after = d.execute_script("return document.getElementById('map').toDataURL().length")
check("Reach outside slider changes the coastline", before != after, text("segment-reach-value"))
before = after
inside = d.find_element(By.ID, "segment-inside")
d.execute_script("arguments[0].value=50;arguments[0].dispatchEvent(new Event('input'))", inside); wait_frames(1.5)
after = d.execute_script("return document.getElementById('map').toDataURL().length")
check("Reach inside slider changes the coastline", before != after, text("segment-inside-value"))

# Shape values add to segment adjustments: shape +x, segment +y, shape +x again.
def set_slider(el_id, v):
    d.execute_script("const e=document.getElementById(arguments[0]);e.value=arguments[1];e.dispatchEvent(new Event('input'))", el_id, v)
    time.sleep(0.3)
def value(el_id): return int(float(d.execute_script("return document.getElementById(arguments[0]).value", el_id)))
seg_mid = ((A[2][0]+A[3][0])/2, (A[2][1]+A[3][1])/2)
click_km(*seg_mid)                                   # a segment of shape A
seg_before = value("segment-roughness")
click_km(330, 500)                                   # select shape A (inside, away from lines)
shape_before = value("shape-roughness")
set_slider("shape-roughness", shape_before - 10)     # shape: -10
click_km(*seg_mid); set_slider("segment-roughness", value("segment-roughness") + 25)   # segment: +25
click_km(330, 500); set_slider("shape-roughness", shape_before - 10 + 5)              # shape: +5
click_km(*seg_mid)
seg_after = value("segment-roughness")
check("segment value = segment change + shape changes", seg_after == seg_before - 10 + 25 + 5, f"{seg_before} -> {seg_after}, expected {seg_before - 10 + 25 + 5}")
check("adjusted segment shows its difference", "from shape" in text("segment-roughness-value"), text("segment-roughness-value"))
d.find_element(By.ID, "reset-segment").click(); time.sleep(0.3)
check("reset returns the segment to the shape value", value("segment-roughness") == shape_before - 5, f"{value('segment-roughness')} vs {shape_before - 5}")
wait_frames(1)
before = after
sm = d.find_element(By.ID, "smoothing")
d.execute_script("arguments[0].value=0;arguments[0].dispatchEvent(new Event('input'))", sm); wait_frames(1.5)
after = d.execute_script("return document.getElementById('map').toDataURL().length")
check("Edge smoothing slider recolours the map", before != after and text("smoothing-value") == "Off", text("smoothing-value"))
d.execute_script("arguments[0].value=1;arguments[0].dispatchEvent(new Event('input'))", sm); wait_frames(1.5)

# Ctrl+Click selects several segments; a slider moves them all by the same amount.
def ctrl_click_km(x, y):
    ox, oy = km_to_offset(x, y)
    mouse().move_to_element_with_offset(overlay, ox, oy).key_down(Keys.CONTROL).click().key_up(Keys.CONTROL).perform()
    time.sleep(0.2)
segs = [((A[2][0]+A[3][0])/2, (A[2][1]+A[3][1])/2), ((A[3][0]+A[4][0])/2, (A[3][1]+A[4][1])/2), ((A[4][0]+A[0][0])/2, (A[4][1]+A[0][1])/2)]
click_km(*segs[1])                     # give the middle segment its own value first
set_slider("segment-roughness", value("segment-roughness") + 20)
d.execute_script("document.getElementById('segment-roughness').dispatchEvent(new Event('change', {bubbles: true}))")
click_km(*segs[0])
r0 = value("segment-roughness")
ctrl_click_km(*segs[1]); r1 = value("segment-roughness")
ctrl_click_km(*segs[2]); r2 = value("segment-roughness")
check("Ctrl+Click selects several segments", text("segment-title") == "3 segments selected", text("segment-title"))
set_slider("segment-roughness", r2 + 10); d.execute_script("document.getElementById('segment-roughness').dispatchEvent(new Event('change', {bubbles: true}))")
wait_frames(1)
after = []
for p in segs:
    click_km(*p); after.append(value("segment-roughness"))
check("a slider moves every selected segment by the same amount, keeping differences", r1 != r0 and after == [r0 + 10, r1 + 10, r2 + 10], f"{[r0, r1, r2]} -> {after}")
click_km(*segs[0]); ctrl_click_km(*segs[1]); ctrl_click_km(*segs[1])
check("Ctrl+Click again removes a segment", text("segment-title").startswith("Segment "), text("segment-title"))
shot("06a-multi-select")

# Draw a lake inside shape A and switch it to water.
d.find_element(By.ID, "new-shape").click(); time.sleep(0.2)
LAKE = [(420,430),(560,420),(590,540),(450,580)]
for p in LAKE: click_km(*p)
click_km(*LAKE[0]); wait_frames()
d.find_element(By.ID, "kind-water").click(); wait_frames()
rows_text = text("shape-list")
check("a shape can be switched to water", "Lake 3" in rows_text and "Water" in rows_text, rows_text.replace("\n", " | "))
px = d.execute_script("""
  const c=document.getElementById('map'), r=c.getBoundingClientRect();
  // Sample the displayed map at the lake's centre (km 505, 495).
  const s=(Math.min(r.width,r.height)-48), left=r.width/2-s/2, top=r.height/2-s/2;
  const x=left+505/1600*s, y=top+495/1600*s, dpr=window.devicePixelRatio||1;
  const p=c.getContext('2d').getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data;
  return [p[0],p[1],p[2]];""")
check("the inside of the lake is water", px[2] > px[0] + 30, f"pixel {px}")
shot("06b-lake")

# Land drawn on land steps up to its own height: the map turns from lowland
# green towards upland brown there.
def map_pixel(x_km, y_km):
    return d.execute_script("""
      const c=document.getElementById('map'), r=c.getBoundingClientRect();
      const s=(Math.min(r.width,r.height)-48), left=r.width/2-s/2, top=r.height/2-s/2;
      const x=left+arguments[0]/1600*s, y=top+arguments[1]/1600*s, dpr=window.devicePixelRatio||1;
      const p=c.getContext('2d').getImageData(Math.round(x*dpr),Math.round(y*dpr),1,1).data;
      return [p[0],p[1],p[2]];""", x_km, y_km)
low = map_pixel(330, 375)
d.find_element(By.ID, "new-shape").click(); time.sleep(0.2)
HIGH = [(270,330),(400,320),(390,420),(280,430)]
for p in HIGH: click_km(*p)
click_km(*HIGH[0]); wait_frames()
check("land has a height slider and no separate highland kind", not hidden("height-field") and not d.find_elements(By.ID, "kind-highland"), text("height-value"))
set_slider("height", 2500); wait_frames()
high = map_pixel(330, 375)
check("land on land steps up to its own height", high != low and high[0] - high[1] > low[0] - low[1], f"{low} -> {high}")
check("the slope slider covers coasts and escarpments", "Slope" in d.find_element(By.ID, "shape-sliders").text)
shot("06c-escarpment")

# Mountains: a range from two points, finished with Enter.
before = map_pixel(600, 700)
d.find_element(By.ID, "tool-mountain").click(); time.sleep(0.2)
click_km(560, 690); click_km(660, 720)
overlay.send_keys(Keys.ENTER) if False else ActionChains(d).send_keys(Keys.ENTER).perform()
wait_frames()
check("a mountain range can be drawn", "Range 1" in text("shape-list") and not hidden("feature-panel"), text("feature-title"))
check("mountains raise the ground", map_pixel(610, 705) != before, f"{before} -> {map_pixel(610, 705)}")

# Rivers: three points downstream to the coast.
d.find_element(By.ID, "tool-river").click(); time.sleep(0.2)
click_km(450, 650); click_km(380, 700); click_km(200, 720)
ActionChains(d).send_keys(Keys.ENTER).perform(); wait_frames()
check("a river can be drawn", "River 1" in text("shape-list"), text("feature-title"))
px = map_pixel(400, 686)
check("the river shows as water", px[2] > px[0] + 20, f"pixel {px}")
# Curves: a river drawn through three points forms a "<"; Curviness turns it into a "(".
d.find_element(By.ID, "tool-river").click(); time.sleep(0.2)
click_km(1250, 700); click_km(1120, 820); click_km(1250, 940)
ActionChains(d).send_keys(Keys.ENTER).perform(); wait_frames()
check("a river has a Curviness slider", not hidden("feature-panel") and not hidden("f-curve-field"), text("f-curve-value"))
set_slider("f-curve", 0); wait_frames(1.5)
straight = d.execute_script("return document.getElementById('overlay').toDataURL().length")
set_slider("f-curve", 100); wait_frames(1.5)
curved = d.execute_script("return document.getElementById('overlay').toDataURL().length")
check("Curviness redraws the river as a curve", straight != curved and text("f-curve-value") == "100%", f"{text('f-curve-value')}")
# Drag the bend handle of the first segment sideways: the segment bows.
ox, oy = km_to_offset(1185, 760)
before = d.execute_script("return document.getElementById('overlay').toDataURL().length")
mouse().move_to_element_with_offset(overlay, ox, oy).click_and_hold().move_by_offset(-30, 10).move_by_offset(-10, 4).release().perform(); wait_frames(1.5)
after = d.execute_script("return document.getElementById('overlay').toDataURL().length")
check("dragging a bend handle bows a segment", before != after and not d.find_element(By.ID, "f-reset-bends").get_property("disabled"))
d.find_element(By.ID, "f-reset-bends").click(); wait_frames(1)
check("Straighten bows clears them", d.find_element(By.ID, "f-reset-bends").get_property("disabled"))
shot("06d-mountains-rivers")
d.find_element(By.ID, "tool-coast").click(); time.sleep(0.2)

# A new variation changes the noise but keeps the design.
before = d.execute_script("return document.getElementById('map').toDataURL().length")
d.find_element(By.ID, "generate").click(); wait_frames(3)
after = d.execute_script("return document.getElementById('map').toDataURL().length")
check("New variation regenerates with different noise", before != after and len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) >= 5, d.find_element(By.ID, "generate").text)

# Lock shape A, then clicking its fill must not select it.
lock_btn = d.find_elements(By.CSS_SELECTOR, ".shape-row")[0].find_elements(By.CSS_SELECTOR, ".icon-btn")[1]
lock_btn.click(); time.sleep(0.2)
click_km(900, 900)  # empty sea, deselect
click_km(300, 560)  # inside shape A, clear of the lake, upland, range and river
check("locked shape can't be selected on the map", hidden("shape-panel") and hidden("segment-panel"))
lock_btn = d.find_elements(By.CSS_SELECTOR, ".shape-row")[0].find_elements(By.CSS_SELECTOR, ".icon-btn")[1]
lock_btn.click(); time.sleep(0.2)
click_km(300, 560)
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

# Export PNG: quick, then full detail.
def export(mode, size=None):
    d.find_element(By.ID, "export").click(); time.sleep(0.3)
    check(f"export dialog opens ({mode})", d.execute_script("return document.getElementById('export-dialog').open"))
    d.find_element(By.CSS_SELECTOR, f'input[name="export-mode"][value="{mode}"]').click(); time.sleep(0.2)
    if size:
        from selenium.webdriver.support.ui import Select
        Select(d.find_element(By.ID, "full-size")).select_by_value(str(size))
    d.find_element(By.ID, "export-go").click()
export("quick"); time.sleep(3)
files = glob.glob(os.path.join(DOWNLOADS, "*.png"))
check("quick export downloads the working-resolution image", any("1024px" in f for f in files), ", ".join(os.path.basename(f) for f in files))
t0 = time.time()
export("full", 4096)
for _ in range(240):
    time.sleep(0.5)
    if glob.glob(os.path.join(DOWNLOADS, "*4096px.png")) and not glob.glob(os.path.join(DOWNLOADS, "*.part")): break
big = glob.glob(os.path.join(DOWNLOADS, "*4096px.png"))
info = ""
if big:
    time.sleep(1)
    try:
        from PIL import Image
        with Image.open(big[0]) as im:
            im.load(); info = f"{im.size[0]}x{im.size[1]} {im.mode}, {os.path.getsize(big[0])//1024//1024} MB, {time.time()-t0:.0f} s"
            ok = im.size == (4096, 4096)
            im.reduce(4).save(str(SHOTS / "full-export-preview.png"))
    except Exception as e:
        ok = False; info = f"couldn't open: {e}"
else:
    ok = False
check("full-detail export writes a valid 4096 PNG", ok, info or text("export-status"))
check("export status reports the size", "MB" in text("export-status"), text("export-status"))

# Reference image: import, adjust, lock; clicks then pass through it.
from PIL import Image as PILImage, ImageDraw
ref_path = os.path.join(DOWNLOADS, "sketch.png")
im = PILImage.new("RGB", (600, 400), "white"); dr = ImageDraw.Draw(im)
dr.polygon([(80, 60), (420, 40), (520, 300), (120, 340)], outline="black", width=6); im.save(ref_path)
d.execute_script("document.getElementById('import-file').hidden=false")
d.find_element(By.ID, "import-file").send_keys(ref_path); time.sleep(1)
d.execute_script("document.getElementById('import-file').hidden=true")
check("importing an image adds a reference layer", "Reference image" in text("shape-list") and not hidden("reference-panel"), text("reference-name"))
set_slider("reference-opacity", 80)
check("reference opacity can be changed", text("reference-opacity-value") == "80%", text("reference-opacity-value"))
before = d.execute_script("return document.getElementById('overlay').toDataURL().length")
drag_km(800, 800, 900, 850); time.sleep(0.3)
after = d.execute_script("return document.getElementById('overlay').toDataURL().length")
check("a selected reference image can be dragged", before != after)
rows = d.find_elements(By.CSS_SELECTOR, ".shape-row")
rows[-1].find_elements(By.CSS_SELECTOR, ".icon-btn")[1].click(); time.sleep(0.3)
check("reference image can be locked", "Locked" in text("reference-help"), text("reference-help"))
click_km(300, 560)
check("clicks pass through a locked reference to the shapes", not hidden("shape-panel"))
shot("09a-reference")

# Grid squares.
from selenium.webdriver.support.ui import Select
Select(d.find_element(By.ID, "grid")).select_by_value("100"); time.sleep(0.3)

# Map width: halve it, scaling shapes with the map, then restore.
def set_width(km, choice):
    w = d.find_element(By.ID, "map-width"); w.clear(); w.send_keys(str(km)); time.sleep(0.2)
    d.find_element(By.ID, "map-width-apply").click(); time.sleep(0.3)
    d.find_element(By.ID, choice).click(); wait_frames(3.5)
set_width(800, "width-scale")
check("map width changes", "800 km across" in text("map-facts"), text("map-facts"))
check("resolution labels follow the map width", "781 m per pixel" in d.find_element(By.ID, "resolution").text, d.find_element(By.ID, "resolution").text.split("\n")[1])
check("shapes survive a map width change", len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) >= 6)
shot("09b-map-800km")
set_width(1600, "width-scale")
check("map width restores", "1,600 km across" in text("map-facts"), text("map-facts"))

# Terrain render: notice first, then the rendered map. (Hide the reference
# picture and deselect, so the screenshot shows the render itself.)
[r for r in d.find_elements(By.CSS_SELECTOR, ".shape-row.reference")][0].find_elements(By.CSS_SELECTOR, ".icon-btn")[0].click(); time.sleep(0.2)
ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.2)
d.find_element(By.ID, "render-terrain").click(); time.sleep(0.4)
check("terrain render explains itself first", d.execute_script("return document.getElementById('terrain-dialog').open"))
d.find_element(By.ID, "terrain-skip").click()
d.find_element(By.ID, "terrain-go").click()
for _ in range(80):
    time.sleep(0.5)
    if "Terrain rendered" in text("export-status"): break
check("terrain renders with rivers", "Terrain rendered" in text("export-status") and "rivers" in text("export-status"), text("export-status"))
check("the terrain render offers to save its image", not hidden("save-terrain"))
from selenium.webdriver.support.ui import Select as _Select
_Select(d.find_element(By.ID, "terrain-look")).select_by_value("1"); time.sleep(0.2)
_Select(d.find_element(By.ID, "terrain-detail")).select_by_value("map-2048"); time.sleep(0.2)
d.find_element(By.ID, "render-terrain").click()
t_hq = time.time()
for _ in range(300):
    time.sleep(0.5)
    if "rendered in detail" in text("export-status") or "failed" in text("export-status"): break
check("a whole-map detail render completes at 2048 px", "rendered in detail" in text("export-status") and "2048 × 2048" in text("export-status"), f"{text('export-status')[:140]} ({time.time()-t_hq:.0f} s)")
tl = d.execute_script("""const c=document.getElementById('map'); const g=c.getContext('2d'); const w=c.width,h=c.height; const px=g.getImageData(Math.floor(w*0.5),Math.floor(h*0.5),1,1).data; return [px[0],px[1],px[2]];""")
check("the detail render is drawn on the map", sum(tl) > 60, f"centre pixel {tl}")
shot("09c2-terrain-detail")
d.find_element(By.ID, "zoom-in").click(); d.find_element(By.ID, "zoom-in").click(); d.find_element(By.ID, "zoom-in").click(); time.sleep(1.2)
check("a detail render can be zoomed", text("zoom-level") != "1.0×", text("zoom-level"))
shot("09c3-terrain-zoomed")
d.find_element(By.ID, "zoom-fit").click(); time.sleep(0.5)
d.find_element(By.ID, "save-terrain").click(); time.sleep(6)
saved_png = glob.glob(os.path.join(DOWNLOADS, "terrain-2048x2048.png"))
check("the detail render saves as a 2048 px PNG", len(saved_png) == 1, ", ".join(os.path.basename(f) for f in glob.glob(os.path.join(DOWNLOADS, "terrain-*.png"))))
# "This view only": zoom in and render just what is on screen, much finer.
d.find_element(By.ID, "zoom-in").click(); d.find_element(By.ID, "zoom-in").click(); time.sleep(0.8)
_Select(d.find_element(By.ID, "terrain-detail")).select_by_value("view-2048"); time.sleep(0.2)
d.find_element(By.ID, "render-terrain").click()
t_view = time.time()
for _ in range(300):
    time.sleep(0.5)
    if "rendered in detail" in text("export-status") or "failed" in text("export-status"): break
import re as _re
m = _re.search(r"(\d+) m per pixel", text("export-status"))
check("a view-only detail render is much finer than the whole map", bool(m) and int(m.group(1)) < 300, f"{m.group(0) if m else text('export-status')[:100]} ({time.time()-t_view:.0f} s)")
shot("09c4-terrain-view")
d.find_element(By.ID, "zoom-fit").click(); time.sleep(0.5)
_Select(d.find_element(By.ID, "terrain-detail")).select_by_value("quick"); time.sleep(0.2)
shot("09c-terrain")
d.find_element(By.ID, "render-terrain").click(); time.sleep(0.5)
check("the notice stays hidden once dismissed", not d.execute_script("return document.getElementById('terrain-dialog').open"))
for _ in range(80):
    time.sleep(0.5)
    if "Terrain rendered" in text("export-status"): break

# Planned features: the render works out rivers, hills and lakes as vectors.
check("the terrain render shows what it planned", not hidden("planned-box") and "rivers" in text("planned-facts"), text("planned-facts"))
o1 = d.execute_script("return document.getElementById('overlay').toDataURL().length")
d.find_element(By.ID, "show-planned").click(); time.sleep(0.3)
o2 = d.execute_script("return document.getElementById('overlay').toDataURL().length")
d.find_element(By.ID, "show-planned").click(); time.sleep(0.3)
check("planned rivers, hills and lakes can be shown or hidden", o1 != o2)
shot("10a-planned")

# Terrain exports at full detail: the colour image and a 16-bit heightmap.
for f in glob.glob(os.path.join(DOWNLOADS, "terrain-*.png")): os.remove(f)
def open_export(mode):
    d.find_element(By.ID, "export").click(); time.sleep(0.3)
    d.find_element(By.CSS_SELECTOR, f'input[name="export-mode"][value="{mode}"]').click(); time.sleep(0.3)
d.find_element(By.ID, "export").click(); time.sleep(0.3)
check("terrain exports are offered once the terrain is rendered", d.execute_script("return !document.querySelector('input[name=\"export-mode\"][value=\"terrain\"]').disabled && !document.querySelector('input[name=\"export-mode\"][value=\"heightmap\"]').disabled"))
d.find_element(By.ID, "export-cancel").click(); time.sleep(0.2)
open_export("terrain")
sizes = d.execute_script("return [...document.getElementById('terrain-size').options].map(o=>o.textContent)")
check("terrain export offers the full-zoom detail size", any("Full zoom" in s for s in sizes), " | ".join(sizes))
_Select(d.find_element(By.ID, "terrain-size")).select_by_value("4096"); time.sleep(0.3)
check("terrain export estimates size and resolution", "4,096 × 4,096" in text("terrain-estimate"), text("terrain-estimate")[:120])
t_ex = time.time()
d.find_element(By.ID, "export-go").click()
for _ in range(600):
    time.sleep(0.5)
    if glob.glob(os.path.join(DOWNLOADS, "terrain-4096x4096.png")) and not glob.glob(os.path.join(DOWNLOADS, "*.part")): break
tex = glob.glob(os.path.join(DOWNLOADS, "terrain-4096x4096.png"))
info, ok = text("export-status"), False
if tex:
    time.sleep(1)
    from PIL import Image, ImageStat
    with Image.open(tex[0]) as im:
        im.load()
        sd = ImageStat.Stat(im.convert("L")).stddev[0]
        ok = im.size == (4096, 4096) and sd > 10
        info = f"{im.size[0]}x{im.size[1]} {im.mode}, contrast {sd:.0f}, {time.time()-t_ex:.0f} s"
        im.crop((1500, 1100, 2300, 1900)).save(str(SHOTS / "10b-terrain-export-crop.png"))
check("the terrain exports as a full-detail 4096 px image", ok, info)
open_export("heightmap")
check("heightmap export explains the Unreal Engine scale", "Z scale" in text("terrain-estimate"), text("terrain-estimate")[-160:])
d.find_element(By.ID, "export-go").click()
for _ in range(300):
    time.sleep(0.5)
    hm = glob.glob(os.path.join(DOWNLOADS, "heightmap-4033x4033-16bit-*.png"))
    if hm and not glob.glob(os.path.join(DOWNLOADS, "*.part")): break
info, ok = text("export-status"), False
if hm:
    time.sleep(1)
    with Image.open(hm[0]) as im:
        im.load()
        lo, hi = im.getextrema()
        ok = im.size == (4033, 4033) and im.mode.startswith("I") and hi - lo > 8000
        info = f"{os.path.basename(hm[0])}: {im.mode}, values {lo}..{hi}"
        prev = im.point(lambda v: v / 256).convert("L").reduce(4)
        prev.save(str(SHOTS / "10c-heightmap-preview.png"))
check("the heightmap is a 16-bit greyscale PNG spanning the terrain's heights", ok, info)

# Biome brush: paint a region, pick a preset, regenerate the terrain.
before_px = map_pixel(640, 500)
d.find_element(By.ID, "tool-biome").click(); time.sleep(0.2)
check("the biome pen explains itself", "biome region" in text("guidance"), text("guidance"))
REGION = [(460, 400), (660, 390), (670, 600), (470, 610)]
for p in REGION: click_km(*p)
click_km(*REGION[0]); time.sleep(0.5)
check("a biome region closes on its first point", "Biomes" in text("shape-list") and not hidden("biome-fields"), text("feature-title"))
check("painting a region returns the map to the live view", hidden("planned-box"))
_Select(d.find_element(By.ID, "b-preset")).select_by_value("hot-desert"); time.sleep(0.4)
check("a preset sets rainfall, humidity, forest and temperature", text("b-rain-value").startswith("80 ") and text("b-humid-value") == "8%" and text("b-forest-value") == "0%" and "27" in text("b-temp-value"), f"{text('b-rain-value')}, {text('b-humid-value')}, {text('b-forest-value')}, {text('b-temp-value')}")
check("the region is named after its preset", "Hot desert" in text("shape-list"), text("shape-list").split("Biomes")[-1].strip().replace("\n", " | "))
set_slider("b-feather", 20)
check("each region's values can be edited", text("b-feather-value") == "20 km", text("b-feather-value"))
d.find_element(By.ID, "b-regen").click()
for _ in range(80):
    time.sleep(0.5)
    if "Terrain rendered" in text("export-status"): break
after_px = map_pixel(640, 500)
check("regenerating the terrain turns the region into desert", "Terrain rendered" in text("export-status") and after_px[0] > before_px[0] + 20 and after_px[0] > after_px[1], f"{before_px} -> {after_px}")
shot("10d-biome-desert")
_Select(d.find_element(By.ID, "b-preset")).select_by_value("rainforest"); time.sleep(0.4)
d.find_element(By.ID, "b-regen").click()
for _ in range(80):
    time.sleep(0.5)
    if "Terrain rendered" in text("export-status"): break
forest_px = map_pixel(640, 500)
check("a rainforest preset turns the same region deep green", forest_px[1] > forest_px[0] + 10 and sum(forest_px) < sum(after_px), f"{forest_px}")
shot("10e-biome-forest")
ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.2)

# Keep the planned features as ordinary guides.
n_before = len(d.find_elements(By.CSS_SELECTOR, ".shape-row"))
d.find_element(By.ID, "keep-planned").click(); wait_frames(3)
n_after = len(d.find_elements(By.CSS_SELECTOR, ".shape-row"))
check("planned features can be kept as editable guides", n_after > n_before + 5 and "(planned)" in text("shape-list"), f"{n_before} -> {n_after} rows; {text('export-status')}")
lake_px = map_pixel(1100, 1150)
check("kept lakes stay in their hollows instead of flooding the land", lake_px[1] > lake_px[2] or lake_px[0] > 80, f"land pixel {lake_px}")
shot("10f-planned-kept")
d.find_element(By.ID, "render-terrain").click()
for _ in range(80):
    time.sleep(0.5)
    if "Terrain rendered" in text("export-status"): break
check("the terrain renders again with the kept guides", "Terrain rendered" in text("export-status"), text("export-status")[:100])
ActionChains(d).send_keys(Keys.ESCAPE).perform(); time.sleep(0.2)

# Project file: save, clear, and open it again.
n_rows = len(d.find_elements(By.CSS_SELECTOR, ".shape-row"))
export("project"); time.sleep(2.5)
saved = glob.glob(os.path.join(DOWNLOADS, "*.wmap.json"))
check("a project file is saved", len(saved) == 1, ", ".join(os.path.basename(f) for f in saved))
clear = d.find_element(By.ID, "clear"); clear.click(); time.sleep(0.2); clear.click(); wait_frames(2)
check("clearing empties the map", len(d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-pick")) <= 1)
if saved:
    d.execute_script("document.getElementById('import-file').hidden=false")
    d.find_element(By.ID, "import-file").send_keys(saved[0]); wait_frames(4)
    d.execute_script("document.getElementById('import-file').hidden=true")
check("opening the project file restores every shape, mountain and river", len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) == n_rows and "Opened" in text("export-status"), f"{len(d.find_elements(By.CSS_SELECTOR, '.shape-row'))} of {n_rows} rows; {text('export-status')}")
shot("09d-reopened")

# Autosave: reload the page and the map comes back.
time.sleep(1.5)
errors_before_reload = d.execute_script("return window.__errors") or []
d.refresh()
d.execute_script("window.__errors=[];window.addEventListener('error',e=>__errors.push(String(e.message)));window.addEventListener('unhandledrejection',e=>__errors.push(String(e.reason)));")
time.sleep(4)
overlay = d.find_element(By.ID, "overlay")
check("the map is restored from autosave after a reload", "Restored" in text("export-status") and len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) >= 5, text("export-status"))

# Delete shape B with the two-step confirmation.
d.find_elements(By.CSS_SELECTOR, ".shape-row .shape-pick")[1].click(); time.sleep(0.2)
btn = d.find_element(By.ID, "delete-shape"); btn.click(); time.sleep(0.2)
n_before = len(d.find_elements(By.CSS_SELECTOR, ".shape-row"))
check("delete asks for confirmation", "again" in btn.text, btn.text)
btn.click(); wait_frames()
check("second click deletes the shape", len(d.find_elements(By.CSS_SELECTOR, ".shape-row")) == n_before - 1)
shot("09-deleted")

errs = errors_before_reload + (d.execute_script("return window.__errors") or [])
check("no JavaScript errors", not errs, "; ".join(errs))
d.quit()
passed = sum(r[1] for r in results)
print(f"\n{passed}/{len(results)} checks passed. Screenshots in {SHOTS}")
raise SystemExit(0 if passed == len(results) else 1)
