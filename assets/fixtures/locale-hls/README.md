# Local HLS fixture

Two one-second blue frames, no audio. These files exercise real yt-dlp manifest,
initialization and segment downloads without an external media service or a
runtime ffmpeg dependency. Tests construct the playlist with their local URLs.

Generated with ffmpeg and its libopenh264 encoder:

```sh
ffmpeg -f lavfi -i color=c=blue:s=32x32:r=1 -t 2 -c:v libopenh264 -g 1 -an \
  -f hls -hls_time 1 -hls_list_size 0 -hls_segment_type fmp4 \
  -hls_segment_filename segment-%d.m4s index.m3u8
```
