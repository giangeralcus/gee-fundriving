#!/usr/bin/env python3
"""Generate logo Gee-MiniDrive: mobil & motor 2D flat, dark bg, racing stripe."""
import math

import pygame

pygame.init()
pygame.font.init()


def rounded_rect(surf, color, rect, radius=8):
    pygame.draw.rect(surf, color, rect, border_radius=radius)


def draw_car(surf, cx, cy, scale=1.0, body=(80, 220, 120), dark=(24, 26, 32)):
    """Mobil top-down menghadap kanan."""
    L, Wd = int(120 * scale), int(56 * scale)

    def pt(dx, dy):
        return (cx + dx * scale, cy + dy * scale)

    # body utama (kapsul)
    body_rect = pygame.Rect(0, 0, L, Wd)
    body_rect.center = (cx, cy)
    pygame.draw.rect(surf, body, body_rect, border_radius=Wd // 2)

    # kaca depan & belakang
    glass = (20, 40, 45)
    pygame.draw.rect(surf, glass,
                     pygame.Rect(cx + int(8 * scale), cy - int(14 * scale),
                                 int(26 * scale), int(28 * scale)),
                     border_radius=6)
    pygame.draw.rect(surf, glass,
                     pygame.Rect(cx - int(38 * scale), cy - int(12 * scale),
                                 int(16 * scale), int(24 * scale)),
                     border_radius=5)

    # racing stripe
    stripe = (245, 245, 245)
    pygame.draw.rect(surf, stripe,
                     pygame.Rect(cx - L // 2 + int(10 * scale), cy - int(3 * scale),
                                 L - int(20 * scale), int(6 * scale)),
                     border_radius=3)

    # roda
    wheel = (18, 18, 20)
    for sx in (-1, 1):
        for sy in (-1, 1):
            wr = pygame.Rect(0, 0, int(18 * scale), int(9 * scale))
            wr.center = (cx + sx * int(34 * scale), cy + sy * int(Wd // 2))
            pygame.draw.rect(surf, wheel, wr, border_radius=4)

    # lampu depan
    head = (255, 230, 120)
    pygame.draw.circle(surf, head, (cx + L // 2 - int(6 * scale), cy - int(14 * scale)),
                       int(4 * scale))
    pygame.draw.circle(surf, head, (cx + L // 2 - int(6 * scale), cy + int(14 * scale)),
                       int(4 * scale))


def draw_motor(surf, cx, cy, scale=1.0, body=(255, 150, 60)):
    """Motor top-down menghadap kanan."""
    # bodi
    pygame.draw.rect(surf, body,
                     pygame.Rect(cx - int(26 * scale), cy - int(12 * scale),
                                 int(56 * scale), int(24 * scale)),
                     border_radius=10)
    # jok
    pygame.draw.rect(surf, (40, 40, 46),
                     pygame.Rect(cx - int(30 * scale), cy - int(8 * scale),
                                 int(28 * scale), int(16 * scale)),
                     border_radius=7)
    # stang
    pygame.draw.line(surf, (120, 124, 132),
                     (cx + int(24 * scale), cy),
                     (cx + int(34 * scale), cy - int(16 * scale)), int(4 * scale))
    pygame.draw.line(surf, (120, 124, 132),
                     (cx + int(24 * scale), cy),
                     (cx + int(34 * scale), cy + int(16 * scale)), int(4 * scale))
    # roda
    wheel = (18, 18, 20)
    pygame.draw.circle(surf, wheel, (cx - int(34 * scale), cy), int(13 * scale))
    pygame.draw.circle(surf, wheel, (cx + int(38 * scale), cy), int(13 * scale))
    pygame.draw.circle(surf, (90, 94, 104), (cx - int(34 * scale), cy), int(5 * scale))
    pygame.draw.circle(surf, (90, 94, 104), (cx + int(38 * scale), cy), int(5 * scale))


def make_logo(size, out, mode="both"):
    surf = pygame.Surface((size, size), pygame.SRCALPHA)
    # bg dark rounded square
    pygame.draw.rect(surf, (30, 32, 40), pygame.Rect(0, 0, size, size), border_radius=size // 5)
    # inner track ring hint
    pygame.draw.ellipse(surf, (48, 52, 62),
                        pygame.Rect(size // 10, size // 5, size * 8 // 10, size * 6 // 10),
                        width=max(4, size // 30))
    if mode == "car":
        draw_car(surf, size // 2, size // 2, scale=size / 160)
    elif mode == "motor":
        draw_motor(surf, size // 2, size // 2, scale=size / 160)
    else:
        draw_car(surf, size // 2, size // 2 - size // 7, scale=size / 210)
        draw_motor(surf, size // 2 + size // 24, size // 2 + size // 4.4, scale=size / 230)

    # teks kecil di bawah
    try:
        font = pygame.font.SysFont("dejavusansbold", max(12, size // 9))
        txt = font.render("GEE-MINIDRIVE", True, (235, 235, 235))
        surf.blit(txt, txt.get_rect(center=(size // 2, size - size // 9)))
        font2 = pygame.font.SysFont("dejavusansbold", max(10, size // 14))
        txt2 = font2.render("- AUTONOMOUS -", True, (120, 200, 255))
        surf.blit(txt2, txt2.get_rect(center=(size // 2, size - size // 26)))
    except Exception:
        pass
    pygame.image.save(surf, out)
    print("saved", out)


if __name__ == "__main__":
    import sys
    base = "assets"
    os.makedirs(base, exist_ok=True) if (os := __import__("os")) else None
    make_logo(512, f"{base}/logo-car.png", "car")
    make_logo(512, f"{base}/logo-motor.png", "motor")
    make_logo(512, f"{base}/logo-both.png", "both")
    make_logo(256, f"{base}/icon-256.png", "car")
