#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
给 Windows PE 可执行文件写入自定义图标 —— 纯标准库实现，零第三方依赖。

为什么自己写？
    electron-builder / rcedit 都要从 GitHub Releases 下载二进制，本机网络拿不到。
    而「换 exe 图标」本质上只是往 PE 的**资源段**里塞 RT_ICON(3) + RT_GROUP_ICON(14)
    两组数据 —— 用 Python 的 struct 就能做完，不需要任何外部工具。

做法（安全优先）：
    1. 解析 exe 里**已有**的资源树（清单、版本信息、字符串表…）并完整保留；
    2. 只把原有的 RT_ICON / RT_GROUP_ICON 换成我们的；
    3. 重建后的资源树放进一个**新追加的 PE 节**，改掉数据目录项指向它。
       —— 原有 .rsrc 节原封不动，所以即使新节有问题，旧数据也没被破坏。

用法：
    python desktop/patch-exe-icon.py <目标.exe> <图标.ico>
"""

import os
import struct
import sys

RT_ICON = 3
RT_GROUP_ICON = 14


# ------------------------------------------------------------------ 小工具

def u16(b, o):
    return struct.unpack_from('<H', b, o)[0]


def u32(b, o):
    return struct.unpack_from('<I', b, o)[0]


def align(n, a):
    return (n + a - 1) // a * a


def sort_key(k):
    """数字 ID 在前并升序，字符串名在后 —— 与原版 Windows 资源工具一致。"""
    return (1, k) if isinstance(k, str) else (0, k)


# ------------------------------------------------------------------ ICO 解析

def parse_ico(buf):
    """解析 .ico，返回每个图像的元数据与原始数据块（可能是 PNG 或 BMP）。"""
    reserved, kind, count = struct.unpack_from('<HHH', buf, 0)
    if reserved != 0 or kind != 1:
        raise ValueError('不是合法的 ICO 文件')
    images = []
    for i in range(count):
        o = 6 + 16 * i
        w, h, colors, _res, planes, bits, size, off = struct.unpack_from(
            '<BBBBHHII', buf, o)
        if off + size > len(buf):
            raise ValueError('ICO 第 %d 个图像数据越界' % i)
        images.append(dict(
            w=w, h=h, colors=colors,
            planes=planes or 1, bits=bits or 32,
            size=size, data=buf[off:off + size],
        ))
    return images


def build_group_icon(images, ids):
    """构造 GRPICONDIR —— 即 RT_GROUP_ICON 资源的内容。"""
    out = struct.pack('<HHH', 0, 1, len(images))
    for img, i in zip(images, ids):
        out += struct.pack(
            '<BBBBHHIH',
            img['w'], img['h'], img['colors'], 0,
            img['planes'], img['bits'], img['size'], i,
        )
    return out


# ------------------------------------------------------------------ PE 解析

def parse_pe(buf):
    if buf[:2] != b'MZ':
        raise ValueError('不是 PE 文件（缺少 MZ 头）')
    e_lfanew = u32(buf, 0x3C)
    if buf[e_lfanew:e_lfanew + 4] != b'PE\0\0':
        raise ValueError('不是 PE 文件（缺少 PE 签名）')

    coff = e_lfanew + 4
    nsec = u16(buf, coff + 2)
    size_opt = u16(buf, coff + 16)
    opt = coff + 20
    pe32plus = u16(buf, opt) == 0x20B

    secs = []
    for i in range(nsec):
        so = opt + size_opt + 40 * i
        secs.append(dict(
            index=i, hdr=so,
            name=buf[so:so + 8].rstrip(b'\0').decode('latin1', 'replace'),
            vsize=u32(buf, so + 8), vaddr=u32(buf, so + 12),
            rawsize=u32(buf, so + 16), rawptr=u32(buf, so + 20),
            chars=u32(buf, so + 36),
        ))

    return dict(
        e_lfanew=e_lfanew, coff=coff, nsec=nsec, size_opt=size_opt, opt=opt,
        pe32plus=pe32plus, dd_off=opt + (112 if pe32plus else 96),
        sections_off=opt + size_opt, secs=secs,
        section_align=u32(buf, opt + 32),
        file_align=u32(buf, opt + 36),
        size_of_image=u32(buf, opt + 56),
        checksum_off=opt + 64,
    )


def make_rva2off(pe):
    def conv(rva):
        for s in pe['secs']:
            span = max(s['vsize'], s['rawsize'])
            if s['vaddr'] <= rva < s['vaddr'] + span:
                return s['rawptr'] + (rva - s['vaddr'])
        raise ValueError('RVA 0x%x 不属于任何节' % rva)
    return conv


# ------------------------------------------------------- 资源树解析 / 重建

def _read_dir(buf, base, off):
    """读一个 IMAGE_RESOURCE_DIRECTORY，返回 [(name, offset_to_data)]。"""
    n_named, n_id = struct.unpack_from('<HH', buf, base + off + 12)
    entries = []
    p = base + off + 16
    for _ in range(n_named + n_id):
        name_val, off_val = struct.unpack_from('<II', buf, p)
        p += 8
        if name_val & 0x80000000:
            so = base + (name_val & 0x7FFFFFFF)
            ln = u16(buf, so)
            name = buf[so + 2:so + 2 + 2 * ln].decode('utf-16-le', 'replace')
        else:
            name = name_val
        entries.append((name, off_val))
    return entries


def parse_resource_tree(buf, pe, rsrc_rva):
    """把资源树读成 {type: {name: {lang: bytes}}}，保持文件里的原顺序。"""
    conv = make_rva2off(pe)
    base = conv(rsrc_rva)
    tree = {}
    for t_name, t_off in _read_dir(buf, base, 0):
        if not (t_off & 0x80000000):
            continue
        names = {}
        for n_name, n_off in _read_dir(buf, base, t_off & 0x7FFFFFFF):
            if not (n_off & 0x80000000):
                continue
            langs = {}
            for l_name, l_off in _read_dir(buf, base, n_off & 0x7FFFFFFF):
                if l_off & 0x80000000:
                    continue
                rva, size, _cp, _r = struct.unpack_from('<IIII', buf, base + l_off)
                at = conv(rva)
                langs[l_name] = buf[at:at + size]
            names[n_name] = langs
        tree[t_name] = names
    return tree


def build_resource_section(tree, section_rva):
    """把 {type: {name: {lang: bytes}}} 序列化成一个完整资源段（RVA 已回填）。"""
    types = sorted(tree.keys(), key=sort_key)
    names_of = {t: sorted(tree[t].keys(), key=sort_key) for t in types}
    langs_of = {
        (t, n): sorted(tree[t][n].keys(), key=sort_key)
        for t in types for n in names_of[t]
    }

    # ---- 第一趟：分配偏移
    off = 16 + 8 * len(types)          # 根目录
    type_dir_off = {}
    for t in types:
        type_dir_off[t] = off
        off += 16 + 8 * len(names_of[t])

    name_dir_off = {}
    for t in types:
        for n in names_of[t]:
            name_dir_off[(t, n)] = off
            off += 16 + 8 * len(langs_of[(t, n)])

    data_entry_off = {}
    for t in types:
        for n in names_of[t]:
            for l in langs_of[(t, n)]:
                data_entry_off[(t, n, l)] = off
                off += 16

    # 字符串池（本应用资源全是数字 ID，留全可能性）
    str_off = {}
    for t in types:
        for n in names_of[t]:
            if isinstance(n, str) and n not in str_off:
                str_off[n] = off
                off += align(2 + 2 * len(n), 4)

    off = align(off, 4)
    blob_off = {}
    for t in types:
        for n in names_of[t]:
            for l in langs_of[(t, n)]:
                blob_off[(t, n, l)] = off
                off += len(tree[t][n][l])
                off = align(off, 4)

    out = bytearray(off)

    # ---- 第二趟：写数据
    def w_dir(at, entries):
        n_named = sum(1 for k, _ in entries if isinstance(k, str))
        struct.pack_into('<IIHHHH', out, at, 0, 0, 0, 0,
                         n_named, len(entries) - n_named)
        p = at + 16
        for k, v in entries:
            if isinstance(k, str):
                struct.pack_into('<II', out, p, 0x80000000 | str_off[k], v)
            else:
                struct.pack_into('<II', out, p, k, v)
            p += 8

    w_dir(0, [(t, 0x80000000 | type_dir_off[t]) for t in types])
    for t in types:
        w_dir(type_dir_off[t],
              [(n, 0x80000000 | name_dir_off[(t, n)]) for n in names_of[t]])
        for n in names_of[t]:
            w_dir(name_dir_off[(t, n)],
                  [(l, data_entry_off[(t, n, l)]) for l in langs_of[(t, n)]])
            for l in langs_of[(t, n)]:
                blob = tree[t][n][l]
                struct.pack_into('<IIII', out, data_entry_off[(t, n, l)],
                                 section_rva + blob_off[(t, n, l)], len(blob), 0, 0)

    for s, at in str_off.items():
        struct.pack_into('<H', out, at, len(s))
        out[at + 2:at + 2 + 2 * len(s)] = s.encode('utf-16-le')

    for t in types:
        for n in names_of[t]:
            for l in langs_of[(t, n)]:
                at = blob_off[(t, n, l)]
                out[at:at + len(tree[t][n][l])] = tree[t][n][l]

    return bytes(out)


# ------------------------------------------------------------------ 校验和

def calc_checksum(buf, chk_off):
    total = 0
    n = len(buf)
    for i in range(0, n - (n % 2), 2):
        if i == chk_off:
            continue
        total += u16(buf, i)
        total = (total & 0xFFFF) + (total >> 16)
    if n % 2:
        total += buf[-1]
        total = (total & 0xFFFF) + (total >> 16)
    total = (total & 0xFFFF) + (total >> 16)
    return (total + n) & 0xFFFFFFFF


# ------------------------------------------------------------------ 主流程

def patch(exe_path, ico_path, out_path=None, lang=1033):
    if out_path is None:
        out_path = exe_path
    with open(exe_path, 'rb') as f:
        buf = bytearray(f.read())
    with open(ico_path, 'rb') as f:
        ico = f.read()

    pe = parse_pe(buf)
    print('  PE: 节数=%d 节对齐=0x%x 文件对齐=0x%x 镜像大小=0x%x'
          % (pe['nsec'], pe['section_align'], pe['file_align'], pe['size_of_image']))

    dd_rsrc = pe['dd_off'] + 2 * 8
    rsrc_rva = u32(buf, dd_rsrc)
    if rsrc_rva == 0:
        tree = {}
        print('  原文件没有资源段，将从零新建')
    else:
        tree = parse_resource_tree(buf, pe, rsrc_rva)
        print('  原有资源类型：%s' % sorted(tree.keys(), key=sort_key))

    # 沿用原来的组图标 ID，Explorer 才会稳定地取到我们的图标
    old_gid = None
    if tree.get(RT_GROUP_ICON):
        old_gid = sorted(tree[RT_GROUP_ICON].keys(), key=sort_key)[0]

    tree.pop(RT_ICON, None)
    tree.pop(RT_GROUP_ICON, None)

    images = parse_ico(ico)
    ids = list(range(1, len(images) + 1))
    gid = old_gid if old_gid is not None else 1

    tree[RT_ICON] = {i: {lang: img['data']} for i, img in zip(ids, images)}
    tree[RT_GROUP_ICON] = {gid: {lang: build_group_icon(images, ids)}}

    sizes = ', '.join('%dx%d' % (im['w'] or 256, im['h'] or 256) for im in images)
    print('  注入图标 %d 个尺寸（%s），组图标 ID=%s%s'
          % (len(images), sizes, gid, '（沿用原 ID）' if old_gid is not None else ''))

    # 新节 RVA 与 body 无关，可以先定下来
    new_rva = align(pe['size_of_image'], pe['section_align'])
    body = build_resource_section(tree, new_rva)

    new_raw = align(len(buf), pe['file_align'])
    raw_size = align(len(body), pe['file_align'])
    new_image_size = new_rva + align(len(body), pe['section_align'])

    hdr_end = pe['sections_off'] + 40 * pe['nsec']
    first_raw = min((s['rawptr'] for s in pe['secs'] if s['rawptr'] > 0), default=len(buf))
    if hdr_end + 40 > first_raw:
        raise RuntimeError('节头表后没有空位放新节头（需 %d，首个节数据在 %d）'
                           % (hdr_end + 40, first_raw))

    # 新节头：.rsrc2，INITIALIZED_DATA | MEM_READ
    struct.pack_into('<8sIIIIIIHHI', buf, hdr_end, b'.rsrc2\0\0',
                     len(body), new_rva, raw_size, new_raw, 0, 0, 0, 0, 0x40000040)
    struct.pack_into('<H', buf, pe['coff'] + 2, pe['nsec'] + 1)
    struct.pack_into('<I', buf, pe['opt'] + 56, new_image_size)
    struct.pack_into('<II', buf, dd_rsrc, new_rva, len(body))

    if len(buf) < new_raw:
        buf += b'\0' * (new_raw - len(buf))
    buf += body
    if len(buf) < new_raw + raw_size:
        buf += b'\0' * (new_raw + raw_size - len(buf))

    struct.pack_into('<I', buf, pe['checksum_off'], 0)
    chk = calc_checksum(buf, pe['checksum_off'])
    struct.pack_into('<I', buf, pe['checksum_off'], chk)

    with open(out_path, 'wb') as f:
        f.write(buf)

    print('  新资源节 .rsrc2 @ RVA 0x%x / 文件偏移 0x%x（%d 字节）'
          % (new_rva, new_raw, len(body)))
    print('  校验和 0x%08x，文件大小 %.1f MB' % (chk, len(buf) / 1024 / 1024))


def verify(exe_path):
    """改完再解析一次，确认资源树自洽、原有资源没丢。"""
    with open(exe_path, 'rb') as f:
        buf = f.read()
    pe = parse_pe(buf)
    dd_rsrc = pe['dd_off'] + 2 * 8
    tree = parse_resource_tree(buf, pe, u32(buf, dd_rsrc))
    kinds = sorted(tree.keys(), key=sort_key)
    icons = sorted(tree.get(RT_ICON, {}).keys(), key=sort_key)
    groups = sorted(tree.get(RT_GROUP_ICON, {}).keys(), key=sort_key)
    print('  复核：资源类型 %s' % kinds)
    print('  复核：RT_ICON %s / RT_GROUP_ICON %s' % (icons, groups))
    print('  复核：版本信息=%s 应用清单=%s 节数=%d'
          % ('有' if 16 in tree else '无',
             '有' if 24 in tree else '无',
             pe['nsec']))
    if not icons or not groups:
        raise RuntimeError('图标资源缺失，改写失败')
    if 24 not in tree:
        raise RuntimeError('应用清单丢了，改写失败')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(2)
    target, icon = sys.argv[1], sys.argv[2]
    if not os.path.exists(target):
        print('✗ 找不到目标文件：%s' % target)
        sys.exit(1)

    # 先写到临时文件，校验通过才原子替换 —— 失败也不会留下一个坏的 exe
    tmp = target + '.icon.tmp'
    print('▶ 写入图标 → %s' % target)
    try:
        patch(target, icon, out_path=tmp)
        verify(tmp)
        os.replace(tmp, target)
    except BaseException:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise
    print('✓ 图标写入完成')
