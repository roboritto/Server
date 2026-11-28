import os
from datetime import timedelta, timezone
from dotenv import load_dotenv

load_dotenv()

# Secrets
SERVER_API_TOKEN = os.getenv("SERVER_API_TOKEN", "")
TMDB_API_KEY = os.getenv("TMDB_API_KEY", "")

# Data Files
CSV_FILE = os.getenv("CSV_FILE", "movie_database.csv")
CUSTOM_MOVIES_FILE = os.getenv("CUSTOM_MOVIES_FILE", "custom_movies.json")
KNOWN_MOVIES_FILE = os.getenv("KNOWN_MOVIES_FILE", "known_movies.json")
HIDDEN_MOVIES_FILE = os.getenv("HIDDEN_MOVIES_FILE", "hidden_movies.json")
PERMISSIONS_FILE = os.getenv("PERMISSIONS_FILE", "permissions.json")
ADMIN_IPS = {
    ip.strip() for ip in os.getenv("ADMIN_IPS", "").split(",") if ip.strip()
}
TMDB_CACHE_FILE = os.getenv("TMDB_CACHE_FILE", "tmdb_cache.json")

CSV_FIELDNAMES = ["movie_id", "link", "rating", "last_watch", "review", "collection"]

# NEW Badge Settings
TIMEZONE_OFFSET_HOURS = int(os.getenv("TIMEZONE_OFFSET_HOURS", "8"))
LOCAL_TZ = timezone(timedelta(hours=TIMEZONE_OFFSET_HOURS))
NEW_BADGE_DAYS = int(os.getenv("NEW_BADGE_DAYS", "7"))

# Collection Download Settings
PREFERRED_DOWNLOAD_HOST = os.getenv("PREFERRED_DOWNLOAD_HOST", "").strip().lower()
DOWNLOAD_TICKET_TTL = 300  # 5 minutes
STREAM_TICKET_TTL = 14400  # 4 hours

# Local Video Files Base Directory (defaults to project root if blank)
LOCAL_MOVIES_DIR = os.getenv("LOCAL_MOVIES_DIR", "").strip()

# Optional FFmpeg / FFprobe paths for MKV & non-native codec streaming
FFMPEG_PATH = os.getenv("FFMPEG_PATH", "").strip()
FFPROBE_PATH = os.getenv("FFPROBE_PATH", "").strip()

# Prepared MP4 Stream Cache (for smooth playback & instant replays)
STREAM_CACHE_DIR = os.getenv("STREAM_CACHE_DIR", ".stream_cache").strip() or ".stream_cache"
STREAM_CACHE_MAX_GB = float(os.getenv("STREAM_CACHE_MAX_GB", "15"))
# Cap resolution height when transcoding (1080 is ~4x faster than 4K)
STREAM_MAX_HEIGHT = int(os.getenv("STREAM_MAX_HEIGHT", "1080"))
# Hardware encoder 
FFMPEG_HW_ENCODER = os.getenv("FFMPEG_HW_ENCODER", "auto").strip().lower() or "auto"