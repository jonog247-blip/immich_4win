import { existsSync } from 'node:fs';
import { join } from 'node:path';

const defaultMediaLocationCandidates = ['/data', '/usr/src/app/upload'];
const defaultMediaLocationFallback = '/usr/src/app/upload';

// Windows builds ship the server outside of a container, so IMMICH_MEDIA_LOCATION points at a real
// directory on the host instead of one of the container mount candidates.
const windowsMediaLocationFallback = 'upload';

const mediaLocationCandidates = () => (process.platform === 'win32' ? [] : defaultMediaLocationCandidates);

const mediaLocationFallback = () => (process.platform === 'win32' ? windowsMediaLocationFallback : defaultMediaLocationFallback);

export const detectMediaLocation = (mediaLocation: string | undefined, exists: (path: string) => boolean): string => {
  if (mediaLocation) {
    return mediaLocation;
  }

  const targets: string[] = [];

  for (const candidate of mediaLocationCandidates()) {
    if (exists(candidate)) {
      targets.push(candidate);
    }
  }

  if (targets.length === 1) {
    return targets[0];
  }

  return mediaLocationFallback();
};

export const getBackupsStatePath = (mediaLocation: string | undefined): string => {
  if (mediaLocation) {
    return join(mediaLocation, 'backups', 'yucca');
  }

  const candidates = mediaLocationCandidates().filter((candidate) => existsSync(candidate));

  let warning: string | undefined;
  if (candidates.length === 0) {
    warning = `None of ${mediaLocationCandidates().join(', ')} exist and media location is not otherwise set`;
  } else if (candidates.length > 1) {
    warning = `Multiple paths (${candidates.join(', ')}) exist at the same time`;
  }

  const statePath = join(candidates.length === 1 ? candidates[0] : mediaLocationFallback(), 'backups', 'yucca');
  if (warning) {
    console.warn(
      `${warning}, your backup configuration and encryption keys will be read from ${statePath}, which may not be where they were originally written.`,
    );
  }

  return statePath;
};
