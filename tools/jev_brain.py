"""Otak Jev live buat Gee-FunDriving (TypeSafe System One).

Pola sesuai skill typesafe-ai: kode pegang workflow + eksekusi halus,
Jev cuma kasih judgment terstruktur (Choice maneuver + Noul rem darurat).
Jev lambat (~1 dtk) dibanding game loop (60fps) -> keputusan di-cache
tiap `every` frame, diantaranya aksi terakhir ditahan (zero-order hold).
API down/lambat -> fallback ke brain rule-based yang dioper dari luar.

Pakai:  from tools.jev_brain import JevBrain
        jev = JevBrain(fallback=map_brain, every=45)
        steer, thr, brk, dec = jev.decide(state, fi)
"""
import os
import time

try:
    from typesafe_sdk import TypeSafeClient, Choice, Noul
    _SDK = True
except ImportError:
    _SDK = False

HERMES_ENV = os.path.expanduser("~/.hermes/profiles/bakasang/.env")


def _load_key():
    if os.environ.get("TYPESAFE_API_KEY"):
        return True
    try:
        with open(HERMES_ENV) as f:
            for line in f:
                if line.strip().startswith("TYPESAFE_API_KEY="):
                    os.environ["TYPESAFE_API_KEY"] = line.strip().split("=", 1)[1].strip()
                    return True
    except OSError:
        pass
    return False


class JevBrain:
    def __init__(self, fallback, every=45, timeout=20):
        self.fallback = fallback
        self.every = every
        self.timeout = timeout
        self.client = None
        self.err = None
        self.cand_dbg = []  # kompatibel render planner (Jev tak sampling kandidat)
        self.calls = 0
        self.fallbacks = 0
        self.lat_ms = []
        self._hold = None
        if _SDK and _load_key():
            try:
                self.client = TypeSafeClient(timeout=timeout)
            except Exception as e:
                self.err = repr(e)[:120]

    @property
    def live(self):
        return self.client is not None

    def _ask(self, s):
        return self.client.system_one(
            state={
                "depan_m": round(s["f"], 1),
                "kiri_m": round(s["fl"], 1),
                "kanan_m": round(s["fr"], 1),
                "heading_err_deg": round(s["heading_err"], 1),
                "lateral_m": round(s["lateral"], 1),
                "speed_norm": round(s.get("speed_norm", 0.5), 2),
                "jarak_mobil_depan_m": (None if s.get("ahead_gap") is None
                                        else round(s["ahead_gap"], 1)),
            },
            questions={
                "manuver": Choice(
                    instructions="Pilih SATU manuver nächste detik untuk mobil di jalan ini",
                    criteria={"lurus": "jalur depan lapang, pertahankan arah",
                              "kiri": "belok/geser kiri menghindari halangan atau ikut tikungan",
                              "kanan": "belok/geser kanan menghindari halangan atau ikut tikungan",
                              "rem": "bahaya dekat di depan, harus melambat/berhenti"}),
                "darurat": Noul(
                    instructions="Perlu rem darurat SEKARANG (tabrakan < 2 detik kalau tidak rem)"),
            })

    def drive(self, car, state, fi):
        """Interface planner upstream: putuskan dari state (car tak dipakai)."""
        steer, thr, brk, dec = self.decide(state, fi)
        dec.setdefault("man", dec.get("manuver", "-"))
        dec.setdefault("src", "jev" if dec.get("brain") == "jev" else "rule")
        return steer, thr, brk, dec

    def decide(self, state, fi):
        if self.client is None or fi % self.every != 0:
            if self._hold is not None and self.client is not None:
                st, th, br, dec = self._hold
                return st, th, br, dict(dec, brain="jev-hold")
            steer, thr, brk, dec = self.fallback(state)
            dec["brain"] = "fallback" if self.client else "no-key"
            return steer, thr, brk, dec
        t0 = time.time()
        try:
            r = self._ask(state)
            self.calls += 1
            self.lat_ms.append((time.time() - t0) * 1000)
            man = r.choices["manuver"].choice
            conf = r.choices["manuver"].confidence
            emg = r.nouls["darurat"].noul
            he = state["heading_err"]
            if man == "kiri":
                steer, thr, brk = -0.7, 0.5, 0.0
            elif man == "kanan":
                steer, thr, brk = 0.7, 0.5, 0.0
            elif man == "rem":
                steer, thr, brk = max(-0.5, min(0.5, he / 40.0)), 0.0, 0.8
            else:
                steer, thr, brk = max(-1.0, min(1.0, he / 40.0)), 0.7, 0.0
            if emg > 0.7:
                thr, brk = 0.0, 1.0
            dec = {"brain": "jev", "manuver": man, "conf": round(conf, 2),
                   "darurat": round(emg, 2),
                   "lat_ms": round(self.lat_ms[-1]),
                   "calls": self.calls, "fallbacks": self.fallbacks}
            self._hold = (steer, thr, brk, dec)
            return steer, thr, brk, dec
        except Exception as e:
            self.fallbacks += 1
            steer, thr, brk, dec = self.fallback(state)
            dec["brain"] = "jev-fallback"
            dec["jev_err"] = type(e).__name__
            self._hold = (steer, thr, brk, dec)
            return steer, thr, brk, dec
