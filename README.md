# Gee-FunDriving 🚗💨

Simulasi nyetir 2D top-down: **1 mobil autonomous** keliling sirkuit dengan *System-One decision loop* — inspirasi dari [demo "rebuilt Tesla FSD with Jev"](https://x.com/jpschroeder/status/2100347770867458384) (TypeSafe AI's Jev model).

![Gee-FunDriving](assets/logo-both.png)

![gameplay](docs/demo.png)

## Peta OSM (dunia kota + traffic + misi)

Sim jalan di **peta kota asli** — misal daerah Puri Indah, Jakarta Barat:

```bash
# 1. Fetch jalan + bangunan + area dari OpenStreetMap (sekali saja)
python3 tools/fetch_osm.py                       # default: Puri Indah -> Cengkareng/Taman Palem
                                                 #   (9.2rb jalan, 80rb bangunan, 9.4x8.9 km)
python3 tools/fetch_osm.py --preset puri-indah   # area kecil Puri Indah doang
python3 tools/fetch_osm.py --bbox -6.19 106.73 -6.15 106.76 --name "Area X" --out maps/x.json

# 2. Main di peta asli: mode misi, mobil AI, lampu merah
python3 fundriving.py --map maps/puri_cengkareng.json

# Atur koordinat sendiri: start (Puri Indah) -> tujuan (Taman Palem)
python3 fundriving.py --map maps/puri_cengkareng.json \
    --start "-6.1912,106.7407" --goal "-6.1520,106.7225"

# headless (rekam MP4, butuh ffmpeg):
python3 fundriving.py --map maps/puri_cengkareng.json --headless --seconds 150
```

Fitur map mode:
- **Dunia berlapis**: jalan per-tipe (tol 22m s/d gang 8m) dengan casing, poligon bangunan, area hijau/air — semua dari OSM, dirender via chunk cache per-tile 500m (60fps di peta 9x9 km)
- **Koordinat bisa diatur**: `--start "lat,lon"`, `--goal "lat,lon"`, `--heading derajat` — misi eksplisit antar dua titik
- **Mode misi**: skor = rute terpendek ÷ rute ditempuh × 1000, −40/lampu merah, −25/tabrakan; selesai → auto misi baru
- **Lalu lintas**: mobil AI random-walk di graf jalan (lane kanan, jaga jarak) + lampu lalu lintas siklus 7 detik — AI dan mobil lu sama-sama berhenti di merah, nyabrang kena denda
- **Self-driving v2**: antisipasi tikungan (rem berdasar curvature depan — slow-in fast-out), ACC jaga jarak dari mobil depan (REM!/ikut/geser di HUD), steering proporsional
- **Nama jalan** muncul di dekat mobil, pathfinding A*-like di graf OSM
- **Kamera follow** + zoom `[-][=]`, `R` misi baru, `ESC` keluar

Tambah peta daerah lain: ubah `LAT0/LON0/LAT1/LON1` di `tools/fetch_osm.py`.

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
