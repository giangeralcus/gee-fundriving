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

## 17. Jev: model milih, kode yang mutusin aman

- **Kejadian**: integrasi Jev SystemOne (2026-10-01) — payload cuma tabel
  kandidat + konteks, Jev balas `{"choice": "v3"}`.
- **Pelajaran** (pola JevPilot): model cuma milih dari kandidat yang sudah
  difilter layak (moving set); **validasi pilihan tetap di kode** (pick harus
  anggota pool, kalau bukan → scorer lokal yang jalan). Safety di kode, bukan
  di model. Berlaku umum buat model-di-loop: jangan pernah percaya output
  mentah — jadikan advisory di atas safety-net deterministik.

## 18. Test sensitif isi working tree = bom waktu antar-checkout

- **Kejadian**: check 6 (`load_settings` fallback) gagal padahal kode tak
  berubah — karena `maps/puri_cengkareng.json` (gitignored, 27MB) ada di
  checkout ini, jadi `"osm"` dianggap valid dan ekspektasi `"loop"` meleset.
- **Pelajaran**: ekspektasi test yang tergantung file gitignored bakal beda
  hasil di fresh clone vs checkout lama. Verifikasi pre-existing tanpa
  melemahkan test: rename file aside → suite hijau → balikin. Jangan ubah
  ekspektasi test buat ngejar hijau.

---

**Pola besar yang keulang**: (1) pisahkan logika murni dari I/O — bikin test,
port, dan debugging jadi murah; (2) setiap klaim "udah bener" butuh ukuran
(A/B seed, tick rate, skor); (3) environment (PATH, build ffmpeg, throttle
browser) lebih sering jadi penyebab daripada algoritmanya.

## 13. Adopsi dari simulasi orang lain: v_target kontinyu, bukan bucket rem

- **Kejadian**: assistant "aneh" — ngerem penuh di depan tikungan (bucket
  `curv > 50 -> brk 0.9`) lalu ditarik-ndorong anti-stall, jadinya creeping.
- **Riset**: pola dari simulasi orang lain — [Regulated Pure Pursuit
  (arXiv 2305.20026, NVIDIA Nav2)](https://arxiv.org/pdf/2305.20026) pakai
  regulasi kecepatan berbasis curvature; [arimb/PurePursuit](https://github.com/arimb/PurePursuit)
  hitung curvature -> velocity tiap tick; [ETH MAP controller](https://www.research-collection.ethz.ch/server/api/core/bitstreams/6b6b5f75-08a5-4760-a5f3-ceac30e5dc70/content)
  turunkan v dari `v = sqrt(a_lat/kappa)`.
- **Adopsi**: `v_target = 1/(1 + curv/40)` kontinyu (relatif), gas/rem
  proporsional ke selisih `(v_target - speed_norm)` — slow-in fast-out tanpa
  patah. Hasil: tempuh 5 detik naik ~44m -> ~230m+, skor misi konsisten
  920-1015 (dulu 921-1008 tapi dengan creeping), nol macet di 4 run x 4 menit.
- **Pelajaran**: bucket diskrit = patah-patah + osilasi sama anti-stall;
  target kontinyu + kontrol proporsional lebih halus DAN lebih simple.

## 14. Kecepatan basis bisa diatur: instance attr menimpa class constant

- **Kejadian**: permintaan "kalo aneh/nyangkut, kecepatan basis bisa diatur".
  `MAXV`/`ACC` tadinya class constant yang dibaca langsung.
- **Adopsi**: instance attribute (`car.MAXV = MapCar.MAXV * speed_scale`) —
  Python/JS sama-sama mengizinkan instance menimpa static. Skala MAXV dan ACC
  BARENG biar feel akselerasi proporsional. Dibuka di SETTINGS
  (KECEPATAN 0.5x-1.5x, persist settings.json / localStorage) + `--speed` CLI.
- **Pelajaran**: knob user = instance state; class constant = kontrak fisika.
  Jangan ubah kontraknya, timpa per-instans.

## 15. Refactor map: satu sumber kebenaran buat edge

- **Kejadian**: pasangan edge di-enumerasi di 3 tempat (World, Game._edgeCache,
  test) dan Signals nyusun ulang simpang lewat matching posisi node di Game —
  konstruksi dua-fase, gampang selisih.
- **Refactor**: `World` hitung `edges` (unik) + `edgeById` + `edgeByPos`
  sekali di konstruktor; `Signals` hitung simpangnya sendiri di konstruktor
  dari data itu; hack `Game._signalsEdgeIds/_findEdge/_edgeCache` dihapus
  (-45 baris). Test paritas (6 lampu, 13 mobil) naik status jadi hard assert.
- **Pelajaran**: saat ngerefactor, ubah test paritas dari "catatan" jadi
  assert keras — refactor beneran gak boleh mengubah perilaku, dan harus
  terbukti sama test.

## 16. Test dulu baru percaya: regression refactor ketangkep dalam 1 run

- **Kejadian**: versi pertama refactor salah key (`"min|max"` vs
  `"ax,ay|bx,by"`) -> lampu = 0. Test headless langsung tangkep sebelum sempat
  ke browser.
- **Pelajaran**: "recursive learning" itu literally ini — setiap iterasi
  dipagari test dari iterasi sebelumnya (paritas lampu/mobil yang dulu
  catatan kaki, sekarang pagar).

## 19. Ganti model gerak: rollout WAJIB cermin fisika beneran

- **Kejadian** (2026-10-01): migrasi yaw "rate kap" (`steer*YAW_MAX*(...)`)
  ke **model sepeda kinematik** (`yaw = v/L·tan(delta)`, sudut roda depan
  di-rate-limit) + steering pure pursuit curvature (`κ = 2y/Ld²`,
  `delta = atan(κ·WB)` — Coulter 1992, PythonRobotics). Brain v3 sempat
  **gak selesai + kena tabrak** padahal v4 bersih: brain rule masih pakai
  `he/40` yang kalibrasinya gak cocok sama geometri baru (understeer).
- **Pelajaran**: kalau ada DUA pemakai model gerak (sim + rollout planner +
  brain rule), ganti fisika = ganti SEMUA, bukan cuma `car.step`. Formula
  steer error-normalized (`he/40`) itu terkalibrasi ke model lama — ganti
  model gerak wajib ganti ke steering berbasis curvature yang turun dari
  geometri kendaraan (wheelbase, steerMax). Paritas test A/B nangkep sisanya.

## 20. Fitur dunia (rambu/kendaraan) lahir dari data deterministik

- **Kejadian**: rambu STOP & zona kecepatan dibangkitkan dari `hash01(nodeId)`
  — bukan `Math.random()` — biar peta sama = rambu sama: bisa dites, bisa
  direproduksi, gak berubah tiap reload. Loop City (semua simpang berlampu)
  hasilnya 0 STOP → fallback: kalau gak ada simpang yang kwalifikasi, sebagian
  kecil node belokan dobel dapat STOP.
- **Pelajaran**: konten dunia yang memengaruhi perilaku (rambu = penalti)
  harus deterministik & dites; fitur yang bisa "gak muncul" di peta tertentu
  butuh fallback biar tetap terlihat. Mobil AI juga harus hormat rambu yang
  sama (crawl masuk simpang STOP) — kalau cuma hero yang nurut, hero berhenti
  jadi sasaran serudukan AI di belakang.

## 21. Referensi dari repo orang lain: ambil formulanya, gak ambil mentah-mentahnya

- **Kejadian** (2026-10-01): fitur parkir otonom + rambu. Riset langsung ke
  sumber: PythonRobotics (AtsushiSakai) — Stanley (``delta = theta_e +
  atan2(k*e, v)``, dipakai buat servo parkir low-speed), MPCC bicycle model
  (``MAX_DSTEER = 30°/s`` memvalidasi rate-limit kemudi), pure pursuit
  (Coulter 1992, sudah dipakai). Wikipedia "Parallel parking" DICEK langsung
  ternyata GAK punya bagian matematis — jadi geometri maneuver disusun dari
  fisika sendiri (keyframe servo + fisika model sepeda), bukan kutipan ngasal.
- **Pelajaran**: adoptasi referensi itu tiga langkah: (1) ambil formula DARI
  SUMBER ASLINYA (raw GitHub, bukan ingatan), (2) petakan ke kontrak kode
  kita (Steer normalized [-1,1], DT 1/60), (3) buktikan lewat benchmark —
  bukan "udah mirip". Yang gak ketemu sumbernya (geometri parkir), tulis
  turunannya sendiri dan-catat di sini.

## 22. Rem antisipatif: jangkar fisika, bukan angka ajaib

- **Kejadian**: mobil gak berhenti di rambu STOP — rem baru engage di 9m
  padahal dari 11 m/s butuh 8,1m (v²/2b). Diperbaiki pakai jangkar fisika
  ``brakeDist = v²/(2·BRAKE) + margin`` dengan FLOOR minimum (3,5m) — versi
  tanpa floor malah osilasi: brakeDist menyusut saat mobil melambat → rem
  lepas → gas lagi, berulang di ~4 m/s.
- **Pelajaran**: logika kendali berbasis jarak harus dijangkar ke fisika
  pengereman (stopping distance), dan ADA batas bawah — tanpa floor, sistem
  menemukan titik ekuilibrium "nyaris berhenti selamanya". Deteksi zona juga
  harus menjangkau 0m (stopAhead lama mulai dari 3m — penalti nabrak rambu
  gak pernah kepicu karena mobil lewat di bawah 3m).
