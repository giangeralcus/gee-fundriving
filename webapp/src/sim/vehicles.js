// Katalog kendaraan hero — spesifikasi fisika 1:1 (meter, m/s, derajat).
// wheelbase + steerMax nentuin radius putar minimal: R = wheelbase / tan(steerMax).
// Angka citycar = kontrak fisika lama (MapCar.MAXV 11.1 dst) biar benchmark
// historis tetap comparable; bus = kendaraan besar yang beneran beda rasa.

export const VEHICLES = {
  citycar: {
    key: "citycar", label: "City Car",
    len: 4.6, wid: 1.85, wheelbase: 2.7, steerMax: 30,   // R min ≈ 4.7 m
    maxv: 11.1, acc: 2.2, brake: 7.5,
    roll: 0.15, drag: 0.0025,   // hambatan jalan (m/s² + v² koef) — pelan tanpa gas
    color: null,   // null = warna hero bawaan scene
  },
  bus: {
    key: "bus", label: "Bus",
    len: 11.5, wid: 2.5, wheelbase: 6.2, steerMax: 34,   // R min ≈ 9.2 m (bus kota beneran)
    maxv: 8.5, acc: 0.95, brake: 4.8,
    roll: 0.28, drag: 0.0030,   // bus: rolling resistance lebih berat
    color: 0xe8912a,
  },
};

export const getVehicle = (k) => VEHICLES[k] || VEHICLES.citycar;
