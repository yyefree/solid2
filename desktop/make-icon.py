#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 Solid2 桌面版图标（零第三方依赖）。

产物：desktop/icon.png（256×256，窗口图标）、desktop/icon.ico（含多尺寸，exe 图标）。
画法：圆角矩形 + 对角渐变底，上面一个**等轴测线框立方体**（CAD 辨识度）。
用 4× 超采样 + 盒式降采样做抗锯齿；PNG 用 zlib 手写，ICO 直接内嵌 PNG（Vista+ 支持）。
"""
import math
import os
import struct
import zlib

SIZE = 256          # 最终边长
SS = 4              # 超采样倍数
N = SIZE * SS       # 光栅化分辨率

BG_TOP = (79, 70, 229)     # indigo-600
BG_BOT = (14, 165, 233)    # sky-500
FG = (255, 255, 255)       # 立方体线框


def _rounded_rect_coverage(x, y, w, h, r):
    """点 (x,y) 是否在圆角矩形内（硬判定，靠降采样做抗锯齿）。"""
    if x < 0 or y < 0 or x >= w or y >= h:
        return False
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    dx = x - cx
    dy = y - cy
    return dx * dx + dy * dy <= r * r


def render():
    r = int(N * 0.22)  # 圆角半径
    # 背景：圆角矩形 + 对角渐变
    bg = bytearray(N * N * 3)
    for y in range(N):
        ty = y / (N - 1)
        for x in range(N):
            if not _rounded_rect_coverage(x + 0.5, y + 0.5, N, N, r):
                continue
            # 对角渐变（左上 → 右下），再混一点垂直分量
            t = 0.55 * ((x / (N - 1)) + (y / (N - 1))) / 2 + 0.45 * ty
            i = (y * N + x) * 3
            bg[i] = int(BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t)
            bg[i + 1] = int(BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t)
            bg[i + 2] = int(BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t)

    # ---- 等轴测投影：把 3D 立方体顶点投到屏幕 ----
    c30, s30 = math.cos(math.radians(30)), math.sin(math.radians(30))
    u = N * 0.175  # 半边长（屏幕单位）

    def proj(p):
        x, y, z = p
        sx = (x - z) * c30
        sy = (x + z) * s30 - y
        return (N / 2 + sx * u, N / 2 - sy * u)

    V = {}
    for x in (-1, 1):
        for y in (-1, 1):
            for z in (-1, 1):
                V[(x, y, z)] = proj((x, y, z))

    edges = []
    for a in V:
        for b in V:
            if a >= b:
                continue
            diff = sum(1 for i in range(3) if a[i] != b[i])
            if diff == 1:  # 相邻顶点 = 一条棱
                edges.append((V[a], V[b]))

    # ---- 画线（按线段包围盒逐像素算距离）----
    thick = N * 0.030
    half = thick / 2.0
    for (x1, y1), (x2, y2) in edges:
        x0 = max(0, int(min(x1, x2) - half - 1))
        x3 = min(N - 1, int(max(x1, x2) + half + 1))
        y0 = max(0, int(min(y1, y2) - half - 1))
        y3 = min(N - 1, int(max(y1, y2) + half + 1))
        dx, dy = x2 - x1, y2 - y1
        seg2 = dx * dx + dy * dy
        for py in range(y0, y3 + 1):
            for px in range(x0, x3 + 1):
                fx, fy = px + 0.5, py + 0.5
                t = 0.0 if seg2 == 0 else ((fx - x1) * dx + (fy - y1) * dy) / seg2
                t = 0.0 if t < 0 else (1.0 if t > 1 else t)
                qx, qy = x1 + t * dx, y1 + t * dy
                ddx, ddy = fx - qx, fy - qy
                if ddx * ddx + ddy * ddy <= half * half:
                    i = (py * N + px) * 3
                    bg[i] = FG[0]
                    bg[i + 1] = FG[1]
                    bg[i + 2] = FG[2]
    return bg


def downsample(buf):
    out = bytearray(SIZE * SIZE * 3)
    k = SS * SS
    for y in range(SIZE):
        for x in range(SIZE):
            r = g = b = 0
            for sy in range(SS):
                row = ((y * SS + sy) * N + x * SS) * 3
                for sx in range(SS):
                    i = row + sx * 3
                    r += buf[i]
                    g += buf[i + 1]
                    b += buf[i + 2]
            o = (y * SIZE + x) * 3
            out[o] = r // k
            out[o + 1] = g // k
            out[o + 2] = b // k
    return out


def png_encode(w, h, rgb):
    raw = bytearray()
    stride = w * 3
    for y in range(h):
        raw.append(0)  # filter type 0
        raw += rgb[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag, data):
        body = tag + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)  # 8bit truecolor
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', comp) + chunk(b'IEND', b''))


def ico_encode(entries):
    """entries: [(size, png_bytes), ...]，PNG 内嵌 ICO（Vista+）。"""
    out = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    dirs = b''
    for size, data in entries:
        w = 0 if size >= 256 else size
        dirs += struct.pack('<BBBBHHII', w, w, 0, 0, 1, 32, len(data), offset)
        offset += len(data)
    return out + dirs + b''.join(d for _, d in entries)


def box_filter(rgb, src_size, dst_size):
    """把 src_size 方形降采样到 dst_size（用于 ICO 的小尺寸）。"""
    if src_size == dst_size:
        return rgb
    out = bytearray(dst_size * dst_size * 3)
    k = src_size // dst_size
    for y in range(dst_size):
        for x in range(dst_size):
            r = g = b = 0
            for sy in range(k):
                row = ((y * k + sy) * src_size + x * k) * 3
                for sx in range(k):
                    i = row + sx * 3
                    r += rgb[i]
                    g += rgb[i + 1]
                    b += rgb[i + 2]
            o = (y * dst_size + x) * 3
            out[o] = r // (k * k)
            out[o + 1] = g // (k * k)
            out[o + 2] = b // (k * k)
    return out


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    print(f'光栅化 {N}×{N}（{SS}× 超采样）…')
    big = downsample(render())

    png = png_encode(SIZE, SIZE, big)
    with open(os.path.join(here, 'icon.png'), 'wb') as f:
        f.write(png)
    print(f'✓ icon.png  {len(png)} 字节')

    entries = [(SIZE, png)]
    for s in (128, 64, 48, 32, 16):
        entries.append((s, png_encode(s, s, box_filter(big, SIZE, s))))
    ico = ico_encode(entries)
    with open(os.path.join(here, 'icon.ico'), 'wb') as f:
        f.write(ico)
    print(f'✓ icon.ico  {len(ico)} 字节（{len(entries)} 个尺寸）')


if __name__ == '__main__':
    main()
