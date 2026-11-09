/* Lector de textos + Reproductor — PWA local, optimizada para caminatas.
 * Reúsa el motor de WalkPlayer (reproducción en segundo plano iOS, Media Session,
 * memoria de posición) y añade lecturas con resaltado y doble-toque para saltar.
 *
 * v5: posición recordada POR CADA audio, avance visible en la biblioteca,
 *     reemplazo de lecturas regeneradas, más velocidades, ±15 s en la pantalla
 *     bloqueada, almacenamiento persistente y frases marcadas para copiar. */

const DB_NAME = 'LectorDB';
const STORE_NAME = 'items';
const DB_VERSION = 1;
const POSITION_SAVE_INTERVAL = 5;
const DOUBLE_TAP_MS = 350;
const POS_KEY = 'lector_pos';      // { [id]: { t: segundos, d: duración } }
const DONE_MARGIN = 2;             // a menos de 2 s del final = escuchado
const MARK_GRACE = 1.5;            // si la frase recién empezó, se marca la anterior

let db;
let tracks = [];
let currentTrackIndex = -1;
let currentObjectURL = null;
let lastSavedPosition = -1;

// Estado de la lectura activa.
let currentSentences = null;   // [{i, t, s, e}] o null si es un MP3 normal
let sentenceSpans = [];        // spans del DOM, alineados con currentSentences
let currentSentenceIdx = -1;
let lastTapIdx = -1;
let lastTapTime = 0;

const audioPlayer = document.getElementById('audio-player');
const playPauseBtn = document.getElementById('btn-play-pause');
const prevBtn = document.getElementById('btn-prev');
const nextBtn = document.getElementById('btn-next');
const rewindBtn = document.getElementById('btn-rewind');
const forwardBtn = document.getElementById('btn-forward');
const speedSelect = document.getElementById('speed-select');
const fileInput = document.getElementById('file-input');
const playlistEl = document.getElementById('playlist');
const trackTitleEl = document.getElementById('track-title');
const currentTimeEl = document.getElementById('current-time');
const durationTimeEl = document.getElementById('duration-time');
const progressBar = document.getElementById('progress-bar');
const artworkEl = document.querySelector('.artwork');
const clearDbBtn = document.getElementById('btn-clear-db');
const statusMessageEl = document.getElementById('status-message');
const readerEl = document.getElementById('reader');
const readerTextEl = document.getElementById('reader-text');
const markBtn = document.getElementById('btn-mark');
const marksSectionEl = document.getElementById('marks-section');
const marksTitleEl = document.getElementById('marks-title');
const marksListEl = document.getElementById('marks-list');
const copyMarksBtn = document.getElementById('btn-copy-marks');
const storageInfoEl = document.getElementById('storage-info');

const icons = { play: '▶', pause: 'Ⅱ' };

/* ----------------------------- IndexedDB ------------------------------ */
function initDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = (event) => {
            const database = event.target.result;
            if (!database.objectStoreNames.contains(STORE_NAME)) {
                database.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
            }
        };
        request.onsuccess = (event) => { db = event.target.result; resolve(); };
        request.onerror = () => reject(request.error);
    });
}

function saveItemToDB(record) {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).add(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function putItemInDB(record) {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function getAllItemsFromDB() {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function deleteItemFromDB(id) {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(id);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

function clearDB() {
    return new Promise((resolve, reject) => {
        const request = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).clear();
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });
}

/* --------------------- Posición guardada por audio --------------------- */
function loadPositions() {
    try { return JSON.parse(localStorage.getItem(POS_KEY)) || {}; } catch (_) { return {}; }
}
let positions = loadPositions();

function savePositions() {
    try { localStorage.setItem(POS_KEY, JSON.stringify(positions)); } catch (_) { /* sin espacio */ }
}

function trackDuration(track) {
    return positions[track.id]?.d || track.duration || 0;
}

function isDone(track) {
    const pos = positions[track.id];
    const d = trackDuration(track);
    return Boolean(pos && d > 0 && pos.t >= d - DONE_MARGIN);
}

function resumeTimeFor(track) {
    const pos = positions[track.id];
    if (!pos || isDone(track)) return 0;
    return pos.t || 0;
}

/* ------------------------------ Utilidades ---------------------------- */
function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return `${min}:${sec < 10 ? '0' : ''}${sec}`;
}

function isLectura(track) {
    return track && track.kind === 'lectura';
}

function getTrackTitle(track) {
    if (!track) return '';
    if (isLectura(track)) return track.name;
    return track.name.replace(/\.[^/.]+$/, '');
}

function currentTrack() {
    return tracks[currentTrackIndex] ?? null;
}

function showStatus(message, isError = false) {
    statusMessageEl.textContent = message;
    statusMessageEl.classList.toggle('is-error', isError);
}

function clearStatus() { showStatus(''); }

function updateControls() {
    const hasTracks = tracks.length > 0;
    [playPauseBtn, prevBtn, nextBtn, rewindBtn, forwardBtn].forEach((b) => { b.disabled = !hasTracks; });
    clearDbBtn.disabled = !hasTracks;
}

function applySpeed() {
    const rate = Number(speedSelect.value) || 1;
    audioPlayer.defaultPlaybackRate = rate;
    audioPlayer.playbackRate = rate;
}

/* --------------------------- Media Session ---------------------------- */
function updateMediaSession() {
    if (!('mediaSession' in navigator) || !currentTrack()) return;
    navigator.mediaSession.metadata = new MediaMetadata({
        title: getTrackTitle(currentTrack()),
        artist: 'Lector',
        artwork: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }
        ]
    });
}

function updatePositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = audioPlayer.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
        navigator.mediaSession.setPositionState({
            duration: d,
            playbackRate: audioPlayer.playbackRate || 1,
            position: Math.min(Math.max(audioPlayer.currentTime, 0), d)
        });
    } catch (_) { /* no soportado */ }
}

function syncPlaybackUI() {
    const playing = !audioPlayer.paused && !audioPlayer.ended;
    playPauseBtn.textContent = playing ? icons.pause : icons.play;
    playPauseBtn.setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir');
    playPauseBtn.title = playing ? 'Pausar' : 'Reproducir';
    artworkEl.classList.toggle('playing', playing);
    if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = playing ? 'playing' : 'paused';
    }
}

function persistCurrentPosition() {
    const track = currentTrack();
    if (!track || !Number.isFinite(audioPlayer.currentTime)) return;
    const d = Number.isFinite(audioPlayer.duration) ? audioPlayer.duration : trackDuration(track);
    positions[track.id] = { t: audioPlayer.currentTime, d };
    savePositions();
    localStorage.setItem('lector_lastTrackId', track.id);
    lastSavedPosition = audioPlayer.currentTime;
    updateItemProgress(track);
}

function revokeCurrentObjectURL() {
    if (currentObjectURL) { URL.revokeObjectURL(currentObjectURL); currentObjectURL = null; }
}

/* ------------------------- Vista de lectura --------------------------- */
function renderReader(sentences) {
    readerTextEl.replaceChildren();
    sentenceSpans = [];
    currentSentenceIdx = -1;
    let parrafoActual = null;
    let pEl = null;
    sentences.forEach((frase, idx) => {
        // Agrupar por párrafo (campo 'p'); lecturas antiguas sin 'p' van en uno solo.
        const p = frase.p ?? 0;
        if (p !== parrafoActual || pEl === null) {
            pEl = document.createElement('p');
            pEl.className = 'reader-p';
            readerTextEl.append(pEl);
            parrafoActual = p;
        }
        const span = document.createElement('span');
        span.className = 'sentence';
        span.textContent = frase.t;
        span.dataset.idx = String(idx);
        span.addEventListener('click', () => handleSentenceTap(idx));
        pEl.append(span);
        pEl.append(document.createTextNode(' '));
        sentenceSpans.push(span);
    });
}

function handleSentenceTap(idx) {
    const now = Date.now();
    if (idx === lastTapIdx && now - lastTapTime < DOUBLE_TAP_MS) {
        seekToSentence(idx);
        lastTapIdx = -1;
    } else {
        lastTapIdx = idx;
        lastTapTime = now;
    }
}

function seekToSentence(idx) {
    if (!currentSentences || !currentSentences[idx]) return;
    const start = currentSentences[idx].s;
    const apply = () => {
        audioPlayer.currentTime = start + 0.001;
        persistCurrentPosition();
        highlightSentence(idx);
        playCurrent();
    };
    if (Number.isFinite(audioPlayer.duration)) apply();
    else audioPlayer.addEventListener('loadedmetadata', apply, { once: true });
}

function findSentenceAt(time) {
    if (!currentSentences || !currentSentences.length) return -1;
    let lo = 0, hi = currentSentences.length - 1, res = 0;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (currentSentences[mid].s <= time) { res = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return res;
}

function highlightSentence(idx) {
    if (idx === currentSentenceIdx || idx < 0) return;
    if (sentenceSpans[currentSentenceIdx]) sentenceSpans[currentSentenceIdx].classList.remove('current');
    const span = sentenceSpans[idx];
    if (span) {
        span.classList.add('current');
        const top = span.offsetTop - readerTextEl.clientHeight / 2 + span.offsetHeight / 2;
        readerTextEl.scrollTo({ top, behavior: 'smooth' });
    }
    currentSentenceIdx = idx;
}

function updateReaderHighlight() {
    if (!currentSentences) return;
    highlightSentence(findSentenceAt(audioPlayer.currentTime));
}

function showReaderFor(track) {
    if (isLectura(track) && Array.isArray(track.sentences) && track.sentences.length) {
        currentSentences = track.sentences;
        renderReader(currentSentences);
        readerEl.hidden = false;
        document.body.classList.add('reading-mode');
    } else {
        currentSentences = null;
        sentenceSpans = [];
        currentSentenceIdx = -1;
        readerEl.hidden = true;
        readerTextEl.replaceChildren();
        document.body.classList.remove('reading-mode');
    }
    renderMarks();
}

/* -------------------------- Frases marcadas --------------------------- */
function getMarks(track) {
    return isLectura(track) && Array.isArray(track.marks) ? track.marks : [];
}

function renderMarks() {
    const track = currentTrack();
    const isReading = Boolean(currentSentences) && isLectura(track);
    markBtn.hidden = !isReading;
    marksSectionEl.hidden = !isReading;
    marksListEl.replaceChildren();
    sentenceSpans.forEach((s) => s.classList.remove('marked'));
    if (!isReading) return;

    const marks = getMarks(track);
    marksTitleEl.textContent = `Frases marcadas (${marks.length})`;
    copyMarksBtn.disabled = marks.length === 0;

    if (!marks.length) {
        const li = document.createElement('li');
        li.className = 'empty-state';
        li.textContent = 'Toca «☆ Marcar» mientras escuchas para guardar la frase que está sonando.';
        marksListEl.append(li);
        return;
    }

    marks.forEach((mark) => {
        if (sentenceSpans[mark.i]) sentenceSpans[mark.i].classList.add('marked');
        const li = document.createElement('li');
        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'mark-jump';
        jump.title = 'Escuchar desde esta frase';
        const time = document.createElement('span');
        time.className = 'mark-time';
        time.textContent = formatTime(currentSentences[mark.i]?.s ?? 0);
        jump.append(time, document.createTextNode(mark.t));
        jump.addEventListener('click', () => seekToSentence(mark.i));

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'mark-delete';
        del.textContent = '×';
        del.setAttribute('aria-label', 'Quitar esta marca');
        del.addEventListener('click', () => removeMark(mark.i));
        li.append(jump, del);
        marksListEl.append(li);
    });
}

async function saveTrackRecord(track) {
    try {
        await putItemInDB(track);
    } catch (error) {
        console.error('Save failed:', error);
        showStatus('No se pudo guardar el cambio.', true);
    }
}

async function markCurrentSentence() {
    const track = currentTrack();
    if (!currentSentences || !isLectura(track)) return;
    let idx = findSentenceAt(audioPlayer.currentTime);
    // Si la frase recién empezó, lo más probable es que se quiera la anterior.
    if (idx > 0 && audioPlayer.currentTime - currentSentences[idx].s < MARK_GRACE) idx -= 1;
    const marks = getMarks(track).slice();
    if (marks.some((m) => m.i === idx)) {
        showStatus('Esa frase ya estaba marcada.');
        return;
    }
    marks.push({ i: idx, t: currentSentences[idx].t });
    marks.sort((a, b) => a.i - b.i);
    track.marks = marks;
    await saveTrackRecord(track);
    renderMarks();
    markBtn.classList.add('flash');
    setTimeout(() => markBtn.classList.remove('flash'), 400);
    showStatus(`★ Marcada (${marks.length}).`);
}

async function removeMark(idx) {
    const track = currentTrack();
    if (!isLectura(track)) return;
    track.marks = getMarks(track).filter((m) => m.i !== idx);
    await saveTrackRecord(track);
    renderMarks();
}

async function copyMarks() {
    const track = currentTrack();
    const marks = getMarks(track);
    if (!marks.length) return;
    const text = `Frases marcadas — ${getTrackTitle(track)}\n\n`
        + marks.map((m) => `• ${m.t}`).join('\n\n');
    try {
        await navigator.clipboard.writeText(text);
    } catch (_) {
        const area = document.createElement('textarea');
        area.value = text;
        document.body.append(area);
        area.select();
        document.execCommand('copy');
        area.remove();
    }
    showStatus(`Copiadas ${marks.length} frases. Pégalas en tus notas.`);
}

/* ------------------------- Reproducción ------------------------------- */
function resetPlayer() {
    audioPlayer.pause();
    audioPlayer.removeAttribute('src');
    audioPlayer.load();
    revokeCurrentObjectURL();
    currentTrackIndex = -1;
    trackTitleEl.textContent = 'Nada seleccionado';
    progressBar.value = 0;
    currentTimeEl.textContent = '0:00';
    durationTimeEl.textContent = '0:00';
    showReaderFor(null);
    syncPlaybackUI();
}

/* startTime = null -> retoma donde se quedó ESTE audio. */
function loadTrack(index, startTime = null) {
    if (index < 0 || index >= tracks.length) return;
    const wasPlaying = !audioPlayer.paused;
    revokeCurrentObjectURL();
    currentTrackIndex = index;
    const track = currentTrack();
    const target = startTime === null ? resumeTimeFor(track) : startTime;
    currentObjectURL = URL.createObjectURL(track.data);
    audioPlayer.src = currentObjectURL;
    applySpeed();
    trackTitleEl.textContent = getTrackTitle(track);
    lastSavedPosition = -1;

    showReaderFor(track);

    audioPlayer.onloadedmetadata = () => {
        applySpeed();
        const targetTime = Math.min(Math.max(Number(target) || 0, 0), audioPlayer.duration || 0);
        if (targetTime > 0) audioPlayer.currentTime = targetTime;
        durationTimeEl.textContent = formatTime(audioPlayer.duration);
        currentTimeEl.textContent = formatTime(targetTime);
        if (Number.isFinite(audioPlayer.duration) && audioPlayer.duration > 0) {
            progressBar.value = (targetTime / audioPlayer.duration) * 100;
            positions[track.id] = { t: targetTime, d: audioPlayer.duration };
            savePositions();
            updateItemProgress(track);
        }
        updateReaderHighlight();
        updatePositionState();
    };

    localStorage.setItem('lector_lastTrackId', track.id);
    updateMediaSession();
    renderPlaylist();
    clearStatus();
    if (wasPlaying) playCurrent();
}

async function playCurrent() {
    if (currentTrackIndex === -1 && tracks.length > 0) loadTrack(0);
    if (currentTrackIndex === -1) return;
    try {
        await audioPlayer.play();
        clearStatus();
    } catch (error) {
        syncPlaybackUI();
        showStatus('No se pudo iniciar el audio. Vuelve a tocar Reproducir.', true);
        console.error('Playback failed:', error);
    }
}

function togglePlay() {
    if (audioPlayer.paused) playCurrent();
    else audioPlayer.pause();
}

function playNext(forcePlay = false) {
    if (!tracks.length) return;
    const shouldPlay = forcePlay || !audioPlayer.paused;
    const nextIndex = currentTrackIndex < 0 || currentTrackIndex + 1 >= tracks.length ? 0 : currentTrackIndex + 1;
    loadTrack(nextIndex);
    if (shouldPlay) playCurrent();
}

function playPrev() {
    if (!tracks.length) return;
    if (audioPlayer.currentTime > 3) {
        audioPlayer.currentTime = 0;
        persistCurrentPosition();
        return;
    }
    const shouldPlay = !audioPlayer.paused;
    const previousIndex = currentTrackIndex <= 0 ? tracks.length - 1 : currentTrackIndex - 1;
    loadTrack(previousIndex);
    if (shouldPlay) playCurrent();
}

/* Al terminar: sigue con el próximo audio NO escuchado de la lista; no da la vuelta. */
function handleEnded() {
    persistCurrentPosition();
    for (let i = currentTrackIndex + 1; i < tracks.length; i++) {
        if (!isDone(tracks[i])) {
            loadTrack(i);
            playCurrent();
            return;
        }
    }
    syncPlaybackUI();
    showStatus('✓ Terminaste. No hay más audios pendientes en la lista.');
}

function skipTime(seconds) {
    if (!currentTrack() || !Number.isFinite(audioPlayer.duration)) return;
    audioPlayer.currentTime = Math.min(Math.max(audioPlayer.currentTime + seconds, 0), audioPlayer.duration);
    persistCurrentPosition();
    updateReaderHighlight();
    updatePositionState();
}

/* ------------------------- Biblioteca / UI ---------------------------- */
function findSameLectura(record) {
    return tracks.find((t) => t.kind === 'lectura' && t.name === record.name) || null;
}

function isDuplicateAudio(record) {
    return tracks.some((t) => t.kind !== 'lectura'
        && t.name === record.name && t.size === record.size && t.lastModified === record.lastModified);
}

function progressInfo(track) {
    const d = trackDuration(track);
    const pos = positions[track.id];
    if (isDone(track)) return { label: `✓ Escuchado · ${formatTime(d)}`, pct: 100, done: true };
    if (pos && pos.t > 1 && d > 0) {
        const pct = Math.min(100, (pos.t / d) * 100);
        return { label: `${formatTime(pos.t)} de ${formatTime(d)} · ${Math.round(pct)}%`, pct, done: false };
    }
    return { label: d > 0 ? `Sin empezar · ${formatTime(d)}` : 'Sin empezar', pct: 0, done: false };
}

function fillProgress(track, labelEl, barEl) {
    const info = progressInfo(track);
    labelEl.textContent = info.label;
    labelEl.classList.toggle('done', info.done);
    barEl.classList.toggle('done', info.done);
    barEl.firstElementChild.style.width = `${info.pct}%`;
}

function updateItemProgress(track) {
    const item = playlistEl.querySelector(`[data-id="${track.id}"]`);
    if (!item) return;
    fillProgress(track, item.querySelector('.item-progress'), item.querySelector('.item-bar'));
}

function renderPlaylist() {
    playlistEl.replaceChildren();
    updateControls();

    if (!tracks.length) {
        const emptyState = document.createElement('li');
        emptyState.className = 'empty-state';
        emptyState.textContent = "No hay nada aún. Toca 'Importar' para empezar.";
        playlistEl.append(emptyState);
        return;
    }

    tracks.forEach((track, index) => {
        const item = document.createElement('li');
        item.className = 'playlist-item';
        item.dataset.id = String(track.id);
        item.classList.toggle('active', index === currentTrackIndex);

        const selectButton = document.createElement('button');
        selectButton.className = 'track-select';
        selectButton.type = 'button';
        selectButton.title = `Reproducir ${getTrackTitle(track)}`;
        selectButton.setAttribute('aria-label', `Reproducir ${getTrackTitle(track)}`);
        selectButton.addEventListener('click', () => { loadTrack(index); playCurrent(); });

        const icon = document.createElement('span');
        icon.className = 'item-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = isLectura(track) ? '📖' : '♫';

        const textBox = document.createElement('span');
        textBox.className = 'item-text';
        const title = document.createElement('span');
        title.className = 'item-title';
        title.textContent = getTrackTitle(track);
        const progress = document.createElement('span');
        progress.className = 'item-progress';
        const bar = document.createElement('span');
        bar.className = 'item-bar';
        bar.append(document.createElement('span'));
        textBox.append(title, progress, bar);
        fillProgress(track, progress, bar);
        selectButton.append(icon, textBox);

        const deleteButton = document.createElement('button');
        deleteButton.className = 'delete-track-btn';
        deleteButton.type = 'button';
        deleteButton.textContent = '×';
        deleteButton.title = `Eliminar ${getTrackTitle(track)}`;
        deleteButton.setAttribute('aria-label', `Eliminar ${getTrackTitle(track)}`);
        deleteButton.addEventListener('click', () => deleteTrack(track));

        item.append(selectButton, deleteButton);
        playlistEl.append(item);
    });
}

async function refreshLibrary() {
    const activeId = currentTrack()?.id;
    tracks = await getAllItemsFromDB();
    currentTrackIndex = activeId ? tracks.findIndex((t) => t.id === activeId) : -1;
    renderPlaylist();
    updateStorageInfo();
}

async function deleteTrack(track) {
    if (!confirm(`¿Eliminar «${getTrackTitle(track)}»?`)) return;
    const deletingCurrent = currentTrack()?.id === track.id;
    try {
        await deleteItemFromDB(track.id);
        delete positions[track.id];
        savePositions();
        if (deletingCurrent) {
            resetPlayer();
            localStorage.removeItem('lector_lastTrackId');
        }
        await refreshLibrary();
        showStatus(`Se eliminó “${getTrackTitle(track)}”.`);
    } catch (error) {
        console.error('Delete failed:', error);
        showStatus('No se pudo eliminar.', true);
    }
}

async function loadInitialLibrary() {
    tracks = await getAllItemsFromDB();
    const lastTrackId = Number(localStorage.getItem('lector_lastTrackId'));
    // Migración desde la versión anterior (una sola posición guardada).
    const oldTime = Number(localStorage.getItem('lector_lastTime'));
    if (lastTrackId && oldTime > 0 && !positions[lastTrackId]) {
        positions[lastTrackId] = { t: oldTime, d: 0 };
        savePositions();
    }
    localStorage.removeItem('lector_lastTime');
    renderPlaylist();
    updateStorageInfo();
    if (!tracks.length) return;
    const savedIndex = tracks.findIndex((t) => t.id === lastTrackId);
    loadTrack(savedIndex >= 0 ? savedIndex : 0);
}

/* ----------------------- Almacenamiento local ------------------------- */
async function requestPersistentStorage() {
    try {
        if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
            await navigator.storage.persist();
        }
    } catch (_) { /* no soportado */ }
}

async function updateStorageInfo() {
    try {
        if (!navigator.storage?.estimate) return;
        const { usage } = await navigator.storage.estimate();
        storageInfoEl.textContent = usage ? `· ${Math.round(usage / 1048576)} MB` : '';
    } catch (_) { /* no soportado */ }
}

/* ----------------------------- Importar ------------------------------- */
function base64ToBlob(b64, mime) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: mime || 'audio/mpeg' });
}

function looksLikeLectura(file) {
    return /\.(lectura|json)$/i.test(file.name);
}

function isAudioFile(file) {
    return file.type.startsWith('audio/') || /\.(mp3|m4a|aac|wav|ogg)$/i.test(file.name);
}

/* Conserva las marcas de una lectura regenerada si la frase sigue existiendo. */
function remapMarks(oldMarks, sentences) {
    if (!Array.isArray(oldMarks) || !oldMarks.length) return [];
    const byText = new Map();
    sentences.forEach((s, i) => { if (!byText.has(s.t)) byText.set(s.t, i); });
    return oldMarks
        .filter((m) => byText.has(m.t))
        .map((m) => ({ i: byText.get(m.t), t: m.t }))
        .sort((a, b) => a.i - b.i);
}

async function importLectura(file) {
    const bundle = JSON.parse(await file.text());
    if (!bundle.audio_b64 || !Array.isArray(bundle.frases)) {
        throw new Error('Archivo de lectura no válido');
    }
    const blob = base64ToBlob(bundle.audio_b64, bundle.audio_mime);
    const name = bundle.titulo || file.name.replace(/\.[^/.]+$/, '');
    const record = { kind: 'lectura', name, sentences: bundle.frases, duration: bundle.duracion || 0, data: blob };
    const existing = findSameLectura(record);
    if (existing) {
        // Lectura regenerada: reemplaza el audio, conserva el lugar en la lista y las marcas.
        record.id = existing.id;
        record.marks = remapMarks(existing.marks, record.sentences);
        await putItemInDB(record);
        delete positions[existing.id];
        savePositions();
        return 'replaced';
    }
    await saveItemToDB(record);
    return 'added';
}

async function importAudio(file) {
    const record = {
        kind: 'audio', name: file.name, type: file.type,
        size: file.size, lastModified: file.lastModified, data: file
    };
    if (isDuplicateAudio(record)) return 'skipped';
    await saveItemToDB(record);
    return 'added';
}

fileInput.addEventListener('change', async (event) => {
    const files = Array.from(event.target.files);
    if (!files.length) return;
    let added = 0, replaced = 0, skipped = 0, failed = 0;
    showStatus('Importando…');
    const activeId = currentTrack()?.id;

    for (const file of files) {
        try {
            let result;
            if (looksLikeLectura(file)) result = await importLectura(file);
            else if (isAudioFile(file)) result = await importAudio(file);
            else { skipped += 1; continue; }
            if (result === 'added') added += 1;
            else if (result === 'replaced') replaced += 1;
            else skipped += 1;
        } catch (error) {
            console.error('Import failed:', error);
            failed += 1;
        }
    }

    const activeWasReplaced = replaced > 0 && activeId && !positions[activeId];
    await refreshLibrary();
    if (activeWasReplaced && currentTrackIndex >= 0) loadTrack(currentTrackIndex, 0);
    else if (currentTrackIndex === -1 && tracks.length) loadTrack(0);
    const parts = [`${added} importado${added === 1 ? '' : 's'}`];
    if (replaced) parts.push(`${replaced} reemplazado${replaced === 1 ? '' : 's'}`);
    if (skipped) parts.push(`${skipped} omitido${skipped === 1 ? '' : 's'} (ya estaba)`);
    if (failed) parts.push(`${failed} con error`);
    showStatus(`${parts.join(', ')}.`, failed > 0);
    fileInput.value = '';
});

/* --------------------------- Media Session ---------------------------- */
function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    // Sin «pista anterior/siguiente»: así la pantalla bloqueada y los audífonos
    // muestran retroceder/adelantar 15 s, más útil para lecturas largas.
    const handlers = {
        play: playCurrent,
        pause: () => audioPlayer.pause(),
        seekbackward: (d) => skipTime(-(d.seekOffset || 15)),
        seekforward: (d) => skipTime(d.seekOffset || 15),
        seekto: (d) => {
            if (Number.isFinite(d.seekTime)) {
                audioPlayer.currentTime = d.seekTime;
                persistCurrentPosition();
                updateReaderHighlight();
                updatePositionState();
            }
        },
        previoustrack: null,
        nexttrack: null
    };
    Object.entries(handlers).forEach(([action, handler]) => {
        try { navigator.mediaSession.setActionHandler(action, handler); } catch (_) { /* no soportado */ }
    });
}

/* ------------------------------ Eventos ------------------------------- */
playPauseBtn.addEventListener('click', togglePlay);
nextBtn.addEventListener('click', () => playNext());
prevBtn.addEventListener('click', playPrev);
rewindBtn.addEventListener('click', () => skipTime(-15));
forwardBtn.addEventListener('click', () => skipTime(15));
markBtn.addEventListener('click', markCurrentSentence);
copyMarksBtn.addEventListener('click', copyMarks);

speedSelect.addEventListener('change', (event) => {
    applySpeed();
    localStorage.setItem('lector_speed', event.target.value);
    updatePositionState();
});

let isDraggingProgressBar = false;
['pointerdown', 'touchstart'].forEach((e) => progressBar.addEventListener(e, () => { isDraggingProgressBar = true; }, { passive: true }));
['pointerup', 'pointercancel', 'touchend'].forEach((e) => progressBar.addEventListener(e, () => { isDraggingProgressBar = false; }));

progressBar.addEventListener('input', (event) => {
    isDraggingProgressBar = true;
    if (Number.isFinite(audioPlayer.duration)) {
        currentTimeEl.textContent = formatTime((Number(event.target.value) / 100) * audioPlayer.duration);
    }
});

progressBar.addEventListener('change', (event) => {
    if (Number.isFinite(audioPlayer.duration)) {
        audioPlayer.currentTime = (Number(event.target.value) / 100) * audioPlayer.duration;
        persistCurrentPosition();
        updateReaderHighlight();
        updatePositionState();
    }
    isDraggingProgressBar = false;
});

audioPlayer.addEventListener('play', () => {
    // iOS a veces vuelve a 1.0x al cambiar de audio: se reaplica la velocidad elegida.
    if (audioPlayer.playbackRate !== Number(speedSelect.value)) applySpeed();
    syncPlaybackUI();
    updatePositionState();
});
audioPlayer.addEventListener('pause', () => { syncPlaybackUI(); persistCurrentPosition(); updatePositionState(); });
audioPlayer.addEventListener('ratechange', updatePositionState);
audioPlayer.addEventListener('timeupdate', () => {
    const current = audioPlayer.currentTime;
    const duration = audioPlayer.duration;
    if (!isDraggingProgressBar) {
        currentTimeEl.textContent = formatTime(current);
        if (Number.isFinite(duration) && duration > 0) progressBar.value = (current / duration) * 100;
    }
    updateReaderHighlight();
    if (Math.abs(current - lastSavedPosition) >= POSITION_SAVE_INTERVAL) persistCurrentPosition();
});
audioPlayer.addEventListener('ended', handleEnded);
audioPlayer.addEventListener('error', () => { syncPlaybackUI(); showStatus('No se pudo leer este archivo.', true); });

clearDbBtn.addEventListener('click', async () => {
    if (!confirm('¿Borrar TODA la biblioteca (audios y lecturas)?')) return;
    try {
        await clearDB();
        tracks = [];
        resetPlayer();
        positions = {};
        savePositions();
        localStorage.removeItem('lector_lastTrackId');
        renderPlaylist();
        updateStorageInfo();
        showStatus('Biblioteca eliminada.');
    } catch (error) {
        console.error('Clear library failed:', error);
        showStatus('No se pudo borrar la biblioteca.', true);
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistCurrentPosition();
});
window.addEventListener('pagehide', persistCurrentPosition);

/* ------------------------------- Init --------------------------------- */
async function init() {
    try {
        await initDB();
        const savedSpeed = localStorage.getItem('lector_speed');
        if (savedSpeed && [...speedSelect.options].some((o) => o.value === savedSpeed)) {
            speedSelect.value = savedSpeed;
        }
        applySpeed();
        setupMediaSession();
        requestPersistentStorage();
        await loadInitialLibrary();
        syncPlaybackUI();
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js').catch((error) => {
                console.error('Service Worker registration failed:', error);
                showStatus('Funciona, pero no se activó el modo sin conexión.', true);
            });
        }
    } catch (error) {
        console.error('Initialization failed:', error);
        showStatus('No se pudo abrir la biblioteca local.', true);
    }
}

init();
