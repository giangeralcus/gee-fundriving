---
name: lazy-writing
description: "Use for ANY writing task: README, docs, commit messages, PR descriptions, comments, chat replies, captions, tweets, emails. Produces plain human text with zero detectable AI patterns. Compiled from Wikipedia Signs of AI Writing, CMU/ACL 2025 vocabulary research, Buffer 52M-post analysis, Orwell's six rules, plus Indonesian slop patterns. Triggers on 'write', 'draft', 'tulis', 'buat caption', 'rewrite', 'anti-slop', 'anti AI slop', or whenever output text must not read as AI-generated."
---

# Lazy Writing

Tulis seperlunya. Efort minimum, sinyal maksimum. Lazy di sini bukan asal-asalan — lazy berarti nol dekorasi: setiap kalimat harus beli tempatnya dengan informasi.

Filosofi: penulis yang malas gak sempat pake kata klise. Malas = potong. Malas = kata pendek. Malas = langsung ke inti.

## Test Lazy (cek sebelum kirim)

Tanya per kalimat: **"kalau gw hapus, apa yang hilang?"**
- Jawabannya "nggak ada" → hapus kalimatnya.
- Jawabannya "buanyak kata-katanya" → potong jadi versi pendek.
- Kalimat masih bisa dipangkas tanpa kehilangan makna → belum selesai.

## Aturan Inti (compiled)

**1. Potong kata yang bisa dipotong.** (Orwell iii) "dalam rangka untuk" → "untuk". "at this point in time" → "now".

**2. Kata pendek menang.** (Orwell ii & v) `utilize`→`use`, `commence`→`start`, `memanfaatkan`→`pakai`, `melakukan pengecekan`→`cek`.

**3. Aktif, bukan pasif.** (Orwell iv) "dilakukan pengecekan oleh tim" → "tim ngecek". Pasif buat sounds measured = bunuh diri gaya.

**4. Variasi panjang kalimat.** Dilarang 3 kalimat beruntun sepanjang mirip. Campur kalimat 4 kata sama yang 30 kata.

**5. No rule of three.** Jangan default daftar tiga. Dua, empat, satu — sesuai isi, bukan sesuai ritme.

**6. No parataxis berantai.** "Kalimat pendek. Terus lagi. Terus lagi." = tanda AI paling gampang dikenalin. Sambung pikiran pakai konjungsi/klausa subordinate.

**7. No negative parallelism.** "bukan hanya X, tetapi Y" / "not just X, but Y" / "Y rather than X" — pola paling dicari detektor. Kalau memang cuma Y yang penting, tulis Y-nya doang.

**8. No puffery & inflasi signifikansi.** (Wikipedia) Jelaskan apa adanya, jangan pakai terowongan "bukti komitmen kami", "a testament to", "berperan penting dalam", "evolving landscape", "turning point".

**9. Akurasi di atas drama.** Dilarang mengarang statistik, quote, atau anekdot. Angka tanpa sumber = jangan ditulis.

**10. No klausa tack-on.** Pola paling gampang dikenalin: kalimat bagus + ekor analitis. ", menciptakan …" / ", menjadikannya …" / ", menandakan …" / ", revolutionizing …". Kalau ekornya gak bawa info konkret → buang. Kalau bawa → jadiin kalimat sendiri.

**11. Kalibrasi suara (house style giang):**
- Chat internal & pesan ke owner: santai, "gw/lu", boleh slang, emoji seperlunya (0–2).
- README / docs / commit / PR publik: profesional tapi kering. Tanpa basa-basi pembuka, tanpa promo. Indonesia untuk repo lokal, ikuti bahasa repo jika English-first.
- Commit message: imperatif pendek. "Add lazy-writing skill", bukan "This commit aims to add...".

## Self-Check Sebelum Kirim

1. Test Lazy per kalimat (di atas).
2. Baca keras-keras. Terasa "robot formal" atau "brand pura-pura gen-Z" → rewrite.
3. Satu register konsisten: jangan campur gue/lo sama aku/kamu dalam satu teks.
4. Angka & klaim: ada sumbernya? Gak ada → hapus atau tandai sebagai tebakan.

## Tanda Baca & Format

- Em dash maksimal 1 per paragraf. Spam em dash = red flag #1 deteksi.
- Dilarang teriak: minimal tanda seru, tanpa spam elipsis (...).
- Bullet dipakai seperlunya dan TIDAK rata (panjang-pendek acak). Maks 5-7 bullet beruntun. Kalimat lebih baik daripada bullet.
- Dilarang emoji sebagai formatting (emoji bullet, emoji heading), dilarang tumpukan hashtag.
- Tanpa markdown di tempat plain-text (chat WhatsApp/tweet).

## Vokab Terlarang

Load saat menulis:
- [references/banned-words-en.md](references/banned-words-en.md) — kata/frasa/pembuka EN (compiled: CMU 2025, Wikipedia WP:AIVOCAB, Buffer 52M, era GPT-4/4o/5)
- [references/kata-terlarang-id.md](references/kata-terlarang-id.md) — pola slop Bahasa Indonesia (kompilasi sendiri)

Satu kata terlarang bisa kebablasan. Sekalikerumunan = ketahuan. Yang paling dicari pembaca Indonesia: **"hiruk pikuk"** — kalau muncul, hampir pasti ditulis AI. Kalau terlanjur nulis kata terlarang, ganti dengan alternatif konkret atau restrukturisasi kalimatnya.

## Sumber

Kompilasi lengkap + link: [references/sources.md](references/sources.md)
