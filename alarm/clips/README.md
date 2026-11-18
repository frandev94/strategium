# Vox clips

Short excerpts of "Disposal Unit" (Warhammer 40,000: Darktide OST, Fatshark / Jesper Kyd), used as notification sounds. Each one is a few seconds long, mono, 32 kbps.

The cut points come from the timed comments on the [SoundCloud upload](https://soundcloud.com/user-861257824/warhammer-40000-darktide-ost-boss-fight-music) (same recording, 383.97 s), snapped to the beat grid (100 bpm). The upload has edit cuts at about 1:16, 1:38, 2:02, 2:40, 3:26, 4:05, 4:45, 5:07, 5:18 and 5:51; no clip crosses one.

| Clip | Source | Length | What it is | Comments that point there |
|---|---|---|---|---|
| `50.mp3` | 0:00.20-0:03.20 | 3.0 s | the opening boom and its ring | "🔥" 0:00, "goes so fucking hard" 0:02 |
| `80.mp3` | 0:06.14-0:08.04 | 1.9 s | two booms | "slaps" 0:05, "Same" 0:06, "…is fucking good" 0:08 |
| `100.mp3` | 0:31.45-0:35.05 | 3.6 s | the chant at full | the chant heard as words 0:32, "POV: You're in Chicago" 0:33 |
| `done.mp3` | 0:17.00-0:20.04 | 3.0 s | a run of hits that ends on a rest | "FINALY, I FOUND THIS SONG" 0:17, "esta es de las gods" 0:17, "for the emperor" 0:19 |
| `attention.mp3` | 4:08.57-4:11.57 | 3.0 s | the end of the break and the drop | "4:05", "4:07 is best" |
| `idle.mp3` | 0:38.65-0:41.00 | 2.35 s | the break before the drop, without the drop | "FOR THE EMPEROR" 0:39, "❤️‍🔥" 0:40 |
| `theme.mp3` | 0:41.05-0:50.65 | 9.6 s | the drop, four bars | the densest cluster: 0:41, 0:44 (twice), 0:45, 0:48 |

Each clip: 10 ms fade-in, a fade-out (0.15-0.8 s), loudness to -16 LUFS, limiter at 0.6:

```
ffmpeg -ss <start> -t <length> -i "Disposal Unit.m4a" -af "afade=t=in:d=0.01,afade=t=out:st=<length-fade>:d=<fade>,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.6:level=false" -ac 1 -ar 22050 -c:a libmp3lame -b:a 32k -map_metadata -1 -id3v2_version 0 -write_id3v1 0 <clip>.mp3
```

Fades: `50` 0.5, `80` 0.15, `100` 0.4, `done` 0.25, `attention` 0.4, `idle` 0.5, `theme` 0.8.
