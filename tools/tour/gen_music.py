#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
优雅舒缓的 CAD 演示背景音乐生成器（纯 numpy 合成，无需外部音源）。
风格：温暖的 C 大调氛围（Pad + 马林巴琶音 + 低频贝斯 + 稀疏钟琴旋律 + 空间延迟）。
输出 16-bit PCM WAV，时长默认 240s —— 覆盖所有巡演视频（最长 ~227s），用 -shortest 裁切，
因此整段无循环拼接，听感连贯。

用法:
    python tools/tour/gen_music.py [时长秒] [输出.wav]
"""
import sys
import wave
import math
import numpy as np

SR = 44100
DUR = float(sys.argv[1]) if len(sys.argv) > 1 else 240.0
OUT = sys.argv[2] if len(sys.argv) > 2 else "videos/sw-bgm.wav"

N = int(SR * DUR)
L = np.zeros(N, np.float64)
R = np.zeros(N, np.float64)


def midi(m):
    return 440.0 * (2.0 ** ((m - 69) / 12.0))


def pan_gains(p):
    th = (p + 1) * math.pi / 4.0  # p in [-1,1]
    return math.cos(th), math.sin(th)


def add(sig, start_s, pan=0.0):
    i = int(start_s * SR)
    j = min(N, i + len(sig))
    if j <= i:
        return
    s = sig[: j - i]
    gl, gr = pan_gains(pan)
    L[i:j] += s * gl
    R[i:j] += s * gr


def ramp(t, a, r):
    env = np.ones_like(t)
    na = max(1, int(a * SR))
    nr = max(1, int(r * SR))
    if na > 0:
        env[:na] *= np.linspace(0, 1, na)
    if nr > 0:
        env[-nr:] *= np.linspace(1, 0, nr)
    return env


def pad(freqs, dur, amps, start_s, pan=0.0):
    n = int(dur * SR)
    if n <= 0:
        return
    t = np.arange(n) / SR
    env = ramp(t, 0.7, 0.9)
    # 轻微振幅脉动，呼吸感
    lfo = 0.9 + 0.1 * np.sin(2 * math.pi * 0.12 * t)
    sig = np.zeros(n)
    for f, a in zip(freqs, amps):
        w = a * (np.sin(2 * math.pi * f * t) + 0.28 * np.sin(2 * math.pi * 2 * f * t + 1.0))
        sig += w
    sig *= env * lfo
    add(sig / (len(freqs) ** 0.5) * 0.12, start_s, pan)


def pluck(freq, start_s, amp=0.5, decay=3.2, pan=0.0, bell=0.0):
    dur = min(2.4, 4.0 / decay + 1.0)
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.exp(-t * decay)
    natt = max(1, int(0.006 * SR))
    env[:natt] *= np.linspace(0, 1, natt)
    w = (np.sin(2 * math.pi * freq * t)
         + 0.22 * np.sin(2 * math.pi * 2 * freq * t)
         + 0.10 * np.sin(2 * math.pi * 3 * freq * t)
         + bell * 0.16 * np.sin(2 * math.pi * 4.01 * freq * t))
    add(w * env * amp * 0.5, start_s, pan)


def bass(freq, start_s, dur, amp=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    env = np.exp(-t * 0.7)
    env *= ramp(t, 0.05, 0.4)
    w = np.sin(2 * math.pi * freq * t) + 0.2 * np.sin(2 * math.pi * 2 * freq * t)
    add(w * env * amp * 0.16, start_s, 0.0)


# ---- 和弦进行（C 大调，爵士味 7/9 和弦）：根 / Pad 音集 / 时长 ----
PROG = [
    ("C", [36, 60, 64, 67, 71, 74], 10.0),
    ("Am", [33, 57, 60, 64, 67, 71], 10.0),
    ("F", [29, 53, 57, 60, 64, 67], 10.0),
    ("G", [31, 50, 55, 59, 62, 65], 10.0),
]
PROG_DUR = sum(c[2] for c in PROG)  # 40s

# ---- 一段五声音阶钟琴旋律（C 大调宫调式：C D E G A），放在每 10s 和弦内 ----
MELODY = [
    (0.05, 72), (1.2, 74), (2.4, 76), (3.6, 74), (4.8, 72), (6.0, 69), (7.2, 67),
    (9.0 + 0.05, 74), (9.0 + 1.2, 76), (9.0 + 2.4, 79), (9.0 + 3.6, 76), (9.0 + 4.8, 74), (9.0 + 6.0, 72), (9.0 + 7.2, 74),
    (18.0 + 0.05, 72), (18.0 + 1.2, 69), (18.0 + 2.4, 67), (18.0 + 3.6, 64), (18.0 + 5.0, 69), (18.0 + 6.4, 72),
    (27.0 + 0.05, 71), (27.0 + 1.2, 74), (27.0 + 2.4, 72), (27.0 + 3.6, 67), (27.0 + 5.0, 69), (27.0 + 6.4, 71),
]

ARP = [0, 2, 3, 4, 3, 2, 1, 0, 2, 4, 5, 4, 3, 2]  # 在 pad 音集内的琶音走位

t = 0.0
loop = 0
while t < DUR - 0.5:
    intensity = 1.0 - 0.45 * ((loop // 2) % 2)  # 交替浓/淡，制造推进感
    oct_shift = 0 if loop % 3 else 12           # 每 3 段给旋律换个八度
    arp_start = 36.0 + 7.0 * loop               # 琶音随段落缓慢移调（大二度近关系，保持悦耳）
    for (name, notes, cdur) in PROG:
        if t >= DUR - 0.5:
            break
        # 贝斯：和弦根，低八度
        bass(midi(notes[0] - 12), t, min(cdur, 2.6))
        # Pad：和弦主体
        fs = [midi(x) for x in notes[1:]]
        as_ = [1.0, 0.8, 0.6, 0.45, 0.3][: len(fs)]
        pad(fs, min(cdur, DUR - t), as_, t, 0.0)
        # 琶音：第 4、6、7、8 个八分点轻微落下（马林巴感），按时强循环
        st = 0.25 + arp_start
        while st < cdur - 0.2 and t + st < DUR - 0.3:
            idx = int((st * 4) % len(ARP))
            m = notes[1 + (ARP[idx] % (len(notes) - 1))]
            pl = (-1.0) ** int(st * 4 % 2)
            pluck(midi(m + 12), t + st, amp=0.34 * intensity, decay=2.6, pan=0.25 * pl)
            if int(st * 4) % 4 == 0:
                bass(midi(notes[0] - 12), t + st, 1.2, amp=0.28 * intensity)
            st += 0.25
        t += cdur
    # 旋律：每段和弦播一次钟琴，随段落换八度
    for (off, m) in MELODY:
        if t - PROG_DUR + off < DUR - 0.5:
            pluck(midi(m + oct_shift), t - PROG_DUR + off, amp=0.20, decay=2.0, pan=0.5, bell=1.0)
    loop += 1

# ---- 空间感：给左右各做一点阻尼反馈延迟（伪混响）----
def reverb(buf):
    out = buf.copy()
    for (d, g, pan) in [(0.09, 0.28, -0.5), (0.14, 0.2, 0.5), (0.23, 0.12, -0.3), (0.33, 0.07, 0.3)]:
        ds = int(d * SR)
        tap = np.zeros_like(buf)
        tap[ds:] = buf[:-ds] * g
        out = out + tap
    return out


L = reverb(L)
R = reverb(R)

# ---- 母带：限幅 + 起/落淡入淡出 ----
peak = max(1e-6, np.max(np.abs(L)), np.max(np.abs(R)))
g = min(1.0, 0.85 / peak)
L *= g
R *= g

fi = int(2.0 * SR)  # 2s 淡入
fo = int(6.0 * SR)  # 6s 淡出
if fi < N:
    L[:fi] *= np.linspace(0, 1, fi)
    R[:fi] *= np.linspace(0, 1, fi)
if fo < N:
    L[-fo:] *= np.linspace(1, 0, fo)
    R[-fo:] *= np.linspace(1, 0, fo)

stereo = np.empty(N * 2, np.float64)
stereo[0::2] = L
stereo[1::2] = R
pcm = np.clip(stereo, -1, 1)
pcm16 = (pcm * 32767.0).astype(np.int16)

import os
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes(pcm16.tobytes())
print(f"OK wrote {OUT}  {DUR:.1f}s  {os.path.getsize(OUT)/1e6:.1f} MB")
