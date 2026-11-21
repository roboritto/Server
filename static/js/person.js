import { state } from './state.js';
import { dom } from './dom.js';
import { createMovieCard } from './utils.js';
import { pushCurrentStateToHistory, navigateToPage } from './navigation.js';
import { openMoviePage } from './movie.js';

export function openPersonPage(personIdentifier, recordHistory = true) {
    if (!dom.personPage) return;

    const person = state.peopleDatabase.find(
        (p) =>
            (p.id && String(p.id) === String(personIdentifier)) ||
            p.name.toLowerCase() === String(personIdentifier).toLowerCase()
    );
    if (!person) return;

    const personKey = person.id ? String(person.id) : person.name;

    if (recordHistory && (state.currentPage !== 'person-page' || String(state.currentPersonId) !== String(personKey))) {
        pushCurrentStateToHistory();
    }

    state.currentPersonId = personKey;

    if (dom.personAvatarContainer) {
        dom.personAvatarContainer.innerHTML = person.profile_path
            ? `<img src="${person.profile_path}" alt="${person.name}" class="person-avatar-img">`
            : `<div class="person-avatar-placeholder">No Photo</div>`;
    }

    if (dom.personRoleLabel) dom.personRoleLabel.textContent = person.role || '';
    if (dom.personName) dom.personName.textContent = person.name;

    const personMovies = state.moviesDatabase.filter((movie) => {
        const directed = (movie.directors || []).some(
            (d) =>
                (d.id && person.id && String(d.id) === String(person.id)) ||
                d.name.toLowerCase() === person.name.toLowerCase()
        );
        const acted = (movie.cast || []).some(
            (a) =>
                (a.id && person.id && String(a.id) === String(person.id)) ||
                a.name.toLowerCase() === person.name.toLowerCase()
        );
        return directed || acted;
    });

    personMovies.sort((a, b) => {
        const dateA = a.release_date || '0000-00-00';
        const dateB = b.release_date || '0000-00-00';
        return dateB.localeCompare(dateA);
    });

    if (dom.personMoviesGrid) {
        dom.personMoviesGrid.innerHTML = '';
        personMovies.forEach((movie) => {
            dom.personMoviesGrid.appendChild(createMovieCard(movie, openMoviePage));
        });
    }

    navigateToPage('person-page', null, false);
}