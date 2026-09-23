from PIL import Image

im = Image.open('/tmp/wd2_screen.png')
tiles = {
    'topleft': (126, 174, 972, 682),
    'topright': (1058, 174, 1904, 682),
    'bottomleft': (126, 726, 972, 1234),
    'bottomright': (1058, 726, 1904, 1234),
}
for k, (l, t, r, b) in tiles.items():
    l2, t2, r2, b2 = min(l, r), min(t, b), max(l, r), max(t, b)
    r2 = min(r2, im.width)
    b2 = min(b2, im.height)
    c = im.crop((l2, t2, r2, b2))
    print(k, c.size)
