# ReserveWatch Console (React + Vite)

This directory contains the React/Vite frontend for the ReserveWatch operator console.

## Commands

```bash
npm install
npm run dev
npm run build
```

## Build output

`npm run build` writes static files to:

- `../server/public`

The API server serves this build at:

- `http://127.0.0.1:8787/console`

## Local workflow

1. Run the API server (`server/`).
2. Develop UI in this folder with `npm run dev`.
3. Build with `npm run build` when ready.
4. Open `/console` from the server process.
