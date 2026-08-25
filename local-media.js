import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const configPath = resolve(moduleDirectory, 'data/local-media.json');
let activeMoviesRoot = resolve(moduleDirectory, process.env.LOCAL_MEDIA_DIR || 'media/movies');
let enabledMovieIds = null;
let titleOverrides = {};
let subtitleOverrides = {};
const supportedExtensions = new Set(['.mkv', '.mp4', '.webm', '.mov', '.avi']);
const subtitleExtensions = new Set(['.srt', '.ttml']);

export async function ensureLocalMoviesRoot() {
  try {
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    if (saved.path) activeMoviesRoot = resolve(String(saved.path));
    if (Array.isArray(saved.enabledIds)) enabledMovieIds = new Set(saved.enabledIds.map(String));
    if (saved.titleOverrides && typeof saved.titleOverrides === 'object') titleOverrides = saved.titleOverrides;
    if (saved.subtitleOverrides && typeof saved.subtitleOverrides === 'object') subtitleOverrides = saved.subtitleOverrides;
  } catch {}
  await mkdir(activeMoviesRoot, { recursive: true });
}

export async function getLocalMoviesRoot() {
  await ensureLocalMoviesRoot();
  return activeMoviesRoot;
}

export async function setLocalMoviesRoot(value) {
  const rawPath = String(value || '').trim();
  if (!rawPath) throw new Error('Choose a valid movie folder');
  const nextRoot = resolve(rawPath);
  if (nextRoot === '/') throw new Error('Choose a valid movie folder');
  await mkdir(nextRoot, { recursive: true });
  activeMoviesRoot = nextRoot;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ path: activeMoviesRoot, enabledIds: enabledMovieIds ? [...enabledMovieIds] : null, titleOverrides, subtitleOverrides }, null, 2));
  return activeMoviesRoot;
}

async function saveLocalMediaConfig() {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify({ path: activeMoviesRoot, enabledIds: enabledMovieIds ? [...enabledMovieIds] : null, titleOverrides, subtitleOverrides }, null, 2));
}

async function collectFiles(directory, result = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = resolve(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(filePath, result);
    else if (supportedExtensions.has(extname(entry.name).toLowerCase())) result.push(filePath);
  }
  return result;
}

async function findSidecarSubtitles(filePath) {
  const directory = dirname(filePath);
  const extension = extname(filePath);
  const baseName = filePath.slice(0, -extension.length).split('/').pop().toLowerCase();
  const entries = await readdir(directory, { withFileTypes: true });
  const subtitles = entries
    .filter(entry => entry.isFile() && subtitleExtensions.has(extname(entry.name).toLowerCase()))
    .map(entry => entry.name);
  const candidates = subtitles
    .filter(name => {
      const stem = name.slice(0, -extname(name).length).toLowerCase();
      return stem === baseName || stem.startsWith(`${baseName}.`);
    })
    .sort((left, right) => {
      const leftExact = left.toLowerCase().slice(0, -extname(left).length) === baseName ? 0 : 1;
      const rightExact = right.toLowerCase().slice(0, -extname(right).length) === baseName ? 0 : 1;
      return leftExact - rightExact || left.localeCompare(right);
    });
  if (candidates.length) return candidates;
  const videoCount = entries.filter(entry => entry.isFile() && supportedExtensions.has(extname(entry.name).toLowerCase())).length;
  return videoCount === 1 ? subtitles.sort((left, right) => left.localeCompare(right)) : [];
}

export async function listLocalMovies() {
  await ensureLocalMoviesRoot();
  const files = await collectFiles(activeMoviesRoot);
  return (await Promise.all(files.map(async filePath => {
    const file = await stat(filePath);
    const fileName = relative(activeMoviesRoot, filePath).replace(/\\/g, '/');
    const id = createHash('sha1').update(fileName).digest('hex').slice(0, 20);
    const fileTitle = fileName.split('/').pop().replace(/\.[^.]+$/, '');
    const title = titleOverrides[id] || fileTitle;
    const subtitleOptions = await findSidecarSubtitles(filePath);
    const baseName = fileTitle.toLowerCase();
    const exactSubtitle = subtitleOptions.find(name => name.slice(0, -extname(name).length).toLowerCase() === baseName) || '';
    const selectedSubtitle = subtitleOverrides[id] === '' ? '' : (subtitleOptions.includes(subtitleOverrides[id]) ? subtitleOverrides[id] : exactSubtitle);
    return { id, title, rokuTitle: title, rokuTextKind: /[A-Za-z]/.test(title) ? 'latin' : 'arabic', source: 'local', kind: 'movie', contentKind: 'movie', streamFormat: 'hls', sizeBytes: file.size, fileName, subtitleFile: selectedSubtitle, subtitleOptions, subtitleUrl: selectedSubtitle ? `/api/local/movies/${id}/subtitle` : '', rokuEnabled: enabledMovieIds === null || enabledMovieIds.has(id), url: `/api/local/movies/${id}/master.m3u8` };
  }))).sort((left, right) => left.title.localeCompare(right.title));
}

export async function setLocalMovieEnabled(id, enabled) {
  const movies = await listLocalMovies();
  if (!movies.some(movie => movie.id === id)) throw new Error('Local movie was not found');
  if (enabledMovieIds === null) enabledMovieIds = new Set(movies.map(movie => movie.id));
  if (enabled) enabledMovieIds.add(id); else enabledMovieIds.delete(id);
  await saveLocalMediaConfig();
  return (await listLocalMovies()).find(movie => movie.id === id);
}

export async function setLocalMovieTitle(id, title) {
  const movies = await listLocalMovies();
  if (!movies.some(movie => movie.id === id)) throw new Error('Local movie was not found');
  const nextTitle = String(title || '').trim();
  if (!nextTitle) throw new Error('Movie name cannot be empty');
  titleOverrides[id] = nextTitle;
  await saveLocalMediaConfig();
  return (await listLocalMovies()).find(movie => movie.id === id);
}

export async function setLocalMovieSubtitle(id, subtitleFile) {
  const movies = await listLocalMovies();
  const movie = movies.find(item => item.id === id);
  if (!movie) throw new Error('Local movie was not found');
  const nextSubtitle = String(subtitleFile || '').trim();
  if (nextSubtitle && !movie.subtitleOptions.includes(nextSubtitle)) throw new Error('Subtitle file was not found for this movie');
  subtitleOverrides[id] = nextSubtitle;
  await saveLocalMediaConfig();
  return (await listLocalMovies()).find(item => item.id === id);
}

export async function uploadLocalMovieSubtitle(id, fileName, buffer) {
  const movie = (await listLocalMovies()).find(item => item.id === id);
  if (!movie) throw new Error('Local movie was not found');
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('Subtitle file is empty');
  const safeName = basename(String(fileName || 'subtitle.srt'));
  if (!subtitleExtensions.has(extname(safeName).toLowerCase())) throw new Error('Only .srt and .ttml subtitles are supported');
  const moviePath = await localMoviePath(movie);
  await writeFile(resolve(dirname(moviePath), safeName), buffer);
  return setLocalMovieSubtitle(id, safeName);
}

export async function findLocalMovie(id) {
  return (await listLocalMovies()).find(movie => movie.id === id) || null;
}

export async function localMoviePath(movie) {
  const candidate = resolve(activeMoviesRoot, movie.fileName);
  if (!candidate.startsWith(`${activeMoviesRoot}/`)) throw new Error('Invalid local movie path');
  await stat(candidate);
  return candidate;
}

export async function localMovieSubtitlePath(movie) {
  if (!movie?.subtitleFile) throw new Error('No sidecar subtitle found for this movie');
  const moviePath = await localMoviePath(movie);
  const candidate = resolve(dirname(moviePath), movie.subtitleFile);
  if (!candidate.startsWith(`${dirname(moviePath)}/`)) throw new Error('Invalid local subtitle path');
  await stat(candidate);
  return candidate;
}
