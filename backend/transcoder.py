from collections import deque
import hashlib
import os
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path
from typing import List, Optional

from backend.config import (
    FFMPEG_HW_ENCODER,
    STREAM_CACHE_MAX_GB,
    STREAM_MAX_HEIGHT,
)
from backend.media_probe import (
    NO_WINDOW_FLAG,
    can_copy_video_for_mobile,
    get_burn_subtitle_stream_index,
    get_ffmpeg_binary,
    get_selected_audio_track,
    get_stream_cache_dir,
)

STREAM_PREPARE_JOBS = {}
PREPARE_LOCK = threading.Lock()
_ENCODER_LOCK = threading.Lock()
_DETECTED_VIDEO_ENCODER = None

_HW_ENCODER_CANDIDATES = [
    (
        "nvenc",
        "GPU: NVENC",
        ["-c:v", "h264_nvenc", "-preset", "p1", "-rc", "vbr", "-cq", "24", "-b:v", "0", "-profile:v", "main", "-pix_fmt", "yuv420p"],
    ),
    (
        "qsv",
        "GPU: QuickSync",
        ["-c:v", "h264_qsv", "-preset", "veryfast", "-global_quality", "24", "-pix_fmt", "nv12"],
    ),
    (
        "amf",
        "GPU: AMF",
        ["-c:v", "h264_amf", "-quality", "speed", "-rc", "cqp", "-qp_i", "24", "-qp_p", "24", "-pix_fmt", "yuv420p"],
    ),
    (
        "mf",
        "GPU: MediaFoundation",
        ["-c:v", "h264_mf", "-rate_control", "quality", "-quality", "75", "-pix_fmt", "nv12"],
    ),
    (
        "mf",
        "GPU: MediaFoundation",
        ["-c:v", "h264_mf", "-b:v", "5M", "-pix_fmt", "nv12"],
    ),
]
CPU_ENCODER_SPEC = (
    "cpu",
    "CPU",
    ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-threads", "0", "-profile:v", "main", "-level", "4.1", "-pix_fmt", "yuv420p"],
)


def build_stream_cache_key(
    file_path: Path,
    audio_track_index: int,
    burn_sub_stream: Optional[int],
) -> str:
    """Device-independent cache key so every browser/phone shares the exact same cached MP4."""
    stat = file_path.stat()
    raw = f"{file_path.resolve()}|{stat.st_mtime_ns}|{stat.st_size}|a{audio_track_index}|b{burn_sub_stream}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def evict_stream_cache_if_needed(keep_key: str = ""):
    cache_dir = get_stream_cache_dir()
    files = []
    total_size = 0
    now = time.time()

    with PREPARE_LOCK:
        active_parts = {
            job.get("part_path")
            for job in STREAM_PREPARE_JOBS.values()
            if job["status"] == "preparing"
        }

    for item in cache_dir.glob("*.mp4"):
        if item.name.endswith(".part.mp4"):
            if str(item) not in active_parts:
                try:
                    if now - item.stat().st_mtime > 21600:
                        item.unlink(missing_ok=True)
                except OSError:
                    pass
            continue
        try:
            st = item.stat()
            total_size += st.st_size
            files.append((st.st_mtime, st.st_size, item))
        except OSError:
            continue

    # STREAM_CACHE_MAX_GB <= 0 disables auto-eviction (keep cached movies permanently)
    if STREAM_CACHE_MAX_GB <= 0:
        return

    max_bytes = int(STREAM_CACHE_MAX_GB * (1024 ** 3))
    if total_size <= max_bytes:
        return

    files.sort(key=lambda entry: entry[0])  # Oldest accessed first
    for _, fsize, item in files:
        if total_size <= max_bytes:
            break
        if keep_key and item.stem == keep_key:
            continue
        try:
            item.unlink(missing_ok=True)
            total_size -= fsize
        except OSError:
            continue


def prune_finished_prepare_jobs():
    """Removes old completed/failed/cancelled job records after 10 minutes."""
    cutoff = time.time() - 600
    with PREPARE_LOCK:
        stale = [
            jid for jid, job in STREAM_PREPARE_JOBS.items()
            if job["status"] != "preparing" and (job.get("finished_at") or 0) < cutoff
        ]
        for jid in stale:
            STREAM_PREPARE_JOBS.pop(jid, None)


def terminate_process(proc: Optional[subprocess.Popen]):
    if not proc or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=2)
    except subprocess.TimeoutExpired:
        proc.kill()


def _probe_video_encoder(ffmpeg_bin: str, encoder_args: List[str]) -> bool:
    """Tests whether an FFmpeg video encoder actually initializes on this machine's GPU/driver."""
    try:
        proc = subprocess.run(
            [
                ffmpeg_bin,
                "-v", "error",
                "-f", "lavfi",
                "-i", "color=c=black:s=256x256:d=0.1:r=24",
                *encoder_args,
                "-f", "null",
                "-",
            ],
            capture_output=True,
            timeout=6,
            creationflags=NO_WINDOW_FLAG,
        )
        return proc.returncode == 0
    except Exception:
        return False


def get_best_h264_encoder(ffmpeg_bin: str) -> tuple[str, str, List[str]]:
    """Detects and caches the fastest working H.264 encoder (NVENC -> QSV -> AMF -> MF -> CPU)."""
    global _DETECTED_VIDEO_ENCODER
    with _ENCODER_LOCK:
        if _DETECTED_VIDEO_ENCODER is not None:
            return _DETECTED_VIDEO_ENCODER

        pref = FFMPEG_HW_ENCODER
        if pref == "cpu":
            _DETECTED_VIDEO_ENCODER = CPU_ENCODER_SPEC
            print("[Stream] Video encoder configured: CPU (libx264 ultrafast)")
            return _DETECTED_VIDEO_ENCODER

        candidates = (
            [c for c in _HW_ENCODER_CANDIDATES if c[0] == pref]
            if pref != "auto"
            else list(_HW_ENCODER_CANDIDATES)
        )

        for key, label, args in candidates:
            if _probe_video_encoder(ffmpeg_bin, args):
                _DETECTED_VIDEO_ENCODER = (key, label, args)
                print(f"[Stream] Selected hardware video encoder: {label}")
                return _DETECTED_VIDEO_ENCODER

        _DETECTED_VIDEO_ENCODER = CPU_ENCODER_SPEC
        print("[Stream] No hardware video encoder detected; using CPU (libx264 ultrafast)")
        return _DETECTED_VIDEO_ENCODER


def build_prepare_ffmpeg_cmd(
    ffmpeg_bin: str,
    file_path: Path,
    part_path: Path,
    audio_map: str,
    audio_codec: str,
    audio_channels: int,
    burn_stream: Optional[int],
    video_args: List[str],
    is_copy_video: bool,
) -> List[str]:
    cmd = [ffmpeg_bin, "-y", "-v", "error", "-fflags", "+genpts", "-i", str(file_path)]
    max_h = STREAM_MAX_HEIGHT if STREAM_MAX_HEIGHT > 0 else 0

    if burn_stream is not None:
        if max_h > 0:
            fg = (
                f"[0:v:0]scale=-2:'trunc(min({max_h},ih)/2)*2'[vid];"
                f"[0:{burn_stream}][vid]scale2ref[sub][vid2];"
                f"[vid2][sub]overlay=eof_action=pass[v]"
            )
        else:
            fg = f"[0:{burn_stream}][0:v:0]scale2ref[sub][vid];[vid][sub]overlay=eof_action=pass[v]"
        cmd.extend(["-filter_complex", fg, "-map", "[v]", "-map", audio_map, *video_args])
    else:
        cmd.extend(["-map", "0:v:0", "-map", audio_map])
        if not is_copy_video and max_h > 0:
            cmd.extend(["-vf", f"scale=-2:'trunc(min({max_h},ih)/2)*2'"])
        cmd.extend(video_args)

    if audio_codec == "aac" and audio_channels <= 2:
        cmd.extend(["-c:a", "copy"])
    else:
        cmd.extend(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"])

    cmd.extend([
        "-max_muxing_queue_size", "1024",
        "-movflags", "+faststart",
        "-f", "mp4",
        "-progress", "pipe:1",
        "-nostats",
        str(part_path),
    ])
    return cmd


def _execute_prepare_cmd(
    job_id: str, cmd: List[str], part_path: Path, duration: float
) -> tuple[int, str, bool]:
    """Runs a single FFmpeg command, updating job progress. Returns (returncode, err_msg, cancelled)."""
    stderr_tail: deque[str] = deque(maxlen=25)
    proc = None
    try:
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=NO_WINDOW_FLAG,
        )
        with PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if not job or job["status"] == "cancelled":
                terminate_process(proc)
                part_path.unlink(missing_ok=True)
                return (-1, "", True)
            job["process"] = proc

        def _drain_stderr():
            assert proc.stderr is not None
            for err_line in proc.stderr:
                clean = err_line.strip()
                if clean:
                    stderr_tail.append(clean)

        err_thread = threading.Thread(target=_drain_stderr, daemon=True)
        err_thread.start()

        assert proc.stdout is not None
        for line in proc.stdout:
            line = line.strip()
            if not line or "=" not in line:
                continue
            key, val = line.split("=", 1)
            if key in ("out_time_us", "out_time_ms") and duration > 0:
                try:
                    encoded_sec = int(val) / 1_000_000.0
                    pct = max(0.0, min(99.0, (encoded_sec / duration) * 100.0))
                    with PREPARE_LOCK:
                        job = STREAM_PREPARE_JOBS.get(job_id)
                        if job and job["status"] == "preparing":
                            job["progress"] = round(pct, 1)
                except ValueError:
                    pass

        proc.wait()
        err_thread.join(timeout=2)

        with PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if not job or job["status"] == "cancelled":
                part_path.unlink(missing_ok=True)
                return (-1, "", True)
            job["process"] = None

        err_msg = " | ".join(list(stderr_tail)[-4:]) or f"FFmpeg exited with code {proc.returncode}"
        return (proc.returncode, err_msg, False)
    finally:
        if proc and proc.stdout:
            proc.stdout.close()
        if proc and proc.stderr:
            proc.stderr.close()


def run_prepare_mp4_worker(
    job_id: str,
    primary_cmd: List[str],
    fallback_cmd: Optional[List[str]],
    part_path: Path,
    final_path: Path,
    duration: float,
    cache_key: str,
):
    try:
        rc, err_msg, cancelled = _execute_prepare_cmd(job_id, primary_cmd, part_path, duration)
        if cancelled:
            return

        if (rc != 0 or not part_path.is_file() or part_path.stat().st_size == 0) and fallback_cmd:
            part_path.unlink(missing_ok=True)
            print(f"[Stream Prepare] GPU encoder failed ({err_msg}); falling back to CPU...")
            with PREPARE_LOCK:
                job = STREAM_PREPARE_JOBS.get(job_id)
                if not job or job["status"] == "cancelled":
                    return
                job["progress"] = 0.0
                job["mode_label"] = "Converting once for all devices (CPU)..."
            rc, err_msg, cancelled = _execute_prepare_cmd(job_id, fallback_cmd, part_path, duration)
            if cancelled:
                return

        if rc == 0 and part_path.is_file() and part_path.stat().st_size > 0:
            os.replace(part_path, final_path)
            evict_stream_cache_if_needed(keep_key=cache_key)
            with PREPARE_LOCK:
                job = STREAM_PREPARE_JOBS.get(job_id)
                if job and job["status"] != "cancelled":
                    job["status"] = "ready"
                    job["progress"] = 100.0
                    job["process"] = None
                    job["finished_at"] = time.time()
        else:
            part_path.unlink(missing_ok=True)
            print(f"[Stream Prepare Error] {err_msg}")
            with PREPARE_LOCK:
                job = STREAM_PREPARE_JOBS.get(job_id)
                if job and job["status"] != "cancelled":
                    job["status"] = "error"
                    job["error"] = f"FFmpeg failed to prepare video: {err_msg}"
                    job["process"] = None
                    job["finished_at"] = time.time()
    except Exception as exc:
        part_path.unlink(missing_ok=True)
        print(f"[Stream Prepare Exception] {exc}")
        with PREPARE_LOCK:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if job and job["status"] != "cancelled":
                job["status"] = "error"
                job["error"] = str(exc)
                job["process"] = None
                job["finished_at"] = time.time()


def start_prepare_mp4_job(
    ticket: str,
    ticket_data: dict,
    audio_track_index: int = 0,
    burn_sub_track: int = -1,
) -> dict:
    """
    Returns a direct or server-cached universal H.264/AAC MP4 immediately if ready,
    attaches to an already-running background conversion if one exists, or starts a new
    one that stays running in the background even if the modal is closed.
    """
    prune_finished_prepare_jobs()
    safe_audio = max(0, audio_track_index)
    burn_stream = get_burn_subtitle_stream_index(ticket_data, burn_sub_track)

    if ticket_data.get("mode") == "direct" and safe_audio == 0 and burn_stream is None:
        return {
            "status": "ready",
            "progress": 100.0,
            "stream_url": f"/api/local-files/stream?ticket={ticket}",
        }

    ffmpeg_bin = get_ffmpeg_binary()
    if not ffmpeg_bin:
        return {
            "status": "error",
            "error": "FFmpeg is required for MKV/HEVC playback or track switching (add ffmpeg to PATH or set FFMPEG_PATH in .env).",
        }

    file_path = Path(ticket_data["path"])
    if not file_path.is_file():
        return {"status": "error", "error": "Source video file no longer exists on server."}

    cache_key = build_stream_cache_key(file_path, safe_audio, burn_stream)
    cache_dir = get_stream_cache_dir()
    final_path = cache_dir / f"{cache_key}.mp4"

    ticket_data.setdefault("allowed_cache_keys", set()).add(cache_key)

    if final_path.is_file() and final_path.stat().st_size > 0:
        try:
            final_path.touch()
        except OSError:
            pass
        return {
            "status": "ready",
            "progress": 100.0,
            "stream_url": f"/api/local-files/stream?ticket={ticket}&cache_key={cache_key}",
        }

    with PREPARE_LOCK:
        for existing_id, job in STREAM_PREPARE_JOBS.items():
            if job["cache_key"] == cache_key and job["status"] == "preparing":
                ticket_data.setdefault("active_job_ids", set()).add(existing_id)
                job["tickets"].add(ticket)
                return {
                    "status": "preparing",
                    "job_id": existing_id,
                    "progress": job["progress"],
                    "mode_label": job["mode_label"],
                }

        job_id = secrets.token_urlsafe(10)
        part_path = cache_dir / f"{cache_key}_{job_id}.part.mp4"

        selected_audio = get_selected_audio_track(ticket_data, safe_audio)
        audio_map = f"0:{selected_audio['stream_index']}" if selected_audio else "0:a:0?"
        audio_codec = selected_audio["codec"] if selected_audio else ticket_data.get("audio_codec", "")
        audio_channels = int(selected_audio.get("channels", 2)) if selected_audio else 2

        can_copy_h264 = can_copy_video_for_mobile(ticket_data) and burn_stream is None
        fallback_cmd: Optional[List[str]] = None

        if can_copy_h264:
            mode_label = "Caching video for all devices (fast copy)..."
            primary_video_args = ["-c:v", "copy"]
        else:
            enc_key, enc_label, primary_video_args = get_best_h264_encoder(ffmpeg_bin)
            mode_label = (
                f"Caching video with subtitles ({enc_label})..."
                if burn_stream is not None
                else f"Caching video once for all devices ({enc_label})..."
            )
            if enc_key != "cpu":
                fallback_cmd = build_prepare_ffmpeg_cmd(
                    ffmpeg_bin,
                    file_path,
                    part_path,
                    audio_map,
                    audio_codec,
                    audio_channels,
                    burn_stream,
                    CPU_ENCODER_SPEC[2],
                    is_copy_video=False,
                )

        primary_cmd = build_prepare_ffmpeg_cmd(
            ffmpeg_bin,
            file_path,
            part_path,
            audio_map,
            audio_codec,
            audio_channels,
            burn_stream,
            primary_video_args,
            is_copy_video=can_copy_h264,
        )

        STREAM_PREPARE_JOBS[job_id] = {
            "cache_key": cache_key,
            "status": "preparing",
            "progress": 0.0,
            "mode_label": mode_label,
            "error": "",
            "process": None,
            "part_path": str(part_path),
            "tickets": {ticket},
            "finished_at": 0.0,
        }
        ticket_data.setdefault("active_job_ids", set()).add(job_id)

    worker = threading.Thread(
        target=run_prepare_mp4_worker,
        args=(
            job_id,
            primary_cmd,
            fallback_cmd,
            part_path,
            final_path,
            float(ticket_data.get("duration") or 0.0),
            cache_key,
        ),
        daemon=True,
    )
    worker.start()

    return {
        "status": "preparing",
        "job_id": job_id,
        "progress": 0.0,
        "mode_label": mode_label,
    }


def get_prepare_job_status(ticket: str, ticket_data: dict, job_id: str) -> Optional[dict]:
    """Returns current progress or final stream_url for a background prepare job."""
    with PREPARE_LOCK:
        job = STREAM_PREPARE_JOBS.get(job_id)
        if not job or ticket not in job["tickets"]:
            return None
        status = job["status"]
        progress = job["progress"]
        cache_key = job["cache_key"]
        err = job["error"]
        mode_label = job["mode_label"]

    if status == "ready":
        ticket_data.setdefault("allowed_cache_keys", set()).add(cache_key)
        return {
            "status": "ready",
            "progress": 100.0,
            "stream_url": f"/api/local-files/stream?ticket={ticket}&cache_key={cache_key}",
        }
    if status == "error":
        return {"status": "error", "error": err or "Could not prepare video."}
    if status == "cancelled":
        return {"status": "cancelled"}
    return {
        "status": "preparing",
        "progress": progress,
        "mode_label": mode_label,
    }


def detach_ticket_from_prepare_jobs(ticket_data: dict, ticket: str = ""):
    """Detaches a closed player ticket while letting FFmpeg finish caching in the background."""
    job_ids = list(ticket_data.get("active_job_ids") or [])
    ticket_data["active_job_ids"] = set()
    if not job_ids or not ticket:
        return

    with PREPARE_LOCK:
        for job_id in job_ids:
            job = STREAM_PREPARE_JOBS.get(job_id)
            if job:
                job["tickets"].discard(ticket)


def cancel_prepare_job(ticket: str, ticket_data: dict, job_id: str) -> bool:
    """Explicitly terminates an in-progress FFmpeg conversion and deletes its partial file."""
    with PREPARE_LOCK:
        job = STREAM_PREPARE_JOBS.get(job_id)
        if not job or ticket not in job["tickets"]:
            return False
        if job["status"] == "preparing":
            job["status"] = "cancelled"
            job["finished_at"] = time.time()
            terminate_process(job.get("process"))
            job["process"] = None
            part_path = job.get("part_path")
            if part_path:
                Path(part_path).unlink(missing_ok=True)
        job["tickets"].discard(ticket)
    ticket_data.get("active_job_ids", set()).discard(job_id)
    return True


def get_cached_mp4_path(ticket_data: dict, cache_key: str) -> Optional[Path]:
    """Validates and returns a prepared cached MP4 authorized for this stream ticket."""
    if not cache_key or not re.fullmatch(r"[0-9a-f]{24}", cache_key):
        return None
    if cache_key not in (ticket_data.get("allowed_cache_keys") or set()):
        return None
    candidate = get_stream_cache_dir() / f"{cache_key}.mp4"
    return candidate if candidate.is_file() else None


def get_stream_cache_stats() -> dict:
    """Returns disk usage and file counts for finished files in .stream_cache/."""
    cache_dir = get_stream_cache_dir()
    total_bytes = 0
    video_count = 0
    subtitle_count = 0

    for item in cache_dir.glob("*.mp4"):
        if item.name.endswith(".part.mp4"):
            continue
        try:
            total_bytes += item.stat().st_size
            video_count += 1
        except OSError:
            continue

    subs_dir = cache_dir / "subs"
    if subs_dir.is_dir():
        for item in subs_dir.glob("*.sup"):
            if item.name.endswith(".part.sup"):
                continue
            try:
                total_bytes += item.stat().st_size
                subtitle_count += 1
            except OSError:
                continue

    return {
        "total_bytes": total_bytes,
        "video_count": video_count,
        "subtitle_count": subtitle_count,
        "max_gb": STREAM_CACHE_MAX_GB,
    }


def clear_stream_cache() -> dict:
    """
    Deletes finished cached .mp4 and .sup files in .stream_cache/ to free disk space.
    Safely skips active in-progress conversions and files currently locked by playback.
    """
    cache_dir = get_stream_cache_dir()
    with PREPARE_LOCK:
        active_keys = {
            job["cache_key"]
            for job in STREAM_PREPARE_JOBS.values()
            if job["status"] == "preparing"
        }
        active_parts = {
            job.get("part_path")
            for job in STREAM_PREPARE_JOBS.values()
            if job["status"] == "preparing"
        }

    deleted_videos = 0
    deleted_subtitles = 0
    freed_bytes = 0
    skipped_in_use = 0

    for item in cache_dir.glob("*.mp4"):
        if item.name.endswith(".part.mp4"):
            if str(item) in active_parts:
                continue
            try:
                fsize = item.stat().st_size
                item.unlink()
                freed_bytes += fsize
            except OSError:
                pass
            continue

        if item.stem in active_keys:
            skipped_in_use += 1
            continue

        try:
            fsize = item.stat().st_size
            item.unlink()
            freed_bytes += fsize
            deleted_videos += 1
        except OSError:
            skipped_in_use += 1

    subs_dir = cache_dir / "subs"
    if subs_dir.is_dir():
        for item in subs_dir.glob("*.sup"):
            if item.name.endswith(".part.sup"):
                continue
            try:
                fsize = item.stat().st_size
                item.unlink()
                freed_bytes += fsize
                deleted_subtitles += 1
            except OSError:
                skipped_in_use += 1

    return {
        "deleted_videos": deleted_videos,
        "deleted_subtitles": deleted_subtitles,
        "freed_bytes": freed_bytes,
        "skipped_in_use": skipped_in_use,
        "cache_stats": get_stream_cache_stats(),
    }