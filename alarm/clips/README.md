# Vox clips

Short excerpts of "Disposal Unit" (Warhammer 40,000: Darktide OST, Fatshark / Jesper Kyd), used as notification sounds. Each one is a few seconds long, mono, 32 kbps.

The cut points come from the timed comments on the [SoundCloud upload](https://soundcloud.com/user-861257824/warhammer-40000-darktide-ost-boss-fight-music) (same recording, 383.97 s), snapped to the beat grid (100 bpm). The upload has edit cuts at about 1:16, 1:38, 2:02, 2:40, 3:26, 4:05, 4:45, 5:07, 5:18 and 5:51; no clip crosses one.

| Clip | Source | Length | What it is | Comments that point there |
|---|---|---|---|---|
| `50.mp3` | 0:00.20-0:03.20 | 3.0 s | the opening boom and its ring | "🔥" 0:00, "goes so fucking hard" 0:02 |
| `80.mp3` | 2:58.46-3:01.46 | 3.0 s | the full groove, hard hits | "This song is more effective than steroids" 3:00 |
| `100.mp3` | 6:03.43-6:06.43 | 3.0 s | where the countdown lands | "Reality Severance In: 2:50" at 2:10 and "Reality severace in: 0:24" at 5:40 count down to it |
| `done.mp3` | 0:36.25-0:38.95 | 2.7 s | the chant at full, cut dead by the break | "Imperium Aeternum Romanum. SPQR." 0:38 |
| `attention.mp3` | 4:06.77-4:10.37 | 3.6 s | the whole break rising into the drop | "4:05", "4:07 is best" |
| `idle.mp3` | 0:02.64-0:05.64 | 3.0 s | the intro's low ring and soft swells, quieter on purpose (-19 LUFS) | "goes so fucking hard" 0:02, "What are the lyrics to this?" 0:04, "slaps" 0:05 |
| `theme.mp3` | 0:41.05-0:50.65 | 9.6 s | the drop, four bars; loops without a seam | the densest cluster: 0:41, 0:44 (twice), 0:45, 0:48 |

Each clip except `theme`: 10 ms fade-in, a fade-out (0.3-0.5 s), loudness to -16 LUFS (`idle` -19), limiter at 0.6:

```
ffmpeg -ss <start> -t <length> -i "Disposal Unit.m4a" -af "afade=t=in:d=0.01,afade=t=out:st=<length-fade>:d=<fade>,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.6:level=false" -ac 1 -ar 22050 -c:a libmp3lame -b:a 32k -map_metadata -1 -id3v2_version 0 -write_id3v1 0 <clip>.mp3
```

Fades: `50` 0.5, `80` 0.3, `100` 0.3, `done` 0.3, `attention` 0.3, `idle` 0.5.

`theme` loops: exactly four bars (211680 samples at 22050 Hz, 9.6 s), no fades and no limiter, one linear gain to -17.5 LUFS. Its first 25 ms are an equal-power crossfade from the audio that follows 0:50.65 (cos) into 0:41.05 (sin), so the end of bar 4 flows into bar 1. LAME's gapless header holds the encoder delay and padding: a player that reads it (ffmpeg, ffplay) decodes exactly 211680 samples; one that ignores it leaves a short gap at each loop.
