#!/bin/sh
# Builds ao-tix.apk with plain SDK tools (no Gradle). Output: android/build/ao-tix.apk
set -e
cd "$(dirname "$0")"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$SDK/build-tools/36.1.0"
JAR="$SDK/platforms/android-36/android.jar"
rm -rf build && mkdir -p build/classes build/dex
"$BT/aapt2" compile --dir res -o build/res.zip
"$BT/aapt2" link -o build/unsigned.apk -I "$JAR" --manifest AndroidManifest.xml build/res.zip
javac -source 8 -target 8 -nowarn -Xlint:-options -bootclasspath "$JAR" -d build/classes $(find src -name '*.java')
"$BT/d8" --min-api 24 --lib "$JAR" --output build/dex $(find build/classes -name '*.class')
(cd build/dex && zip -q ../unsigned.apk classes.dex)
"$BT/zipalign" -f 4 build/unsigned.apk build/aligned.apk
"$BT/apksigner" sign --ks "$HOME/.android/debug.keystore" --ks-pass pass:android \
  --out build/ao-tix.apk build/aligned.apk
echo "built build/ao-tix.apk"
