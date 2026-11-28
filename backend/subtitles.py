import hashlib
import os
import re
import secrets
import subprocess
from pathlib import Path
from typing import List, Optional

from backend.media_probe import NO_WINDOW_FLAG, get_ffmpeg_binary, get_stream_cache_dir

_SUBTITLE_TIMING_RE = re.compile(
    r"((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})\s*-->\s*((?:\d{1,2}:)?\d{2}:\d{2}[.,]\d{3})(.*)"
)


def _parse_subtitle_ts(ts_str: str) -> float:
    parts = ts_str.replace(",", ".").split(":")
    if len(parts) == 3:
        return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    if len(parts) == 2:
        return int(parts[0]) * 60 + float(parts[1])
    return 0.0


def _format_vtt_ts(seconds: float) -> str:
    ms_total = max(0, int(round(seconds * 1000)))
    hours, rem = divmod(ms_total, 3_600_000)
    minutes, rem = divmod(rem, 60_000)
    secs, ms = divmod(rem, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{ms:03d}"


def convert_srt_or_vtt_to_vtt(raw_text: str, offset_seconds: float = 0.0) -> str:
    """Converts .srt or .vtt text into WebVTT and shifts cue times by -offset_seconds."""
    text = raw_text.lstrip("\ufeff").replace("\r\n", "\n").replace("\r", "\n")
    blocks = re.split(r"\n\s*\n", text.strip())
    output = ["WEBVTT", ""]

    for block in blocks:
        lines = [line for line in block.split("\n") if line.strip()]
        if not lines:
            continue
        first_upper = lines[0].strip().upper()
        if first_upper.startswith("WEBVTT") or first_upper.startswith("NOTE"):
            continue

        timing_idx = next(
            (i for i, l in enumerate(lines) if _SUBTITLE_TIMING_RE.match(l.strip())),
            -1,
        )
        if timing_idx == -1:
            continue

        match = _SUBTITLE_TIMING_RE.match(lines[timing_idx].strip())
        if not match:
            continue

        start = _parse_subtitle_ts(match.group(1)) - offset_seconds
        end = _parse_subtitle_ts(match.group(2)) - offset_seconds
        if end <= 0:
            continue

        cue_lines = lines[timing_idx + 1:]
        if not cue_lines:
            continue

        output.append(
            f"{_format_vtt_ts(max(0.0, start))} --> {_format_vtt_ts(end)}{match.group(3)}"
        )
        output.extend(cue_lines)
        output.append("")

    return "\n".join(output)


def render_subtitle_track_vtt(
    ticket_data: dict, track_index: int, offset_seconds: float = 0.0
) -> Optional[str]:
    """Reads a sidecar .srt/.vtt or extracts an embedded MKV subtitle stream as WebVTT."""
    subtitles = ticket_data.get("subtitles") or []
    if track_index < 0 or track_index >= len(subtitles):
        return None

    track = subtitles[track_index]
    if track["source"] == "file":
        sub_path = Path(track["path"])
        if not sub_path.is_file():
            return None
        try:
            raw_text = sub_path.read_text(encoding="utf-8-sig")
        except UnicodeDecodeError:
            raw_text = sub_path.read_text(encoding="cp1252", errors="replace")
        return convert_srt_or_vtt_to_vtt(raw_text, offset_seconds=offset_seconds)

    if track["source"] == "embedded":
        stream_idx = track["stream_index"]
        cache = ticket_data.setdefault("subtitle_cache", {})
        raw_text = cache.get(stream_idx)

        if raw_text is None:
            ffmpeg_bin = get_ffmpeg_binary()
            if not ffmpeg_bin:
                return None
            proc = subprocess.run(
                [
                    ffmpeg_bin,
                    "-v",
                    "error",
                    "-i",
                    ticket_data["path"],
                    "-map",
                    f"0:{stream_idx}",
                    "-c:s",
                    "webvtt",
                    "-f",
                    "webvtt",
                    "pipe:1",
                ],
                capture_output=True,
                timeout=120,
                creationflags=NO_WINDOW_FLAG,
            )
            if proc.returncode != 0:
                return None
            raw_text = proc.stdout.decode("utf-8", errors="replace")
            cache[stream_idx] = raw_text

        return convert_srt_or_vtt_to_vtt(raw_text, offset_seconds=offset_seconds)

    return None


def _get_pgs_sup_cache_path(file_path: Path, stream_idx: int) -> Path:
    stat = file_path.stat()
    raw_key = f"{file_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|pgs:{stream_idx}"
    cache_key = hashlib.sha256(raw_key.encode("utf-8")).hexdigest()[:24]
    subs_dir = get_stream_cache_dir() / "subs"
    subs_dir.mkdir(parents=True, exist_ok=True)
    return subs_dir / f"{cache_key}.sup"


def _extract_single_pgs_sup(
    ffmpeg_bin: str, file_path: Path, stream_idx: int, final_path: Path
) -> bool:
    part_path = final_path.with_name(f"{final_path.stem}_{secrets.token_hex(4)}.part.sup")
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-y",
                "-v",
                "error",
                "-i",
                str(file_path),
                "-map",
                f"0:{stream_idx}",
                "-c:s",
                "copy",
                "-f",
                "sup",
                str(part_path),
            ],
            capture_output=True,
            timeout=120,
            creationflags=NO_WINDOW_FLAG,
        )
        if proc.returncode == 0 and part_path.is_file() and part_path.stat().st_size > 0:
            os.replace(part_path, final_path)
            return True
        err = proc.stderr.decode("utf-8", errors="replace").strip()
        if err:
            print(f"[PGS Extract Error] {err}")
    except Exception as exc:
        print(f"[PGS Extract Exception] {exc}")
    finally:
        part_path.unlink(missing_ok=True)

    return False


def extract_pgs_track_sup(ticket_data: dict, track_index: int) -> Optional[Path]:
    """
    Extracts an embedded Blu-ray PGS (hdmv_pgs_subtitle) stream to a cached .sup file
    in .stream_cache/subs/ without re-encoding any video.
    """
    subtitles = ticket_data.get("subtitles") or []
    if track_index < 0 or track_index >= len(subtitles):
        return None

    track = subtitles[track_index]
    if track.get("codec") != "hdmv_pgs_subtitle" or "stream_index" not in track:
        return None

    file_path = Path(ticket_data["path"])
    if not file_path.is_file():
        return None

    stream_idx = int(track["stream_index"])
    final_path = _get_pgs_sup_cache_path(file_path, stream_idx)
    if final_path.is_file() and final_path.stat().st_size > 0:
        return final_path

    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return None

    if _extract_single_pgs_sup(ffmpeg_bin, file_path, stream_idx, final_path):
        return final_path
    return None


def extract_all_pgs_sup_tracks(file_path: Path, stream_indices: List[int]):
    """
    Pre-extracts all uncached embedded PGS (.sup) subtitle tracks in a single FFmpeg pass,
    with a per-track fallback if any individual stream fails.
    """
    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin or not file_path.is_file() or not stream_indices:
        return

    unique_indices = list(dict.fromkeys(int(idx) for idx in stream_indices))
    pending: List[tuple[int, Path, Path]] = []

    for stream_idx in unique_indices:
        try:
            final_path = _get_pgs_sup_cache_path(file_path, stream_idx)
            if final_path.is_file() and final_path.stat().st_size > 0:
                continue
            part_path = final_path.with_name(
                f"{final_path.stem}_{secrets.token_hex(4)}.part.sup"
            )
            pending.append((stream_idx, part_path, final_path))
        except OSError:
            continue

    if not pending:
        return

    cmd = [ffmpeg_bin, "-y", "-v", "error", "-i", str(file_path)]
    for stream_idx, part_path, _ in pending:
        cmd.extend(["-map", f"0:{stream_idx}", "-c:s", "copy", "-f", "sup", str(part_path)])

    batch_ok = False
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            timeout=300,
            creationflags=NO_WINDOW_FLAG,
        )
        if proc.returncode == 0:
            batch_ok = True
            for _, part_path, final_path in pending:
                if part_path.is_file() and part_path.stat().st_size > 0:
                    os.replace(part_path, final_path)
    except Exception:
        pass
    finally:
        for _, part_path, _ in pending:
            part_path.unlink(missing_ok=True)

    # If the batch command failed (e.g. one corrupted subtitle stream), salvage the rest individually
    if not batch_ok and len(pending) > 1:
        for stream_idx, _, final_path in pending:
            if not (final_path.is_file() and final_path.stat().st_size > 0):
                _extract_single_pgs_sup(ffmpeg_bin, file_path, stream_idx, final_path)