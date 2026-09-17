// Test headless logika game.js: dunia kebentuk, mobil jalan, misi selesai.
// Runner: gabungkan map + game + body (test_body.js) jadi satu script.
"use strict";
const fs = require("fs");
const path = require("path");
const dir = __dirname;
const combined =
  fs.readFileSync(path.join(dir, "map_loop_city.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(dir, "game.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(dir, "test_body.js"), "utf8");
const tmp = path.join(dir, "._combined_test.js");
fs.writeFileSync(tmp, combined);
require(tmp);
