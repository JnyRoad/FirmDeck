#!/usr/bin/env python3
"""Generate a lightweight StaffDeck DMG background without external deps."""

from __future__ import annotations

import math
import struct
import sys
import zlib
from pathlib import Path


WIDTH = 640
HEIGHT = 360


def _mix(a: int, b: int, t: float) -> int:
    return round(a + (b - a) * t)


def _inside_round_rect(x: int, y: int, left: int, top: int, right: int, bottom: int, radius: int) -> bool:
    if left + radius <= x <= right - radius and top <= y <= bottom:
        return True
    if left <= x <= right and top + radius <= y <= bottom - radius:
        return True
    for cx, cy in (
        (left + radius, top + radius),
        (right - radius, top + radius),
        (left + radius, bottom - radius),
        (right - radius, bottom - radius),
    ):
        if (x - cx) * (x - cx) + (y - cy) * (y - cy) <= radius * radius:
            return True
    return False


def _blend(pixel: tuple[int, int, int, int], color: tuple[int, int, int], alpha: float) -> tuple[int, int, int, int]:
    r, g, b, a = pixel
    cr, cg, cb = color
    return (_mix(r, cr, alpha), _mix(g, cg, alpha), _mix(b, cb, alpha), a)


def _distance_to_segment(px: float, py: float, ax: float, ay: float, bx: float, by: float) -> float:
    vx = bx - ax
    vy = by - ay
    wx = px - ax
    wy = py - ay
    length_sq = vx * vx + vy * vy
    if length_sq == 0:
        return math.hypot(px - ax, py - ay)
    t = max(0.0, min(1.0, (wx * vx + wy * vy) / length_sq))
    cx = ax + t * vx
    cy = ay + t * vy
    return math.hypot(px - cx, py - cy)


def _inside_triangle(px: float, py: float, points: tuple[tuple[float, float], ...]) -> bool:
    (x1, y1), (x2, y2), (x3, y3) = points
    d1 = (px - x2) * (y1 - y2) - (x1 - x2) * (py - y2)
    d2 = (px - x3) * (y2 - y3) - (x2 - x3) * (py - y3)
    d3 = (px - x1) * (y3 - y1) - (x3 - x1) * (py - y1)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def generate(path: Path) -> None:
    pixels: list[tuple[int, int, int, int]] = []
    arrow_color = (71, 96, 132)
    arrow = ((270.0, 179.0), (372.0, 179.0))
    arrow_head = ((372.0, 179.0), (350.0, 164.0), (350.0, 194.0))

    for y in range(HEIGHT):
        y_t = y / max(HEIGHT - 1, 1)
        for x in range(WIDTH):
            x_t = x / max(WIDTH - 1, 1)
            base = (
                _mix(248, 239, y_t),
                _mix(250, 244, y_t),
                _mix(252, 248, y_t),
                255,
            )

            # Soft left/right installation zones behind Finder icons.
            for left, top, right, bottom in ((74, 77, 286, 273), (354, 77, 566, 273)):
                if _inside_round_rect(x, y, left, top, right, bottom, 22):
                    base = _blend(base, (255, 255, 255), 0.70)
                if _inside_round_rect(x, y, left, top, right, bottom, 22) and (
                    x in (left, right) or y in (top, bottom)
                ):
                    base = _blend(base, (215, 222, 232), 0.35)

            # Subtle top tint so the Finder title bar does not blend into a blank white sheet.
            if y < 48:
                base = _blend(base, (232, 238, 247), 0.35 * (1 - y / 48))

            distance = _distance_to_segment(x + 0.5, y + 0.5, *arrow[0], *arrow[1])
            if distance <= 3.0:
                base = _blend(base, arrow_color, 0.55)
            if _inside_triangle(x + 0.5, y + 0.5, arrow_head):
                base = _blend(base, arrow_color, 0.55)

            # A quiet blue accent in the lower edge, kept away from labels/icons.
            if y > 310:
                base = _blend(base, (58, 118, 197), 0.06 * ((y - 310) / 50))
            if x_t > 0.62 and y_t > 0.70:
                base = _blend(base, (0, 178, 191), 0.025 * (x_t - 0.62) * (y_t - 0.70) * 8)

            pixels.append(base)

    raw = bytearray()
    for y in range(HEIGHT):
        raw.append(0)
        row = pixels[y * WIDTH : (y + 1) * WIDTH]
        for r, g, b, a in row:
            raw.extend((r, g, b, a))

    def chunk(kind: bytes, data: bytes) -> bytes:
        return (
            struct.pack(">I", len(data))
            + kind
            + data
            + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", WIDTH, HEIGHT, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(png)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: make_dmg_background.py <output.png>", file=sys.stderr)
        return 2
    generate(Path(sys.argv[1]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
