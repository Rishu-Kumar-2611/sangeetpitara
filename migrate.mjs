import { createRepositoryFromEnv } from './persistence.mjs';

if (!process.env.DATABASE_URL?.trim()) {
  console.error('DATABASE_URL is required to run PostgreSQL migrations.');
  process.exitCode = 1;
} else {
  try {
    const repository = await createRepositoryFromEnv(process.env);
    await repository.close();
    console.log('RoomSound database migrations are up to date.');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
