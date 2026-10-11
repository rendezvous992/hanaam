#!/usr/bin/env bash
# 캐치알람 APK 빌드 (안드로이드 스튜디오 없이)
# 필요: JDK 17+, python3, tools/lib 에 android-all.jar(org.robolectric:android-all:15-robolectric-12714715),
#       dalvik-dx-16.0.1.jar(com.jakewharton.android.repackaged), apksig.jar(com.android.tools.build:apksig:2.3.0)
set -euo pipefail
cd "$(dirname "$0")"
L=${LIB:-tools/lib}
CODE=${1:-5}; NAME=${2:-1.4}
rm -rf build && mkdir -p build/classes build/tools
javac -encoding UTF-8 --release 8 -Xlint:-options -cp $L/android-all.jar -d build/classes $(find src -name '*.java')
java -cp $L/dalvik-dx-16.0.1.jar com.android.dx.command.Main --dex --min-sdk-version=28 --output=build/classes.dex build/classes
python3 tools/patch_manifest.py AndroidManifest-1.3.bin build/AndroidManifest.xml "$CODE" "$NAME"
python3 tools/pack.py build/unsigned.apk build/AndroidManifest.xml build/classes.dex resources.arsc
javac -cp $L/apksig.jar -d build/tools tools/Sign.java
java --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.pkcs=ALL-UNNAMED \
     --add-exports java.base/sun.security.util=ALL-UNNAMED -cp $L/apksig.jar:build/tools \
     Sign catchalarm.p12 catchalarm catchalarm build/unsigned.apk "build/catch-alarm-$NAME.apk"
echo "build/catch-alarm-$NAME.apk"
