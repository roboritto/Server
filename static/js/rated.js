import { state } from './state.js';
import { dom } from './dom.js';
import { getHeartSvgMarkup, createMovieCard } from './utils.js';
import { openMoviePage } from './movie.js';

export function updateRatedFilterHeartsUI(ratingVal) {
    state.activeRatedFilter = Math.max(0, Math.min(5, parseFloat(ratingVal) || 0));

    dom.ratedFilterHearts.forEach((heartEl, idx) => {
        const heartNumber = idx + 1;
        let fillState = 'empty';
        if (state.activeRatedFilter >= heartNumber) {
            fillState = 'full';
        } else if (state.activeRatedFilter >= heartNumber - 0.5) {
            fillState = 'half';
        }
        heartEl.innerHTML = getHeartSvgMarkup(fillState, `rated-filter-${heartNumber}`);
    });
}

export function renderRatedMoviesPage() {
    if (!dom.ratedMoviesGrid) return;

    let ratedMovies = state.moviesDatabase.filter((movie) => (parseFloat(movie.rating) || 0) > 0);

    if (state.activeRatedFilter > 0) {
        ratedMovies = ratedMovies.filter((movie) => {
            const movieRating = parseFloat(movie.rating) || 0;
            return Math.abs(movieRating - state.activeRatedFilter) < 0.01;
        });
    }

    ratedMovies.sort((a, b) => {
        const ratingDiff = (parseFloat(b.rating) || 0) - (parseFloat(a.rating) || 0);
        if (Math.abs(ratingDiff) > 0.001) return ratingDiff;
        return (a.title || '').localeCompare(b.title || '', undefined, { numeric: true, sensitivity: 'base' });
    });

    if (dom.ratedMoviesCountBadge) {
        dom.ratedMoviesCountBadge.textContent = `${ratedMovies.length}`;
    }

    dom.ratedMoviesGrid.innerHTML = '';

    if (ratedMovies.length === 0) {
        const emptyText = state.activeRatedFilter > 0
            ? `No movies found with a ${state.activeRatedFilter.toFixed(1)} rating.`
            : 'No rated movies yet.';
        dom.ratedMoviesGrid.innerHTML = `<div class="search-empty-msg" style="grid-column: 1 / -1;">${emptyText}</div>`;
        return;
    }

    ratedMovies.forEach((movie) => {
        dom.ratedMoviesGrid.appendChild(createMovieCard(movie, openMoviePage));
    });
}