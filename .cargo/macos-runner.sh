#!/bin/sh

set -eu

binary="$1"
shift

if /usr/bin/otool -L "$binary" 2>/dev/null | /usr/bin/grep -q '@rpath/libswift_Concurrency.dylib'; then
  for rpath in \
    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift-5.5/macosx \
    /Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib/swift/macosx
  do
    if /usr/bin/otool -l "$binary" 2>/dev/null | /usr/bin/grep -A2 'LC_RPATH' | /usr/bin/grep -q "$rpath"; then
      /usr/bin/install_name_tool -delete_rpath "$rpath" "$binary"
    fi
  done

  if ! /usr/bin/otool -l "$binary" 2>/dev/null | /usr/bin/grep -A2 'LC_RPATH' | /usr/bin/grep -q '/usr/lib/swift'; then
    /usr/bin/install_name_tool -add_rpath /usr/lib/swift "$binary"
  fi
fi

exec "$binary" "$@"
