/**
 * Muss als erstes geladen werden, damit .env vor config.ts verfügbar ist.
 */
import path from 'path';
import { config } from 'dotenv';

config({ path: path.resolve(process.cwd(), '../.env') });
config({ path: path.resolve(process.cwd(), '.env') });
