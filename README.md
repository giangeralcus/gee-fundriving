# Gee-FunDriving 🚗💨

Simulasi nyetir 2D top-down: **1 mobil autonomous** keliling sirkuit dengan *System-One decision loop* — inspirasi dari [demo "rebuilt Tesla FSD with Jev"](https://x.com/jpschroeder/status/2100347770867458384) (TypeSafe AI's Jev model).

![Gee-FunDriving](assets/logo-both.png)

![gameplay](docs/demo.png)

## Versi web (baru! — Loop City di browser)

```bash
# cara 1: buka langsung (offline, tanpa server)
web/index.html                      # dobel-klik

# cara 2: server lokal
cd web && python -m http.server 8123   # -> http://localhost:8123/
```

Port JavaScript + Canvas dari versi desktop: fisika 60Hz fixed-step, render
30/60fps, menu START/SETTINGS/ABOUT/EXIT (setelan di localStorage), assistant
pure pursuit + ACC + lampu merah, traffic AI, mode misi, dan kendali manual
(WASD/arrow + `F` ambil-alih). Peta Loop City di-embed (`map_loop_city.js`).
Tes: `node web/test_headless.js` (logika: mobil jalan, misi selesai).

## Loop City (default, peta internal — instan & gampang diadaptasi)

Peta ring kota bikinan sendiri: 1 jalan lingkar + 3 jalan cross (6 simpang
berlampu) + bangunan + taman. Loading instan, semua fitur jalan. Mau diubah-
ubah? Semua parameter ada di atas `tools/make_loopmap.py` (ukuran ring, lebar
jalan, kepadatan bangunan, posisi cross, seed).

```bash
python tools/make_loopmap.py     # regenerate peta (23KB, sekali saja)
python fundriving.py --map loop  # mode misi + traffic + lampu di Loop City
```

## Peta OSM nyata (opsional, berat — fetch sendiri)

Mau dunia kota asli? Fetch dari OpenStreetMap (butuh internet, hasilnya puluhan MB, gak disimpan di repo):

```bash
python tools/fetch_osm.py                          # preset: Puri Indah -> Cengkareng/Taman Palem
python tools/fetch_osm.py --preset puri-indah      # area kecil Puri Indah doang
python tools/fetch_osm.py --bbox -6.19 106.73 -6.15 106.76 --name "Area X" --out maps/x.json

# koordinat bebas + rute antar dua titik (contoh: Green Sedayu -> Puri Indah Mall):
python fundriving.py --map maps/puri_cengkareng.json \
    --route green-sedayu puri-indah
# atau langsung lat,lon:
python fundriving.py --map maps/puri_cengkareng.json \
    --start "-6.1390775,106.7286378" --goal "-6.1882573,106.7338886"

# headless (rekam MP4, butuh ffmpeg):
python fundriving.py --map loop --headless --seconds 60
```

Fitur map mode:
- **Self-driving v3**: pure pursuit (target selalu di atas rute), progresi proyeksi segmen, raut rute Douglas-Peucker (bunuh zigzag dual-carriageway), antisipasi tikungan (rem curvature, slow-in fast-out), ACC proporsional searah (lawan arah bukan rintangan), anti-stall, safety-net snap kalau keluar > 35m
- **Lajur kanan**: mobil jalan di lajur kanan (bukan tengah jalan), AI deteksi mobil lu sebagai rintangan
- **Dunia berlapis**: jalan per-tipe dengan casing, poligon bangunan, area hijau/air — chunk cache per-tile 500m (60fps di peta 9x9 km)
- **Koordinat bisa diatur**: `--route poi-a poi-b` (dari maps/poi.json), atau `--start "lat,lon"` + `--goal "lat,lon"` + `--heading derajat`
- **Mode misi**: skor = rute terpendek ÷ rute ditempuh × 1000, −40/lampu merah, −25/tabrakan; selesai → auto misi baru
- **Lalu lintas**: mobil AI random-walk di graf (lane kanan, jaga jarak, deteksi hero) + lampu lalu lintas siklus 7 detik, nyabrang merah kena denda
- **Nama jalan** di dekat mobil, pathfinding A* di graf OSM
- **Main menu**: `python fundriving.py` tanpa argumen → **START / SETTINGS / ABOUT / EXIT**. SETTINGS ngatur mode (assistant / kendali sendiri), peta (Loop City / sirkuit / OSM kalau ada), dan render FPS 30/60 — tersimpan di `~/gee-fundriving/settings.json`. ESC di game balik ke menu; windowed tanpa `--seconds` = main tanpa timer
- **Bisa dikendarai sendiri**: tekan `F` untuk lepas dari assistant dan kemudikan mobil pakai `WASD`/arrow (`W`/`↑` gas, `S`/`↓` rem, `A`/`D` belok — kemudi di-smooth biar gak jerk). Tekan `F` lagi buat balik ke autopilot. Mulai langsung dari kemudi: `--manual`. Di mode manual kamu yang nyabrang lampu merah (denda tetap masuk) dan nggak ada snap balik ke rute
- **Kamera follow** + zoom `[-][=]`, `R` misi baru, `F` assistant ON/OFF, `ESC` keluar, FPS live di HUD; render 30fps (fisika tetap 60Hz), rekaman MP4 headless 30fps real-time

Benchmark learning curve: `python tools/benchmark.py` (dua arah Green Sedayu ↔ Puri Indah di peta OSM, atau misi acak di Loop City) — hasil tercatat di `docs/benchmark/history.jsonl`.

Tambah peta daerah lain: ubah koordinat bbox di `tools/fetch_osm.py` atau pakai `--bbox`.

## Konsep

Mobil nggak pakai bahasa natural — dia **memutuskan** tiap tick:

| State (sensor) | Keputusan (typed) |
|---|---|
| `f, fl, fr, l, r` — jarak ray 5 arah | `steer ∈ [-1,1]` |
| `lateral` — posisi vs center line | `throttle ∈ [0,1]` |
| `heading_err` — sudut vs arah track | `brake ∈ {0,1}` |
| `speed_norm` | + `confidence` per keputusan |

Fungsi `brain_decide(state)` adalah **pluggable brain**. Default: rule-based yang mengimitasi pola Jev (pertanyaan kecil paralel → keputusan typed + confidence). Ganti dengan API call Jev asli tanpa menyentuh kode lain.

## Hasil tes awal

- 3 lap penuh dalam 30 detik, **0 crash**
- Reset otomatis saat keluar jalan + statistik `best alive`

## Jalanin

```bash
pip install pygame

# Mode jendela (butuh display)
python3 fundriving.py

# Headless + rekam MP4 30 detik
python3 fundriving.py --headless --seconds 30
# → fundriving_demo.mp4
```

## Struktur

```
fundriving.py     # sim + physics + sensors + brain + renderer
docs/demo.png    # screenshot gameplay
```

- [x] Map mode: peta jalan asli OSM (Puri Indah) — DONE

## Roadmap

- [ ] Mode sedang: mobil + motor, obstacle acak, traffic
- [ ] Multi-agent + leaderboard
- [ ] Hook Jev API asli (early access TypeSafe) sebagai brain
- [ ] Brain generational (evolution) buat belajar hindar

---
Dibuat di D4 oleh bakasang untuk Gee 🏁
