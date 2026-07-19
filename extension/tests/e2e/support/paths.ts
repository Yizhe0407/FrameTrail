import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const extensionRoot = fileURLToPath(new URL('../../../', import.meta.url));
export const chromeBuildPath = path.join(extensionRoot, '.output/chrome-mv3');
export const preparedExtensionPath = path.join(extensionRoot, '.output/e2e-chrome-mv3');
