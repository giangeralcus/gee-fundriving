"""Test suite desktop (pygame): jalankan dengan `py tests/test_desktop.py`.
Pakai SDL dummy driver — jalan tanpa buka jendela."""
import json
import os
import sys
import tempfile

os.environ["SDL_VIDEODRIVER"] = "dummy"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)          # root repo
sys.path.insert(0, ROOT)
os.chdir(ROOT)

import pygame
import fundriving as fd

LOOP = os.path.join("maps", "loop_city.json")


def key(k):
    pygame.event.post(pygame.event.Event(pygame.KEYDOWN, {"key": k}))


# --- 1. unit: mapping tombol driver_controls ---
keys = (pygame.K_UP, pygame.K_DOWN, pygame.K_LEFT, pygame.K_RIGHT,
        pygame.K_w, pygame.K_a, pygame.K_s, pygame.K_d)
pressed = {k: False for k in keys}
assert fd.driver_controls(pressed) == (0.0, 0.0, 0.0)
p = dict(pressed); p[pygame.K_UP] = True; p[pygame.K_RIGHT] = True
assert fd.driver_controls(p) == (1.0, 1.0, 0.0)
p = dict(pressed); p[pygame.K_s] = True; p[pygame.K_a] = True
assert fd.driver_controls(p) == (-1.0, 0.0, 1.0)
print("PASS: mapping driver_controls")

# --- 2. unit: resolve_map & set_render_fps ---
assert fd.resolve_map("circuit") is None
assert fd.resolve_map("loop") == LOOP
assert fd.resolve_map("osm") in (os.path.join("maps", "puri_cengkareng.json"), LOOP)
fd.set_render_fps(60)
assert (fd.RENDER_FPS, fd.RENDER_EVERY) == (60, 1)
fd.set_render_fps(30)
assert (fd.RENDER_FPS, fd.RENDER_EVERY) == (30, 2)
fd.set_render_fps(999)  # nilai aneh -> fallback 30
assert fd.RENDER_FPS == 30
print("PASS: resolve_map & set_render_fps")

pygame.init()
surf = pygame.display.set_mode((fd.W, fd.H))
clock = pygame.time.Clock()

# --- 3. menu: ENTER -> START pakai setelan default ---
settings = {"mode": "assistant", "map": "loop", "fps": 30}
key(pygame.K_RETURN)
got = fd.main_menu(surf, clock, settings)
assert got == {"mapfile": LOOP, "auto_start": True}, got
print("PASS: menu ENTER -> START (assistant, Loop City)")

# --- 4. menu: DOWN+ENTER buka SETTINGS (fake instan), lalu ESC keluar menu ---
real_settings_screen, real_about_screen = fd.settings_screen, fd.about_screen
opened = {"settings": 0, "about": 0}
fd.settings_screen = lambda s, c, st: opened.__setitem__("settings", opened["settings"] + 1)
fd.about_screen = lambda s, c: opened.__setitem__("about", opened["about"] + 1)
key(pygame.K_DOWN); key(pygame.K_RETURN); key(pygame.K_ESCAPE)
assert fd.main_menu(surf, clock, settings) is None
assert opened["settings"] == 1, opened
key(pygame.K_DOWN); key(pygame.K_DOWN); key(pygame.K_RETURN); key(pygame.K_ESCAPE)
assert fd.main_menu(surf, clock, settings) is None
assert opened["about"] == 1, opened
print("PASS: menu -> SETTINGS/ABOUT terbuka -> EXIT")
fd.settings_screen, fd.about_screen = real_settings_screen, real_about_screen

# --- 5. settings: ubah mode/peta/fps, tersimpan ke file ---
st = {"mode": "assistant", "map": "loop", "fps": 30}
key(pygame.K_RIGHT)             # MODE -> KENDALI SENDIRI
key(pygame.K_DOWN); key(pygame.K_RIGHT)   # PETA -> SIRKUIT
key(pygame.K_DOWN); key(pygame.K_RIGHT)   # FPS -> 60
key(pygame.K_ESCAPE)
fd.settings_screen(surf, clock, st)
assert st == {"mode": "manual", "map": "circuit", "fps": 60}, st
assert fd.RENDER_FPS == 60 and fd.RENDER_EVERY == 1
with open(fd.SETTINGS_PATH, encoding="utf-8") as f:
    assert json.load(f) == st, "file settings gak tersimpan"
# load ulang harus baca file yang sama
st2 = fd.load_settings()
assert st2 == st, st2
os.remove(fd.SETTINGS_PATH)     # beres-beres
fd.set_render_fps(30)
print("PASS: settings ubah+persist+load ulang")

# --- 6. load_settings: file rusak/aneh -> fallback aman ---
with open(fd.SETTINGS_PATH, "w", encoding="utf-8") as f:
    json.dump({"mode": "ngasal", "map": "osm", "fps": 120}, f)
st3 = fd.load_settings()
assert st3 == {"mode": "assistant", "map": "loop", "fps": 30}, st3
os.remove(fd.SETTINGS_PATH)
print("PASS: load_settings validasi & fallback")

# --- 7. about: ESC nutup ---
key(pygame.K_ESCAPE)
fd.about_screen(surf, clock)
print("PASS: about ESC nutup")
pygame.quit()

# --- 8. main() tanpa argumen: menu muncul, ESC keluar bersih ---
pygame.init()
surf = pygame.display.set_mode((fd.W, fd.H))
key(pygame.K_ESCAPE)
sys.argv = ["fundriving.py"]
fd.main()
print("PASS: main() -> menu -> EXIT bersih")

# --- 9. main() --map: skip menu ---
sys.argv = ["fundriving.py", "--map", "loop", "--seconds", "1"]
fd.main()
print("PASS: main() --map skip menu")
pygame.quit()

# --- 10. mode manual mengemudikan mobil ---
calls = {"n": 0}
def fake_controls(pressed):
    calls["n"] += 1
    return 0.3, 1.0, 0.0
fd.driver_controls = fake_controls
pygame.init()
surf = pygame.display.set_mode((fd.W, fd.H))
clock = pygame.time.Clock()
stats = fd.run_map(LOOP, False, 2, surf, clock, tempfile.mkdtemp(),
                   record=False, auto_start=False)
assert calls["n"] > 60 and stats["tempuh_m"] > 50, (calls["n"], stats["tempuh_m"])
print(f"PASS: mode manual — {calls['n']}x kontrol, tempuh {stats['tempuh_m']:.0f}m")
pygame.quit()

# --- 11. mode assistant windowed tak berubah ---
pygame.init()
surf = pygame.display.set_mode((fd.W, fd.H))
clock = pygame.time.Clock()
stats = fd.run_map(LOOP, False, 8, surf, clock, tempfile.mkdtemp(),
                   record=False, auto_start=True)
assert stats["tempuh_m"] > 40, stats["tempuh_m"]
print(f"PASS: mode assistant — tempuh {stats['tempuh_m']:.0f}m dalam 8s sim")
pygame.quit()
# --- 12. build_jev_body: request kandidat -> body SystemOne (murni, tanpa net) ---
_req = {
    "speed": 8.0, "limit": 13.0, "destination_m": 500.0,
    "questions": {"vector": "pilih id kandidat fastest useful progress"},
    "candidates": {
        "v0": {"name": "Lurus", "progress_m": 19.5, "lane_error_m": 0.4,
               "end_speed": 12.5, "on_road": True, "collision_in_s": None,
               "crosses_red": False},
        "stop": {"name": "Rem", "progress_m": 4.2, "lane_error_m": 0.2,
                 "end_speed": 0.0, "on_road": True, "collision_in_s": None,
                 "crosses_red": False},
    },
}
_body = fd.build_jev_body(_req)
assert _body["model"] == "jev-latest", _body.get("model")
assert _body["questions"]["vector"]["type"] == "choice"
assert set(_body["questions"]["vector"]["criteria"]) == {"v0", "stop"}
assert "candidates" not in _body["state"] and _body["state"]["speed"] == 8.0
print("PASS: build_jev_body shape SystemOne")

# --- 13. remote_decide: tanpa key/URL -> None; URL mati -> None (fail soft) ---
_saved = {k: os.environ.get(k) for k in ("JEV_API_URL", "TYPESAFE_API_KEY")}
for k in _saved:
    os.environ.pop(k, None)
assert fd.remote_decide({}) is None
os.environ["JEV_API_URL"] = "http://127.0.0.1:9/"  # port tutup: refused instan
assert fd.remote_decide({}) is None
for k, v in _saved.items():
    if v is not None:
        os.environ[k] = v
    else:
        os.environ.pop(k, None)
print("PASS: remote_decide fallback tanpa net")

# --- 14. load_dotenv: parse .env, env asli menang ---
_tmp = os.path.join(tempfile.mkdtemp(), ".env")
with open(_tmp, "w", encoding="utf-8") as f:
    f.write("# komen\n\nFD_TEST_A=1\nFD_TEST_B=\"dua kata\"\nFD_TEST_A=diabaikan\n")
os.environ["FD_TEST_B"] = "env-menang"
fd.load_dotenv(_tmp)
assert os.environ.get("FD_TEST_A") == "1", os.environ.get("FD_TEST_A")
assert os.environ.get("FD_TEST_B") == "env-menang", os.environ.get("FD_TEST_B")
del os.environ["FD_TEST_B"]
os.remove(_tmp)
print("PASS: load_dotenv parse + prioritas env")
print("SEMUA PASS")
