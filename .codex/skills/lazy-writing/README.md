# lazy-writing

Skill anti AI-slop versi giang. Nama kerennya: tulis seperlunya — efort minimum, sinyal maksimum. Lazy bukan asal-asalan; lazy berarti nol dekorasi.

## Isi

```
SKILL.md                        # aturan inti + test lazy + self-check
references/
  kata-terlarang-id.md          # jargon slop Indonesia (pembuka klise, transisi, penutup, tack-on, over-gaul)
  banned-words-en.md            # vocab/frasa/pola EN (CMU, Wikipedia, Buffer)
  sources.md                    # semua sumber + kredit
```

## Sumber yang dikompilasi

Riset: Wikipedia *Signs of AI writing*, Russell et al. (ACL 2025), Kobak et al. (Science Advances 2025), Buffer 52M posts, Orwell.

Repo sejawat: [jalaalrd/anti-ai-slop-writing](https://github.com/jalaalrd/anti-ai-slop-writing), [alvinindra/bahasa-skills](https://github.com/alvinindra/bahasa-skills), [ardha27/humanizer-id](https://github.com/ardha27/humanizer-id), [adenaufal/anti-slop-nusantara](https://github.com/adenaufal/anti-slop-nusantara), [konten-studio/jekardah-writer](https://github.com/konten-studio/jekardah-writer).

Tambahan sendiri: pola slop Bahasa Indonesia (", menciptakan …" tack-on, hiruk pikuk, campur register), test lazy, kalibrasi gaya kerja.

## Pasang

Claude Code:
```
cp -r lazy-writing ~/.claude/skills/
```
atau project-scoped: `cp -r lazy-writing <repo>/.claude/skills/`

Codex: `cp -r lazy-writing <repo>/.codex/skills/`

## Test Lazy

Tanya per kalimat: *kalau gw hapus, apa yang hilang?* Jawabannya "nggak ada" → hapus.

MIT.
