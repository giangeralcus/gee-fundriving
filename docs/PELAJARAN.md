# Catatan Pelajaran — Perjalanan Ngerjain Gee-FunDriving

Dokumen ini nyatet pelajaran-pelajaran (bug, jebakan, pola) dari perjalanan
ngerjain proyek: dari simulasi desktop jadi playable, sampai port ke web.
Diurut kira-kira sesuai urutan kejadian.

## 1. Environment: `python` bukan berarti Python-mu

- **Kejadian**: `python fundriving.py` → `ModuleNotFoundError: No module named
  'pygame'`. Ternyata `python` di PATH nunjuk ke venv milik tool lain
  (hermes-agent), dan venv itu bahkan **gak punya pip** — jadi saran resmi di
  README (`pip install pygame`) juga gagal.
- **Pelajaran**: selalu cek `which python` / `python -m pip --version` SEBELUM
  ngasih saran install. Di Windows, launcher `py` (miniconda) jadi jalur aman:
  `py -m pip install -r requirements.txt`. Repo sekarang punya
  `requirements.txt` biar kebutuhannya eksplisit.

## 2. ffmpeg build Windows gak dukung `-pattern_type glob`

- **Kejadian**: `--headless` selesai render ratusan frame, tapi encode MP4
  gagal dengan exit code aneh (4294967256). Dijalankan manual: `Pattern type
  'glob' was selected but globbing is not supported by this libavformat build`.
- **Pelajaran**: fitur ffmpeg yang "pasti ada" ternyata tergantung build.
  Pola aman lintas-platform: input **image sequence** `%05d`, bukan glob.
  Sekalian: frame yang disave tiap-2-tick jangan pakai nomor tick sebagai
  nama file (namanya jadi bolong: f00000, f00002, …) — pakai counter tersendiri.

## 3. Tuning fisika diikat ke tick — render dipisah dari fisika

- **Kejadian**: permintaan "framerate 30" — kalau `FPS = 60` diubah begitu
  saja, semua konstanta (ACCEL, siklus lampu 420 tick = 7 detik, cooldown 240
  tick) ikut melambat: dunia jadi slow-motion.
- **Pelajaran**: pisahkan **tick fisika** (60Hz, kontrak tuning) dari
  **render/input/rekam** (30fps). Pola: fisika jalan tiap tick, render tiap
  `RENDER_EVERY` tick. Bukti bebas regresi: A/B test dengan seed sama —
  jarak tempuh identik (69m di 4 seed) sebelum vs sesudah.

## 4. Bug logika satu karakter: `and not` vs `or`

- **Kejadian**: guard "headless gak punya sopir" ditulis
  `auto = auto_start and not headless` — justru memaksa mode MANUAL pas
  headless → mobil beku total (0m vs 69m di A/B test).
- **Pelajaran**: kalimat niat ("headless wajib autopilot") harus diterjemahin
  hati-hati: `auto_start OR headless`. Dan **tes regresi A/B seed-sama itu
  murah tapi mendeteksi bug yang keliatan "aneh gak masuk akal"**.

## 5. Timer tersembunyi membunuh playability

- **Kejadian**: loop game ternyata `for fi in range(FPS * seconds)` dengan
  default 45 — di mode windowed, game keluar sendiri setelah 45 detik.
  Masuk akal buat demo/headless, aneh buat main.
- **Pelajaran**: batas waktu itu fitur headless, bukan fitur game. Windowed
  tanpa `--seconds` = main tanpa timer.

## 6. Kemudi keyboard mentah itu jerky — lerp itu pola baku

- **Kejadian**: kontrol manual pertama: steer 0/1 mentah — mobil snap
  kiri/kanan.
- **Pelajaran** (dari referensi controller top-down, mis. kidscancode):
  held-key via `get_pressed()`, turn rate diskalakan speed, dan **lerp kemudi
  ke target** (`steer += (target - steer) * 0.25`) biar halus. Jangan lupa
  reset nilai kemudi pas ganti sopir (assistant ↔ manual).

## 7. Port ke web: logika murni gampang, environment yang bikin kerja

- **Kejadian**: port JS ~1.000 baris lancar karena hampir semua logika adalah
  matematika murni (pure pursuit, ACC, Dijkstra, Douglas-Peucker). Angka
  paritas langsung kebaca: 6 lampu & 13 mobil AI — persis desktop.
- **Pelajaran**: kalau logika dipisah bersih dari I/O (render, file, env),
  port-nya transliterasi + test paritas. Node bisa jadi harness test tanpa
  browser: jalankan `Game.simTick` asli pakai canvas palsu
  (`window` di-guard). Hasil: 13 misi selesai, skor 921–1008.

## 8. `eval` + `"use strict"` = scope bocor kemana-mana

- **Kejadian**: test node pakai `eval(file)` — deklarasi `class`/`const` gak
  keluar dari scope eval strict → `World is not defined`.
- **Pelajaran**: buat script gabungan (concat file → tulis file sementara →
  `require`), atau pakai module system beneran.

## 9. rAF di-throttle Chromium — jam simulasi harus dari Worker

- **Kejadian** (TC-1): game web keliatan beku pas tab/pane gak dirender:
  `requestAnimationFrame` di-throttle Chromium (occluded) dari 60fps jadi
  ~1fps — ikut menyeret loop simulasi.
- **Pelajaran**: **jam fisika jangan nempel rAF.** Tick 60Hz dikirim Web
  Worker (timer worker gak kena throttle), rAF cuma render. Fallback
  akumulator kalau Worker gak ada. Hasil TC-1: 59 tick/detik di tab
  di-throttle, waktu sim = waktu nyata. Pola ini berlaku umum buat game/anim
  web apa pun.

## 10. Otomasi UI di atas canvas butuh render sinkron

- **Kejadian**: klik otomatis ke menu web kadang gak kena — di tab yang
  di-throttle, `renderMenu()` (dan `itemsRects`) belum jalan pas klik datang.
- **Pelajaran**: sebelum aksi koordinat di UI canvas, paksa render sinkron
  dulu. Dan untuk test logika, jangan bergantung jalur UI — panggil
  `activate()` langsung. (Di tab hidup 60fps, klik normal gak bermasalah.)

## 11. Deadlock breaker harus nutup zona yang bikin deadlock

- **Kejadian**: assistant berhenti permanen di antrean AI dengan gap 20m —
  breaker lama cuma nyala di gap <15m, padahal zona "ikut" ACC itu 20–35m.
- **Pelajaran**: threshold safety-net harus dinuber terhadap zona perilaku
  yang dia tangani. Web dilonggarkan ke <36m (3 run × 5 menit: 13 misi, nol
  macet). Desktop masih 15m — tercatat sebagai quirk, belum disentuh biar
  angka benchmark historis tetap comparable.

## 12. Windows dev environment: path & server

- `file://` gak bisa dibuka tool otomasi browser → jalankan
  `python -m http.server` lokal buat test (sekalian memvalidasi skenario
  deploy statis).
- Desktop shortcut (`WScript.Shell`) paling gampang dibuat lewat file .ps1 —
  inline dari bash suap `$variabel` PowerShell-nya.

---

**Pola besar yang keulang**: (1) pisahkan logika murni dari I/O — bikin test,
port, dan debugging jadi murah; (2) setiap klaim "udah bener" butuh ukuran
(A/B seed, tick rate, skor); (3) environment (PATH, build ffmpeg, throttle
browser) lebih sering jadi penyebab daripada algoritmanya.
