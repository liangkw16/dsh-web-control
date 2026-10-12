import { mkdir, copyFile } from 'node:fs/promises'
await mkdir(new URL('./dist/migrations/', import.meta.url), { recursive: true })
await copyFile(
  new URL('./src/migrations/001.sql', import.meta.url),
  new URL('./dist/migrations/001.sql', import.meta.url),
)
