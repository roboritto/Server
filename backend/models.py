from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class Movie(BaseModel):
    movie_id: str
    link: Optional[str] = ""
    rating: Optional[float] = 0.0
    last_watch: Optional[str] = ""
    review: Optional[str] = ""
    collection: Optional[str] = ""


class MovieUpdate(BaseModel):
    link: Optional[str] = None
    rating: Optional[float] = None
    last_watch: Optional[str] = None
    review: Optional[str] = None
    collection: Optional[str] = None


class CollectionDownloadRequest(BaseModel):
    collection: str
    titles: dict[str, str] = {}
    movie_order: List[str] = []

class TmdbCacheUpdate(BaseModel):
    entries: Dict[str, Dict[str, Any]]