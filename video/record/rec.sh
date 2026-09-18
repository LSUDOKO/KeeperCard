#!/bin/bash
# rec.sh start <name> | rec.sh stop
# Records the Chrome window region of the Hyprland screen to footage/<name>.mp4.
# Uses wf-recorder when present (60 fps), otherwise streams grim frames into ffmpeg (~20 fps).
set -e
cd "$(dirname "$0")/.."
GEO_X=6; GEO_Y=52; GEO_W=1908; GEO_H=1022
case "$1" in
  start)
    name=$2; mkdir -p footage tmp
    if command -v wf-recorder >/dev/null; then
      wf-recorder -g "${GEO_X},${GEO_Y} ${GEO_W}x${GEO_H}" -r 60 -c libx264 -p crf=16 -p preset=veryfast -f "footage/$name.mp4" -y \
        > "tmp/rec-$name.log" 2>&1 & echo $! > tmp/rec.pid
    else
      ( while [ ! -e tmp/rec.stop ]; do grim -g "${GEO_X},${GEO_Y} ${GEO_W}x${GEO_H}" -t ppm -; done \
        | ffmpeg -hide_banner -loglevel error -y -f image2pipe -vcodec ppm -framerate 20 -i - \
            -vf "format=yuv420p" -c:v libx264 -crf 16 -preset veryfast -r 20 "footage/$name.mp4" ) \
        > "tmp/rec-$name.log" 2>&1 & echo $! > tmp/rec.pid
    fi
    rm -f tmp/rec.stop; echo "recording $name";;
  stop)
    if command -v wf-recorder >/dev/null; then kill -INT "$(cat tmp/rec.pid)"; else touch tmp/rec.stop; fi
    for i in $(seq 1 100); do kill -0 "$(cat tmp/rec.pid)" 2>/dev/null || break; sleep 0.2; done
    rm -f tmp/rec.stop tmp/rec.pid; echo stopped;;
esac
