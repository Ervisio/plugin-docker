// Lets the tests import source files that use extensionless relative imports (as the bundler allows).
import { register } from 'node:module';
register('./resolve-ts.mjs', import.meta.url);
