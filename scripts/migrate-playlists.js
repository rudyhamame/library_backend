import 'dotenv/config';
import { closePlaylistStore, migrateLegacyPlaylists } from '../playlist-store.js';

try {
  const result = await migrateLegacyPlaylists();
  console.log(`MongoDB migration complete: ${result.imported}/${result.discovered} playlist documents imported into ${result.database}.${result.collection}.`);
} catch (error) {
  console.error(`MongoDB migration failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  await closePlaylistStore();
}
