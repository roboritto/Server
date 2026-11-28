export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getMovieIdFromUrlPath() {
    const pathMatch = window.location.pathname.match(/^\/(\d+)\/?$/);
    if (pathMatch) return pathMatch[1];

    const hashMatch = window.location.hash.match(/^#\/?(\d+)\/?$/);
    return hashMatch ? hashMatch[1] : null;
}

export function getKualaLumpurTimestamp() {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Kuala_Lumpur',
        day: '2-digit',
        month: '2-digit',
        year: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    });

    const parts = formatter.formatToParts(now);
    const partMap = {};
    parts.forEach((p) => {
        partMap[p.type] = p.value;
    });

    // Matches CSV format: DD-MM-YY HH:mm (e.g., 10-10-26 21:38)
    return `${partMap.day}-${partMap.month}-${partMap.year} ${partMap.hour}:${partMap.minute}`;
}

export function parseCollectionArray(collectionStr) {
    if (!collectionStr || !collectionStr.trim()) return [];
    return collectionStr
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
}

export function parseLinkArray(linkStr) {
    if (!linkStr || !linkStr.trim()) return [];
    return linkStr
        .split(',')
        .map((l) => l.trim())
        .filter(Boolean);
}

export function getMovieAlphaKey(title) {
    const cleanTitle = (title || '').trim();
    if (!cleanTitle) return '#';
    const firstChar = cleanTitle.charAt(0).toUpperCase();
    return (firstChar >= 'A' && firstChar <= 'Z') ? firstChar : '#';
}

export function getHeartSvgMarkup(fillState, uniqueIdSuffix) {
    // fillState: 'full' | 'half' | 'empty'
    const heartPath = 'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z';

    if (fillState === 'full') {
        return `
            <svg class="rating-heart-icon" style="color: #ef4444;" viewBox="0 0 24 24">
                <path d="${heartPath}" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        `;
    } else if (fillState === 'half') {
        const clipId = `half-heart-clip-${uniqueIdSuffix}`;
        return `
            <svg class="rating-heart-icon" style="color: #ef4444;" viewBox="0 0 24 24">
                <defs>
                    <clipPath id="${clipId}">
                        <rect x="0" y="0" width="12" height="24"></rect>
                    </clipPath>
                </defs>
                <path d="${heartPath}" fill="currentColor" stroke="none" clip-path="url(#${clipId})"></path>
                <path d="${heartPath}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        `;
    } else {
        return `
            <svg class="rating-heart-icon" style="color: #64748b;" viewBox="0 0 24 24">
                <path d="${heartPath}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
        `;
    }
}

export function triggerDiceRollAnimation(buttonEl) {
    const svgEl = buttonEl?.querySelector('svg');
    if (!svgEl) return;

    svgEl.animate(
        [
            { transform: 'rotate(0deg) scale(1)' },
            { transform: 'rotate(140deg) scale(1.25)', offset: 0.35 },
            { transform: 'rotate(310deg) scale(0.92)', offset: 0.75 },
            { transform: 'rotate(360deg) scale(1)' }
        ],
        {
            duration: 450,
            easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)'
        }
    );
}

export function createMovieCard(movie, onSelectMovie) {
    const card = document.createElement('div');
    card.className = 'movie-card';
    card.dataset.movieId = String(movie.movie_id);
    if (movie.is_hidden) {
        card.classList.add('is-hidden-movie');
    }

    const posterHtml = movie.poster_path
        ? `<img src="${movie.poster_path}" alt="${movie.title}" class="movie-card-poster" loading="lazy">`
        : `<div class="movie-card-poster-placeholder">No Poster</div>`;

    const numericRating = parseFloat(movie.rating) || 0;
    const formattedRating = Number.isInteger(numericRating)
        ? numericRating.toString()
        : numericRating.toFixed(1);

    const ratingBadgeHtml = numericRating > 0
        ? `
            <div class="movie-card-rating-badge" title="Rated ${formattedRating} / 5">
                <svg viewBox="0 0 24 24">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"></path>
                </svg>
                <span>${formattedRating}</span>
            </div>
        `
        : '';

    const newBadgeHtml = movie.is_new
        ? `<div class="movie-card-new-badge">NEW</div>`
        : '';

    card.innerHTML = `
        <div class="movie-card-poster-wrapper">
            ${posterHtml}
            ${ratingBadgeHtml}
            ${newBadgeHtml}
        </div>
        <div class="movie-card-info">
            <div class="movie-card-title" title="${movie.title}">${movie.title}</div>
            <div class="movie-card-year">${movie.release_year || 'Unknown Year'}</div>
        </div>
    `;

    card.addEventListener('click', () => {
        if (typeof onSelectMovie === 'function') {
            onSelectMovie(movie.movie_id);
        }
    });

    return card;
}