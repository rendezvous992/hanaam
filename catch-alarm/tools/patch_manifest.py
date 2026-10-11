"""AndroidManifest.xml(바이너리)의 versionCode / versionName 을 바꾼다."""
import struct, sys

src, dst, new_code, new_name = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
b = bytearray(open(src, 'rb').read())
assert struct.unpack_from('<HHI', b, 0)[0] == 0x0003

# string pool
off = 8
typ, hsz, size = struct.unpack_from('<HHI', b, off)
assert typ == 0x0001
count, styles, flags, str_start, style_start = struct.unpack_from('<IIIII', b, off + 8)
utf8 = bool(flags & 0x100)
offsets = struct.unpack_from('<%dI' % count, b, off + 28)
def read_str(i):
    p = off + str_start + offsets[i]
    if utf8:
        n = b[p]; p += 1
        if n & 0x80: p += 1
        n = b[p]; p += 1
        if n & 0x80: n = ((n & 0x7f) << 8) | b[p]; p += 1
        return b[p:p + n].decode('utf-8'), p, n, 'utf8'
    n = struct.unpack_from('<H', b, p)[0]; p += 2
    return b[p:p + 2 * n].decode('utf-16le'), p, n, 'utf16'
strings = [read_str(i)[0] for i in range(count)]

# 첫 START_TAG(manifest) 의 속성
p = off + size
while p < len(b):
    t, h, s = struct.unpack_from('<HHI', b, p)
    if t == 0x0102:
        name = struct.unpack_from('<i', b, p + 20)[0]
        assert strings[name] == 'manifest', strings[name]
        attr_start, attr_size, attr_count = struct.unpack_from('<HHH', b, p + 24)
        a0 = p + 16 + attr_start
        for k in range(attr_count):
            ap = a0 + k * attr_size
            ns, an, raw = struct.unpack_from('<iii', b, ap)
            vsize, res0, dtype, data = struct.unpack_from('<HBBI', b, ap + 12)
            aname = strings[an]
            if aname == 'versionCode':
                assert dtype == 0x10, dtype
                print('versionCode', data, '->', new_code)
                struct.pack_into('<I', b, ap + 16, new_code)
            elif aname == 'versionName':
                old, sp, n, enc = read_str(data)
                print('versionName', old, '->', new_name)
                assert len(new_name) == len(old), 'same length only'
                b[sp:sp + (n if enc == 'utf8' else 2 * n)] = new_name.encode('utf-8' if enc == 'utf8' else 'utf-16le')
        break
    p += s
open(dst, 'wb').write(b)
