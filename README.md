# Gee-FunDriving 🚗💨

Simulasi nyetir 2D top-down: **1 mobil autonomous** keliling sirkuit dengan *System-One decision loop* — inspirasi dari [demo "rebuilt Tesla FSD with Jev"](https://x.com/jpschroeder/status/2100347770867458384) (TypeSafe AI's Jev model).

![Gee-FunDriving](assets/logo-both.png)

![gameplay](docs/demo.png)

## Peta OSM (baru!)

Sim bisa jalan di **peta jalan asli** — misal daerah Puri Indah, Jakarta Barat:

```bash
# 1. Fetch jalan dari OpenStreetMap (sekali saja)
python3 tools/fetch_osm.py        # -> maps/puri_indah.json (1137 jalan, 3.6x2.4 km)

# 2. Sim di peta asli: mobil otomatis cari rute barat->timur & nyetir sendiri
python3 fundriving.py --map maps/puri_indah.json --headless --seconds 150
```

Fitur map mode:
- Graf jalan OSM (node/way) + pathfinding A*-like (heapq BFS berbobot)
- Mobil follow rute pakai waypoint: steer proporsional sudut ke target,
  rem otomatis di tikungan tajam (>90° = balik arah)
- Kamera follow + render jalan sesuai lebar asli (tol 22m s/d gang 8m)
- Hasil verifikasi: rute 92 waypoint, **finished=True** (sampai tujuan)

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
