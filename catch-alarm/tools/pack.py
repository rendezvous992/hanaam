"""서명 전 APK 만들기. resources.arsc 는 압축 없이 4바이트 정렬 (targetSdk 30+ 필수)."""
import sys, zipfile
out, manifest, dex, arsc = sys.argv[1:5]
with zipfile.ZipFile(out, 'w') as z:
    for name, path, stored in (('AndroidManifest.xml', manifest, False), ('classes.dex', dex, False), ('resources.arsc', arsc, True)):
        data = open(path, 'rb').read()
        zi = zipfile.ZipInfo(name, date_time=(1981, 1, 1, 0, 0, 0))
        if stored:
            zi.compress_type = zipfile.ZIP_STORED
            hdr = 30 + len(name.encode())
            pad = (-(z.fp.tell() + hdr)) % 4
            zi.extra = b'\x00' * pad
        else:
            zi.compress_type = zipfile.ZIP_DEFLATED
        z.writestr(zi, data)
